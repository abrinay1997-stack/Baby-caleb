import { z } from "zod";

/**
 * Los eventos de cola. **Esto es contrato**: `bc-avisos` lo consume el CRM, y
 * está copiado de docs/plan/03-contratos.md §4. Cambiar un nombre o quitar un
 * campo aquí rompe el otro repo, así que se cambia en el plan primero.
 *
 * Los datos de las clientas NO viajan en los eventos: va una `clienteRef` y el
 * CRM resuelve a quién avisar con sus propios datos. Es la decisión D-20 («al
 * modelo del asistente no le llegan datos personales de clientas») aplicada
 * también aquí: un evento que cruza una cola se guarda, se reintenta y se
 * registra, y cuantos menos datos personales pase por ahí, mejor.
 */

export const COLAS = ["bc-avisos", "bc-tareas"] as const;
export type Cola = (typeof COLAS)[number];

/** Lo que consume el CRM. */
export const TIPOS_AVISOS = [
  "pedido.creado",
  "pago.confirmado",
  "pedido.agendado",
  "pedido.en_ruta",
  "pedido.entregado",
  "pedido.cancelado",
  "inventario.bajo",
  "sistema.alerta",
] as const;

/** Lo que el sistema se manda a sí mismo. */
export const TIPOS_TAREAS = [
  "meta.purchase",
  "pago.consultar",
  "reporte.excel",
  "correo.enviar",
] as const;

export type TipoAviso = (typeof TIPOS_AVISOS)[number];
export type TipoTarea = (typeof TIPOS_TAREAS)[number];
export type TipoEvento = TipoAviso | TipoTarea;

export const TIPOS_EVENTO = [...TIPOS_AVISOS, ...TIPOS_TAREAS] as const;

export const esTipoEvento = (v: string): v is TipoEvento =>
  (TIPOS_EVENTO as readonly string[]).includes(v);

/**
 * A qué cola va cada tipo. Se deriva del tipo y no se pasa como parámetro a
 * propósito: así es imposible mandar un `pago.confirmado` a `bc-tareas` por un
 * dedo, y el consumidor equivocado nunca ve un evento que no entiende.
 */
export function colaDe(tipo: TipoEvento): Cola {
  return (TIPOS_AVISOS as readonly string[]).includes(tipo) ? "bc-avisos" : "bc-tareas";
}

/** El sobre de todo mensaje. */
export interface Evento<T = unknown> {
  /** ULID. El consumidor lo guarda en `eventos_recibidos` y no lo repite. */
  id: string;
  tipo: TipoEvento;
  version: 1;
  ocurridoEn: number;
  datos: T;
}

// ---------------------------------------------------------------------------
// Los datos de cada tipo
// ---------------------------------------------------------------------------

/** Referencia opaca a una clienta. El CRM la resuelve; el evento no la lleva. */
const clienteRef = z.string().min(1);
const numero = z.string().min(1); // «BC-000123»
const tokenPublico = z.string().min(1);
const centavos = z.number().int();

export const DatosAviso = {
  "pedido.creado": z.object({
    numero,
    token: tokenPublico,
    origen: z.enum(["web", "whatsapp", "instagram", "messenger", "telegram", "panel"]),
    clienteRef,
    totalCents: centavos,
  }),
  "pago.confirmado": z.object({
    numero,
    token: tokenPublico,
    montoCents: centavos,
    metodo: z.string().min(1),
    estadoPago: z.enum(["sin_pago", "abonado", "pagado", "reembolso_parcial", "reembolsado"]),
    clienteRef,
  }),
  "pedido.agendado": z.object({
    numero,
    token: tokenPublico,
    // Las ventanas de entrega están PENDIENTE de la dueña (02-datos §9), así
    // que aquí es texto libre y no una lista cerrada: cerrarla ahora sería
    // inventar sus horarios.
    ventana: z.string().nullable(),
    clienteRef,
  }),
  "pedido.en_ruta": z.object({
    numero,
    token: tokenPublico,
    motorizadoNombre: z.string().min(1),
    clienteRef,
  }),
  "pedido.entregado": z.object({
    numero,
    clienteRef,
    /** Los códigos comprados: el CRM los usa para el descanso y la recompra. */
    codigos: z.array(z.string().min(1)),
  }),
  "pedido.cancelado": z.object({
    numero,
    motivo: z.string().min(1),
    clienteRef,
  }),
  "inventario.bajo": z.object({
    codigo: z.string().min(1),
    /** La etiqueta, no la cantidad: el número exacto no sale del sistema. */
    etiqueta: z.enum(["disponible", "pocas", "agotado"]),
    bodega: z.string().min(1),
  }),
  "sistema.alerta": z.object({
    nivel: z.enum(["aviso", "error", "critico"]),
    mensaje: z.string().min(1),
  }),
} as const satisfies Record<TipoAviso, z.ZodType>;

export const DatosTarea = {
  /** `event_id` de la Conversions API = id del pago (03-contratos §4). */
  "meta.purchase": z.object({ pagoId: z.string().min(1) }),
  /** Un pago que quedó en «confirmando» y hay que preguntarle a la pasarela. */
  "pago.consultar": z.object({ pagoId: z.string().min(1) }),
  // Estas dos se completan en su fase (F5 los reportes, F7 el correo): lo que
  // hace falta ahora es que el tipo exista para que la cola y la cola muerta se
  // puedan probar. `passthrough` deja pasar campos que todavía no se conocen.
  "reporte.excel": z.looseObject({ clase: z.string().min(1) }),
  "correo.enviar": z.looseObject({ plantilla: z.string().min(1) }),
} as const satisfies Record<TipoTarea, z.ZodType>;

export const DATOS_POR_TIPO = { ...DatosAviso, ...DatosTarea } as const;

/** El sobre, validado. Lo usa el consumidor con lo que saca de la cola. */
export const SobreEvento = z.object({
  id: z.string().min(1),
  tipo: z.enum(TIPOS_EVENTO),
  version: z.literal(1),
  ocurridoEn: z.number().int(),
  datos: z.unknown(),
});

export type ResultadoValidacion =
  | { ok: true; evento: Evento }
  | { ok: false; motivo: string };

/**
 * Valida un mensaje recién sacado de la cola: primero el sobre y después los
 * datos según su tipo.
 *
 * Un mensaje que no valida NO se reintenta: reintentarlo cinco veces y mandarlo
 * a la cola muerta solo retrasa el aviso. Si llegó mal formado, es un error de
 * programación de quien lo publicó, no una falla pasajera.
 */
export function validarEvento(crudo: unknown): ResultadoValidacion {
  const sobre = SobreEvento.safeParse(crudo);
  if (!sobre.success) {
    return { ok: false, motivo: `sobre inválido: ${sobre.error.issues[0]?.message ?? "?"}` };
  }
  const esquema = DATOS_POR_TIPO[sobre.data.tipo];
  const datos = esquema.safeParse(sobre.data.datos);
  if (!datos.success) {
    const problema = datos.error.issues[0];
    return {
      ok: false,
      motivo: `datos de ${sobre.data.tipo}: ${problema?.path.join(".") ?? "?"} ${problema?.message ?? ""}`.trim(),
    };
  }
  return { ok: true, evento: { ...sobre.data, datos: datos.data } as Evento };
}
