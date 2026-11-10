import type { Env } from "./env";
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
 * Portado de `netlify/functions/chat.ts` SIN cambiar su comportamiento: mismo
 * modelo, misma temperatura, mismos topes, mismos códigos de respuesta. F1.4
 * es explícito en eso, y con razón —mudar de casa no es el momento de cambiar
 * también los muebles: si algo se rompe después del corte, hay que poder
 * descartar que lo rompió la mudanza—.
 *
 * Lo único que cambia es la forma: Netlify daba `event`/`statusCode` y aquí
 * son `Request`/`Response`. La clave pasa de `process.env` a un secreto del
 * Worker (`wrangler secret put GROQ_API_KEY`).
 *
 * En F3.6 esto se reemplaza por `CanalWeb` del CRM y el archivo se borra.
 */

interface MensajeDelChat {
  role?: string;
  content?: unknown;
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

  if (!env.GROQ_API_KEY) {
    return json({ error: "GROQ_API_KEY not configured on server" }, 500);
  }

  try {
    const messages = cuerpo.messages;
    if (!Array.isArray(messages)) {
      return json({ error: "Invalid or missing messages array" }, 400);
    }

    const respuesta = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: promptDelSistema(await preciosDelCatalogo(env)) },
          ...(messages as MensajeDelChat[]).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
        ],
        temperature: 0.7,
        max_tokens: 220, // suficiente para respuestas breves de ~400 caracteres
      }),
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      return json({ error: `Groq API Error: ${detalle}` }, respuesta.status);
    }

    const datos = (await respuesta.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    let texto = datos.choices?.[0]?.message?.content ?? "";

    // Salvaguarda: evita respuestas excesivamente largas sin cortar a media frase.
    const MAX_CHARS = 500;
    if (texto.length > MAX_CHARS) {
      const recortado = texto.substring(0, MAX_CHARS);
      const ultimoPunto = Math.max(recortado.lastIndexOf(". "), recortado.lastIndexOf("\n"));
      texto = (ultimoPunto > 200 ? recortado.substring(0, ultimoPunto + 1) : recortado).trim();
    }

    return json({ reply: texto }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Internal Server Error" }, 500);
  }
}
