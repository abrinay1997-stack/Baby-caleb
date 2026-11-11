/**
 * Cuántas unidades de un combo se pueden armar.
 *
 * Un combo no tiene existencias propias: no hay una caja en la bodega que
 * ponga «combo». Lo que hay son sus componentes, y de un combo caben tantos
 * como permita **el que menos alcance**. Dos pañales y un paquete de wipes
 * por combo, con 10 pañales y 3 wipes, dan 3 combos — no 5, aunque los
 * pañales den para 5.
 *
 * Por eso es una función pura con sus pruebas y no una consulta SQL: es la
 * regla de la que depende que el bot no prometa un combo que no se puede
 * armar, y la quiero poder romper a propósito para comprobar que se nota.
 */

export interface Componente {
  readonly codigo: string;
  /** Cuántas unidades de este componente lleva UN combo. */
  readonly cantidad: number;
  /** Lo que de verdad queda libre de ese componente (fisico - reservado). */
  readonly libres: number;
}

/**
 * Cuántos combos se pueden armar hoy.
 *
 * **Un combo sin componentes da 0, no infinito.** Es el caso que parece de
 * laboratorio y no lo es: una receta a medio llenar, o un componente que
 * alguien borró. Devolver «ilimitado» ahí haría que el bot ofreciera sin
 * límite algo que no existe, y el error se descubriría con una clienta
 * esperando.
 */
export function cuantosCombos(componentes: readonly Componente[]): number {
  if (componentes.length === 0) return 0;

  let menor = Infinity;
  for (const c of componentes) {
    // Una cantidad que no es un entero positivo no es una receta: es un dato
    // roto. Se trata como «no se puede armar» en vez de dividir por cero o
    // redondear hacia algo que suene bien.
    if (!Number.isSafeInteger(c.cantidad) || c.cantidad <= 0) return 0;
    if (!Number.isSafeInteger(c.libres) || c.libres < 0) return 0;

    const caben = Math.floor(c.libres / c.cantidad);
    if (caben < menor) menor = caben;
    // Uno agotado deja el combo en cero, y no hace falta mirar el resto.
    if (menor === 0) return 0;
  }
  return menor;
}

/**
 * Qué componentes son los que frenan el combo.
 *
 * Para la pantalla: «no se puede armar» a secas obliga a Yarielis a ir mirando
 * uno por uno cuál falta. Esto le dice cuál reponer.
 */
export function loQueFrena(componentes: readonly Componente[]): string[] {
  const total = cuantosCombos(componentes);
  return componentes
    .filter((c) => {
      if (!Number.isSafeInteger(c.cantidad) || c.cantidad <= 0) return true;
      return Math.floor(c.libres / c.cantidad) === total;
    })
    .map((c) => c.codigo);
}

/**
 * Lo que hay que reservar de cada componente para vender `cuantos` combos.
 *
 * Se devuelve explícito —y no se calcula al vuelo donde haga falta— porque es
 * lo que entra en el mismo batch que el pedido. Vender un combo sin apartar
 * sus piezas es vender dos veces el mismo pañal.
 */
export function aReservar(
  componentes: readonly Componente[],
  cuantos: number,
): { codigo: string; cantidad: number }[] {
  if (!Number.isSafeInteger(cuantos) || cuantos <= 0) return [];
  return componentes.map((c) => ({ codigo: c.codigo, cantidad: c.cantidad * cuantos }));
}
