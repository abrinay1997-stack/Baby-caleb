/**
 * El identificador de la conversación del chat (F3.6).
 *
 * Es lo que agrupa los mensajes de una misma persona en UNA conversación del
 * CRM, en vez de abrir una nueva con cada pregunta. Antes no hacía falta
 * porque el chat de la web no guardaba nada: el navegador mandaba el historial
 * entero en cada mensaje y el modelo no sabía ni con quién hablaba.
 *
 * Lo que NO es: una identidad. Nadie ha dicho quién es — es un número al azar
 * que vive en este navegador. Por eso no se cruza con `clientes`. Cuando la
 * clienta deje su celular, ahí sí hay una persona, y de eso se encarga el
 * agente con `captureLead`.
 *
 * Sobrevive a recargar la página, pero no a borrar los datos del sitio ni a
 * cambiar de navegador. Eso es lo correcto: cualquier cosa más persistente
 * sería seguir a alguien que no ha pedido que lo sigan.
 */

const CLAVE = 'bc-chat-sesion';

/** Mismo formato que acepta `CanalWeb`: opaco, de 8 a 64 caracteres. */
const nuevo = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

// En memoria, para cuando el navegador no deja guardar: una ventana privada,
// o alguien que bloqueó el almacenamiento del sitio. El chat tiene que
// funcionar igual; lo que se pierde es que la conversación siga ahí mañana.
let enMemoria: string | null = null;

export function sesionDelChat(): string {
  if (enMemoria !== null) return enMemoria;

  try {
    const guardada = window.localStorage.getItem(CLAVE);
    if (guardada !== null && guardada.length >= 8) {
      enMemoria = guardada;
      return guardada;
    }
    const creada = nuevo();
    window.localStorage.setItem(CLAVE, creada);
    enMemoria = creada;
    return creada;
  } catch {
    // `localStorage` puede LANZAR, no solo devolver null: en una ventana
    // privada de Safari, escribir revienta. Sin este catch, el chat entero
    // dejaría de abrirse por no poder guardar un identificador.
    enMemoria = nuevo();
    return enMemoria;
  }
}
