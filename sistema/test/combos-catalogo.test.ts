import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { cuantosCombos } from "../src/dominio/combos";
import { catalogoPublico } from "../src/rpc/catalogo";

/**
 * Que el catálogo y la regla pura digan LO MISMO.
 *
 * La disponibilidad de un combo se calcula en dos sitios: en SQL, porque el
 * catálogo entero sale en una consulta, y en `src/dominio/combos.ts`, que es
 * lo que usan el panel y la creación de pedidos. Dos copias de una regla
 * acaban discrepando — y la que se equivoca del lado flojo es la que nadie
 * revisa.
 *
 * Esta prueba no comprueba un número concreto: siembra combos de verdad en D1
 * y exige que las dos den el mismo.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let productoId: string;
let bodegaId: string;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM combo_componentes"),
    env.DB.prepare("UPDATE variantes SET publicado = 0"),
  ]);
  productoId = id("prod");
  await env.DB.prepare(
    "INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)",
  )
    .bind(productoId, "panal", "Combos", id("slug"), ahora())
    .run();
  const b = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
  bodegaId = b?.id ?? "";
});

async function pieza(libres: number): Promise<string> {
  const codigo = id("PZ").toUpperCase();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en) VALUES (?,?,?,1,100,0,1,1,?)`,
    ).bind(codigo, productoId, "pieza", ahora()),
    env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)",
    ).bind(codigo, bodegaId, libres),
  ]);
  return codigo;
}

async function combo(receta: { codigo: string; cantidad: number }[]): Promise<string> {
  const codigo = id("CO").toUpperCase();
  await env.DB.prepare(
    `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
       publicado,activo,version,actualizado_en,es_combo) VALUES (?,?,?,1,500,1,1,1,?,1)`,
  )
    .bind(codigo, productoId, "combo", ahora())
    .run();
  for (const r of receta) {
    await env.DB.prepare(
      "INSERT INTO combo_componentes (combo_codigo,codigo,cantidad) VALUES (?,?,?)",
    )
      .bind(codigo, r.codigo, r.cantidad)
      .run();
  }
  return codigo;
}

const deLa = async (codigo: string) => {
  const c = await catalogoPublico(env.DB, ahora());
  return c.variantes.find((v) => v.codigo === codigo);
};

describe("el catálogo y la regla pura coinciden", () => {
  const casos = [
    { nombre: "manda el que menos alcanza", piezas: [10, 3], cantidades: [2, 1] },
    { nombre: "uno agotado deja todo en cero", piezas: [500, 0], cantidades: [1, 1] },
    { nombre: "no parte unidades", piezas: [7], cantidades: [2] },
    { nombre: "justo para uno", piezas: [2, 3], cantidades: [2, 3] },
    { nombre: "holgado", piezas: [100, 100, 100], cantidades: [1, 2, 5] },
    { nombre: "pocas, no agotado", piezas: [6, 9], cantidades: [2, 3] },
  ];

  for (const caso of casos) {
    it(caso.nombre, async () => {
      const codigos = await Promise.all(caso.piezas.map((l) => pieza(l)));
      const receta = codigos.map((codigo, i) => ({ codigo, cantidad: caso.cantidades[i]! }));
      const c = await combo(receta);

      const esperado = cuantosCombos(
        receta.map((r, i) => ({ codigo: r.codigo, cantidad: r.cantidad, libres: caso.piezas[i]! })),
      );
      const publica = await deLa(c);

      expect(publica, "el combo tiene que salir en el catálogo").toBeDefined();
      // No se compara el número crudo porque el catálogo no lo publica —a
      // propósito, para no filtrar el inventario— sino la etiqueta que sale de
      // él. Lo que se exige es que las dos vengan del mismo cálculo.
      const etiquetaEsperada =
        esperado === 0 ? "agotado" : esperado <= 5 ? "pocas" : "disponible";
      expect(publica?.disponibilidad, `esperaba ${esperado} combos`).toBe(etiquetaEsperada);
    });
  }
});

describe("los casos límite", () => {
  it("un combo SIN receta sale agotado, no disponible", async () => {
    const c = await combo([]);
    // En SQL, `MIN` sobre un conjunto vacío da NULL. Si eso se leyera como
    // «no se sabe» en vez de como cero, el bot ofrecería sin límite un combo
    // que no se puede armar.
    expect((await deLa(c))?.disponibilidad).toBe("agotado");
    expect(cuantosCombos([])).toBe(0);
  });

  it("el combo NO publica cuántos quedan", async () => {
    const p = await pieza(3);
    const c = await combo([{ codigo: p, cantidad: 1 }]);
    const publica = await deLa(c);
    // La cantidad exacta de inventario no sale hacia el navegador, ni por esta
    // puerta nueva.
    expect(JSON.stringify(publica)).not.toContain("maximoDisponible");
    expect(Object.keys(publica ?? {})).not.toContain("pedido");
  });
});
