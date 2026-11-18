import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { iniciarCobro } from "../src/db/cobros-en-linea";
import { configurarCredencial } from "../src/db/pasarelas";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";
import { DOMINIO_DEL_BOTON, recibirAvisoDeYappy, respuestaAlAviso } from "../src/pagos/recibir-aviso";
import { firmaDelIpn, yappy } from "../src/pagos/yappy";

/**
 * El aviso de pago de Yappy, de punta a punta y con la base de verdad.
 *
 * Es el único sitio del sistema donde una petición que llega de internet mueve
 * dinero. Lo que estas pruebas vigilan es que haga falta pasar por TODO antes
 * de creerle: la clave del baúl, el dominio, la firma, y después la base.
 *
 * El escenario es el de verdad: se crea un pedido, se arranca un cobro contra
 * un Yappy de mentira que contesta lo que contestaría el suyo, y después llega
 * el aviso. Lo único falso son las respuestas HTTP y los secretos.
 */

// Obviamente falsos. Ninguna llave ni credencial de verdad entra en este repo.
const LLAVE = "TExBVkUtRkFMU0EtREUtUFJVRUJBLTMyLUJZVEVTISE=";
const ID_FALSO = "ID-COMERCIO-FALSO-DE-PRUEBA-0001";
/** base64 de «clavedeprueba.segundotrozo», como la entrega Yappy. */
const CLAVE_FALSA = "Y2xhdmVkZXBydWViYS5zZWd1bmRvdHJvem8=";

let clienteId: string;
let n = 0;
const ahora = () => Date.now();
const ctx = () => ({
  db: env.DB,
  ahora: ahora(),
  actor: "sistema: aviso de Yappy",
  llaveMaestra: LLAVE,
});

const ctxP = (): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: "pruebas",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
});

function yappyQueContesta() {
  return yappy({ aliasYappy: "60000000" }, async () =>
    new Response(
      JSON.stringify({
        status: { code: "OK" },
        body: {
          epochTime: 1,
          token: "tok",
          transactionId: "TX-1",
          documentName: "doc-1",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

beforeEach(async () => {
  clienteId = `cli-ipn-${Date.now()}-${n++}`;
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, "Ana", ahora(), ahora())
    .run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pasarela_credenciales"),
    env.DB.prepare("UPDATE pasarelas SET modo = 'prueba'"),
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 50 WHERE codigo = 'NAT-M' AND bodega_id = (SELECT id FROM bodegas WHERE activa = 1 LIMIT 1)",
    ),
  ]);

  // El baúl, con las dos credenciales del modo de prueba.
  for (const [credencial, valor] of [
    ["id_comercio", ID_FALSO],
    ["clave_secreta", CLAVE_FALSA],
  ] as const) {
    const r = await configurarCredencial(
      { db: env.DB, ahora: ahora(), actor: "yarielis@babycaleb.com", llaveMaestra: LLAVE },
      {
        pasarela: "yappy",
        credencial,
        valor,
        modo: "prueba",
        motivo: "montar el escenario de la prueba del aviso",
      },
    );
    if (!r.ok) throw new Error(`${credencial}: ${r.mensaje}`);
  }
});

/** Un pedido con un cobro de Yappy ya arrancado. */
async function conCobro() {
  const p = await crearPedido(ctxP(), {
    idempotencia: `idem-ipn-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  });
  if (!p.ok) throw new Error(p.mensaje);

  const total = await env.DB.prepare("SELECT total_cents FROM pedidos WHERE id = ?")
    .bind(p.datos.id)
    .first<{ total_cents: number }>();

  const r = await iniciarCobro(
    ctx(),
    {
      pedidoId: p.datos.id,
      proveedor: "yappy",
      metodo: "yappy",
      tipo: "total",
      montoCents: total!.total_cents,
      urlAviso: `https://${DOMINIO_DEL_BOTON}/api/pago/yappy`,
    },
    yappyQueContesta(),
    {
      modo: "prueba",
      merchantId: ID_FALSO,
      secretKey: CLAVE_FALSA,
      domain: DOMINIO_DEL_BOTON,
    },
  );
  if (!r.ok) throw new Error(r.mensaje);
  return { pedido: p.datos, total: total!.total_cents, ...r.datos };
}

/** La URL que mandaría Yappy, bien firmada. */
async function urlDelAviso(orderId: string, letra: string, dominio = DOMINIO_DEL_BOTON) {
  const hash = await firmaDelIpn(CLAVE_FALSA, orderId, letra, dominio);
  return `?orderId=${orderId}&status=${letra}&domain=${dominio}&hash=${hash}&confirmationNumber=CONF-7`;
}

const pagadoDe = async (pedidoId: string) =>
  (
    await env.DB.prepare("SELECT pagado_cents, estado_pago FROM pedidos WHERE id = ?")
      .bind(pedidoId)
      .first<{ pagado_cents: number; estado_pago: string }>()
  )!;

// ---------------------------------------------------------------------------
describe("un aviso de verdad", () => {
  /**
   * ESTA PRUEBA ENCONTRÓ UN BUG DE DISEÑO, y por eso mira lo que `iniciarCobro`
   * GENERÓ y no lo que el generador sabe hacer.
   *
   * La primera versión armaba la referencia igual para todas las pasarelas:
   * `BC-000014-01M7P2J6VM5TXY4XS31CEVD4GY`, treinta y cinco caracteres con
   * guiones. Yappy solo acepta quince alfanuméricos y la rechaza con un error
   * que no dice que el problema sea el largo: el cobro habría fallado en
   * producción sin que nadie supiera por qué.
   *
   * Comprobar `referenciaParaYappy(...)` por separado NO lo habría visto —esa
   * función siempre estuvo bien—. Lo que fallaba era quién la llamaba.
   */
  it("la referencia que iniciarCobro mandó a Yappy cabe en sus 15 caracteres", async () => {
    const c = await conCobro();
    expect(c.intentoRef.length).toBeLessThanOrEqual(15);
    expect(c.intentoRef).toMatch(/^[A-Za-z0-9]+$/);
    // Y es la que viaja de verdad: la fila de `pagos` guarda esa misma.
    const fila = await env.DB.prepare("SELECT intento_ref FROM pagos WHERE id = ?")
      .bind(c.pagoId)
      .first<{ intento_ref: string }>();
    expect(fila?.intento_ref).toBe(c.intentoRef);
  });

  it("un «ejecutado» bien firmado aplica el pago", async () => {
    const c = await conCobro();

    const r = await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, "E"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.estado).toBe("ejecutado");
      expect(r.datos.comoQuedo.resultado).toBe("aprobado");
      expect(r.datos.mensaje).toMatch(/salió bien/i);
    }

    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(c.total);
  });

  it("y deja el asiento en 1101, que es la cuenta de Yappy", async () => {
    const c = await conCobro();
    await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, "E"));

    const linea = await env.DB.prepare(
      `SELECT cu.codigo, l.debe_cents
         FROM asientos a
         JOIN asiento_lineas l ON l.asiento_id = a.id
         JOIN cuentas cu       ON cu.id = l.cuenta_id
        WHERE a.referencia_tipo = 'pago' AND a.referencia_id = ? AND l.debe_cents > 0`,
    )
      .bind(c.pagoId)
      .first<{ codigo: string; debe_cents: number }>();

    /*
      1101 «Yappy Comercial», no 1105 «Por liquidar Tilopay»: a Yappy la
      clienta paga directo a la cuenta del negocio, así que no hay nada
      pendiente de liquidar. Si esto dijera 1105, el dinero aparecería dos
      veces: una esperando liquidación que nunca llega, y otra en el banco.
    */
    expect(linea?.codigo).toBe("1101");
    expect(linea?.debe_cents).toBe(c.total);
  });

  it("cada final no-ejecutado cierra el cobro sin sumar nada", async () => {
    for (const letra of ["R", "C", "X"]) {
      const c = await conCobro();
      const r = await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, letra));
      expect(r.ok, letra).toBe(true);
      if (r.ok) expect(r.datos.comoQuedo.resultado, letra).toBe("rechazado");
      expect((await pagadoDe(c.pedido.id)).pagado_cents, letra).toBe(0);
    }
  });

  it("y a cada uno le dice algo distinto a la clienta", async () => {
    const dichos: string[] = [];
    for (const letra of ["E", "R", "C", "X"]) {
      const c = await conCobro();
      const r = await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, letra));
      if (r.ok) dichos.push(r.datos.mensaje);
    }
    expect(new Set(dichos).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe("un aviso que no es de verdad", () => {
  /**
   * LA PRUEBA QUE JUSTIFICA TODO ESTO.
   *
   * El IPN es un GET abierto. Sin verificar la firma, escribir esta URL a mano
   * —con el número de un pedido, que la clienta tiene delante— marca el pedido
   * como pagado. No hace falta saber nada más del sistema.
   */
  it("con el hash inventado NO paga nada", async () => {
    const c = await conCobro();

    const r = await recibirAvisoDeYappy(
      ctx(),
      `?orderId=${c.intentoRef}&status=E&domain=${DOMINIO_DEL_BOTON}&hash=${"a".repeat(64)}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");

    expect((await pagadoDe(c.pedido.id)).pagado_cents, "no se pagó nada").toBe(0);
  });

  it("sin hash tampoco", async () => {
    const c = await conCobro();
    const r = await recibirAvisoDeYappy(
      ctx(),
      `?orderId=${c.intentoRef}&status=E&domain=${DOMINIO_DEL_BOTON}`,
    );
    expect(r.ok).toBe(false);
    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(0);
  });

  /**
   * Firmado para OTRO dominio, correctamente. La firma cuadra consigo misma;
   * lo que no cuadra es el dominio, y por eso se comprueba aparte.
   */
  it("firmado para otro dominio NO paga nada", async () => {
    const c = await conCobro();
    const r = await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, "E", "otracosa.com"));
    expect(r.ok).toBe(false);
    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(0);
  });

  /**
   * Y la firma de un RECHAZO no sirve para aprobar: sin el estado dentro de la
   * firma, bastaría con capturar el aviso de un pago fallido y reenviarlo
   * cambiando la letra.
   */
  it("la firma de un rechazo reenviada como «ejecutado» NO paga nada", async () => {
    const c = await conCobro();
    const firmaDelRechazo = await firmaDelIpn(CLAVE_FALSA, c.intentoRef, "R", DOMINIO_DEL_BOTON);
    const r = await recibirAvisoDeYappy(
      ctx(),
      `?orderId=${c.intentoRef}&status=E&domain=${DOMINIO_DEL_BOTON}&hash=${firmaDelRechazo}`,
    );
    expect(r.ok).toBe(false);
    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(0);
  });

  it("de una orden que no existe, no revienta: lo dice", async () => {
    const r = await recibirAvisoDeYappy(ctx(), await urlDelAviso("BCNOEXISTE1", "E"));
    expect(r.ok).toBe(false);
  });

  /**
   * SIN LLAVE MAESTRA NO SE PUEDE ABRIR LA CLAVE, Y ENTONCES NO SE APRUEBA.
   *
   * Falla cerrado: un sistema que no puede verificar no es un sistema que
   * aprueba por defecto.
   */
  it("sin llave maestra no se aprueba nada", async () => {
    const c = await conCobro();
    const r = await recibirAvisoDeYappy(
      { db: env.DB, ahora: ahora(), actor: "x", llaveMaestra: undefined },
      await urlDelAviso(c.intentoRef, "E"),
    );
    expect(r.ok).toBe(false);
    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("qué se le contesta a Yappy", () => {
  /**
   * SIEMPRE 200, SALVO CUANDO EL FALLO ES NUESTRO.
   *
   * Yappy reintenta lo que no recibe un 200. Un aviso con firma inválida no se
   * vuelve válido por reintentarlo: devolver un error solo consigue que nos lo
   * manden otras cinco veces. Pero si la que falló fue nuestra base, un
   * reintento sí puede salir bien, y ahí el 500 es correcto.
   */
  it("un aviso aplicado contesta 200", async () => {
    const c = await conCobro();
    const r = await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, "E"));
    expect(respuestaAlAviso(r).status).toBe(200);
  });

  it("un aviso con firma mala también contesta 200: reintentarlo no lo arregla", async () => {
    const c = await conCobro();
    const r = await recibirAvisoDeYappy(
      ctx(),
      `?orderId=${c.intentoRef}&status=E&domain=${DOMINIO_DEL_BOTON}&hash=${"b".repeat(64)}`,
    );
    expect(r.ok).toBe(false);
    expect(respuestaAlAviso(r).status).toBe(200);
  });

  it("un fallo nuestro contesta 500, para que Yappy vuelva a intentarlo", () => {
    const r = { ok: false as const, codigo: "interno" as const, mensaje: "la base no contestó" };
    expect(respuestaAlAviso(r).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
describe("el aviso repetido", () => {
  /**
   * Yappy reintenta. Y la clienta puede recargar. Sin idempotencia, el segundo
   * aviso suma el pago otra vez y el pedido se agenda con un abono que nadie
   * hizo.
   */
  it("el mismo aviso dos veces no paga dos veces", async () => {
    const c = await conCobro();
    const url = await urlDelAviso(c.intentoRef, "E");

    await recibirAvisoDeYappy(ctx(), url);
    const dos = await recibirAvisoDeYappy(ctx(), url);

    expect(dos.ok).toBe(true);
    if (dos.ok) expect(dos.datos.comoQuedo.resultado).toBe("ya_estaba");
    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(c.total);
  });

  it("y un «cancelado» que llega DESPUÉS de un «ejecutado» no deshace el pago", async () => {
    const c = await conCobro();
    await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, "E"));
    await recibirAvisoDeYappy(ctx(), await urlDelAviso(c.intentoRef, "C"));

    // El dinero entró. Un aviso posterior no lo borra: los libros no se editan.
    expect((await pagadoDe(c.pedido.id)).pagado_cents).toBe(c.total);
  });
});
