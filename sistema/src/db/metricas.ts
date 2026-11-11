import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { atrasados } from "../eventos";
import { type Permiso, type Rol, puedeVer } from "../seguridad/roles";
import {
  DESFASE_PANAMA_MS,
  type NombrePeriodo,
  type Periodo,
  fechaPanama,
  inicioDelDia,
  periodoAnterior,
  periodoDe,
  sumarDias,
} from "../dominio/metricas";

/**
 * Las consultas del resumen. **Solo lectura**: aquí no se escribe nada.
 *
 * ## Por qué cada cifra sale de una consulta y no de una resta en memoria
 *
 * Regla del proyecto: ninguna cifra a ojo (`docs/plan/README.md`). Todo lo que
 * esta pantalla enseña sale de un `SELECT` sobre las tablas que ya son dueñas
 * del dato —`pedidos`, `pagos`, `existencias`, `envios`, `rutas`, `clientes`— y
 * las únicas cuentas que se hacen en TypeScript son las del dominio
 * (`src/dominio/metricas.ts`), que están probadas aparte.
 *
 * ## Las tres trampas que estas consultas evitan a propósito
 *
 * **1. Un cero que en realidad es «no hay datos».** La más gorda está en el
 * inventario: la carga inicial (migración 0003) deja UNA FILA POR variante y
 * bodega, todas en cero y todas sin mínimo, porque la llave foránea de
 * `movimientos_inventario` la necesita. Contarlas como «36 artículos agotados»
 * sería cierto y sería inútil: nadie ha cargado nada todavía. Por eso se mira
 * si existe algún movimiento de inventario, y mientras no exista, el bloque
 * dice que el inventario no se ha cargado en vez de dar una alarma de cero.
 *
 * **2. Un cobro contado como una venta.** Un abono de un pedido que no ha
 * salido es un anticipo, no un ingreso (`cuentaComoVenta` en
 * `src/dominio/estado-pedido.ts`, y 05-contabilidad.md). Así que «lo que entró»
 * (de `pagos`) y «lo que se entregó» (de la bitácora de `pedido_eventos`) son
 * dos cifras distintas con dos nombres distintos, y ninguna se llama «ventas»:
 * las ventas y la ganancia son de la pantalla de contabilidad, que reconoce con
 * su propio criterio.
 *
 * **3. Un dato de dinero en manos de quien no ve dinero.** No se consulta y se
 * filtra: NO SE CONSULTA. Es la regla 3 de `src/api/panel.ts` —«lo que no sale
 * del servidor no se puede filtrar por error»— y aquí significa que con el rol
 * equivocado la consulta de dinero no se ejecuta y el bloque viaja en `null`.
 */

export interface ContextoMetricas {
  readonly db: D1Database;
  /** La hora se pasa, no se lee: así una prueba puede mirar las 9 a.m. de un miércoles. */
  readonly ahora: number;
  readonly rol: Rol;
}

/** Cuántos días cubre el gráfico de entradas como máximo. */
export const DIAS_DE_SERIE = 14;

/** Cuántas filas de inventario bajo se mandan a la pantalla. */
const MAXIMO_DE_LISTA = 12;

// ---------------------------------------------------------------------------
// Quién ve qué
// ---------------------------------------------------------------------------

/**
 * Ver cifras de dinero.
 *
 * Son DOS permisos con un «o» porque la matriz de `roles.ts` parte el dinero en
 * dos oficios: `cobros` es cobrarlo (la dueña) y `contabilidad` es llevarlo (la
 * contadora, que lo ve todo en su pantalla y a quien esconderle el total de la
 * semana aquí no protegería nada). La asistente no tiene ninguno de los dos
 * —`cobros: "no"`— y es justo el caso que esto existe para cumplir: lleva
 * pedidos y gastos, y no ve lo que entró.
 */
const PERMISOS_DE_DINERO: readonly Permiso[] = ["cobros", "contabilidad"];

const veDinero = (rol: Rol): boolean => PERMISOS_DE_DINERO.some((p) => puedeVer(rol, p));

/** Ver la operación: pedidos, entregas y existencias. Es el mismo permiso que `GET /existencias`. */
const veOperacion = (rol: Rol): boolean => puedeVer(rol, "pedidos");

// ---------------------------------------------------------------------------
// Lo que viaja a la pantalla
// ---------------------------------------------------------------------------

/** Lo que espera a una persona. Cada número es una cosa que se puede hacer hoy. */
export interface Atencion {
  /** Pedidos que existen, de cualquier estado. Distingue «nada pendiente» de «nada todavía». */
  readonly pedidosEnTotal: number;
  readonly porAbonar: number;
  /** De los anteriores, los que ya pasaron su `vence_en`: la reserva está trabada. */
  readonly porAbonarVencidos: number;
  readonly agendadosSinDespachar: number;
  /** Comprobantes esperando que alguien de la casa los mire (`pagos.estado = 'confirmando'`). */
  readonly pagosPorRevisar: number;
  /** Pagos que esperan a la clienta, no a usted. */
  readonly pagosEsperandoClienta: number;
  /** Salió y nadie la cerró: lleva un día o más en la calle. */
  readonly entregasAtrasadas: number;
  readonly entregasFallidas: number;
  readonly paradasDeHoySinAsignar: number;
  readonly rutasDeHoySinSalir: number;
}

export interface Actividad {
  readonly pedidosNuevos: number;
  readonly pedidosNuevosAnterior: number;
  readonly clientasNuevas: number;
  readonly clientasNuevasAnterior: number;
  readonly clientasEnTotal: number;
}

export interface FilaDeInventario {
  readonly codigo: string;
  readonly nombre: string;
  readonly bodega: string;
  readonly libres: number;
  readonly minimo: number | null;
}

/**
 * El inventario, en dos formas que NO son la misma.
 *
 * `cargado: false` es «todavía no se ha registrado ningún movimiento»: las
 * filas existen en cero porque la migración las creó, y hablar de agotados ahí
 * sería dar por agotado lo que nunca entró.
 */
export type Inventario =
  | {
      readonly cargado: false;
      readonly filas: number;
      readonly sinMinimo: number;
    }
  | {
      readonly cargado: true;
      readonly filas: number;
      readonly sinMinimo: number;
      readonly unidades: number;
      readonly reservadas: number;
      readonly agotadas: number;
      readonly porAcabarse: number;
      readonly lista: readonly FilaDeInventario[];
      /** La lista viene cortada: hay más de las que caben. */
      readonly listaTruncada: boolean;
    };

export interface Dinero {
  /** Pagos aprobados en el periodo, en centavos. Es caja que entró, no ventas. */
  readonly entro: number;
  readonly entroAnterior: number;
  /** Aprobados sin hora de confirmación: no se pueden ubicar en ningún día. */
  readonly pagosSinFecha: number;
  /** Pedidos cuya entrega quedó registrada dentro del periodo. */
  readonly entregado: { readonly total: number; readonly pedidos: number };
  readonly entregadoAnterior: { readonly total: number; readonly pedidos: number };
  readonly devueltos: number;
  /** Saldo de los pedidos ya entregados. Es un saldo AL DÍA DE HOY, no del periodo. */
  readonly porCobrar: { readonly total: number; readonly pedidos: number };
  /** Entradas por día de Panamá, de lo más viejo a hoy. Nunca más de `DIAS_DE_SERIE`. */
  readonly serie: readonly { readonly fecha: string; readonly centavos: number }[];
}

export interface ResumenDelNegocio {
  readonly ahora: number;
  /** El día de Panamá, que es el del negocio. */
  readonly hoy: string;
  readonly periodo: Periodo;
  readonly anterior: Periodo;
  readonly avisos: { readonly sinPublicar: number; readonly masViejo: number | null };
  /** `null` = su rol no ve la operación. */
  readonly atencion: Atencion | null;
  readonly actividad: Actividad | null;
  readonly inventario: Inventario | null;
  /** `null` = su rol no ve dinero. No es que no haya: es que no le corresponde. */
  readonly dinero: Dinero | null;
}

// ---------------------------------------------------------------------------
// Las consultas
// ---------------------------------------------------------------------------

/**
 * Las fechas del negocio son TEXT 'YYYY-MM-DD', y en ese formato comparar
 * textos es comparar fechas: '2026-11-09' < '2026-11-11' es cierto como texto y
 * como día. Es la razón de que el formato sea ese y no '11/11/2026'.
 */
const SQL_ATENCION = `
  SELECT
    (SELECT COUNT(*) FROM pedidos) AS pedidos_en_total,
    (SELECT COUNT(*) FROM pedidos WHERE estado = 'por_abonar') AS por_abonar,
    (SELECT COUNT(*) FROM pedidos
      WHERE estado = 'por_abonar' AND vence_en IS NOT NULL AND vence_en <= ?1) AS por_abonar_vencidos,
    -- Agendado y sin una entrega viva: nadie lo preparó. Los estados terminales
    -- no cuentan como entrega viva, igual que en el índice único
    -- «envios_uno_vivo_por_pedido» de la migración 0009.
    (SELECT COUNT(*) FROM pedidos p WHERE p.estado = 'agendado'
       AND NOT EXISTS (SELECT 1 FROM envios e WHERE e.pedido_id = p.id
                        AND e.estado NOT IN ('entregado','devuelto','anulado'))) AS agendados_sin_despachar,
    (SELECT COUNT(*) FROM pagos WHERE estado = 'confirmando') AS pagos_por_revisar,
    (SELECT COUNT(*) FROM pagos WHERE estado = 'esperando_cliente') AS pagos_esperando_clienta,
    -- Salió de la bodega en un día anterior y sigue abierta. Una con
    -- «programado_para» nulo no entra: NULL < texto no es cierto, y además
    -- «crearEnvio» siempre le pone el día.
    (SELECT COUNT(*) FROM envios
      WHERE estado IN ('recogido','en_ruta') AND programado_para < ?2) AS entregas_atrasadas,
    -- 'fallido' no es terminal: sigue siendo la entrega viva de ese pedido hasta
    -- que alguien la resuelve, así que se cuentan todas y no solo las de hoy.
    (SELECT COUNT(*) FROM envios WHERE estado = 'fallido') AS entregas_fallidas,
    (SELECT COUNT(*) FROM envios
      WHERE programado_para = ?2 AND estado = 'pendiente') AS paradas_de_hoy_sin_asignar,
    (SELECT COUNT(*) FROM rutas WHERE fecha = ?2 AND estado = 'borrador') AS rutas_de_hoy_sin_salir
`;

/**
 * `BETWEEN` es inclusivo en los dos extremos, igual que el periodo del dominio
 * (`desde <= t <= hasta`). No es un descuido: con el extremo de arriba abierto,
 * un pedido creado justo en este milisegundo se perdería sin que nada lo dijera.
 *
 * Una clienta fusionada no se cuenta dos veces, y una anonimizada (Ley 81) ya no
 * se cuenta: las dos cosas las dice `clientes` con sus columnas.
 */
const SQL_ACTIVIDAD = `
  SELECT
    (SELECT COUNT(*) FROM pedidos WHERE creado_en BETWEEN ?1 AND ?2) AS pedidos_nuevos,
    (SELECT COUNT(*) FROM pedidos WHERE creado_en BETWEEN ?3 AND ?4) AS pedidos_nuevos_anterior,
    (SELECT COUNT(*) FROM clientes
      WHERE anonimizado_en IS NULL AND fusionado_en_id IS NULL
        AND creado_en BETWEEN ?1 AND ?2) AS clientas_nuevas,
    (SELECT COUNT(*) FROM clientes
      WHERE anonimizado_en IS NULL AND fusionado_en_id IS NULL
        AND creado_en BETWEEN ?3 AND ?4) AS clientas_nuevas_anterior,
    (SELECT COUNT(*) FROM clientes
      WHERE anonimizado_en IS NULL AND fusionado_en_id IS NULL) AS clientas_en_total
`;

/**
 * Solo variantes y bodegas activas: una bodega apagada o una talla retirada no
 * son trabajo pendiente, y contarlas haría crecer la alarma cada vez que se
 * jubila un producto.
 *
 * `libres = fisico - reservado`, que es lo único que de verdad se puede vender
 * (`disponible` en `src/dominio/existencias.ts`). Agotado y por acabarse son
 * conjuntos SIN solapar —el `> 0` del segundo— para que la suma de los dos no
 * cuente una fila dos veces.
 */
const SQL_INVENTARIO = `
  SELECT
    COUNT(*) AS filas,
    COALESCE(SUM(e.fisico), 0) AS unidades,
    COALESCE(SUM(e.reservado), 0) AS reservadas,
    COALESCE(SUM(CASE WHEN e.fisico - e.reservado <= 0 THEN 1 ELSE 0 END), 0) AS agotadas,
    COALESCE(SUM(CASE WHEN e.minimo IS NOT NULL
                       AND e.fisico - e.reservado > 0
                       AND e.fisico - e.reservado <= e.minimo THEN 1 ELSE 0 END), 0) AS por_acabarse,
    COALESCE(SUM(CASE WHEN e.minimo IS NULL THEN 1 ELSE 0 END), 0) AS sin_minimo,
    (SELECT COUNT(*) FROM movimientos_inventario) AS movimientos
  FROM existencias e
  JOIN variantes v ON v.codigo = e.codigo
  JOIN bodegas b ON b.id = e.bodega_id
  WHERE v.activo = 1 AND b.activa = 1
`;

/** Lo agotado primero, que es lo que ya está costando ventas. */
const SQL_LISTA_BAJA = `
  SELECT e.codigo, v.nombre, b.nombre AS bodega,
         e.fisico - e.reservado AS libres, e.minimo
  FROM existencias e
  JOIN variantes v ON v.codigo = e.codigo
  JOIN bodegas b ON b.id = e.bodega_id
  WHERE v.activo = 1 AND b.activa = 1
    AND (e.fisico - e.reservado <= 0
         OR (e.minimo IS NOT NULL AND e.fisico - e.reservado <= e.minimo))
  ORDER BY libres, e.codigo
  LIMIT ?1
`;

/**
 * El dinero.
 *
 * «Entró» sale de `pagos` aprobados y se fecha con `confirmado_en`, que es
 * cuando el dinero se dio por bueno. Los aprobados SIN esa hora se cuentan
 * aparte en vez de empujarlos a `creado_en`: meterlos en un día que no se sabe
 * es inventarse la fecha, y son pocos y arreglables si se ven.
 *
 * «Entregado» sale de la BITÁCORA (`pedido_eventos`), no de `pedidos.estado`.
 * Dos razones: el estado no dice CUÁNDO cambió, y una devolución de la semana
 * que viene cambiaría la cifra de esta semana para atrás. La bitácora no se
 * edita (trigger de la 0006), así que lo entregado el lunes sigue siendo lo
 * entregado el lunes.
 *
 * «Por cobrar» no lleva periodo: es un saldo al día de hoy, con la regla de
 * fechas de 05-contabilidad §5 («un saldo es al día X»).
 */
const SQL_DINERO = `
  SELECT
    (SELECT COALESCE(SUM(monto_cents), 0) FROM pagos
      WHERE estado = 'aprobado' AND confirmado_en BETWEEN ?1 AND ?2) AS entro,
    (SELECT COALESCE(SUM(monto_cents), 0) FROM pagos
      WHERE estado = 'aprobado' AND confirmado_en BETWEEN ?3 AND ?4) AS entro_anterior,
    (SELECT COUNT(*) FROM pagos
      WHERE estado = 'aprobado' AND confirmado_en IS NULL) AS pagos_sin_fecha,
    (SELECT COALESCE(SUM(p.total_cents), 0) FROM pedidos p
      WHERE EXISTS (SELECT 1 FROM pedido_eventos ev WHERE ev.pedido_id = p.id
                     AND ev.a = 'entregado' AND ev.creado_en BETWEEN ?1 AND ?2)) AS entregado_total,
    (SELECT COUNT(*) FROM pedidos p
      WHERE EXISTS (SELECT 1 FROM pedido_eventos ev WHERE ev.pedido_id = p.id
                     AND ev.a = 'entregado' AND ev.creado_en BETWEEN ?1 AND ?2)) AS entregado_pedidos,
    (SELECT COALESCE(SUM(p.total_cents), 0) FROM pedidos p
      WHERE EXISTS (SELECT 1 FROM pedido_eventos ev WHERE ev.pedido_id = p.id
                     AND ev.a = 'entregado' AND ev.creado_en BETWEEN ?3 AND ?4)) AS entregado_total_anterior,
    (SELECT COUNT(*) FROM pedidos p
      WHERE EXISTS (SELECT 1 FROM pedido_eventos ev WHERE ev.pedido_id = p.id
                     AND ev.a = 'entregado' AND ev.creado_en BETWEEN ?3 AND ?4)) AS entregado_pedidos_anterior,
    (SELECT COUNT(*) FROM pedidos p
      WHERE EXISTS (SELECT 1 FROM pedido_eventos ev WHERE ev.pedido_id = p.id
                     AND ev.a = 'devuelto' AND ev.creado_en BETWEEN ?1 AND ?2)) AS devueltos,
    (SELECT COALESCE(SUM(total_cents - pagado_cents), 0) FROM pedidos
      WHERE estado = 'entregado' AND pagado_cents < total_cents) AS por_cobrar_total,
    (SELECT COUNT(*) FROM pedidos
      WHERE estado = 'entregado' AND pagado_cents < total_cents) AS por_cobrar_pedidos,
    (SELECT MIN(creado_en) FROM pedidos) AS primer_pedido_en
`;

/**
 * Las entradas agrupadas por día DE PANAMÁ.
 *
 * El desfase entra como parámetro (`?2`) y no escrito en el SQL: la regla del
 * huso tiene un dueño, `DESFASE_PANAMA_MS` en el dominio, y una constante
 * repetida dentro de una cadena de SQL es la copia que nadie actualiza. El
 * 86 400 000 sí va escrito: es lo que mide un día, no una decisión del negocio.
 *
 * La división entera de SQLite trunca hacia cero, que para instantes posteriores
 * a 1970 es lo mismo que el suelo. Se agrupa en la base y no en TypeScript para
 * no traerse una fila por pago.
 */
const SQL_SERIE = `
  SELECT (confirmado_en - ?2) / 86400000 AS dia, COALESCE(SUM(monto_cents), 0) AS centavos
  FROM pagos
  WHERE estado = 'aprobado' AND confirmado_en IS NOT NULL AND confirmado_en >= ?1
  GROUP BY dia
`;

interface FilaAtencion {
  pedidos_en_total: number;
  por_abonar: number;
  por_abonar_vencidos: number;
  agendados_sin_despachar: number;
  pagos_por_revisar: number;
  pagos_esperando_clienta: number;
  entregas_atrasadas: number;
  entregas_fallidas: number;
  paradas_de_hoy_sin_asignar: number;
  rutas_de_hoy_sin_salir: number;
}

interface FilaActividad {
  pedidos_nuevos: number;
  pedidos_nuevos_anterior: number;
  clientas_nuevas: number;
  clientas_nuevas_anterior: number;
  clientas_en_total: number;
}

interface FilaInventario {
  filas: number;
  unidades: number;
  reservadas: number;
  agotadas: number;
  por_acabarse: number;
  sin_minimo: number;
  movimientos: number;
}

interface FilaDinero {
  entro: number;
  entro_anterior: number;
  pagos_sin_fecha: number;
  entregado_total: number;
  entregado_pedidos: number;
  entregado_total_anterior: number;
  entregado_pedidos_anterior: number;
  devueltos: number;
  por_cobrar_total: number;
  por_cobrar_pedidos: number;
  primer_pedido_en: number | null;
}

// ---------------------------------------------------------------------------
// El resumen
// ---------------------------------------------------------------------------

/**
 * Todo lo que enseña la pantalla de inicio, en una llamada.
 *
 * Una llamada y no cinco porque es lo primero que se abre en un teléfono con
 * mala señal; y las consultas van en paralelo porque son independientes y
 * ninguna escribe.
 */
export async function resumenDelNegocio(
  ctx: ContextoMetricas,
  nombre: NombrePeriodo = "hoy",
): Promise<Resultado<ResumenDelNegocio>> {
  const periodo = periodoDe(nombre, ctx.ahora);
  const anterior = periodoAnterior(periodo);
  const hoy = fechaPanama(ctx.ahora);

  try {
    const operacion = veOperacion(ctx.rol);
    const dinero = veDinero(ctx.rol);

    const [avisos, atencion, actividad, inventario, dineroDatos] = await Promise.all([
      atrasados(ctx.db),
      operacion
        ? ctx.db.prepare(SQL_ATENCION).bind(ctx.ahora, hoy).first<FilaAtencion>()
        : null,
      operacion
        ? ctx.db
            .prepare(SQL_ACTIVIDAD)
            .bind(periodo.desde, periodo.hasta, anterior.desde, anterior.hasta)
            .first<FilaActividad>()
        : null,
      operacion ? leerInventario(ctx.db) : null,
      dinero ? leerDinero(ctx.db, periodo, anterior, hoy) : null,
    ]);

    return ok({
      ahora: ctx.ahora,
      hoy,
      periodo,
      anterior,
      avisos: { sinPublicar: avisos.cuantos, masViejo: avisos.masViejo },
      atencion: atencion === null ? null : conFormaDeAtencion(atencion),
      actividad: actividad === null ? null : conFormaDeActividad(actividad),
      inventario,
      dinero: dineroDatos,
    });
  } catch (err) {
    // El motivo técnico viaja al panel y el panel lo enseña en pequeño: sin él,
    // quien tenga que repararlo trabaja a ciegas.
    return fallo("interno", `no se pudo armar el resumen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const conFormaDeAtencion = (f: FilaAtencion): Atencion => ({
  pedidosEnTotal: f.pedidos_en_total,
  porAbonar: f.por_abonar,
  porAbonarVencidos: f.por_abonar_vencidos,
  agendadosSinDespachar: f.agendados_sin_despachar,
  pagosPorRevisar: f.pagos_por_revisar,
  pagosEsperandoClienta: f.pagos_esperando_clienta,
  entregasAtrasadas: f.entregas_atrasadas,
  entregasFallidas: f.entregas_fallidas,
  paradasDeHoySinAsignar: f.paradas_de_hoy_sin_asignar,
  rutasDeHoySinSalir: f.rutas_de_hoy_sin_salir,
});

const conFormaDeActividad = (f: FilaActividad): Actividad => ({
  pedidosNuevos: f.pedidos_nuevos,
  pedidosNuevosAnterior: f.pedidos_nuevos_anterior,
  clientasNuevas: f.clientas_nuevas,
  clientasNuevasAnterior: f.clientas_nuevas_anterior,
  clientasEnTotal: f.clientas_en_total,
});

/**
 * El inventario, decidiendo primero si hay inventario del que hablar.
 *
 * `movimientos = 0` significa que NUNCA ha entrado ni salido nada: las
 * existencias solo se mueven por `src/db/inventario.ts`, que escribe un
 * movimiento en el mismo batch. Entonces las filas en cero son las que creó la
 * migración y no un almacén vacío, y la lista de agotados no se consulta
 * siquiera: serían las treinta y seis de la carga inicial.
 */
async function leerInventario(db: D1Database): Promise<Inventario> {
  const f = await db.prepare(SQL_INVENTARIO).first<FilaInventario>();
  const base = { filas: f?.filas ?? 0, sinMinimo: f?.sin_minimo ?? 0 };
  if (f === null || f.movimientos === 0) return { cargado: false, ...base };

  const { results } = await db
    .prepare(SQL_LISTA_BAJA)
    .bind(MAXIMO_DE_LISTA + 1)
    .all<FilaDeInventario>();

  return {
    cargado: true,
    ...base,
    unidades: f.unidades,
    reservadas: f.reservadas,
    agotadas: f.agotadas,
    porAcabarse: f.por_acabarse,
    // Se pide una de más justo para saber si sobran, y así la pantalla puede
    // decir «y algunas más» en vez de dar la lista por completa.
    lista: results.slice(0, MAXIMO_DE_LISTA),
    listaTruncada: results.length > MAXIMO_DE_LISTA,
  };
}

async function leerDinero(
  db: D1Database,
  periodo: Periodo,
  anterior: Periodo,
  hoy: string,
): Promise<Dinero> {
  const f = await db
    .prepare(SQL_DINERO)
    .bind(periodo.desde, periodo.hasta, anterior.desde, anterior.hasta)
    .first<FilaDinero>();

  return {
    entro: f?.entro ?? 0,
    entroAnterior: f?.entro_anterior ?? 0,
    pagosSinFecha: f?.pagos_sin_fecha ?? 0,
    entregado: { total: f?.entregado_total ?? 0, pedidos: f?.entregado_pedidos ?? 0 },
    entregadoAnterior: {
      total: f?.entregado_total_anterior ?? 0,
      pedidos: f?.entregado_pedidos_anterior ?? 0,
    },
    devueltos: f?.devueltos ?? 0,
    porCobrar: { total: f?.por_cobrar_total ?? 0, pedidos: f?.por_cobrar_pedidos ?? 0 },
    serie: await leerSerie(db, hoy, f?.primer_pedido_en ?? null),
  };
}

/**
 * Las entradas por día, y NUNCA días anteriores a que el sistema existiera.
 *
 * Es la parte sutil: rellenar con ceros los días sin pagos es correcto —ese día
 * no entró nada— pero solo desde que había algo que pudiera entrar. Si el primer
 * pedido es de anteayer, pintar catorce barras en cero diría que el negocio
 * lleva dos semanas sin vender. Así que la serie empieza en el día del primer
 * pedido o hace `DIAS_DE_SERIE` días, el que sea más reciente.
 */
async function leerSerie(
  db: D1Database,
  hoy: string,
  primerPedidoEn: number | null,
): Promise<Dinero["serie"]> {
  if (primerPedidoEn === null) return [];

  const masViejoQueMiro = sumarDias(hoy, -(DIAS_DE_SERIE - 1));
  const arranque = fechaPanama(primerPedidoEn);
  const desdeFecha = arranque > masViejoQueMiro ? arranque : masViejoQueMiro;
  const desde = inicioDelDia(desdeFecha);

  const { results } = await db
    .prepare(SQL_SERIE)
    .bind(desde, DESFASE_PANAMA_MS)
    .all<{ dia: number; centavos: number }>();

  // El índice que devuelve la base es el número de día de Panamá desde 1970;
  // volver a fecha con la misma función del dominio es lo que mantiene una sola
  // forma de saber en qué día cae un instante.
  const porDia = new Map(
    results.map((r) => [fechaPanama(r.dia * 86_400_000 + DESFASE_PANAMA_MS), r.centavos]),
  );

  const serie: { fecha: string; centavos: number }[] = [];
  for (let f = desdeFecha; f <= hoy; f = sumarDias(f, 1)) {
    serie.push({ fecha: f, centavos: porDia.get(f) ?? 0 });
  }
  return serie;
}
