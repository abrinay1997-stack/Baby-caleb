import type { SistemaWebBinding } from "./catalogo";

/**
 * Lo que el Worker de la web tiene a mano.
 *
 * `ASSETS` lo da Cloudflare a partir del bloque `assets` de `wrangler.jsonc`:
 * es el sitio ya construido (`dist/`). El Worker lo pide con `fetch` y después
 * reescribe el `<head>` antes de devolverlo.
 *
 * `SISTEMA` llegó en F3.5. `CRM` todavía no: `CanalWeb` no existe hasta F3.6,
 * y un binding a un entrypoint que no existe NO deja desplegar, así que cada
 * uno entra con la fase que lo crea.
 */
export interface Env {
  readonly ASSETS: Fetcher;

  /**
   * El sistema, por service binding (F3.5).
   *
   * No sale a internet: es una llamada dentro de la cuenta, sin token y sin
   * red pública. Y la superficie es la de `SistemaWeb` —catálogo, zonas,
   * salud—, no la del CRM: desde aquí no se puede tocar el inventario ni ver
   * un costo, aunque alguien se equivoque escribiendo código.
   */
  readonly SISTEMA?: SistemaWebBinding;

  /** Clave de Groq para `/api/chat`. Secreto: `wrangler secret put GROQ_API_KEY`. */
  readonly GROQ_API_KEY?: string;

  /** El dominio del sitio, para el canónico y Open Graph. */
  readonly SITE_URL?: string;

  /** La versión desplegada, que estampa el flujo con el SHA del commit. */
  readonly VERSION?: string;

  /**
   * El identificador de Cloudflare Web Analytics (F1.8).
   *
   * Va como variable y no como secreto a propósito: acaba escrito en el HTML
   * de cada página, así que no es un secreto por mucho que lo parezca. Vacío o
   * ausente, no se inyecta nada — que es lo que se quiere en las vistas
   * previas, para no contar visitas de prueba como si fueran clientas.
   *
   * La inserción AUTOMÁTICA de Cloudflare no sirve aquí: solo funciona con un
   * dominio propio detrás de su proxy, y la web todavía vive en workers.dev.
   * Por eso se pone a mano.
   */
  readonly CF_ANALYTICS_TOKEN?: string;
}
