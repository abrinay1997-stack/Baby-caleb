/**
 * Por dónde se contacta a Baby Caleb.
 *
 * Existe porque este número estaba escrito a mano en SEIS archivos
 * (`S01Nav`, `S09Products`, `S10Gallery`, `S13Tips`, `Chatbot`,
 * `FichaProducto`). El día que cambie, seis sitios tienen que acordarse, y el
 * que se olvide manda a las clientas a un número que ya no contesta sin que
 * nada falle ni avise.
 *
 * No es un dato del negocio que viva en D1: es contacto público del sitio, y
 * cambia cuando cambia la web. Pero vive en UN solo sitio.
 */

/** Celular de WhatsApp en formato internacional sin `+`, como lo quiere wa.me. */
export const WHATSAPP_E164 = '50767575065';

export const WHATSAPP_URL = `https://wa.me/${WHATSAPP_E164}`;

/**
 * Un enlace de WhatsApp con el mensaje ya escrito.
 *
 * Codifica el texto aquí para que ningún sitio se olvide: un mensaje con un
 * `&` o un salto de línea sin codificar llega cortado, y se corta justo donde
 * estaba lo que la clienta quería pedir.
 */
export const whatsappCon = (mensaje: string): string =>
  `${WHATSAPP_URL}?text=${encodeURIComponent(mensaje)}`;
