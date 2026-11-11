import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";
import {
  agendar,
  cancelar,
  enunciadosDeCobro,
  enunciadosDeTransicion,
  type ContextoTransicion,
} from "../src/db/transiciones";

/**
 * Mover un pedido de un estado a otro (F4.2).
 *
 * Lo que se vigila: que la condición se compruebe DENTRO del UPDATE. Leer el
 * pedido, decidir, y escribir después deja una grieta del tamaño de un pedido
 * — entre la lectura y la escritura otro proceso puede haberlo cancelado, y
 * acabaría agendado y cancelado a la vez, con la reserva liberada dos veces.
 */

let clienteId: string;
let n = 0;
const ahora = () => Date.now();

const ctxT = (): ContextoTransicion => ({ db: env.DB, ahora: ahora(), actor: "pruebas" });
const ctxP = (sobre: Partial<ContextoPedido> = {}): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: "pruebas",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
  ...sobre,
});

beforeEach(async () => {
  clienteId = `cli-${Date.now()}-${n++}`;
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, "Ana", ahora(), ahora())
    .run();
  await env.DB.batch([
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 20 WHERE codigo = 'NAT-M' AND bodega_id = (SELECT id FROM bodegas WHERE activa = 1 LIMIT 1)",
    ),
  ]);
});

/** Un pedido de $50 recién creado, en `por_abonar`. */
async function unPedido(sobre: Partial<ContextoPedido> = {}) {
  const r = await crearPedido(ctxP(sobre), {
    idempotencia: `idem-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

const cobrar = async (pedidoId: string, totalCents: number, pagado: number) => {
  // La versión se LEE justo antes: es lo que `enunciadosDeCobro` usa para
  // detectar que nadie se metió en medio.
  const v = await env.DB.prepare("SELECT version FROM pedidos WHERE id = ?")
    .bind(pedidoId)
    .first<{ version: number }>();
  await env.DB.batch(
    enunciadosDeCobro(ctxT(), pedidoId, totalCents, pagado, v?.version ?? 0),
  );
};

const estadoDe = async (id: string) =>
  await env.DB.prepare("SELECT estado, estado_pago, pagado_cents FROM pedidos WHERE id = ?")
    .bind(id)
    .first<{ estado: string; estado_pago: string; pagado_cents: number }>();

describe("agendar exige el abono", () => {
  it("sin un centavo pagado NO se agenda", async () => {
    const p = await unPedido();
    const r = await agendar(ctxT(), p.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
    expect((await estadoDe(p.id))?.estado).toBe("por_abonar");
  });

  it("con el abono mínimo sí", async () => {
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 500);
    expect((await agendar(ctxT(), p.id)).ok).toBe(true);
    expect((await estadoDe(p.id))?.estado).toBe("agendado");
  });

  it("un centavo por debajo del mínimo no alcanza", async () => {
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 499);
    expect((await agendar(ctxT(), p.id)).ok).toBe(false);
  });

  it("manda el mínimo COPIADO en el pedido, no el de los ajustes de hoy", async () => {
    // El pedido se creó con mínimo de $15. Que hoy el ajuste diga $5 no puede
    // cambiar la regla de un pedido que ya existe.
    const p = await unPedido({ abonoMinimoCents: 1500 });
    await cobrar(p.id, p.totalCents, 500);
    expect((await agendar(ctxT(), p.id)).ok).toBe(false);
    await cobrar(p.id, p.totalCents, 1500);
    expect((await agendar(ctxT(), p.id)).ok).toBe(true);
  });

  it("un pedido ya agendado no se agenda dos veces", async () => {
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 500);
    await agendar(ctxT(), p.id);
    const otra = await agendar(ctxT(), p.id);
    expect(otra.ok).toBe(false);
    if (!otra.ok) expect(otra.codigo).toBe("transicion_invalida");
  });

  it("un pedido que no existe se dice, no se revienta", async () => {
    const r = await agendar(ctxT(), "no-existe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});

describe("una zona que exige pago total", () => {
  it("no se agenda con un abono: hace falta todo", async () => {
    const r = await crearPedido(ctxP(), {
      idempotencia: `idem-${n++}`,
      clienteId,
      origen: "web",
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
      zona: "Colón",
    });
    // Si la zona no existe en la carga inicial, esta prueba no aplica.
    if (!r.ok) return;
    const esPagoTotal = await env.DB.prepare(
      "SELECT requiere_pago_total AS t FROM pedidos WHERE id = ?",
    )
      .bind(r.datos.id)
      .first<{ t: number }>();
    if (esPagoTotal?.t !== 1) return;

    await cobrar(r.datos.id, r.datos.totalCents, r.datos.totalCents - 1);
    expect((await agendar(ctxT(), r.datos.id)).ok).toBe(false);
    await cobrar(r.datos.id, r.datos.totalCents, r.datos.totalCents);
    expect((await agendar(ctxT(), r.datos.id)).ok).toBe(true);
  });
});

describe("el estado de pago se DERIVA, no se escribe a mano", () => {
  it("cero es sin_pago, parte es abonado, todo es pagado", async () => {
    const p = await unPedido();
    expect((await estadoDe(p.id))?.estado_pago).toBe("sin_pago");

    await cobrar(p.id, p.totalCents, 500);
    expect((await estadoDe(p.id))?.estado_pago).toBe("abonado");

    await cobrar(p.id, p.totalCents, p.totalCents);
    expect((await estadoDe(p.id))?.estado_pago).toBe("pagado");
  });

  it("no se puede cobrar más de lo que vale el pedido", async () => {
    // Lo impide la tabla, y aquí se comprueba que el batch entero se cae en
    // vez de dejar el pedido a medias.
    const p = await unPedido();
    await expect(cobrar(p.id, p.totalCents, p.totalCents + 1)).rejects.toThrow();
    expect((await estadoDe(p.id))?.pagado_cents).toBe(0);
  });
});

describe("cancelar libera la reserva", () => {
  const reservadas = async () =>
    (
      await env.DB.prepare(
        "SELECT COALESCE(SUM(reservado),0) AS r FROM existencias WHERE codigo = 'NAT-M'",
      ).first<{ r: number }>()
    )?.r ?? -1;

  it("lo reservado vuelve a estar libre", async () => {
    const p = await unPedido();
    expect(await reservadas()).toBe(1);

    const r = await cancelar(ctxT(), p.id, "la clienta desistió");
    expect(r.ok).toBe(true);
    expect(await reservadas()).toBe(0);
    expect((await estadoDe(p.id))?.estado).toBe("cancelado");
  });

  it("se puede cancelar un pedido ya agendado", async () => {
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 500);
    await agendar(ctxT(), p.id);
    expect((await cancelar(ctxT(), p.id, "se arrepintió")).ok).toBe(true);
    expect(await reservadas()).toBe(0);
  });

  it("el abono NO desaparece al cancelar", async () => {
    // Ese dinero existe y alguien tiene que decidir si se devuelve o queda
    // como crédito. Ponerlo en sin_pago haría desaparecer la deuda.
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 500);
    await cancelar(ctxT(), p.id, "x");
    const e = await estadoDe(p.id);
    expect(e?.estado_pago).toBe("abonado");
    expect(e?.pagado_cents).toBe(500);
  });

  it("cancelar dos veces no libera dos veces", async () => {
    // Es el fallo que dejaría stock fantasma: la segunda cancelación restaría
    // otra vez y las reservas quedarían por debajo de lo real.
    const p = await unPedido();
    await cancelar(ctxT(), p.id, "x");
    const otra = await cancelar(ctxT(), p.id, "x");
    expect(otra.ok).toBe(false);
    expect(await reservadas()).toBe(0);
  });

  it("si lo apartado no alcanza, la cancelación FALLA en vez de dejar el stock trabado", async () => {
    // El caso que el control de este módulo decía cazar y no cazaba.
    //
    // Si `existencias.reservado` queda por debajo de lo que el pedido dice
    // tener apartado —porque alguien ajustó el inventario a mano, o por una
    // liberación a medias— el `UPDATE … WHERE reservado >= ?` no casa con
    // ninguna fila. Y el control comprobaba `reservado >= 0`, que la tabla YA
    // exige con un CHECK: contaba filas que existen, no que el UPDATE hubiera
    // hecho algo. Salía 1, el batch pasaba, y el pedido quedaba cancelado con
    // su reserva puesta: stock trabado para siempre y nada que avisara.
    //
    // Lo correcto es reventar. Un pedido vivo cuya reserva no cuadra es un
    // dato roto, y seguir adelante en silencio lo entierra.
    const p = await unPedido();
    await env.DB.prepare("UPDATE existencias SET reservado = 0 WHERE codigo = 'NAT-M'").run();

    const r = await cancelar(ctxT(), p.id, "x");
    expect(r.ok, "cancelar debería fallar: lo apartado no alcanza").toBe(false);
    // Y el pedido NO queda cancelado: el batch es todo o nada.
    expect((await estadoDe(p.id))?.estado).not.toBe("cancelado");
  });

  it("un pedido en ruta NO se cancela: se devuelve", async () => {
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 500);
    await agendar(ctxT(), p.id);
    await env.DB.batch([
      env.DB.prepare("UPDATE pedidos SET estado = 'en_ruta' WHERE id = ?").bind(p.id),
    ]);
    const r = await cancelar(ctxT(), p.id, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain("devolución");
  });
});

describe("cada transición deja su rastro", () => {
  it("la bitácora cuenta de dónde a dónde y quién", async () => {
    const p = await unPedido();
    await cobrar(p.id, p.totalCents, 500);
    await agendar(ctxT(), p.id);
    await cancelar(ctxT(), p.id, "se arrepintió");

    const { results } = await env.DB.prepare(
      "SELECT tipo, de, a, actor FROM pedido_eventos WHERE pedido_id = ? ORDER BY creado_en, id",
    )
      .bind(p.id)
      .all<{ tipo: string; de: string | null; a: string; actor: string }>();

    expect(results.map((r) => `${r.de ?? "-"}->${r.a}`)).toEqual([
      "-->por_abonar",
      "por_abonar->agendado",
      "agendado->cancelado",
    ]);
    expect(results.every((r) => r.actor === "pruebas")).toBe(true);
  });
});

describe("la condición va DENTRO del UPDATE, no antes", () => {
  it("si el pedido ya no está en el estado de partida, el batch se cae entero", async () => {
    // Esto es la carrera, simulada: se piden los enunciados para pasar de
    // `por_abonar` a `agendado` cuando el pedido YA está cancelado. Es lo que
    // pasaría si entre la lectura y la escritura otro proceso lo moviera.
    //
    // Sin `WHERE … AND estado = ?`, el UPDATE pisaría el estado y el pedido
    // quedaría agendado Y cancelado a la vez, con la reserva liberada y la
    // mercancía comprometida. Con él, el UPDATE no casa con nada, el control
    // sale 0 y no queda rastro de la transición.
    const p = await unPedido();
    await cancelar(ctxT(), p.id, "se adelantó otro proceso");

    const antes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pedido_eventos WHERE pedido_id = ?",
    )
      .bind(p.id)
      .first<{ n: number }>();

    await expect(
      env.DB.batch(enunciadosDeTransicion(ctxT(), p.id, "por_abonar", "agendado")),
    ).rejects.toThrow();

    // Ni el estado cambió ni se escribió el evento: el batch es todo o nada.
    expect((await estadoDe(p.id))?.estado).toBe("cancelado");
    const despues = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pedido_eventos WHERE pedido_id = ?",
    )
      .bind(p.id)
      .first<{ n: number }>();
    expect(despues?.n).toBe(antes?.n);
  });
});
