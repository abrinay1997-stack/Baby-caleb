import { describe, expect, it } from "vitest";

import {
  CDN,
  COMO_SE_LE_DICE,
  HOST,
  LARGO_MAXIMO_ORDEN,
  credencialesYappy,
  estadoDeLetra,
  firmaDelIpn,
  leerAviso,
  ordenValida,
  referenciaParaYappy,
  yappy,
  type CredencialesYappy,
} from "./yappy";

/**
 * Las pruebas del Botón de Pago de Yappy.
 *
 * Sin red: el `fetch` se inyecta. Lo que se vigila no es que Yappy funcione
 * —eso lo prueba un cobro de verdad en su entorno de pruebas— sino que
 * mandemos lo que su documentación pide y que **la firma del aviso se
 * verifique de verdad**.
 *
 * Esa última es LA prueba de este archivo. El IPN de Yappy es un GET abierto
 * que cualquiera puede llamar escribiendo una URL; lo único que lo hace
 * confiable es el hash. Sin verificarlo, cualquiera marca pedidos como pagados
 * desde la barra de direcciones, sin saber nada del sistema más que el número
 * de un pedido.
 */

/**
 * LOS VECTORES DEL HASH SE CALCULARON APARTE, CON OTRA IMPLEMENTACIÓN.
 *
 * Están sacados con el `hmac` de Python, no con este código: una prueba que
 * calcula el valor esperado con la misma función que está probando no comprueba
 * nada —las dos se equivocarían igual—. Así que si alguien cambia el orden de
 * la concatenación, se olvida de partir por el punto, o usa la clave sin
 * decodificar de base64, estos números dejan de salir.
 *
 * La clave es base64 de «clavedeprueba.segundotrozo», y lo que se firma es
 * «BC104X1» + la letra + «babycaleb.com».
 */
const SECRETO = "Y2xhdmVkZXBydWViYS5zZWd1bmRvdHJvem8=";
const DOMINIO = "babycaleb.com";
const ORDEN = "BC104X1";

const FIRMAS: Readonly<Record<string, string>> = {
  E: "e960e5163c68af0b23ad4331ae678116e184426e55a6261cd9e600fb51502f25",
  R: "22ba0240915b65226c006c36b9d7afa5ec8e3fb25d654d5ea81acce3ffa595af",
  C: "00ef976ed46331b7fb5325766fe3dcf2ff665ab77072e9b5f77256b5c8606a3d",
  X: "89735b472fa84ccc919ea9dc466f927553de141778856e20f4f3183d9f0865ee",
};

const CRED: CredencialesYappy = {
  modo: "prueba",
  merchantId: "comercio-de-prueba",
  secretKey: SECRETO,
  domain: DOMINIO,
  dominiosAceptados: [DOMINIO],
};

const avisoDe = (letra: string, sobre: Partial<Record<string, string>> = {}) => ({
  orderId: ORDEN,
  status: letra,
  domain: DOMINIO,
  hash: FIRMAS[letra] ?? "",
  ...sobre,
});

function espia(respuestas: ReadonlyArray<{ status?: number; cuerpo: unknown }>) {
  const llamadas: Array<{ url: string; init: RequestInit; cuerpo: unknown }> = [];
  let i = 0;
  return {
    llamadas,
    buscar: async (url: string, init: RequestInit): Promise<Response> => {
      const crudo = typeof init.body === "string" ? init.body : "";
      llamadas.push({ url, init, cuerpo: crudo === "" ? null : (JSON.parse(crudo) as unknown) });
      const r = respuestas[Math.min(i, respuestas.length - 1)];
      i += 1;
      return new Response(JSON.stringify(r?.cuerpo ?? {}), {
        status: r?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

const TOKEN_OK = { cuerpo: { status: { code: "OK" }, body: { epochTime: 1, token: "tok-sesion" } } };
const ORDEN_OK = {
  cuerpo: {
    status: { code: "OK" },
    body: { transactionId: "TX-1", token: "tok-boton", documentName: "doc-1" },
  },
};

// ---------------------------------------------------------------------------
describe("el hash del aviso", () => {
  it("da los vectores calculados aparte, para los cuatro estados", async () => {
    for (const [letra, esperada] of Object.entries(FIRMAS)) {
      expect(await firmaDelIpn(SECRETO, ORDEN, letra, DOMINIO), letra).toBe(esperada);
    }
  });

  it("es hexadecimal en minúsculas, 64 caracteres", async () => {
    const f = await firmaDelIpn(SECRETO, ORDEN, "E", DOMINIO);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Los tres detalles que se pueden equivocar por separado. Cada uno cambia el
   * resultado, así que cada uno tiene su prueba de que SÍ influye.
   */
  it("cambiar el dominio cambia la firma", async () => {
    const a = await firmaDelIpn(SECRETO, ORDEN, "E", DOMINIO);
    const b = await firmaDelIpn(SECRETO, ORDEN, "E", "otracosa.com");
    expect(b).not.toBe(a);
    expect(b).toBe("104120da77313fa0a4ac3dbcabe3feb807d333a2cd02d15823cb4519348a60af");
  });

  it("cambiar la orden cambia la firma", async () => {
    const b = await firmaDelIpn(SECRETO, "BC999Z9", "E", DOMINIO);
    expect(b).toBe("1c54d8c53801f2d111e43873acade8b89ca2391a12819c6e537090db785d9d19");
  });

  it("cambiar el estado cambia la firma", async () => {
    expect(FIRMAS.E).not.toBe(FIRMAS.R);
  });

  /**
   * SE USA SOLO EL PRIMER TROZO DE LA CLAVE.
   *
   * Si alguien firmara con el texto entero —sin partir por el punto— saldría
   * otra cosa. Esta prueba lo fija comparando contra la firma hecha con una
   * clave cuyo primer trozo es el mismo pero el segundo es distinto: tienen
   * que dar IGUAL, porque el segundo trozo no entra.
   */
  it("el segundo trozo de la clave no influye: se parte por el punto", async () => {
    const otraCola = btoa("clavedeprueba.otracosaquenoimporta");
    expect(await firmaDelIpn(otraCola, ORDEN, "E", DOMINIO)).toBe(FIRMAS.E);
  });
});

// ---------------------------------------------------------------------------
describe("verificar el aviso (lo único que puede marcar un pago)", () => {
  // Verificar un aviso no necesita teléfono de nadie: la fábrica va sin extras.
  const pas = () => yappy({}, espia([]).buscar);

  it("un aviso bien firmado pasa, y trae nuestro estado en palabras", async () => {
    const r = await pas().verifyWebhook(CRED, avisoDe("E"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.estado).toBe("ejecutado");
      expect(r.datos.ordenId).toBe(ORDEN);
    }
  });

  /**
   * ESTA ES LA PRUEBA QUE JUSTIFICA EL ARCHIVO.
   *
   * Sin verificación de firma, escribir la URL del IPN a mano con `status=E`
   * marca cualquier pedido como pagado. No hace falta saber nada del sistema:
   * solo el número de un pedido, que la clienta tiene en su pantalla.
   */
  it("un aviso con el hash inventado NO pasa", async () => {
    const r = await pas().verifyWebhook(CRED, avisoDe("E", { hash: "a".repeat(64) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");
  });

  it("un aviso sin hash NO pasa", async () => {
    const r = await pas().verifyWebhook(CRED, avisoDe("E", { hash: "" }));
    expect(r.ok).toBe(false);
  });

  /**
   * Y la firma de OTRO estado tampoco vale para éste.
   *
   * Sin el estado dentro de la firma, bastaría con capturar el aviso de un
   * pago rechazado —que es público para quien esté mirando— y reenviarlo
   * cambiando la letra a «E».
   */
  it("la firma de un rechazo no sirve para aprobar", async () => {
    const r = await pas().verifyWebhook(CRED, { ...avisoDe("E"), hash: FIRMAS.R! });
    expect(r.ok).toBe(false);
  });

  /**
   * EL DOMINIO DEL AVISO TIENE QUE SER EL NUESTRO.
   *
   * El hash se calcula sobre el dominio que venga, así que sin esta
   * comprobación bastaría con firmar un aviso para otro dominio y la firma
   * cuadraría consigo misma.
   */
  it("un aviso de otro dominio NO pasa, aunque venga bien firmado para ese dominio", async () => {
    const firmaDeOtro = await firmaDelIpn(SECRETO, ORDEN, "E", "otracosa.com");
    const r = await pas().verifyWebhook(CRED, {
      orderId: ORDEN,
      status: "E",
      domain: "otracosa.com",
      hash: firmaDeOtro,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");
  });

  it("un estado que Yappy no define se rechaza en vez de adivinarse", async () => {
    const r = await pas().verifyWebhook(CRED, avisoDe("Z", { hash: "x".repeat(64) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  /**
   * El id del evento lleva el ESTADO dentro.
   *
   * Yappy puede mandar más de un aviso para la misma orden si pasa por estados
   * distintos. Con solo el `orderId`, el segundo se descartaría en silencio
   * por repetido.
   */
  it("el id del evento distingue dos avisos de la misma orden", async () => {
    const e = await pas().verifyWebhook(CRED, avisoDe("E"));
    const c = await pas().verifyWebhook(CRED, avisoDe("C"));
    expect(e.ok && c.ok).toBe(true);
    if (e.ok && c.ok) expect(e.datos.eventoId).not.toBe(c.datos.eventoId);
  });
});

// ---------------------------------------------------------------------------
/**
 * `www` y sin `www`: las dos son NUESTRAS, y Yappy elige con cuál firma.
 *
 * Esto se descubrió el 18-nov-2026, el día del primer despliegue del cobro. El
 * dominio que la dueña declaró en Yappy Comercial lleva `www`, y el código
 * exigía el ápice exacto. Con eso, las órdenes se habrían creado —el botón
 * habría funcionado, la clienta habría pagado— y CADA aviso de vuelta se
 * habría rechazado por no_autorizado: dinero en la cuenta de Yappy y pedidos
 * sin confirmar, sin un solo error en ninguna pantalla.
 *
 * No afloja la verificación. Se aceptan DOS cadenas, las dos escritas por
 * nosotros, y lo que se mete en el hash es NUESTRA copia de la que coincidió,
 * no la que vino en la petición. La firma se sigue comprobando con la clave.
 *
 * ## Romper a propósito
 *
 * Deje `dominiosAceptados` con uno solo, o firme con `cred.domain` en vez de
 * con el que coincidió. Las dos ponen roja su casilla.
 */
describe("el dominio del aviso: los nuestros, y solo los nuestros", () => {
  const CON_WWW = "www.babycaleb.com";
  const LOS_DOS: CredencialesYappy = { ...CRED, domain: CON_WWW, dominiosAceptados: [CON_WWW, DOMINIO] };
  const pas = () => yappy({}, espia([]).buscar);

  it("un aviso firmado para www pasa, aunque lo declarado tenga www", async () => {
    const hash = await firmaDelIpn(SECRETO, ORDEN, "E", CON_WWW);
    const r = await pas().verifyWebhook(LOS_DOS, avisoDe("E", { domain: CON_WWW, hash }));
    expect(r.ok, !r.ok ? r.mensaje : "").toBe(true);
  });

  it("y uno firmado para el ápice también, con las mismas credenciales", async () => {
    // Es el caso que importa: no sabemos con cuál de las dos va a firmar Yappy,
    // y las dos tienen que entrar.
    const r = await pas().verifyWebhook(LOS_DOS, avisoDe("E"));
    expect(r.ok, !r.ok ? r.mensaje : "").toBe(true);
  });

  it("se firma con el dominio QUE COINCIDIÓ, no con uno fijo", async () => {
    // Si se firmara siempre con `cred.domain` (www), este aviso del ápice
    // —correctamente firmado para el ápice— se rechazaría.
    const hash = await firmaDelIpn(SECRETO, ORDEN, "E", DOMINIO);
    const r = await pas().verifyWebhook(LOS_DOS, avisoDe("E", { domain: DOMINIO, hash }));
    expect(r.ok).toBe(true);

    // Y al revés: el hash del ápice con el dominio de www NO cuadra.
    const cruzado = await pas().verifyWebhook(LOS_DOS, avisoDe("E", { domain: CON_WWW, hash }));
    expect(cruzado.ok).toBe(false);
  });

  it("un dominio que no es nuestro NO pasa, por bien firmado que venga", async () => {
    // La prueba de que la lista es una lista nuestra y no «cualquier dominio».
    const ajeno = "babycaleb.com.ejemplo-malo.net";
    const hash = await firmaDelIpn(SECRETO, ORDEN, "E", ajeno);
    const r = await pas().verifyWebhook(LOS_DOS, avisoDe("E", { domain: ajeno, hash }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");
  });

  it("y un subdominio parecido tampoco", async () => {
    for (const casi of ["babycaleb.com.co", "wwwbabycaleb.com", "pagos.babycaleb.com", ""]) {
      const hash = await firmaDelIpn(SECRETO, ORDEN, "E", casi);
      const r = await pas().verifyWebhook(LOS_DOS, avisoDe("E", { domain: casi, hash }));
      expect(r.ok, `pasó con «${casi}»`).toBe(false);
    }
  });

  it("las credenciales guardan el declarado y, además, los aceptados", () => {
    const cred = credencialesYappy(
      "real",
      new Map([["id_comercio", "x"], ["clave_secreta", "y"]]),
      CON_WWW,
      [DOMINIO, CON_WWW, "  "],
    );
    expect(cred.ok).toBe(true);
    if (cred.ok) {
      // El declarado es UNO: es el que se manda en `urlDomain`.
      expect(cred.datos.domain).toBe(CON_WWW);
      // Y la lista no repite ni guarda vacíos.
      expect(cred.datos.dominiosAceptados).toEqual([CON_WWW, DOMINIO]);
    }
  });

  it("sin lista, se acepta solo el declarado — el comportamiento de antes", () => {
    const cred = credencialesYappy(
      "real",
      new Map([["id_comercio", "x"], ["clave_secreta", "y"]]),
      DOMINIO,
    );
    expect(cred.ok).toBe(true);
    if (cred.ok) expect(cred.datos.dominiosAceptados).toEqual([DOMINIO]);
  });
});

describe("los cuatro finales", () => {
  it("solo E es un pago", () => {
    expect(estadoDeLetra("E")).toBe("ejecutado");
    expect(estadoDeLetra("R")).toBe("rechazado");
    expect(estadoDeLetra("C")).toBe("cancelado");
    expect(estadoDeLetra("X")).toBe("expirado");
    expect(estadoDeLetra("Q")).toBeNull();
  });

  /**
   * Cada final tiene su mensaje. «Falló el pago» a secas deja a la clienta sin
   * saber si volver a intentarlo o llamar al banco, y son tres cosas distintas:
   * no confirmó a tiempo, lo canceló ella, o nunca lo empezó.
   */
  it("cada final le dice a la clienta algo distinto y útil", () => {
    const dichos = Object.values(COMO_SE_LE_DICE);
    expect(new Set(dichos).size).toBe(4);
    expect(COMO_SE_LE_DICE.rechazado).toMatch(/cinco minutos/);
    expect(COMO_SE_LE_DICE.cancelado).toMatch(/app de Yappy/i);
  });

  it("lee el aviso de la URL, con y sin interrogación", () => {
    const a = leerAviso("?orderId=BC1&status=E&domain=d.com&hash=ff&confirmationNumber=9");
    expect(a).toEqual({
      orderId: "BC1",
      status: "E",
      domain: "d.com",
      hash: "ff",
      confirmationNumber: "9",
    });
    expect(leerAviso("orderId=BC1").orderId).toBe("BC1");
  });
});

// ---------------------------------------------------------------------------
describe("el número de orden: 1 a 15 alfanuméricos", () => {
  /**
   * Es la restricción más fácil de pasar por alto, y rompe en producción y no
   * en desarrollo: nuestras referencias internas son ULID de 26 caracteres con
   * guiones. Yappy las rechaza con un error que no dice que el problema sea el
   * largo.
   */
  it("acepta lo que cabe y rechaza lo que no", () => {
    expect(ordenValida("BC104X1")).toBe(true);
    expect(ordenValida("A")).toBe(true);
    expect(ordenValida("A".repeat(LARGO_MAXIMO_ORDEN))).toBe(true);
    expect(ordenValida("A".repeat(LARGO_MAXIMO_ORDEN + 1))).toBe(false);
    expect(ordenValida("")).toBe(false);
    expect(ordenValida("BC-104")).toBe(false); // el guion no es alfanumérico
    expect(ordenValida("01K9ABC-DEF-GHI-JKL")).toBe(false); // un ULID nuestro
  });

  it("la referencia que se genera siempre cabe y siempre es válida", () => {
    for (const numero of ["BC-1", "BC-104", "BC-999999", "PEDIDO-LARGUÍSIMO-DE-VERDAD-2026"]) {
      const r = referenciaParaYappy(numero);
      expect(ordenValida(r), `${numero} → ${r}`).toBe(true);
      expect(r.length).toBeLessThanOrEqual(LARGO_MAXIMO_ORDEN);
    }
  });

  it("empieza por el número del pedido: la dueña lo reconoce en su panel", () => {
    expect(referenciaParaYappy("BC-104").startsWith("BC104")).toBe(true);
  });

  /**
   * Y es ÚNICA. `pagos.intento_ref` tiene UNIQUE, así que dos referencias
   * iguales abortarían el segundo cobro del mismo pedido.
   */
  it("dos referencias del mismo pedido no coinciden", () => {
    const vistas = new Set<string>();
    for (let i = 0; i < 200; i++) vistas.add(referenciaParaYappy("BC-104"));
    expect(vistas.size).toBeGreaterThan(190);
  });
});

// ---------------------------------------------------------------------------
describe("crear la orden", () => {
  it("valida el comercio y después crea la orden, en ese orden", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    const r = await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/yappy",
    });

    expect(r.ok).toBe(true);
    expect(e.llamadas[0]?.url).toBe(`${HOST.prueba}/payments/validate/merchant`);
    expect(e.llamadas[1]?.url).toBe(`${HOST.prueba}/payments/payment-wc`);
  });

  it("el modo decide el servidor, no solo las credenciales", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(
      { ...CRED, modo: "real" },
      { ordenId: ORDEN, montoCents: 1250, urlAviso: "u" },
    );
    expect(e.llamadas[0]?.url.startsWith(HOST.real)).toBe(true);
    expect(HOST.real).not.toBe(HOST.prueba);
    expect(CDN.real).not.toBe(CDN.prueba);
  });

  it("manda el importe como texto con dos decimales, no en centavos", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "u",
    });
    const c = e.llamadas[1]?.cuerpo as Record<string, unknown>;
    expect(c.total).toBe("12.50");
    expect(c.total).not.toBe(1250);
    expect(c.discount).toBe("0.00");
    expect(c.taxes).toBe("0.00");
  });

  it("manda el dominio, el alias y la URL del aviso", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    await yappy({ aliasYappy: "61234567" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/yappy",
    });
    const c = e.llamadas[1]?.cuerpo as Record<string, unknown>;
    expect(c.domain).toBe(DOMINIO);
    expect(c.aliasYappy).toBe("61234567");
    expect(c.ipnUrl).toBe("https://babycaleb.com/pago/yappy");
    expect(c.merchantId).toBe("comercio-de-prueba");
  });

  /**
   * Devuelve datos de BOTÓN, no una URL: Yappy no manda a la clienta a otra
   * página, el componente abre un modal con estos tres valores.
   */
  it("devuelve los tres valores del botón, y ninguno es un secreto", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    const r = await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "u",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.datos.tipo === "creado") {
      expect(r.datos.datosBoton).toEqual({
        transactionId: "TX-1",
        token: "tok-boton",
        documentName: "doc-1",
      });
      expect(r.datos.redirectUrl).toBeUndefined();
      expect(JSON.stringify(r.datos.datosBoton)).not.toContain(SECRETO);
    }
  });

  it("una orden que Yappy no aceptaría no llega a salir", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    const r = await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: "01K9ABC-DEF-GHI-JKL-MNO",
      montoCents: 1250,
      urlAviso: "u",
    });
    expect(r.ok).toBe(false);
    // Y no se gastó una llamada en algo que se sabía que iba a fallar.
    expect(e.llamadas.length).toBe(0);
  });

  it("menos de un centavo no se manda: su mínimo es 0.01", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    const r = await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 0,
      urlAviso: "u",
    });
    expect(r.ok).toBe(false);
    expect(e.llamadas.length).toBe(0);
  });

  it("si Yappy no valida el comercio, no se intenta crear la orden", async () => {
    const e = espia([{ status: 401, cuerpo: { status: { description: "merchant not found" } } }]);
    const r = await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "u",
    });
    expect(r.ok).toBe(false);
    expect(e.llamadas.length).toBe(1);
  });

  it("el mensaje de error no filtra la clave secreta ni el ID de comercio", async () => {
    const e = espia([
      { status: 400, cuerpo: { enviado: { merchantId: "comercio-de-prueba", secretKey: SECRETO } } },
    ]);
    const r = await yappy({ aliasYappy: "60000000" }, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "u",
    });
    expect(r.ok).toBe(false);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(SECRETO);
    expect(texto).not.toContain("comercio-de-prueba");
  });
});

// ---------------------------------------------------------------------------
describe("las credenciales y lo que no se hace", () => {
  it("sin ID de comercio o sin clave secreta, no hay cobro", () => {
    expect(credencialesYappy("real", new Map([["id_comercio", "x"]]), DOMINIO).ok).toBe(false);
    expect(credencialesYappy("real", new Map([["clave_secreta", "x"]]), DOMINIO).ok).toBe(false);
  });

  /**
   * Y SIN DOMINIO TAMPOCO, aunque no sea un secreto.
   *
   * Entra en el hash de cada aviso: con el dominio mal, las órdenes se crean y
   * después NINGÚN pago se puede verificar. Fallar al crear es mucho más
   * barato que fallar al cobrar.
   */
  it("sin dominio no hay cobro, aunque el dominio no sea un secreto", () => {
    const r = credencialesYappy(
      "real",
      new Map([["id_comercio", "x"], ["clave_secreta", "y"]]),
      "   ",
    );
    expect(r.ok).toBe(false);
  });

  it("consultar dice que esa integración es otra, no que no se puede", async () => {
    const r = await yappy({}, espia([]).buscar).consultar(CRED, ORDEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/API Comercial/i);
  });

  it("el reembolso dice dónde se hace", async () => {
    const r = await yappy({}, espia([]).buscar).refundPayment(CRED, "TX-1", 1250);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/Yappy Comercial/i);
  });
});

// ---------------------------------------------------------------------------
describe("el teléfono se pide donde se usa", () => {
  /**
   * Sin alias no se crea una orden, y el mensaje dice QUÉ falta.
   *
   * Antes la fábrica lo exigía siempre, así que la ruta del aviso —que no
   * necesita el teléfono de nadie— tenía que inventarse un `{ aliasYappy: "" }`
   * para contentar al tipo. Un valor falso puesto para eso es exactamente como
   * se cuela un dato vacío donde después hace falta uno de verdad: Yappy
   * habría creado la orden y la solicitud no habría llegado a ningún teléfono.
   */
  it("crear una orden sin teléfono falla, y no se gasta una llamada", async () => {
    const e = espia([TOKEN_OK, ORDEN_OK]);
    const r = await yappy({}, e.buscar).createPayment(CRED, {
      ordenId: ORDEN,
      montoCents: 1250,
      urlAviso: "u",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/teléfono/i);
    expect(e.llamadas.length).toBe(0);
  });

  it("verificar un aviso NO necesita teléfono", async () => {
    const r = await yappy().verifyWebhook(CRED, avisoDe("E"));
    expect(r.ok).toBe(true);
  });
});
