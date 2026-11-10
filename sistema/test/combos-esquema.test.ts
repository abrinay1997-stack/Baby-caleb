import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Lo que el esquema de combos IMPIDE (F4.19).
 *
 * No se comprueba que el SQL esté bien escrito —eso lo haría cualquier
 * SQLite— sino que D1 HACE CUMPLIR lo que el diseño da por sentado. Y aquí lo
 * que da por sentado es fuerte: que NO EXISTEN los ciclos. Si existieran, una
 * consulta de existencias sobre un combo no terminaría nunca, o terminaría con
 * un número inventado — y ese número es el que el bot le dice a una clienta.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let productoId: string;

beforeEach(async () => {
  productoId = id("prod");
  await env.DB.prepare(
    "INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)",
  )
    .bind(productoId, "panal", "Para combos", id("slug"), ahora())
    .run();
});

async function variante(esCombo = false): Promise<string> {
  const codigo = id("CB").toUpperCase();
  await env.DB.prepare(
    `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
       publicado,activo,version,actualizado_en,es_combo)
     VALUES (?,?,?,1,100,0,1,1,?,?)`,
  )
    .bind(codigo, productoId, "x", ahora(), esCombo ? 1 : 0)
    .run();
  return codigo;
}

const meter = (combo: string, componente: string, cantidad = 1) =>
  env.DB.prepare(
    "INSERT INTO combo_componentes (combo_codigo,codigo,cantidad) VALUES (?,?,?)",
  )
    .bind(combo, componente, cantidad)
    .run();

describe("una receta normal entra", () => {
  it("un combo con dos componentes", async () => {
    const combo = await variante(true);
    const a = await variante();
    const b = await variante();
    await meter(combo, a, 2);
    await meter(combo, b, 1);

    const { results } = await env.DB.prepare(
      "SELECT codigo, cantidad FROM combo_componentes WHERE combo_codigo = ? ORDER BY codigo",
    )
      .bind(combo)
      .all<{ codigo: string; cantidad: number }>();
    expect(results).toHaveLength(2);
  });
});

describe("los ciclos son imposibles, no improbables", () => {
  it("un combo no se puede llevar a sí mismo", async () => {
    const combo = await variante(true);
    await expect(meter(combo, combo)).rejects.toThrow();
  });

  it("un combo no puede llevar OTRO combo dentro", async () => {
    const a = await variante(true);
    const b = await variante(true);
    // Sin esto, A lleva B y B lleva A: la consulta de existencias da vueltas.
    await expect(meter(a, b)).rejects.toThrow();
  });

  it("y no se puede esquivar en dos pasos", async () => {
    // El truco: meterlo primero como componente normal y marcarlo combo
    // después. Es el camino que deja abierto vigilar solo la inserción.
    const combo = await variante(true);
    const pieza = await variante(false);
    await meter(combo, pieza);

    await expect(
      env.DB.prepare("UPDATE variantes SET es_combo = 1 WHERE codigo = ?").bind(pieza).run(),
    ).rejects.toThrow();
  });

  it("pero marcar combo a una variante suelta sí se puede", async () => {
    // El contraste importa: si el trigger prohibiera siempre, la prueba de
    // arriba pasaría sin demostrar nada.
    const suelta = await variante(false);
    await env.DB.prepare("UPDATE variantes SET es_combo = 1 WHERE codigo = ?").bind(suelta).run();
    const v = await env.DB.prepare("SELECT es_combo FROM variantes WHERE codigo = ?")
      .bind(suelta)
      .first<{ es_combo: number }>();
    expect(v?.es_combo).toBe(1);
  });
});

describe("lo demás que el esquema no deja pasar", () => {
  it("una cantidad de cero o negativa", async () => {
    const combo = await variante(true);
    const pieza = await variante();
    await expect(meter(combo, pieza, 0)).rejects.toThrow();
    await expect(meter(combo, pieza, -1)).rejects.toThrow();
  });

  it("el mismo componente dos veces en la misma receta", async () => {
    const combo = await variante(true);
    const pieza = await variante();
    await meter(combo, pieza, 1);
    // Dos filas del mismo componente serían dos cantidades para lo mismo, y
    // cualquier suma dependería de cuál se lea primero.
    await expect(meter(combo, pieza, 2)).rejects.toThrow();
  });

  it("un componente que no existe", async () => {
    const combo = await variante(true);
    await expect(meter(combo, "NO-EXISTE-NUNCA")).rejects.toThrow();
  });

  it("es_combo solo acepta 0 o 1", async () => {
    const v = await variante();
    await expect(
      env.DB.prepare("UPDATE variantes SET es_combo = 2 WHERE codigo = ?").bind(v).run(),
    ).rejects.toThrow();
  });
});

describe("una receta no cuelga de algo que no es un combo", () => {
  it("una variante normal NO puede tener componentes", async () => {
    const normal = await variante(false);
    const pieza = await variante();
    // Serían datos que nadie consulta —nada sabe que es un combo— pero que
    // quedan ahí y mienten sobre lo que es esa variante.
    await expect(meter(normal, pieza)).rejects.toThrow();
  });

  it("un combo con receta no puede dejar de ser combo", async () => {
    const combo = await variante(true);
    const pieza = await variante();
    await meter(combo, pieza);
    // Si pudiera, su receta quedaría colgando de algo que ya no es un combo.
    await expect(
      env.DB.prepare("UPDATE variantes SET es_combo = 0 WHERE codigo = ?").bind(combo).run(),
    ).rejects.toThrow();
  });

  it("pero un combo VACÍO sí puede dejar de serlo", async () => {
    const combo = await variante(true);
    await env.DB.prepare("UPDATE variantes SET es_combo = 0 WHERE codigo = ?").bind(combo).run();
    const v = await env.DB.prepare("SELECT es_combo FROM variantes WHERE codigo = ?")
      .bind(combo)
      .first<{ es_combo: number }>();
    expect(v?.es_combo).toBe(0);
  });
});
