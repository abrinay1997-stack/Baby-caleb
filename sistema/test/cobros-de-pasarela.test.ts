import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { confirmarPago } from "../src/db/pagos";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";

/**
 * Un cobro de pasarela tiene que llegar a los libros.
 *
 * ## Lo que estaba pasando
 *
 * `confirmarPago` elegía la cuenta contable con `CUENTA_DEL_METODO`, que solo
 * conoce los tres métodos manuales (Yappy, transferencia, efectivo). Para un
 * pago de Tilopay o de PayPal esa cuenta valía `null`, y el `if (asiento !==
 * null)` se saltaba entero: **el pago se aprobaba, el pedido sumaba, y en la
 * contabilidad no entraba un centavo.**
 *
 * No se habría visto en ninguna prueba porque no había ninguna: el camino
 * estaba muerto —nadie cobraba por pasarela todavía— y un camino muerto pasa
 * en verde sin comprobar nada. El día que la web empiece a cobrar, cada venta
 * en línea habría descuadrado los libros en silencio, y el descuadre no se ve
 * en el balance: los asientos que SÍ se escriben cuadran entre ellos. Lo que
 * falta no desequilibra nada, simplemente no está.
 *
 * ## Lo que se vigila aquí
 *
 * Que el asiento 2 del plan (05-contabilidad §3) se escriba de verdad: debe
 * 1105 «Por liquidar Tilopay» por el BRUTO, haber 2101 «Anticipos de
 * clientas». El bruto y no el neto, porque la pasarela todavía tiene el
 * dinero; la comisión real aparece al liquidar (asiento 7), con la cifra del
 * depósito y no con una estimada.
 */

let clienteId: string;
let n = 0;
const ahora = () => Date.now();

const ctxP = (): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: "pruebas",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
});

beforeEach(async () => {
  clienteId = `cli-pas-${Date.now()}-${n++}`;
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

async function unPedido() {
  const r = await crearPedido(ctxP(), {
    idempotencia: `idem-pas-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  });
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

/**
 * Un pago de pasarela ya esperando confirmación.
 *
 * Se inserta a mano porque la capa que lo crea desde el cobro en línea es la
 * siguiente pieza; lo que esta prueba mide es lo que pasa AL CONFIRMARLO, que
 * es donde estaba el agujero.
 */
async function unPagoDePasarela(
  pedidoId: string,
  montoCents: number,
  proveedor: "tilopay" | "paypal" | "manual" = "tilopay",
): Promise<string> {
  const id = `pago-${proveedor}-${Date.now()}-${n++}`;
  await env.DB.prepare(
    `INSERT INTO pagos (id, pedido_id, proveedor, metodo, tipo, estado, monto_cents,
                        intento_ref, creado_en, actualizado_en)
     VALUES (?, ?, ?, 'tarjeta', 'abono', 'confirmando', ?, ?, ?, ?)`,
  )
    .bind(id, pedidoId, proveedor, montoCents, `ref-${id}`, ahora(), ahora())
    .run();
  return id;
}

/** Las líneas del asiento de un pago, con el CÓDIGO de cuenta ya resuelto. */
const asientoDelPago = (pagoId: string) =>
  env.DB.prepare(
    `SELECT a.hecho, a.origen, a.descripcion, c.codigo, l.debe_cents, l.haber_cents
       FROM asientos a
       JOIN asiento_lineas l ON l.asiento_id = a.id
       JOIN cuentas c        ON c.id = l.cuenta_id
      WHERE a.referencia_tipo = 'pago' AND a.referencia_id = ?
      ORDER BY l.debe_cents DESC`,
  )
    .bind(pagoId)
    .all<{
      hecho: string;
      origen: string;
      descripcion: string;
      codigo: string;
      debe_cents: number;
      haber_cents: number;
    }>();

describe("un cobro de Tilopay entra en los libros", () => {
  it("escribe el asiento 2: debe 1105 por el bruto, haber 2101", async () => {
    const p = await unPedido();
    const pagoId = await unPagoDePasarela(p.id, 1250);

    const r = await confirmarPago({ db: env.DB, ahora: ahora(), actor: "yarielis" }, pagoId);
    expect(r.ok).toBe(true);

    const { results } = await asientoDelPago(pagoId);

    /*
      ESTA es la aserción que estaba fallando antes del arreglo, y falla con
      «0 líneas»: no había asiento ninguno. No es un detalle de formato — es
      la diferencia entre que la venta exista en la contabilidad o no.
    */
    expect(results.length, "el cobro de pasarela no escribió ningún asiento").toBe(2);

    expect(results[0]?.hecho).toBe("2");
    expect(results[0]?.origen).toBe("pago");

    const debe = results.find((l) => l.debe_cents > 0);
    const haber = results.find((l) => l.haber_cents > 0);

    expect(debe?.codigo, "el bruto debe entrar en «Por liquidar Tilopay»").toBe("1105");
    expect(debe?.debe_cents).toBe(1250);
    expect(haber?.codigo, "contra los anticipos de la clienta").toBe("2101");
    expect(haber?.haber_cents).toBe(1250);
  });

  it("PayPal va a su propia cuenta, 1106, y no a la de Tilopay", async () => {
    const p = await unPedido();
    const pagoId = await unPagoDePasarela(p.id, 800, "paypal");

    const r = await confirmarPago({ db: env.DB, ahora: ahora(), actor: "yarielis" }, pagoId);
    expect(r.ok).toBe(true);

    const { results } = await asientoDelPago(pagoId);
    expect(results.find((l) => l.debe_cents > 0)?.codigo).toBe("1106");
  });

  /**
   * El bruto, no el neto. La comisión NO se descuenta aquí.
   *
   * Si alguien «mejorara» esto restando la comisión estimada, el asiento
   * seguiría cuadrando —debe y haber bajarían juntos— y el anticipo de la
   * clienta quedaría por debajo de lo que ella pagó. O sea: un descuadre que
   * el balance no delata y que la clienta sí, cuando reclame su saldo.
   */
  it("entra el bruto aunque el pago traiga comisión anotada", async () => {
    const p = await unPedido();
    const pagoId = await unPagoDePasarela(p.id, 1250);
    await env.DB.prepare("UPDATE pagos SET comision_cents = 48 WHERE id = ?").bind(pagoId).run();

    const r = await confirmarPago({ db: env.DB, ahora: ahora(), actor: "yarielis" }, pagoId);
    expect(r.ok).toBe(true);

    const { results } = await asientoDelPago(pagoId);
    expect(results.find((l) => l.debe_cents > 0)?.debe_cents).toBe(1250);
    expect(results.find((l) => l.haber_cents > 0)?.haber_cents).toBe(1250);
  });

  it("el pedido suma igual que con un cobro manual", async () => {
    const p = await unPedido();
    const pagoId = await unPagoDePasarela(p.id, 1250);

    const r = await confirmarPago({ db: env.DB, ahora: ahora(), actor: "yarielis" }, pagoId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.pagadoCents).toBe(1250);

    const fila = await env.DB.prepare("SELECT pagado_cents, estado_pago FROM pedidos WHERE id = ?")
      .bind(p.id)
      .first<{ pagado_cents: number; estado_pago: string }>();
    expect(fila?.pagado_cents).toBe(1250);
  });

  /**
   * Y el caso que NO cambia: `proveedor = 'manual'` sigue decidiendo por el
   * método, como siempre. Si el arreglo hubiera reemplazado el camino manual
   * en vez de añadir el de pasarela, esto se pondría rojo.
   */
  it("un pago manual sigue por su camino de siempre", async () => {
    const p = await unPedido();
    const id = `pago-man-${Date.now()}-${n++}`;
    await env.DB.prepare(
      `INSERT INTO pagos (id, pedido_id, proveedor, metodo, tipo, estado, monto_cents,
                          intento_ref, creado_en, actualizado_en)
       VALUES (?, ?, 'manual', 'yappy', 'abono', 'confirmando', 1250, ?, ?, ?)`,
    )
      .bind(id, p.id, `ref-${id}`, ahora(), ahora())
      .run();

    const r = await confirmarPago({ db: env.DB, ahora: ahora(), actor: "yarielis" }, id);
    expect(r.ok).toBe(true);

    const { results } = await asientoDelPago(id);
    expect(results.length).toBe(2);
    // 1101 es Yappy Comercial, no 1105: a Yappy la clienta le paga directo y
    // el dinero ya está en el banco, así que no hay nada «por liquidar».
    expect(results.find((l) => l.debe_cents > 0)?.codigo).toBe("1101");
    expect(results[0]?.hecho).toBe("1");
  });
});
