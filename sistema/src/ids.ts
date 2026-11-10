/**
 * ULID: los identificadores de todo el sistema.
 *
 * El plan los pide ordenables por tiempo (docs/plan/02-datos.md §1), y eso no
 * es un capricho: con un UUID aleatorio, `ORDER BY id` no sirve para nada y
 * cada consulta que quiera «los últimos pedidos» necesita un índice más sobre
 * la fecha. Con un ULID, el id YA viene ordenado, y el índice de la llave
 * primaria hace ese trabajo gratis.
 *
 * Forma: 26 caracteres en base32 de Crockford. Los primeros 10 son los
 * milisegundos UTC (48 bits, llegan al año 10889) y los 16 restantes son 80
 * bits de azar.
 *
 * El alfabeto de Crockford deja fuera la I, la L, la O y la U: así nadie
 * confunde un 1 con una I ni un 0 con una O al leer un id por teléfono, y no
 * sale ninguna palabra fea por casualidad.
 */

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, sin I L O U
const LARGO_TIEMPO = 10;
const LARGO_AZAR = 16;
export const LARGO_ULID = LARGO_TIEMPO + LARGO_AZAR;

/** El mayor milisegundo que cabe en 48 bits. */
const MAX_MS = 281_474_976_710_655;

function tiempoEnBase32(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_MS) {
    throw new RangeError(`ulid: el tiempo ${ms} no cabe en 48 bits`);
  }
  let resto = ms;
  let salida = "";
  for (let i = 0; i < LARGO_TIEMPO; i++) {
    salida = ALFABETO[resto % 32]! + salida;
    resto = Math.floor(resto / 32);
  }
  return salida;
}

function azarEnBase32(): string {
  // Un byte por carácter y se usan 5 bits: desperdicia 3 bits por byte y no
  // introduce sesgo, que es lo que importa.
  const bytes = crypto.getRandomValues(new Uint8Array(LARGO_AZAR));
  let salida = "";
  for (const b of bytes) salida += ALFABETO[b & 31]!;
  return salida;
}

/**
 * Lo último que se entregó, para que dos ULID del MISMO milisegundo sigan
 * saliendo en orden.
 *
 * Sin esto, dos pedidos creados en el mismo milisegundo tendrían ids cuyo orden
 * es el del azar, y `ORDER BY id` los devolvería al revés de como pasaron. Es
 * raro, pero «raro» en un sistema de pedidos significa «un martes cualquiera».
 */
let ultimoMs = -1;
let ultimoAzar = "";

/** Incrementa la parte de azar en uno, como un número en base 32. */
function siguienteAzar(azar: string): string | null {
  const letras = azar.split("");
  for (let i = letras.length - 1; i >= 0; i--) {
    const pos = ALFABETO.indexOf(letras[i]!);
    if (pos < 31) {
      letras[i] = ALFABETO[pos + 1]!;
      return letras.join("");
    }
    letras[i] = ALFABETO[0]!;
  }
  // Se desbordó: 80 bits de azar agotados dentro del mismo milisegundo. No pasa
  // en la vida real, pero si pasara, mejor un id nuevo que uno repetido.
  return null;
}

/**
 * Un ULID nuevo. `ahora` se pasa para que las pruebas no dependan del reloj;
 * en producción se le pasa `Date.now()`.
 */
export function ulid(ahora: number): string {
  const ms = Math.floor(ahora);

  if (ms === ultimoMs) {
    const siguiente = siguienteAzar(ultimoAzar);
    ultimoAzar = siguiente ?? azarEnBase32();
  } else if (ms > ultimoMs) {
    ultimoMs = ms;
    ultimoAzar = azarEnBase32();
  } else {
    // El reloj fue hacia atrás (ajuste de hora, otra máquina). No se devuelve
    // un id del pasado, porque rompería el orden: se sigue desde el último.
    const siguiente = siguienteAzar(ultimoAzar);
    ultimoAzar = siguiente ?? azarEnBase32();
    return tiempoEnBase32(ultimoMs) + ultimoAzar;
  }

  return tiempoEnBase32(ms) + ultimoAzar;
}

const FORMA = new RegExp(`^[${ALFABETO}]{${LARGO_ULID}}$`);

export const esUlid = (v: unknown): v is string => typeof v === "string" && FORMA.test(v);

/** Los milisegundos que trae dentro. Útil para auditar sin otra columna. */
export function msDeUlid(id: string): number | null {
  if (!esUlid(id)) return null;
  let ms = 0;
  for (const letra of id.slice(0, LARGO_TIEMPO)) ms = ms * 32 + ALFABETO.indexOf(letra);
  return ms;
}

/** Para pruebas: olvida el último entregado. */
export function reiniciarUlid(): void {
  ultimoMs = -1;
  ultimoAzar = "";
}

/**
 * Token público de 256 bits, en base64url.
 *
 * NO es un ULID y no debe serlo: `pedidos.token`, `envios.guia_token` y los id
 * de sesión salen en enlaces que cualquiera puede recibir, y un ULID dice
 * cuándo se creó y se puede ir probando el de al lado. Esto es azar puro.
 */
export function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
