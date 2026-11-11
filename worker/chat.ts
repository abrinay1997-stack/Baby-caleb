import type { Env } from "./env";
import { quienLlama, revisarConversacion } from "./limites";
import { promptDelSistema } from "./prompt";

/**
 * Los precios que el chat puede decir, del catálogo del sistema (F3.5).
 *
 * Si el sistema no contesta, se devuelve un mapa VACÍO a propósito y el prompt
 * se queda sin su lista de precios: el chat dirá que confirma con el equipo.
 * La alternativa —tirar de la copia del build— sería cotizar con precios de la
 * fecha del último despliegue sin que nadie lo sepa, y en un chat eso es una
 * cifra dicha a una clienta, no un número en una pantalla.
 */
async function preciosDelCatalogo(env: Env): Promise<ReadonlyMap<string, number>> {
  if (env.SISTEMA === undefined) return new Map();
  try {
    const r = await env.SISTEMA.catalogo();
    if (!r.ok) return new Map();
    const vs = r.datos.variantes as { codigo: string; precioCents: number }[];
    return new Map(vs.map((v) => [v.codigo, v.precioCents]));
  } catch (error) {
    console.warn(JSON.stringify({ evento: "chat_sin_catalogo", error: String(error) }));
    return new Map();
  }
}

/**
 * El chat de la web, dentro del Worker.
 *
 * Nació portado de Netlify sin cambiar nada, a propósito: mudar de casa no es
 * el momento de cambiar también los muebles. Ya se mudó, así que ahora sí
 * cambia, y en dos cosas.
 *
 * **El proveedor.** Era Groq; ahora es el mismo que el asistente interno, con
 * su propia llave (`META_API_KEY_WEB`, en el Worker de la web). Dos llaves y
 * no una, a propósito: esta cara está abierta a internet y la otra está detrás
 * de Access con cuatro correos. Si esta se abusa o se filtra, se revoca sin
 * dejar muda a la dueña. Y un bombardeo aquí no se come el límite de allá.
 *
 * **El blindaje.** Antes no había ninguno: cualquiera podía mandar un mensaje
 * de un megabyte mil veces seguidas y cada uno iba derecho al proveedor a
 * costo del negocio. Ahora hay límite por IP y topes de tamaño, y van ANTES de
 * mirar nada más.
 *
 * En F3.6 esto se reemplaza por `CanalWeb` del CRM y el archivo se borra.
 */

/** Un solo host, también para pruebas (ver la documentación de Meta). */
const BASE_META = "https://api.meta.ai/v1";

/**
 * El mismo nivel que el asistente interno: `Contributor`.
 *
 * Cuesta menos a cambio de permiso para entrenar con lo que recibe, y eso está
 * DICHO en la política de privacidad del sitio. Si alguien lo cambia aquí, hay
 * que cambiarlo allá: una política que describe un modelo que ya no se usa es
 * peor que no tener política.
 */
const MODELO_POR_OMISION = "muse-spark-1.2-contributor";

/**
 * El texto de la respuesta, sin confiar en su forma.
 *
 * Meta devuelve `content` como una lista de bloques. Si el formato cambia, se
 * devuelve lo que se haya podido leer en vez de reventar: un cambio de forma
 * del proveedor deja al chat callado, no caído.
 */
export function textoDeLaRespuesta(crudo: unknown): string {
  const cuerpo = (crudo ?? {}) as Record<string, unknown>;
  const bloques = Array.isArray(cuerpo["content"]) ? (cuerpo["content"] as unknown[]) : [];
  let texto = "";
  for (const b of bloques) {
    const bloque = (b ?? {}) as Record<string, unknown>;
    if (bloque["type"] === "text" && typeof bloque["text"] === "string") texto += bloque["text"];
  }
  return texto;
}

const json = (cuerpo: unknown, status: number): Response =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * El chat, por el agente del CRM (F3.6).
 *
 * Es el MISMO bot que atiende WhatsApp y Telegram: misma base de
 * conocimiento, mismas herramientas, mismo revisor, mismo trato de usted. Y la
 * conversación aparece en la bandeja, así que la dueña puede leerla, meterse,
 * o pausar el bot — nada de eso existía con el chat de Groq.
 *
 * El historial NO se manda: el CRM lleva su propia memoria por conversación,
 * que es más fiel que lo que el navegador tenga en pantalla.
 */
async function porElCrm(
  crm: NonNullable<Env["CRM"]>,
  sesion: string,
  texto: string,
): Promise<Response> {
  const r = await crm.mensajeWeb({ sesion, texto });

  if (r.ok) {
    // La interfaz espera UN texto. El agente trocea para los canales que
    // mandan varios mensajes seguidos; aquí se vuelven a juntar.
    return json({ reply: r.trozos.join("\n\n") }, 200);
  }

  if (r.codigo === "sin_respuesta") {
    // El bot está pausado o un guardarraíl descartó el mensaje. NO es un
    // error: se le dice a la clienta lo que de verdad está pasando, con 200,
    // para que la pantalla no enseñe «algo salió mal».
    return json({ reply: r.mensaje }, 200);
  }

  return json({ error: r.mensaje }, 400);
}

export async function chat(peticion: Request, env: Env): Promise<Response> {
  if (peticion.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  const cuerpo = (await peticion.json().catch(() => ({}))) as {
    messages?: unknown;
    sesion?: unknown;
  };

  // Con el binding al CRM puesto, se va por el agente de verdad. Sin él, por
  // el camino de siempre.
  //
  // El interruptor es la PRESENCIA del binding y no una variable, porque un
  // binding a un entrypoint que no existe ni siquiera deja desplegar: si está,
  // el CRM ya tiene `CanalWeb` desplegado. Una variable podría decir «usa el
  // CRM» con el CRM sin actualizar, y el chat se quedaría mudo.
  if (env.CRM !== undefined) {
    const sesion = typeof cuerpo.sesion === "string" ? cuerpo.sesion : "";
    const ultimo = Array.isArray(cuerpo.messages)
      ? (cuerpo.messages as { role?: string; content?: unknown }[])
          .filter((m) => m.role !== "assistant" && typeof m.content === "string")
          .at(-1)
      : undefined;
    const texto = typeof ultimo?.content === "string" ? ultimo.content : "";

    if (sesion === "" || texto === "") {
      return json({ error: "Invalid or missing messages array" }, 400);
    }
    return await porElCrm(env.CRM, sesion, texto);
  }

  // ── El blindaje ──────────────────────────────────────────────────────────
  //
  // El chat está abierto a internet sin cuenta ni contraseña, y cada mensaje
  // que pasa de aquí cuesta dinero en el proveedor del modelo. Las dos
  // defensas van ANTES de mirar nada más: no tiene sentido validar con cuidado
  // una petición que de todas formas no se va a atender.

  if (env.LIMITE_CHAT !== undefined) {
    const { success } = await env.LIMITE_CHAT.limit({ key: quienLlama(peticion) });
    if (!success) {
      // 429 con un texto que una clienta entienda, no un código seco. La
      // mayoría de los que llegan aquí son robots, pero la que no lo es
      // merece saber qué pasó.
      return json(
        {
          error:
            "Está escribiendo muy rápido. Espere un momento, o escríbanos por WhatsApp y le contesta una persona.",
        },
        429,
      );
    }
  }

  const revision = revisarConversacion(cuerpo.messages);
  if (!revision.ok) {
    return json({ error: revision.motivo }, revision.estado);
  }

  if (!env.META_API_KEY_WEB) {
    return json({ error: "Falta META_API_KEY_WEB en el Worker" }, 500);
  }

  try {
    // `system` va en su propio campo, NO como un mensaje más de la lista. Es
    // lo que separa las instrucciones del negocio de lo que teclea la clienta:
    // si fueran un mensaje más, cualquiera podría mandar otro que dijera lo
    // contrario y el modelo tendría dos textos del mismo rango discutiendo.
    const respuesta = await fetch(`${BASE_META}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.META_API_KEY_WEB}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODELO_CHAT ?? MODELO_POR_OMISION,
        max_tokens: 220, // suficiente para respuestas breves de ~400 caracteres
        system: promptDelSistema(await preciosDelCatalogo(env)),
        messages: revision.mensajes.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!respuesta.ok) {
      // El detalle NO se devuelve a la clienta: el cuerpo de un error puede
      // traer de vuelta lo que se mandó, y ahí va el prompt entero.
      const detalle = (await respuesta.text().catch(() => "")).slice(0, 300);
      console.warn(JSON.stringify({ evento: "chat_modelo_fallo", estado: respuesta.status, detalle }));
      return json(
        { error: "El asistente no está disponible ahora mismo. Escríbanos por WhatsApp." },
        502,
      );
    }

    const crudo: unknown = await respuesta.json();
    let texto = textoDeLaRespuesta(crudo);

    // Salvaguarda del largo: el prompt pide respuestas cortas y el modelo casi
    // siempre obedece, pero «casi» no es una garantía y una parrafada en una
    // burbuja de chat no se lee. Se corta en la última frase entera, no a
    // mitad de palabra.
    const MAX_CHARS = 500;
    if (texto.length > MAX_CHARS) {
      const recortado = texto.substring(0, MAX_CHARS);
      const ultimoPunto = Math.max(recortado.lastIndexOf(". "), recortado.lastIndexOf("\n"));
      texto = (ultimoPunto > 200 ? recortado.substring(0, ultimoPunto + 1) : recortado).trim();
    }

    if (texto.trim() === "") {
      // El modelo contestó 200 y sin texto legible. Es el caso difícil de
      // diagnosticar: la clienta ve una frase amable y nadie se entera de por
      // qué. Así que se anota la FORMA de lo que llegó —las claves de primer
      // nivel, los tipos de bloque, el motivo de parada y el modelo que dice
      // ser— y nunca el contenido: ahí puede venir de vuelta lo que se mandó,
      // y ahí va el prompt entero.
      //
      // Se lee en Cloudflare → Workers → babycaleb-web → Logs, en vivo.
      const cuerpoCrudo = (crudo ?? {}) as Record<string, unknown>;
      const bloques = Array.isArray(cuerpoCrudo["content"]) ? cuerpoCrudo["content"] : [];
      console.warn(
        JSON.stringify({
          evento: "chat_sin_texto",
          claves: Object.keys(cuerpoCrudo),
          modelo_pedido: env.MODELO_CHAT ?? MODELO_POR_OMISION,
          modelo_dicho: cuerpoCrudo["model"] ?? null,
          motivo_parada: cuerpoCrudo["stop_reason"] ?? null,
          bloques: (bloques as unknown[]).map((b) => (b as Record<string, unknown>)?.["type"]),
        }),
      );
      return json(
        { reply: "No tengo eso a mano. Escríbanos por WhatsApp y le contesta una persona." },
        200,
      );
    }

    return json({ reply: texto }, 200);
  } catch (e) {
    // Lo que se registra lleva el detalle; lo que se devuelve, no. Un error
    // del proveedor puede traer de vuelta lo que se le mandó, y ahí va el
    // prompt entero.
    console.warn(JSON.stringify({ evento: "chat_error", error: String(e) }));
    return json(
      { error: "El asistente no está disponible ahora mismo. Escríbanos por WhatsApp." },
      500,
    );
  }
}
