/**
 * Sesiones de motorizados y de clientas.
 *
 * El equipo NO usa esto: entra por Cloudflare Access (`access.ts`). Esto es
 * para quien no tiene cuenta en Access — el motorizado en la calle y la clienta
 * en «Mi cuenta» — y sigue docs/plan/07-seguridad.md §3:
 *
 *  - Cookie `HttpOnly; Secure; SameSite=Strict`, firmada con HMAC (`SESION_HMAC`).
 *  - Motorizado: 14 horas. Clienta: 30 días. Las dos revocables desde el panel.
 *  - La fila de `sesiones` en D1 es la que manda: ahí vive el vencimiento y la
 *    revocación.
 *
 * ¿Para qué la firma, si el id ya son 256 bits que nadie adivina? Para poder
 * rechazar una cookie inventada SIN tocar la base. Sin firma, cualquiera puede
 * hacer que cada petición suya cueste una consulta a D1; con firma, una cookie
 * falsa se tira en microsegundos y sin salir del Worker. La seguridad la da el
 * id; la firma ahorra el viaje.
 */

const codificador = new TextEncoder();

export type SujetoSesion = "motorizado" | "cliente";

/** Horas que vale cada tipo de sesión (07-seguridad.md §3). */
export const HORAS_MOTORIZADO = 14;
export const DIAS_CLIENTE = 30;

export const DURACION_MS: Record<SujetoSesion, number> = {
  motorizado: HORAS_MOTORIZADO * 3_600_000,
  cliente: DIAS_CLIENTE * 86_400_000,
};

/**
 * `__Host-` obliga a HTTPS, prohíbe el atributo Domain y fija la ruta en `/`:
 * una cookie así no la puede poner un subdominio comprometido.
 */
export const COOKIE_MOTORIZADO = "__Host-bc_ruta";
export const COOKIE_CLIENTE = "__Host-bc_cuenta";

export const COOKIE_DE: Record<SujetoSesion, string> = {
  motorizado: COOKIE_MOTORIZADO,
  cliente: COOKIE_CLIENTE,
};

function aBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function igualesSinAtajo(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

async function firmar(secreto: string, mensaje: string): Promise<string> {
  const clave = await crypto.subtle.importKey(
    "raw",
    codificador.encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await crypto.subtle.sign("HMAC", clave, codificador.encode(mensaje));
  return aBase64Url(new Uint8Array(firma));
}

/** 256 bits de azar. Es lo que de verdad protege la sesión. */
export function nuevoId(): string {
  return aBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface FilaSesion {
  id: string;
  sujeto_tipo: SujetoSesion;
  sujeto_id: string;
  creado_en: number;
  vence_en: number;
  revocada_en: number | null;
}

export interface SesionNueva {
  /** La fila que hay que insertar en `sesiones`. */
  fila: FilaSesion;
  /** La cabecera `Set-Cookie` completa. */
  setCookie: string;
}

/** Crea una sesión. `ahora` se pasa: nada aquí lee el reloj. */
export async function crearSesion(
  sujeto_tipo: SujetoSesion,
  sujeto_id: string,
  hmacSecreto: string,
  ahora: number,
): Promise<SesionNueva> {
  const id = nuevoId();
  const vence_en = ahora + DURACION_MS[sujeto_tipo];
  const valor = `${id}.${await firmar(hmacSecreto, id)}`;
  const maxAge = Math.floor(DURACION_MS[sujeto_tipo] / 1000);

  return {
    fila: { id, sujeto_tipo, sujeto_id, creado_en: ahora, vence_en, revocada_en: null },
    setCookie: armarCookie(COOKIE_DE[sujeto_tipo], valor, maxAge),
  };
}

export function armarCookie(nombre: string, valor: string, maxAge: number): string {
  return [
    `${nombre}=${valor}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

/** Para cerrar sesión, o cuando la cookie ya no sirve. */
export function cookieBorrada(sujeto_tipo: SujetoSesion): string {
  return armarCookie(COOKIE_DE[sujeto_tipo], "", 0);
}

function leerCookieCruda(cabecera: string | null, nombre: string): string | null {
  if (!cabecera) return null;
  for (const trozo of cabecera.split(";")) {
    const corte = trozo.indexOf("=");
    if (corte < 0) continue;
    if (trozo.slice(0, corte).trim() === nombre) return trozo.slice(corte + 1).trim();
  }
  return null;
}

/**
 * Saca el id de sesión de la petición, comprobando la firma. Devuelve null si
 * la cookie no está, tiene mala forma o la firma no cuadra: a partir de aquí
 * quien llama ya puede ir a buscar la fila a D1 con la tranquilidad de que el
 * id lo emitimos nosotros.
 */
export async function idDeLaPeticion(
  request: Request,
  sujeto_tipo: SujetoSesion,
  hmacSecreto: string,
): Promise<string | null> {
  const valor = leerCookieCruda(request.headers.get("Cookie"), COOKIE_DE[sujeto_tipo]);
  if (!valor) return null;

  const corte = valor.lastIndexOf(".");
  if (corte <= 0) return null;

  const id = valor.slice(0, corte);
  const firma = valor.slice(corte + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(id) || !firma) return null;

  return igualesSinAtajo(await firmar(hmacSecreto, id), firma) ? id : null;
}

export type EstadoSesion = "vigente" | "vencida" | "revocada" | "no_existe";

/**
 * ¿Sirve esta sesión? La fila de D1 es la que manda: el `vence_en` de la fila
 * gana al `Max-Age` de la cookie, porque la cookie la controla el navegador y
 * la fila la controlamos nosotros. Revocar desde el panel tiene efecto en la
 * siguiente petición.
 */
export function estadoDeSesion(fila: FilaSesion | null, ahora: number): EstadoSesion {
  if (!fila) return "no_existe";
  if (fila.revocada_en !== null) return "revocada";
  if (fila.vence_en <= ahora) return "vencida";
  return "vigente";
}

export const esVigente = (fila: FilaSesion | null, ahora: number): boolean =>
  estadoDeSesion(fila, ahora) === "vigente";

/**
 * Comprobación de origen para los cambios de estado del panel
 * (07-seguridad.md §2: «`Origin` igual al del panel, además de la cookie con
 * `SameSite`»). Dos capas porque `SameSite` lo aplica el navegador y esto lo
 * aplica el servidor: si un navegador viejo no respeta la primera, queda la
 * segunda.
 */
export function origenPermitido(request: Request, origenesValidos: readonly string[]): boolean {
  const metodo = request.method.toUpperCase();
  if (metodo === "GET" || metodo === "HEAD" || metodo === "OPTIONS") return true;

  const origen = request.headers.get("Origin");
  // Sin `Origin` en un POST: los navegadores lo mandan siempre, así que esto es
  // un cliente que no es un navegador. Se rechaza.
  if (!origen) return false;
  return origenesValidos.includes(origen);
}
