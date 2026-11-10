import { type Evento, type TipoEvento, validarEvento } from "../contrato/eventos";
import { encolar, publicar } from "./outbox";

/**
 * El consumidor de `bc-tareas` y de las colas muertas.
 *
 * LAS COLAS ENTREGAN AL MENOS UNA VEZ
 *
 * No es un detalle: significa que el mismo mensaje puede llegar dos veces, y
 * que un cobro o un envío a Meta hecho dos veces es un problema de verdad. Por
 * eso lo primero de todo es mirar `eventos_recibidos`.
 *
 * CUÁNDO SE MARCA RECIBIDO, Y POR QUÉ IMPORTA
 *
 * Se marca DESPUÉS de que el trabajo salió bien, no antes. Al revés —marcar y
 * luego trabajar— un fallo dejaría el evento marcado como hecho sin haberse
 * hecho, y la cola no lo reintentaría nunca: el peor de los dos mundos.
 *
 * Lo que eso cuesta: si el trabajo sale bien y el marcado falla, la próxima
 * entrega lo repite. Por eso **cada manejador tiene que ser idempotente por su
 * cuenta**, y el contrato ya lo prevé: `meta.purchase` manda `event_id` = id
 * del pago, así que Meta descarta el repetido; `pago.consultar` solo lee. El
 * manejador que escriba en D1 mete su propio marcado en el mismo `batch()`.
 */

export type Manejador = (evento: Evento, env: Env, ahora: number) => Promise<void>;

export type Manejadores = Partial<Record<TipoEvento, Manejador>>;

export interface ResumenLote {
  hechos: number;
  repetidos: number;
  descartados: number;
  reintentos: number;
}

/** Una cola de mensajes muertos, por su nombre. Vale para producción y staging. */
export const esColaMuerta = (nombre: string): boolean => nombre.endsWith("-muertos");

/**
 * Procesa un lote de `bc-tareas`.
 *
 * `manejadores` empieza casi vacío y cada fase le agrega los suyos. Un tipo
 * válido sin manejador se descarta con una alerta en vez de reintentarse:
 * reintentar cinco veces no hace aparecer un manejador que todavía no se ha
 * programado, y lo que hace falta es que alguien lo sepa.
 */
export async function consumirTareas(
  lote: MessageBatch<unknown>,
  env: Env,
  ahora: number,
  manejadores: Manejadores,
): Promise<ResumenLote> {
  const resumen: ResumenLote = { hechos: 0, repetidos: 0, descartados: 0, reintentos: 0 };

  for (const mensaje of lote.messages) {
    const validado = validarEvento(mensaje.body);

    if (!validado.ok) {
      // Un mensaje mal formado no se reintenta: llegó mal por un error de quien
      // lo publicó, no por una falla pasajera, y cinco reintentos solo retrasan
      // el aviso.
      console.error(
        JSON.stringify({ evento: "cola_mensaje_invalido", motivo: validado.motivo }),
      );
      await alertar(env, ahora, "error", `Mensaje inválido en ${lote.queue}: ${validado.motivo}`);
      mensaje.ack();
      resumen.descartados += 1;
      continue;
    }

    const { evento } = validado;

    try {
      const visto = await env.DB.prepare("SELECT 1 FROM eventos_recibidos WHERE id = ?")
        .bind(evento.id)
        .first();
      if (visto) {
        mensaje.ack();
        resumen.repetidos += 1;
        continue;
      }

      const manejador = manejadores[evento.tipo];
      if (!manejador) {
        console.error(JSON.stringify({ evento: "cola_sin_manejador", tipo: evento.tipo }));
        await alertar(
          env,
          ahora,
          "error",
          `No hay quién atienda «${evento.tipo}»: el evento se descartó.`,
        );
        mensaje.ack();
        resumen.descartados += 1;
        continue;
      }

      await manejador(evento, env, ahora);

      await env.DB.prepare(
        "INSERT OR IGNORE INTO eventos_recibidos (id, tipo, procesado_en) VALUES (?, ?, ?)",
      )
        .bind(evento.id, evento.tipo, ahora)
        .run();

      mensaje.ack();
      resumen.hechos += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          evento: "cola_manejador_fallido",
          tipo: evento.tipo,
          id: evento.id,
          error: String(error).slice(0, 200),
        }),
      );
      // Que lo reintente la cola. A los 5 intentos cae en la cola muerta.
      mensaje.retry();
      resumen.reintentos += 1;
    }
  }

  return resumen;
}

/**
 * La cola muerta.
 *
 * Lo que llega aquí ya se intentó cinco veces: no se vuelve a intentar. Lo
 * único que se hace es avisar, que es lo que pide el contrato («lo que cae en
 * la cola muerta genera `sistema.alerta`»). Si se reintentara, un mensaje
 * imposible daría vueltas para siempre y nadie se enteraría.
 */
export async function consumirColaMuerta(
  lote: MessageBatch<unknown>,
  env: Env,
  ahora: number,
): Promise<ResumenLote> {
  const resumen: ResumenLote = { hechos: 0, repetidos: 0, descartados: 0, reintentos: 0 };

  for (const mensaje of lote.messages) {
    const validado = validarEvento(mensaje.body);
    const descripcion = validado.ok
      ? `«${validado.evento.tipo}» (${validado.evento.id})`
      : `un mensaje ilegible (${validado.motivo})`;

    console.error(
      JSON.stringify({ evento: "cola_muerta", cola: lote.queue, detalle: descripcion }),
    );
    await alertar(
      env,
      ahora,
      "critico",
      `Se agotaron los reintentos de ${descripcion} en ${lote.queue}. No se hizo.`,
    );

    // Siempre ack: lo que cae aquí no se reintenta.
    mensaje.ack();
    resumen.descartados += 1;
  }

  return resumen;
}

/**
 * Deja una alerta en el outbox y la publica. Va por `bc-avisos`, así que la
 * dueña la recibe por Telegram como cualquier otro aviso.
 *
 * Si esto falla no se propaga el error: una alerta que no sale no debe tumbar
 * el procesamiento del lote, y la fila del outbox queda para el cron.
 */
async function alertar(
  env: Env,
  ahora: number,
  nivel: "aviso" | "error" | "critico",
  mensaje: string,
): Promise<void> {
  try {
    const { evento, sentencia } = encolar(env.DB, "sistema.alerta", { nivel, mensaje }, ahora);
    // Primero la fila del outbox y después publicar: si lo segundo falla, el
    // cron la republica. Una alerta que no sale sería justo el peor momento
    // para perder un aviso.
    await sentencia.run();
    await publicar(env, [evento], ahora);
  } catch (error) {
    console.error(
      JSON.stringify({ evento: "alerta_fallida", error: String(error).slice(0, 200) }),
    );
  }
}

/**
 * El punto de entrada del `queue()` del Worker: decide si el lote es de tareas
 * o de una cola muerta.
 */
export async function consumir(
  lote: MessageBatch<unknown>,
  env: Env,
  ahora: number,
  manejadores: Manejadores,
): Promise<ResumenLote> {
  return esColaMuerta(lote.queue)
    ? consumirColaMuerta(lote, env, ahora)
    : consumirTareas(lote, env, ahora, manejadores);
}

/**
 * Los manejadores que existen hoy: ninguno.
 *
 * No es un olvido. `meta.purchase` llega en F7, `pago.consultar` en F4b,
 * `reporte.excel` en F5 y `correo.enviar` en F7. Hasta entonces, un evento de
 * esos tipos no debería estar publicándose; si aparece, la alerta de «no hay
 * quién atienda» es exactamente lo que hace falta ver.
 */
export const MANEJADORES: Manejadores = {};
