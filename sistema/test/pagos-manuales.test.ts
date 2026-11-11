import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";
import { enunciadosDeCobro } from "../src/db/transiciones";
import {
  confirmarPago,
  enunciadosDeConfirmacion,
  registrarComprobante,
  rechazarPago,
} from "../src/db/pagos";

/**
 * Pago manual (F4.4): Yappy, transferencia, efectivo.
 *
 * Es como Baby Caleb cobra HOY. Lo que se vigila es la regla dura del
 * proyecto: **el navegador no decide un pago**. Una captura que manda una
 * clienta es una AFIRMACIÓN, no un cobro — puede estar recortada, ser de otro
 * pedido, ser de ayer, o ser de otra persona.
 *
 * Sin esa separación, cualquiera que sepa el número de un pedido sube una
 * imagen y se agenda una entrega.
 */

let clienteId: string;
let n = 0;
const ahora = () => Date.now();
const ctx = () => ({ db: env.DB, ahora: ahora(), actor: "yarielis" });

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
      "UPDATE existencias SET fisico = 50 WHERE codigo = 'NAT-M' AND bodega_id = (SELECT id FROM bodegas WHERE activa = 1 LIMIT 1)",
    ),
  ]);
});

async function unPedido(sobre: Partial<ContextoPedido> = {}) {
  const r = await crearPedido(ctxP(sobre), {
    idempotencia: `idem-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  });
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

const estadoDe = (id: string) =>
  env.DB.prepare("SELECT estado, estado_pago, pagado_cents FROM pedidos WHERE id = ?")
    .bind(id)
    .first<{ estado: string; estado_pago: string; pagado_cents: number }>();

const comprobante = (pedidoId: string, montoCents: number, sobre = {}) =>
  registrarComprobante(ctx(), {
    idempotencia: `comp-${Date.now()}-${n++}`,
    pedidoId,
    montoCents,
    metodo: "yappy",
    tipo: "abono",
    ...sobre,
  });

describe("un comprobante NO es un pago", () => {
  it("se registra en «confirmando» y el pedido no se mueve", async () => {
    const p = await unPedido();
    const r = await comprobante(p.id, 5000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.estado).toBe("confirmando");

    // Lo que importa: el pedido sigue igual. Nadie se agendó una entrega
    // subiendo una imagen.
    const e = await estadoDe(p.id);
    expect(e?.estado).toBe("por_abonar");
    expect(e?.pagado_cents).toBe(0);
    expect(e?.estado_pago).toBe("sin_pago");
  });

  it("y hace falta que una persona lo confirme", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, 5000);
    if (!c.ok) throw new Error(c.mensaje);

    const r = await confirmarPago(ctx(), c.datos.pagoId);
    expect(r.ok).toBe(true);

    const e = await estadoDe(p.id);
    expect(e?.pagado_cents).toBe(5000);
    expect(e?.estado_pago).toBe("pagado");
  });
});

describe("confirmar agenda el pedido si ya alcanza", () => {
  it("con el abono mínimo, el pedido queda agendado solo", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, 500);
    if (!c.ok) return;

    const r = await confirmarPago(ctx(), c.datos.pagoId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.agendado).toBe(true);
    expect((await estadoDe(p.id))?.estado).toBe("agendado");
  });

  it("por debajo del mínimo, se cobra pero NO se agenda", async () => {
    const p = await unPedido({ abonoMinimoCents: 2000 });
    const c = await comprobante(p.id, 500);
    if (!c.ok) return;

    const r = await confirmarPago(ctx(), c.datos.pagoId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.agendado).toBe(false);

    const e = await estadoDe(p.id);
    expect(e?.estado).toBe("por_abonar");
    expect(e?.pagado_cents).toBe(500); // el dinero sí entró
  });

  it("dos abonos que juntos alcanzan, agendan al segundo", async () => {
    const p = await unPedido({ abonoMinimoCents: 2000 });
    const a = await comprobante(p.id, 1000);
    const b = await comprobante(p.id, 1500);
    if (!a.ok || !b.ok) return;

    expect((await confirmarPago(ctx(), a.datos.pagoId)).ok).toBe(true);
    expect((await estadoDe(p.id))?.estado).toBe("por_abonar");

    const r = await confirmarPago(ctx(), b.datos.pagoId);
    if (r.ok) expect(r.datos.agendado).toBe(true);
    expect((await estadoDe(p.id))?.estado).toBe("agendado");
  });
});

describe("no se cobra de más", () => {
  it("un comprobante por encima del total se rechaza al registrarlo", async () => {
    const p = await unPedido();
    const r = await comprobante(p.id, p.totalCents + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("monto_no_coincide");
  });

  it("y dos comprobantes que JUNTOS se pasan, tampoco", async () => {
    // Este es el que se escapa si solo se mira el pago que entra: dos
    // capturas de $50 cada una, en un pedido de $50.
    const p = await unPedido();
    expect((await comprobante(p.id, p.totalCents)).ok).toBe(true);
    const segundo = await comprobante(p.id, p.totalCents);
    expect(segundo.ok).toBe(false);
  });

  it("un monto de cero o negativo no es un pago", async () => {
    const p = await unPedido();
    for (const malo of [0, -500, 1.5, Number.NaN]) {
      expect((await comprobante(p.id, malo)).ok, `aceptó ${malo}`).toBe(false);
    }
  });

  it("un método que no es manual se rechaza", async () => {
    const p = await unPedido();
    const r = await comprobante(p.id, 500, { metodo: "tarjeta" });
    expect(r.ok).toBe(false);
  });
});

describe("el segundo clic del mismo botón", () => {
  it("no registra dos comprobantes por el mismo dinero", async () => {
    const p = await unPedido();
    const clave = `comp-doble-${Date.now()}`;
    const uno = await registrarComprobante(ctx(), {
      idempotencia: clave, pedidoId: p.id, montoCents: 500, metodo: "yappy", tipo: "abono",
    });
    const dos = await registrarComprobante(ctx(), {
      idempotencia: clave, pedidoId: p.id, montoCents: 500, metodo: "yappy", tipo: "abono",
    });
    expect(uno.ok).toBe(true);
    expect(dos.ok).toBe(false);
    if (!dos.ok) expect(dos.codigo).toBe("repetido");
  });

  it("y confirmar dos veces no suma dos veces", async () => {
    // Dos personas pueden estar mirando el mismo comprobante en el panel.
    const p = await unPedido();
    const c = await comprobante(p.id, 500);
    if (!c.ok) return;

    expect((await confirmarPago(ctx(), c.datos.pagoId)).ok).toBe(true);
    const otra = await confirmarPago(ctx(), c.datos.pagoId);
    expect(otra.ok).toBe(false);
    expect((await estadoDe(p.id))?.pagado_cents).toBe(500);
  });
});

describe("rechazar un comprobante", () => {
  it("no lo borra: lo marca, y deja dicho por qué", async () => {
    // Un comprobante rechazado es parte de lo que pasó con ese pedido.
    // Borrarlo deja a quien lo mire mañana sin saber por qué la clienta
    // insiste en que ya pagó.
    const p = await unPedido();
    const c = await comprobante(p.id, 500);
    if (!c.ok) return;

    expect((await rechazarPago(ctx(), c.datos.pagoId, "la captura es de otro pedido")).ok).toBe(true);

    const pago = await env.DB.prepare("SELECT estado, confirmado_por FROM pagos WHERE id = ?")
      .bind(c.datos.pagoId)
      .first<{ estado: string; confirmado_por: string }>();
    expect(pago?.estado).toBe("rechazado");
    expect(pago?.confirmado_por).toBe("yarielis");

    const ev = await env.DB.prepare(
      "SELECT datos_json FROM pedido_eventos WHERE pedido_id = ? AND tipo = 'pago_rechazado'",
    )
      .bind(p.id)
      .first<{ datos_json: string }>();
    expect(ev?.datos_json).toContain("otro pedido");

    expect((await estadoDe(p.id))?.pagado_cents).toBe(0);
  });

  it("un rechazo sin motivo no le sirve a nadie", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, 500);
    if (!c.ok) return;
    expect((await rechazarPago(ctx(), c.datos.pagoId, "   ")).ok).toBe(false);
  });

  it("un comprobante ya rechazado libera su cupo del total", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, p.totalCents);
    if (!c.ok) return;

    // Con el primero pendiente, no cabe otro por el total.
    expect((await comprobante(p.id, p.totalCents)).ok).toBe(false);

    await rechazarPago(ctx(), c.datos.pagoId, "no se ve el monto");
    // Rechazado el primero, el segundo sí cabe.
    expect((await comprobante(p.id, p.totalCents)).ok).toBe(true);
  });
});

describe("un pedido cancelado no recibe pagos", () => {
  it("se dice, no se acepta en silencio", async () => {
    const p = await unPedido();
    await env.DB.prepare("UPDATE pedidos SET estado = 'cancelado' WHERE id = ?").bind(p.id).run();
    const r = await comprobante(p.id, 500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
  });
});

describe("dos personas confirmando a la vez", () => {
  it("el segundo batch se cae entero: el comprobante no se suma dos veces", async () => {
    // Esto es la carrera, simulada. La lectura previa de `confirmarPago` caza
    // al que llega DESPUÉS; esto caza al que llega A LA VEZ: dos personas
    // mirando el mismo comprobante en el panel y las dos pulsando confirmar.
    //
    // Sin `WHERE … AND estado = 'confirmando'`, el segundo UPDATE pisaría el
    // primero, los dos batches sumarían, y el pedido quedaría con el doble
    // cobrado por una sola transferencia.
    const p = await unPedido();
    const c = await comprobante(p.id, 500);
    if (!c.ok) return;

    expect((await confirmarPago(ctx(), c.datos.pagoId)).ok).toBe(true);
    expect((await estadoDe(p.id))?.pagado_cents).toBe(500);

    // El segundo, con el pago YA aprobado.
    await expect(
      env.DB.batch(enunciadosDeConfirmacion(ctx(), c.datos.pagoId)),
    ).rejects.toThrow();

    expect((await estadoDe(p.id))?.pagado_cents).toBe(500);
  });
});

describe("dos pagos DISTINTOS confirmados a la vez", () => {
  it("no se pierde ninguno: el segundo batch se cae y se reintenta", async () => {
    // Este es el fallo caro, y no es el que parece. Confirmar dos veces el
    // MISMO pago es inofensivo: el cobro escribe un valor absoluto, así que
    // el segundo escribe lo mismo. Lo que hace desaparecer dinero es
    // confirmar DOS PAGOS DISTINTOS a la vez — los dos leen `pagado_cents=0`,
    // uno calcula $5 y el otro $3, el último que escribe gana, y uno de los
    // dos cobros desaparece del pedido aunque el dinero esté en la cuenta.
    //
    // Lo cierra la `version` del pedido en el WHERE del cobro.
    const p = await unPedido({ abonoMinimoCents: 100000 }); // que no se agende
    const a = await comprobante(p.id, 500);
    const b = await comprobante(p.id, 300);
    if (!a.ok || !b.ok) return;

    // El primero entra y sube la versión del pedido.
    expect((await confirmarPago(ctx(), a.datos.pagoId)).ok).toBe(true);
    expect((await estadoDe(p.id))?.pagado_cents).toBe(500);

    // El segundo, confirmado después, VUELVE A LEER y suma sobre lo que hay.
    expect((await confirmarPago(ctx(), b.datos.pagoId)).ok).toBe(true);
    expect((await estadoDe(p.id))?.pagado_cents, "los dos cobros tienen que estar").toBe(800);
  });

  it("y con la versión vieja en la mano, el batch se niega", async () => {
    // La carrera de verdad: se arma el cobro con la versión LEÍDA ANTES de
    // que otro escribiera. Sin la versión en el WHERE, esto pisaría el cobro
    // anterior y lo haría desaparecer.
    const p = await unPedido({ abonoMinimoCents: 100000 });
    const v = await env.DB.prepare("SELECT version FROM pedidos WHERE id = ?")
      .bind(p.id)
      .first<{ version: number }>();

    const a = await comprobante(p.id, 500);
    if (!a.ok) return;
    await confirmarPago(ctx(), a.datos.pagoId); // sube la versión

    await expect(
      env.DB.batch(
        enunciadosDeCobro(ctx(), p.id, p.totalCents, 300, v?.version ?? 0),
      ),
    ).rejects.toThrow();

    expect((await estadoDe(p.id))?.pagado_cents, "el cobro anterior sigue ahí").toBe(500);
  });
});
