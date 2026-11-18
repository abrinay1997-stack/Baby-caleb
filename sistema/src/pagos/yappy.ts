import { fallo, ok, type Resultado } from "../contrato/resultado";
import type { Modo } from "../dominio/pasarelas";
import { igualesSinAtajo } from "../seguridad/comparar";
import { aTextoDeDinero } from "./importes";
import type { AvisoVerificado, Buscador, CobroCreado, OrdenDeCobro, PaymentProvider } from "./proveedor";

/**
 * Yappy · Botón de Pago: el adaptador (04-pagos §4.1).
 *
 * Todo lo de aquí sale de `docs/YAPPY-BOTON.md`, que es la página oficial
 * transcrita. El plan lo exigía con todas las letras: «no se escribe código con
 * nombres adivinados». Lo que no está en ese documento, no está aquí.
 *
 * ## Lo que hace confiable un pago de Yappy: el hash
 *
 * La notificación (IPN) es un **GET abierto** que cualquiera puede llamar
 * escribiendo una URL. Lo único que la hace confiable es el hash firmado con la
 * clave secreta del comercio. Sin verificarlo, cualquiera marca pedidos como
 * pagados desde la barra de direcciones — y no hace falta saber nada del
 * sistema, solo el número de un pedido.
 *
 * ## Puro: sin D1 y sin `env`
 *
 * Recibe las credenciales ya abiertas del baúl y un `fetch`. Se prueba con
 * respuestas grabadas y con los vectores del ejemplo oficial, sin red.
 */

/**
 * Los dos entornos. API distinta, no solo credenciales distintas.
 *
 * A diferencia de Tilopay —que no tiene servidor de pruebas y cambia el modo
 * dentro de la cuenta del comercio—, Yappy sí tiene un host aparte. Eso es lo
 * que permite probar el cobro de punta a punta sin mover un centavo.
 */
export const HOST: Record<Modo, string> = {
  real: "https://apipagosbg.bgeneral.cloud",
  prueba: "https://api-comecom-uat.yappycloud.com",
};

/** El componente del navegador, que también cambia por entorno. */
export const CDN: Record<Modo, string> = {
  real: "https://bt-cdn.yappy.cloud/v1/cdn/web-component-btn-yappy.js",
  prueba: "https://bt-cdn-uat.yappycloud.com/v1/cdn/web-component-btn-yappy.js",
};

// ---------------------------------------------------------------------------
// Las credenciales
// ---------------------------------------------------------------------------

export interface CredencialesYappy {
  readonly modo: Modo;
  /** `id_comercio` en el baúl. */
  readonly merchantId: string;
  /** `clave_secreta` en el baúl. Viene en base64. */
  readonly secretKey: string;
  /**
   * EL DOMINIO NO ES UNA CREDENCIAL, y por eso está aparte.
   *
   * Yappy solo guarda dos secretos: ID de comercio y clave secreta. El dominio
   * es el que la dueña declaró al crear el botón, y lo pone el sitio — no el
   * baúl. Viaja en cada llamada (`urlDomain` / `domain`) y **entra en el hash
   * de la notificación**, así que si el que mandamos no es exactamente el que
   * ella declaró, las firmas no cuadran y ningún pago se puede verificar.
   *
   * Tenerlo en el tipo obliga a quien llama a decidirlo a conciencia, en vez
   * de que alguien lo deduzca del `Host` de una petición —que lo controla
   * quien la manda— o lo deje en una constante que nadie vuelve a mirar.
   */
  readonly domain: string;
}

export function credencialesYappy(
  modo: Modo,
  valores: ReadonlyMap<string, string>,
  domain: string,
): Resultado<CredencialesYappy> {
  const merchantId = valores.get("id_comercio");
  const secretKey = valores.get("clave_secreta");
  if (merchantId === undefined || secretKey === undefined) {
    return fallo(
      "pasarela_no_disponible",
      "A Yappy le falta el ID de comercio o la clave secreta. Revíselos en Pasarelas.",
    );
  }
  if (domain.trim() === "") {
    return fallo(
      "pasarela_no_disponible",
      "Falta el dominio con el que está dado de alta el Botón de Pago de Yappy.",
    );
  }
  return { ok: true, datos: { modo, merchantId, secretKey, domain: domain.trim() } };
}

// ---------------------------------------------------------------------------
// El número de orden: 1 a 15 caracteres ALFANUMÉRICOS
// ---------------------------------------------------------------------------

/**
 * El límite de Yappy para `orderId`, copiado de su tabla de campos.
 *
 * Es la restricción más fácil de pasar por alto y la que rompe en producción y
 * no en desarrollo: nuestras referencias internas son ULID de 26 caracteres con
 * guiones, y no caben ni son alfanuméricas. Si se manda una, Yappy la rechaza
 * con un error que no dice que el problema sea el largo.
 */
export const LARGO_MAXIMO_ORDEN = 15;
const SOLO_ALFANUMERICO = /^[A-Za-z0-9]{1,15}$/;

export const ordenValida = (orderId: string): boolean => SOLO_ALFANUMERICO.test(orderId);

/**
 * Una referencia que Yappy acepta, a partir del número del pedido.
 *
 * Lleva el número del pedido DELANTE —es lo que la dueña ve en su panel de
 * Yappy, y sin eso tendría que venir al sistema a averiguar de qué pedido es
 * cada cobro— y un sufijo al azar detrás, que es lo que la hace única: un
 * reintento del mismo pedido no puede chocar con el intento anterior, porque
 * `pagos.intento_ref` es UNIQUE y un choque abortaría el cobro.
 *
 * Todo en mayúsculas y sin guiones, que es lo que cabe en «alfanumérico».
 */
export function referenciaParaYappy(numeroDePedido: string, azar = crypto): string {
  const base = numeroDePedido.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const bytes = azar.getRandomValues(new Uint8Array(8));
  const sufijo = [...bytes]
    .map((b) => b.toString(36).toUpperCase())
    .join("")
    .slice(0, 6);
  // El pedido manda: si es largo, lo que se recorta es el pedido y NO el
  // sufijo, porque recortar el sufijo es perder la unicidad.
  return `${base.slice(0, LARGO_MAXIMO_ORDEN - sufijo.length)}${sufijo}`;
}

// ---------------------------------------------------------------------------
// Los estados del IPN
// ---------------------------------------------------------------------------

/**
 * Los cuatro finales de Yappy. **Solo `E` es un pago.**
 *
 * Los otros tres son cosas distintas y la clienta merece un mensaje distinto en
 * cada uno: «no confirmaste a tiempo» no es lo mismo que «lo cancelaste» ni que
 * «nunca lo empezaste». Un «falló el pago» genérico la deja sin saber si volver
 * a intentarlo o llamar al banco.
 */
export type EstadoYappy = "ejecutado" | "rechazado" | "cancelado" | "expirado";

const DEL_IPN: Readonly<Record<string, EstadoYappy>> = {
  E: "ejecutado",
  R: "rechazado",
  C: "cancelado",
  X: "expirado",
};

export const COMO_SE_LE_DICE: Record<EstadoYappy, string> = {
  ejecutado: "Tu pago salió bien. Ya quedó registrado en tu pedido.",
  rechazado:
    "El pago no se confirmó a tiempo: la solicitud de Yappy dura cinco minutos. Puedes volver a intentarlo.",
  cancelado: "Cancelaste el pago en la app de Yappy. Tu pedido sigue ahí si quieres intentarlo otra vez.",
  expirado: "La solicitud de pago venció sin empezarse. Puedes generar una nueva.",
};

export const estadoDeLetra = (letra: string): EstadoYappy | null =>
  DEL_IPN[letra.trim().toUpperCase()] ?? null;

// ---------------------------------------------------------------------------
// El hash del IPN
// ---------------------------------------------------------------------------

/**
 * La firma que Yappy manda en la notificación.
 *
 * Del ejemplo oficial en Node.js de su página, y son cuatro detalles que se
 * pueden equivocar por separado:
 *
 *   1. La clave secreta **viene en base64**: primero se decodifica a texto.
 *   2. Ese texto **se parte por el punto** y se usa **solo el primer trozo**.
 *   3. Se firma `orderId + status + domain` concatenado, **sin separadores** y
 *      **en ese orden**.
 *   4. HMAC-SHA256 en **hexadecimal minúsculas**.
 *
 * El ejemplo de .NET de la misma página hace lo mismo, lo que confirma la
 * lectura. `status` es la LETRA (E, R, C, X), no nuestra palabra: lo que se
 * firma es lo que Yappy mandó.
 */
export async function firmaDelIpn(
  claveSecreta: string,
  orderId: string,
  letraEstado: string,
  domain: string,
): Promise<string> {
  const texto = atob(claveSecreta);
  const primerTrozo = texto.split(".")[0] ?? "";

  const clave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(primerTrozo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await crypto.subtle.sign(
    "HMAC",
    clave,
    new TextEncoder().encode(`${orderId}${letraEstado}${domain}`),
  );
  return [...new Uint8Array(firma)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lo que llega por la URL del IPN. Nada de esto es de fiar hasta verificarlo. */
export interface AvisoDeYappy {
  readonly orderId: string;
  readonly status: string;
  readonly domain: string;
  readonly hash: string;
  readonly confirmationNumber?: string | undefined;
}

export function leerAviso(consulta: string): AvisoDeYappy {
  const q = new URLSearchParams(consulta.startsWith("?") ? consulta.slice(1) : consulta);
  const conf = q.get("confirmationNumber");
  return {
    orderId: q.get("orderId") ?? "",
    status: q.get("status") ?? "",
    domain: q.get("domain") ?? "",
    hash: q.get("hash") ?? "",
    ...(conf === null ? {} : { confirmationNumber: conf }),
  };
}

// ---------------------------------------------------------------------------
// El adaptador
// ---------------------------------------------------------------------------

function comoTexto(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
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

/** Lo que hace falta además de la orden, y que solo sabe quien cobra. */
export interface ExtrasDeYappy {
  /**
   * El teléfono panameño de la clienta, sin prefijo.
   *
   * Yappy lo exige (`aliasYappy`). En el entorno de pruebas tiene que ser un
   * número dado de alta en su programa de pruebas: con cualquier otro, la orden
   * se crea y el pago nunca llega a ningún teléfono.
   */
  readonly aliasYappy: string;
}

export function yappy(
  extras: ExtrasDeYappy,
  buscar: Buscador = fetch,
): PaymentProvider<CredencialesYappy, AvisoDeYappy, EstadoYappy> {
  /**
   * Paso 1 · Validar el comercio y conseguir el token de sesión.
   *
   * Su página lo subraya: «se deben hacer los llamados de estas API's dentro de
   * su backend». La clave secreta no puede llegar al navegador, así que esto
   * corre en el Worker y nada más.
   */
  async function token(cred: CredencialesYappy): Promise<Resultado<string>> {
    let r: Response;
    try {
      r = await buscar(`${HOST[cred.modo]}/payments/validate/merchant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId: cred.merchantId, urlDomain: cred.domain }),
      });
    } catch {
      return fallo("pasarela_no_disponible", "No se pudo hablar con Yappy. Intenta en un momento.");
    }

    const j = await leerJson(r);
    if (j === null) return fallo("pasarela_no_disponible", "Yappy contestó algo que no se entiende.");

    const cuerpo = (j.body ?? {}) as Record<string, unknown>;
    const t = comoTexto(cuerpo.token);
    if (!r.ok || t === null) {
      // El cuerpo NO se incluye en el mensaje: una respuesta de error puede
      // devolver lo que se le mandó, el ID de comercio incluido, y ese mensaje
      // acaba en una pantalla o en un registro.
      const estado = (j.status ?? {}) as Record<string, unknown>;
      const dice = comoTexto(estado.description);
      return fallo(
        "pasarela_no_disponible",
        dice === null
          ? "Yappy no validó el comercio. Revise el ID de comercio y el dominio en Pasarelas."
          : `Yappy no validó el comercio: ${dice}`,
      );
    }
    return ok(t);
  }

  return {
    /**
     * Paso 2 · Crear la orden.
     *
     * Devuelve `datosBoton` y no `redirectUrl`: Yappy no manda a la clienta a
     * otra página — el componente del navegador abre el modal con estos tres
     * valores. Ninguno de los tres es un secreto; la clave secreta se queda
     * aquí.
     */
    async createPayment(cred, orden: OrdenDeCobro): Promise<Resultado<CobroCreado>> {
      if (!ordenValida(orden.ordenId)) {
        return fallo(
          "entrada_invalida",
          `Yappy solo acepta un número de orden alfanumérico de 1 a ${LARGO_MAXIMO_ORDEN} caracteres, y «${orden.ordenId}» no lo es.`,
        );
      }
      if (orden.montoCents < 1) {
        // Su tabla dice: total mínimo «0.01».
        return fallo("entrada_invalida", "Yappy no cobra menos de un centavo.");
      }

      const t = await token(cred);
      if (!t.ok) return t;

      const total = aTextoDeDinero(orden.montoCents);

      let r: Response;
      try {
        r = await buscar(`${HOST[cred.modo]}/payments/payment-wc`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: t.datos },
          body: JSON.stringify({
            merchantId: cred.merchantId,
            orderId: orden.ordenId,
            domain: cred.domain,
            paymentDate: Math.floor(Date.now() / 1000),
            aliasYappy: extras.aliasYappy,
            ipnUrl: orden.urlAviso,
            discount: "0.00",
            taxes: "0.00",
            // El subtotal es el total: el envío y el descuento ya están dentro
            // del total del pedido, y repartirlos aquí sería inventarse un
            // desglose que ninguna de las dos partes usa para nada.
            subtotal: total,
            total,
          }),
        });
      } catch {
        return fallo("pasarela_no_disponible", "No se pudo hablar con Yappy. Intenta en un momento.");
      }

      const j = await leerJson(r);
      if (j === null) return fallo("pasarela_no_disponible", "Yappy contestó algo que no se entiende.");

      const cuerpo = (j.body ?? {}) as Record<string, unknown>;
      const transactionId = comoTexto(cuerpo.transactionId);
      const tokenBoton = comoTexto(cuerpo.token);
      const documentName = comoTexto(cuerpo.documentName);

      if (!r.ok || transactionId === null || tokenBoton === null || documentName === null) {
        const estado = (j.status ?? {}) as Record<string, unknown>;
        const dice = comoTexto(estado.description);
        return fallo(
          "pasarela_no_disponible",
          dice === null ? "Yappy no pudo crear la orden." : `Yappy no pudo crear la orden: ${dice}`,
        );
      }

      return ok({
        tipo: "creado",
        referencia: transactionId,
        datosBoton: { transactionId, token: tokenBoton, documentName },
      });
    },

    /**
     * Verificar la notificación. **ES LO ÚNICO QUE PUEDE MARCAR UN PAGO.**
     *
     * El IPN es un GET abierto: sin esta comprobación cualquiera marca pedidos
     * como pagados escribiendo una URL. Y la comparación va en tiempo
     * constante: el ejemplo oficial usa `===` porque es un ejemplo, y un `===`
     * filtra —por lo que tarda— cuánto del hash acertó quien lo intenta.
     */
    async verifyWebhook(cred, aviso: AvisoDeYappy): Promise<Resultado<AvisoVerificado<EstadoYappy>>> {
      const estado = estadoDeLetra(aviso.status);
      if (estado === null) {
        return fallo("entrada_invalida", `Yappy mandó un estado que no se conoce: «${aviso.status}»`);
      }

      /**
       * El dominio del aviso tiene que ser el NUESTRO.
       *
       * Va antes del hash y no sobra: el hash se calcula sobre el dominio que
       * venga en la URL, así que sin esto bastaría con firmar un aviso para
       * otro dominio y la firma cuadraría consigo misma.
       */
      if (!igualesSinAtajo(aviso.domain, cred.domain)) {
        return fallo("no_autorizado", "ese aviso de pago no es de este sitio");
      }

      const esperada = await firmaDelIpn(
        cred.secretKey,
        aviso.orderId,
        aviso.status.trim().toUpperCase(),
        cred.domain,
      );
      if (!igualesSinAtajo(aviso.hash.trim().toLowerCase(), esperada)) {
        return fallo("no_autorizado", "la firma de ese aviso de pago no cuadra");
      }

      return ok({
        ordenId: aviso.orderId,
        estado,
        /**
         * El id del evento, para no aplicar dos veces el mismo aviso.
         *
         * Lleva el estado dentro a propósito: Yappy puede mandar más de un
         * aviso para la misma orden si pasa por estados distintos, y usar solo
         * el `orderId` haría que el segundo se descartara en silencio.
         */
        eventoId: `${aviso.orderId}:${aviso.status.trim().toUpperCase()}`,
        referencia: aviso.confirmationNumber ?? null,
      });
    },

    /**
     * No se implementa, y se dice por qué.
     *
     * La documentación del Botón de Pago no expone ninguna consulta de estado:
     * lo que hay es el IPN. Consultar el estado de una orden sí se puede, pero
     * con la OTRA integración —la API Comercial, `movement/history`— que tiene
     * sus propias credenciales y es otra pieza.
     */
    async consultar(): Promise<Resultado<never>> {
      return fallo(
        "pasarela_no_disponible",
        "El Botón de Pago de Yappy no permite consultar una orden: el resultado llega por su notificación. Para conciliar hace falta la API Comercial, que es otra integración.",
      );
    },

    async refundPayment(): Promise<Resultado<never>> {
      return fallo(
        "pasarela_no_disponible",
        "El Botón de Pago de Yappy no devuelve dinero por API: el reembolso se hace desde Yappy Comercial y después se anota aquí.",
      );
    },
  };
}
