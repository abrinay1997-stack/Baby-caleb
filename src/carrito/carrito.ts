/**
 * El carrito: qué lleva la clienta, y nada más.
 *
 * LA DECISIÓN QUE DEFINE ESTE ARCHIVO
 *
 * Un carrito guarda **códigos y cantidades**. No guarda precios, ni nombres, ni
 * totales. No es una simplificación: es la frontera de seguridad.
 *
 * El carrito vive en el navegador de la clienta, en `localStorage`, que ella
 * puede abrir y editar con dos clics. Si aquí hubiera un precio, ese precio
 * sería editable, y el pedido se crearía con lo que diga el navegador. Guardar
 * solo el código obliga a que el precio salga de D1 en el servidor, cada vez.
 *
 * Es la misma regla que ya está escrita en `sistema/src/db/pedidos.ts` —«las
 * líneas, con el precio y el nombre del SERVIDOR»— y en el `CLAUDE.md` del
 * repositorio: **el navegador no decide un pago**. Este archivo es su mitad
 * del lado del navegador.
 *
 * Lo que se ve en pantalla —el precio de cada línea, el subtotal— se calcula al
 * pintar, cruzando estos códigos con el catálogo que llega de `/api/catalogo`.
 * Es un número para que ella se oriente, no el número que se cobra.
 */

/** Una línea: un código del catálogo y cuántas unidades. Nada más. */
export interface LineaCarrito {
  readonly codigo: string;
  readonly cantidad: number;
}

/**
 * El carrito entero.
 *
 * Una lista y no un mapa porque el ORDEN importa para quien mira: lo que
 * agregó primero sale primero, y un mapa reordenado al guardar y recuperar
 * haría que la lista baile entre cargas sin motivo visible.
 */
export interface Carrito {
  readonly lineas: readonly LineaCarrito[];
}

export const VACIO: Carrito = { lineas: [] };

/**
 * El tope por línea: 99.
 *
 * NO es una regla del negocio y por eso no vive en `ajustes`. Es un límite de
 * cordura contra un dedo torpe en un teléfono: un `9` repetido convierte «2
 * cajas» en «999 cajas», y sin tope eso intenta apartar todo el inventario y
 * revienta en el servidor con un error que la clienta no entiende.
 *
 * Quién decide de verdad si hay suficiente es la reserva en D1, que hace
 * fallar el pedido entero si las existencias libres quedarían en negativo. El
 * carrito no puede saberlo: el catálogo público expone a propósito
 * `disponible`/`pocas`/`agotado` y NUNCA la cantidad exacta, porque la
 * cantidad de stock es un dato del negocio que no sale hacia afuera.
 *
 * Así que esto no comprueba disponibilidad. Solo evita el absurdo.
 */
export const MAXIMO_POR_LINEA = 99;

/** El código más largo que aceptamos. Más que eso no es un código: es basura. */
const MAXIMO_LARGO_CODIGO = 64;

/**
 * Si un código tiene la forma de un código.
 *
 * No comprueba que exista —eso lo sabe el catálogo, no el carrito—, solo que
 * sea algo que valga la pena preguntar. Un `localStorage` manipulado puede
 * traer cualquier cosa, y una clave con un salto de línea o de diez kilobytes
 * acaba en una URL o en una consulta.
 */
export function esCodigoPlausible(codigo: unknown): codigo is string {
  return (
    typeof codigo === "string" &&
    codigo.length > 0 &&
    codigo.length <= MAXIMO_LARGO_CODIGO &&
    /^[A-Za-z0-9_-]+$/.test(codigo)
  );
}

/** Deja la cantidad en un entero entre 1 y el tope. `0` o menos significa quitar. */
function cantidadSana(cantidad: number): number {
  if (!Number.isFinite(cantidad)) return 0;
  const entero = Math.trunc(cantidad);
  if (entero <= 0) return 0;
  return Math.min(entero, MAXIMO_POR_LINEA);
}

/**
 * Agrega unidades de un código, o las suma a la línea que ya estaba.
 *
 * Suma en vez de reemplazar porque es lo que espera quien toca «Agregar» dos
 * veces: la segunda vez quiere dos, no volver a tener una.
 */
export function agregar(carrito: Carrito, codigo: string, cantidad = 1): Carrito {
  if (!esCodigoPlausible(codigo)) return carrito;
  const suma = cantidadSana(cantidad);
  if (suma === 0) return carrito;

  const ya = carrito.lineas.find((l) => l.codigo === codigo);
  if (ya === undefined) {
    return { lineas: [...carrito.lineas, { codigo, cantidad: suma }] };
  }
  // El tope se aplica al TOTAL de la línea, no a lo que se suma: sin esto,
  // tocar «Agregar» cien veces pasa de 99 igualmente.
  return ponerCantidad(carrito, codigo, ya.cantidad + suma);
}

/**
 * Fija la cantidad de una línea. Cero o menos la quita.
 *
 * Que `0` quite la línea en vez de dejarla en cero es deliberado: una línea en
 * cero se ve en pantalla como algo que está en el carrito sin estarlo, y la
 * clienta tiene que tocar otra cosa para hacerla desaparecer.
 */
export function ponerCantidad(carrito: Carrito, codigo: string, cantidad: number): Carrito {
  const sana = cantidadSana(cantidad);
  if (sana === 0) return quitar(carrito, codigo);
  return {
    lineas: carrito.lineas.map((l) => (l.codigo === codigo ? { codigo, cantidad: sana } : l)),
  };
}

export function quitar(carrito: Carrito, codigo: string): Carrito {
  return { lineas: carrito.lineas.filter((l) => l.codigo !== codigo) };
}

export function vaciar(): Carrito {
  return VACIO;
}

/** Cuántas unidades lleva en total: el número de la burbujita. */
export function unidades(carrito: Carrito): number {
  return carrito.lineas.reduce((n, l) => n + l.cantidad, 0);
}

export function cantidadDe(carrito: Carrito, codigo: string): number {
  return carrito.lineas.find((l) => l.codigo === codigo)?.cantidad ?? 0;
}

export const estaVacio = (carrito: Carrito): boolean => carrito.lineas.length === 0;

/**
 * Limpia lo que venga de `localStorage`.
 *
 * Todo lo que sale de ahí es ENTRADA NO CONFIABLE, aunque lo escribiéramos
 * nosotros: lo pudo editar quien quiera, o lo pudo dejar a medias una versión
 * vieja del sitio. Una línea con un código raro, una cantidad en texto, un
 * duplicado o un objeto entero en lugar de una lista no deben romper la
 * página: se descartan en silencio y el resto del carrito sobrevive.
 *
 * Perder una línea rota es molesto. Una pantalla en blanco en el carrito es
 * una venta perdida.
 */
export function desdeGuardado(crudo: unknown): Carrito {
  if (crudo === null || typeof crudo !== "object") return VACIO;
  const lineas = (crudo as { lineas?: unknown }).lineas;
  if (!Array.isArray(lineas)) return VACIO;

  const vistos = new Set<string>();
  const limpias: LineaCarrito[] = [];
  for (const l of lineas) {
    if (l === null || typeof l !== "object") continue;
    const { codigo, cantidad } = l as { codigo?: unknown; cantidad?: unknown };
    if (!esCodigoPlausible(codigo)) continue;
    if (typeof cantidad !== "number") continue;
    const sana = cantidadSana(cantidad);
    if (sana === 0) continue;
    // Un código repetido se queda con la primera línea en vez de sumarse: si
    // el archivo guardado está duplicado, sumar inventaría una cantidad que la
    // clienta nunca pidió.
    if (vistos.has(codigo)) continue;
    vistos.add(codigo);
    limpias.push({ codigo, cantidad: sana });
  }
  return { lineas: limpias };
}
