import { chat } from "./chat";
import type { Env } from "./env";
import { reescribirHead } from "./head";

/**
 * `babycaleb-web`: la misma web, servida desde Cloudflare.
 *
 * F1 del plan. La regla de la mudanza es que NADA cambie de comportamiento:
 * si algo se rompe después del corte, hay que poder descartar que lo rompió la
 * mudanza. Lo único que se gana de entrada es el `<head>` por ruta, que hoy no
 * funciona para WhatsApp ni para Meta porque lo pone JavaScript.
 *
 * Casi todo sale directo de los estáticos sin pasar por aquí: `run_worker_first`
 * en `wrangler.jsonc` dice las pocas rutas en las que el Worker corre primero.
 * Una imagen o un `.js` no tienen por qué pagar el precio de un Worker.
 */

/** Las cabeceras que `public/_headers` no puede poner: las de lo que responde el Worker. */
function conCabeceras(respuesta: Response): Response {
  const r = new Response(respuesta.body, respuesta);
  r.headers.set("x-frame-options", "DENY");
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return r;
}

const json = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(peticion: Request, env: Env): Promise<Response> {
    const url = new URL(peticion.url);

    // El dominio sale de una variable y no del `Host` de la petición: con el
    // `Host`, el canónico de una vista previa apuntaría a la vista previa, y
    // Google indexaría esa en vez del sitio.
    const siteUrl = (env.SITE_URL ?? url.origin).replace(/\/+$/, "");

    // ---- API -------------------------------------------------------------
    if (url.pathname === "/api/chat") {
      return conCabeceras(await chat(peticion, env));
    }

    if (url.pathname === "/api/salud") {
      return conCabeceras(
        json({
          ok: true,
          version: env.VERSION ?? "dev",
          sitio: siteUrl,
          // El chat necesita su clave; decirlo aquí evita descubrirlo cuando
          // una clienta escriba.
          chat: env.GROQ_API_KEY ? "listo" : "falta GROQ_API_KEY",
        }),
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return conCabeceras(json({ error: "no existe esa ruta" }, 404));
    }

    // ---- La web ----------------------------------------------------------
    const estatico = await env.ASSETS.fetch(peticion);

    // Solo se reescribe el HTML. Una imagen o una hoja de estilo pasan tal
    // cual: meterlas por HTMLRewriter sería gastar por nada.
    const tipo = estatico.headers.get("content-type") ?? "";
    if (!tipo.includes("text/html")) return estatico;

    return conCabeceras(reescribirHead(estatico, url, siteUrl, env.CF_ANALYTICS_TOKEN));
  },
} satisfies ExportedHandler<Env>;
