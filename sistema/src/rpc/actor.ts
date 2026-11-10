import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import type { Rol } from "../seguridad/roles";

/**
 * Quién llama por RPC, y qué puede hacer.
 *
 * El service binding dice que la llamada viene del CRM, no QUIÉN la pidió: al
 * otro lado puede estar la dueña por Telegram o el bot contestándole a una
 * clienta. El CRM manda un `Actor` diciéndolo, y aquí se COMPRUEBA, porque un
 * campo que manda quien llama no es una credencial.
 *
 * «Un actor `bot` nunca puede llamar a los métodos de la dueña: el sistema lo
 * rechaza con `no_autorizado`» (03-contratos §3). La comprobación de verdad es
 * cruzar su chat de Telegram con `usuarios`: si no está ahí, o está inactivo,
 * no es nadie — aunque el CRM jure que es la dueña.
 */

export interface Actor {
  readonly tipo: "bot" | "duena" | "usuario";
  /** El chat_id de Telegram, o el id del usuario del panel. */
  readonly id: string;
  readonly canal: string;
  readonly conversacionRef?: string;
}

export interface QuienEs {
  readonly usuarioId: string;
  readonly nombre: string;
  readonly rol: Rol;
}

/**
 * Comprueba que quien dice ser la dueña lo sea.
 *
 * Dos pasos y los dos pueden fallar. Que `actor.tipo` no sea `bot` solo dice lo
 * que el CRM cree; que el chat esté en `usuarios` y activo es lo que lo hace
 * cierto. El primero se mira igual, porque un bot que manda `tipo: 'duena'`
 * es una señal de que algo va mal y conviene que no funcione nunca.
 */
export async function comoPersona(db: D1Database, actor: Actor): Promise<Resultado<QuienEs>> {
  if (actor.tipo === "bot") {
    return fallo("no_autorizado", "el bot no puede hacer esto: tiene que pedirlo una persona");
  }

  const id = actor.id.trim();
  if (id === "") {
    return fallo("no_autorizado", "la llamada no dice quién la pide");
  }

  // Por chat de Telegram o por id de usuario del panel: el CRM usa lo uno o lo
  // otro según por dónde entre la dueña, y las dos acaban en la misma fila.
  const fila = await db
    .prepare(
      `SELECT id, nombre, rol FROM usuarios
       WHERE activo = 1 AND (telegram_chat_id = ?1 OR id = ?1)`,
    )
    .bind(id)
    .first<{ id: string; nombre: string; rol: string }>();

  if (fila === null) {
    // El motivo se dice a propósito: sin él, un 403 en la consola de la dueña
    // es un callejón sin salida (lección del incidente 4 de D'Casa).
    return fallo(
      "no_autorizado",
      "ese chat no está vinculado a ninguna cuenta activa del panel",
    );
  }

  return ok({ usuarioId: fila.id, nombre: fila.nombre, rol: fila.rol as Rol });
}

/** Lo mismo, pero exigiendo que sea la dueña. */
export async function comoDuena(db: D1Database, actor: Actor): Promise<Resultado<QuienEs>> {
  const quien = await comoPersona(db, actor);
  if (!quien.ok) return quien;
  if (quien.datos.rol !== "duena") {
    return fallo("no_autorizado", `esto solo lo hace la dueña, y usted entra como ${quien.datos.rol}`);
  }
  return quien;
}

/** Cómo queda escrito en los libros quien hizo algo. */
export const comoSeFirma = (actor: Actor, quien: QuienEs): string =>
  `${quien.usuarioId}@${actor.canal}`;
