/**
 * Centavos enteros ↔ el texto con dos decimales que piden las pasarelas.
 *
 * Vive aquí, una sola vez, porque Yappy y Tilopay piden exactamente lo mismo
 * —una cadena como «12.50», no un número— y porque este código ya tuvo un
 * fallo que costaba dinero. Escribirlo dos veces es garantizar que el arreglo
 * se aplique a una copia y no a la otra.
 *
 * El sistema guarda centavos ENTEROS a propósito: un `number` con decimales
 * suma mal el dinero.
 */

/** Centavos enteros → «12.50». */
export function aTextoDeDinero(centavos: number): string {
  const signo = centavos < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(centavos));
  return `${signo}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * «12.50» → 1250 centavos. `null` si no se entiende.
 *
 * Devuelve `null` en vez de `NaN` o un redondeo callado: un importe que no se
 * entiende tiene que PARAR la comparación, no convertirse en un número que
 * casualmente no cuadre. Con `NaN`, un `!==` da «no coincide» —el lado bueno—
 * pero un `Math.abs(a-b) < 1` da `false` y podría leerse como «cuadra». Con
 * cero, un pago de cero cuadraría con un pedido de cero. `null` no se puede
 * comparar por error.
 */
export function deTextoDeDinero(texto: unknown): number | null {
  if (typeof texto === "number" && Number.isFinite(texto)) {
    // Algunas respuestas traen número. Se pasa por su texto para no heredar el
    // error de la coma flotante: `Number("19.99") * 100` da 1998.9999999999998.
    return deTextoDeDinero(texto.toFixed(2));
  }
  if (typeof texto !== "string") return null;
  const limpio = texto.trim();

  /**
   * LA COMA SOLO SE ACEPTA COMO SEPARADOR DE MILES, Y SE COMPRUEBA.
   *
   * Esto empezó siendo `.replace(/,/g, "")`, que es lo que uno escribe sin
   * pensar, y con eso `"12,50"` daba 125000 centavos: **mil doscientos
   * cincuenta dólares en vez de doce con cincuenta**, cien veces más.
   *
   * No es una rareza teórica: la coma decimal es lo normal en media
   * Latinoamérica, y basta con que una respuesta venga así. Y el error cae del
   * lado que cuesta dinero: con nuestro pedido en $1250.00 y su respuesta
   * «12,50», los dos números coincidirían y se aprobaría un pedido de mil
   * doscientos cincuenta por doce dólares.
   *
   * Un importe ambiguo no se adivina: se rechaza. La coma solo pasa en grupos
   * de tres (`1,250.00`); `12,50` no lo es y sale `null`, que PARA la
   * comparación en vez de resolverla mal.
   */
  const conMiles = /^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;
  const sinMiles = /^-?\d+(?:\.\d{1,2})?$/;
  if (!sinMiles.test(limpio) && !conMiles.test(limpio)) return null;

  const m = /^(-?)(\d[\d,]*?)(?:\.(\d{1,2}))?$/.exec(limpio);
  if (m === null) return null;

  const enteros = Number((m[2] ?? "").replace(/,/g, ""));
  const decimales = Number((m[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(enteros) || !Number.isSafeInteger(decimales)) return null;
  const total = enteros * 100 + decimales;
  return m[1] === "-" ? -total : total;
}
