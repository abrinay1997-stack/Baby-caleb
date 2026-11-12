/**
 * La decisión de la persona sobre el rastreo, y dónde vive.
 *
 * ## Por qué existe esto
 *
 * Baby Caleb va a instalar el píxel de Meta. Un píxel es un rastreador de un
 * TERCERO: no mide esta página, le cuenta a Meta que usted pasó por aquí. En
 * Panamá rige la Ley 81 de 2019 de protección de datos personales, y la
 * lectura que se aplica aquí es la conservadora: eso no se carga antes de que
 * la persona lo acepte.
 *
 * ## Tres opciones, no dos
 *
 * Aceptar, rechazar, y poder cambiar de opinión después. Un banner con un solo
 * botón grande que dice «Entendido» no es una elección, y uno que esconde el
 * «no» detrás de tres pantallas tampoco. Rechazar aquí significa rechazar: no
 * se carga el píxel, ni «solo para medir», ni más tarde.
 *
 * ## Por qué en el navegador y no en un servidor
 *
 * La decisión se guarda en `localStorage` y no viaja a ningún sitio. Guardarla
 * en el servidor obligaría a identificar el navegador para poder volver a
 * leerla — o sea, a rastrear a alguien para recordar que no quiere que lo
 * rastreen. Guardar menos es mejor.
 *
 * Lo que se pierde es que la decisión no se comparte entre dispositivos: quien
 * entre desde otro teléfono la verá otra vez. Es el precio correcto.
 *
 * ## TODO ACCESO VA EN `try`
 *
 * No es paranoia de manual: `localStorage` **lanza una excepción** —no
 * devuelve vacío— en ventana privada de Safari, con el almacenamiento del
 * sitio bloqueado y cuando la cuota está llena. La lección ya está escrita en
 * `src/carrito/almacen.ts`. Y aquí el fallo tiene un lado seguro muy claro: si
 * no se puede leer la decisión, no hay decisión, y sin decisión el píxel NO se
 * carga.
 */

/** Lo que la persona decidió. `null` —la ausencia— es «todavía no ha elegido». */
export type Decision = "aceptado" | "rechazado";

/**
 * La versión va en la CLAVE, como en el carrito.
 *
 * El día que haya más de un rastreador que consentir, la clave nueva no
 * encuentra nada y vuelve a preguntar — en vez de leer un «sí» viejo y
 * estirarlo a algo que la persona nunca aceptó. Un consentimiento heredado no
 * es un consentimiento.
 */
const CLAVE = "bc.consentimiento.v1";

/** El evento con el que el pie de página vuelve a abrir el banner. */
export const EVENTO_ABRIR = "bc:abrir-consentimiento";

/** El evento con el que el banner avisa de que la decisión cambió. */
export const EVENTO_DECIDIDO = "bc:consentimiento-decidido";

const esDecision = (v: unknown): v is Decision => v === "aceptado" || v === "rechazado";

/**
 * Qué decidió esta persona, o `null` si no ha decidido.
 *
 * Cualquier cosa guardada que no sea exactamente una de las dos palabras se
 * trata como «no ha decidido»: lo que hay en `localStorage` lo pudo editar
 * cualquiera, y la única interpretación segura de un valor que no se entiende
 * es la que no carga nada.
 */
export function leerDecision(): Decision | null {
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    return esDecision(crudo) ? crudo : null;
  } catch {
    return null;
  }
}

export function guardarDecision(decision: Decision): void {
  try {
    window.localStorage.setItem(CLAVE, decision);
  } catch {
    // Sin permiso para guardar, la decisión vale para esta pestaña y se
    // olvida al cerrarla. Se vuelve a preguntar, que es molesto y correcto:
    // la alternativa sería dar por supuesto un «sí» que nadie puede leer.
  }
}

/** Olvida la decisión: la próxima visita vuelve a preguntar. */
export function olvidarDecision(): void {
  try {
    window.localStorage.removeItem(CLAVE);
  } catch {
    /* ídem */
  }
}
