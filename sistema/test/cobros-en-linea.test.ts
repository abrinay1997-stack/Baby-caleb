import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { iniciarCobro, resolverCobro, type LoQueDiceLaPasarela } from "../src/db/cobros-en-linea";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";
import { ok, type Resultado } from "../src/contrato/resultado";
import type { CobroCreado, OrdenDeCobro, PaymentProvider } from "../src/pagos/proveedor";

/**
 * El cobro en línea, con la D1 de verdad.
 *
 * Lo que se vigila aquí es el dinero, y cada prueba lleva en el nombre lo que
 * pasaría si fallara. Tres controles:
 *
 *  1. No se cobra más de lo que se debe.
 *  2. Una vuelta repetida no suma el pago dos veces.
 *  3. **No se aprueba si el monto de la pasarela no es exactamente el nuestro.**
 *
 * El tercero es el que convierte «la pasarela dijo que sí» en «la pasarela
 * cobró lo que había que cobrar», que no es lo mismo.
 */

let clienteId: string;
let n = 0;
const ahora = () => Date.now();
const ctx = () => ({ db: env.DB, ahora: ahora(), actor: "yarielis" });

const ctxP = (): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: "pruebas",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
});

beforeEach(async () => {
  clienteId = `cli-lin-${Date.now()}-${n++}`;
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

async function unPedido(cantidad = 1) {
  const r = await crearPedido(ctxP(), {
    idempotencia: `idem-lin-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas: [{ codigo: "NAT-M", cantidad }],
  });
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

const totalDe = async (pedidoId: string) =>
  (
    await env.DB.prepare("SELECT total_cents, pagado_cents FROM pedidos WHERE id = ?")
      .bind(pedidoId)
      .first<{ total_cents: number; pagado_cents: number }>()
  )!;

/** Una pasarela de mentira que contesta lo que se le diga. */
function pasarelaQue(
  respuesta: Resultado<CobroCreado> | "revienta",
): PaymentProvider<null, never, "aprobado"> & { ordenes: OrdenDeCobro[] } {
  const ordenes: OrdenDeCobro[] = [];
  return {
    ordenes,
    async createPayment(_c, orden) {
      ordenes.push(orden);
      if (respuesta === "revienta") throw new Error("la red se cayó");
      return respuesta;
    },
    async verifyWebhook() {
      throw new Error("no se usa");
    },
    async consultar() {
      throw new Error("no se usa");
    },
    async refundPayment() {
      throw new Error("no se usa");
    },
  };
}

const CREADA: Resultado<CobroCreado> = ok({
  tipo: "creado",
  referencia: "T-9",
  redirectUrl: "https://app.tilopay.com/pagar/xyz",
});

const aprobadoPor = (montoCents: number | null): LoQueDiceLaPasarela => ({
  estado: "aprobado",
  montoCents,
  referencia: "T-9",
  comisionCents: 48,
});

const estadoDelPago = (pagoId: string) =>
  env.DB.prepare(
    "SELECT estado, monto_cents, comision_cents, proveedor_ref FROM pagos WHERE id = ?",
  )
    .bind(pagoId)
    .first<{
      estado: string;
      monto_cents: number;
      comision_cents: number | null;
      proveedor_ref: string | null;
    }>();

// ---------------------------------------------------------------------------
describe("arrancar un cobro", () => {
  it("crea el pago y devuelve la página de pago", async () => {
    const p = await unPedido();
    const { total_cents } = await totalDe(p.id);

    const r = await iniciarCobro(
      ctx(),
      {
        pedidoId: p.id,
        proveedor: "tilopay",
        metodo: "tarjeta",
        tipo: "total",
        montoCents: total_cents,
        urlAviso: "https://babycaleb.com/pago/vuelta",
      },
      pasarelaQue(CREADA),
      null,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.redirectUrl).toBe("https://app.tilopay.com/pagar/xyz");

    const pago = await estadoDelPago(r.datos.pagoId);
    expect(pago?.estado).toBe("esperando_cliente");
    expect(pago?.monto_cents).toBe(total_cents);
    expect(pago?.proveedor_ref).toBe("T-9");
  });

  /**
   * El `intento_ref` lleva el número del pedido delante: es lo que la dueña ve
   * en el panel de Tilopay, y sin eso tendría que venir aquí a buscar de qué
   * pedido es cada cobro.
   */
  it("la referencia hacia la pasarela empieza por el número del pedido", async () => {
    const p = await unPedido();
    const { total_cents } = await totalDe(p.id);
    const pas = pasarelaQue(CREADA);

    const r = await iniciarCobro(
      ctx(),
      { pedidoId: p.id, proveedor: "tilopay", metodo: "tarjeta", tipo: "total", montoCents: total_cents, urlAviso: "u" },
      pas,
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.intentoRef.startsWith(`${p.numero}-`)).toBe(true);
    // Y es lo que viaja a la pasarela, no el id interno del pago.
    expect(pas.ordenes[0]?.ordenId).toBe(r.datos.intentoRef);
  });

  /**
   * NO SE COBRA MÁS DE LO QUE SE DEBE.
   *
   * Sin esto, una ventana reenviada o un formulario manipulado cobra dos veces
   * el total, y devolver dinero cuesta mucho más trabajo que no cobrarlo.
   */
  it("cobrar más que el saldo se niega, y dice las dos cifras", async () => {
    const p = await unPedido();
    const { total_cents } = await totalDe(p.id);

    const r = await iniciarCobro(
      ctx(),
      { pedidoId: p.id, proveedor: "tilopay", metodo: "tarjeta", tipo: "total", montoCents: total_cents + 1, urlAviso: "u" },
      pasarelaQue(CREADA),
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("monto_no_coincide");
      expect(r.mensaje).toMatch(/debe/i);
    }
  });

  it("un monto de cero o negativo no llega ni a la pasarela", async () => {
    const p = await unPedido();
    for (const monto of [0, -100, 1.5]) {
      const pas = pasarelaQue(CREADA);
      const r = await iniciarCobro(
        ctx(),
        { pedidoId: p.id, proveedor: "tilopay", metodo: "tarjeta", tipo: "abono", montoCents: monto, urlAviso: "u" },
        pas,
        null,
      );
      expect(r.ok, String(monto)).toBe(false);
      expect(pas.ordenes.length, String(monto)).toBe(0);
    }
  });

  /**
   * LISTA BLANCA, Y ESTA PRUEBA ENCONTRÓ POR QUÉ.
   *
   * La primera versión del código comprobaba `estado === "anulado"`, y ese
   * estado NO EXISTE: se llama `cancelado`. La comprobación no protegía de
   * nada. Lo delató esta prueba al chocar con el CHECK del esquema, que sí
   * sabía los nombres de verdad.
   *
   * Se recorren TODOS los estados no cobrables en vez de uno: con un solo
   * caso, el siguiente nombre mal escrito vuelve a pasar desapercibido.
   */
  it("a un pedido cancelado, devuelto o en cotización no se le cobra", async () => {
    for (const estado of ['cancelado', 'devuelto', 'cotizacion']) {
      const p = await unPedido();
      const { total_cents } = await totalDe(p.id);
      await env.DB.prepare('UPDATE pedidos SET estado = ? WHERE id = ?').bind(estado, p.id).run();

      const pas = pasarelaQue(CREADA);
      const r = await iniciarCobro(
        ctx(),
        { pedidoId: p.id, proveedor: 'tilopay', metodo: 'tarjeta', tipo: 'total', montoCents: total_cents, urlAviso: 'u' },
        pas,
        null,
      );
      expect(r.ok, estado).toBe(false);
      // Y no se llamó a la pasarela: no hay cobro vivo que cancelar después.
      expect(pas.ordenes.length, estado).toBe(0);
    }
  });

  /**
   * LA FILA SE ESCRIBE ANTES DE LLAMAR A LA PASARELA, y esto lo comprueba.
   *
   * Al revés —llamar primero, escribir después— una llamada que sale bien y
   * una escritura que falla dejan un cobro vivo en la pasarela que no existe
   * aquí: la clienta paga y no hay a qué pedido aplicarlo. Si la pasarela
   * falla, lo que queda es una fila en `rechazado`, que es la anotación de lo
   * que se intentó.
   */
  it("si la pasarela revienta, queda anotado el intento y no un hueco", async () => {
    const p = await unPedido();
    const { total_cents } = await totalDe(p.id);

    const r = await iniciarCobro(
      ctx(),
      { pedidoId: p.id, proveedor: "tilopay", metodo: "tarjeta", tipo: "total", montoCents: total_cents, urlAviso: "u" },
      pasarelaQue("revienta"),
      null,
    );
    expect(r.ok).toBe(false);

    const fila = await env.DB.prepare(
      "SELECT estado FROM pagos WHERE pedido_id = ? ORDER BY creado_en DESC LIMIT 1",
    )
      .bind(p.id)
      .first<{ estado: string }>();
    expect(fila?.estado).toBe("rechazado");

    // Y el pedido NO suma nada.
    expect((await totalDe(p.id)).pagado_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("resolver un cobro: el monto manda", () => {
  async function arrancado(montoCents?: number) {
    const p = await unPedido();
    const { total_cents } = await totalDe(p.id);
    const monto = montoCents ?? total_cents;
    const r = await iniciarCobro(
      ctx(),
      { pedidoId: p.id, proveedor: "tilopay", metodo: "tarjeta", tipo: "total", montoCents: monto, urlAviso: "u" },
      pasarelaQue(CREADA),
      null,
    );
    if (!r.ok) throw new Error(r.mensaje);
    return { pedido: p, monto, ...r.datos };
  }

  it("aprobado por el monto exacto: se aplica, con su comisión", async () => {
    const a = await arrancado();

    const r = await resolverCobro(ctx(), a.intentoRef, aprobadoPor(a.monto));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.resultado).toBe("aprobado");

    const pago = await estadoDelPago(a.pagoId);
    expect(pago?.estado).toBe("aprobado");
    expect(pago?.comision_cents).toBe(48);
    expect((await totalDe(a.pedido.id)).pagado_cents).toBe(a.monto);
  });

  /**
   * UN PEDIDO DE $50 NO SE APRUEBA CON UN COBRO DE $1.
   *
   * Es la forma más barata de robarle a la tienda y no requiere tocar nada
   * nuestro: basta con que la orden exista en la pasarela por otro importe.
   * Sin esta comprobación, «aprobado» alcanzaría.
   */
  it("aprobado por OTRO monto no se aplica, y el pedido no suma", async () => {
    const a = await arrancado();

    const r = await resolverCobro(ctx(), a.intentoRef, aprobadoPor(100));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("monto_no_coincide");
      // El mensaje tiene que traer LAS DOS cifras o no sirve para investigar.
      expect(r.mensaje).toMatch(/1\.00/);
    }

    const pago = await estadoDelPago(a.pagoId);
    expect(pago?.estado, "no se aprueba").not.toBe("aprobado");
    expect(pago?.estado, "y tampoco se cierra: lo mira una persona").not.toBe("rechazado");
    expect((await totalDe(a.pedido.id)).pagado_cents).toBe(0);
  });

  /**
   * Y aprobar SIN SABER el importe es aprobar a ciegas: si la respuesta fuera
   * de otra orden, nadie lo notaría.
   */
  it("aprobado sin decir cuánto tampoco se aplica", async () => {
    const a = await arrancado();

    const r = await resolverCobro(ctx(), a.intentoRef, aprobadoPor(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("monto_no_coincide");
    expect((await totalDe(a.pedido.id)).pagado_cents).toBe(0);
  });

  it("un centavo de diferencia es diferencia", async () => {
    const a = await arrancado();
    const r = await resolverCobro(ctx(), a.intentoRef, aprobadoPor(a.monto - 1));
    expect(r.ok).toBe(false);
    expect((await totalDe(a.pedido.id)).pagado_cents).toBe(0);
  });

  it("rechazado por la pasarela: se cierra y el pedido no suma", async () => {
    const a = await arrancado();

    const r = await resolverCobro(ctx(), a.intentoRef, {
      estado: "rechazado",
      montoCents: null,
      referencia: null,
      comisionCents: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.resultado).toBe("rechazado");

    expect((await estadoDelPago(a.pagoId))?.estado).toBe("rechazado");
    expect((await totalDe(a.pedido.id)).pagado_cents).toBe(0);
  });

  /**
   * «Pendiente» NO cierra el pago.
   *
   * Si lo cerrara como rechazado, un pago que todavía puede entrar quedaría
   * muerto y la clienta pagaría sin pedido.
   */
  it("pendiente deja el cobro abierto, ni aprobado ni rechazado", async () => {
    const a = await arrancado();

    const r = await resolverCobro(ctx(), a.intentoRef, {
      estado: "pendiente",
      montoCents: null,
      referencia: null,
      comisionCents: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.resultado).toBe("pendiente");
    expect((await estadoDelPago(a.pagoId))?.estado).toBe("esperando_cliente");
  });

  /**
   * LA CLIENTA RECARGA LA PÁGINA DE VUELTA.
   *
   * Sin idempotencia, la segunda vuelta suma el pago otra vez y la clienta
   * aparece habiendo pagado el doble — y el pedido se agenda con un abono que
   * nadie hizo.
   */
  it("resolver dos veces no suma dos veces", async () => {
    const a = await arrancado();

    const uno = await resolverCobro(ctx(), a.intentoRef, aprobadoPor(a.monto));
    expect(uno.ok).toBe(true);
    const dos = await resolverCobro(ctx(), a.intentoRef, aprobadoPor(a.monto));
    expect(dos.ok).toBe(true);
    if (dos.ok) expect(dos.datos.resultado).toBe("ya_estaba");

    expect((await totalDe(a.pedido.id)).pagado_cents).toBe(a.monto);
  });

  it("una referencia que no existe no revienta: lo dice", async () => {
    const r = await resolverCobro(ctx(), "BC-999-noexiste", aprobadoPor(1250));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  /** La bitácora de la pasarela queda escrita, para poder investigar después. */
  it("deja constancia de lo que contestó la pasarela", async () => {
    const a = await arrancado();
    await resolverCobro(ctx(), a.intentoRef, aprobadoPor(a.monto));

    const ev = await env.DB.prepare(
      "SELECT proveedor, evento_id, firma_valida, resultado FROM eventos_pasarela WHERE evento_id LIKE ?",
    )
      .bind(`consulta:${a.intentoRef}%`)
      .first<{ proveedor: string; evento_id: string; firma_valida: number; resultado: string }>();

    expect(ev?.proveedor).toBe("tilopay");
    expect(ev?.resultado).toBe("aprobado");
    // 1 porque esto viene de una consulta servidor a servidor con nuestras
    // credenciales: esa consulta ES la verificación.
    expect(ev?.firma_valida).toBe(1);
  });

  /** Y el asiento contable, que es lo que arreglamos antes. */
  it("un cobro aprobado llega a los libros, en 1105", async () => {
    const a = await arrancado();
    await resolverCobro(ctx(), a.intentoRef, aprobadoPor(a.monto));

    const linea = await env.DB.prepare(
      `SELECT c.codigo, l.debe_cents
         FROM asientos a
         JOIN asiento_lineas l ON l.asiento_id = a.id
         JOIN cuentas c        ON c.id = l.cuenta_id
        WHERE a.referencia_tipo = 'pago' AND a.referencia_id = ? AND l.debe_cents > 0`,
    )
      .bind(a.pagoId)
      .first<{ codigo: string; debe_cents: number }>();

    expect(linea?.codigo).toBe("1105");
    expect(linea?.debe_cents).toBe(a.monto);
  });
});
