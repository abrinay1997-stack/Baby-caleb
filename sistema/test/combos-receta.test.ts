import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { leerReceta, ponerReceta, type ContextoCatalogo } from "../src/db/catalogo-admin";
import { cuantosCombos } from "../src/dominio/combos";

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let ctx: ContextoCatalogo;
let productoId: string;
let bodegaId: string;

beforeEach(async () => {
  ctx = { db: env.DB, ahora: ahora(), actor: "yarielis" };
  productoId = id("prod");
  const b = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
  bodegaId = b?.id ?? "";
  await env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)")
    .bind(productoId, "panal", "Recetas", id("slug"), ahora())
    .run();
});

async function variante(esCombo: boolean, libres = 0): Promise<string> {
  const codigo = id("RC").toUpperCase();
  const lotes = [
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en,es_combo) VALUES (?,?,?,1,100,0,1,1,?,?)`,
    ).bind(codigo, productoId, `n ${codigo}`, ahora(), esCombo ? 1 : 0),
  ];
  if (!esCombo) {
    lotes.push(
      env.DB.prepare(
        "INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)",
      ).bind(codigo, bodegaId, libres),
    );
  }
  await env.DB.batch(lotes);
  return codigo;
}

describe("poner la receta", () => {
  it("reemplaza la receta entera, no la parchea", async () => {
    const c = await variante(true);
    const a = await variante(false, 10);
    const b = await variante(false, 10);
    const d = await variante(false, 10);

    await ponerReceta(ctx, c, [{ codigo: a, cantidad: 1 }, { codigo: b, cantidad: 2 }]);
    await ponerReceta(ctx, c, [{ codigo: d, cantidad: 3 }]);

    const r = await leerReceta(ctx, c);
    // Editar ingrediente a ingrediente deja recetas a medias, y quien venda
    // justo en ese momento aparta de menos.
    expect(r.ok && r.datos.map((x) => x.codigo)).toEqual([d]);
  });

  it("la receta vacía deja el combo sin armar, y se puede", async () => {
    const c = await variante(true);
    const a = await variante(false, 10);
    await ponerReceta(ctx, c, [{ codigo: a, cantidad: 1 }]);
    const r = await ponerReceta(ctx, c, []);
    expect(r.ok).toBe(true);
    // Y el catálogo lo da por agotado, que es lo correcto.
    expect(cuantosCombos([])).toBe(0);
  });

  it("devuelve lo que hay de cada pieza, para saber qué frena", async () => {
    const c = await variante(true);
    const a = await variante(false, 7);
    await ponerReceta(ctx, c, [{ codigo: a, cantidad: 2 }]);
    const r = await leerReceta(ctx, c);
    expect(r.ok && r.datos[0]?.libres).toBe(7);
  });
});

describe("lo que no se deja poner", () => {
  it("una receta en una variante que no es combo", async () => {
    const normal = await variante(false, 5);
    const a = await variante(false, 5);
    const r = await ponerReceta(ctx, normal, [{ codigo: a, cantidad: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
    // El mensaje EXACTO, sin la coletilla del trigger. Lo que de verdad lo
    // impide es el trigger del esquema —quitando la comprobación de aquí, la
    // base lo rechaza igual— así que lo que esta línea fija es que el aviso
    // salga antes de ir a la base y sin el texto de la base detrás.
    if (!r.ok) expect(r.mensaje).toBe("esta variante no es un combo");
  });

  it("un combo dentro de otro combo, con el mensaje del esquema", async () => {
    const c = await variante(true);
    const otro = await variante(true);
    const r = await ponerReceta(ctx, c, [{ codigo: otro, cantidad: 1 }]);
    expect(r.ok).toBe(false);
    // El trigger habla en español: se pasa su mensaje en vez de uno genérico,
    // que mandaría a adivinar.
    if (!r.ok) expect(r.mensaje).toContain("combo");
  });

  it("el combo dentro de sí mismo", async () => {
    const c = await variante(true);
    const r = await ponerReceta(ctx, c, [{ codigo: c, cantidad: 1 }]);
    expect(r.ok).toBe(false);
  });

  it("el mismo ingrediente dos veces", async () => {
    const c = await variante(true);
    const a = await variante(false, 10);
    const r = await ponerReceta(ctx, c, [
      { codigo: a, cantidad: 1 },
      { codigo: a, cantidad: 2 },
    ]);
    expect(r.ok).toBe(false);
    // Serían dos cantidades para lo mismo, y cuál manda dependería de cuál se
    // lea primero. Se avisa en vez de quedarse con una.
    if (!r.ok) expect(r.mensaje).toContain("dos veces");
  });

  it("una cantidad de cero", async () => {
    const c = await variante(true);
    const a = await variante(false, 10);
    expect((await ponerReceta(ctx, c, [{ codigo: a, cantidad: 0 }])).ok).toBe(false);
  });

  it("un ingrediente que no existe", async () => {
    const c = await variante(true);
    const r = await ponerReceta(ctx, c, [{ codigo: "NO-EXISTE-NUNCA", cantidad: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  it("si algo falla, la receta anterior SIGUE intacta", async () => {
    const c = await variante(true);
    const buena = await variante(false, 10);
    await ponerReceta(ctx, c, [{ codigo: buena, cantidad: 4 }]);

    await ponerReceta(ctx, c, [
      { codigo: buena, cantidad: 1 },
      { codigo: "NO-EXISTE-NUNCA", cantidad: 1 },
    ]);

    const r = await leerReceta(ctx, c);
    // El batch borra y vuelve a poner: si el insert falla, el delete se
    // deshace con él. Sin eso, un error dejaría el combo SIN receta — o sea,
    // agotado y sin que nadie supiera por qué.
    expect(r.ok && r.datos).toHaveLength(1);
    expect(r.ok && r.datos[0]?.cantidad).toBe(4);
  });
});
