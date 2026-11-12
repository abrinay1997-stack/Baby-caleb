import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { enunciadosParaBorrar } from "./archivos";

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
 * ## Qué protege D1 y qué no (medido, no supuesto)
 *
 * `PRAGMA foreign_key_list` sobre cada tabla que guarda un código:
 *
 *   movimientos_inventario.codigo → existencias   (NO a variantes)
 *   conteo_lineas.codigo          → NINGUNA
 *   traslado_lineas.codigo        → variantes
 *   existencias.codigo            → variantes
 *
 * O sea: un movimiento no apunta a la variante, pero sí a su fila de
 * existencias, y borrar la variante obliga a borrar esa fila. La cadena
 * protege. Lo mismo los traslados, por su llave directa.
 *
 * **`conteo_lineas` es la que no tiene nada.** Ni llave directa ni cadena: D1
 * dejaría borrar una variante contada en un inventario y la línea del conteo
 * quedaría hablando de un código que ya no existe, sin un solo error. Por eso
 * se comprueba a mano arriba, y por eso el control del batch la vuelve a
 * mirar antes de escribir.
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

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

export interface ProductoNuevo {
  readonly familia: string;
  readonly nombre: string;
  readonly slug: string;
  readonly marca?: string;
}

export interface VarianteNueva {
  readonly codigo: string;
  readonly productoId: string;
  readonly nombre: string;
  readonly talla?: string;
  readonly unidadesPorCaja: number;
  readonly precioCents: number;
  /** Puntos básicos (700 = 7 %). Ausente = PENDIENTE, que no es cero. */
  readonly tasaItbmsBp?: number;
}

/** `Pañal Nateen M` → `panal-nateen-m`. El slug es la URL de la ficha. */
export function slugDe(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const CODIGO_VALIDO = /^[A-Z0-9][A-Z0-9-]{1,23}$/;

/**
 * El código es la llave de todo: lo repite el bot, lo lee la web y lo guarda
 * cada pedido. Se valida aquí y no se "arregla" solo — corregirle el código a
 * alguien en silencio es cómo acaba habiendo dos variantes que quien las
 * escribió creía que eran la misma.
 */
export function revisarCodigo(codigo: string): string | null {
  if (!CODIGO_VALIDO.test(codigo)) {
    return "el código va en mayúsculas, de 2 a 24 letras, números o guiones (ej. NAT-M)";
  }
  return null;
}

export async function crearProducto(
  ctx: ContextoCatalogo,
  datos: ProductoNuevo,
): Promise<Resultado<{ id: string }>> {
  const nombre = datos.nombre.trim();
  if (nombre === "") return fallo("entrada_invalida", "el producto necesita un nombre");

  const slug = datos.slug.trim() === "" ? slugDe(nombre) : slugDe(datos.slug);
  if (slug === "") return fallo("entrada_invalida", "ese nombre no da una dirección web usable");

  const id = ulid(ctx.ahora);
  try {
    await ctx.db
      .prepare(
        `INSERT INTO productos (id,familia,nombre,slug,marca,activo,orden,creado_en)
         VALUES (?,?,?,?,?,1,0,?)`,
      )
      .bind(id, datos.familia, nombre, slug, datos.marca ?? null, ctx.ahora)
      .run();
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e);
    return /UNIQUE/i.test(texto)
      ? fallo("repetido", `ya hay un producto con la dirección «${slug}»`)
      : fallo("interno", texto);
  }
  return ok({ id });
}

/**
 * Una variante nueva nace SIN PUBLICAR, siempre.
 *
 * No es prudencia de más: publicada, el precio que se acaba de teclear sale a
 * la web y al bot en el siguiente minuto. Quien la crea la revisa y la publica
 * después, en dos pasos, porque equivocarse de tecla en el precio y que lo vea
 * una clienta es un error que no se puede deshacer con un botón.
 */
export async function crearVariante(
  ctx: ContextoCatalogo,
  datos: VarianteNueva,
): Promise<Resultado<{ codigo: string }>> {
  const malCodigo = revisarCodigo(datos.codigo);
  if (malCodigo !== null) return fallo("entrada_invalida", malCodigo);

  const nombre = datos.nombre.trim();
  if (nombre === "") return fallo("entrada_invalida", "la variante necesita un nombre");
  if (!Number.isSafeInteger(datos.precioCents) || datos.precioCents <= 0) {
    return fallo("entrada_invalida", "el precio tiene que ser mayor que cero");
  }
  if (!Number.isSafeInteger(datos.unidadesPorCaja) || datos.unidadesPorCaja <= 0) {
    return fallo("entrada_invalida", "las unidades por caja tienen que ser mayor que cero");
  }

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,
             precio_cents,tasa_itbms_bp,publicado,activo,version,actualizado_en)
           VALUES (?,?,?,?,?,?,?,0,1,1,?)`,
        )
        .bind(
          datos.codigo,
          datos.productoId,
          nombre,
          datos.talla ?? null,
          datos.unidadesPorCaja,
          datos.precioCents,
          datos.tasaItbmsBp ?? null,
          ctx.ahora,
        ),
      // El precio de partida entra en el historial igual que cualquier otro:
      // si no, la primera cifra —la que más se consulta cuando algo no cuadra—
      // sería la única sin fecha ni autor.
      ctx.db
        .prepare(
          `INSERT INTO precios_historial (id,codigo,precio_cents,vigente_desde,cambiado_por,motivo)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(ulid(ctx.ahora), datos.codigo, datos.precioCents, ctx.ahora, ctx.actor, "alta"),
    ]);
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|PRIMARY/i.test(texto)) {
      return fallo("repetido", `el código «${datos.codigo}» ya existe`);
    }
    if (/FOREIGN KEY/i.test(texto)) {
      return fallo("no_encontrado", "ese producto no existe");
    }
    return fallo("interno", texto);
  }
  return ok({ codigo: datos.codigo });
}

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

export interface CambiosEnVariante {
  readonly nombre?: string;
  readonly talla?: string | null;
  readonly unidadesPorCaja?: number;
  readonly precioCents?: number;
  readonly tasaItbmsBp?: number | null;
  readonly publicado?: boolean;
  /**
   * El botón de «Pedir por WhatsApp» en ESTE artículo.
   *
   * Tres estados y los tres significan algo distinto:
   *   `undefined` → no se toca (es como se dice «no cambies este campo»).
   *   `null`      → vuelve a «lo que diga Ajustes».
   *   `true/false`→ encendido o apagado en este artículo.
   *
   * Un `true` NO se salta el ajuste global: la regla de combinarlos vive en
   * `seEnseniaElBoton` (src/rpc/catalogo.ts) y el porqué en
   * `migrations/0013_whatsapp_por_variante.sql`.
   */
  readonly pedirPorWhatsapp?: boolean | null;
  readonly motivo?: string;
}

/**
 * Editar una variante, con la versión que se leyó.
 *
 * `versionLeida` cierra la ACTUALIZACIÓN PERDIDA, y aquí el caso es concreto:
 * Yarielis abre el catálogo en el teléfono, se distrae, y mientras tanto el
 * precio cambia desde la computadora. Si al volver guardara, escribiría encima
 * del precio nuevo el viejo que tenía en pantalla, sin que nada fallara.
 *
 * Con la versión, el UPDATE no casa con nada y el control de detrás tumba el
 * batch: la pantalla recarga y le enseña lo que hay ahora.
 *
 * Un cambio de precio escribe SIEMPRE en `precios_historial`, en el mismo
 * batch. Si fueran dos escrituras, un fallo entre una y otra dejaría el precio
 * cambiado sin rastro de quién ni cuándo — que es justo lo que se consulta
 * cuando una clienta reclama lo que le cotizaron ayer.
 */
export async function editarVariante(
  ctx: ContextoCatalogo,
  codigo: string,
  cambios: CambiosEnVariante,
  versionLeida: number,
): Promise<Resultado<{ version: number }>> {
  const actual = await ctx.db
    .prepare("SELECT codigo, precio_cents, version FROM variantes WHERE codigo = ?")
    .bind(codigo)
    .first<{ codigo: string; precio_cents: number; version: number }>();
  if (actual === null) return fallo("no_encontrado", "no existe esa variante");

  if (cambios.precioCents !== undefined) {
    if (!Number.isSafeInteger(cambios.precioCents) || cambios.precioCents <= 0) {
      return fallo("entrada_invalida", "el precio tiene que ser mayor que cero");
    }
  }
  if (cambios.nombre !== undefined && cambios.nombre.trim() === "") {
    return fallo("entrada_invalida", "el nombre no puede quedar vacío");
  }
  if (
    cambios.unidadesPorCaja !== undefined &&
    (!Number.isSafeInteger(cambios.unidadesPorCaja) || cambios.unidadesPorCaja <= 0)
  ) {
    return fallo("entrada_invalida", "las unidades por caja tienen que ser mayor que cero");
  }

  const campos: string[] = [];
  /**
   * Las mismas columnas, para COMPROBAR en vez de para asignar.
   *
   * `IS` y no `=`, y no es cosmético: en SQL `tasa_itbms_bp = NULL` no es
   * falso, es DESCONOCIDO, así que un control que compare con `=` da cero en
   * cuanto una de las columnas se deja vacía. En SQLite `x IS y` sí compara
   * nulos, y es el único operador que vale aquí.
   *
   * El `=` del SET está bien: ahí es una asignación, no una comparación. Son
   * dos listas porque son dos cosas distintas que se escribían igual.
   */
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const poner = (columna: string, valor: unknown) => {
    campos.push(`${columna} = ?`);
    condiciones.push(`${columna} IS ?`);
    valores.push(valor);
  };

  if (cambios.nombre !== undefined) poner("nombre", cambios.nombre.trim());
  if (cambios.talla !== undefined) poner("talla", cambios.talla);
  if (cambios.unidadesPorCaja !== undefined) poner("unidades_por_caja", cambios.unidadesPorCaja);
  if (cambios.precioCents !== undefined) poner("precio_cents", cambios.precioCents);
  if (cambios.tasaItbmsBp !== undefined) poner("tasa_itbms_bp", cambios.tasaItbmsBp);
  if (cambios.publicado !== undefined) poner("publicado", cambios.publicado ? 1 : 0);
  if (cambios.pedirPorWhatsapp !== undefined) {
    // `null` se escribe como NULL y no como 0: son dos cosas distintas en esa
    // columna —«lo que diga Ajustes» y «no, en este no»— y por eso el control
    // de abajo compara con `IS` y no con `=`.
    poner(
      "pedir_por_whatsapp",
      cambios.pedirPorWhatsapp === null ? null : cambios.pedirPorWhatsapp ? 1 : 0,
    );
  }

  if (campos.length === 0) return ok({ version: actual.version });

  const versionNueva = versionLeida + 1;
  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `UPDATE variantes SET ${campos.join(", ")}, version = version + 1, actualizado_en = ?
          WHERE codigo = ? AND version = ?`,
      )
      // El `WHERE version` no es lo que cierra la actualización perdida: eso lo
      // hace el control de abajo. Probado quitándolo, el batch se sigue cayendo.
      // Vale la pena igual —evita escribir un valor que luego hay que revertir,
      // y deja dicha la intención donde se lee el UPDATE— pero quien lo lea no
      // debe creer que es la defensa.
      .bind(...valores, ctx.ahora, codigo, versionLeida),
    // El control mira el estado YA CAMBIADO. Un UPDATE que no casa con nada NO
    // falla en D1 —afecta cero filas y sigue—, así que sin esto el guardado
    // diría que todo fue bien sin haber escrito nada.
    //
    // Y mira LOS VALORES, no solo la versión. Comprobar `version = leída + 1`
    // a secas no detecta nada: si otro guardó en medio, la versión YA es esa, y
    // el control la encuentra y da por bueno un guardado que no escribió una
    // sola columna. Lo destapó la prueba de la versión vieja. Mirando también
    // lo que este batch quería dejar escrito, un guardado que no llegó a
    // escribir no puede hacerse pasar por uno que sí.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM variantes
                        WHERE codigo = ? AND version = ? AND ${condiciones.join(" AND ")}), ?)`,
      )
      .bind(ulid(ctx.ahora), `editar:${codigo}`, codigo, versionNueva, ...valores, ctx.ahora),
  ];

  // Un precio que no cambia no ensucia el historial: si cada guardado dejara
  // una fila, el historial de precios se volvería un registro de guardados y
  // dejaría de servir para ver cuándo cambió el precio de verdad.
  if (cambios.precioCents !== undefined && cambios.precioCents !== actual.precio_cents) {
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO precios_historial (id,codigo,precio_cents,vigente_desde,cambiado_por,motivo)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(
          ulid(ctx.ahora),
          codigo,
          cambios.precioCents,
          ctx.ahora,
          ctx.actor,
          cambios.motivo ?? null,
        ),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch {
    return fallo(
      "conflicto_version",
      "alguien cambió esta variante mientras la editaba. Vuelva a abrirla para ver lo que hay ahora",
    );
  }
  return ok({ version: versionNueva });
}

// ---------------------------------------------------------------------------
// Borrar
// ---------------------------------------------------------------------------

export interface Borrada {
  readonly modo: "se_borra" | "se_oculta";
  readonly rastros: Rastro[];
  /** Claves marcadas para que el barrido las quite de R2 (F4.18). */
  readonly archivos: string[];
}

/**
 * Borrar una variante: de verdad si no pasó nada con ella, oculta si sí.
 *
 * Decide con `comoSeBorra`, la MISMA función que usa la pantalla para avisar
 * antes del clic. Dos funciones acabarían discrepando y la advertencia diría
 * una cosa mientras ocurre otra.
 *
 * Entre que la pantalla avisa y alguien confirma puede pasar un rato — y en
 * ese rato una clienta puede comprar. Por eso el veredicto se vuelve a
 * calcular aquí, y por eso el batch lleva detrás un control que mira otra vez:
 * si entre el cálculo y la escritura apareció una venta, el batch se cae
 * entero en vez de borrar la prueba de esa venta.
 */
export async function borrarVariante(
  ctx: ContextoCatalogo,
  codigo: string,
): Promise<Resultado<Borrada>> {
  const v = await comoSeBorra(ctx, codigo);
  if (!v.ok) return v;

  if (v.datos.modo === "se_oculta") {
    const enunciados: D1PreparedStatement[] = [
      ctx.db
        .prepare(
          "UPDATE variantes SET activo = 0, publicado = 0, version = version + 1, actualizado_en = ? WHERE codigo = ?",
        )
        .bind(ctx.ahora, codigo),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM variantes
                          WHERE codigo = ? AND activo = 0 AND publicado = 0), ?)`,
        )
        .bind(ulid(ctx.ahora), `ocultar:${codigo}`, codigo, ctx.ahora),
    ];
    try {
      await ctx.db.batch(enunciados);
    } catch {
      return fallo("interno", "no se pudo ocultar la variante");
    }
    // Las fotos NO se tocan: la variante sigue existiendo y su ficha puede
    // hacer falta para explicar un pedido viejo.
    return ok({ modo: "se_oculta", rastros: v.datos.rastros, archivos: [] });
  }

  const archivos = v.datos.archivos;

  try {
    await ctx.db.batch(enunciadosDeBorradoReal(ctx, codigo, archivos));
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e);
    if (/FOREIGN KEY/i.test(texto)) {
      return fallo(
        "transicion_invalida",
        "esta variante ya tiene historia y no se puede borrar. Vuelva a abrirla: lo que corresponde es ocultarla",
      );
    }
    return fallo(
      "conflicto_version",
      "algo cambió con esta variante mientras se borraba. Vuelva a abrirla",
    );
  }

  return ok({ modo: "se_borra", rastros: [], archivos });
}

/**
 * Los enunciados del borrado de verdad.
 *
 * Se devuelven en vez de ejecutarse para que el CONTROL se pueda probar. Es el
 * último filo contra el registro fantasma —una fila de inventario apuntando a
 * un código que ya no existe— y un guardia que nadie prueba es un guardia del
 * que no se sabe nada.
 */
export function enunciadosDeBorradoReal(
  ctx: ContextoCatalogo,
  codigo: string,
  archivos: readonly string[],
): D1PreparedStatement[] {
  const enunciados: D1PreparedStatement[] = [
    // Otra variante puede apuntar a esta como «la talla siguiente». Ese puntero
    // no puede sobrevivir, y si no se limpia la llave foránea tumba el borrado
    // con un error que no le dice nada a nadie.
    ctx.db
      .prepare("UPDATE variantes SET siguiente_codigo = NULL WHERE siguiente_codigo = ?")
      .bind(codigo),
    // Contabilidad de algo que comercialmente no existió. Se va con ella y no
    // deja nada colgando; si quedara, la llave foránea impediría el borrado.
    ctx.db.prepare("DELETE FROM precios_historial WHERE codigo = ?").bind(codigo),
    ctx.db.prepare("DELETE FROM existencias WHERE codigo = ?").bind(codigo),
    ctx.db.prepare("DELETE FROM valor_inventario WHERE codigo = ?").bind(codigo),
    ctx.db.prepare("DELETE FROM variantes WHERE codigo = ?").bind(codigo),
    // El control mira el estado YA CAMBIADO. Lo que de verdad cubre es
    // `conteo_lineas`: es la única sin llave foránea ni cadena hasta
    // `variantes`, así que D1 habría dejado borrar una variante contada en un
    // inventario y la línea del conteo quedaría apuntando a la nada, sin un
    // solo error. Las demás se defienden solas —los movimientos por su llave a
    // `existencias`, los traslados por la suya a `variantes`—, y se comprueban
    // aquí igual: cuestan nada y así el control no depende de que esas llaves
    // sigan existiendo mañana.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT CASE WHEN
             (SELECT COUNT(*) FROM movimientos_inventario WHERE codigo = ?) = 0
         AND (SELECT COUNT(*) FROM conteo_lineas          WHERE codigo = ?) = 0
         AND (SELECT COUNT(*) FROM variantes              WHERE codigo = ?) = 0
           THEN 1 ELSE 0 END), ?)`,
      )
      .bind(ulid(ctx.ahora), `borrar:${codigo}`, codigo, codigo, codigo, ctx.ahora),
  ];

  // Las fotos se MARCAN, no se borran, y se marcan en ESTE batch: si el
  // borrado se cae, la foto no queda condenada a morir en 24 horas con su
  // producto todavía vivo. Quitarlas de R2 es cosa del barrido (F4.18).
  if (archivos.length > 0) {
    enunciados.push(
      ...enunciadosParaBorrar({ db: ctx.db, ahora: ctx.ahora }, archivos),
    );
  }

  return enunciados;
}

/**
 * Dar de alta un producto con su primera presentación, de una sola vez.
 *
 * Son dos tablas, y hacerlo en dos llamadas deja un hueco: si la segunda falla
 * —un código repetido, por ejemplo— queda un producto SIN NINGUNA VARIANTE. Y
 * ese producto no se puede ver ni arreglar desde el panel, porque la lista del
 * catálogo sale de `variantes JOIN productos`: lo que no tiene variantes no
 * aparece en ninguna parte. Es un registro fantasma con otro nombre, y en una
 * base que nadie mira crece sin que nada falle.
 *
 * Un batch de D1 es una transacción: entran los dos o no entra ninguno.
 */
export async function crearProductoConVariante(
  ctx: ContextoCatalogo,
  producto: ProductoNuevo,
  variante: Omit<VarianteNueva, "productoId">,
): Promise<Resultado<{ id: string; codigo: string }>> {
  const nombre = producto.nombre.trim();
  if (nombre === "") return fallo("entrada_invalida", "el producto necesita un nombre");

  const slug = producto.slug.trim() === "" ? slugDe(nombre) : slugDe(producto.slug);
  if (slug === "") return fallo("entrada_invalida", "ese nombre no da una dirección web usable");

  const malCodigo = revisarCodigo(variante.codigo);
  if (malCodigo !== null) return fallo("entrada_invalida", malCodigo);

  const nombreVariante = variante.nombre.trim();
  if (nombreVariante === "") return fallo("entrada_invalida", "la variante necesita un nombre");
  if (!Number.isSafeInteger(variante.precioCents) || variante.precioCents <= 0) {
    return fallo("entrada_invalida", "el precio tiene que ser mayor que cero");
  }
  if (!Number.isSafeInteger(variante.unidadesPorCaja) || variante.unidadesPorCaja <= 0) {
    return fallo("entrada_invalida", "las unidades por caja tienen que ser mayor que cero");
  }

  const id = ulid(ctx.ahora);
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO productos (id,familia,nombre,slug,marca,activo,orden,creado_en)
           VALUES (?,?,?,?,?,1,0,?)`,
        )
        .bind(id, producto.familia, nombre, slug, producto.marca ?? null, ctx.ahora),
      ctx.db
        .prepare(
          `INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,
             precio_cents,tasa_itbms_bp,publicado,activo,version,actualizado_en)
           VALUES (?,?,?,?,?,?,?,0,1,1,?)`,
        )
        .bind(
          variante.codigo,
          id,
          nombreVariante,
          variante.talla ?? null,
          variante.unidadesPorCaja,
          variante.precioCents,
          variante.tasaItbmsBp ?? null,
          ctx.ahora,
        ),
      ctx.db
        .prepare(
          `INSERT INTO precios_historial (id,codigo,precio_cents,vigente_desde,cambiado_por,motivo)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(ulid(ctx.ahora), variante.codigo, variante.precioCents, ctx.ahora, ctx.actor, "alta"),
    ]);
  } catch (e) {
    const t = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|PRIMARY/i.test(t)) {
      // Puede ser el slug del producto o el código de la variante. Se dicen
      // los dos: decir «ya existe» sin decir qué manda a mirar al sitio
      // equivocado.
      return fallo(
        "repetido",
        `Ya existe un producto con ese nombre, o una presentación con el código «${variante.codigo}».`,
      );
    }
    return fallo("interno", t);
  }

  return ok({ id, codigo: variante.codigo });
}

// ---------------------------------------------------------------------------
// La receta de un combo
// ---------------------------------------------------------------------------

export interface Ingrediente {
  readonly codigo: string;
  readonly cantidad: number;
}

/**
 * Reemplaza la receta ENTERA de un combo.
 *
 * Entera y no por partes: editar ingrediente a ingrediente deja estados
 * intermedios —una receta sin uno de sus componentes— que, si alguien vende
 * justo ahí, apartan de menos. Un batch borra lo que había y pone lo nuevo, o
 * no hace nada.
 *
 * Cambiar la receta NO toca los pedidos que ya existen: lo que se apartó al
 * vender quedó escrito en `pedido_linea_componentes` y es de ahí de donde se
 * devuelve al cancelar.
 */
export async function ponerReceta(
  ctx: ContextoCatalogo,
  comboCodigo: string,
  receta: readonly Ingrediente[],
): Promise<Resultado<{ ingredientes: number }>> {
  const v = await ctx.db
    .prepare("SELECT codigo, es_combo FROM variantes WHERE codigo = ?")
    .bind(comboCodigo)
    .first<{ codigo: string; es_combo: number }>();
  if (v === null) return fallo("no_encontrado", "no existe esa variante");
  // Lo que de verdad lo impide es el trigger `combo_duenno_es_combo` del
  // esquema: quitando esta línea, la base lo rechaza igual. Se queda porque
  // evita un viaje a la base para algo que ya se sabe, y porque el mensaje sale
  // sin la coletilla del trigger. Quien lo lea no debe creer que es la defensa.
  if (v.es_combo !== 1) return fallo("entrada_invalida", "esta variante no es un combo");

  for (const i of receta) {
    if (!Number.isSafeInteger(i.cantidad) || i.cantidad <= 0) {
      return fallo("entrada_invalida", `la cantidad de ${i.codigo} tiene que ser mayor que cero`);
    }
    if (i.codigo === comboCodigo) {
      return fallo("entrada_invalida", "un combo no puede llevarse a sí mismo");
    }
  }

  // Repetir un ingrediente serían dos cantidades para lo mismo, y cuál manda
  // dependería de cuál se lea primero. Se avisa en vez de quedarse con una.
  const vistos = new Set<string>();
  for (const i of receta) {
    if (vistos.has(i.codigo)) {
      return fallo("entrada_invalida", `${i.codigo} está dos veces en la receta`);
    }
    vistos.add(i.codigo);
  }

  const enunciados: D1PreparedStatement[] = [
    ctx.db.prepare("DELETE FROM combo_componentes WHERE combo_codigo = ?").bind(comboCodigo),
    ...receta.map((i) =>
      ctx.db
        .prepare(
          "INSERT INTO combo_componentes (combo_codigo,codigo,cantidad) VALUES (?,?,?)",
        )
        .bind(comboCodigo, i.codigo, i.cantidad),
    ),
    // La versión sube para que quien tuviera el combo abierto se entere.
    ctx.db
      .prepare("UPDATE variantes SET version = version + 1, actualizado_en = ? WHERE codigo = ?")
      .bind(ctx.ahora, comboCodigo),
  ];

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    const t = e instanceof Error ? e.message : String(e);
    // Los triggers del esquema hablan en español y dicen exactamente qué pasó:
    // se pasa su mensaje en vez de uno genérico, que mandaría a adivinar.
    if (/combo/i.test(t)) return fallo("entrada_invalida", t.replace(/^.*?: /, ""));
    if (/FOREIGN KEY/i.test(t)) return fallo("no_encontrado", "algún componente no existe");
    return fallo("interno", t);
  }

  return ok({ ingredientes: receta.length });
}

/** La receta de un combo, con lo que hay de cada pieza. */
export async function leerReceta(
  ctx: ContextoCatalogo,
  comboCodigo: string,
): Promise<Resultado<{ codigo: string; nombre: string; cantidad: number; libres: number }[]>> {
  const { results } = await ctx.db
    .prepare(
      `SELECT cc.codigo, v.nombre, cc.cantidad,
              COALESCE((SELECT SUM(e.fisico - e.reservado) FROM existencias e
                         WHERE e.codigo = cc.codigo), 0) AS libres
         FROM combo_componentes cc
         JOIN variantes v ON v.codigo = cc.codigo
        WHERE cc.combo_codigo = ?
        ORDER BY v.nombre`,
    )
    .bind(comboCodigo)
    .all<{ codigo: string; nombre: string; cantidad: number; libres: number }>();
  return ok(results);
}
