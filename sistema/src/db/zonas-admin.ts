import { fallo, ok, type Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import { esMetodo, esRegion, type Metodo, type Region } from "../dominio/zonas";

/**
 * Las zonas de envío desde el panel: crearlas, editarlas y pausarlas.
 *
 * ## La tarifa vacía NO es cero
 *
 * `zonas_envio.tarifa_cents` admite nulo y significa **se cotiza a mano**: son
 * las del interior, donde el costo depende de la encomienda y nadie lo sabe
 * hasta preguntarlo. Cero significa otra cosa muy distinta: que el envío no se
 * cobra.
 *
 * Confundirlas sale caro en los dos sentidos. Un nulo tratado como cero regala
 * el envío en cada pedido del interior; un cero tratado como nulo le dice a la
 * clienta «le cotizamos» cuando lo que había que decirle era «es gratis». Por
 * eso aquí son dos valores distintos y nunca se traduce uno al otro, y por eso
 * `cotizarEnvio` (src/dominio/zonas.ts) devuelve un fallo con el nulo en vez
 * de un número. La pantalla lo pregunta con palabras, no con un campo que se
 * deja vacío: un campo vacío no distingue «cero» de «no sé» (trampa nº 7).
 *
 * ## Las filas de control
 *
 * Están en lo que ACTUALIZA, que es donde hacen falta: un `UPDATE` que no casa
 * con ninguna fila no falla en D1, afecta cero filas y el batch sigue. El
 * control mira el estado YA CAMBIADO, incluido `actualizado_en`, que cambia en
 * cada guardado — así no puede dar por bueno un guardado que no escribió nada.
 *
 * Y compara con `IS` y no con `=`. En SQL `tarifa_cents = NULL` no es falso:
 * es DESCONOCIDO, así que el control daría cero en cuanto una zona se quedara
 * sin tarifa o sin bodega preferida, y tumbaría un guardado perfectamente
 * bueno. `IS` sí compara nulos. Esta es la que rompió el catálogo entero.
 */

export interface ContextoZona {
  readonly db: D1Database;
  readonly ahora: number;
}

const LARGO_NOMBRE = 80;
const LARGO_ALIAS = 60;
/** Suficiente para las formas de escribir un barrio; un tope evita el pegote. */
const MAXIMO_ALIAS = 24;

export interface ZonaNueva {
  readonly nombre: string;
  readonly alias: readonly string[];
  readonly region: Region;
  readonly metodo: Metodo;
  /** null = se cotiza a mano. 0 = el envío no se cobra. No son lo mismo. */
  readonly tarifaCents: number | null;
  readonly requierePagoTotal: boolean;
  readonly bodegaPreferidaId: string | null;
}

export type CambiosEnZona = Partial<ZonaNueva> & { readonly activa?: boolean };

function revisarNombre(crudo: unknown): Resultado<string> {
  if (typeof crudo !== "string") return fallo("entrada_invalida", "la zona necesita un nombre");
  const nombre = crudo.trim().replace(/\s+/g, " ");
  if (nombre === "") return fallo("entrada_invalida", "la zona necesita un nombre");
  if (nombre.length > LARGO_NOMBRE) {
    return fallo("entrada_invalida", `el nombre no puede pasar de ${LARGO_NOMBRE} letras`);
  }
  return ok(nombre);
}

/**
 * Los alias, limpios y sin repetidos.
 *
 * Se normaliza el espacio pero NO las tildes ni las mayúsculas: lo que se
 * guarda es como la clienta lo escribe, y quien compara es `normalizar()` de
 * src/dominio/zonas.ts, que ya quita tildes al buscar. Guardar aquí la versión
 * aplastada haría que la pantalla le enseñara a la dueña un alias que ella no
 * escribió.
 */
function revisarAlias(crudo: unknown): Resultado<string[]> {
  if (crudo === undefined || crudo === null) return ok([]);
  if (!Array.isArray(crudo)) {
    return fallo("entrada_invalida", "los alias tienen que venir como una lista");
  }
  if (crudo.length > MAXIMO_ALIAS) {
    return fallo("entrada_invalida", `son demasiados alias: el tope es ${MAXIMO_ALIAS}`);
  }

  const vistos = new Set<string>();
  const limpios: string[] = [];
  for (const bruto of crudo) {
    if (typeof bruto !== "string") {
      return fallo("entrada_invalida", "cada alias tiene que ser un texto");
    }
    const alias = bruto.trim().replace(/\s+/g, " ");
    if (alias === "") continue;
    if (alias.length > LARGO_ALIAS) {
      return fallo("entrada_invalida", `«${alias.slice(0, 20)}…» pasa de ${LARGO_ALIAS} letras`);
    }
    const llave = alias.toLowerCase();
    if (vistos.has(llave)) continue;
    vistos.add(llave);
    limpios.push(alias);
  }
  return ok(limpios);
}

function revisarTarifa(crudo: unknown): Resultado<number | null> {
  if (crudo === null) return ok(null);
  if (!Number.isSafeInteger(crudo)) {
    return fallo(
      "entrada_invalida",
      "la tarifa va en centavos enteros, o se deja en «se cotiza a mano»",
    );
  }
  const centavos = crudo as number;
  if (centavos < 0) return fallo("entrada_invalida", "la tarifa no puede ser negativa");
  return ok(centavos);
}

/** La bodega preferida existe, o se dice cuál no. La llave foránea es la red. */
async function revisarBodega(db: D1Database, id: unknown): Promise<Resultado<string | null>> {
  if (id === null || id === undefined) return ok(null);
  if (typeof id !== "string" || id.trim() === "") {
    return fallo("entrada_invalida", "esa no es una bodega");
  }
  const fila = await db.prepare("SELECT id FROM bodegas WHERE id = ?").bind(id).first();
  return fila === null ? fallo("no_encontrado", "esa bodega no existe") : ok(id);
}

const existe = async (db: D1Database, id: string): Promise<boolean> =>
  (await db.prepare("SELECT id FROM zonas_envio WHERE id = ?").bind(id).first()) !== null;

async function otraSeLlamaIgual(
  db: D1Database,
  nombre: string,
  exceptoId: string,
): Promise<boolean> {
  const fila = await db
    .prepare("SELECT id FROM zonas_envio WHERE nombre = ? AND id <> ?")
    .bind(nombre, exceptoId)
    .first();
  return fila !== null;
}

/**
 * Una zona nueva.
 *
 * Nace activa: una zona que se crea es una zona a la que se empieza a
 * entregar, y dejarla apagada obligaría a dos pasos para la operación normal.
 * Pausarla es un acto aparte y explícito.
 *
 * Sin fila de control detrás: es un solo `INSERT`, que o entra o revienta el
 * batch. Un control ahí comprobaría algo que no puede ser falso y haría creer
 * que hay una defensa donde no hace falta ninguna.
 */
export async function crear(
  ctx: ContextoZona,
  datos: Partial<ZonaNueva>,
): Promise<Resultado<{ id: string; nombre: string }>> {
  const nombre = revisarNombre(datos.nombre);
  if (!nombre.ok) return nombre;

  const alias = revisarAlias(datos.alias);
  if (!alias.ok) return alias;

  if (!esRegion(datos.region)) {
    return fallo("entrada_invalida", "diga si la zona es de la ciudad o del interior");
  }
  if (!esMetodo(datos.metodo)) {
    return fallo("entrada_invalida", "diga cómo llega el pedido: motorizado, Ferguson u otro");
  }

  const tarifa = revisarTarifa(datos.tarifaCents === undefined ? null : datos.tarifaCents);
  if (!tarifa.ok) return tarifa;

  const bodega = await revisarBodega(ctx.db, datos.bodegaPreferidaId ?? null);
  if (!bodega.ok) return bodega;

  const id = ulid(ctx.ahora);

  try {
    await ctx.db
      .prepare(
        `INSERT INTO zonas_envio
           (id, nombre, alias_json, region, metodo, tarifa_cents,
            requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
         VALUES (?,?,?,?,?,?,?,?,1,?)`,
      )
      .bind(
        id,
        nombre.datos,
        JSON.stringify(alias.datos),
        datos.region,
        datos.metodo,
        tarifa.datos,
        datos.requierePagoTotal === true ? 1 : 0,
        bodega.datos,
        ctx.ahora,
      )
      .run();
  } catch {
    // Se pregunta por el nombre en vez de leer el texto del error: «UNIQUE
    // constraint» y «CHECK constraint» dicen las dos «constraint» (trampa
    // nº 10).
    if (await otraSeLlamaIgual(ctx.db, nombre.datos, id)) {
      return fallo("repetido", `ya hay una zona que se llama «${nombre.datos}»`);
    }
    return fallo("interno", "no se pudo crear la zona");
  }

  return ok({ id, nombre: nombre.datos });
}

/**
 * Cambiar una zona. Lo que no venga en `cambios` se queda como estaba.
 *
 * `tarifaCents: null` SÍ es un cambio —pasa la zona a «se cotiza a mano»—, así
 * que el campo ausente y el campo en nulo no pueden tratarse igual. Por eso se
 * mira con `in` y no con `?? valorDeAntes`: `?? ` convertiría «ponla en se
 * cotiza» en «déjala como está», y la dueña vería que su cambio no pasó sin
 * que nada fallara.
 *
 * No se comprueba antes si la zona existe: eso lo hace la fila de control, que
 * mira el estado ya cambiado. Un `SELECT` previo dejaría al control sin nada
 * que detectar y lo convertiría en un adorno.
 */
export async function editar(
  ctx: ContextoZona,
  id: string,
  cambios: CambiosEnZona,
): Promise<Resultado<{ id: string }>> {
  const campos: string[] = [];
  /** Las mismas columnas para COMPROBAR. `IS` y no `=`: aquí hay nulos. */
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const poner = (columna: string, valor: unknown): void => {
    campos.push(`${columna} = ?`);
    condiciones.push(`${columna} IS ?`);
    valores.push(valor);
  };

  if ("nombre" in cambios) {
    const nombre = revisarNombre(cambios.nombre);
    if (!nombre.ok) return nombre;
    poner("nombre", nombre.datos);
  }

  if ("alias" in cambios) {
    const alias = revisarAlias(cambios.alias);
    if (!alias.ok) return alias;
    poner("alias_json", JSON.stringify(alias.datos));
  }

  if ("region" in cambios) {
    if (!esRegion(cambios.region)) {
      return fallo("entrada_invalida", "diga si la zona es de la ciudad o del interior");
    }
    poner("region", cambios.region);
  }

  if ("metodo" in cambios) {
    if (!esMetodo(cambios.metodo)) {
      return fallo("entrada_invalida", "diga cómo llega el pedido: motorizado, Ferguson u otro");
    }
    poner("metodo", cambios.metodo);
  }

  if ("tarifaCents" in cambios) {
    const tarifa = revisarTarifa(cambios.tarifaCents === undefined ? null : cambios.tarifaCents);
    if (!tarifa.ok) return tarifa;
    poner("tarifa_cents", tarifa.datos);
  }

  if ("requierePagoTotal" in cambios) {
    poner("requiere_pago_total", cambios.requierePagoTotal === true ? 1 : 0);
  }

  if ("bodegaPreferidaId" in cambios) {
    const bodega = await revisarBodega(ctx.db, cambios.bodegaPreferidaId ?? null);
    if (!bodega.ok) return bodega;
    poner("bodega_preferida_id", bodega.datos);
  }

  if ("activa" in cambios) poner("activa", cambios.activa === true ? 1 : 0);

  if (campos.length === 0) return fallo("entrada_invalida", "no hay nada que cambiar");

  // `actualizado_en` entra en el control a propósito. Es lo único que cambia
  // SIEMPRE, así que es lo que impide que un guardado que no escribió nada se
  // haga pasar por uno que sí: las demás columnas podrían venir ya con el
  // valor que se quería poner.
  const nombreDeLaRegla = `editar-zona:${id}`;

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE zonas_envio SET ${campos.join(", ")}, actualizado_en = ? WHERE id = ?`)
        .bind(...valores, ctx.ahora, id),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM zonas_envio
                          WHERE id = ? AND actualizado_en IS ? AND ${condiciones.join(" AND ")}), ?)`,
        )
        .bind(ulid(ctx.ahora), nombreDeLaRegla, id, ctx.ahora, ...valores, ctx.ahora),
    ]);
  } catch {
    if (!(await existe(ctx.db, id))) return fallo("no_encontrado", "no existe esa zona");
    if ("nombre" in cambios && typeof cambios.nombre === "string") {
      const nombre = cambios.nombre.trim().replace(/\s+/g, " ");
      if (await otraSeLlamaIgual(ctx.db, nombre, id)) {
        return fallo("repetido", `ya hay otra zona que se llama «${nombre}»`);
      }
    }
    return fallo("interno", "no se pudo guardar la zona");
  }

  return ok({ id });
}
