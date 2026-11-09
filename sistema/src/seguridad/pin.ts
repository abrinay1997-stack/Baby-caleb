/**
 * PIN de motorizados y códigos de un solo uso de las clientas.
 *
 * Las cifras son las de docs/plan/07-seguridad.md §3, no inventadas:
 *
 *  - PIN de 6 dígitos, que pone la dueña desde el panel.
 *  - PBKDF2-SHA256 con 100.000 iteraciones (el máximo que acepta WebCrypto en
 *    Workers), sal por persona y `PIN_PEPPER` secreto.
 *  - `PIN_PEPPER` **no se rota nunca**: rotarlo invalida todos los PIN a la vez
 *    y deja a los motorizados fuera en plena ruta. Es la misma regla
 *    documentada de `DCASA_PIN_PEPPER`.
 *  - Los códigos de las clientas vencen a los 10 minutos, 5 intentos, y no se
 *    piden más de 3 veces por hora por celular.
 *
 * Un código de 6 dígitos solo tiene un millón de posibilidades, así que se
 * guarda con el mismo PBKDF2 que el PIN y no con un hash rápido: el candado de
 * intentos protege contra la fuerza bruta en vivo, pero si la base se filtrara,
 * un SHA-256 a secas de seis dígitos se revierte en un suspiro.
 */

const codificador = new TextEncoder();

export const ITERACIONES = 100_000;
export const LARGO_PIN = 6;
export const LARGO_CODIGO = 6;

/** Minutos que vale un código de un solo uso. */
export const MINUTOS_CODIGO = 10;
/** Intentos antes de quemar el código. */
export const INTENTOS_CODIGO = 5;
/** Códigos que se pueden pedir por hora y por celular. */
export const CODIGOS_POR_HORA = 3;

export const esPinValido = (pin: string): boolean => new RegExp(`^\\d{${LARGO_PIN}}$`).test(pin);

function aBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deBase64Url(texto: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(texto)) return null;
  const relleno =
    texto.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (texto.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(relleno), (l) => l.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Comparación sin atajos: el tiempo no depende de en qué byte difieren. */
export function igualesSinAtajo(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a[i]! ^ b[i]!;
  return diferencia === 0;
}

async function derivar(
  secreto: string,
  sal: Uint8Array,
  iteraciones: number,
): Promise<Uint8Array> {
  const clave = await crypto.subtle.importKey(
    "raw",
    codificador.encode(secreto),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: sal as unknown as BufferSource, iterations: iteraciones, hash: "SHA-256" },
    clave,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Lo que se guarda en `motorizados.pin_hash` y en `codigos_acceso.codigo_hash`.
 *
 * Se guarda el algoritmo y las iteraciones dentro del propio texto, en vez de
 * darlas por sabidas: el día que WebCrypto admita más iteraciones se podrán
 * subir sin invalidar los PIN que ya existen, porque cada uno dice con cuántas
 * se hizo. La pimienta NO va aquí: vive en el secreto del Worker.
 */
const PREFIJO = "pbkdf2-sha256";

export async function hashearSecreto(
  secreto: string,
  pepper: string,
  iteraciones = ITERACIONES,
): Promise<string> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(secreto + pepper, sal, iteraciones);
  return `${PREFIJO}$${iteraciones}$${aBase64Url(sal)}$${aBase64Url(hash)}`;
}

/**
 * ¿Coincide? Devuelve false ante cualquier duda —formato raro, algoritmo
 * desconocido, iteraciones imposibles— en vez de lanzar: quien llama está en
 * una pantalla de entrar, y un error técnico ahí no se distingue de un sí.
 */
export async function verificarSecreto(
  secreto: string,
  guardado: string | null,
  pepper: string,
): Promise<boolean> {
  if (!guardado) return false;
  const partes = guardado.split("$");
  if (partes.length !== 4 || partes[0] !== PREFIJO) return false;

  const iteraciones = Number(partes[1]);
  if (!Number.isInteger(iteraciones) || iteraciones < 1_000 || iteraciones > 1_000_000) return false;

  const sal = deBase64Url(partes[2]!);
  const esperado = deBase64Url(partes[3]!);
  if (!sal || !esperado || sal.length === 0 || esperado.length === 0) return false;

  const calculado = await derivar(secreto + pepper, sal, iteraciones);
  return igualesSinAtajo(calculado, esperado);
}

/** Alias con nombre de lo que son, para que las llamadas se lean solas. */
export const hashearPin = hashearSecreto;
export const verificarPin = verificarSecreto;
export const hashearCodigo = hashearSecreto;
export const verificarCodigo = verificarSecreto;

/**
 * Un código de un solo uso, uniforme.
 *
 * Con `% 1000000` sobre un entero de 32 bits los primeros códigos saldrían un
 * pelo más seguido que los últimos. El sesgo es minúsculo, pero descartar y
 * volver a tirar cuesta lo mismo y no hay que explicar nada.
 */
export function generarCodigo(largo = LARGO_CODIGO): string {
  const tope = 10 ** largo;
  const limite = Math.floor(0x1_0000_0000 / tope) * tope;
  const buffer = new Uint32Array(1);
  let valor: number;
  do {
    crypto.getRandomValues(buffer);
    valor = buffer[0]!;
  } while (valor >= limite);
  return String(valor % tope).padStart(largo, "0");
}

export interface CodigoGuardado {
  /** Lo que va en `codigos_acceso.codigo_hash`. */
  hash: string;
  /** Lo que se le manda a la clienta. No se guarda en ningún sitio. */
  codigo: string;
  /** Ms UTC en que deja de valer. */
  vence_en: number;
}

/** Crea un código nuevo con su vencimiento. `ahora` se pasa: nada lee el reloj. */
export async function crearCodigo(
  pepper: string,
  ahora: number,
  minutos = MINUTOS_CODIGO,
): Promise<CodigoGuardado> {
  const codigo = generarCodigo();
  return {
    codigo,
    hash: await hashearSecreto(codigo, pepper),
    vence_en: ahora + minutos * 60_000,
  };
}

export interface FilaCodigo {
  codigo_hash: string;
  intentos: number;
  vence_en: number;
  usado_en: number | null;
}

export type ResultadoCodigo =
  | { ok: true }
  | { ok: false; motivo: "vencido" | "usado" | "sin intentos" | "incorrecto" };

/**
 * Revisa un código contra su fila. El orden importa: primero lo que no depende
 * del código (vencido, usado, sin intentos) y solo al final se compara, para no
 * gastar 100.000 iteraciones en un código que ya no valía.
 */
export async function revisarCodigo(
  codigo: string,
  fila: FilaCodigo,
  pepper: string,
  ahora: number,
): Promise<ResultadoCodigo> {
  if (fila.usado_en !== null) return { ok: false, motivo: "usado" };
  if (fila.vence_en <= ahora) return { ok: false, motivo: "vencido" };
  if (fila.intentos >= INTENTOS_CODIGO) return { ok: false, motivo: "sin intentos" };
  const coincide = await verificarSecreto(codigo, fila.codigo_hash, pepper);
  return coincide ? { ok: true } : { ok: false, motivo: "incorrecto" };
}

/** Lo que se le dice a la clienta. Trato de usted. */
export function mensajeDeCodigo(r: ResultadoCodigo): string {
  if (r.ok) return "Listo.";
  switch (r.motivo) {
    case "vencido":
      return "Ese código ya venció. Pídanos uno nuevo.";
    case "usado":
      return "Ese código ya se usó. Pídanos uno nuevo.";
    case "sin intentos":
      return "Se agotaron los intentos de ese código. Pídanos uno nuevo.";
    case "incorrecto":
      return "El código no coincide. Revíselo y vuelva a intentar.";
  }
}
