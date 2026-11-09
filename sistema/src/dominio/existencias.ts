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

/** De una bodega concreta o del total: lo que se le dice a la clienta. */
export type Nivel = "hay" | "poco" | "agotado";

export function nivel(e: Existencia): Nivel {
  const libre = disponible(e);
  if (libre <= 0) return "agotado";
  if (e.minimo !== null && libre <= e.minimo) return "poco";
  return "hay";
}

/**
 * Lo ÚNICO que sale hacia el bot o hacia la web.
 *
 * La cantidad exacta de existencias no se le dice a nadie de fuera, igual que
 * el costo (regla del CRM, `docs/PLAN_CATALOGO_BABY_CALEB.md`): saber que
 * quedan tres cajas es información del negocio, no de la venta.
 */
export function etiqueta(e: Existencia): string {
  switch (nivel(e)) {
    case "hay":
      return "Disponible";
    case "poco":
      return "Quedan pocas";
    case "agotado":
      return "Agotado por ahora";
  }
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
