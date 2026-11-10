import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";

/**
 * El ciclo de vida de un archivo: subirlo, borrarlo, y que no quede basura.
 *
 * Hay DOS formas de ensuciar esto, y van en direcciones opuestas:
 *
 *  - **Huérfanos**: el archivo se queda en R2 y su fila no. Nadie sabe qué es,
 *    ocupa, y se paga todos los meses. Crece sin que nada falle.
 *  - **Referencias rotas**: la fila se queda y el archivo no. Fotos rotas en la
 *    web, y una pantalla que promete algo que no está.
 *
 * Las dos salen del mismo error: escribir en dos sitios que no comparten
 * transacción. D1 y R2 son dos sistemas distintos; no hay forma de que una
 * escritura en los dos sea atómica. Así que lo que se hace es ORDENAR las
 * operaciones de modo que cualquier interrupción deje un estado que el barrido
 * sepa limpiar.
 *
 * ## Subir
 *
 *   1. Se escribe la fila YA MARCADA para borrar (provisional).
 *   2. Se sube a R2.
 *   3. Se quita la marca (confirmado).
 *
 * Si se cae en el 2 o en el 3, la fila queda marcada y el barrido la limpia
 * —borrando de R2 lo que haya llegado— sin dejar nada. Lo contrario (subir
 * primero y escribir la fila después) deja un huérfano que nada va a limpiar
 * nunca, porque no hay fila que diga que existe.
 *
 * ## Borrar
 *
 * NUNCA se borra de R2 en el momento. Se marca con una fecha y el barrido lo
 * hace después. Eso da tres cosas que el borrado inmediato no da:
 *
 *   - si la operación que lo pidió se cae, no se perdió nada;
 *   - si R2 falla, el barrido lo reintenta solo;
 *   - y hay un MARGEN para recuperar lo que se borró por error.
 *
 * ## Barrer
 *
 * Primero R2, después la fila. Si el borrado de R2 falla, la fila sigue
 * marcada y se reintenta. Si se borrara la fila primero y R2 fallara, el
 * archivo quedaría huérfano sin nada que lo recuerde.
 */

export interface ContextoArchivo {
  readonly db: D1Database;
  readonly r2: R2Bucket;
  readonly ahora: number;
  readonly actor: string;
}

/**
 * Margen por defecto antes de borrar de verdad: 24 horas.
 *
 * No es un número técnico: es cuánto tiempo tiene alguien para decir «me
 * equivoqué» antes de que la foto deje de existir.
 */
export const GRACIA_MS = 24 * 60 * 60 * 1000;

/** Margen de la subida provisional: si en 15 min no se confirmó, no llegó. */
const GRACIA_SUBIDA_MS = 15 * 60 * 1000;

export interface ArchivoNuevo {
  readonly tipo: string;
  readonly mime: string;
  readonly bytes: number;
  /** `true` por defecto: lo que lleva datos de una clienta no se sirve público. */
  readonly sensible?: boolean;
  readonly referenciaTipo?: string;
  readonly referenciaId?: string;
}

/** `catalogo/NAT-M/01HX….webp`: agrupado por lo que describe. */
export function claveDe(tipo: string, referenciaId: string, extension: string, ahora: number): string {
  const limpio = referenciaId.replace(/[^A-Za-z0-9_-]/g, "_");
  const ext = extension.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `${tipo}/${limpio}/${ulid(ahora)}.${ext}`;
}

/**
 * Sube un archivo y lo deja registrado, o no deja nada.
 *
 * El cuerpo llega ya leído: quien llama es el que decide cuánto se acepta y de
 * qué tipo, porque eso depende de para qué sea el archivo.
 */
export async function subir(
  ctx: ContextoArchivo,
  clave: string,
  cuerpo: ArrayBuffer,
  meta: ArchivoNuevo,
): Promise<Resultado<{ r2Key: string }>> {
  if (cuerpo.byteLength === 0) return fallo("entrada_invalida", "el archivo está vacío");
  if (cuerpo.byteLength !== meta.bytes) {
    return fallo("entrada_invalida", "el tamaño declarado no coincide con el archivo");
  }

  // 1. La fila primero, ya marcada. Si todo lo demás se cae, el barrido
  //    encuentra esta marca y limpia; nunca queda un archivo sin dueño.
  try {
    await ctx.db
      .prepare(
        `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,
           referencia_tipo,referencia_id,borrar_despues_de,creado_en)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        clave, meta.tipo, meta.mime, meta.bytes, meta.sensible === false ? 0 : 1,
        ctx.actor, meta.referenciaTipo ?? null, meta.referenciaId ?? null,
        ctx.ahora + GRACIA_SUBIDA_MS, ctx.ahora,
      )
      .run();
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e);
    return /UNIQUE|PRIMARY/i.test(texto)
      ? fallo("repetido", "ya existe un archivo con esa clave")
      : fallo("interno", texto);
  }

  // 2. A R2.
  try {
    await ctx.r2.put(clave, cuerpo, { httpMetadata: { contentType: meta.mime } });
  } catch (e) {
    // La fila queda marcada: el barrido se encarga. No se intenta deshacer
    // aquí —si R2 falló, es probable que borrar también falle— y dejarlo al
    // barrido es justo para lo que existe.
    return fallo("interno", `no se pudo subir: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Confirmado: se quita la marca.
  await ctx.db
    .prepare("UPDATE archivos SET borrar_despues_de = NULL WHERE r2_key = ?")
    .bind(clave)
    .run();

  return ok({ r2Key: clave });
}

/**
 * Marca un archivo para borrar. NO lo borra.
 *
 * Devuelve los enunciados en vez de ejecutarlos cuando se le pide, para que la
 * marca entre en el MISMO batch que el borrado del producto al que pertenece:
 * si el producto no se borra, su foto tampoco se marca.
 */
export function enunciadosParaBorrar(
  ctx: ContextoArchivo,
  claves: readonly string[],
  graciaMs = GRACIA_MS,
): D1PreparedStatement[] {
  return claves.map((k) =>
    ctx.db
      .prepare("UPDATE archivos SET borrar_despues_de = ? WHERE r2_key = ? AND borrar_despues_de IS NULL")
      .bind(ctx.ahora + graciaMs, k),
  );
}

export async function marcarParaBorrar(
  ctx: ContextoArchivo,
  clave: string,
  graciaMs = GRACIA_MS,
): Promise<Resultado<{ borraDespuesDe: number }>> {
  const r = await ctx.db
    .prepare("UPDATE archivos SET borrar_despues_de = ? WHERE r2_key = ?")
    .bind(ctx.ahora + graciaMs, clave)
    .run();

  if ((r.meta.changes ?? 0) === 0) return fallo("no_encontrado", "no existe ese archivo");
  return ok({ borraDespuesDe: ctx.ahora + graciaMs });
}

/** Deshace una marca: la foto se recupera si el barrido no ha pasado. */
export async function recuperar(
  ctx: ContextoArchivo,
  clave: string,
): Promise<Resultado<{ recuperado: true }>> {
  const r = await ctx.db
    .prepare(
      "UPDATE archivos SET borrar_despues_de = NULL WHERE r2_key = ? AND borrar_despues_de IS NOT NULL",
    )
    .bind(clave)
    .run();

  if ((r.meta.changes ?? 0) === 0) {
    return fallo("no_encontrado", "ese archivo no estaba marcado para borrar, o ya no existe");
  }
  return ok({ recuperado: true });
}

/**
 * El barrido: borra de verdad lo que ya cumplió su margen.
 *
 * Lo llama el cron. Primero R2 y después la fila, en ese orden: si R2 falla,
 * la fila sigue marcada y se reintenta en el siguiente barrido. Al revés, el
 * archivo quedaría huérfano sin nada que lo recuerde.
 *
 * `tope` existe para que un borrado masivo no agote el tiempo del cron: lo que
 * no entre, entra en los cinco minutos siguientes.
 */
export async function barrer(
  ctx: ContextoArchivo,
  tope = 100,
): Promise<Resultado<{ borrados: number; fallidos: number }>> {
  const { results } = await ctx.db
    .prepare(
      "SELECT r2_key FROM archivos WHERE borrar_despues_de IS NOT NULL AND borrar_despues_de <= ? LIMIT ?",
    )
    .bind(ctx.ahora, tope)
    .all<{ r2_key: string }>();

  let borrados = 0;
  let fallidos = 0;

  for (const f of results) {
    try {
      // Borrar en R2 una clave que no existe NO falla. Eso es justo lo que se
      // quiere: una subida que se cayó a mitad deja una fila marcada sin
      // archivo, y el barrido la limpia igual.
      await ctx.r2.delete(f.r2_key);
      await ctx.db.prepare("DELETE FROM archivos WHERE r2_key = ?").bind(f.r2_key).run();
      borrados++;
    } catch (e) {
      // La fila se queda marcada: el siguiente barrido lo reintenta.
      fallidos++;
      console.warn(
        JSON.stringify({
          evento: "barrido_archivo_fallido",
          clave: f.r2_key,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return ok({ borrados, fallidos });
}

/**
 * Los huérfanos: archivos en R2 sin fila que los explique.
 *
 * Solo LEE y reporta; no borra. Un huérfano solo puede venir de un error, y
 * borrar a partir de un listado es exactamente cómo se pierde algo que sí
 * importaba — basta con que una fila no se haya escrito todavía.
 *
 * Quien lo mire decide. Lo que esto impide es lo otro: que la basura crezca
 * durante meses sin que nadie se entere.
 */
export async function huerfanos(
  ctx: ContextoArchivo,
  prefijo: string,
  tope = 1000,
): Promise<Resultado<{ claves: string[]; bytes: number }>> {
  const listado = await ctx.r2.list({ prefix: prefijo, limit: tope });
  if (listado.objects.length === 0) return ok({ claves: [], bytes: 0 });

  const { results } = await ctx.db
    .prepare(
      `SELECT r2_key FROM archivos WHERE r2_key IN (${listado.objects.map(() => "?").join(",")})`,
    )
    .bind(...listado.objects.map((o) => o.key))
    .all<{ r2_key: string }>();

  const conocidos = new Set(results.map((r) => r.r2_key));
  const sueltos = listado.objects.filter((o) => !conocidos.has(o.key));

  return ok({
    claves: sueltos.map((o) => o.key),
    bytes: sueltos.reduce((s, o) => s + o.size, 0),
  });
}

/**
 * Lo contrario: filas que apuntan a un archivo que ya no está en R2.
 *
 * Es lo que se ve como una foto rota en la web. Se reporta, no se borra: la
 * fila puede ser lo único que queda para saber qué había ahí.
 */
export async function rotas(
  ctx: ContextoArchivo,
  tope = 200,
): Promise<Resultado<{ claves: string[] }>> {
  const { results } = await ctx.db
    .prepare("SELECT r2_key FROM archivos WHERE borrar_despues_de IS NULL LIMIT ?")
    .bind(tope)
    .all<{ r2_key: string }>();

  const sueltas: string[] = [];
  for (const f of results) {
    const o = await ctx.r2.head(f.r2_key);
    if (o === null) sueltas.push(f.r2_key);
  }

  return ok({ claves: sueltas });
}
