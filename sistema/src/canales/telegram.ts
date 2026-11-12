import { z } from "zod";
import { igualesSinAtajo } from "../seguridad/pin";

/**
 * El protocolo de Telegram, aparte de lo que hace Caleb.
 *
 * Aquí vive todo lo que se puede probar sin base y sin red —leer una
 * actualización, comparar el secreto, partir un texto largo, armar y leer los
 * botones— y el cliente mínimo de la API del bot. La puerta en sí
 * (autenticación contra `usuarios`, el turno, la bitácora) está en
 * `src/api/telegram-rutas.ts`.
 *
 * ## Los dos secretos, y por qué son dos
 *
 * - `TELEGRAM_BOT_TOKEN` sirve para HABLAR: va dentro de la URL de cada
 *   llamada a la API. Por eso **la URL nunca se registra en un log**: llevaría
 *   el token escrito.
 * - `TELEGRAM_WEBHOOK_SECRET` sirve para ESCUCHAR: se le entrega a Telegram al
 *   dar de alta el webhook (`secret_token` de `setWebhook`) y Telegram lo
 *   devuelve en la cabecera `X-Telegram-Bot-Api-Secret-Token` de cada entrega.
 *   Sin comprobarlo, cualquiera que adivine la ruta le escribe a Caleb como si
 *   fuera Telegram.
 *
 * Los dos se ponen con `wrangler secret put` y **ninguno va en
 * `wrangler.jsonc`**: ahí van los identificadores públicos, no las llaves.
 *
 *     npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
 *     npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production
 *
 * El del webhook se genera con `openssl rand -hex 32` y se le da a Telegram en
 * la misma llamada que fija la URL:
 *
 *     curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *       -d "url=https://<host sin Access>/telegram/webhook" \
 *       -d "secret_token=<el mismo valor>"
 *
 * **El host NO puede estar detrás de Cloudflare Access.** Telegram no tiene
 * sesión de Access: la puerta le contestaría con la pantalla de inicio de
 * sesión y el webhook quedaría muerto en silencio. Hoy `panel.babycaleb.com`
 * cubre el host entero (`docs/PUERTA-DE-ACCESS.md`), así que el host de este
 * webhook está PENDIENTE de decidir — ver el reporte y
 * `docs/plan/06-asistente.md` §4.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /** El token del bot. Secreto, puesto con `wrangler secret put`. */
      TELEGRAM_BOT_TOKEN?: string;
      /** El `secret_token` que Telegram devuelve en cada entrega. Secreto. */
      TELEGRAM_WEBHOOK_SECRET?: string;
    }
  }
  /**
   * Y también el `Env` global, que es otro: `worker-configuration.d.ts`
   * declara los dos por separado y son HERMANOS, no padre e hijo, así que
   * ampliar uno no llega al otro. Las pruebas usan `Cloudflare.Env`; las
   * rutas, el global. Es el mismo recurso que usa `seguridad/cifrado.ts`.
   */
  interface Env {
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
  }
}

const codificador = new TextEncoder();

/** La cabecera donde Telegram devuelve el secreto del webhook. */
export const CABECERA_SECRETO = "X-Telegram-Bot-Api-Secret-Token";

/**
 * ¿Lo manda Telegram de verdad?
 *
 * En tiempo constante, porque comparar con `===` filtra por el tiempo de
 * respuesta cuántos bytes del principio acertó quien lo intenta, y con eso un
 * secreto se adivina byte a byte en unos cuantos miles de intentos. El largo
 * sí se filtra (`igualesSinAtajo` sale antes si no coinciden), y eso es lo
 * normal: saber que el secreto mide 64 no ayuda a nadie.
 *
 * Falla CERRADO: sin secreto configurado no hay forma de comprobar nada, así
 * que no se deja pasar. Es la misma regla que Access en `access.ts` — sin
 * configuración se cierra, no se abre.
 */
export function secretoCoincide(
  cabecera: string | null | undefined,
  secreto: string | undefined,
): boolean {
  const esperado = (secreto ?? "").trim();
  if (esperado === "") return false;
  return igualesSinAtajo(codificador.encode(cabecera ?? ""), codificador.encode(esperado));
}

// ---------------------------------------------------------------------------
// Lo que llega
// ---------------------------------------------------------------------------

/**
 * Una actualización de Telegram, con SOLO lo que se usa.
 *
 * Todo lo que no es `update_id` va opcional a propósito: por este webhook
 * pasan avisos que no son mensajes (`my_chat_member`, `edited_message`,
 * mensajes de canal…) y un esquema estricto los convertiría en errores de
 * forma, o sea en ruido en los registros por cosas normales. Lo que no se
 * entiende se ignora en silencio, que es justo lo que hay que hacer con ello.
 */
const CHAT = z.object({
  id: z.number(),
  /** `private`, `group`, `supergroup` o `channel`. Telegram siempre lo manda. */
  type: z.string(),
});

const MENSAJE = z.object({
  message_id: z.number(),
  chat: CHAT,
  from: z.object({ id: z.number() }).optional(),
  text: z.string().optional(),
});

export const ACTUALIZACION = z.object({
  update_id: z.number(),
  message: MENSAJE.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number() }),
      data: z.string().optional(),
      message: MENSAJE.optional(),
    })
    .optional(),
});

export type Actualizacion = z.infer<typeof ACTUALIZACION>;

/** Lo que de verdad hay que atender. */
export type Entrada =
  | { readonly clase: "texto"; readonly chatId: string; readonly texto: string }
  /** Una foto, una nota de voz, un adjunto: llegó algo que no es texto. */
  | { readonly clase: "sin_texto"; readonly chatId: string }
  | {
      readonly clase: "boton";
      readonly chatId: string;
      readonly mensajeId: number;
      readonly callbackId: string;
      readonly datos: string;
    };

/**
 * Un id de chat, como se guarda en `usuarios.telegram_chat_id`: texto.
 *
 * Devuelve `null` si el número no es un entero seguro. Telegram promete que
 * sus ids caben en 52 bits, así que esto no debería pasar nunca; si pasa, el
 * `String(...)` de un número ya redondeado escribiría un chat que no existe y
 * el cruce con `usuarios` daría un falso positivo contra otra fila.
 */
function comoTexto(id: number): string | null {
  return Number.isSafeInteger(id) ? String(id) : null;
}

/**
 * Qué hay que atender de esta actualización, o `null` si nada.
 *
 * **Solo chats privados, y solo si quien escribe ES el dueño del chat.** Un
 * chat de grupo no se atiende ni se vincula: si el bot acabara en un grupo y
 * ese grupo quedara vinculado, cualquiera de sus miembros le hablaría a Caleb
 * con los permisos de la dueña. En un chat privado, `chat.id` y `from.id` son
 * el mismo número por definición de Telegram, así que exigirlo no cuesta nada
 * y cierra la puerta a cualquier forma de actualización que no sea esa.
 */
export function loQueLlega(u: Actualizacion): Entrada | null {
  const boton = u.callback_query;
  if (boton !== undefined) {
    const mensaje = boton.message;
    if (mensaje === undefined || boton.data === undefined) return null;
    if (!esPrivadoDe(mensaje, boton.from.id)) return null;
    const chatId = comoTexto(mensaje.chat.id);
    if (chatId === null) return null;
    return {
      clase: "boton",
      chatId,
      mensajeId: mensaje.message_id,
      callbackId: boton.id,
      datos: boton.data,
    };
  }

  const mensaje = u.message;
  if (mensaje === undefined) return null;
  if (mensaje.from === undefined || !esPrivadoDe(mensaje, mensaje.from.id)) return null;
  const chatId = comoTexto(mensaje.chat.id);
  if (chatId === null) return null;

  const texto = (mensaje.text ?? "").trim();
  return texto === "" ? { clase: "sin_texto", chatId } : { clase: "texto", chatId, texto };
}

function esPrivadoDe(mensaje: z.infer<typeof MENSAJE>, deId: number): boolean {
  return mensaje.chat.type === "private" && mensaje.chat.id === deId;
}

// ---------------------------------------------------------------------------
// Los botones de una acción sensible
// ---------------------------------------------------------------------------

export interface Botones {
  readonly inline_keyboard: readonly { readonly text: string; readonly callback_data: string }[][];
}

const PERMITIR = "ok";
const RECHAZAR = "no";

/** Telegram rechaza un `callback_data` de más de 64 bytes. */
export const MAX_CALLBACK = 64;

/**
 * Los dos botones de una acción que espera permiso.
 *
 * Lo que viaja en `callback_data` es el id de la acción y nada más. El plan
 * (06-asistente §3) lo describía con un HMAC al lado, copiando a la consola
 * del CRM, y aquí no hace falta: a este webhook no se llega sin el
 * `secret_token`, o sea que el único que puede poner algo en `callback_data`
 * es Telegram. Y lo que de verdad protege la acción no es la firma del dato,
 * es `confirmar()`: comprueba que la pida la MISMA persona, que no haya
 * vencido y —con el trigger de la base— que no se ejecute dos veces. Una firma
 * encima solo repetiría lo que ya garantiza el transporte.
 *
 * Si el id no cupiera, Telegram rechazaría el mensaje entero y la dueña no
 * vería ni la pregunta: por eso se revienta aquí, donde se nota, en vez de
 * mandarlo y esperar.
 */
export function botonesDe(accionId: string): Botones {
  for (const dato of [`${PERMITIR}:${accionId}`, `${RECHAZAR}:${accionId}`]) {
    if (codificador.encode(dato).length > MAX_CALLBACK) {
      throw new Error(`callback_data de ${dato.length} letras: Telegram admite ${MAX_CALLBACK}`);
    }
  }
  return {
    inline_keyboard: [
      [
        { text: "Permitir", callback_data: `${PERMITIR}:${accionId}` },
        { text: "Rechazar", callback_data: `${RECHAZAR}:${accionId}` },
      ],
    ],
  };
}

/** Qué botón se tocó, o `null` si eso no lo escribió `botonesDe`. */
export function leerBoton(
  datos: string,
): { readonly decision: "permitir" | "rechazar"; readonly accionId: string } | null {
  const corte = datos.indexOf(":");
  if (corte === -1) return null;
  const cual = datos.slice(0, corte);
  const accionId = datos.slice(corte + 1);
  if (accionId === "") return null;
  if (cual === PERMITIR) return { decision: "permitir", accionId };
  if (cual === RECHAZAR) return { decision: "rechazar", accionId };
  return null;
}

// ---------------------------------------------------------------------------
// Partir un texto largo
// ---------------------------------------------------------------------------

/** Lo que admite un mensaje de Telegram. */
export const LARGO_MENSAJE = 4_096;

/** Cuántos mensajes seguidos se le mandan a alguien por una sola pregunta. */
export const MAX_TROZOS = 4;

/**
 * Parte una respuesta larga en mensajes que Telegram acepte.
 *
 * Caleb contesta corto por diseño (`prompt.ts`), pero «por diseño» no es «por
 * garantía»: un modelo puede soltar 6.000 letras y entonces Telegram rechaza
 * el mensaje ENTERO y la persona no ve nada. Un corte feo se lee; un mensaje
 * que no llegó, no.
 *
 * Se corta por el último salto de línea o espacio del trozo para no partir una
 * palabra, y si aun así sobra texto **se dice**, no se tira en silencio: una
 * respuesta cortada que no avisa de que está cortada se lee como completa.
 */
export function trozos(texto: string, max = LARGO_MENSAJE, maxTrozos = MAX_TROZOS): string[] {
  let resto = texto.trim();
  if (resto === "") return [];

  const salida: string[] = [];
  while (resto !== "" && salida.length < maxTrozos) {
    if (resto.length <= max) {
      salida.push(resto);
      resto = "";
      break;
    }
    const ventana = resto.slice(0, max);
    const corte = Math.max(ventana.lastIndexOf("\n"), ventana.lastIndexOf(" "));
    const hasta = corte > Math.floor(max / 2) ? corte : max;
    salida.push(resto.slice(0, hasta).trim());
    resto = resto.slice(hasta).trim();
  }

  if (resto !== "") {
    salida.push("Hasta aquí llega lo que cabe en un mensaje. Pregúnteme el resto por partes.");
  }
  return salida;
}

// ---------------------------------------------------------------------------
// El cliente de la API del bot
// ---------------------------------------------------------------------------

/** Lo poco que Caleb necesita de Telegram para contestar. */
export interface Bot {
  decir(chatId: string, texto: string, botones?: Botones): Promise<void>;
  /** Un `callback_query` SIN contestar deja el botón girando para siempre. */
  responderBoton(callbackId: string, texto: string): Promise<void>;
  /** Quita los botones de una pregunta ya decidida, para que no se vuelvan a tocar. */
  quitarBotones(chatId: string, mensajeId: number): Promise<void>;
}

/**
 * De dónde sale el bot.
 *
 * Fábrica y no objeto suelto por lo mismo que `HacerProveedor`: las pruebas
 * entran sin hablar con Telegram de verdad. Devuelve `null` cuando no hay
 * token, que no es un error: es el estado de un sistema recién instalado.
 */
export type HacerBot = (env: Env) => Bot | null;

/** La API de Telegram. El token va en la URL, así que la URL no se registra. */
const BASE = "https://api.telegram.org";

/** Lo máximo que se ve en el aviso flotante de un botón. */
export const LARGO_AVISO = 200;

export const porTelegram: HacerBot = (env) => {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (token === "") return null;

  async function llamar(metodo: string, cuerpo: Record<string, unknown>): Promise<void> {
    const r = await fetch(`${BASE}/bot${token}/${metodo}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });

    // Telegram contesta 200 con `{"ok": false, "description": "..."}` para
    // algunos fallos, así que mirar solo el código HTTP da por bueno lo que
    // no se envió. Se mira el campo `ok`, que es un dato de su contrato, y no
    // el texto de `description`, que es prosa y puede cambiar (trampa nº 2).
    let dice: { ok?: unknown; description?: unknown } = {};
    try {
      dice = (await r.json()) as typeof dice;
    } catch {
      dice = {};
    }
    if (r.ok && dice.ok === true) return;

    // El mensaje NO lleva la URL: ahí va el token del bot.
    throw new Error(
      `telegram ${metodo}: ${r.status} ${String(dice.description ?? "").slice(0, 200)}`,
    );
  }

  return {
    async decir(chatId, texto, botones) {
      await llamar("sendMessage", {
        chat_id: chatId,
        text: texto,
        // Sin `parse_mode` a propósito: el texto lo escribe un modelo y
        // cualquier guion bajo o asterisco suelto haría que Telegram
        // rechazara el mensaje por formato mal cerrado. Texto plano no se
        // puede escapar mal.
        ...(botones === undefined ? {} : { reply_markup: botones }),
      });
    },
    async responderBoton(callbackId, texto) {
      await llamar("answerCallbackQuery", {
        callback_query_id: callbackId,
        text: texto.slice(0, LARGO_AVISO),
      });
    },
    async quitarBotones(chatId, mensajeId) {
      await llamar("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: mensajeId,
        reply_markup: { inline_keyboard: [] },
      });
    },
  };
};
