import { fallo, ok, type Resultado } from "../contrato/resultado";
import { aTextoDeDinero, deTextoDeDinero } from "./importes";
import type { Modo } from "../dominio/pasarelas";
import type { AvisoVerificado, Buscador, CobroCreado, OrdenDeCobro, PaymentProvider } from "./proveedor";

/**
 * Tilopay · tarjetas y cuotas: el adaptador (04-pagos §4.2, F4.12).
 *
 * Es la única vía para cobrar Visa, Mastercard y American Express: el Botón de
 * Pago de Yappy no cobra tarjeta. Por Yappy se cobra directo —sin el 1 % que
 * Tilopay añade encima de la comisión de Yappy—, y por aquí se cobran las
 * tarjetas, que es lo que Yappy no hace.
 *
 * ## LA DECISIÓN QUE MANDA: la verdad es la consulta
 *
 * Tilopay no tiene webhook en esta API. Lo que hay es una vuelta por GET a
 * nuestra página con `code`, `order`, `tpt` y `OrderHash`, y el algoritmo del
 * `OrderHash` **no es público** (se pide a su soporte). O sea que lo que vuelve
 * en la URL no se puede verificar, y una URL que no se puede verificar la
 * escribe cualquiera: `?code=1&order=BC-7` en la barra de direcciones sería un
 * pedido pagado que nadie pagó.
 *
 * Así que la vuelta del navegador NO aprueba nada. Solo dice «ya volvió, mira
 * a ver». Quien aprueba es `consultar()`, que le pregunta al servidor de
 * Tilopay cómo quedó esa orden **y por cuánto**, y compara el monto con el
 * nuestro. Es la regla del `CLAUDE.md` —«el navegador no decide un pago»— y
 * aquí no es una precaución de más: es la única defensa que hay.
 *
 * Por eso `verifyWebhook` no acepta la vuelta del navegador. Recibe lo que
 * contestó el servidor.
 *
 * ## Puro: sin D1 y sin `env`
 *
 * Recibe las credenciales ya abiertas del baúl y un `fetch`. Se prueba con
 * respuestas grabadas, sin red.
 */

/**
 * Un solo host, también para probar.
 *
 * Tilopay no tiene servidor de caja de arena aparte: el modo de prueba se
 * cambia desde la cuenta del comercio (04-pagos §4.2, «entornos»). Aun así el
 * `modo` viaja hasta aquí, porque las CREDENCIALES sí son distintas por modo y
 * el baúl entrega las del modo en que está la pasarela.
 */
export const HOST = "https://app.tilopay.com";

/** Cuánto dura el token de `login`, según su documentación. */
export const HORAS_TOKEN = 24;

// ---------------------------------------------------------------------------
// Las credenciales, como las entrega el baúl
// ---------------------------------------------------------------------------

/**
 * Los nombres son LOS DE SU API, letra por letra.
 *
 * Es a propósito y ya está decidido en `dominio/pasarelas.ts`: el adaptador los
 * manda tal cual en el cuerpo de la petición, así que no hay capa de
 * traducción donde equivocarse.
 */
export interface CredencialesTilopay {
  readonly modo: Modo;
  readonly apiuser: string;
  readonly password: string;
  /** `key` NO es opcional: es parámetro obligatorio de processPayment y de consult. */
  readonly key: string;
}

export function credencialesTilopay(
  modo: Modo,
  valores: ReadonlyMap<string, string>,
): Resultado<CredencialesTilopay> {
  const apiuser = valores.get("apiuser");
  const password = valores.get("password");
  const key = valores.get("key");
  if (apiuser === undefined || password === undefined || key === undefined) {
    return fallo(
      "pasarela_no_disponible",
      "A Tilopay le falta una credencial (usuario de API, contraseña de API o llave de integración). Revíselas en Pasarelas.",
    );
  }
  return ok({ modo, apiuser, password, key });
}

// ---------------------------------------------------------------------------
// Los importes
// ---------------------------------------------------------------------------

/**
 * Los importes, del módulo común.
 *
 * Se re-exportan con el nombre que ya usaban las pruebas de este adaptador.
 * La implementación vive en `importes.ts` porque Yappy pide exactamente lo
 * mismo, y porque esta conversión ya tuvo un fallo que costaba dinero: dos
 * copias son dos sitios donde el arreglo puede aplicarse a una y no a la otra.
 */
export const aTextoTilopay = aTextoDeDinero;
export const deTextoTilopay = deTextoDeDinero;

// ---------------------------------------------------------------------------
// Los estados
// ---------------------------------------------------------------------------

/**
 * Cómo puede terminar un cobro de Tilopay, en NUESTRAS palabras.
 *
 * Tilopay contesta `code = "1"` para aprobado y otro código para lo demás
 * (04-pagos §4.2). Se traduce aquí, una vez, y lo de dentro habla de estos
 * tres y no de códigos sueltos.
 */
export type EstadoTilopay = "aprobado" | "rechazado" | "pendiente";

export const FINALES: Record<EstadoTilopay, { titulo: string; clienta: string }> = {
  aprobado: {
    titulo: "Aprobado",
    clienta: "Tu pago salió bien. Ya quedó registrado en tu pedido.",
  },
  rechazado: {
    titulo: "Rechazado",
    clienta:
      "El banco no autorizó el pago. No se te cobró nada: puedes intentarlo otra vez o con otra tarjeta.",
  },
  pendiente: {
    titulo: "Pendiente",
    clienta: "Estamos confirmando tu pago con el banco. Te avisamos en cuanto quede listo.",
  },
};

/** El código que Tilopay llama «aprobado». */
const CODIGO_APROBADO = "1";

export function estadoDeCodigo(code: unknown): EstadoTilopay {
  const c = String(code ?? "").trim();
  if (c === CODIGO_APROBADO) return "aprobado";
  // Sin código no se adivina: «pendiente» deja el pago abierto y a la vista
  // en vez de darlo por perdido o por bueno.
  return c === "" ? "pendiente" : "rechazado";
}

// ---------------------------------------------------------------------------
// Lo que vuelve por el navegador, y lo que contesta el servidor
// ---------------------------------------------------------------------------

/**
 * La vuelta del navegador. **No prueba nada.**
 *
 * Se lee para saber QUÉ orden mirar, y nada más. `OrderHash` se recoge porque
 * algún día se podrá verificar —el algoritmo se le pidió a su soporte— pero
 * hoy no se usa para decidir, y eso está escrito aquí para que nadie lo
 * enchufe «porque ya viene en la URL».
 */
export interface VueltaDeTilopay {
  readonly code: string | null;
  readonly order: string | null;
  readonly tpt: string | null;
  readonly OrderHash: string | null;
}

export function leerVuelta(consulta: string): VueltaDeTilopay {
  const q = new URLSearchParams(consulta.startsWith("?") ? consulta.slice(1) : consulta);
  return {
    code: q.get("code"),
    order: q.get("order"),
    tpt: q.get("tpt"),
    OrderHash: q.get("OrderHash"),
  };
}

/** Lo que `consultar` averigua del servidor: el estado Y el monto. */
export interface ConsultaDeTilopay {
  readonly estado: EstadoTilopay;
  /** Lo que Tilopay dice que se cobró. `null` si no lo dijo. */
  readonly montoCents: number | null;
  readonly referencia: string | null;
  /** La comisión que Tilopay reporta, para el asiento de liquidación. */
  readonly comisionCents: number | null;
  /**
   * EN QUÉ ENTORNO SE COBRÓ, según el propio Tilopay: «Test» o «PROD».
   *
   * No es un dato de adorno y no se puede deducir de nuestro lado. En Tilopay
   * el modo de prueba **se cambia desde su portal, no desde la integración**:
   * las credenciales son las mismas y no hay parámetro, cabecera ni dirección
   * distinta que lo cambie. O sea que nuestro interruptor de «modo» en el
   * panel NO decide si Tilopay cobra de verdad.
   *
   * La consecuencia cara, y la avisa su propia documentación: con la cuenta en
   * Test, una tarjeta de prueba devuelve `code: "1"` —aprobada— y marcaríamos
   * el pedido pagado sin que entre un dólar. Este campo es la única forma de
   * darse cuenta, así que viaja hasta arriba y quien confirme un cobro tiene
   * que mirarlo.
   */
  readonly entorno: string | null;
}

// ---------------------------------------------------------------------------
// El adaptador
// ---------------------------------------------------------------------------

interface RespuestaLogin {
  readonly access_token?: unknown;
  readonly token?: unknown;
}

function comoTexto(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Saca el primer campo que exista de un objeto, probando varios nombres. */
function primero(o: Record<string, unknown>, ...claves: readonly string[]): unknown {
  for (const k of claves) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

async function leerJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    const j: unknown = await r.json();
    return j !== null && typeof j === "object" && !Array.isArray(j)
      ? (j as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function tilopay(buscar: Buscador = fetch): PaymentProvider<
  CredencialesTilopay,
  ConsultaDeTilopay,
  EstadoTilopay
> {
  /**
   * El token de `POST /api/v1/login`, que vale 24 h.
   *
   * NO se cachea entre peticiones a propósito. En un Worker, una variable de
   * módulo vive lo que viva esa instancia y la comparten todas las peticiones
   * que caigan en ella: un token cacheado ahí es un secreto de UN comercio
   * guardado en memoria compartida, y el día que haya dos modos o dos cuentas
   * se serviría el de la otra. Un login de más por cobro cuesta una petición;
   * el fallo contrario cuesta un cobro al comercio equivocado.
   */
  async function token(cred: CredencialesTilopay): Promise<Resultado<string>> {
    let r: Response;
    try {
      r = await buscar(`${HOST}/api/v1/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Su propia documentación avisa de que `apiuser` y `password` NO deben
        // llegar al navegador. Por eso esto corre en el servidor y nada más.
        body: JSON.stringify({ apiuser: cred.apiuser, password: cred.password }),
      });
    } catch {
      return fallo("pasarela_no_disponible", "No se pudo hablar con Tilopay. Intenta en un momento.");
    }

    const j = await leerJson(r);
    if (!r.ok || j === null) {
      // El cuerpo NO se incluye en el mensaje: una respuesta de error de una
      // pasarela puede traer de vuelta lo que se le mandó, credenciales
      // incluidas, y ese mensaje acaba en una pantalla o en un registro.
      return fallo(
        "pasarela_no_disponible",
        r.status === 401 || r.status === 403
          ? "Tilopay no aceptó el usuario y la contraseña de API. Revíselos en Pasarelas."
          : "Tilopay no contestó bien al iniciar sesión.",
      );
    }

    const t = comoTexto(primero(j as RespuestaLogin as Record<string, unknown>, "access_token", "token"));
    if (t === null) return fallo("pasarela_no_disponible", "Tilopay no devolvió el token de acceso.");
    return ok(t);
  }

  return {
    /**
     * Crea el cobro y devuelve la URL de la página de pago de Tilopay.
     *
     * No es un «botón» como el de Yappy: la clienta se va a la página de
     * Tilopay, paga allí y vuelve. Por eso esto devuelve `redirectUrl` y no
     * `datosBoton` — las dos formas ya estaban previstas en `CobroCreado`.
     */
    async createPayment(cred, orden: OrdenDeCobro): Promise<Resultado<CobroCreado>> {
      const t = await token(cred);
      if (!t.ok) return t;

      let r: Response;
      try {
        r = await buscar(`${HOST}/api/v1/processPayment`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `bearer ${t.datos}`,
          },
          body: JSON.stringify({
            // `key` va ADEMÁS del token: es obligatorio aquí y en `consult`,
            // así que con dos de las tres credenciales no se cobra.
            key: cred.key,
            amount: aTextoTilopay(orden.montoCents),
            currency: "USD",
            orderNumber: orden.ordenId,
            // A dónde vuelve la clienta. Tilopay no manda webhook: esta URL es
            // la señal de «ya terminó», y lo que decide es la consulta.
            redirect: orden.urlAviso,
            capture: 1,
          }),
        });
      } catch {
        return fallo("pasarela_no_disponible", "No se pudo hablar con Tilopay. Intenta en un momento.");
      }

      const j = await leerJson(r);
      if (j === null) {
        return fallo("pasarela_no_disponible", "Tilopay contestó algo que no se entiende.");
      }

      const url = comoTexto(primero(j, "url", "urlPayment", "payment_url", "processUrl"));
      if (!r.ok || url === null) {
        const dice = comoTexto(primero(j, "message", "description", "error"));
        return fallo(
          "pasarela_no_disponible",
          dice === null
            ? "Tilopay no pudo crear el cobro."
            : `Tilopay no pudo crear el cobro: ${dice}`,
          // El código se guarda aparte para la bitácora, igual que con Yappy:
          // así `src/db/` puede distinguir «la pasarela dijo que no» —que
          // cierra el pago— de un silencio, que no.
          { codigo_tilopay: comoTexto(primero(j, "code", "status")) ?? "sin_codigo" },
        );
      }

      return ok({
        tipo: "creado",
        referencia: comoTexto(primero(j, "tpt", "transaction", "id")) ?? orden.ordenId,
        redirectUrl: url,
      });
    },

    /**
     * Da por bueno lo que YA preguntó `consultar`.
     *
     * Se llama `verifyWebhook` por la interfaz común, pero aquí no hay webhook
     * que verificar: lo que entra es la respuesta del servidor de Tilopay, que
     * es la única fuente que vale. La vuelta del navegador no llega hasta aquí
     * — ni debe.
     */
    async verifyWebhook(_cred, consulta: ConsultaDeTilopay): Promise<Resultado<AvisoVerificado<EstadoTilopay>>> {
      return ok({
        ordenId: "",
        estado: consulta.estado,
        eventoId: "",
        referencia: consulta.referencia,
      });
    },

    /**
     * Le pregunta a Tilopay cómo quedó una orden. ESTO es lo que aprueba.
     *
     * Devuelve el estado por la interfaz común; el monto y la comisión salen
     * por `consultarDetalle`, que es lo que usa la base para comparar. Se
     * parten porque la interfaz es común a las tres pasarelas y el monto solo
     * lo devuelve ésta.
     */
    async consultar(cred, ordenId: string): Promise<Resultado<{ estado: EstadoTilopay }>> {
      const d = await consultarDetalle(buscar, cred, ordenId);
      return d.ok ? ok({ estado: d.datos.estado }) : d;
    },

    /**
     * No se implementa, y se dice por qué.
     *
     * La documentación de la página de pago alojada no trae devolución, y la
     * vía servidor a servidor —que sí la tiene— exige certificación PCI del
     * comercio, que Baby Caleb no tiene (04-pagos §4.2). Un reembolso se hace
     * hoy desde el panel de Tilopay, a mano, y se anota en el sistema.
     */
    async refundPayment(): Promise<Resultado<never>> {
      return fallo(
        "pasarela_no_disponible",
        "Tilopay no devuelve dinero por esta API: el reembolso se hace en el panel de Tilopay y después se anota aquí.",
      );
    },
  };
}

/**
 * La consulta, con el monto y la comisión.
 *
 * Aparte del `PaymentProvider` porque devuelve más de lo que la interfaz común
 * promete, y lo que devuelve de más es justo lo que hace seguro el cobro: el
 * MONTO. Sin comparar el monto, una orden aprobada por un dólar aprobaría un
 * pedido de cincuenta.
 */
export async function consultarDetalle(
  buscar: Buscador,
  cred: CredencialesTilopay,
  ordenId: string,
): Promise<Resultado<ConsultaDeTilopay>> {
  const t = await (async (): Promise<Resultado<string>> => {
    try {
      const r = await buscar(`${HOST}/api/v1/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiuser: cred.apiuser, password: cred.password }),
      });
      const j = await leerJson(r);
      if (!r.ok || j === null) {
        return fallo("pasarela_no_disponible", "Tilopay no contestó bien al iniciar sesión.");
      }
      const tok = comoTexto(primero(j, "access_token", "token"));
      return tok === null
        ? fallo("pasarela_no_disponible", "Tilopay no devolvió el token de acceso.")
        : ok(tok);
    } catch {
      return fallo("pasarela_no_disponible", "No se pudo hablar con Tilopay.");
    }
  })();
  if (!t.ok) return t;

  let r: Response;
  try {
    r = await buscar(`${HOST}/api/v1/consult`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `bearer ${t.datos}` },
      body: JSON.stringify({ key: cred.key, orderNumber: ordenId }),
    });
  } catch {
    return fallo("pasarela_no_disponible", "No se pudo preguntarle a Tilopay por ese cobro.");
  }

  const j = await leerJson(r);
  if (!r.ok || j === null) {
    return fallo("pasarela_no_disponible", "Tilopay no contestó bien a la consulta del cobro.");
  }

  /**
   * `consult` contesta `{ type, message, response: [...] }`, y **`response` es
   * un ARRAY**. Está en su OpenAPI (`tilopay.com/developers/openapi.json`,
   * `/api/v1/consult`), comprobado leyéndolo, no de memoria.
   *
   * Aquí decía otra cosa: buscaba la envoltura en `data`, `result` o
   * `transaction` —tres nombres que Tilopay no usa— y encima **descartaba los
   * arrays a propósito** (`!Array.isArray`), que es justo la forma que tiene
   * la buena. Con la respuesta real delante, `code` y `amount` salían
   * `undefined`: todo cobro habría quedado «pendiente» con monto `null`, para
   * siempre, y el pedido en «confirmando» sin que nada fallara.
   *
   * No mordió porque este adaptador todavía no lo llama nadie. Habría mordido
   * el día de enchufarlo, que es la peor fecha posible.
   */
  const filas = Array.isArray(j.response) ? (j.response as unknown[]) : [];
  if (filas.length === 0) {
    // Ni una fila no es «rechazado»: es «Tilopay no sabe de esa orden todavía».
    // Darlo por perdido aquí cerraría un pago que puede estar en camino.
    return ok({
      estado: "pendiente" as EstadoTilopay,
      montoCents: null,
      referencia: null,
      comisionCents: null,
      entorno: null,
    });
  }

  /**
   * Una orden puede traer VARIAS filas: un intento rechazado y luego el bueno.
   * Manda la aprobada; si no hay ninguna, la última que contestaron.
   *
   * Quedarse con la primera sería leer el rechazo de hace diez minutos y dejar
   * sin cobrar un pedido que sí se pagó.
   */
  const comoFila = (x: unknown): Record<string, unknown> =>
    x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const cuerpo = comoFila(
    filas.find((f) => estadoDeCodigo(comoFila(f).code) === "aprobado") ?? filas[filas.length - 1],
  );

  const monto = deTextoTilopay(cuerpo.amount);
  const neto = deTextoTilopay(cuerpo.net_to_liquidate);
  const comision = deTextoTilopay(cuerpo.commission);
  const ivaComision = deTextoTilopay(cuerpo.iva_commission);

  return ok({
    estado: estadoDeCodigo(cuerpo.code),
    montoCents: monto,
    referencia: comoTexto(primero(cuerpo, "id_tilopay", "auth")),
    /**
     * LO QUE TILOPAY SE QUEDA DE VERDAD, que no es `commission + iva`.
     *
     * Su fila trae SEIS deducciones —`commission`, `iva_commission`,
     * `retention_iva`, `retention_rent`, `cost`, `cost_iva`— y antes solo se
     * sumaban las dos primeras. Con los números de su propio ejemplo eso
     * recoge una fracción del costo real, y cada asiento de liquidación
     * quedaría descuadrado por la diferencia.
     *
     * Así que se usa la resta: lo que se cobró menos lo que nos liquidan. No
     * depende de que mañana añadan una séptima retención, y no depende de que
     * `retention_iva` y `retention_rent` —que son costarricenses— apliquen en
     * Panamá, que es cosa que nadie nos ha confirmado.
     *
     * Si falta alguno de los dos números, se cae a la suma de las dos
     * comisiones; y si tampoco están, `null`. Nunca cero: cero es afirmar que
     * Tilopay no cobró nada, y eso es una cifra inventada.
     */
    comisionCents:
      monto !== null && neto !== null
        ? monto - neto
        : comision === null
          ? null
          : comision + (ivaComision ?? 0),
    entorno: comoTexto(cuerpo.environment),
  });
}
