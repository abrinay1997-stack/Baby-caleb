/**
 * Reglas de disponibilidad de inventario.
 *
 * Portado de `packages/domain/src/stock.ts` de Nébula y adaptado a la tabla
 * `existencias` de Baby Caleb (docs/plan/02-datos.md §3), que tiene `fisico`,
 * `reservado` y `minimo` — y NO tiene los `trackInventory` ni `allowBackorder`
 * de Nébula: aquí todo producto se controla y no se vende lo que no hay.
 *
 * «Disponible» nunca es `fisico` a secas: hay unidades comprometidas en
 * pedidos sin entregar, y venderlas otra vez es cancelarle la compra a alguien.
 */

export interface Existencia {
  /** Unidades en la bodega, incluidas las comprometidas. */
  fisico: number;
  /** Comprometidas en pedidos sin entregar. La base obliga a reservado <= fisico. */
  reservado: number;
  /** Umbral de alerta. null = esta variante no avisa. */
  minimo: number | null;
}

export function disponible(e: Existencia): number {
  return Math.max(e.fisico - e.reservado, 0);
}

export function puedeDespachar(e: Existencia, pedidas: number): boolean {
  if (!Number.isInteger(pedidas) || pedidas <= 0) return false;
  return disponible(e) >= pedidas;
}

/**
 * Lo ÚNICO que sale hacia el bot o hacia la web.
 *
 * Los tres valores y el nombre son los del CRM (`src/catalog/validation.ts`,
 * `Disponibilidad`) y los que exige el contrato (03-contratos.md §1). No se
 * renombran: el CRM ya los usa y el bot ya los dice.
 *
 * La cantidad exacta no se le dice a nadie de fuera, igual que el costo: «si
 * nunca tiene la cifra exacta, no la puede soltar por error» (comentario del
 * propio CRM). Saber que quedan tres cajas es información del negocio.
 */
export type Disponibilidad = "disponible" | "pocas" | "agotado";

/**
 * Valor de fábrica del umbral de «pocas». Es el `STOCK_BAJO` del CRM, que el
 * plan manda pasar a `ajustes` para que la dueña lo pueda cambiar; esto es solo
 * el piso cuando no hay nada configurado.
 */
export const UMBRAL_POCAS = 5;

/**
 * La etiqueta según las unidades libres.
 *
 * El `<` es estricto, igual que en el CRM: con el umbral en 5, cinco cajas son
 * «disponible» y cuatro son «pocas». Parece un detalle y no lo es — es la
 * diferencia entre que el bot diga lo mismo antes y después del traspaso.
 */
export function disponibilidad(libres: number, umbral = UMBRAL_POCAS): Disponibilidad {
  if (libres <= 0) return "agotado";
  if (libres < umbral) return "pocas";
  return "disponible";
}

export function disponibilidadDe(e: Existencia, umbral = UMBRAL_POCAS): Disponibilidad {
  return disponibilidad(disponible(e), umbral);
}

/**
 * ¿Hay que avisarle a la dueña de esta existencia?
 *
 * Aquí sí manda `existencias.minimo`, y por eso es distinto de la etiqueta: el
 * umbral de lo que se le DICE a la clienta es uno y global (`ajustes`), y el de
 * cuándo se AVISA a la dueña es por variante y bodega, porque de unos productos
 * conviene enterarse antes que de otros. `minimo` en NULL apaga el aviso de
 * esta fila, no la etiqueta.
 */
export function debeAlertar(e: Existencia): boolean {
  if (e.minimo === null) return false;
  return disponible(e) <= e.minimo;
}

/** El texto que se muestra. La etiqueta no lleva números. */
export const TEXTO_DISPONIBILIDAD: Record<Disponibilidad, string> = {
  disponible: "Disponible",
  pocas: "Quedan pocas",
  agotado: "Agotado por ahora",
};

export function etiqueta(e: Existencia, umbral = UMBRAL_POCAS): string {
  return TEXTO_DISPONIBILIDAD[disponibilidadDe(e, umbral)];
}

/** Suma varias bodegas para responder «¿hay o no hay?» sin decir dónde ni cuántas. */
export function consolidar(existencias: readonly Existencia[]): Existencia {
  return {
    fisico: existencias.reduce((t, e) => t + e.fisico, 0),
    reservado: existencias.reduce((t, e) => t + e.reservado, 0),
    // El umbral consolidado es el mayor de los definidos: si una bodega pide
    // avisar antes, se avisa antes.
    minimo: existencias.reduce<number | null>(
      (t, e) => (e.minimo === null ? t : t === null ? e.minimo : Math.max(t, e.minimo)),
      null,
    ),
  };
}

/** Qué líneas de un pedido no se pueden despachar de una bodega. */
export function faltantes<L extends { codigo: string; cantidad: number }>(
  lineas: readonly L[],
  existenciaPorCodigo: (codigo: string) => Existencia | undefined,
): { codigo: string; pedidas: number; disponibles: number }[] {
  const faltan: { codigo: string; pedidas: number; disponibles: number }[] = [];
  for (const l of lineas) {
    const e = existenciaPorCodigo(l.codigo);
    const libres = e ? disponible(e) : 0;
    if (!e || !puedeDespachar(e, l.cantidad)) {
      faltan.push({ codigo: l.codigo, pedidas: l.cantidad, disponibles: libres });
    }
  }
  return faltan;
}
