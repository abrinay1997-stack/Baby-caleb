import { describe, expect, it } from "vitest";

import { iniciarPagoYappy, type LimitePorIp, type SistemaDelCobro } from "./iniciar-pago";

/**
 * La ruta que arranca un pago.
 *
 * Es pública y **crea pedidos, que apartan inventario**. Eso es lo que decide
 * qué se vigila aquí: el límite por IP, el tope del cuerpo, y que ningún fallo
 * acabe en una pantalla que no dice qué hacer.
 *
 * Lo que NO se prueba aquí: los precios, el pedido y el cobro. Eso vive del
 * lado del sistema, con la base de verdad, y se prueba allí.
 */

const sistemaQue = (
  r: Awaited<ReturnType<NonNullable<SistemaDelCobro["cobrarCarrito"]>>> | "revienta",
): SistemaDelCobro & { visto: unknown[] } => {
  const visto: unknown[] = [];
  return {
    visto,
    async cobrarCarrito(carrito: unknown) {
      visto.push(carrito);
      if (r === "revienta") throw new Error("el binding no contestó");
      return r;
    },
  };
};

const limiteQue = (deja: boolean): LimitePorIp & { veces: number } => {
  const l = { veces: 0, async limit() { l.veces += 1; return { success: deja }; } };
  return l;
};

const BIEN = {
  ok: true as const,
  datos: {
    pedido: { numero: "BC-000104", token: "tok", totalCents: 5000, envioCents: 300 },
    boton: { transactionId: "TX-1", token: "tok-boton", documentName: "doc-1" },
  },
};

const CARRITO = {
  nombre: "Ana",
  celular: "6000-0001",
  lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  idempotencia: "carrito-12345678",
};

const POST = (cuerpo: unknown, cabeceras: Record<string, string> = {}) =>
  new Request("https://babycaleb.com/api/pago/yappy/iniciar", {
    method: "POST",
    headers: { "content-type": "application/json", ...cabeceras },
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });

const leer = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("el camino bueno", () => {
  it("pasa el carrito al sistema y devuelve lo del botón", async () => {
    const s = sistemaQue(BIEN);
    const r = await iniciarPagoYappy(POST(CARRITO), s, undefined);

    expect(r.status).toBe(200);
    expect(s.visto[0]).toEqual(CARRITO);
    const cuerpo = await leer(r);
    expect(cuerpo.ok).toBe(true);
  });

  /**
   * La respuesta NO se cachea. Lleva el número de un pedido y los datos de un
   * cobro: un intermediario que la guarde se la serviría a otra persona.
   */
  it("la respuesta no se guarda en ninguna caché", async () => {
    const r = await iniciarPagoYappy(POST(CARRITO), sistemaQue(BIEN), undefined);
    expect(r.headers.get("cache-control")).toContain("no-store");
  });
});

describe("el límite por IP", () => {
  /**
   * VA ANTES DE TODO, y es lo que impide que un guion aparte la bodega entera.
   *
   * Crear un pedido reserva cajas. Mil pedidos en un minuto dejan la tienda
   * diciendo «agotado» a las clientas de verdad, sin que nadie haya pagado un
   * centavo. Las reservas vencen solas, pero «un rato» en una tienda que vende
   * por WhatsApp es una mañana de ventas.
   */
  it("si se pasa del límite, no se llama al sistema", async () => {
    const s = sistemaQue(BIEN);
    const r = await iniciarPagoYappy(POST(CARRITO), s, limiteQue(false));

    expect(r.status).toBe(429);
    expect(s.visto.length, "no se creó ningún pedido").toBe(0);
  });

  it("y el mensaje lo entiende una clienta, no es un código seco", async () => {
    const r = await iniciarPagoYappy(POST(CARRITO), sistemaQue(BIEN), limiteQue(false));
    const cuerpo = await leer(r);
    expect(String(cuerpo.mensaje)).toMatch(/espera un momento/i);
  });

  it("dentro del límite, pasa", async () => {
    const l = limiteQue(true);
    const r = await iniciarPagoYappy(POST(CARRITO), sistemaQue(BIEN), l);
    expect(r.status).toBe(200);
    expect(l.veces).toBe(1);
  });
});

describe("lo que no se acepta", () => {
  it("solo POST", async () => {
    const s = sistemaQue(BIEN);
    const r = await iniciarPagoYappy(
      new Request("https://babycaleb.com/api/pago/yappy/iniciar"),
      s,
      undefined,
    );
    expect(r.status).toBe(405);
    expect(s.visto.length).toBe(0);
  });

  /**
   * UN CUERPO ENORME SE CORTA ANTES DE PARSEARLO.
   *
   * Sin tope, alguien manda diez megas y el Worker los parsea antes de poder
   * negarse: gratis para quien lo manda, caro para nosotros.
   */
  it("un cuerpo enorme se rechaza sin parsearlo", async () => {
    const s = sistemaQue(BIEN);
    const enorme = JSON.stringify({ ...CARRITO, notas: "x".repeat(20_000) });
    const r = await iniciarPagoYappy(POST(enorme), s, undefined);
    expect(r.status).toBe(413);
    expect(s.visto.length).toBe(0);
  });

  it("y también si solo lo DICE la cabecera", async () => {
    const s = sistemaQue(BIEN);
    const r = await iniciarPagoYappy(POST(CARRITO, { "content-length": "999999" }), s, undefined);
    expect(r.status).toBe(413);
    expect(s.visto.length).toBe(0);
  });

  it("un cuerpo que no es JSON no revienta: lo dice", async () => {
    const r = await iniciarPagoYappy(POST("{esto no es json"), sistemaQue(BIEN), undefined);
    expect(r.status).toBe(400);
    expect(String((await leer(r)).mensaje)).toMatch(/no se entendió/i);
  });
});

describe("cuando algo falla, la clienta sabe qué hacer", () => {
  /**
   * El mensaje del sistema pasa TAL CUAL: está escrito para que lo lea una
   * clienta. Reescribirlo aquí sería tener dos versiones del mismo texto.
   */
  it("el mensaje del sistema no se reescribe", async () => {
    const s = sistemaQue({
      ok: false,
      codigo: "sin_stock",
      mensaje: "Solo quedan 2 cajas de NAT-M y pediste 5.",
    });
    const r = await iniciarPagoYappy(POST(CARRITO), s, undefined);
    expect((await leer(r)).mensaje).toBe("Solo quedan 2 cajas de NAT-M y pediste 5.");
  });

  /**
   * El código HTTP sí se traduce, porque el navegador lo usa: 409 para lo que
   * depende del estado de las cosas, 400 para lo que depende de lo que se
   * mandó, 503 para «la pasarela no está».
   */
  it("traduce el código a algo que el navegador entienda", async () => {
    const casos: ReadonlyArray<readonly [string, number]> = [
      ["sin_stock", 409],
      ["transicion_invalida", 409],
      ["repetido", 409],
      ["entrada_invalida", 400],
      ["pasarela_no_disponible", 503],
    ];
    for (const [codigo, esperado] of casos) {
      const r = await iniciarPagoYappy(
        POST(CARRITO),
        sistemaQue({ ok: false, codigo, mensaje: "x" }),
        undefined,
      );
      expect(r.status, codigo).toBe(esperado);
    }
  });

  /**
   * SIN SISTEMA, EL MENSAJE DICE DOS COSAS: que el pedido NO se creó, y por
   * dónde seguir. «Error 503» deja a una clienta sin saber si le cobraron.
   */
  it("sin sistema al otro lado, lo dice y da una salida", async () => {
    const r = await iniciarPagoYappy(POST(CARRITO), undefined, undefined);
    expect(r.status).toBe(503);
    const m = String((await leer(r)).mensaje);
    expect(m).toMatch(/no se creó/i);
    expect(m).toMatch(/whatsapp/i);
  });

  /**
   * Y si revienta a media llamada, lo que hay que decir es lo que la clienta
   * no puede saber sola: si le cobraron o no. Por eso el mensaje la manda a
   * escribir CON SU NÚMERO, que es con lo que se puede buscar el pago.
   */
  it("si el binding revienta, el mensaje contempla que le hayan cobrado", async () => {
    const r = await iniciarPagoYappy(POST(CARRITO), sistemaQue("revienta"), undefined);
    expect(r.status).toBe(500);
    expect(String((await leer(r)).mensaje)).toMatch(/si te cobraron/i);
  });
});
