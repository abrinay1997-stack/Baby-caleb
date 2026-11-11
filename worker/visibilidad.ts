/**
 * Quién puede ver este sitio en Google, y por qué dirección.
 *
 * Dos decisiones que viven juntas porque se equivocan juntas.
 *
 * ## 1. El interruptor de indexación
 *
 * `babycaleb.com` se conecta ANTES de estar listo para buscadores: los precios
 * todavía salen de la base de pruebas y no existen las páginas legales. Que el
 * dominio sirva es útil (verificarlo en Google y en Meta, emitir el
 * certificado, comprobar que todo responde); que Google GUARDE esas páginas no
 * lo es, y deshacerlo tarda semanas.
 *
 * Así que el sitio nace oculto y se enciende a propósito. Lo que da miedo de
 * esto es lo contrario: lanzar y que a nadie se le ocurra quitarlo, con el
 * sitio invisible durante meses. Por eso el estado NO es silencioso — sale en
 * `/api/salud` y el chequeo del despliegue lo dice en voz alta en cada
 * publicación.
 *
 * El valor por defecto es «oculto». Una variable vacía, mal escrita o ausente
 * deja el sitio fuera de Google, nunca dentro: equivocarse hacia el lado que se
 * nota es mejor que equivocarse hacia el que no.
 *
 * ## 2. Una sola dirección
 *
 * Aunque el interruptor esté encendido, la copia de `workers.dev` NO se indexa
 * jamás. Si se indexara, Google tendría dos sitios idénticos compitiendo y
 * repartiría entre ellos lo que debería ir a uno. Lo mismo con `www`, que se
 * redirige a seco (301) en vez de servir una copia.
 */

/** Encendido solo con un sí explícito. Cualquier otra cosa es «oculto». */
const ENCENDIDO = new Set(["si", "sí", "true", "1", "on"]);

export const quiereIndexarse = (interruptor: string | undefined): boolean =>
  ENCENDIDO.has((interruptor ?? "").trim().toLowerCase());

/**
 * ¿Esta petición concreta puede salir en buscadores?
 *
 * Hacen falta las dos cosas: el interruptor encendido Y que la petición venga
 * por la dirección oficial. Sin `sitioCanonico` configurado no hay dirección
 * oficial que valga, así que no se indexa nada.
 */
export function seIndexa(
  sitioCanonico: string,
  host: string,
  interruptor: string | undefined,
): boolean {
  if (!quiereIndexarse(interruptor)) return false;
  const oficial = hostDe(sitioCanonico);
  if (oficial === null) return false;
  return host.toLowerCase() === oficial;
}

/**
 * Si la petición llega por `www`, a dónde mandarla. `null` si ya está bien.
 *
 * Solo `www`. La copia de `workers.dev` NO se redirige: es la que se usa para
 * comparar antes de cada corte, y mandarla al dominio real la volvería inútil
 * justo cuando hace falta.
 */
export function redireccionCanonica(sitioCanonico: string, url: URL): string | null {
  const oficial = hostDe(sitioCanonico);
  if (oficial === null) return null;

  const host = url.hostname.toLowerCase();
  if (host !== `www.${oficial}`) return null;

  const destino = new URL(url.toString());
  destino.protocol = "https:";
  destino.hostname = oficial;
  destino.port = "";
  return destino.toString();
}

function hostDe(sitio: string): string | null {
  const limpio = (sitio ?? "").trim();
  if (limpio === "") return null;
  try {
    return new URL(limpio).hostname.toLowerCase();
  } catch {
    return null;
  }
}
