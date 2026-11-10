import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido } from "../src/db/pedidos";
import { cancelar } from "../src/db/transiciones";

/**
 * Vender un combo aparta SUS PIEZAS, y cancelarlo las devuelve.
 *
 * Es la parte peligrosa de los combos: vender uno sin apartar sus piezas es
 * vender dos veces el mismo pañal. Y liberar de más o de menos al cancelar
 * deja existencias bloqueadas para siempre, sin que nada falle.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let productoId: string;
let bodegaId: string;
let clienteId: string;

const ctx = () => ({
  db: env.DB,
  ahora: ahora(),
  actor: "yarielis",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
});

beforeEach(async () => {
  productoId = id("prod");
  clienteId = id("cli");
  const b = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
  bodegaId = b?.id ?? "";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
      productoId, "panal", "Combos", id("slug"), ahora(),
    ),
    env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)").bind(
      clienteId, "Ana", ahora(), ahora(),
    ),
  ]);
});

async function pieza(fisico: number): Promise<string> {
  const codigo = id("PZ").toUpperCase();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en) VALUES (?,?,?,1,100,1,1,1,?)`,
    ).bind(codigo, productoId, `pieza ${codigo}`, ahora()),
    env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)",
    ).bind(codigo, bodegaId, fisico),
  ]);
  return codigo;
}

async function combo(receta: { codigo: string; cantidad: number }[]): Promise<string> {
  const codigo = id("CO").toUpperCase();
  await env.DB.prepare(
    `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
       publicado,activo,version,actualizado_en,es_combo) VALUES (?,?,?,1,900,1,1,1,?,1)`,
  )
    .bind(codigo, productoId, `combo ${codigo}`, ahora())
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

const reservadoDe = async (codigo: string) =>
  (
    await env.DB.prepare("SELECT reservado FROM existencias WHERE codigo = ?")
      .bind(codigo)
      .first<{ reservado: number }>()
  )?.reservado;

const pedir = (codigo: string, cantidad: number) =>
  crearPedido(ctx(), {
    idempotencia: `idem-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas: [{ codigo, cantidad }],
  });

describe("vender un combo aparta sus piezas", () => {
  it("la receta se multiplica por lo pedido", async () => {
    const a = await pieza(100);
    const b = await pieza(100);
    const c = await combo([{ codigo: a, cantidad: 2 }, { codigo: b, cantidad: 1 }]);

    const r = await pedir(c, 3);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect(await reservadoDe(a), "2 por combo × 3 combos").toBe(6);
    expect(await reservadoDe(b), "1 por combo × 3 combos").toBe(3);
  });

  it("no se vende un combo si una sola pieza no alcanza", async () => {
    const a = await pieza(100);
    const b = await pieza(2); // solo da para 2 combos
    const c = await combo([{ codigo: a, cantidad: 1 }, { codigo: b, cantidad: 1 }]);

    const r = await pedir(c, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("sin_stock");
    // Y no apartó nada de la que sí alcanzaba.
    expect(await reservadoDe(a)).toBe(0);
  });

  it("un combo SIN receta no se vende", async () => {
    const c = await combo([]);
    const r = await pedir(c, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("sin_stock");
  });

  it("queda escrito LO APARTADO, no la receta", async () => {
    const a = await pieza(100);
    const c = await combo([{ codigo: a, cantidad: 2 }]);
    await pedir(c, 4);

    const guardado = await env.DB.prepare(
      `SELECT plc.codigo, plc.cantidad FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id WHERE pl.codigo = ?`,
    )
      .bind(c)
      .first<{ codigo: string; cantidad: number }>();
    // 8, no 2: la receta YA multiplicada. Guardar la receta obligaría a
    // volver a leerla al cancelar, y para entonces puede haber cambiado.
    expect(guardado?.cantidad).toBe(8);
    expect(guardado?.codigo).toBe(a);
  });
});

describe("cancelar devuelve exactamente lo que se apartó", () => {
  it("el inventario queda como estaba", async () => {
    const a = await pieza(100);
    const b = await pieza(50);
    const c = await combo([{ codigo: a, cantidad: 3 }, { codigo: b, cantidad: 1 }]);

    const r = await pedir(c, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await reservadoDe(a)).toBe(15);

    const x = await cancelar(ctx(), r.datos.id, "se arrepintió");
    expect(x.ok, JSON.stringify(x)).toBe(true);

    expect(await reservadoDe(a), "vuelve a cero").toBe(0);
    expect(await reservadoDe(b), "vuelve a cero").toBe(0);
  });

  it("aunque la receta haya CAMBIADO entre la venta y la cancelación", async () => {
    const a = await pieza(100);
    const c = await combo([{ codigo: a, cantidad: 2 }]);

    const r = await pedir(c, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await reservadoDe(a)).toBe(10);

    // Yarielis cambia la receta: ahora el combo lleva 5 en vez de 2.
    await env.DB.prepare(
      "UPDATE combo_componentes SET cantidad = 5 WHERE combo_codigo = ? AND codigo = ?",
    )
      .bind(c, a)
      .run();

    await cancelar(ctx(), r.datos.id, "cambió de idea");

    // Si la cancelación volviera a leer la receta, liberaría 25 de 10
    // apartadas — o fallaría el control y dejaría el pedido colgado. Con lo
    // apartado guardado, devuelve 10.
    expect(await reservadoDe(a), "devuelve lo que QUITÓ, no lo que dice la receta de hoy").toBe(0);
  });

  it("una variante normal sigue funcionando igual", async () => {
    const a = await pieza(20);
    const r = await crearPedido(ctx(), {
      idempotencia: `idem-${Date.now()}-${n++}`,
      clienteId,
      origen: "web",
      lineas: [{ codigo: a, cantidad: 7 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await reservadoDe(a)).toBe(7);

    await cancelar(ctx(), r.datos.id, "x");
    expect(await reservadoDe(a)).toBe(0);
  });
});
