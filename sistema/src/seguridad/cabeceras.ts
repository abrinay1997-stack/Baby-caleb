/**
 * Cabeceras de seguridad de las respuestas del Worker.
 *
 * Son las de docs/plan/07-seguridad.md §5. Van en el código y no en un archivo
 * `_headers` porque `_headers` solo se aplica a los estáticos: todo lo que
 * responde el Worker —el panel, la app del motorizado y `/api/*`— se queda sin
 * ellas si no se ponen aquí.
 *
 * Dos cosas quedan deliberadamente fuera:
 *
 *  - **La lista de proveedores de la CSP de la web** (componente de Yappy, SDK
 *    de PayPal, Turnstile, píxel de Meta). El plan la pone en F4, «con la lista
 *    exacta de cada proveedor»; inventarla ahora sería escribir dominios a ojo,
 *    y una CSP con un dominio de más es una CSP que no protege. Lo que hay aquí
 *    es la del panel y la ruta, que no cargan pasarelas.
 *  - **HSTS está apagado por defecto.** El plan lo condiciona a «después de
 *    confirmar que todo subdominio tiene HTTPS». Encenderlo con
 *    `includeSubDomains` antes de eso deja inaccesible, y durante un año, a
 *    cualquier subdominio que no lo tenga.
 */

export type Superficie = "panel" | "ruta" | "api";

export interface OpcionesCabeceras {
  superficie: Superficie;
  /**
   * Enciende `Strict-Transport-Security`. Solo cuando esté confirmado que todo
   * subdominio de babycaleb.com sirve HTTPS.
   */
  hsts?: boolean;
}

const UN_ANIO_S = 31_536_000;

/**
 * Interruptores de `wrangler.jsonc`: la convención es «si» / «no» en texto,
 * porque las variables de un Worker son cadenas y un `"false"` que se lee como
 * verdadero es un clásico.
 *
 * Toma `string | undefined` a propósito: `wrangler types` tipa cada variable
 * con su valor literal, así que comparar `env.HSTS === "si"` directamente lo
 * marcaría como imposible y el interruptor no se podría cambiar sin tocar
 * código. Pasar por aquí ensancha el tipo y deja que el valor manda en
 * ejecución, que es donde importa.
 *
 * Solo «si» enciende. Cualquier otra cosa —vacío, «true», un typo— deja la
 * cosa apagada, que para una cabecera de seguridad es el lado correcto.
 */
export const encendido = (valor: string | undefined): boolean => valor === "si";

/**
 * La CSP del panel y de la app del motorizado: todo propio. El panel es un SPA
 * que se sirve del mismo Worker, así que no necesita ningún dominio externo.
 * `'unsafe-inline'` queda fuera a propósito; si alguna vez hiciera falta un
 * script en línea, lleva nonce.
 */
const CSP_PROPIA = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https://mapas.babycaleb.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * `camera=(self)` solo en la ruta del motorizado, que necesita la foto de
 * entrega. En el panel la cámara está apagada: nada ahí la usa, y un permiso
 * que no se usa es superficie regalada.
 */
const PERMISOS_POR_SUPERFICIE: Record<Superficie, string> = {
  panel: "geolocation=(), camera=(), microphone=()",
  ruta: "geolocation=(self), camera=(self), microphone=()",
  api: "geolocation=(), camera=(), microphone=()",
};

export function cabecerasDeSeguridad(opciones: OpcionesCabeceras): Record<string, string> {
  const cabeceras: Record<string, string> = {
    "Content-Security-Policy": CSP_PROPIA,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISOS_POR_SUPERFICIE[opciones.superficie],
    // El panel, la ruta y la API no se indexan nunca. No hay nada ahí para
    // nadie de fuera, y un buscador que entre solo puede filtrar rutas.
    "X-Robots-Tag": "noindex, nofollow",
    "Cross-Origin-Opener-Policy": "same-origin",
  };

  if (opciones.hsts) {
    cabeceras["Strict-Transport-Security"] = `max-age=${UN_ANIO_S}; includeSubDomains`;
  }

  return cabeceras;
}

/** Devuelve la respuesta con las cabeceras puestas, sin pisar las que ya trae. */
export function conCabecerasDeSeguridad(
  respuesta: Response,
  opciones: OpcionesCabeceras,
): Response {
  const salida = new Response(respuesta.body, respuesta);
  for (const [nombre, valor] of Object.entries(cabecerasDeSeguridad(opciones))) {
    if (!salida.headers.has(nombre)) salida.headers.set(nombre, valor);
  }
  return salida;
}

/**
 * Qué superficie es, por el hostname. `ruta.` y `panel.` son los dos dominios
 * de `babycaleb-sistema` (01-arquitectura.md §3); cualquier otra cosa se trata
 * como API, que es lo más restrictivo.
 */
export function superficieDe(hostname: string): Superficie {
  const host = hostname.toLowerCase();
  if (host.startsWith("ruta.")) return "ruta";
  if (host.startsWith("panel.")) return "panel";
  return "api";
}
