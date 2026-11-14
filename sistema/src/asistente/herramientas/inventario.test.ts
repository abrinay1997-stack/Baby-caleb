import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Contexto } from "../registro";
import { movimientos, verStock } from "./inventario";

/**
 * Las dos primeras herramientas, contra una D1 de verdad.
 *
 * Lo que se comprueba no es que el SQL corra: es que digan lo que la dueña
 * necesita creer. Si `ver_stock` dijera lo físico en vez de lo libre, el
 * asistente prometería mercancía ya comprometida.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const ctx = (): Contexto => ({
  db: env.DB,
  usuario: { id: "u1", correo: "duena@babycaleb.com", rol: "duena" },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

/** Siembra una variante con existencias en una bodega propia de la prueba. */
async function sembrar(opciones: {
  fisico: number;
  reservado: number;
  minimo: number | null;
}): Promise<{ codigo: string; bodega: string; nombreBodega: string }> {
  const bodega = id("b");
  const nombreBodega = `Bodega ${bodega}`;
  const prod = id("p");
  const codigo = id("BC").toUpperCase();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(bodega, nombreBodega),
    env.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,orden,activo,creado_en) VALUES (?,'panal','Body',?,1,1,?)",
    ).bind(prod, `slug-${prod}`, ahora()),
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,
         tasa_itbms_bp,publicado,activo,actualizado_en)
       VALUES (?,?,'Body manga larga','0-3m',12,1250,0,1,1,?)`,
    ).bind(codigo, prod, ahora()),
    env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,?,?,?)",
    ).bind(codigo, bodega, opciones.fisico, opciones.reservado, opciones.minimo),
  ]);

  return { codigo, bodega, nombreBodega };
}

describe("ver_stock", () => {
  it("dice lo LIBRE, no lo físico", async () => {
    // Es la diferencia entre prometer lo que hay y prometer lo que ya es de
    // otra clienta.
    const { codigo } = await sembrar({ fisico: 14, reservado: 2, minimo: 5 });
    const r = await verStock.ejecutar(ctx(), { codigo });

    expect(r.articulos[0]?.libres).toBe(12);
    expect(r.articulos[0]?.comprometido).toBe(2);
  });

  it("traduce la cantidad a disponible / pocas / agotado", async () => {
    const abundante = await sembrar({ fisico: 20, reservado: 0, minimo: null });
    const escaso = await sembrar({ fisico: 3, reservado: 0, minimo: null });
    const vacio = await sembrar({ fisico: 0, reservado: 0, minimo: null });

    const dime = async (codigo: string) =>
      (await verStock.ejecutar(ctx(), { codigo })).articulos[0]?.hay;

    expect(await dime(abundante.codigo)).toBe("disponible");
    expect(await dime(escaso.codigo)).toBe("pocas");
    expect(await dime(vacio.codigo)).toBe("agotado");
  });

  it("avisa de lo que está bajo SU mínimo, que no es el umbral general", async () => {
    // Un artículo con 8 libres está «disponible» y aun así por debajo de su
    // mínimo de 10: las dos cosas son ciertas y las dos hay que decirlas.
    const { codigo } = await sembrar({ fisico: 8, reservado: 0, minimo: 10 });
    const r = await verStock.ejecutar(ctx(), { codigo });

    expect(r.articulos[0]?.hay).toBe("disponible");
    expect(r.articulos[0]?.bajoElMinimo).toBe(true);
  });

  it("lo que no tiene mínimo no avisa nunca", async () => {
    const { codigo } = await sembrar({ fisico: 1, reservado: 0, minimo: null });
    expect((await verStock.ejecutar(ctx(), { codigo })).articulos[0]?.bajoElMinimo).toBe(false);
  });

  it("se puede filtrar por bodega", async () => {
    const a = await sembrar({ fisico: 5, reservado: 0, minimo: null });
    const r = await verStock.ejecutar(ctx(), { bodega: a.nombreBodega });
    expect(r.articulos.map((x) => x.codigo)).toEqual([a.codigo]);
  });

  it("un código que no existe devuelve vacío, no un error", async () => {
    const r = await verStock.ejecutar(ctx(), { codigo: "NO-EXISTE" });
    expect(r.articulos).toEqual([]);
    expect(r.cuantos).toBe(0);
  });

  it("no devuelve el costo ni aunque lo pregunte la dueña", async () => {
    // El costo tiene su propio permiso (`costo_y_margen`). Una herramienta que
    // a veces lo trae y a veces no sería una forma difícil de equivocarse.
    const { codigo } = await sembrar({ fisico: 5, reservado: 0, minimo: null });
    const r = await verStock.ejecutar(ctx(), { codigo });
    expect(JSON.stringify(r)).not.toMatch(/costo|cents/i);
  });
});

describe("movimientos", () => {
  // El costo con que se siembra, en un solo sitio: la prueba que comprueba
  // que NO sale y la siembra que lo mete tienen que hablar del mismo número.
  const COSTO_SEMBRADO = 640;

  async function unMovimiento(
    codigo: string,
    bodega: string,
    delta: number,
    tipo: string,
    cuando: number,
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,costo_unit_cents,
         referencia_tipo,referencia_id,motivo,actor,creado_en)
       VALUES (?,?,?,?,?,${COSTO_SEMBRADO},'compra','co-1',?,'duena@babycaleb.com',?)`,
    )
      .bind(id("mv"), codigo, bodega, delta, tipo, tipo === "ajuste" ? "conteo de octubre" : null, cuando)
      .run();
  }

  it("devuelve del más nuevo al más viejo", async () => {
    const { codigo, bodega } = await sembrar({ fisico: 10, reservado: 0, minimo: null });
    const t = ahora();
    await unMovimiento(codigo, bodega, 10, "compra", t - 3000);
    await unMovimiento(codigo, bodega, -2, "venta", t - 1000);

    const r = await movimientos.ejecutar(ctx(), { codigo, cuantos: 20 });
    expect(r.movimientos.map((m) => m.porque)).toEqual(["venta", "compra"]);
  });

  it("separa lo que entró de lo que salió", async () => {
    // El signo ya lo lleva `delta`; se nombra para que el modelo no tenga que
    // deducirlo y se equivoque en el borde.
    const { codigo, bodega } = await sembrar({ fisico: 10, reservado: 0, minimo: null });
    await unMovimiento(codigo, bodega, 10, "compra", ahora());
    await unMovimiento(codigo, bodega, -2, "venta", ahora() + 1);

    const r = await movimientos.ejecutar(ctx(), { codigo, cuantos: 20 });
    expect(r.movimientos[0]).toMatchObject({ entraron: 0, salieron: 2 });
    expect(r.movimientos[1]).toMatchObject({ entraron: 10, salieron: 0 });
  });

  it("NO devuelve quién lo hizo ni a cuánto costó", async () => {
    // `actor` puede ser una persona y el costo tiene su propio permiso: están
    // en la tabla, y que no estén aquí es a propósito (D-20).
    //
    // Se miran los VALORES, no la cadena del JSON entero. Esto era
    // `not.toMatch(/640|costo/)` sobre un `JSON.stringify(...)` y se puso rojo
    // en `main`, en verde en la corrida de al lado DEL MISMO COMMIT: los
    // identificadores de esta prueba se arman con la hora, y aquel milisegundo
    // fue 1794596946403 — que lleva un «640» dentro, en `…9464|03`. Lo mismo
    // `cuando`, que es la hora en crudo.
    //
    // Es la trampa §11 otra vez, y el barrido que la cerró con un ULID y un
    // «250» no vio esta porque buscó identificadores ALEATORIOS, y estos son
    // marcas de tiempo. La propiedad sí importa y se queda entera; lo que
    // estaba mal era la forma de comprobarla.
    const { codigo, bodega } = await sembrar({ fisico: 10, reservado: 0, minimo: null });
    await unMovimiento(codigo, bodega, 10, "compra", ahora());

    const numeros: number[] = [];
    const textos: string[] = [];
    const nombres: string[] = [];
    const recorrer = (v: unknown): void => {
      if (typeof v === "number") numeros.push(v);
      else if (typeof v === "string") textos.push(v);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          nombres.push(k);
          recorrer(x);
        }
      }
    };
    recorrer(await movimientos.ejecutar(ctx(), { codigo, cuantos: 20 }));

    // Quién lo hizo: en ningún texto, ni suelto ni dentro de otro.
    for (const t of textos) expect(t).not.toContain("duena@babycaleb.com");
    // El costo: ni como número bajo cualquier nombre…
    expect(numeros).not.toContain(COSTO_SEMBRADO);
    // …ni escrito como dinero. Con frontera de dígito a los lados, porque un
    // «640» metido dentro de 1794596946403 no es un costo, es la hora.
    for (const t of textos) expect(t).not.toMatch(/(^|\D)(640|6[.,]40)(\D|$)/);
    // Ni un campo que invite a ponerlo mañana.
    for (const n of nombres) expect(n).not.toMatch(/costo|precio|valor|cents/i);
  });

  it("respeta cuántos se le piden", async () => {
    const { codigo, bodega } = await sembrar({ fisico: 10, reservado: 0, minimo: null });
    for (let i = 0; i < 5; i += 1) await unMovimiento(codigo, bodega, 1, "compra", ahora() + i);

    const r = await movimientos.ejecutar(ctx(), { codigo, cuantos: 2 });
    expect(r.movimientos).toHaveLength(2);
  });

  it("el motivo de un ajuste se conserva: es la explicación", async () => {
    const { codigo, bodega } = await sembrar({ fisico: 10, reservado: 0, minimo: null });
    await unMovimiento(codigo, bodega, -1, "ajuste", ahora());

    const r = await movimientos.ejecutar(ctx(), { codigo, cuantos: 5 });
    expect(r.movimientos[0]?.motivo).toBe("conteo de octubre");
  });
});

describe("los argumentos se validan en el servidor", () => {
  it("«cuantos» tiene techo", async () => {
    // 06-asistente §6: no se cuenta con que el modelo valide nada. Pedir
    // diez mil movimientos no puede ser una forma de tumbar la consulta.
    expect(movimientos.parametros.safeParse({ codigo: "BC-1", cuantos: 10_000 }).success).toBe(false);
    expect(movimientos.parametros.safeParse({ codigo: "BC-1", cuantos: 0 }).success).toBe(false);
  });

  it("«cuantos» tiene un valor por omisión, así que basta el código", () => {
    const r = movimientos.parametros.safeParse({ codigo: "BC-1" });
    expect(r.success && r.data.cuantos).toBe(20);
  });

  it("movimientos exige el código", () => {
    expect(movimientos.parametros.safeParse({}).success).toBe(false);
  });

  it("un argumento de más nunca llega a la herramienta", () => {
    // Al modelo se le manda el esquema cerrado (`additionalProperties: false`),
    // pero 06-asistente §6 dice que no se cuenta con que el modelo valide nada.
    // zod no rechaza lo que sobra: lo DESCARTA, y eso es lo que importa — que
    // `ejecutar` reciba solo lo declarado. Fallar por un campo de más sería
    // peor: dejaría a la dueña sin respuesta por un desliz del modelo.
    const r = verStock.parametros.safeParse({ codigo: "BC-1", inventado: 1, bodega: "Principal" });
    expect(r.success).toBe(true);
    expect(r.success && Object.keys(r.data).sort()).toEqual(["bodega", "codigo"]);
  });
});
