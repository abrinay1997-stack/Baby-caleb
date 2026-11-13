import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido } from "./pedidos";
import { soltarVencidos } from "./vencidos";

/**
 * Las reservas vencidas sueltan su mercancía.
 *
 * Un pedido `por_abonar` aparta sus cajas para que la clienta pague con calma,
 * y lleva un plazo. Cumplido el plazo no pasaba NADA: el pedido seguía ahí y
 * las cajas seguían apartadas para siempre. La dueña veía «agotado» en algo
 * que tenía en la bodega.
 *
 * Lo venenoso es que la métrica YA los contaba —`por_abonar_vencidos`— y el
 * panel YA enseñaba el número. Parecía atendido. Contar no es actuar.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let productoId: string;
let bodegaId: string;
let bodega: string;
let zonaId: string;
let zona: string;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ajustes").run();
  productoId = id("prod");
  bodegaId = id("bod");
  bodega = `Bodega ${bodegaId}`;
  zonaId = id("zon");
  zona = `Zona ${zonaId}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
      productoId, "panal", "Para vencidos", id("slug"), ahora(),
    ),
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(bodegaId, bodega),
    env.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,region,metodo,tarifa_cents,actualizado_en)
       VALUES (?,?,'ciudad','motorizado',500,?)`,
    ).bind(zonaId, zona, ahora()),
  ]);
});

async function variante(fisico: number): Promise<string> {
  const codigo = id("PZ").toUpperCase();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en) VALUES (?,?,?,1,5000,1,1,1,?)`,
    ).bind(codigo, productoId, `pieza ${codigo}`, ahora()),
    env.DB.prepare("INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)").bind(
      codigo, bodegaId, fisico,
    ),
  ]);
  return codigo;
}

/** Un pedido por abonar, con su plazo ya cumplido. */
async function porAbonarVencido(opts: { abono?: number } = {}) {
  const codigo = await variante(50);
  const clienteId = id("cli");
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, `Clienta ${clienteId}`, ahora(), ahora())
    .run();

  const r = await crearPedido(
    { db: env.DB, ahora: ahora(), actor: "prueba", abonoMinimoCents: 500, minutosParaAbonar: 30 },
    {
      idempotencia: id("idem"),
      clienteId,
      origen: "web",
      lineas: [{ codigo, cantidad: 2, bodega }],
      zona,
    },
  );
  if (!r.ok) throw new Error(`no se pudo crear el pedido: ${r.mensaje}`);

  if (opts.abono !== undefined && opts.abono > 0) {
    await env.DB.prepare("UPDATE pedidos SET pagado_cents = ?, estado_pago = 'abonado' WHERE id = ?")
      .bind(opts.abono, r.datos.id)
      .run();
  }
  return { pedidoId: r.datos.id, codigo };
}

const reservado = async (codigo: string) =>
  (
    await env.DB.prepare("SELECT reservado FROM existencias WHERE codigo = ?")
      .bind(codigo)
      .first<{ reservado: number }>()
  )?.reservado;

const estado = async (pedidoId: string) =>
  (
    await env.DB.prepare("SELECT estado FROM pedidos WHERE id = ?")
      .bind(pedidoId)
      .first<{ estado: string }>()
  )?.estado;

/** El cron corriendo más tarde del plazo. */
const masTarde = () => ({ db: env.DB, ahora: ahora() + 60 * 60 * 1000, actor: "cron" });

describe("las reservas vencidas vuelven a la venta", () => {
  it("un pedido vencido sin pagar nada se cancela y suelta su mercancía", async () => {
    const p = await porAbonarVencido();
    expect(await reservado(p.codigo)).toBe(2);

    const r = await soltarVencidos(masTarde());

    expect(r.soltados).toContain(p.pedidoId);
    expect(await estado(p.pedidoId)).toBe("cancelado");
    expect(await reservado(p.codigo)).toBe(0);
  });

  it("antes del plazo no se toca nada", async () => {
    const p = await porAbonarVencido();
    const r = await soltarVencidos({ db: env.DB, ahora: ahora(), actor: "cron" });
    expect(r.soltados).not.toContain(p.pedidoId);
    expect(await estado(p.pedidoId)).toBe("por_abonar");
    expect(await reservado(p.codigo)).toBe(2);
  });

  it("uno con abono NO se cancela solo: ese dinero lo decide una persona", async () => {
    /**
     * Qué pasa con el abono de un pedido que se cancela —si se devuelve, si
     * queda como crédito, si se pierde— es una regla que la dueña todavía no
     * ha decidido: el ajuste `cancelacion_con_abono` está en PENDIENTE.
     * Cancelarlo por nuestra cuenta sería inventarse esa regla con dinero de
     * una clienta de verdad.
     */
    const p = await porAbonarVencido({ abono: 500 });
    const r = await soltarVencidos(masTarde());

    expect(r.conAbono).toContain(p.pedidoId);
    expect(r.soltados).not.toContain(p.pedidoId);
    expect(await estado(p.pedidoId)).toBe("por_abonar");
    // Y su mercancía sigue apartada, que es lo correcto: ella pagó algo.
    expect(await reservado(p.codigo)).toBe(2);
  });

  it("dos vueltas del cron no cancelan dos veces", async () => {
    const p = await porAbonarVencido();
    const a = await soltarVencidos(masTarde());
    const b = await soltarVencidos(masTarde());
    expect(a.soltados).toContain(p.pedidoId);
    expect(b.soltados).not.toContain(p.pedidoId);
    expect(await reservado(p.codigo)).toBe(0);
  });
});
