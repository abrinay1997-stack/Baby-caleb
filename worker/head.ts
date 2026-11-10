import { metaDe, seIndexa } from "../src/seo/rutas";

/**
 * El `<head>` correcto ANTES de que el navegador ejecute nada.
 *
 * Esto es lo que gana la web al mudarse a un Worker. Hoy el `<head>` lo
 * arregla `Seo.tsx` con JavaScript, y eso llega tarde para quien más importa:
 * cuando alguien pega un enlace en WhatsApp, Meta pide la página y lee el HTML
 * TAL CUAL llega — no ejecuta React. Así que las siete páginas comparten el
 * título y la descripción de `index.html`, y el enlace de «Preguntas
 * frecuentes» se ve en WhatsApp como si fuera la portada.
 *
 * `index.html` ya trae todas las etiquetas que hacen falta, así que aquí no se
 * añade ninguna: solo se les cambia el valor. Es a propósito —añadir etiquetas
 * sueltas desde el servidor acaba en páginas con dos `og:title` y ninguna
 * forma de saber cuál gana—.
 *
 * `Seo.tsx` se queda, y no sobra: al navegar DENTRO de la SPA no hay petición
 * al servidor, así que el título lo tiene que cambiar el navegador. Los dos
 * leen `src/seo/rutas.ts`, que es lo que impide que digan cosas distintas.
 */

/** Cambia el `content` de una `<meta>`. */
class Contenido {
  constructor(private readonly valor: string) {}
  element(el: Element): void {
    el.setAttribute("content", this.valor);
  }
}

/** Cambia el texto de una etiqueta (el `<title>`). */
class Texto {
  constructor(private readonly valor: string) {}
  element(el: Element): void {
    el.setInnerContent(this.valor);
  }
}

/** Cambia el `href` (el canónico). */
class Href {
  constructor(private readonly valor: string) {}
  element(el: Element): void {
    el.setAttribute("href", this.valor);
  }
}

/**
 * Reescribe el `<head>` de una respuesta HTML para la ruta pedida.
 *
 * Las rutas que no son de las siete públicas —`/carrito`, `/mi-cuenta`,
 * `/seguimiento/<token>`— conservan el `<head>` de `index.html` pero se marcan
 * `noindex`: son pantallas de una persona y no tienen nada que hacer en Google.
 * El seguimiento es el caso claro: su URL lleva un token dentro.
 */
/**
 * El beacon de Cloudflare Web Analytics, al final del `<head>` (F1.8).
 *
 * El identificador se valida ANTES de escribirlo. No es paranoia de manual:
 * este valor viene de la configuración y acaba dentro de un atributo HTML que
 * además contiene JSON. Un valor con una comilla rompe el atributo y lo que
 * siga se interpreta como marcado. Que hoy lo escriba una persona de
 * confianza no cambia lo que pasa si un día se pega mal.
 *
 * Cloudflare entrega un token de 32 caracteres hexadecimales. Cualquier otra
 * cosa no se escribe: se ignora y se deja dicho en el registro. Una analítica
 * que no cuenta es un problema pequeño; un `<head>` roto se lleva la página
 * entera por delante.
 */
const TOKEN_VALIDO = /^[0-9a-f]{32}$/;

class Analitica {
  constructor(private readonly token: string) {}

  element(el: Element): void {
    el.append(
      `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
        `data-cf-beacon='{"token": "${this.token}"}'></script>`,
      { html: true },
    );
  }
}

export function reescribirHead(
  respuesta: Response,
  url: URL,
  siteUrl: string,
  tokenAnalitica?: string,
): Response {
  const camino = url.pathname;
  const meta = metaDe(camino);
  const canonico = `${siteUrl}${camino === "/" ? "/" : camino}`;

  let rw = new HTMLRewriter();

  if (meta !== null) {
    rw = rw
      .on("title", new Texto(meta.title))
      .on('meta[name="description"]', new Contenido(meta.description))
      .on('meta[property="og:title"]', new Contenido(meta.title))
      .on('meta[property="og:description"]', new Contenido(meta.description))
      .on('meta[property="og:url"]', new Contenido(canonico))
      .on('meta[name="twitter:title"]', new Contenido(meta.title))
      .on('meta[name="twitter:description"]', new Contenido(meta.description))
      .on('link[rel="canonical"]', new Href(canonico));
  }

  if (!seIndexa(camino)) {
    rw = rw.on('meta[name="robots"]', new Contenido("noindex, nofollow"));
  }

  const token = (tokenAnalitica ?? "").trim();
  if (token !== "") {
    if (TOKEN_VALIDO.test(token)) {
      rw = rw.on("head", new Analitica(token));
    } else {
      // Sin `token` en el registro: aunque no sea secreto, un valor mal pegado
      // puede ser cualquier cosa, y los registros se comparten.
      console.warn(
        JSON.stringify({
          evento: "analitica_token_invalido",
          detalle: "CF_ANALYTICS_TOKEN no son 32 caracteres hexadecimales; no se inyecta el beacon",
        }),
      );
    }
  }

  return rw.transform(respuesta);
}
