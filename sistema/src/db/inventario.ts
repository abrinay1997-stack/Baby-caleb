import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { ulid } from "../ids";

/**
 * Mover el inventario sin transacciones interactivas.
 *
 * D1 no las tiene. `db.batch()` es todo o nada, PERO un UPDATE que no encuentra
 * su fila cambia cero filas y el batch sigue tan contento. Así que «descuenta
 * 5 si hay 5» no se puede escribir como un UPDATE con WHERE y confiar.
 *
 * La forma que sí funciona (02-datos §1) es la fila de control: después del
 * UPDATE se inserta en `controles` una fila cuyo `ok` se calcula con un SELECT
 * sobre el estado YA cambiado, y la tabla tiene `CHECK (ok = 1)`. Si el UPDATE
 * no hizo lo suyo, el SELECT da 0, el CHECK revienta y se cae el batch entero
 * —movimiento incluido—. `SELECT RAISE()` no sirve fuera de un trigger; esta
 * fila sí.
 *
 * Todo lo que escribe en el inventario pasa por aquí. Es a propósito: si cada
 * sitio armara su propio batch, bastaría uno que se olvidara de la fila de
 * control para que el stock quedara en negativo sin que nada protestara.
 */

/** Los tipos de movimiento que estas funciones escriben. */
export type TipoMovimiento =
  | "apertura"
  | "compra"
  | "venta"
  | "devolucion"
  | "ajuste"
  | "merma"
  | "muestra"
  | "regalo"
  | "traslado_salida"
  | "traslado_entrada"
  | "conteo";

/** Los que el esquema obliga a justificar. */
const EXIGEN_MOTIVO = new Set(["ajuste", "merma", "muestra", "regalo", "conteo"]);

export interface Linea {
  readonly codigo: string;
  readonly cantidad: number;
  /** Nombre de la bodega. Si falta, se elige la que tenga con qué. */
  readonly bodega?: string;
}

export interface Movimiento {
  readonly codigo: string;
  readonly bodegaId: string;
  /** Positivo entra, negativo sale. Nunca cero: el esquema lo prohíbe. */
  readonly delta: number;
  readonly tipo: TipoMovimiento;
  readonly motivo?: string;
  readonly costoUnitCents?: number;
  readonly revierteId?: string;
}

export interface Contexto {
  readonly db: D1Database;
  readonly actor: string;
  readonly ahora: number;
}

/**
 * Escribe varios movimientos y deja las existencias cuadradas, o no escribe
 * ninguno.
 *
 * `referenciaId` es la llave que agrupa la operación entera, y es también el
 * `deshacerId` que se devuelve: deshacer es buscar por ahí y escribir lo
 * contrario.
 */
export async function aplicar(
  ctx: Contexto,
  movimientos: readonly Movimiento[],
  referencia: { tipo: string; id: string },
): Promise<Resultado<{ deshacerId: string }>> {
  if (movimientos.length === 0) {
    return fallo("entrada_invalida", "no hay nada que mover");
  }

  for (const m of movimientos) {
    if (!Number.isSafeInteger(m.delta) || m.delta === 0) {
      return fallo("entrada_invalida", `el movimiento de ${m.codigo} no puede ser ${m.delta}`);
    }
    if (EXIGEN_MOTIVO.has(m.tipo) && (m.motivo ?? "").trim() === "") {
      // El esquema también lo exige con un CHECK; aquí se dice antes y con
      // palabras, para que el mensaje sirva de algo.
      return fallo("entrada_invalida", `un movimiento de «${m.tipo}» necesita motivo`);
    }
  }

  const enunciados: D1PreparedStatement[] = [];

  for (const m of movimientos) {
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO movimientos_inventario
             (id, codigo, bodega_id, delta, tipo, costo_unit_cents, referencia_tipo, referencia_id,
              motivo, actor, revierte_id, creado_en)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ulid(ctx.ahora),
          m.codigo,
          m.bodegaId,
          m.delta,
          m.tipo,
          m.costoUnitCents ?? null,
          referencia.tipo,
          referencia.id,
          m.motivo ?? null,
          ctx.actor,
          m.revierteId ?? null,
          ctx.ahora,
        ),
    );

    enunciados.push(
      ctx.db
        .prepare("UPDATE existencias SET fisico = fisico + ? WHERE codigo = ? AND bodega_id = ?")
        .bind(m.delta, m.codigo, m.bodegaId),
    );

    // La fila de control. Mira el estado YA cambiado: si el UPDATE no encontró
    // su fila, o si dejó el físico por debajo de lo reservado, aquí `ok` sale 0
    // y el CHECK tumba el batch entero.
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM existencias
                          WHERE codigo = ? AND bodega_id = ? AND fisico >= reservado), ?)`,
        )
        .bind(ulid(ctx.ahora), `mover:${m.tipo}:${m.codigo}`, m.codigo, m.bodegaId, ctx.ahora),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    // `sin_stock` y no un código inventado: los doce del contrato son los
    // que hay (03-contratos §5), y el que llega aquí casi siempre es que
    // no alcanzaba.
    return fallo("sin_stock", comoSeLee(e, movimientos));
  }

  return ok({ deshacerId: referencia.id });
}

/**
 * Traduce el error de la base a algo que se pueda leer.
 *
 * Sin esto, lo que sube es «SQLITE_CONSTRAINT», que no le dice a nadie que lo
 * que pasó es que no había suficiente.
 */
function comoSeLee(e: unknown, movimientos: readonly Movimiento[]): string {
  const crudo = e instanceof Error ? e.message : String(e);

  if (/CHECK|controles/i.test(crudo)) {
    const salidas = movimientos.filter((m) => m.delta < 0).map((m) => m.codigo);
    return salidas.length > 0
      ? `no alcanza el inventario de ${salidas.join(", ")}, o esa bodega no tiene ese artículo`
      : "el inventario no quedó cuadrado y no se escribió nada";
  }
  if (/FOREIGN KEY/i.test(crudo)) {
    return "ese artículo no existe en esa bodega";
  }
  return crudo;
}

/**
 * En qué bodega hay con qué.
 *
 * Elige la que más libre tenga, no la primera: repartir las salidas por donde
 * hay evita que una bodega quede en cero mientras otra está llena, que es lo
 * que obliga a un traslado de urgencia.
 */
export async function bodegaConExistencia(
  db: D1Database,
  codigo: string,
  cantidad: number,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare(
      `SELECT b.id, b.nombre FROM existencias e
       JOIN bodegas b ON b.id = e.bodega_id
       WHERE e.codigo = ? AND b.activa = 1 AND e.fisico - e.reservado >= ?
       ORDER BY e.fisico - e.reservado DESC
       LIMIT 1`,
    )
    .bind(codigo, cantidad)
    .first<{ id: string; nombre: string }>();
}

export async function bodegaPorNombre(
  db: D1Database,
  nombre: string,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare("SELECT id, nombre FROM bodegas WHERE nombre = ? AND activa = 1")
    .bind(nombre)
    .first<{ id: string; nombre: string }>();
}

/**
 * Resuelve en qué bodega va cada línea antes de tocar nada.
 *
 * Se hace entero y por adelantado: si la tercera línea no tiene dónde salir, no
 * se ha escrito nada todavía y el mensaje puede decir exactamente cuál falló.
 */
export async function resolverLineas(
  db: D1Database,
  lineas: readonly Linea[],
): Promise<Resultado<{ codigo: string; cantidad: number; bodegaId: string; bodega: string }[]>> {
  const salida: { codigo: string; cantidad: number; bodegaId: string; bodega: string }[] = [];

  for (const l of lineas) {
    if (!Number.isSafeInteger(l.cantidad) || l.cantidad <= 0) {
      return fallo("entrada_invalida", `la cantidad de ${l.codigo} tiene que ser un entero positivo`);
    }

    const bodega =
      l.bodega === undefined
        ? await bodegaConExistencia(db, l.codigo, l.cantidad)
        : await bodegaPorNombre(db, l.bodega);

    if (bodega === null) {
      return l.bodega === undefined
        ? fallo("sin_stock", `no hay ${l.cantidad} de ${l.codigo} en ninguna bodega`)
        : fallo("no_encontrado", `no existe la bodega «${l.bodega}»`);
    }

    salida.push({ codigo: l.codigo, cantidad: l.cantidad, bodegaId: bodega.id, bodega: bodega.nombre });
  }

  return ok(salida);
}

/**
 * Deshacer: escribir lo contrario, nunca borrar.
 *
 * Los libros no se editan (02-datos §1). Deshacer una venta no es quitar la
 * venta: es anotar la entrada que la compensa, con `revierte_id` apuntando al
 * movimiento original para que se vea qué deshizo qué.
 *
 * Deshacer dos veces no duplica nada: la segunda no encuentra movimientos sin
 * revertir y se va con `no_encontrado`.
 */
export async function deshacer(
  ctx: Contexto,
  deshacerId: string,
): Promise<Resultado<{ hecho: true; movimientos: number }>> {
  const { results } = await ctx.db
    .prepare(
      `SELECT m.id, m.codigo, m.bodega_id, m.delta, m.tipo, m.costo_unit_cents
       FROM movimientos_inventario m
       WHERE m.referencia_id = ?
         AND NOT EXISTS (SELECT 1 FROM movimientos_inventario r WHERE r.revierte_id = m.id)`,
    )
    .bind(deshacerId)
    .all<{
      id: string;
      codigo: string;
      bodega_id: string;
      delta: number;
      tipo: string;
      costo_unit_cents: number | null;
    }>();

  if (results.length === 0) {
    return fallo("no_encontrado", "no hay nada que deshacer con ese identificador (o ya se deshizo)");
  }

  const contrarios: Movimiento[] = results.map((m) => ({
    codigo: m.codigo,
    bodegaId: m.bodega_id,
    delta: -m.delta,
    // El contrario de una salida es una devolución y el de una entrada un
    // ajuste: así el tipo sigue diciendo qué pasó en vez de mentir «venta».
    tipo: m.delta < 0 ? ("devolucion" as const) : ("ajuste" as const),
    motivo: `deshace ${deshacerId}`,
    revierteId: m.id,
    ...(m.costo_unit_cents === null ? {} : { costoUnitCents: m.costo_unit_cents }),
  }));

  const r = await aplicar(ctx, contrarios, { tipo: "deshacer", id: ulid(ctx.ahora) });
  if (!r.ok) return r;

  return ok({ hecho: true as const, movimientos: contrarios.length });
}

/**
 * Las etiquetas de disponibilidad DESPUÉS de mover.
 *
 * El CRM las necesita para contestar en el mismo turno («quedan pocas»), y
 * tienen que salir de después y no de antes, o el bot diría que hay de algo
 * que se acaba de llevar la última caja.
 */
export async function etiquetasDe(
  db: D1Database,
  codigos: readonly string[],
): Promise<Record<string, number>> {
  if (codigos.length === 0) return {};
  const marcas = codigos.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT codigo, SUM(fisico - reservado) AS libres FROM existencias
       WHERE codigo IN (${marcas}) GROUP BY codigo`,
    )
    .bind(...codigos)
    .all<{ codigo: string; libres: number }>();

  return Object.fromEntries(results.map((r) => [r.codigo, r.libres]));
}
