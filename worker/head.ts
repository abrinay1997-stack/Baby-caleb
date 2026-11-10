import { metaDe, seIndexa, type MetaDeRuta } from "../src/seo/rutas";
import {
  jsonLdProducto,
  metaDeProducto,
  slugDeRuta,
  type VarianteParaFicha,
} from "../src/seo/producto";

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

/** Cuelga un `<script type="application/ld+json">` al final del `<head>`. */
class DatosEstructurados {
  constructor(private readonly datos: Record<string, unknown>) {}
  element(el: Element): void {
    // `</` se escapa porque un `</script>` dentro del JSON cerraría la etiqueta
    // antes de tiempo y el resto se interpretaría como marcado. Hoy ningún
    // nombre del catálogo lleva eso, pero los nombres los escribe una persona
    // en un panel y esta es la frontera donde ese texto se vuelve HTML.
    const json = JSON.stringify(this.datos).replace(/<\//g, "<\\/");
    el.append(`<script type="application/ld+json">${json}</script>`, { html: true });
  }
}

export function reescribirHead(
  respuesta: Response,
  url: URL,
  siteUrl: string,
  tokenAnalitica?: string,
  /**
   * El catálogo, solo para las fichas de producto (F3.7).
   *
   * Llega por parámetro y no se pide aquí dentro para que esta función siga
   * sin efectos: recibe datos, devuelve HTML. Quien la llama decide si le
   * cuesta una consulta —solo en `/productos/<slug>`— o no.
   */
  variantes: readonly VarianteParaFicha[] = [],
): Response {
  const camino = url.pathname;
  const canonico = `${siteUrl}${camino === "/" ? "/" : camino}`;

  // La ficha de un producto: su `<head>` sale del CATÁLOGO, no de una lista
  // escrita a mano. Si el slug no existe —un enlace viejo, un producto
  // retirado— no se inventa una ficha: se deja el <head> de fábrica y se marca
  // noindex más abajo, para que Google no guarde una página que no hay.
  const slug = slugDeRuta(camino);
  const variante = slug === null ? undefined : variantes.find((v) => v.slug === slug);

  let meta: MetaDeRuta | null;
  if (slug !== null) {
    meta = variante === undefined ? null : metaDeProducto(variante);
  } else {
    meta = metaDe(camino);
  }

  let rw = new HTMLRewriter();

  if (variante !== undefined) {
    rw = rw.on("head", new DatosEstructurados(jsonLdProducto(variante, canonico)));
  }

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

  // Una ficha cuyo slug no está en el catálogo tampoco se indexa: es una URL
  // que no corresponde a nada que se pueda comprar.
  if (!seIndexa(camino) || (slug !== null && variante === undefined)) {
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
