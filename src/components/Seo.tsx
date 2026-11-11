import { useEffect } from 'react';
import { RUTAS, SITE_NAME, metaDe } from '../seo/rutas';

/**
 * El `<head>` al navegar DENTRO de la SPA.
 *
 * El Worker ya pone el `<head>` correcto en el HTML que manda (worker/head.ts),
 * que es lo que leen WhatsApp y Meta. Pero al moverse entre páginas sin
 * recargar no hay petición al servidor, así que el título lo tiene que cambiar
 * el navegador: eso es esto.
 *
 * Los textos NO se pasan por propiedades: se piden por RUTA a `seo/rutas.ts`,
 * que es el mismo archivo que lee el Worker. Antes vivían escritos en cada
 * página, y eso significaba que el día que alguien cambiara uno, el enlace
 * compartido por WhatsApp diría una cosa y la pestaña del navegador otra.
 */
interface SeoProps {
  /** La ruta, ej. "/productos". Sus textos salen de `seo/rutas.ts`. */
  ruta: keyof typeof RUTAS | string;
  /** JSON-LD específico de la página (ej. FAQPage, Product). */
  jsonLd?: Record<string, unknown>;
  /**
   * Título y descripción ya resueltos, para las páginas que NO están en la
   * lista fija: las fichas de producto, cuyos textos salen del catálogo
   * (F3.7). Si viene, manda sobre `rutas.ts`.
   *
   * Es la única forma de que la ficha diga lo mismo aquí que en el HTML que
   * manda el Worker: los dos arman el texto con `metaDeProducto`.
   */
  meta?: { title: string; description: string };
}
const JSONLD_ID = 'route-jsonld';

function upsertMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

export default function Seo({ ruta, jsonLd, meta: metaDada }: SeoProps) {
  useEffect(() => {
    const meta = metaDada ?? metaDe(ruta);
    if (!meta) return;
    const { title, description } = meta;
    const url = `${window.location.origin}${ruta}`;

    document.title = title;
    upsertMeta('name', 'description', description);
    upsertMeta('property', 'og:title', title);
    upsertMeta('property', 'og:description', description);
    upsertMeta('property', 'og:url', url);
    upsertMeta('name', 'twitter:title', title);
    upsertMeta('name', 'twitter:description', description);
    upsertCanonical(url);

    let script: HTMLScriptElement | null = null;
    if (jsonLd) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = JSONLD_ID;
      script.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }

    return () => {
      script?.remove();
    };
  }, [ruta, jsonLd, metaDada]);

  return null;
}

export { SITE_NAME };
