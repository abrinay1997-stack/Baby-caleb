/**
 * Máquina de estados de un envío.
 *
 * Portado de `packages/domain/src/shipment-state.ts` de Nébula, que ya usa
 * exactamente los ocho estados de `envios.estado` en Baby Caleb
 * (docs/plan/02-datos.md §5). Las transiciones se conservan tal cual, con los
 * motivos originales: están razonadas y son las mismas aquí.
 *
 * Existe por lo mismo que la de pedidos: sin ella, cualquier pantalla puede
 * mover un envío a donde le parezca. Y aquí importa más, porque quien mueve
 * estos estados no es alguien sentado en un panel: es alguien en la calle, con
 * una mano en el manillar, tocando un botón en el teléfono. Los toques
 * accidentales existen, y un envío que vuelve de «entregado» a «en ruta» deja a
 * la clienta mirando una mentira.
 *
 * Un pedido y un envío son cosas distintas y por eso son máquinas distintas: un
 * pedido puede tener varios envíos —dos viajes, o una entrega fallida y su
 * reintento— y cada uno va por su cuenta.
 */

export const ESTADOS_ENVIO = [
  "pendiente",
  "asignado",
  "recogido",
  "en_ruta",
  "entregado",
  "fallido",
  "devuelto",
  "anulado",
] as const;

export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

export const esEstadoEnvio = (v: string): v is EstadoEnvio =>
  (ESTADOS_ENVIO as readonly string[]).includes(v);

/**
 * Qué se lee en pantalla. Se escriben desde el punto de vista de quien mira, no
 * del sistema: la clienta entiende «va en camino», no «en_ruta».
 */
export const ETIQUETAS_ENVIO: Record<EstadoEnvio, string> = {
  pendiente: "Pendiente de asignar",
  asignado: "Asignado",
  recogido: "Recogido",
  en_ruta: "Va en camino",
  entregado: "Entregado",
  fallido: "Entrega fallida",
  devuelto: "Devuelto",
  anulado: "Anulado",
};

const TRANSICIONES: Record<EstadoEnvio, readonly EstadoEnvio[]> = {
  // «Anulado» solo se alcanza desde «pendiente», y es a propósito: es el único
  // estado en el que el envío todavía no es nada —sin motorizado, sin salir,
  // sin nadie esperándolo—. Desde «asignado» ya hay una persona con una tarea,
  // y desde «recogido» hay un paquete en la calle: eso es «fallido» o
  // «devuelto», que es lo que de verdad pasó.
  pendiente: ["asignado", "fallido", "anulado"],
  asignado: ["recogido", "pendiente", "fallido"],
  recogido: ["en_ruta", "fallido"],
  en_ruta: ["entregado", "fallido"],
  // Un intento fallido se reintenta —vuelve a la cola— o se devuelve. No pasa a
  // «entregado» directamente: si al final se entregó, hubo un segundo intento y
  // ese intento merece constar.
  fallido: ["pendiente", "devuelto"],
  // Terminales. «Anulado» también: un envío anulado no se resucita. Si el
  // pedido vuelve a despacharse es un envío nuevo, con su guía y su token.
  entregado: [],
  devuelto: [],
  anulado: [],
};

export function puedeCambiarEnvio(de: EstadoEnvio, a: EstadoEnvio): boolean {
  if (de === a) return true;
  return TRANSICIONES[de].includes(a);
}

export function transicionesEnvio(de: EstadoEnvio): readonly EstadoEnvio[] {
  return TRANSICIONES[de];
}

export function esTerminalEnvio(estado: EstadoEnvio): boolean {
  return TRANSICIONES[estado].length === 0;
}

/**
 * ¿Ya salió de la bodega?
 *
 * Lo usa el panel para no dejar cambiar la dirección ni la bodega de un envío
 * que ya va por la calle: cambiarla ahí no cambia dónde está yendo quien la
 * lleva, solo hace que el sistema y la realidad dejen de coincidir. Es la misma
 * razón por la que el plan permite mover la bodega solo antes de «recogido»
 * (02-datos.md §5).
 */
export function estaEnLaCalle(estado: EstadoEnvio): boolean {
  return estado === "recogido" || estado === "en_ruta";
}

/**
 * Los dos únicos estados que puede marcar cualquiera que tenga la guía en la
 * mano, por el QR, sin sesión. Quien recibe puede no ser quien lleva.
 */
export const ESTADOS_CON_LA_GUIA = [
  "entregado",
  "fallido",
] as const satisfies readonly EstadoEnvio[];

/**
 * Lo que puede marcar un motorizado identificado desde `ruta.babycaleb.com`
 * (celular + PIN, docs/plan/01-arquitectura.md §3).
 *
 * Son más que los de arriba, y la diferencia no es de comodidad sino de quién
 * está al otro lado: esta lista la marca alguien con su ficha de motorizado
 * detrás, así que también puede decir que recogió el paquete y que va en camino.
 *
 * Lo que queda fuera para los dos: asignar y devolver. Son decisiones de quien
 * despacha, y se toman desde el panel.
 */
export const ESTADOS_DEL_MOTORIZADO = [
  "recogido",
  "en_ruta",
  "entregado",
  "fallido",
] as const satisfies readonly EstadoEnvio[];

export const esEstadoDelMotorizado = (v: string): boolean =>
  (ESTADOS_DEL_MOTORIZADO as readonly string[]).includes(v);

export interface ErrorDeEnvio {
  de: EstadoEnvio;
  a: EstadoEnvio;
  mensaje: string;
}

/** Valida un cambio de estado antes de tocar la base. */
export function validarTransicionEnvio(de: EstadoEnvio, a: EstadoEnvio): ErrorDeEnvio | null {
  if (puedeCambiarEnvio(de, a)) return null;
  return {
    de,
    a,
    mensaje: `Un envío «${ETIQUETAS_ENVIO[de]}» no puede pasar a «${ETIQUETAS_ENVIO[a]}».`,
  };
}
