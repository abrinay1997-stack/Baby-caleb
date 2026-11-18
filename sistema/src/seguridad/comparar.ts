/**
 * Comparar dos secretos sin filtrar cuánto se acertó.
 *
 * Un `===` sobre cadenas se detiene en el primer carácter distinto. Esa parada
 * se puede MEDIR: quien intenta adivinar un hash prueba un carácter, mide si la
 * respuesta tardó un pelo más, y lo fija; después el siguiente. Un secreto de
 * 64 caracteres hexadecimales pasa de 16^64 intentos a 64 × 16, que es un rato
 * de tarde.
 *
 * Esto recorre SIEMPRE la cadena entera y acumula las diferencias con un OR.
 * No hay salida temprana, así que el tiempo no dice nada sobre el contenido.
 *
 * La longitud sí se compara con un atajo, y es correcto: la longitud de un
 * hash no es secreta —la fija el algoritmo— y saberla no acerca a nadie al
 * valor.
 *
 * Vivía dentro de `sesion.ts`, privada, y el adaptador de Yappy necesita lo
 * mismo para su hash del IPN. Dos copias de una primitiva de seguridad son dos
 * sitios donde puede corregirse una y la otra no, así que vive una sola vez.
 */
export function igualesSinAtajo(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}
