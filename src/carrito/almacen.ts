import { type Carrito, VACIO, desdeGuardado } from "./carrito";

/**
 * Guardar el carrito entre visitas.
 *
 * Está aparte del carrito a propósito: el carrito es lógica pura y se prueba en
 * Node; esto habla con el navegador y no se puede probar ahí. Mezclarlos
 * dejaría la lógica sin pruebas.
 *
 * TODO ACCESO VA EN `try`. No es paranoia: `localStorage` **lanza una
 * excepción** —no devuelve vacío— en ventana privada de Safari, con las cookies
 * de sitio bloqueadas, y cuando la cuota está llena. Una excepción sin atrapar
 * aquí deja la página en blanco antes de pintar nada, y la clienta no ve un
 * carrito vacío: ve un sitio roto.
 *
 * Lo que se guarda vive SOLO en el navegador de esa persona y en ese
 * dispositivo. No viaja al servidor, no se comparte entre teléfonos y no es un
 * dato del negocio: si se pierde, se pierde una lista de compras, no un pedido.
 * El pedido existe cuando el servidor lo escribe en D1.
 */

const CLAVE = "bc.carrito.v1";

/**
 * La versión va en la CLAVE, no dentro del valor.
 *
 * Así, el día que la forma del carrito cambie, la clave nueva simplemente no
 * encuentra nada y empieza vacía — en vez de leer algo viejo e intentar
 * adivinar cómo convertirlo. Un carrito perdido no le cuesta nada a nadie; una
 * conversión mal hecha sí.
 */

export function leer(): Carrito {
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    if (crudo === null) return VACIO;
    // `desdeGuardado` ya trata esto como entrada no confiable: lo pudo editar
    // cualquiera. Aquí solo hay que lograr llegar hasta él.
    return desdeGuardado(JSON.parse(crudo));
  } catch {
    return VACIO;
  }
}

export function guardar(carrito: Carrito): void {
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(carrito));
  } catch {
    // Sin sitio o sin permiso: el carrito sigue funcionando en esta pestaña y
    // se olvida al cerrarla. Es peor avisar de esto que callarlo: no hay nada
    // que la clienta pueda hacer al respecto.
  }
}

export function olvidar(): void {
  try {
    window.localStorage.removeItem(CLAVE);
  } catch {
    /* ídem */
  }
}

/**
 * Avisa cuando OTRA pestaña cambió el carrito.
 *
 * Dos pestañas del mismo sitio es lo normal en un teléfono —se abre una ficha
 * de producto desde WhatsApp sin cerrar la anterior—, y sin esto cada pestaña
 * tiene su propia idea del carrito y la última que guarda gana. El evento
 * `storage` solo lo reciben las OTRAS pestañas, nunca la que escribió, así que
 * no hay bucle.
 */
export function alCambiarEnOtraPestana(avisar: (c: Carrito) => void): () => void {
  const mano = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== CLAVE) return;
    avisar(leer());
  };
  try {
    window.addEventListener("storage", mano);
  } catch {
    return () => {};
  }
  return () => {
    try {
      window.removeEventListener("storage", mano);
    } catch {
      /* la página se está cerrando */
    }
  };
}
