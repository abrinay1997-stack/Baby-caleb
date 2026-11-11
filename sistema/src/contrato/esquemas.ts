import { z } from "zod";

/**
 * Las formas que cruzan los service bindings.
 *
 * **Esto es contrato.** Está copiado de docs/plan/03-contratos.md §2 y §3, y el
 * CRM tiene una copia en `src/sistema/contrato.ts`. Una prueba en cada repo
 * falla si la huella (`huella.ts`) no coincide con la del otro, así que esto no
 * se toca sin tocar los dos lados — y el plan primero.
 *
 * Dos reglas que se ven en todos los esquemas y conviene decir una vez:
 *
 *  - **Los montos son enteros de centavos**, y los calcula siempre el sistema.
 *    Ningún método de entrada acepta un precio: `crearPedido` recibe códigos y
 *    cantidades, no importes. El navegador no decide un cobro.
 *  - **El bot y la web nunca reciben el costo ni la cantidad exacta de stock.**
 *    Reciben `disponibilidad`, que es una etiqueta de tres valores. Lo que no
 *    sale del sistema no se puede filtrar por error.
 */

const centavos = z.number().int();
const codigo = z.string().min(1).max(64);

/** Los tres valores del CRM (`src/catalog/validation.ts`). */
export const Disponibilidad = z.enum(["disponible", "pocas", "agotado"]);

/**
 * La respuesta a «¿alcanza para 30?».
 *
 * Está aquí porque es la ÚNICA puerta por la que una cantidad de inventario
 * sale del sistema, y hasta ahora no estaba: `buscarCatalogo` devolvía el campo
 * `pedido` y el contrato no lo mencionaba, así que la huella no vigilaba
 * precisamente el campo que lleva el número exacto. Un dato sin dueño en el
 * contrato es un dato que los dos repos pueden entender distinto sin que nada
 * se ponga rojo.
 *
 * `alcanza` es un sí o un no y puede venir en cada artículo de la respuesta.
 * `maximoDisponible` es la cantidad exacta y viene UNA VEZ por llamada, en el
 * artículo que mejor casa con lo buscado: «de 30 no, de 20 sí» es la respuesta
 * útil y no hay manera de darla sin el número, pero el catálogo entero con su
 * número cada uno no es una respuesta, es el inventario.
 */
export const Cobertura = z.object({
  cantidadPedida: z.number().int().positive(),
  alcanza: z.boolean(),
  maximoDisponible: z.number().int().nonnegative().optional(),
});

export const VariantePublica = z.object({
  codigo,
  slug: z.string().min(1),
  nombre: z.string().min(1),
  talla: z.string().nullable(),
  pesoMinLb: z.number().nullable(),
  pesoMaxLb: z.number().nullable(),
  unidadesPorCaja: z.number().int().positive(),
  precioCents: centavos.positive(),
  disponibilidad: Disponibilidad,
  /** Solo si se preguntó por una cantidad concreta. La web nunca lo recibe. */
  pedido: Cobertura.optional(),
  // Deliberadamente NO hay costo, ni stock, ni bodega.
});

export const CatalogoPublico = z.object({
  version: z.number().int(),
  generadoEn: z.number().int(),
  variantes: z.array(VariantePublica),
});

export const ZonaPublica = z.object({
  id: z.string().min(1),
  nombre: z.string().min(1),
  alias: z.array(z.string()),
  region: z.enum(["ciudad", "interior"]),
  /** null = se cotiza a mano. No es gratis: es que todavía no se sabe. */
  tarifaCents: centavos.nullable(),
  requierePagoTotal: z.boolean(),
});

export const MetodoDePago = z.enum([
  "yappy",
  "tilopay",
  "paypal",
  "manual",
  "efectivo",
]);

/** Quién actúa. Viaja en cada llamada que escribe. */
export const Actor = z.object({
  tipo: z.enum(["bot", "duena", "usuario"]),
  id: z.string().min(1),
  canal: z.string().min(1),
  conversacionRef: z.string().optional(),
});

/** Cómo se reconoce a una clienta sin pasar sus datos personales. */
export const IdentidadRef = z.object({
  canal: z.enum([
    "web",
    "whatsapp_qr",
    "whatsapp_cloud",
    "instagram",
    "messenger",
    "telegram",
    "panel",
  ]),
  idExterno: z.string().min(1),
});

/**
 * Lo que se le puede contar de un pedido a quien tiene su enlace.
 *
 * Sin nombre, sin celular y sin la dirección completa (07-seguridad.md §4): el
 * token sale en un enlace, y un enlace se reenvía. Lleva la zona, que basta
 * para saber a dónde va, y no el texto de la calle.
 */
export const EstadoPublicoPedido = z.object({
  numero: z.string().min(1),
  token: z.string().min(1),
  estado: z.enum(["por_abonar", "agendado", "en_ruta", "entregado", "cancelado", "devuelto"]),
  estadoPago: z.enum(["sin_pago", "abonado", "pagado", "reembolso_parcial", "reembolsado"]),
  totalCents: centavos,
  pagadoCents: centavos,
  saldoCents: centavos,
  zona: z.string().nullable(),
  programadoPara: z.string().nullable(),
  ventana: z.string().nullable(),
  lineas: z.array(
    z.object({ codigo, nombre: z.string(), cantidad: z.number().int().positive() }),
  ),
  creadoEn: z.number().int(),
});

// ---------------------------------------------------------------------------
// Entradas y salidas de los métodos que escriben
// ---------------------------------------------------------------------------

/** Toda escritura lleva su clave de idempotencia (03-contratos §5). */
const idempotencia = z.string().min(8).max(128);

export const CrearPedidoEntrada = z.object({
  idempotencia,
  // Códigos y cantidades. Nada de precios: los pone el sistema.
  lineas: z.array(z.object({ codigo, cantidad: z.number().int().positive() })).min(1),
  cliente: z.object({
    nombre: z.string().min(1),
    celular: z.string().min(1),
    correo: z.string().optional(),
    consentimientoMkt: z.boolean(),
  }),
  entrega: z.object({
    zonaId: z.string().min(1),
    texto: z.string().min(1),
    referencia: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    precision: z.enum(["gps", "pin", "geocodificado", "manual"]).optional(),
  }),
  notas: z.string().optional(),
  identidadWeb: z.string().optional(),
});

export const CrearPedidoSalida = z.object({
  numero: z.string().min(1),
  token: z.string().min(1),
  totalCents: centavos,
  abonoMinimoCents: centavos,
  requierePagoTotal: z.boolean(),
  venceEn: z.number().int().nullable(),
  metodos: z.array(MetodoDePago),
});

export const IniciarPagoEntrada = z.object({
  token: z.string().min(1),
  proveedor: z.enum(["yappy", "tilopay", "paypal"]),
  tipo: z.enum(["abono", "total"]),
  montoCents: centavos.optional(),
  idempotencia,
});

export const IniciarPagoSalida = z.object({
  pagoId: z.string().min(1),
  redirectUrl: z.string().optional(),
  datosBoton: z.record(z.string(), z.unknown()).optional(),
});

export const RegistrarVentaEntrada = z.object({
  idempotencia,
  lineas: z
    .array(z.object({ codigo, cantidad: z.number().int().positive(), bodega: z.string().optional() }))
    .min(1),
  pagado: z.enum(["todo", "abono", "nada"]),
  metodo: z.string().optional(),
  clienteRef: IdentidadRef.optional(),
});

export const RegistrarVentaSalida = z.object({
  numero: z.string().min(1),
  deshacerId: z.string().min(1),
  /** Por código, la etiqueta que queda. Nunca el número. */
  etiquetas: z.record(z.string(), Disponibilidad),
});

export const AjustarStockEntrada = z.object({
  idempotencia,
  codigo,
  bodega: z.string().min(1),
  modo: z.enum(["sumar", "restar", "fijar"]),
  cantidad: z.number().int().nonnegative(),
  // Obligatorio: el CHECK de `movimientos_inventario` no deja un ajuste sin
  // motivo, así que pedirlo aquí evita un viaje a la base para fallar.
  motivo: z.string().min(1),
});

export const CotizarEnvioSalida = z.union([
  z.object({
    zona: z.string().min(1),
    tarifaCents: centavos.nullable(),
    requierePagoTotal: z.boolean(),
  }),
  // Cuando no hay una sola respuesta clara se devuelven sugerencias, porque
  // adivinar la zona es adivinar la tarifa.
  z.object({ zona: z.null(), sugerencias: z.array(z.string()) }),
]);

/**
 * El registro: todo esquema que forma parte del contrato está aquí, y de aquí
 * sale la huella. Si se agrega un esquema y no se registra, no cuenta como
 * contrato y el otro repo no se enterará de que cambió.
 */
export const ESQUEMAS = {
  Disponibilidad,
  Cobertura,
  VariantePublica,
  CatalogoPublico,
  ZonaPublica,
  MetodoDePago,
  Actor,
  IdentidadRef,
  EstadoPublicoPedido,
  CrearPedidoEntrada,
  CrearPedidoSalida,
  IniciarPagoEntrada,
  IniciarPagoSalida,
  RegistrarVentaEntrada,
  RegistrarVentaSalida,
  AjustarStockEntrada,
  CotizarEnvioSalida,
} as const;

export type Disponibilidad = z.infer<typeof Disponibilidad>;
export type Cobertura = z.infer<typeof Cobertura>;
export type VariantePublica = z.infer<typeof VariantePublica>;
export type CatalogoPublico = z.infer<typeof CatalogoPublico>;
export type ZonaPublica = z.infer<typeof ZonaPublica>;
export type MetodoDePago = z.infer<typeof MetodoDePago>;
export type Actor = z.infer<typeof Actor>;
export type IdentidadRef = z.infer<typeof IdentidadRef>;
export type EstadoPublicoPedido = z.infer<typeof EstadoPublicoPedido>;
export type CrearPedidoEntrada = z.infer<typeof CrearPedidoEntrada>;
export type CrearPedidoSalida = z.infer<typeof CrearPedidoSalida>;
export type IniciarPagoEntrada = z.infer<typeof IniciarPagoEntrada>;
export type IniciarPagoSalida = z.infer<typeof IniciarPagoSalida>;
export type RegistrarVentaEntrada = z.infer<typeof RegistrarVentaEntrada>;
export type RegistrarVentaSalida = z.infer<typeof RegistrarVentaSalida>;
export type AjustarStockEntrada = z.infer<typeof AjustarStockEntrada>;
export type CotizarEnvioSalida = z.infer<typeof CotizarEnvioSalida>;
