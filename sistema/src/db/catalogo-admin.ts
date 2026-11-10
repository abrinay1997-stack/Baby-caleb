import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";

/**
 * Crear, editar y borrar productos desde el panel (F4.19).
 *
 * Lo pidió el dueño así: que Yarielis pueda crear productos, ponerles precio,
 * agruparlos y borrarlos, «y que cuando se eliminan el sistema quede limpio».
 *
 * ## Qué significa «borrar» aquí, y por qué no siempre es borrar
 *
 * Una variante que nunca pasó nada se puede borrar de verdad. Una que YA SE
 * VENDIÓ, no: `pedido_lineas` guarda lo que una clienta compró, y
 * `movimientos_inventario` guarda que esa caja entró y salió de una bodega.
 * Borrar la variante dejaría esas filas apuntando a un código que no existe —
 * que es exactamente el registro fantasma que no queremos— o, peor, borraría
 * la prueba de lo que alguien compró y pagó.
 *
 * Así que hay dos finales, y el panel tiene que decir cuál antes de que
 * alguien haga clic:
 *
 *   - **se borra**: no hay rastro de nada; la fila desaparece y su foto con
 *     ella.
 *   - **se oculta**: hubo ventas o movimientos; queda `activo = 0`,
 *     `publicado = 0`, fuera del catálogo del bot y de la web, pero la fila
 *     se queda para que el historial siga teniendo sentido.
 *
 * Este es el único sitio del sistema donde el botón no hace literalmente lo
 * que dice, y por eso `comoSeBorra` existe: la pantalla pregunta ANTES y
 * enseña el final de verdad. La misma función decide en los dos sitios, para
 * que la advertencia y lo que pasa no puedan discrepar.
 *
 * ## El detalle que no se ve
 *
 * `movimientos_inventario.codigo` y `conteo_lineas.codigo` NO tienen llave
 * foránea. Es a propósito —son registros históricos y tienen que sobrevivir a
 * que el catálogo cambie— pero significa que **D1 no impide** borrar una
 * variante con movimientos. No salta ningún error: la fila se va y el libro
 * de inventario queda hablando de un código que ya no existe. Por eso aquí se
 * comprueban a mano, y por eso el control del batch los vuelve a mirar.
 */

export interface ContextoCatalogo {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
}

/** Por qué una variante no se puede borrar del todo. */
export type Rastro =
  | { tabla: "movimientos_inventario"; cuantos: number }
  | { tabla: "pedido_lineas"; cuantos: number }
  | { tabla: "conteo_lineas"; cuantos: number }
  | { tabla: "traslado_lineas"; cuantos: number }
  | { tabla: "existencias"; cuantos: number };

export type Veredicto =
  | { modo: "se_borra"; archivos: string[] }
  | { modo: "se_oculta"; rastros: Rastro[]; yaOculta: boolean };

/** En español, para la pantalla. El panel no arma esta frase por su cuenta. */
export function explicar(r: Rastro): string {
  switch (r.tabla) {
    case "pedido_lineas":
      return r.cuantos === 1 ? "está en 1 pedido" : `está en ${r.cuantos} pedidos`;
    case "movimientos_inventario":
      return r.cuantos === 1
        ? "tiene 1 movimiento de inventario"
        : `tiene ${r.cuantos} movimientos de inventario`;
    case "conteo_lineas":
      return "aparece en un conteo de inventario";
    case "traslado_lineas":
      return "aparece en un traslado entre bodegas";
    case "existencias":
      return r.cuantos === 1 ? "tiene 1 unidad en bodega" : `tiene ${r.cuantos} unidades en bodega`;
  }
}

/**
 * Las tablas que guardan que ALGO PASÓ DE VERDAD con esta variante.
 *
 * No están todas las que la referencian. `precios_historial`, `existencias` en
 * cero y `valor_inventario` en cero son contabilidad de una variante que
 * comercialmente no existió: se van con ella y no dejan nada colgando. Lo que
 * no se puede tocar es lo que registra un hecho del mundo — una venta, una
 * caja que se movió, un conteo, un traslado.
 */
async function rastrosDe(db: D1Database, codigo: string): Promise<Rastro[]> {
  const fila = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM movimientos_inventario WHERE codigo = ?1) AS movimientos,
         (SELECT COUNT(*) FROM pedido_lineas          WHERE codigo = ?1) AS pedidos,
         (SELECT COUNT(*) FROM conteo_lineas          WHERE codigo = ?1) AS conteos,
         (SELECT COUNT(*) FROM traslado_lineas        WHERE codigo = ?1) AS traslados,
         -- Solo fisico, NO fisico + reservado: el CHECK de la tabla dice
         -- "reservado <= fisico", o sea que lo reservado es una PARTE de lo
         -- fisico, no algo aparte. Sumarlos contaba dos veces lo apartado y le
         -- habria dicho a Yarielis un numero que no cuadra con lo que ve en el
         -- estante. Y como con fisico = 0 el CHECK obliga a reservado = 0,
         -- mirar solo fisico no deja escapar ninguna caja.
         (SELECT COALESCE(SUM(fisico), 0) FROM existencias WHERE codigo = ?1) AS unidades`,
    )
    .bind(codigo)
    .first<{
      movimientos: number;
      pedidos: number;
      conteos: number;
      traslados: number;
      unidades: number;
    }>();

  if (fila === null) return [];

  const rastros: Rastro[] = [];
  // El orden importa: es el orden en que la pantalla los lee, y la venta es
  // lo primero que una persona necesita saber.
  if (fila.pedidos > 0) rastros.push({ tabla: "pedido_lineas", cuantos: fila.pedidos });
  if (fila.movimientos > 0) {
    rastros.push({ tabla: "movimientos_inventario", cuantos: fila.movimientos });
  }
  if (fila.unidades > 0) rastros.push({ tabla: "existencias", cuantos: fila.unidades });
  if (fila.conteos > 0) rastros.push({ tabla: "conteo_lineas", cuantos: fila.conteos });
  if (fila.traslados > 0) rastros.push({ tabla: "traslado_lineas", cuantos: fila.traslados });
  return rastros;
}

/** Los archivos que se van con la variante (F4.18 los borra de R2 después). */
async function archivosDe(db: D1Database, codigo: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r2_key FROM archivos
        WHERE referencia_tipo = 'variante' AND referencia_id = ?
          AND borrar_despues_de IS NULL`,
    )
    .bind(codigo)
    .all<{ r2_key: string }>();
  return results.map((r) => r.r2_key);
}

/**
 * Qué va a pasar de verdad si se borra esta variante.
 *
 * La pantalla llama a esto ANTES de enseñar el «¿seguro?», para que lo que
 * diga la advertencia sea lo que va a ocurrir. `borrarVariante` llama a lo
 * mismo: una sola función decide, y así no pueden discrepar.
 */
export async function comoSeBorra(
  ctx: ContextoCatalogo,
  codigo: string,
): Promise<Resultado<Veredicto>> {
  const v = await ctx.db
    .prepare("SELECT codigo, activo FROM variantes WHERE codigo = ?")
    .bind(codigo)
    .first<{ codigo: string; activo: number }>();
  if (v === null) return fallo("no_encontrado", "no existe esa variante");

  const rastros = await rastrosDe(ctx.db, codigo);
  if (rastros.length > 0) {
    return ok({ modo: "se_oculta", rastros, yaOculta: v.activo === 0 });
  }
  return ok({ modo: "se_borra", archivos: await archivosDe(ctx.db, codigo) });
}
