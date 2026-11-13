import { catalogo, variantesDelCatalogo } from "./catalogo";
import { chat } from "./chat";
import type { Env } from "./env";
import { reescribirHead } from "./head";
import { rutaCortaDeProducto, slugDeRuta } from "../src/seo/producto";
import { PREFIJO, imagen } from "./imagenes";
import { urlDelSitio } from "./sitio";
import { quiereIndexarse, redireccionCanonica, seIndexa } from "./visibilidad";

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
function conCabeceras(respuesta: Response, indexable = true): Response {
  const r = new Response(respuesta.body, respuesta);
  r.headers.set("x-frame-options", "DENY");
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  // La cabecera, no solo la etiqueta <meta>: así también quedan fuera el
  // sitemap, el JSON y cualquier cosa que no sea HTML.
  if (!indexable) r.headers.set("x-robots-tag", "noindex, nofollow");
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
    const siteUrl = urlDelSitio(env.SITE_URL, url.origin);
    const indexable = seIndexa(env.SITE_URL ?? "", url.hostname, env.INDEXABLE);

    // `www` no sirve una copia: manda a la dirección oficial de una vez. Dos
    // direcciones con el mismo contenido reparten entre ellas lo que debería
    // ir a una sola. (La copia de workers.dev NO se redirige: es contra la que
    // se compara antes de cada corte.)
    const aDondeVa = redireccionCanonica(env.SITE_URL ?? "", url);
    if (aDondeVa !== null) {
      return Response.redirect(aDondeVa, 301);
    }

    // ---- El enlace corto de una ficha -------------------------------------
    // `/p/<slug>` → `/productos/<slug>`. Va ANTES que todo lo demás porque es
    // un desvío, no una página: cuanto antes se resuelva, menos trabajo se
    // hace para algo que no se va a servir.
    //
    // 301 y no 302: el enlace corto es para compartir, así que acabará pegado
    // en mensajes y en publicaciones durante años. Un permanente le dice al
    // buscador que la página buena es la larga, y evita que las dos compitan
    // entre sí por el mismo producto.
    const fichaCorta = rutaCortaDeProducto(url.pathname);
    if (fichaCorta !== null) {
      return Response.redirect(new URL(fichaCorta, url.origin).toString(), 301);
    }

    // ---- API -------------------------------------------------------------
    if (url.pathname === "/api/chat") {
      return conCabeceras(await chat(peticion, env), indexable);
    }

    // El catálogo: precio y disponibilidad, del sistema (F3.5). Se devuelve
    // SIN pasar por `conCabeceras` porque esta respuesta se guarda en la caché
    // del borde y ya trae las suyas propias.
    if (url.pathname === "/api/catalogo") {
      return await catalogo(peticion, env.SISTEMA);
    }

    if (url.pathname === "/api/salud") {
      // Se le PREGUNTA al sistema; no se mira si el binding existe.
      //
      // Esto decía `env.SISTEMA ? "del sistema" : "falta el binding"`, que
      // comprueba que el cable esté enchufado y no que al otro lado conteste
      // alguien. Con la base caída seguía diciendo «del sistema» mientras cada
      // petición servía la copia de respaldo: la salud afirmaba justo lo que
      // había dejado de ser verdad, y es la primera pantalla que alguien mira
      // cuando la tienda enseña precios raros.
      //
      // Un control que no puede ser falso es peor que ninguno (trampa §1), y
      // éste no podía: el binding se declara en `wrangler.jsonc` y está ahí
      // siempre. Ahora la llamada puede fallar, así que la respuesta puede
      // decir que no.
      let catalogo: string;
      if (env.SISTEMA === undefined) {
        catalogo = "copia del build (falta el binding SISTEMA)";
      } else {
        try {
          const r = await env.SISTEMA.salud();
          catalogo = r.ok
            ? r.datos.sano
              ? "del sistema"
              : "EL SISTEMA CONTESTA PERO NO ESTÁ SANO: la tienda está sirviendo la copia del build"
            : "EL SISTEMA RECHAZA LA CONSULTA: la tienda está sirviendo la copia del build";
        } catch {
          // La llamada revienta cuando el Worker del sistema no está, o cuando
          // el método todavía no está desplegado al otro lado. No es lo mismo
          // que un «no» suyo, y confundirlos manda al siguiente que lo mire a
          // buscar en la base en vez de en el despliegue.
          catalogo = "EL SISTEMA NO CONTESTA: la tienda está sirviendo la copia del build";
        }
      }

      return conCabeceras(
        json({
          ok: true,
          version: env.VERSION ?? "dev",
          sitio: siteUrl,
          // Que esto se vea de un vistazo es el punto: un sitio lanzado y
          // olvidado en «oculto» no da ningún síntoma — simplemente no llega
          // nadie, y para cuando alguien lo nota han pasado meses.
          buscadores: quiereIndexarse(env.INDEXABLE)
            ? "indexable"
            : "OCULTO a buscadores (INDEXABLE no está encendido)",
          // El chat necesita su clave; decirlo aquí evita descubrirlo cuando
          // una clienta escriba. Y el límite por IP se dice aparte: sin él el
          // chat FUNCIONA, que es justo lo que lo hace peligroso —un
          // formulario abierto a internet sin freno no da ningún síntoma hasta
          // que llega la factura—.
          chat: env.META_API_KEY_WEB ? "listo" : "falta META_API_KEY_WEB",
          chat_limite: env.LIMITE_CHAT ? "puesto" : "SIN LÍMITE por IP",
          // Qué modelo se está pidiendo de verdad. Sale aquí porque el nombre
          // viene de `reglas.json` y NUNCA se había usado contra la API: si
          // está mal, esto es lo primero que hay que mirar, y mirarlo no debe
          // exigir leer el código.
          chat_modelo: env.MODELO_CHAT ?? "muse-spark-1.3-contributor",
          // Si esto no dice «del sistema», la web sigue en pie pero con los
          // precios de la fecha del despliegue. Vale más verlo aquí que
          // descubrirlo por un precio viejo cobrado a una clienta.
          catalogo,
        }),
      );
    }

    // Las fotos del catálogo. La lógica vive en `imagenes.ts` para poder
    // probarla; aquí solo se enruta.
    if (url.pathname.startsWith(PREFIJO)) {
      return conCabeceras(await imagen(peticion, env.SISTEMA), indexable);
    }

    if (url.pathname.startsWith("/api/")) {
      return conCabeceras(json({ error: "no existe esa ruta" }, 404), indexable);
    }

    // ---- La web ----------------------------------------------------------
    const estatico = await env.ASSETS.fetch(peticion);

    // Solo se reescribe el HTML. Una imagen o una hoja de estilo pasan tal
    // cual: meterlas por HTMLRewriter sería gastar por nada.
    const tipo = estatico.headers.get("content-type") ?? "";
    if (!tipo.includes("text/html")) return estatico;

    // El catálogo solo se pide para las fichas de producto: las otras seis
    // páginas no lo necesitan y no tienen por qué pagar la consulta.
    const variantes = slugDeRuta(url.pathname)
      ? await variantesDelCatalogo(peticion, env.SISTEMA)
      : [];

    return conCabeceras(
      reescribirHead(estatico, url, siteUrl, env.CF_ANALYTICS_TOKEN, env.META_PIXEL_ID, variantes),
      indexable,
    );
  },
} satisfies ExportedHandler<Env>;
