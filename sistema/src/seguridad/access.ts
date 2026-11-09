/**
 * La puerta del equipo: el token de Cloudflare Access.
 *
 * Portado de `edge/src/puerta.ts` de D'Casa (docs/plan/09-fases.md, F2.4), que
 * es código probado contra un Access de verdad. Se queda con la parte difícil
 * —verificar el JWT y manejar el listado de llaves sin castigar a Cloudflare— y
 * se deja fuera todo lo que allí existe por Odoo: la cookie propia firmada y la
 * cabecera `X-Dcasa-Puerta`. Baby Caleb no las necesita: `panel.babycaleb.com`
 * va detrás de Access y el Worker verifica el token en cada petición.
 *
 * **Falla CERRADO, y aquí más que en D'Casa.** Allí la puerta era una capa
 * encima del login de Odoo, así que sin configurar se apagaba y el sitio seguía
 * funcionando. El panel de Baby Caleb no tiene otra puerta detrás: si falta la
 * configuración, no entra nadie. Cualquier duda es un rechazo.
 *
 * Sin dependencias de Cloudflare: todo entra por parámetros, así que se prueba
 * sin Access y sin red.
 */

const codificador = new TextEncoder();

/** Lo que hace falta para verificar. No son secretos: son identificadores. */
export interface ConfigAccess {
  /** `https://<equipo>.cloudflareaccess.com`, sin barra final y en minúsculas. */
  equipo: string;
  /** La audiencia (`aud`) de la aplicación de Access. */
  aud: string;
}

export interface EntornoAccess {
  ACCESS_EQUIPO?: string;
  ACCESS_AUD?: string;
}

const EQUIPO_VALIDO = /^https:\/\/[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.cloudflareaccess\.com$/;
const AUD_VALIDA = /^[a-f0-9]{64}$/;

/** Margen por relojes que no van exactamente iguales. */
const MARGEN_RELOJ_S = 30;

/** Cuánto vale el listado de llaves antes de volver a pedirlo. */
const TTL_JWKS_MS = 60 * 60 * 1000;
/** Tras un `kid` desconocido, no se vuelve a pedir el listado antes de esto. */
const PAUSA_REFRESCO_JWKS_MS = 60 * 1000;
/** Tras un fallo de descarga, no se insiste antes de esto. */
const PAUSA_TRAS_FALLO_JWKS_MS = 10 * 1000;
const TOPE_DESCARGA_JWKS_MS = 5 * 1000;

/**
 * Lee la configuración. Devuelve null si falta algo o tiene mala forma, y eso
 * significa que el panel no abre: ver la nota de arriba.
 */
export function configAccess(env: EntornoAccess): ConfigAccess | null {
  const equipo = (env.ACCESS_EQUIPO ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const aud = (env.ACCESS_AUD ?? "").trim().toLowerCase();
  if (!EQUIPO_VALIDO.test(equipo) || !AUD_VALIDA.test(aud)) return null;
  return { equipo, aud };
}

export function deBase64Url(texto: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(texto)) return null;
  const relleno =
    texto.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (texto.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(relleno), (letra) => letra.charCodeAt(0));
  } catch {
    return null;
  }
}

function objetoJson(parte: string): Record<string, unknown> | null {
  const bytes = deBase64Url(parte);
  if (!bytes) return null;
  try {
    const valor: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return valor && typeof valor === "object" && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// El listado de llaves públicas del equipo
// ---------------------------------------------------------------------------
// Guardado en memoria del isolate. Las tres pausas de abajo no son adorno:
// sin ellas, una ráfaga de peticiones con un token raro se convierte en una
// ráfaga de descargas contra Cloudflare, y cuando Access rota sus llaves el
// panel se queda fuera justo cuando más se usa.

interface CacheJwks {
  claves: Map<string, CryptoKey>;
  cargadoEn: number;
  ultimoRefresco: number;
}

const cacheJwks = new Map<string, CacheJwks>();
/** Una descarga por equipo: veinte peticiones a la vez no hacen veinte descargas. */
const descargasEnCurso = new Map<string, Promise<CacheJwks>>();
const ultimoFalloJwks = new Map<string, number>();

/** Para pruebas: olvida las llaves guardadas. */
export function reiniciarCacheJwks(): void {
  cacheJwks.clear();
  descargasEnCurso.clear();
  ultimoFalloJwks.clear();
}

export interface DepsAccess {
  /** Descarga el listado de llaves. Se inyecta en las pruebas. */
  traerJwks?: (url: string) => Promise<unknown>;
  /** Reloj en milisegundos. */
  ahora?: () => number;
}

async function descargarJwks(url: string): Promise<unknown> {
  const respuesta = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TOPE_DESCARGA_JWKS_MS),
  });
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
  return respuesta.json();
}

async function cargarLlaves(equipo: string, deps: DepsAccess, ahora: number): Promise<CacheJwks> {
  const crudo = (await (deps.traerJwks ?? descargarJwks)(
    `${equipo}/cdn-cgi/access/certs`,
  )) as { keys?: unknown };

  const claves = new Map<string, CryptoKey>();
  const lista = Array.isArray(crudo?.keys) ? (crudo.keys as Record<string, unknown>[]) : [];

  for (const jwk of lista) {
    if (
      jwk?.kty !== "RSA" ||
      typeof jwk.kid !== "string" ||
      typeof jwk.n !== "string" ||
      typeof jwk.e !== "string"
    ) {
      continue;
    }
    try {
      claves.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch {
      // Una llave rara no invalida las demás.
    }
  }
  return { claves, cargadoEn: ahora, ultimoRefresco: ahora };
}

async function claveParaKid(
  equipo: string,
  kid: string,
  deps: DepsAccess,
  ahora: number,
): Promise<CryptoKey | null> {
  const guardado = cacheJwks.get(equipo);
  const vigente = guardado && ahora - guardado.cargadoEn < TTL_JWKS_MS;
  if (guardado && vigente && guardado.claves.has(kid)) return guardado.claves.get(kid) ?? null;

  // Llave desconocida (Access rotó) o listado viejo: se vuelve a pedir, con pausa.
  if (guardado && ahora - guardado.ultimoRefresco < PAUSA_REFRESCO_JWKS_MS) {
    return guardado.claves.get(kid) ?? null;
  }

  const fallo = ultimoFalloJwks.get(equipo);
  if (fallo !== undefined && ahora - fallo < PAUSA_TRAS_FALLO_JWKS_MS) {
    return guardado?.claves.get(kid) ?? null;
  }

  try {
    let descarga = descargasEnCurso.get(equipo);
    if (!descarga) {
      descarga = cargarLlaves(equipo, deps, ahora).finally(() => descargasEnCurso.delete(equipo));
      descargasEnCurso.set(equipo, descarga);
    }
    const nuevo = await descarga;
    cacheJwks.set(equipo, nuevo);
    ultimoFalloJwks.delete(equipo);
    return nuevo.claves.get(kid) ?? null;
  } catch (error) {
    console.error(
      JSON.stringify({ evento: "access_jwks_fallido", error: String(error).slice(0, 200) }),
    );
    ultimoFalloJwks.set(equipo, ahora);
    // Se conserva lo que haya: una llave vieja que todavía sirve es mejor que
    // dejar al equipo fuera porque Cloudflare tardó un segundo.
    if (guardado) guardado.ultimoRefresco = ahora;
    return guardado?.claves.get(kid) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------

/**
 * Por qué no abrió. Los primeros pasan ANTES de comprobar la firma (el token lo
 * puede traer cualquiera); desde `emisor` en adelante ya está firmado por
 * nuestro equipo, así que quien lo trae pasó por nuestro Access.
 */
export type MotivoRechazo =
  | "sin configurar"
  | "sin token"
  | "forma"
  | "ilegible"
  | "algoritmo"
  | "sin kid"
  | "llaves no disponibles"
  | "llave desconocida"
  | "firma"
  | "emisor"
  | "audiencia"
  | "vencido"
  | "todavia no vale"
  | "emitido en el futuro"
  | "sin correo";

export interface Rechazo {
  motivo: MotivoRechazo;
  /** El equipo que dice haber emitido el token, solo si tiene forma válida. */
  emisor?: string;
  /** Últimos 6 caracteres de la audiencia, solo con la firma ya comprobada. */
  audRecibida?: string;
  audEsperada?: string;
}

export interface Identidad {
  /** El correo con el que se identificó en Access, en minúsculas. */
  correo: string;
  /** Vencimiento del token (segundos Unix). */
  exp: number;
}

export type ResultadoAccess = { identidad: Identidad } | { rechazo: Rechazo };

const final6 = (t: string) => t.slice(-6);

function rechazar(datos: Rechazo): ResultadoAccess {
  const registro: Record<string, unknown> = {
    evento: "access_token_rechazado",
    motivo: datos.motivo,
  };
  if (datos.emisor) registro.emisor = datos.emisor;
  if (datos.audRecibida) registro.aud_recibida_termina = datos.audRecibida;
  if (datos.audEsperada) registro.aud_esperada_termina = datos.audEsperada;
  console.warn(JSON.stringify(registro));
  return { rechazo: datos };
}

/**
 * El `iss` del token, solo si tiene forma de equipo: así se puede mostrar sin
 * riesgo. Devuelve un objeto para poder esparcirlo sin dejar la propiedad en
 * `undefined` (`exactOptionalPropertyTypes`).
 */
function emisorLegible(carga: Record<string, unknown> | null): { emisor?: string } {
  const iss = typeof carga?.iss === "string" ? carga.iss.replace(/\/+$/, "").toLowerCase() : "";
  return EQUIPO_VALIDO.test(iss) ? { emisor: iss } : {};
}

/**
 * ASCII imprimible, sin espacios ni «|» ni un segundo «@»: un carácter raro en
 * un correo acaba rompiendo una cabecera HTTP o una consulta.
 */
const CORREO_VALIDO =
  /^[\x21-\x3f\x41-\x7b\x7d-\x7e]{1,64}@[\x21-\x3f\x41-\x7b\x7d-\x7e]{1,190}$/;

/** Donde Access pone el token. */
export const CABECERA_TOKEN = "Cf-Access-Jwt-Assertion";

/**
 * Verifica el token y, si no sirve, dice por qué.
 *
 * Solo RS256 —nunca `none` ni HS256, que son la puerta de atrás clásica de los
 * JWT—, emisor y audiencia exactos, vigente, y con un correo bien formado.
 */
export async function revisarToken(
  token: string | null,
  cfg: ConfigAccess,
  deps: DepsAccess = {},
): Promise<ResultadoAccess> {
  if (!token) return rechazar({ motivo: "sin token" });

  const ahoraMs = (deps.ahora ?? Date.now)();
  const partes = token.split(".");
  if (partes.length !== 3 || partes.some((p) => p === "")) return rechazar({ motivo: "forma" });

  const cabecera = objetoJson(partes[0]!);
  const carga = objetoJson(partes[1]!);
  const firma = deBase64Url(partes[2]!);
  if (!cabecera || !carga || !firma) return rechazar({ motivo: "ilegible" });
  if (cabecera.alg !== "RS256") return rechazar({ motivo: "algoritmo" });
  if (typeof cabecera.kid !== "string" || cabecera.kid === "") {
    return rechazar({ motivo: "sin kid" });
  }

  const clave = await claveParaKid(cfg.equipo, cabecera.kid, deps, ahoraMs);
  if (!clave) {
    const motivo: MotivoRechazo = cacheJwks.has(cfg.equipo)
      ? "llave desconocida"
      : "llaves no disponibles";
    return rechazar({ motivo, ...emisorLegible(carga) });
  }

  const valida = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    clave,
    firma as unknown as BufferSource,
    codificador.encode(`${partes[0]}.${partes[1]}`),
  );
  if (!valida) return rechazar({ motivo: "firma" });

  const ahoraS = Math.floor(ahoraMs / 1000);

  if (typeof carga.iss !== "string" || carga.iss.replace(/\/+$/, "").toLowerCase() !== cfg.equipo) {
    return rechazar({ motivo: "emisor", ...emisorLegible(carga) });
  }

  const audiencia = carga.aud;
  const coincide = Array.isArray(audiencia) ? audiencia.includes(cfg.aud) : audiencia === cfg.aud;
  if (!coincide) {
    const recibida = Array.isArray(audiencia)
      ? audiencia.find((a) => typeof a === "string")
      : audiencia;
    return rechazar({
      motivo: "audiencia",
      ...(typeof recibida === "string" && AUD_VALIDA.test(recibida)
        ? { audRecibida: final6(recibida) }
        : {}),
      audEsperada: final6(cfg.aud),
    });
  }

  if (
    typeof carga.exp !== "number" ||
    !Number.isFinite(carga.exp) ||
    carga.exp <= ahoraS - MARGEN_RELOJ_S
  ) {
    return rechazar({ motivo: "vencido" });
  }
  if (typeof carga.nbf === "number" && carga.nbf > ahoraS + MARGEN_RELOJ_S) {
    return rechazar({ motivo: "todavia no vale" });
  }
  if (typeof carga.iat === "number" && carga.iat > ahoraS + MARGEN_RELOJ_S) {
    return rechazar({ motivo: "emitido en el futuro" });
  }

  const correo = typeof carga.email === "string" ? carga.email.trim().toLowerCase() : "";
  if (!CORREO_VALIDO.test(correo)) return rechazar({ motivo: "sin correo" });

  return { identidad: { correo, exp: carga.exp } };
}

/**
 * Lo mismo, leyendo el token de la petición y la configuración del entorno.
 * Sin configuración no abre: el panel no tiene otra puerta detrás.
 */
export async function revisarPeticion(
  request: Request,
  env: EntornoAccess,
  deps: DepsAccess = {},
): Promise<ResultadoAccess> {
  const cfg = configAccess(env);
  if (!cfg) return rechazar({ motivo: "sin configurar" });
  return revisarToken(request.headers.get(CABECERA_TOKEN), cfg, deps);
}
