import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";
import { enunciadosDeCobro } from "../src/db/transiciones";
import {
  confirmarPago,
  enunciadosDeConfirmacion,
  enunciadosDeDineroQueSale,
  registrarComprobante,
  registrarContracargo,
  registrarReembolso,
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

/**
 * El asiento que deja un pago confirmado (F5.1 enganchada).
 *
 * Las 18 pruebas de arriba pasaban en verde con la contabilidad en cero: los
 * veinte constructores existían y nadie los llamaba. Así que estas miran la
 * TABLA `asientos`, no lo que devuelve la función.
 *
 * La referencia apunta al PAGO y no al pedido a propósito: un pedido tiene
 * varios pagos (el abono, el saldo) y cada uno lleva su asiento, así que una
 * referencia al pedido no permite preguntar «¿este cobro está en los libros?»
 * — que es la casilla del cierre que lo vigila.
 */
describe("el asiento de un pago", () => {
  const asientoDelPago = (pagoId: string) =>
    env.DB.prepare(
      `SELECT a.id, a.hecho, a.origen, a.fecha, a.descripcion, cc.diferencia
         FROM asientos a LEFT JOIN control_cuadre cc ON cc.asiento_id = a.id
        WHERE a.referencia_tipo = 'pago' AND a.referencia_id = ?`,
    )
      .bind(pagoId)
      .first<{
        id: string;
        hecho: string;
        origen: string;
        fecha: string;
        descripcion: string;
        diferencia: number | null;
      }>();

  const lineasDe = async (asientoId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT c.codigo, l.debe_cents AS debe, l.haber_cents AS haber
         FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
        WHERE l.asiento_id = ? ORDER BY c.codigo`,
    )
      .bind(asientoId)
      .all<{ codigo: string; debe: number; haber: number }>();
    return results;
  };

  it("un abono por Yappy entra como ANTICIPO, no como venta", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, 3000);
    if (!c.ok) throw new Error(c.mensaje);

    // Mientras está en «confirmando» no hay asiento: una captura es una
    // afirmación, y los libros no anotan afirmaciones.
    expect(await asientoDelPago(c.datos.pagoId)).toBeNull();

    expect((await confirmarPago(ctx(), c.datos.pagoId)).ok).toBe(true);

    const a = await asientoDelPago(c.datos.pagoId);
    expect(a, "falta el asiento del pago").not.toBeNull();
    expect(a?.hecho).toBe("1");
    expect(a?.origen).toBe("pago");
    expect(a?.diferencia, "el asiento no cuadró").toBe(0);
    expect(a?.descripcion).toContain(p.numero);

    // Lo abonado es un PASIVO hasta que el pedido salga. Reconocerlo como
    // venta aquí sería dar por ganado algo que todavía hay que entregar — y
    // además inflaría las ventas del mes con pedidos que no han salido.
    expect(await lineasDe(a!.id)).toEqual([
      { codigo: "1101", debe: 3000, haber: 0 },
      { codigo: "2101", debe: 0, haber: 3000 },
    ]);
  });

  it("cada método entra por su cuenta: Yappy 1101, transferencia 1102, efectivo 1103", async () => {
    for (const [metodo, cuenta] of [
      ["yappy", "1101"],
      ["transferencia", "1102"],
      ["efectivo", "1103"],
    ] as const) {
      const p = await unPedido();
      const c = await comprobante(p.id, 1500, { metodo });
      if (!c.ok) throw new Error(c.mensaje);
      expect((await confirmarPago(ctx(), c.datos.pagoId)).ok, metodo).toBe(true);

      const a = await asientoDelPago(c.datos.pagoId);
      expect(a, `falta el asiento de ${metodo}`).not.toBeNull();
      expect(await lineasDe(a!.id), metodo).toEqual([
        { codigo: cuenta, debe: 1500, haber: 0 },
        { codigo: "2101", debe: 0, haber: 1500 },
      ]);
    }
  });

  it("un método que este código no conoce cobra igual y NO inventa un asiento", async () => {
    // `pagos.metodo` es una columna de texto SIN CHECK, así que una fila con
    // un método que este código no conoce puede existir: una importación, una
    // fila escrita a mano, o —como pasó— un método que se deja de aceptar.
    // Aquí estuvo `nequi` hasta que Juan confirmó que ya no es un método de
    // pago en Panamá; se quitó de la lista y no quedaba ni un pago con él.
    //
    // Lo que se vigila es que leer esa fila no reviente y no se invente una
    // cuenta: el dinero entró de verdad, así que el pago se confirma y el
    // pedido avanza, pero sin asiento. La casilla «todo el dinero que entró
    // tiene su asiento» del cierre lo canta hasta que alguien lo anote.
    //
    // Se inserta directo porque `registrarComprobante` rechaza un método que
    // no es manual, que es correcto: por la puerta de entrada esto no pasa.
    const p = await unPedido();
    const pagoId = `pago-raro-${Date.now()}-${n++}`;
    await env.DB.prepare(
      `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,
         intento_ref,creado_en,actualizado_en)
       VALUES (?,?,'manual','cheque','abono','confirmando',2000,?,?,?)`,
    )
      .bind(pagoId, p.id, `raro-${pagoId}`, ahora(), ahora())
      .run();

    expect((await confirmarPago(ctx(), pagoId)).ok).toBe(true);

    expect((await estadoDe(p.id))?.pagado_cents).toBe(2000);
    expect(await asientoDelPago(pagoId)).toBeNull();
  });

  it("un comprobante rechazado no deja asiento: no entró dinero", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, 2500);
    if (!c.ok) throw new Error(c.mensaje);

    expect((await rechazarPago(ctx(), c.datos.pagoId, "la captura es de otro pedido")).ok).toBe(
      true,
    );
    expect(await asientoDelPago(c.datos.pagoId)).toBeNull();
  });

  it("después de entregar, un pago por Yappy DESCARGA lo por cobrar, no abre un anticipo", async () => {
    const p = await unPedido();
    // El pedido ya salió. Se pone a mano porque lo que se prueba es la rama de
    // `confirmarPago`, no el camino de la entrega (eso vive en
    // `src/db/entregas.test.ts`, con sus propios asientos 3 y 4).
    await env.DB.prepare("UPDATE pedidos SET estado = 'entregado' WHERE id = ?").bind(p.id).run();

    const c = await comprobante(p.id, 3000, { tipo: "saldo" });
    if (!c.ok) throw new Error(c.mensaje);
    expect((await confirmarPago(ctx(), c.datos.pagoId)).ok).toBe(true);

    const a = await asientoDelPago(c.datos.pagoId);
    expect(a, "falta el asiento del saldo").not.toBeNull();
    // 4b y no 1: la venta ya se reconoció al entregar y 1201 lleva el saldo.
    // Un anticipo aquí dejaría a la clienta debiendo Y con saldo a favor a la
    // vez, y las dos cifras cuadrarían por separado.
    expect(a?.hecho).toBe("4b");
    expect(await lineasDe(a!.id)).toEqual([
      { codigo: "1101", debe: 3000, haber: 0 },
      { codigo: "1201", debe: 0, haber: 3000 },
    ]);
  });

  it("después de entregar, un efectivo o una transferencia se quedan sin asiento, y se dice", async () => {
    // Los dieciocho asientos del documento solo contemplan Yappy para cobrar
    // un saldo después de la entrega (es como pagan las clientas que se
    // quedaron debiendo). Un efectivo o una transferencia que llegan después
    // no tienen asiento, y el diecinueve no me lo invento yo: lo decide la
    // dueña con su contadora. El dinero se cobra igual y la casilla del cierre
    // lo canta.
    for (const metodo of ["efectivo", "transferencia"] as const) {
      const p = await unPedido();
      await env.DB.prepare("UPDATE pedidos SET estado = 'entregado' WHERE id = ?").bind(p.id).run();
      const c = await comprobante(p.id, 1000, { metodo, tipo: "saldo" });
      if (!c.ok) throw new Error(c.mensaje);
      expect((await confirmarPago(ctx(), c.datos.pagoId)).ok, metodo).toBe(true);
      expect((await estadoDe(p.id))?.pagado_cents, metodo).toBe(1000);
      expect(await asientoDelPago(c.datos.pagoId), metodo).toBeNull();
    }
  });
});

describe("cuando la tabla rechaza el dato", () => {
  /**
   * El `catch` de `registrarComprobante` decía «repetido» a todo.
   *
   * En SQLite las dos restricciones hablan igual: «UNIQUE constraint failed» y
   * «CHECK constraint failed». El `catch` miraba `/UNIQUE|constraint/i`, así
   * que un `tipo` que no existe respondía «ese comprobante ya estaba
   * registrado» — y quien lo recibe se pone a buscar un comprobante repetido
   * que no existe en vez de mirar lo que mandó.
   *
   * Hay una guarda en la ruta `/cobros` que da un mensaje mejor antes de
   * llegar aquí, y por eso esta prueba llama al MÓDULO directo: con la ruta
   * en medio, la mutación que devuelve el `catch` a su estado anterior no
   * pone roja ninguna prueba. Lo comprobé, y es la razón de que esta exista.
   *
   * El `as` no es pereza: el tipo ya prohíbe este valor en tiempo de
   * compilación y lo que se prueba es qué pasa cuando llega de todas formas,
   * que es lo que hace un cliente que no es este código.
   */
  it("un tipo que no existe es «entrada_invalida», no «repetido»", async () => {
    const p = await unPedido();
    const r = await registrarComprobante(ctx(), {
      idempotencia: `malo-${Date.now()}-${n++}`,
      pedidoId: p.id,
      montoCents: 1000,
      metodo: "yappy",
      tipo: "inventado" as "abono",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(r.mensaje).not.toContain("ya estaba registrado");
  });

  it("y la clave repetida sigue siendo «repetido»: el caso bueno no se perdió", async () => {
    const p = await unPedido();
    const clave = `misma-${Date.now()}-${n++}`;
    const uno = await registrarComprobante(ctx(), {
      idempotencia: clave,
      pedidoId: p.id,
      montoCents: 1000,
      metodo: "yappy",
      tipo: "abono",
    });
    expect(uno.ok).toBe(true);

    const dos = await registrarComprobante(ctx(), {
      idempotencia: clave,
      pedidoId: p.id,
      montoCents: 1000,
      metodo: "yappy",
      tipo: "abono",
    });
    expect(dos.ok).toBe(false);
    if (dos.ok) return;
    expect(dos.codigo).toBe("repetido");
  });
});

/**
 * El dinero que vuelve: reembolsos y contracargos (04-pagos §7, asientos 14 y 15).
 *
 * Los dos constructores estaban escritos, cuadraban y tenían sus pruebas en el
 * dominio… y nadie los llamaba: no había función, ni ruta, ni forma de
 * devolverle un peso a una clienta sin escribirlo a mano en la consola de D1.
 * Es la trampa nº 12 otra vez, y por eso estas pruebas miran las TABLAS
 * —`asientos`, `reembolsos`, `pagos`, `pedidos`— y no lo que devuelve la
 * función.
 *
 * Cada una se validó rompiendo lo que vigila: quitando el asiento del batch,
 * cambiando la cuenta contra la que se carga, y neutralizando los dos
 * controles.
 */
describe("el dinero que vuelve", () => {
  const asientosDelPago = async (pagoId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.hecho, a.origen, a.descripcion, cc.diferencia
         FROM asientos a LEFT JOIN control_cuadre cc ON cc.asiento_id = a.id
        WHERE a.referencia_tipo = 'pago' AND a.referencia_id = ?
        ORDER BY a.hecho`,
    )
      .bind(pagoId)
      .all<{
        id: string;
        hecho: string;
        origen: string;
        descripcion: string;
        diferencia: number | null;
      }>();
    return results;
  };

  const lineasDelAsiento = async (asientoId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT c.codigo, l.debe_cents AS debe, l.haber_cents AS haber
         FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
        WHERE l.asiento_id = ? ORDER BY c.codigo`,
    )
      .bind(asientoId)
      .all<{ codigo: string; debe: number; haber: number }>();
    return results;
  };

  const pagoDe = (pagoId: string) =>
    env.DB.prepare("SELECT estado, actualizado_en FROM pagos WHERE id = ?")
      .bind(pagoId)
      .first<{ estado: string; actualizado_en: number }>();

  const reembolsosDe = async (pagoId: string) => {
    const { results } = await env.DB.prepare(
      "SELECT monto_cents, motivo, via, estado, actor FROM reembolsos WHERE pago_id = ? ORDER BY id",
    )
      .bind(pagoId)
      .all<{ monto_cents: number; motivo: string; via: string; estado: string; actor: string }>();
    return results;
  };

  /** Un pedido con un pago manual ya aprobado. */
  async function conPagoAprobado(montoCents: number, metodo = "yappy") {
    const p = await unPedido();
    const c = await comprobante(p.id, montoCents, { metodo, tipo: "abono" });
    if (!c.ok) throw new Error(c.mensaje);
    const conf = await confirmarPago(ctx(), c.datos.pagoId);
    if (!conf.ok) throw new Error(conf.mensaje);
    return { pedido: p, pagoId: c.datos.pagoId };
  }

  it("un reembolso antes de entregar sale del anticipo, no de las ventas", async () => {
    const { pedido, pagoId } = await conPagoAprobado(3000);

    const r = await registrarReembolso(ctx(), {
      pagoId,
      montoCents: 3000,
      motivo: "se arrepintió y no había salido",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.pagadoCents).toBe(0);
    expect(r.datos.estadoDelPago).toBe("reembolsado");

    // El pedido deja de tener ese dinero y lo dice con su estado de pago.
    const e = await estadoDe(pedido.id);
    expect(e?.pagado_cents).toBe(0);
    expect(e?.estado_pago).toBe("reembolsado");
    expect((await pagoDe(pagoId))?.estado).toBe("reembolsado");

    // Y queda la fila del libro: cuánto, por qué, por dónde y quién.
    expect(await reembolsosDe(pagoId)).toEqual([
      {
        monto_cents: 3000,
        motivo: "se arrepintió y no había salido",
        via: "manual",
        estado: "hecho",
        actor: "yarielis",
      },
    ]);

    const asiento = (await asientosDelPago(pagoId)).find((a) => a.hecho === "14");
    expect(asiento, "falta el asiento 14").toBeDefined();
    expect(asiento?.origen).toBe("reembolso");
    expect(asiento?.diferencia, "el asiento 14 no cuadró").toBe(0);
    expect(asiento?.descripcion).toContain(pedido.numero);

    // El pedido no había salido, así que ese dinero nunca fue una venta: sale
    // del pasivo con la clienta. Cargarlo a 4901 restaría de las ventas un
    // dinero que jamás entró en ellas.
    expect(await lineasDelAsiento(asiento!.id)).toEqual([
      { codigo: "1101", debe: 0, haber: 3000 },
      { codigo: "2101", debe: 3000, haber: 0 },
    ]);
  });

  it("después de entregar deshace la venta: va contra devoluciones (4901)", async () => {
    const { pedido, pagoId } = await conPagoAprobado(3000);
    // El pedido ya salió: ahí la venta SÍ se reconoció, y devolver dinero es
    // deshacerla. Se mueve a mano porque lo que se prueba es la cuenta del
    // asiento, no el camino de la entrega, que tiene sus propias pruebas.
    await env.DB.prepare("UPDATE pedidos SET estado = 'entregado' WHERE id = ?")
      .bind(pedido.id)
      .run();

    const r = await registrarReembolso(ctx(), {
      pagoId,
      montoCents: 3000,
      motivo: "le llegó rota",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const asiento = (await asientosDelPago(pagoId)).find((a) => a.hecho === "14");
    expect(await lineasDelAsiento(asiento!.id)).toEqual([
      { codigo: "1101", debe: 0, haber: 3000 },
      { codigo: "4901", debe: 3000, haber: 0 },
    ]);
  });

  it("el dinero vuelve por donde entró: cada método, su cuenta", async () => {
    for (const [metodo, cuenta] of [
      ["yappy", "1101"],
      ["transferencia", "1102"],
      ["efectivo", "1103"],
    ] as const) {
      const { pagoId } = await conPagoAprobado(1500, metodo);
      expect(
        (await registrarReembolso(ctx(), { pagoId, montoCents: 1500, motivo: "devuelto" })).ok,
        metodo,
      ).toBe(true);

      const asiento = (await asientosDelPago(pagoId)).find((a) => a.hecho === "14");
      expect(await lineasDelAsiento(asiento!.id), metodo).toEqual([
        { codigo: "2101", debe: 1500, haber: 0 },
        { codigo: cuenta, debe: 0, haber: 1500 },
      ].sort((a, b) => a.codigo.localeCompare(b.codigo)));
    }
  });

  it("un reembolso parcial lo dice en los dos sitios, y el resto puede volver después", async () => {
    const { pedido, pagoId } = await conPagoAprobado(3000);

    expect((await registrarReembolso(ctx(), { pagoId, montoCents: 1000, motivo: "una caja" })).ok)
      .toBe(true);
    expect((await estadoDe(pedido.id))?.pagado_cents).toBe(2000);
    expect((await estadoDe(pedido.id))?.estado_pago).toBe("reembolso_parcial");
    expect((await pagoDe(pagoId))?.estado).toBe("reembolso_parcial");

    expect((await registrarReembolso(ctx(), { pagoId, montoCents: 2000, motivo: "el resto" })).ok)
      .toBe(true);
    expect((await estadoDe(pedido.id))?.pagado_cents).toBe(0);
    expect((await pagoDe(pagoId))?.estado).toBe("reembolsado");
    expect(await reembolsosDe(pagoId)).toHaveLength(2);
  });

  it("no puede volver más de lo que entró", async () => {
    const { pagoId } = await conPagoAprobado(3000);
    expect((await registrarReembolso(ctx(), { pagoId, montoCents: 2500, motivo: "casi todo" })).ok)
      .toBe(true);

    const r = await registrarReembolso(ctx(), { pagoId, montoCents: 1000, motivo: "y un poco más" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("monto_no_coincide");
    // El mensaje dice las dos cifras: sin ellas, quien lo lea tiene que ir a
    // buscar cuánto llevaba devuelto ese pago.
    expect(r.mensaje).toMatch(/\$25\.00/);
    expect(await reembolsosDe(pagoId)).toHaveLength(1);
  });

  it("de un pago que no está aprobado no vuelve nada", async () => {
    const p = await unPedido();
    const c = await comprobante(p.id, 2000);
    if (!c.ok) throw new Error(c.mensaje);

    // Sigue en «confirmando»: nadie ha comprobado que ese dinero entrara, así
    // que devolverlo sería sacar de la cuenta algo que nunca llegó.
    const r = await registrarReembolso(ctx(), {
      pagoId: c.datos.pagoId,
      montoCents: 2000,
      motivo: "mejor no",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
    expect((await estadoDe(p.id))?.pagado_cents).toBe(0);
    expect(await reembolsosDe(c.datos.pagoId)).toHaveLength(0);
  });

  it("sin motivo no se registra: dentro de seis meses nadie sabría por qué volvió", async () => {
    const { pagoId } = await conPagoAprobado(2000);
    const r = await registrarReembolso(ctx(), { pagoId, montoCents: 2000, motivo: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
    expect(await reembolsosDe(pagoId)).toHaveLength(0);
  });

  /** Un pago de pasarela, que es de donde vienen los contracargos. */
  async function conPagoDePasarela(montoCents: number, proveedor: "tilopay" | "paypal") {
    const p = await unPedido();
    const pagoId = `pago-${proveedor}-${Date.now()}-${n++}`;
    // Se inserta directo porque `registrarComprobante` solo acepta métodos
    // manuales —y hace bien: un cobro de tarjeta no lo anota una persona—. El
    // adaptador de la pasarela, que es quien lo escribirá, llega en F4.7.
    await env.DB.prepare(
      `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,
         intento_ref,creado_en,actualizado_en)
       VALUES (?,?,?,'tarjeta','total','confirmando',?,?,?,?)`,
    )
      .bind(pagoId, p.id, proveedor, montoCents, `ref-${pagoId}`, ahora(), ahora())
      .run();
    const conf = await confirmarPago(ctx(), pagoId);
    if (!conf.ok) throw new Error(conf.mensaje);
    return { pedido: p, pagoId };
  }

  it("un contracargo deshace la venta contra la cuenta de la pasarela", async () => {
    const { pedido, pagoId } = await conPagoDePasarela(5000, "tilopay");

    const r = await registrarContracargo(ctx(), {
      pagoId,
      montoCents: 5000,
      motivo: "la clienta desconoció el cargo",
      proveedorRef: "DISPUTA-123",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const e = await estadoDe(pedido.id);
    expect(e?.pagado_cents, "el dinero ya no está: el pedido tiene que decirlo").toBe(0);
    expect(e?.estado_pago).toBe("reembolsado");
    expect((await pagoDe(pagoId))?.estado).toBe("reembolsado");

    const asiento = (await asientosDelPago(pagoId)).find((a) => a.hecho === "15");
    expect(asiento, "falta el asiento 15").toBeDefined();
    expect(asiento?.origen).toBe("contracargo");
    expect(asiento?.diferencia, "el asiento 15 no cuadró").toBe(0);

    // 1105 es «Por liquidar Tilopay»: ahí es donde estaba ese dinero mientras
    // la pasarela no lo depositaba, y de ahí se lo llevan.
    expect(await lineasDelAsiento(asiento!.id)).toEqual([
      { codigo: "1105", debe: 0, haber: 5000 },
      { codigo: "4901", debe: 5000, haber: 0 },
    ]);

    // Y la bitácora del pedido dice que fue un contracargo, no un reembolso:
    // la columna `pagos.estado` no distingue los dos y no se le inventa un
    // valor nuevo, así que la diferencia vive aquí y en el asiento.
    const ev = await env.DB.prepare(
      "SELECT tipo FROM pedido_eventos WHERE pedido_id = ? AND tipo = 'contracargo'",
    )
      .bind(pedido.id)
      .first<{ tipo: string }>();
    expect(ev?.tipo).toBe("contracargo");
  });

  it("un contracargo de un pago en efectivo no existe, y se dice en vez de inventarlo", async () => {
    const { pedido, pagoId } = await conPagoAprobado(2000, "efectivo");

    const r = await registrarContracargo(ctx(), {
      pagoId,
      montoCents: 2000,
      motivo: "alguien lo marcó mal",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");

    // Y no escribió nada por el camino: el dinero sigue donde estaba.
    expect((await estadoDe(pedido.id))?.pagado_cents).toBe(2000);
    expect((await pagoDe(pagoId))?.estado).toBe("aprobado");
    expect(await reembolsosDe(pagoId)).toHaveLength(0);
  });

  describe("dos salidas de dinero a la vez", () => {
    it("con la versión vieja del pedido en la mano, el batch se niega", async () => {
      // Es la actualización perdida, por el lado del dinero que sale: dos
      // reembolsos DISTINTOS leen `pagado_cents = 3000` a la vez, uno resta
      // $10 y el otro $5, y el último que escribe borra al otro. Lo cierra la
      // versión del pedido, que el segundo ya no tiene.
      const { pedido, pagoId } = await conPagoAprobado(3000);
      const v = await env.DB.prepare("SELECT version FROM pedidos WHERE id = ?")
        .bind(pedido.id)
        .first<{ version: number }>();

      expect((await registrarReembolso(ctx(), { pagoId, montoCents: 1000, motivo: "una caja" })).ok)
        .toBe(true);

      await expect(
        env.DB.batch(
          enunciadosDeDineroQueSale(ctx(), {
            pagoId,
            pedidoId: pedido.id,
            montoCents: 500,
            motivo: "otra caja",
            via: "manual",
            proveedorRef: null,
            estadoDelPagoLeido: "reembolso_parcial",
            estadoDelPagoNuevo: "reembolso_parcial",
            versionLeida: v?.version ?? 0,
            // Lo que habría escrito quien leyó 3000 antes del otro reembolso.
            pagadoDespuesCents: 2500,
            estadoDePagoDelPedido: "reembolso_parcial",
            evento: "reembolso",
          }),
        ),
      ).rejects.toThrow();

      expect((await estadoDe(pedido.id))?.pagado_cents, "el primer reembolso sigue ahí").toBe(2000);
    });

    it("y con el estado viejo del pago, también", async () => {
      // El otro lado de la carrera: dos personas devolviendo el MISMO pago. El
      // `WHERE estado = ?` hace que el segundo UPDATE no case con nada —y un
      // UPDATE que no casa NO FALLA—, así que lo que tumba el batch es el
      // control, que mira el estado nuevo Y la hora que escribió este batch.
      const { pedido, pagoId } = await conPagoAprobado(3000);
      expect((await registrarReembolso(ctx(), { pagoId, montoCents: 3000, motivo: "todo" })).ok)
        .toBe(true);

      const v = await env.DB.prepare("SELECT version FROM pedidos WHERE id = ?")
        .bind(pedido.id)
        .first<{ version: number }>();
      // Otra hora a propósito: si fuera la misma, el control no distinguiría
      // este batch del anterior, que es justo lo que `actualizado_en` defiende.
      const despues = { db: env.DB, ahora: ahora() + 60_000, actor: "yarielis" };

      await expect(
        env.DB.batch(
          enunciadosDeDineroQueSale(despues, {
            pagoId,
            pedidoId: pedido.id,
            montoCents: 3000,
            motivo: "otra vez",
            via: "manual",
            proveedorRef: null,
            // El estado que creía tener quien llegó segundo.
            estadoDelPagoLeido: "aprobado",
            estadoDelPagoNuevo: "reembolsado",
            versionLeida: v?.version ?? 0,
            pagadoDespuesCents: 0,
            estadoDePagoDelPedido: "reembolsado",
            evento: "reembolso",
          }),
        ),
      ).rejects.toThrow();

      expect(await reembolsosDe(pagoId), "el segundo no dejó fila").toHaveLength(1);
    });
  });
});
