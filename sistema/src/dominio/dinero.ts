/**
 * Aritmética de dinero · TODO en centavos enteros.
 *
 * Portado de `packages/domain/src/money.ts` de Nébula, pero NO tal cual: allí
 * los importes son dólares en `number` porque Postgres devuelve `numeric`, y
 * cada operación tiene que volver a redondear para que `0.1 + 0.2` no acabe
 * facturando 0.30000000000000004.
 *
 * Aquí no hace falta: el plan manda centavos en INTEGER y nunca REAL
 * (docs/plan/02-datos.md §1), así que sumar y multiplicar son exactos y el
 * único lugar donde se redondea es al aplicar una tasa o al repartir un monto.
 * Los dólares solo existen para mostrar en pantalla y para leer lo que escribe
 * una persona.
 */

/** Centavos de USD. Siempre entero. */
export type Centavos = number;

/** D1 guarda INTEGER; más allá de esto el número deja de ser exacto. */
export const esCentavos = (n: unknown): n is Centavos => Number.isSafeInteger(n);

/** Redondeo simétrico: medio centavo se va siempre lejos del cero. */
const redondear = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

export function sumar(montos: readonly Centavos[]): Centavos {
  return montos.reduce((t, m) => t + m, 0);
}

export function multiplicar(monto: Centavos, cantidad: number): Centavos {
  return monto * cantidad;
}

/**
 * Aplica una tasa en puntos básicos (700 = 7 %), como `tasa_itbms_bp`.
 * Se guardan en puntos básicos y no como fracción para que la tasa también
 * sea un entero exacto y no haya un 0.07 que no existe en binario.
 */
export function aplicarPuntosBasicos(monto: Centavos, puntosBasicos: number): Centavos {
  return redondear((monto * puntosBasicos) / 10_000);
}

/**
 * Reparte un monto entre varias partes según sus pesos, de forma que la suma
 * de las partes sea EXACTAMENTE el monto: ni un centavo se pierde ni se
 * inventa. El resto se reparte por el método del mayor residuo.
 *
 * Se usa para prorratear un descuento entre las líneas de un pedido y los
 * gastos de una compra entre sus artículos (`compras_proveedor.prorrateo`).
 */
export function prorratear(monto: Centavos, pesos: readonly number[]): Centavos[] {
  if (pesos.length === 0) return [];
  if (pesos.some((p) => p < 0)) throw new RangeError("prorratear: ningún peso puede ser negativo");

  const sumaPesos = pesos.reduce((t, p) => t + p, 0);

  // Sin pesos (todo a cero): reparto parejo, que es lo único defendible.
  const exactos =
    sumaPesos === 0
      ? pesos.map(() => monto / pesos.length)
      : pesos.map((p) => (monto * p) / sumaPesos);

  const partes = exactos.map((e) => Math.trunc(e));
  let resto = monto - partes.reduce((t, p) => t + p, 0);

  // El resto va a quienes tienen la fracción más grande; a igualdad, al primero.
  const porFraccion = exactos
    .map((e, i) => ({ i, fraccion: Math.abs(e - Math.trunc(e)) }))
    .sort((a, b) => b.fraccion - a.fraccion || a.i - b.i);

  const paso = resto < 0 ? -1 : 1;
  for (let k = 0; resto !== 0 && k < porFraccion.length; k++) {
    const indice = porFraccion[k]!.i;
    partes[indice] = partes[indice]! + paso;
    resto -= paso;
  }
  return partes;
}

/**
 * Lee un monto escrito por una persona y lo pasa a centavos SIN coma flotante.
 * `parseFloat('29.98') * 100` da 2998.0000000000005; esto parte el texto y
 * suma enteros. Devuelve null si no se entiende: no se adivina una cifra.
 *
 * Acepta «50», «50.5», «$50.50», «1,234.56» y el signo negativo.
 *
 * El punto es el separador decimal. La coma se acepta SOLO como separador de
 * miles bien formado («1,234.56»). «50,5» se rechaza aposta: en media América
 * es cincuenta con cinco y en la otra quinientos cinco, y equivocarse ahí es
 * un error de diez veces en un precio. Ante la duda, null.
 */
export function desdeDolares(texto: string): Centavos | null {
  const limpio = texto.trim().replace(/\s/g, "").replace(/^[$]/, "");
  const m = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:[.](\d{1,2}))?$/.exec(limpio);
  if (!m) return null;
  const enteros = m[2]!.replace(/,/g, "");
  const centavos = Number(enteros) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -centavos : centavos;
}

/** Solo para mostrar. Nunca para calcular ni para guardar. */
export function aDolares(monto: Centavos): number {
  return monto / 100;
}

/** «$50.00». Solo para mostrar. */
export function formatear(monto: Centavos): string {
  const signo = monto < 0 ? "-" : "";
  const abs = Math.abs(monto);
  const enteros = Math.trunc(abs / 100);
  const decimales = String(abs % 100).padStart(2, "0");
  return signo + "$" + enteros + "." + decimales;
}
