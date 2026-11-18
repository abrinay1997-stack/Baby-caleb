import { describe, expect, it } from "vitest";

import {
  HOST,
  aTextoTilopay,
  consultarDetalle,
  credencialesTilopay,
  deTextoTilopay,
  estadoDeCodigo,
  leerVuelta,
  tilopay,
  type CredencialesTilopay,
} from "./tilopay";

/**
 * Las pruebas del adaptador de Tilopay.
 *
 * Sin red: el `fetch` se inyecta. Lo que se comprueba no es que Tilopay
 * funcione —eso lo prueba un cobro de verdad— sino que NOSOTROS mandemos lo
 * que su documentación pide y leamos lo que contesta sin inventarnos nada.
 *
 * Tres cosas de aquí pueden costar dinero si se rompen, y cada una tiene su
 * prueba con el nombre de lo que pasaría:
 *
 *  1. Un importe mal convertido cobra otra cantidad.
 *  2. Un estado mal leído da por pagado lo que no se pagó.
 *  3. Un token cacheado entre comercios cobra al comercio equivocado.
 */

const CRED: CredencialesTilopay = {
  modo: "prueba",
  apiuser: "usuario-de-api",
  password: "contrasena-de-api",
  key: "llave-de-integracion",
};

/** Un `fetch` de mentira que guarda lo que se le pidió. */
function espia(
  respuestas: ReadonlyArray<{ status?: number; cuerpo: unknown }>,
): {
  buscar: (url: string, init: RequestInit) => Promise<Response>;
  llamadas: Array<{ url: string; init: RequestInit; cuerpo: unknown }>;
} {
  const llamadas: Array<{ url: string; init: RequestInit; cuerpo: unknown }> = [];
  let i = 0;
  return {
    llamadas,
    buscar: async (url, init) => {
      const crudo = typeof init.body === "string" ? init.body : "";
      llamadas.push({
        url,
        init,
        cuerpo: crudo === "" ? null : (JSON.parse(crudo) as unknown),
      });
      const r = respuestas[Math.min(i, respuestas.length - 1)];
      i += 1;
      return new Response(JSON.stringify(r?.cuerpo ?? {}), {
        status: r?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

const LOGIN_OK = { cuerpo: { access_token: "token-de-24-horas" } };

// ---------------------------------------------------------------------------
describe("los importes", () => {
  it("convierte centavos a los dos decimales que espera Tilopay", () => {
    expect(aTextoTilopay(0)).toBe("0.00");
    expect(aTextoTilopay(5)).toBe("0.05");
    expect(aTextoTilopay(50)).toBe("0.50");
    expect(aTextoTilopay(1250)).toBe("12.50");
    expect(aTextoTilopay(100000)).toBe("1000.00");
    expect(aTextoTilopay(-1250)).toBe("-12.50");
  });

  /**
   * LA TRAMPA DE LA COMA FLOTANTE, con el número exacto que la dispara.
   *
   * `Number("12.50") * 100` da 1250.0000000000002 en coma flotante. Redondear
   * eso da 1250 y parece inofensivo; el problema es que invita a escribir
   * `Math.round(Number(t) * 100)` en todas partes, y hay importes donde ese
   * redondeo cae del lado malo. Por eso se parte el texto y no se multiplica.
   */
  it("no multiplica: 12.50 son 1250 centavos exactos, no 1250.0000000000002", () => {
    expect(Number("19.99") * 100).not.toBe(1999); // la trampa existe de verdad
    expect(deTextoTilopay("19.99")).toBe(1999); // y aquí no pica
    expect(deTextoTilopay("12.50")).toBe(1250);
    expect(deTextoTilopay("0.07")).toBe(7);
    expect(deTextoTilopay("1000.00")).toBe(100000);
    expect(deTextoTilopay("-12.50")).toBe(-1250);
  });

  it("acepta un decimal solo y un separador de miles", () => {
    expect(deTextoTilopay("12.5")).toBe(1250);
    expect(deTextoTilopay("1,250.00")).toBe(125000);
    expect(deTextoTilopay(" 12.50 ")).toBe(1250);
  });

  it("acepta un número y lo pasa por su texto", () => {
    expect(deTextoTilopay(12.5)).toBe(1250);
    expect(deTextoTilopay(0)).toBe(0);
  });

  /**
   * Devuelve `null`, NO `NaN` y NO un redondeo callado.
   *
   * Un importe que no se entiende tiene que PARAR la comparación. Si esto
   * devolviera `NaN`, cualquier `!==` contra nuestro monto daría «no coincide»
   * —que es el lado bueno— pero un `Math.abs(a-b) < 1` daría `false` y podría
   * leerse como «cuadra». Y si devolviera 0, un pago de cero cuadraría con un
   * pedido de cero. `null` no se puede comparar por error.
   */
  it("un importe que no se entiende da null, no NaN ni cero", () => {
    for (const malo of ["", "abc", "12.345", "1.2.3", "$12.50", "12,50", null, undefined, {}, []]) {
      expect(deTextoTilopay(malo), String(malo)).toBeNull();
    }
    expect(deTextoTilopay(Number.NaN)).toBeNull();
    expect(deTextoTilopay(Number.POSITIVE_INFINITY)).toBeNull();
  });

  /**
   * LA COMA DECIMAL NO SE ADIVINA. Esta prueba existe porque el bug estuvo.
   *
   * La primera versión hacía `.replace(/,/g, "")` —lo que uno escribe sin
   * pensar— y con eso `"12,50"` daba 125000 centavos: mil doscientos cincuenta
   * dólares en vez de doce con cincuenta. Y el error caía del lado caro: con
   * nuestro pedido en $1250.00 y la respuesta «12,50», los dos números
   * coincidían y se habría aprobado un pedido de mil doscientos cincuenta por
   * doce dólares.
   *
   * La coma solo pasa en grupos de tres. Lo ambiguo se rechaza.
   */
  it("12,50 no son 1250 dólares: un importe ambiguo se rechaza", () => {
    expect(deTextoTilopay("12,50")).toBeNull();
    expect(deTextoTilopay("1,25")).toBeNull();
    expect(deTextoTilopay("1,2345")).toBeNull();
    expect(deTextoTilopay("1,250,00")).toBeNull();
    // Y los grupos de tres de verdad siguen pasando.
    expect(deTextoTilopay("1,250.00")).toBe(125000);
    expect(deTextoTilopay("1,250,500.25")).toBe(125050025);
  });

  it("ida y vuelta, para cada centavo del primer dólar", () => {
    for (let c = 0; c <= 100; c += 1) {
      expect(deTextoTilopay(aTextoTilopay(c)), `${c}`).toBe(c);
    }
  });
});

// ---------------------------------------------------------------------------
describe("los estados", () => {
  it("solo el código 1 es un pago", () => {
    expect(estadoDeCodigo("1")).toBe("aprobado");
    expect(estadoDeCodigo(1)).toBe("aprobado");
    expect(estadoDeCodigo(" 1 ")).toBe("aprobado");
  });

  it("cualquier otro código es un rechazo", () => {
    for (const c of ["0", "2", "99", "declined"]) {
      expect(estadoDeCodigo(c), c).toBe("rechazado");
    }
  });

  /**
   * SIN CÓDIGO NO SE ADIVINA, y el lado al que se cae importa.
   *
   * «pendiente» deja el pago abierto y a la vista. Si esto cayera en
   * «rechazado», un pago que Tilopay sí cobró quedaría cerrado como fallido y
   * la clienta pagaría sin pedido. Si cayera en «aprobado», se entregaría sin
   * cobrar. Pendiente es el único que no pierde dinero de nadie.
   */
  it("sin código queda pendiente: ni aprobado ni rechazado", () => {
    expect(estadoDeCodigo(undefined)).toBe("pendiente");
    expect(estadoDeCodigo(null)).toBe("pendiente");
    expect(estadoDeCodigo("")).toBe("pendiente");
    expect(estadoDeCodigo("   ")).toBe("pendiente");
  });
});

// ---------------------------------------------------------------------------
describe("la vuelta del navegador", () => {
  it("lee los cuatro parámetros", () => {
    const v = leerVuelta("?code=1&order=BC-7&tpt=abc123&OrderHash=deadbeef");
    expect(v).toEqual({ code: "1", order: "BC-7", tpt: "abc123", OrderHash: "deadbeef" });
  });

  it("lo que no viene es null, no una cadena vacía", () => {
    const v = leerVuelta("?order=BC-7");
    expect(v.order).toBe("BC-7");
    expect(v.code).toBeNull();
    expect(v.OrderHash).toBeNull();
  });

  it("da igual que traiga la interrogación o no", () => {
    expect(leerVuelta("code=1").code).toBe("1");
    expect(leerVuelta("?code=1").code).toBe("1");
  });
});

// ---------------------------------------------------------------------------
describe("las credenciales", () => {
  it("las tres son obligatorias: con dos no se cobra", () => {
    const juegos: ReadonlyArray<readonly [string, ReadonlyMap<string, string>]> = [
      ["sin key", new Map([["apiuser", "u"], ["password", "p"]])],
      ["sin password", new Map([["apiuser", "u"], ["key", "k"]])],
      ["sin apiuser", new Map([["password", "p"], ["key", "k"]])],
      ["sin nada", new Map()],
    ];
    for (const [que, m] of juegos) {
      const r = credencialesTilopay("real", m);
      expect(r.ok, que).toBe(false);
    }
  });

  it("con las tres, salen con el modo puesto", () => {
    const r = credencialesTilopay(
      "real",
      new Map([["apiuser", "u"], ["password", "p"], ["key", "k"]]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos).toEqual({ modo: "real", apiuser: "u", password: "p", key: "k" });
    }
  });

  it("el aviso de que falta algo no filtra lo que sí hay", () => {
    const r = credencialesTilopay("real", new Map([["apiuser", "usuario-secreto"]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r)).not.toContain("usuario-secreto");
  });
});

// ---------------------------------------------------------------------------
describe("crear el cobro", () => {
  it("pide el token y después crea el pago, en ese orden", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { url: "https://app.tilopay.com/pagar/xyz", tpt: "T-9" } }]);
    const r = await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });

    expect(r.ok).toBe(true);
    expect(e.llamadas).toHaveLength(2);
    expect(e.llamadas[0]?.url).toBe(`${HOST}/api/v1/login`);
    expect(e.llamadas[1]?.url).toBe(`${HOST}/api/v1/processPayment`);
  });

  it("manda el importe en dólares con dos decimales, no en centavos", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { url: "https://app.tilopay.com/pagar/xyz" } }]);
    await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });

    const cuerpo = e.llamadas[1]?.cuerpo as Record<string, unknown>;
    expect(cuerpo.amount).toBe("12.50");
    // Mandar 1250 cobraría mil doscientos cincuenta dólares.
    expect(cuerpo.amount).not.toBe(1250);
    expect(cuerpo.amount).not.toBe("1250");
  });

  /** `key` va ADEMÁS del token: es obligatorio y se olvida fácil. */
  it("manda la llave de integración y el token, los dos", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { url: "https://app.tilopay.com/pagar/xyz" } }]);
    await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });

    const pago = e.llamadas[1];
    expect((pago?.cuerpo as Record<string, unknown>).key).toBe("llave-de-integracion");
    const cab = pago?.init.headers as Record<string, string>;
    expect(cab.authorization).toBe("bearer token-de-24-horas");
  });

  it("manda nuestro número de orden y la URL de vuelta", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { url: "https://app.tilopay.com/pagar/xyz" } }]);
    await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });

    const cuerpo = e.llamadas[1]?.cuerpo as Record<string, unknown>;
    expect(cuerpo.orderNumber).toBe("BC-7");
    expect(cuerpo.redirect).toBe("https://babycaleb.com/pago/vuelta");
    expect(cuerpo.currency).toBe("USD");
  });

  it("devuelve la URL de la página de pago, no datos de botón", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { url: "https://app.tilopay.com/pagar/xyz", tpt: "T-9" } }]);
    const r = await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });

    expect(r.ok).toBe(true);
    if (r.ok && r.datos.tipo === "creado") {
      expect(r.datos.redirectUrl).toBe("https://app.tilopay.com/pagar/xyz");
      expect(r.datos.referencia).toBe("T-9");
      expect(r.datos.datosBoton).toBeUndefined();
    }
  });

  /**
   * UN COBRO SIN URL NO ES UN COBRO.
   *
   * Si Tilopay contesta 200 pero sin página de pago, dar eso por bueno dejaría
   * a la clienta mirando una pantalla que no lleva a ningún sitio, con el pago
   * ya anotado como iniciado.
   */
  it("un 200 sin URL de pago es un fallo, no un éxito", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { message: "algo pasó" } }]);
    const r = await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });
    expect(r.ok).toBe(false);
  });

  /**
   * EL MENSAJE DE ERROR NO LLEVA CREDENCIALES.
   *
   * Una pasarela que rechaza una petición puede devolver en el cuerpo lo que
   * se le mandó. Si ese cuerpo se pega en el mensaje, la contraseña de API
   * acaba en una pantalla o en un registro.
   */
  it("el fallo del login no filtra la contraseña de API", async () => {
    const e = espia([
      { status: 401, cuerpo: { error: "bad credentials", sent: { password: "contrasena-de-api" } } },
    ]);
    const r = await tilopay(e.buscar).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });

    expect(r.ok).toBe(false);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain("contrasena-de-api");
    expect(texto).not.toContain("llave-de-integracion");
  });

  it("si la red se cae, falla con un mensaje para la clienta y no reventando", async () => {
    const r = await tilopay(async () => {
      throw new Error("ECONNRESET");
    }).createPayment(CRED, {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/Tilopay/i);
  });

  /**
   * EL TOKEN NO SE CACHEA ENTRE PETICIONES, y el porqué es de seguridad.
   *
   * En un Worker, una variable de módulo la comparten todas las peticiones que
   * caigan en esa instancia. Un token cacheado ahí es el secreto de UN comercio
   * en memoria compartida: el día que haya dos modos o dos cuentas, se serviría
   * el de la otra. Un login de más por cobro cuesta una petición.
   */
  it("cada cobro pide su propio token: no se reutiliza el del cobro anterior", async () => {
    const e = espia([LOGIN_OK, { cuerpo: { url: "https://app.tilopay.com/a" } }]);
    const t = tilopay(e.buscar);
    const orden = {
      ordenId: "BC-7",
      montoCents: 1250,
      urlAviso: "https://babycaleb.com/pago/vuelta",
    };
    await t.createPayment(CRED, orden);
    await t.createPayment(CRED, { ...orden, ordenId: "BC-8" });

    const logins = e.llamadas.filter((l) => l.url.endsWith("/login"));
    expect(logins).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
/**
 * LOS DATOS DE EJEMPLO DE AQUÍ SALEN DE SU OPENAPI, NO DE LA CABEZA.
 *
 * Esto estaba escrito contra una respuesta INVENTADA: un objeto plano con
 * `code` y `amount` arriba, a veces envuelto en `data`, `result` o
 * `transaction`. Tilopay no usa ninguno de esos tres nombres. Contesta
 * `{ type, message, response: [...] }` y `response` es un ARRAY
 * (`tilopay.com/developers/openapi.json`, `/api/v1/consult`, verificado
 * leyéndolo).
 *
 * Había incluso una casilla llamada «mira dentro de la respuesta si viene
 * envuelta» que recorría esos tres nombres y pasaba — porque probaba el código
 * contra la suposición del propio código. Es una variante de la trampa §6 que
 * conviene nombrar: **una prueba cuyo dato de entrada se adivinó vigila la
 * adivinanza, no a la pasarela.** La regla de «no se escribe código con
 * nombres adivinados» existía; faltaba para los datos de ejemplo.
 *
 * Con la respuesta de verdad delante, el adaptador anterior sacaba `code` y
 * `amount` en `undefined`: todo cobro habría quedado «pendiente» con monto
 * `null`, para siempre. No mordió porque nadie llama todavía a este módulo.
 */
const FILA = {
  id_tilopay: "T-9",
  orderNumber: "BC-7",
  amount: "12.50",
  currency: "USD",
  code: "1",
  auth: "123456",
  commission: "0.45",
  iva_commission: "0.03",
  cost: "0.40",
  cost_iva: "0.03",
  net_to_liquidate: "11.54",
  environment: "PROD",
};
/** La envoltura que Tilopay pone de verdad alrededor de las filas. */
const consulta = (...filas: Record<string, unknown>[]) => ({
  cuerpo: { type: "200", message: "ok", response: filas },
});

describe("la consulta, que es lo que aprueba", () => {
  it("lee la fila de dentro de `response`, que es un array", async () => {
    const e = espia([LOGIN_OK, consulta(FILA)]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.estado).toBe("aprobado");
      expect(r.datos.montoCents).toBe(1250);
      expect(r.datos.referencia).toBe("T-9");
    }
  });

  it("la comisión es lo que Tilopay SE QUEDA, no `commission + iva`", async () => {
    // Su fila trae seis deducciones. Sumando solo las dos primeras salen 48
    // centavos; lo que de verdad se queda son 12.50 − 11.54 = 96. Antes se
    // recogía la mitad y cada asiento de liquidación quedaba descuadrado.
    const e = espia([LOGIN_OK, consulta(FILA)]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.comisionCents).toBe(96);
  });

  it("y sin el neto se cae a las dos comisiones, nunca a cero", async () => {
    const { net_to_liquidate: _, ...sinNeto } = FILA;
    const e = espia([LOGIN_OK, consulta(sinNeto)]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.comisionCents).toBe(48);
  });

  it("dice EN QUÉ ENTORNO se cobró, que es lo único que delata el modo", async () => {
    // En Tilopay el modo de prueba se cambia desde SU portal, no desde la
    // integración: las credenciales son las mismas. Con la cuenta en Test, una
    // tarjeta de prueba devuelve `code: "1"` y marcaríamos pagado un pedido
    // por el que no entró un dólar. Este campo es la única forma de verlo.
    const e = espia([LOGIN_OK, consulta({ ...FILA, environment: "Test" })]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.entorno).toBe("Test");
  });

  it("con varios intentos manda el APROBADO, no el primero", async () => {
    // Una orden puede traer un rechazo y después el bueno. Quedarse con el
    // primero dejaría sin cobrar un pedido que sí se pagó.
    const rechazado = { ...FILA, code: "99", id_tilopay: "T-8", net_to_liquidate: "0.00" };
    const e = espia([LOGIN_OK, consulta(rechazado, FILA)]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.estado).toBe("aprobado");
      expect(r.datos.referencia).toBe("T-9");
    }
  });

  it("sin ninguna fila es PENDIENTE, no rechazado", async () => {
    // Ni una fila quiere decir «Tilopay no sabe de esa orden todavía». Darlo
    // por perdido cerraría un pago que puede estar en camino.
    const e = espia([LOGIN_OK, consulta()]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.estado).toBe("pendiente");
      expect(r.datos.montoCents).toBeNull();
    }
  });

  it("pregunta por NUESTRO número de orden, con la llave de integración", async () => {
    const e = espia([LOGIN_OK, consulta(FILA)]);
    await consultarDetalle(e.buscar, CRED, "BC-7");

    const c = e.llamadas[1];
    expect(c?.url).toBe(`${HOST}/api/v1/consult`);
    expect((c?.cuerpo as Record<string, unknown>).orderNumber).toBe("BC-7");
    expect((c?.cuerpo as Record<string, unknown>).key).toBe("llave-de-integracion");
  });

  /**
   * UN MONTO QUE NO SE ENTIENDE NO SE INVENTA.
   *
   * Lo que compara el monto es la capa de la base, y lo compara contra esto.
   * Si aquí saliera 0 en vez de `null`, un pedido de cero cuadraría; si saliera
   * `NaN`, según cómo se compare podría cuadrar también. `null` obliga a quien
   * compara a decidir qué hacer, y lo que hace es no aprobar.
   */
  it("sin monto legible, montoCents es null y no cero", async () => {
    const e = espia([LOGIN_OK, consulta({ code: "1" })]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.montoCents).toBeNull();
      expect(r.datos.montoCents).not.toBe(0);
    }
  });

  it("sin comisión reportada, comisionCents es null: no se calcula a ojo", async () => {
    const e = espia([LOGIN_OK, consulta({ code: "1", amount: "12.50" })]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.comisionCents).toBeNull();
  });

  it("un error de Tilopay en la consulta es un fallo, no un rechazo", async () => {
    const e = espia([LOGIN_OK, { status: 500, cuerpo: { error: "boom" } }]);
    const r = await consultarDetalle(e.buscar, CRED, "BC-7");
    // Importa que NO diga «rechazado»: un fallo de red no es una negativa del
    // banco, y tratarlo como tal cerraría un pago que quizá sí entró.
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("lo que este adaptador NO hace", () => {
  /**
   * Tilopay no tiene webhook en esta API, así que `verifyWebhook` no verifica
   * una firma: da por bueno lo que YA preguntó `consultarDetalle`. La vuelta
   * del navegador no entra por aquí — ni debe, porque el algoritmo del
   * `OrderHash` no es público y una URL sin verificar la escribe cualquiera.
   */
  it("verifyWebhook pasa el estado que trae la consulta del servidor", async () => {
    const r = await tilopay(espia([]).buscar).verifyWebhook(CRED, {
      estado: "aprobado",
      montoCents: 1250,
      referencia: "T-9",
      comisionCents: 96,
      entorno: "PROD",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.estado).toBe("aprobado");
  });

  it("el reembolso dice que se hace en el panel de Tilopay, y por qué no aquí", async () => {
    const r = await tilopay(espia([]).buscar).refundPayment(CRED, "T-9", 1250);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.mensaje).toMatch(/panel de Tilopay/i);
      // Que diga qué hacer, no solo que no puede.
      expect(r.mensaje).toMatch(/anota/i);
    }
  });
});
