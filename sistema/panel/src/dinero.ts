/**
 * Lo que la persona teclea → centavos.
 *
 * Parece de una línea y no lo es. `12.50 * 100` da 1250, pero `1.15 * 100` da
 * 114.99999999999999, y un `Math.floor` ahí le cobra un centavo de menos a cada
 * clienta para siempre. Por eso se redondea, y por eso esto vive aparte con sus
 * pruebas en vez de dentro de un `onChange`.
 *
 * Acepta lo que la gente escribe de verdad: «12.50», «12,50», «$12.50», « 12 ».
 * La coma decimal es lo normal en Panamá y rechazarla sería hacerle pelear a
 * Yarielis con el teclado.
 */

/** `null` si no es un monto válido. No adivina: devuelve nada. */
export function aCentavos(texto: string): number | null {
  const limpio = texto.trim().replace(/^\$/, "").replace(",", ".").replace(/\s/g, "");
  if (limpio === "") return null;
  // Un solo punto decimal y hasta dos decimales. «12.5.0» y «12.555» no son
  // montos, son erratas, y aceptarlas redondeando esconde el error.
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;

  const n = Number(limpio);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Centavos → lo que se mete en el campo para editarlo. Sin símbolo. */
export function deCentavos(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

/**
 * Puntos básicos ↔ por ciento. 700 = 7 %.
 *
 * El ITBMS se guarda en puntos básicos y no en por ciento porque 7 % de un
 * monto en centavos tiene que salir exacto, y «0.07» no es un número exacto en
 * coma flotante.
 */
export function aPuntosBasicos(texto: string): number | null {
  const limpio = texto.trim().replace(/%/g, "").replace(",", ".").replace(/\s/g, "");
  if (limpio === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
  const n = Number(limpio);
  if (!Number.isFinite(n) || n > 100) return null;
  return Math.round(n * 100);
}

export const dePuntosBasicos = (bp: number): string => String(bp / 100);
