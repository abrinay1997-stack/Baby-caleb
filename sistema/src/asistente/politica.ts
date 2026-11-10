import type { Rol } from "../seguridad/roles";
import type { Herramienta, NivelHerramienta } from "./registro";

/**
 * La política: qué se ejecuta, qué se pregunta y qué no pasa.
 *
 * Lo prohibido de verdad no está aquí: no existe herramienta para borrar un
 * asiento, cambiar un permiso o ejecutar SQL (06-asistente §3). Esto es la
 * segunda capa, la que revisa CADA llamada antes de ejecutarla: rol, nivel,
 * adjuntos, texto de fuera y tamaño.
 *
 * Todo está en funciones puras a propósito. Una política que solo se puede
 * probar levantando una base y un modelo acaba sin probarse, y es justo la
 * pieza que no puede fallar en silencio.
 */

// ---------------------------------------------------------------------------
// Los topes (06-asistente §7)
// ---------------------------------------------------------------------------

export const TOPES = {
  /** Letras por argumento. */
  letrasPorArgumento: 10_000,
  /** Letras sumando todos los argumentos de una llamada. */
  letrasPorLlamada: 30_000,
  /** Letras de un mensaje de la persona. */
  letrasPorMensaje: 8_000,
  archivosPorMensaje: 5,
  /** Herramientas que el modelo puede encadenar en un turno. */
  pasosPorTurno: 8,
  /** Cuántos de los últimos mensajes se miran para ver si hubo un archivo. */
  mensajesQueCuentanParaAdjuntos: 6,
  /** Minutos que vive una acción sensible esperando confirmación. */
  minutosParaConfirmar: 30,
} as const;

// ---------------------------------------------------------------------------
// La decisión
// ---------------------------------------------------------------------------

export type MotivoDeConfirmacion =
  | "nivel_sensible"
  | "hubo_un_archivo"
  | "se_leyo_texto_de_fuera";

export type Decision =
  | { readonly clase: "ejecutar" }
  | { readonly clase: "confirmar"; readonly porque: MotivoDeConfirmacion; readonly explicacion: string }
  | { readonly clase: "bloquear"; readonly explicacion: string };

/** Lo que ya pasó en este turno y en los mensajes de antes. */
export interface Turno {
  /** Alguno de los últimos 6 mensajes de la persona traía un archivo. */
  readonly huboArchivoReciente: boolean;
  /** En este turno ya se usó una herramienta que lee texto de clientas. */
  readonly seLeyoTextoDeFuera: boolean;
  /** Herramientas ya ejecutadas en este turno. */
  readonly pasosDados: number;
}

export const TURNO_LIMPIO: Turno = {
  huboArchivoReciente: false,
  seLeyoTextoDeFuera: false,
  pasosDados: 0,
};

/**
 * Qué hacer con una llamada.
 *
 * El orden importa: primero lo que NO se puede hacer (rol, pasos), y solo
 * después si hace falta pedir permiso. Al revés, se le enseñaría a la persona
 * una tarjeta de «¿permite esto?» para algo que su rol no puede hacer igual.
 */
export function decidir(
  herramienta: Pick<Herramienta<never, never>, "nombre" | "nivel" | "roles">,
  rol: Rol,
  turno: Turno = TURNO_LIMPIO,
): Decision {
  if (!herramienta.roles.includes(rol)) {
    // El asistente nunca actúa con más permisos que la persona con quien habla
    // (06-asistente §3, punto 5).
    return {
      clase: "bloquear",
      explicacion: `«${herramienta.nombre}» no es para el rol ${rol}`,
    };
  }

  if (turno.pasosDados >= TOPES.pasosPorTurno) {
    // Sin esto, un bucle del modelo gasta la cuota del mes en un turno.
    return {
      clase: "bloquear",
      explicacion: `ya se usaron ${TOPES.pasosPorTurno} herramientas en este turno`,
    };
  }

  if (herramienta.nivel === "sensible") {
    return {
      clase: "confirmar",
      porque: "nivel_sensible",
      explicacion: "es una acción que cambia dinero, precios o existencias",
    };
  }

  if (herramienta.nivel === "construccion") {
    // Las dos defensas contra el texto que no escribió la persona: si vino un
    // archivo, o si en este turno se leyó algo escrito por una clienta, lo que
    // el modelo cree que le pidieron puede venir de ahí dentro. Entonces
    // construir deja de ser directo y pasa por la persona.
    if (turno.huboArchivoReciente) {
      return {
        clase: "confirmar",
        porque: "hubo_un_archivo",
        explicacion: "hubo un archivo en la conversación hace poco",
      };
    }
    if (turno.seLeyoTextoDeFuera) {
      return {
        clase: "confirmar",
        porque: "se_leyo_texto_de_fuera",
        explicacion: "en este turno se leyó texto escrito por una clienta",
      };
    }
  }

  return { clase: "ejecutar" };
}

/** Nivel en palabras, para el resumen que lee la persona. */
export const COMO_SE_LEE_EL_NIVEL: Record<NivelHerramienta, string> = {
  lectura: "consultar",
  construccion: "anotar",
  sensible: "cambiar",
};

// ---------------------------------------------------------------------------
// Tamaños
// ---------------------------------------------------------------------------

export type Revision = { readonly ok: true } | { readonly ok: false; readonly explicacion: string };

const BIEN: Revision = { ok: true };

/**
 * Los argumentos no pueden ser enormes.
 *
 * Se revisa ANTES de registrar en la bitácora (06-asistente §7): si no, una
 * llamada de medio megabyte entra entera en `acciones` y el tope no sirve de
 * nada porque el daño ya está guardado.
 */
export function revisarArgumentos(args: unknown): Revision {
  let total = 0;

  const mirar = (valor: unknown, camino: string): Revision => {
    if (typeof valor === "string") {
      total += valor.length;
      if (valor.length > TOPES.letrasPorArgumento) {
        return {
          ok: false,
          explicacion: `«${camino}» trae ${valor.length} letras y el tope son ${TOPES.letrasPorArgumento}`,
        };
      }
      return BIEN;
    }
    if (Array.isArray(valor)) {
      for (const [i, v] of valor.entries()) {
        const r = mirar(v, `${camino}[${i}]`);
        if (!r.ok) return r;
      }
      return BIEN;
    }
    if (valor !== null && typeof valor === "object") {
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
        const r = mirar(v, camino === "" ? k : `${camino}.${k}`);
        if (!r.ok) return r;
      }
      return BIEN;
    }
    return BIEN;
  };

  const r = mirar(args, "");
  if (!r.ok) return r;

  if (total > TOPES.letrasPorLlamada) {
    return {
      ok: false,
      explicacion: `la llamada suma ${total} letras y el tope son ${TOPES.letrasPorLlamada}`,
    };
  }
  return BIEN;
}

export function revisarMensaje(texto: string, archivos = 0): Revision {
  if (texto.length > TOPES.letrasPorMensaje) {
    return {
      ok: false,
      explicacion: `el mensaje trae ${texto.length} letras y el tope son ${TOPES.letrasPorMensaje}`,
    };
  }
  if (archivos > TOPES.archivosPorMensaje) {
    return {
      ok: false,
      explicacion: `${archivos} archivos de una vez; el tope son ${TOPES.archivosPorMensaje}`,
    };
  }
  return BIEN;
}

// ---------------------------------------------------------------------------
// Confirmaciones
// ---------------------------------------------------------------------------

/** Una acción sensible que nadie confirmó en 30 minutos está vencida. */
export function estaVencida(creadaEn: number, ahora: number): boolean {
  return ahora - creadaEn > TOPES.minutosParaConfirmar * 60_000;
}

/**
 * Quién puede confirmar: solo quien la pidió (06-asistente §3).
 *
 * No es una formalidad. En Telegram los botones viven en un chat, y sin esto
 * cualquiera con acceso a ese chat confirmaría un cobro que pidió otra persona.
 */
export function puedeConfirmar(accion: { usuario_id: string }, usuarioId: string): boolean {
  return accion.usuario_id === usuarioId;
}
