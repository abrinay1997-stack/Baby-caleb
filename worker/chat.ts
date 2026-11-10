import type { Env } from "./env";
import { PROMPT_DEL_SISTEMA } from "./prompt";

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

export async function chat(peticion: Request, env: Env): Promise<Response> {
  if (peticion.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  if (!env.GROQ_API_KEY) {
    return json({ error: "GROQ_API_KEY not configured on server" }, 500);
  }

  try {
    const cuerpo = (await peticion.json().catch(() => ({}))) as { messages?: unknown };
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
          { role: "system", content: PROMPT_DEL_SISTEMA },
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
