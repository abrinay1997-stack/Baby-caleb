import { type Cola, type Evento, type TipoEvento, colaDe } from "../contrato/eventos";
import { ulid } from "../ids";

/**
 * El patrón outbox: ningún evento se pierde aunque la cola falle.
 *
 * EL PROBLEMA
 *
 * Un pedido se agenda y hay que avisarle a la clienta. Si se escribe el cambio
 * en D1 y después se manda el mensaje a la cola, hay un instante entre las dos
 * cosas: si el Worker muere ahí, o la cola no contesta, el pedido queda
 * agendado y el aviso no sale nunca. Y al revés es peor: mandar primero el
 * aviso y después fallar al escribir deja a la clienta esperando un pedido que
 * no existe.
 *
 * LA SOLUCIÓN
 *
 * El evento se escribe en `eventos_salida` DENTRO DEL MISMO `batch()` que el
 * cambio de estado. El batch es todo o nada, así que o pasan las dos cosas o no
 * pasa ninguna. Publicar a la cola viene después, y si falla no importa: la
 * fila sigue ahí con `publicado_en` en NULL, y el cron de cada 5 minutos la
 * vuelve a intentar (08-operacion §6).
 *
 * Por eso `encolar` no publica nada: devuelve la sentencia para que quien está
 * armando el batch la meta dentro. Si publicara, volvería el problema.
 */

export interface Encolado {
  evento: Evento;
  /** La sentencia que hay que meter en el mismo `batch()` que el cambio. */
  sentencia: D1PreparedStatement;
}

/**
 * Prepara un evento y su fila. No escribe ni publica nada: eso lo hace el batch
 * de quien llama.
 *
 * ```ts
 * const aviso = encolar(env.DB, "pedido.agendado", datos, ahora);
 * await env.DB.batch([
 *   env.DB.prepare("UPDATE pedidos SET estado = 'agendado' ...").bind(...),
 *   env.DB.prepare("INSERT INTO controles ...").bind(...),  // la condición
 *   aviso.sentencia,                                        // el evento
 * ]);
 * await publicar(env, [aviso.evento], ahora);               // y después
 * ```
 */
export function encolar<T>(
  db: D1Database,
  tipo: TipoEvento,
  datos: T,
  ahora: number,
): Encolado {
  const evento: Evento<T> = { id: ulid(ahora), tipo, version: 1, ocurridoEn: ahora, datos };
  const sentencia = db
    .prepare(
      `INSERT INTO eventos_salida (id, cola, tipo, version, datos_json, creado_en)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(evento.id, colaDe(tipo), tipo, evento.version, JSON.stringify(datos), ahora);
  return { evento: evento as Evento, sentencia };
}

export interface EntornoColas {
  DB: D1Database;
  AVISOS: Queue;
  TAREAS: Queue;
}

const colaDelEntorno = (env: EntornoColas, cola: Cola): Queue =>
  cola === "bc-avisos" ? env.AVISOS : env.TAREAS;

export interface ResultadoPublicacion {
  publicados: string[];
  pendientes: string[];
}

/**
 * Publica eventos a su cola y marca los que salieron.
 *
 * Agrupa por cola para usar `sendBatch`, que es una sola llamada en vez de una
 * por evento. Lo que falle se queda con `publicado_en` en NULL y `intentos`
 * sumado uno: no se lanza, porque el cambio de estado YA pasó y hacer fallar la
 * respuesta por un aviso que se reintenta en cinco minutos sería peor.
 */
export async function publicar(
  env: EntornoColas,
  eventos: readonly Evento[],
  ahora: number,
): Promise<ResultadoPublicacion> {
  const publicados: string[] = [];
  const pendientes: string[] = [];

  const porCola = new Map<Cola, Evento[]>();
  for (const e of eventos) {
    const cola = colaDe(e.tipo);
    const lista = porCola.get(cola);
    if (lista) lista.push(e);
    else porCola.set(cola, [e]);
  }

  for (const [cola, lista] of porCola) {
    try {
      await colaDelEntorno(env, cola).sendBatch(lista.map((e) => ({ body: e })));
      publicados.push(...lista.map((e) => e.id));
    } catch (error) {
      console.error(
        JSON.stringify({
          evento: "outbox_publicacion_fallida",
          cola,
          cuantos: lista.length,
          error: String(error).slice(0, 200),
        }),
      );
      pendientes.push(...lista.map((e) => e.id));
    }
  }

  const sentencias: D1PreparedStatement[] = [];
  if (publicados.length > 0) {
    sentencias.push(
      env.DB.prepare(
        `UPDATE eventos_salida SET publicado_en = ?
         WHERE id IN (${publicados.map(() => "?").join(",")})`,
      ).bind(ahora, ...publicados),
    );
  }
  if (pendientes.length > 0) {
    sentencias.push(
      env.DB.prepare(
        `UPDATE eventos_salida SET intentos = intentos + 1
         WHERE id IN (${pendientes.map(() => "?").join(",")})`,
      ).bind(...pendientes),
    );
  }
  if (sentencias.length > 0) {
    try {
      await env.DB.batch(sentencias);
    } catch (error) {
      // Si no se pudo marcar lo publicado, el cron lo volverá a publicar. La
      // cola entrega al menos una vez y el consumidor descarta repetidos, así
      // que un aviso de más no hace daño; uno de menos sí.
      console.error(
        JSON.stringify({ evento: "outbox_marca_fallida", error: String(error).slice(0, 200) }),
      );
    }
  }

  return { publicados, pendientes };
}

/** Cuántos eventos sin publicar se intentan por vuelta del cron. */
export const TOPE_POR_VUELTA = 100;

/**
 * Lo que quedó sin publicar. Lo llama el cron cada 5 minutos.
 *
 * Ordena por `creado_en` para que los avisos salgan en el orden en que pasaron
 * las cosas: a nadie le sirve recibir «va en camino» antes que «pedido
 * agendado».
 */
export async function publicarPendientes(
  env: EntornoColas,
  ahora: number,
  tope = TOPE_POR_VUELTA,
): Promise<ResultadoPublicacion> {
  const { results } = await env.DB.prepare(
    `SELECT id, tipo, version, datos_json, creado_en
     FROM eventos_salida
     WHERE publicado_en IS NULL
     ORDER BY creado_en, id
     LIMIT ?`,
  )
    .bind(tope)
    .all<{
      id: string;
      tipo: string;
      version: number;
      datos_json: string;
      creado_en: number;
    }>();

  if (results.length === 0) return { publicados: [], pendientes: [] };

  const eventos: Evento[] = [];
  for (const fila of results) {
    try {
      eventos.push({
        id: fila.id,
        tipo: fila.tipo as TipoEvento,
        version: 1,
        ocurridoEn: fila.creado_en,
        datos: JSON.parse(fila.datos_json),
      });
    } catch {
      // Una fila con JSON roto no se puede publicar ni arreglar sola. Se deja
      // ahí y se avisa: si se descartara, el aviso desaparecería en silencio,
      // que es exactamente lo que este patrón existe para evitar.
      console.error(JSON.stringify({ evento: "outbox_fila_ilegible", id: fila.id }));
    }
  }

  return publicar(env, eventos, ahora);
}

/** Para el panel y para `/salud`: cuántos avisos están atrasados. */
export async function atrasados(db: D1Database): Promise<{ cuantos: number; masViejo: number | null }> {
  const fila = await db
    .prepare(
      `SELECT COUNT(*) AS cuantos, MIN(creado_en) AS mas_viejo
       FROM eventos_salida WHERE publicado_en IS NULL`,
    )
    .first<{ cuantos: number; mas_viejo: number | null }>();
  return { cuantos: fila?.cuantos ?? 0, masViejo: fila?.mas_viejo ?? null };
}
