import { fallo, ok, type Resultado } from "../contrato/resultado";
import { ulid } from "../ids";

/**
 * Las bodegas: crearlas, renombrarlas y dejar de usarlas.
 *
 * ## Una bodega no se borra
 *
 * No hay aquí ningún `DELETE`, y no es un olvido. Una bodega aparece en cada
 * `movimientos_inventario` que pasó por ella, y esos no se editan ni se borran
 * —hay triggers que lo impiden (02-datos §1)—. Borrar la bodega dejaría cada
 * movimiento apuntando a un sitio que no existe, o sea: el libro que explica
 * de dónde salió cada caja dejaría de explicarlo.
 *
 * Lo que sí se puede es DEJAR DE USARLA (`activa = 0`). Con eso:
 *
 *   - `bodegaConExistencia` ya no la elige para surtir un pedido, así que
 *     nada nuevo sale de ahí;
 *   - `trasladar` no deja meterle más mercancía;
 *   - pero lo que ya está adentro SIGUE CONTANDO como disponible para la web
 *     y el bot, porque `libresSQL` suma `existencias` sin mirar si la bodega
 *     está en uso.
 *
 * Esa última es la que sorprende, y por eso la pantalla la dice con todas las
 * letras antes de que alguien toque el botón: dejar de usar una bodega llena
 * no esconde su mercancía, solo deja de surtir desde ahí. Para vaciarla está
 * el traslado.
 *
 * ## Por qué aquí casi no hay filas de control
 *
 * Las hay en lo que ACTUALIZA, porque un `UPDATE` que no casa con ninguna fila
 * no falla en D1: afecta cero filas y el batch sigue tan contento (trampa nº 1
 * de docs/TRAMPAS.md). En lo que solo INSERTA no las hay: un `INSERT` o entra
 * o revienta el batch, así que un control detrás comprobaría algo que no puede
 * ser falso — y un control que siempre pasa hace creer que algo está vigilado
 * cuando no lo está. Lo mismo que ya está escrito en `src/db/entregas.ts`.
 */

export interface ContextoBodega {
  readonly db: D1Database;
  readonly ahora: number;
}

/** El mismo tope que acepta `bodegaPorNombre` en las herramientas. */
const LARGO_NOMBRE = 60;

function revisarNombre(crudo: unknown): Resultado<string> {
  if (typeof crudo !== "string") return fallo("entrada_invalida", "la bodega necesita un nombre");
  const nombre = crudo.trim().replace(/\s+/g, " ");
  if (nombre === "") return fallo("entrada_invalida", "la bodega necesita un nombre");
  if (nombre.length > LARGO_NOMBRE) {
    return fallo("entrada_invalida", `el nombre no puede pasar de ${LARGO_NOMBRE} letras`);
  }
  return ok(nombre);
}

/** ¿Hay OTRA bodega con ese nombre? Se pregunta, no se lee el mensaje de error. */
async function otraSeLlamaIgual(
  db: D1Database,
  nombre: string,
  exceptoId: string,
): Promise<boolean> {
  const fila = await db
    .prepare("SELECT id FROM bodegas WHERE nombre = ? AND id <> ?")
    .bind(nombre, exceptoId)
    .first<{ id: string }>();
  return fila !== null;
}

const existe = async (db: D1Database, id: string): Promise<boolean> =>
  (await db.prepare("SELECT id FROM bodegas WHERE id = ?").bind(id).first()) !== null;

/**
 * Una bodega nueva, con su casillero para cada artículo.
 *
 * Las dos cosas van en el MISMO batch y eso es lo que la hace usable. Una
 * bodega sin filas en `existencias` existe en la lista y no sirve para nada:
 * `aplicar()` mueve el físico con un `UPDATE ... WHERE codigo = ? AND
 * bodega_id = ?`, así que sin esa fila el movimiento no casa con nada, el
 * control lo tumba y la dueña lee «esa bodega no tiene ese artículo» sobre una
 * bodega que acaba de crear. Es exactamente lo que hace la migración 0003 al
 * sembrar las tres bodegas de verdad; esto la repite para las que vengan
 * después.
 *
 * Los combos quedan fuera a propósito: un combo no se guarda, se arma, y sus
 * unidades libres salen de sus componentes (`libresSQL`). Darle casillero
 * invitaría a contar combos como si fueran cajas en un estante.
 */
export async function crear(
  ctx: ContextoBodega,
  nombreCrudo: unknown,
): Promise<Resultado<{ id: string; nombre: string }>> {
  const revisado = revisarNombre(nombreCrudo);
  if (!revisado.ok) return revisado;
  const nombre = revisado.datos;

  const id = ulid(ctx.ahora);

  try {
    await ctx.db.batch([
      ctx.db.prepare("INSERT INTO bodegas (id, nombre, activa) VALUES (?,?,1)").bind(id, nombre),
      ctx.db
        .prepare(
          `INSERT INTO existencias (codigo, bodega_id, fisico, reservado, minimo)
           SELECT v.codigo, ?, 0, 0, NULL FROM variantes v WHERE v.es_combo = 0`,
        )
        .bind(id),
    ]);
  } catch {
    // El nombre es UNIQUE en el esquema. Se comprueba preguntando por el
    // nombre y no leyendo el texto del error: «UNIQUE constraint» y «CHECK
    // constraint» dicen las dos «constraint», y confundirlas manda a quien lo
    // lea a buscar un duplicado que no existe (trampa nº 10).
    if (await otraSeLlamaIgual(ctx.db, nombre, id)) {
      return fallo("repetido", `ya hay una bodega que se llama «${nombre}»`);
    }
    return fallo("interno", "no se pudo crear la bodega");
  }

  return ok({ id, nombre });
}

/**
 * Cambiarle el nombre a una bodega.
 *
 * Sin comprobar antes si existe: eso lo hace la FILA DE CONTROL, que mira el
 * estado YA CAMBIADO. Un `SELECT` previo sería una comprobación de más que
 * además deja una rendija —entre leer y escribir cabe un cambio—, y sobre todo
 * dejaría al control sin nada que detectar: cualquier prueba pasaría por el
 * camino corto y el control sería un adorno que nadie puede ver fallar.
 */
export async function renombrar(
  ctx: ContextoBodega,
  id: string,
  nombreCrudo: unknown,
): Promise<Resultado<{ id: string; nombre: string }>> {
  const revisado = revisarNombre(nombreCrudo);
  if (!revisado.ok) return revisado;
  const nombre = revisado.datos;

  try {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE bodegas SET nombre = ? WHERE id = ?").bind(nombre, id),
      // Mira el nombre que ESTE batch quería dejar escrito. Si el id no existe
      // —o si alguien la quitó en medio— el UPDATE no casa con nada, `ok` sale
      // 0 y el CHECK de `controles` tumba el batch entero.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM bodegas WHERE id = ? AND nombre IS ?), ?)`,
        )
        .bind(ulid(ctx.ahora), `renombrar-bodega:${id}`, id, nombre, ctx.ahora),
    ]);
  } catch {
    return await porQueNoSeGuardo(ctx, id, nombre);
  }

  return ok({ id, nombre });
}

/**
 * Poner una bodega en uso, o dejar de usarla.
 *
 * Es un interruptor y no dos funciones porque son el mismo batch con otro
 * valor, y partirlo en dos invitaba a que una de las dos se quedara sin
 * control.
 */
export async function cambiarUso(
  ctx: ContextoBodega,
  id: string,
  activa: boolean,
): Promise<Resultado<{ id: string; activa: boolean }>> {
  const valor = activa ? 1 : 0;

  try {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE bodegas SET activa = ? WHERE id = ?").bind(valor, id),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM bodegas WHERE id = ? AND activa IS ?), ?)`,
        )
        .bind(ulid(ctx.ahora), `uso-bodega:${id}`, id, valor, ctx.ahora),
    ]);
  } catch {
    // Aquí no hay ningún UNIQUE de por medio: lo único que puede tumbar este
    // batch es el control, y el control solo da 0 cuando el UPDATE no encontró
    // la fila. Por eso el código es directo y no hay que adivinar nada.
    return fallo("no_encontrado", "no existe esa bodega");
  }

  return ok({ id, activa });
}

/**
 * Por qué se cayó el batch de un renombrado, preguntándole a la base.
 *
 * Primero la existencia y después el nombre repetido: si la bodega no está, lo
 * que hay que decir es eso, aunque además haya otra con ese nombre. Un error
 * mal etiquetado manda a buscar al sitio equivocado (trampa nº 10).
 */
async function porQueNoSeGuardo(
  ctx: ContextoBodega,
  id: string,
  nombre: string,
): Promise<Resultado<never>> {
  if (!(await existe(ctx.db, id))) return fallo("no_encontrado", "no existe esa bodega");
  if (await otraSeLlamaIgual(ctx.db, nombre, id)) {
    return fallo("repetido", `ya hay otra bodega que se llama «${nombre}»`);
  }
  return fallo("interno", "no se pudo guardar el nombre de la bodega");
}
