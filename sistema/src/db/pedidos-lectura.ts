import { type Resultado, fallo, ok } from "../contrato/resultado";

/**
 * Leer pedidos. Solo leer.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 *
 * Hasta ahora el sistema sabía CREAR un pedido (`crearPedido`) y no sabía
 * enseñarlo. Ni una consulta: el panel tenía Catálogo, Existencias, Bodegas,
 * Zonas, Ajustes y Usuarios, y ninguna pantalla donde ver una venta. Eso
 * convertía el centro del negocio en el único sitio al que nadie podía mirar.
 *
 * Va aparte de `pedidos.ts` a propósito. Ahí vive la escritura, que es donde
 * están las reservas, los controles y los batches; aquí no se escribe nada, y
 * tenerlo separado hace evidente que leer un pedido no puede cambiarlo.
 *
 * LO QUE SALE DEPENDE DE QUIÉN MIRA
 *
 * Un pedido lleva dinero y puede llevar costo. La matriz de roles dice quién
 * ve qué, y aquí se respeta **en la consulta**, no escondiéndolo en la
 * pantalla: lo que no se tiene permiso de ver no se pide a la base. Esconder
 * sin filtrar deja el dato viajando hasta el navegador, donde cualquiera lo
 * mira.
 */

/** Lo que se ve de un pedido en la lista. */
export interface PedidoEnLista {
  readonly id: string;
  readonly numero: string;
  readonly estado: string;
  readonly estado_pago: string;
  readonly cliente: string | null;
  readonly origen: string;
  readonly lineas: number;
  readonly creado_en: number;
  /** Solo con permiso de `cobros`. `null` si quien mira no lo tiene. */
  readonly total_cents: number | null;
  readonly pagado_cents: number | null;
  /** Lo que falta por cobrar. `null` igual que los anteriores. */
  readonly saldo_cents: number | null;
  /** Cuándo se le vence el apartado, si tiene. */
  readonly vence_en: number | null;
}

export interface LineaDePedido {
  readonly codigo: string;
  readonly nombre: string;
  readonly cantidad: number;
  readonly precio_unit_cents: number | null;
  readonly bodega: string | null;
  /** Solo con permiso de `costo_y_margen`. */
  readonly costo_unit_cents: number | null;
}

export interface PedidoCompleto extends PedidoEnLista {
  readonly items: LineaDePedido[];
  readonly notas_cliente: string | null;
  readonly subtotal_cents: number | null;
  readonly envio_cents: number | null;
  readonly descuento_cents: number | null;
  readonly itbms_cents: number | null;
  readonly zona: string | null;
}

export interface QuienMira {
  /** Si puede ver dinero (permiso `cobros`). */
  readonly veDinero: boolean;
  /** Si puede ver el costo (permiso `costo_y_margen`). */
  readonly veCosto: boolean;
}

export interface Filtro {
  /** Uno de los estados de `pedidos.estado`, o nada para todos. */
  readonly estado?: string;
  /** Texto del número o del nombre de la clienta. */
  readonly busca?: string;
  /**
   * Los de UNA clienta, para su ficha.
   *
   * Va aquí y no en una consulta propia de `clientes.ts` porque el recorte del
   * dinero por rol vive en esta función: dos sitios decidiendo quién ve un
   * total acaban discrepando, y el que se equivoca del lado flojo es el que
   * nadie revisa.
   */
  readonly clienteId?: string;
  readonly limite?: number;
}

/**
 * Los estados por los que se puede filtrar.
 *
 * Es la lista de `ESTADOS_PEDIDO` del dominio, repetida aquí a mano igual que
 * en otras fronteras del sistema — y con una prueba en `pedidos-lectura.test.ts`
 * que falla si las dos se separan. `cotizacion` está porque una cotización es
 * el mismo documento en su primer estado: se lista y se lee con las mismas dos
 * consultas de este archivo, sin una pantalla ni una ruta paralelas.
 */
const ESTADOS = [
  "cotizacion",
  "por_abonar",
  "agendado",
  "en_ruta",
  "entregado",
  "cancelado",
  "devuelto",
] as const;

/**
 * El tope: 200 pedidos.
 *
 * No es una regla del negocio y por eso no vive en `ajustes`. Es el límite de
 * lo que tiene sentido mandarle a un teléfono de una vez; quien necesite más
 * filtra. Sin tope, el día que haya diez mil pedidos esta consulta tumba el
 * panel y el fallo aparece el día de más ventas del año.
 */
const TOPE = 200;

/**
 * Los pedidos, el más nuevo primero.
 *
 * El `COUNT` de líneas va en la misma consulta y no en una por pedido: cien
 * pedidos serían cien viajes a la base, y D1 cobra por viaje además de por
 * tiempo.
 */
export async function listarPedidos(
  db: D1Database,
  quien: QuienMira,
  filtro: Filtro = {},
): Promise<Resultado<{ pedidos: PedidoEnLista[]; hayMas: boolean }>> {
  if (filtro.estado !== undefined && !ESTADOS.includes(filtro.estado as never)) {
    return fallo("entrada_invalida", `«${filtro.estado}» no es un estado de pedido`);
  }

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), TOPE);
  const busca = (filtro.busca ?? "").trim();

  // Se pide uno de más para saber si hay página siguiente sin contar la tabla
  // entera: un COUNT(*) sobre todos los pedidos cuesta lo mismo que traerlos.
  const { results } = await db
    .prepare(
      `SELECT p.id, p.numero, p.estado, p.estado_pago, p.origen, p.creado_en,
              p.vence_en, p.total_cents, p.pagado_cents,
              c.nombre AS cliente,
              (SELECT COUNT(*) FROM pedido_lineas pl WHERE pl.pedido_id = p.id) AS lineas
         FROM pedidos p
         LEFT JOIN clientes c ON c.id = p.cliente_id
        WHERE (?1 IS NULL OR p.estado = ?1)
          AND (?2 = '' OR p.numero LIKE '%' || ?2 || '%'
                       OR c.nombre LIKE '%' || ?2 || '%')
          AND (?4 IS NULL OR p.cliente_id = ?4)
        ORDER BY p.creado_en DESC
        LIMIT ?3`,
    )
    .bind(filtro.estado ?? null, busca, limite + 1, filtro.clienteId ?? null)
    .all<{
      id: string;
      numero: string;
      estado: string;
      estado_pago: string;
      origen: string;
      creado_en: number;
      vence_en: number | null;
      total_cents: number;
      pagado_cents: number;
      cliente: string | null;
      lineas: number;
    }>();

  const hayMas = results.length > limite;
  const pedidos = results.slice(0, limite).map((p) => ({
    id: p.id,
    numero: p.numero,
    estado: p.estado,
    estado_pago: p.estado_pago,
    cliente: p.cliente,
    origen: p.origen,
    lineas: p.lineas,
    creado_en: p.creado_en,
    vence_en: p.vence_en,
    // El dinero se recorta AQUÍ, no en la pantalla: lo que no se puede ver no
    // debe llegar al navegador.
    total_cents: quien.veDinero ? p.total_cents : null,
    pagado_cents: quien.veDinero ? p.pagado_cents : null,
    saldo_cents: quien.veDinero ? p.total_cents - p.pagado_cents : null,
  }));

  return ok({ pedidos, hayMas });
}

/** Un pedido con sus líneas. */
export async function leerPedido(
  db: D1Database,
  quien: QuienMira,
  pedidoId: string,
): Promise<Resultado<PedidoCompleto>> {
  const p = await db
    .prepare(
      `SELECT p.id, p.numero, p.estado, p.estado_pago, p.origen, p.creado_en, p.vence_en,
              p.total_cents, p.pagado_cents, p.subtotal_cents, p.envio_cents,
              p.descuento_cents, p.itbms_cents, p.notas_cliente,
              c.nombre AS cliente, z.nombre AS zona
         FROM pedidos p
         LEFT JOIN clientes c ON c.id = p.cliente_id
         LEFT JOIN zonas_envio z ON z.id = p.zona_id
        WHERE p.id = ?`,
    )
    .bind(pedidoId)
    .first<{
      id: string;
      numero: string;
      estado: string;
      estado_pago: string;
      origen: string;
      creado_en: number;
      vence_en: number | null;
      total_cents: number;
      pagado_cents: number;
      subtotal_cents: number;
      envio_cents: number;
      descuento_cents: number;
      itbms_cents: number;
      notas_cliente: string | null;
      cliente: string | null;
      zona: string | null;
    }>();

  if (p === null) return fallo("no_encontrado", "no existe ese pedido");

  const { results: items } = await db
    .prepare(
      `SELECT pl.codigo, pl.nombre, pl.cantidad, pl.precio_unit_cents,
              pl.costo_unit_cents, b.nombre AS bodega
         FROM pedido_lineas pl
         LEFT JOIN bodegas b ON b.id = pl.bodega_id
        WHERE pl.pedido_id = ?
        ORDER BY pl.nombre`,
    )
    .bind(pedidoId)
    .all<{
      codigo: string;
      nombre: string;
      cantidad: number;
      precio_unit_cents: number;
      costo_unit_cents: number | null;
      bodega: string | null;
    }>();

  const dinero = <T>(v: T): T | null => (quien.veDinero ? v : null);

  return ok({
    id: p.id,
    numero: p.numero,
    estado: p.estado,
    estado_pago: p.estado_pago,
    cliente: p.cliente,
    origen: p.origen,
    lineas: items.length,
    creado_en: p.creado_en,
    vence_en: p.vence_en,
    zona: p.zona,
    notas_cliente: p.notas_cliente,
    total_cents: dinero(p.total_cents),
    pagado_cents: dinero(p.pagado_cents),
    saldo_cents: dinero(p.total_cents - p.pagado_cents),
    subtotal_cents: dinero(p.subtotal_cents),
    envio_cents: dinero(p.envio_cents),
    descuento_cents: dinero(p.descuento_cents),
    itbms_cents: dinero(p.itbms_cents),
    items: items.map((l) => ({
      codigo: l.codigo,
      nombre: l.nombre,
      cantidad: l.cantidad,
      bodega: l.bodega,
      precio_unit_cents: dinero(l.precio_unit_cents),
      // El costo es otro permiso, y más estrecho: la asistente ve lo que se
      // cobró y no lo que costó. Un margen deducido de dos cifras visibles es
      // el margen igual.
      costo_unit_cents: quien.veCosto ? l.costo_unit_cents : null,
    })),
  });
}
