import type { SistemaWebBinding } from "./catalogo";

/**
 * Lo que `CanalWeb` del CRM expone (F3.6). Solo mandar un mensaje: desde la
 * web no se puede leer una conversación ajena, ni listar clientas, ni tocar el
 * inventario.
 */
export interface CanalWebBinding {
  mensajeWeb(entrada: { sesion: string; texto: string; nombre?: string }): Promise<
    | { ok: true; trozos: string[] }
    | { ok: false; codigo: "entrada_invalida" | "sin_respuesta"; mensaje: string }
  >;
}

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

  /**
   * El CRM, por service binding (F3.6): el chat de la web.
   *
   * Mientras no esté, `/api/chat` usa el camino viejo (Groq). El interruptor
   * es la PRESENCIA del binding y no una variable, porque un binding a un
   * entrypoint que no existe ni siquiera deja desplegar: si está, el CRM ya
   * tiene `CanalWeb` desplegado. Una variable podría decir «usa el CRM» con el
   * CRM sin actualizar, y el chat se quedaría mudo.
   */
  readonly CRM?: CanalWebBinding;

  /**
   * La llave del modelo para `/api/chat`. Secreto, puesto en Cloudflare.
   *
   * Se llama `_WEB` y no `META_API_KEY` aunque viva en otro Worker, donde no
   * chocaría. Es a propósito: con el mismo nombre, en el panel de Cloudflare
   * se ven dos secretos idénticos y no se sabe cuál es cuál sin abrir cada
   * Worker. Y si alguna termina en el sitio equivocado, el código NO la
   * encuentra y falla en voz alta, en vez de funcionar en silencio gastando el
   * límite del asistente de la dueña con el tráfico público.
   */
  readonly META_API_KEY_WEB?: string;

  /** El modelo del chat. Vacío = el del asistente interno. Es configuración. */
  readonly MODELO_CHAT?: string;

  /**
   * El límite de llamadas al chat, por IP.
   *
   * Opcional en el tipo porque en las pruebas no existe, y el chat tiene que
   * poder correr sin él. En producción SÍ está: sin límite, el formulario
   * abierto a internet es una factura esperando a que pase un rastreador.
   */
  readonly LIMITE_CHAT?: { limit(opciones: { key: string }): Promise<{ success: boolean }> };

  /** El dominio del sitio, para el canónico y Open Graph. */
  readonly SITE_URL?: string;
  /**
   * El sitio sale en buscadores SOLO con un sí explícito aquí.
   *
   * Nace apagado a propósito: `babycaleb.com` se conectó antes de que los
   * precios estuvieran aprobados y antes de que existieran las páginas
   * legales. Vacío, mal escrito o ausente = oculto, nunca al revés.
   *
   * Se enciende poniendo "si" en wrangler.jsonc. El estado sale en
   * /api/salud y el chequeo del despliegue lo dice en cada publicación, para
   * que nadie lo deje apagado sin querer.
   */
  readonly INDEXABLE?: string;

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
