import { useEffect } from 'react';

interface SeoProps {
  title: string;
  description: string;
  /** Ruta canónica, ej. "/productos". Por defecto la actual. */
  path?: string;
  /** JSON-LD adicional específico de la página (ej. FAQPage). */
  jsonLd?: Record<string, unknown>;
}

const SITE_NAME = 'Baby Caleb Panamá';
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

export default function Seo({ title, description, path, jsonLd }: SeoProps) {
  useEffect(() => {
    const origin = window.location.origin;
    const routePath = path ?? window.location.pathname;
    const url = `${origin}${routePath}`;

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
  }, [title, description, path, jsonLd]);

  return null;
}

export { SITE_NAME };
