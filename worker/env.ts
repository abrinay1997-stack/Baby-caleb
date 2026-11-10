/**
 * Lo que el Worker de la web tiene a mano.
 *
 * `ASSETS` lo da Cloudflare a partir del bloque `assets` de `wrangler.jsonc`:
 * es el sitio ya construido (`dist/`). El Worker lo pide con `fetch` y después
 * reescribe el `<head>` antes de devolverlo.
 *
 * Los bindings al sistema y al CRM NO están todavía y es a propósito: el
 * ejemplo de 01-arquitectura §3 los incluye, pero `babycaleb-sistema` aún no
 * se despliega a producción y `CanalWeb` del CRM no existe hasta F3.6. Un
 * binding a un entrypoint que no existe NO deja desplegar, así que entran con
 * la fase que los crea (SISTEMA en F3.5, CRM en F3.6).
 */
export interface Env {
  readonly ASSETS: Fetcher;

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
