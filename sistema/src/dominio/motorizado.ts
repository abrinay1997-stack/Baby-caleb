/**
 * Los motorizados: sus estados, su vehículo y el candado del PIN.
 *
 * Portado de `packages/domain/src/motorizado.ts` de Nébula. Los estados y los
 * vehículos son exactamente los del CHECK de `motorizados` (02-datos.md §5), así
 * que viajan tal cual.
 *
 * Dos diferencias:
 *
 *  - `documentosPorVencer` de Nébula NO se porta: la tabla `motorizados` de Baby
 *    Caleb no guarda documentos ni vencimientos, y una función sobre datos que
 *    no existen es una función que nadie prueba contra la realidad. Si algún día
 *    se guardan, está en Nébula para traerla.
 *  - En su lugar está el candado del PIN, que Baby Caleb sí tiene
 *    (`pin_fallos`, `bloqueado_hasta`) y Nébula no.
 */

/**
 * Las tres situaciones en las que puede estar quien reparte.
 *
 * `pausa` existe porque la alternativa —dar de baja y volver a dar de alta—
 * pierde el historial de la persona, y porque alguien de vacaciones o con la
 * moto en el taller sigue siendo del equipo. La diferencia con `inactivo` no es
 * de grado: quien está en pausa **entra y cierra lo que ya lleva encima**, y
 * quien está inactivo no entra. Pausar a alguien a media tarde no puede dejarle
 * tres paquetes sin poder marcar.
 */
export const ESTADOS_MOTORIZADO = ["activo", "pausa", "inactivo"] as const;

export type EstadoMotorizado = (typeof ESTADOS_MOTORIZADO)[number];

export const esEstadoMotorizado = (v: string): v is EstadoMotorizado =>
  (ESTADOS_MOTORIZADO as readonly string[]).includes(v);

export const ETIQUETAS_MOTORIZADO: Record<EstadoMotorizado, string> = {
  activo: "Activo",
  pausa: "En pausa",
  inactivo: "Inactivo",
};

export const AYUDA_MOTORIZADO: Record<EstadoMotorizado, string> = {
  activo: "Se le pueden asignar entregas.",
  pausa: "No recibe entregas nuevas, pero cierra las que ya lleva.",
  inactivo: "No entra a la aplicación.",
};

export const VEHICULOS = ["moto", "auto", "bicicleta", "a_pie"] as const;

export type Vehiculo = (typeof VEHICULOS)[number];

export const esVehiculo = (v: string): v is Vehiculo =>
  (VEHICULOS as readonly string[]).includes(v);

export const ETIQUETAS_VEHICULO: Record<Vehiculo, string> = {
  moto: "Moto",
  auto: "Auto",
  bicicleta: "Bicicleta",
  a_pie: "A pie",
};

/** ¿Se le puede asignar una entrega nueva? */
export function puedeRecibirEntregas(estado: EstadoMotorizado): boolean {
  return estado === "activo";
}

/** ¿Puede entrar a `ruta.babycaleb.com` y cerrar lo que lleva? */
export function puedeEntrar(estado: EstadoMotorizado): boolean {
  return estado !== "inactivo";
}

// ---------------------------------------------------------------------------
// El candado del PIN
// ---------------------------------------------------------------------------
// Las dos cifras salen de docs/plan/07-seguridad.md §«Motorizado»: «5 fallos →
// bloqueo de 15 minutos, contado en D1 (no en el rate limiting del runtime, que
// no garantiza un tope exacto)». No son a ojo.

export const FALLOS_PARA_BLOQUEAR = 5;
export const MINUTOS_DE_BLOQUEO = 15;
const MS_DE_BLOQUEO = MINUTOS_DE_BLOQUEO * 60_000;

export interface CandadoPin {
  /** `motorizados.pin_fallos`. */
  pin_fallos: number;
  /** `motorizados.bloqueado_hasta`, en ms UTC. null = no está bloqueado. */
  bloqueado_hasta: number | null;
}

export interface EstadoDelCandado {
  bloqueado: boolean;
  /** Milisegundos que faltan para poder reintentar. 0 si ya puede. */
  faltan_ms: number;
  /** Intentos que quedan antes del bloqueo. 0 si ya está bloqueado. */
  intentos_restantes: number;
}

/**
 * ¿Puede intentar el PIN ahora?
 *
 * `ahora` se pasa y no se lee del reloj aquí para que la función sea pura y se
 * pueda probar el minuto 14 y el minuto 16 sin esperar.
 */
export function estadoDelCandado(c: CandadoPin, ahora: number): EstadoDelCandado {
  const hasta = c.bloqueado_hasta;
  if (hasta !== null && Number.isFinite(hasta) && hasta > ahora) {
    return { bloqueado: true, faltan_ms: hasta - ahora, intentos_restantes: 0 };
  }
  const fallos = Number.isFinite(c.pin_fallos) ? Math.max(c.pin_fallos, 0) : 0;
  return {
    bloqueado: false,
    faltan_ms: 0,
    // Si el bloqueo ya venció, el contador se reinicia al registrar el
    // resultado del siguiente intento (ver `trasFallarElPin`).
    intentos_restantes: Math.max(FALLOS_PARA_BLOQUEAR - fallos, 0),
  };
}

/** Cómo queda el candado después de un PIN equivocado. */
export function trasFallarElPin(c: CandadoPin, ahora: number): CandadoPin {
  // Un bloqueo ya vencido no se arrastra: el contador empieza de nuevo.
  const venciaAntes = c.bloqueado_hasta !== null && c.bloqueado_hasta <= ahora;
  const fallos = (venciaAntes ? 0 : Math.max(c.pin_fallos, 0)) + 1;

  return fallos >= FALLOS_PARA_BLOQUEAR
    ? { pin_fallos: fallos, bloqueado_hasta: ahora + MS_DE_BLOQUEO }
    : { pin_fallos: fallos, bloqueado_hasta: null };
}

/** Cómo queda el candado después de un PIN correcto: limpio. */
export function trasAcertarElPin(): CandadoPin {
  return { pin_fallos: 0, bloqueado_hasta: null };
}

/** Lo que se le dice a quien está en la calle sin poder entrar. */
export function mensajeDelCandado(e: EstadoDelCandado): string {
  if (!e.bloqueado) {
    return e.intentos_restantes <= 2
      ? `PIN incorrecto. Le quedan ${e.intentos_restantes} intentos.`
      : "PIN incorrecto.";
  }
  const minutos = Math.max(1, Math.ceil(e.faltan_ms / 60_000));
  return `Demasiados intentos. Vuelva a probar en ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.`;
}
