import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import type { RolDePanel } from "../seguridad/roles";

/**
 * Las llaves personales de MCP.
 *
 * MCP vive FUERA de Cloudflare Access: un cliente de MCP no tiene navegador,
 * no inicia sesión con Google y no trae la cookie de Access. Necesita su
 * propia llave, y esa llave tiene que decir QUIÉN es, porque la política del
 * asistente decide por el ROL de la persona y no por el canal.
 *
 * Una llave por persona y por sitio, revocable de una en una. Una sola llave
 * compartida obliga a cambiarla en todas partes cada vez que una se pierde, y
 * por eso nadie la cambia nunca.
 *
 * **El token se enseña UNA vez, al crearlo.** Después solo queda su huella. No
 * es una molestia: es lo que hace que un volcado de la base no sea un llavero.
 */

/** El prefijo existe para que una llave filtrada se reconozca de un vistazo. */
const PREFIJO = "bcmcp_";

/** SHA-256 en hexadecimal. */
async function huellaDe(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const resumen = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Un token nuevo: 256 bits de azar.
 *
 * Con esa entropía, un SHA-256 a secas basta para guardarlo —no hay
 * diccionario que lo adivine—. Un PIN de seis dígitos sí necesita PBKDF2, y
 * por eso `src/seguridad/pin.ts` lo usa; una llave aleatoria no.
 */
function nuevoToken(): string {
  const azar = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...azar))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${PREFIJO}${base64}`;
}

export interface LlaveCreada {
  readonly id: string;
  readonly nombre: string;
  /** Se enseña UNA vez. Después ya no existe en ninguna parte. */
  readonly token: string;
}

export async function crearLlave(
  db: D1Database,
  usuarioId: string,
  nombre: string,
  ahora: number,
): Promise<Resultado<LlaveCreada>> {
  const limpio = nombre.trim();
  if (limpio === "" || limpio.length > 60) {
    return fallo("entrada_invalida", "la llave necesita un nombre de hasta 60 letras");
  }

  const token = nuevoToken();
  const id = ulid(ahora);
  try {
    await db
      .prepare(
        "INSERT INTO mcp_llaves (id, usuario_id, nombre, huella, creado_en) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, usuarioId, limpio, await huellaDe(token), ahora)
      .run();
  } catch (e) {
    const porque = e instanceof Error ? e.message : String(e);
    // La clave foránea es la única forma de que esto falle con un usuario que
    // no existe. Se pregunta por el código, no se adivina por el texto.
    return fallo("interno", `no se pudo crear la llave: ${porque}`);
  }

  return ok({ id, nombre: limpio, token });
}

export interface LlaveEnLista {
  readonly id: string;
  readonly nombre: string;
  readonly creado_en: number;
  readonly ultimo_uso_en: number | null;
  readonly revocado_en: number | null;
}

/** Las llaves de una persona. Nunca sale la huella: no le sirve a nadie. */
export async function llavesDe(db: D1Database, usuarioId: string): Promise<LlaveEnLista[]> {
  const { results } = await db
    .prepare(
      `SELECT id, nombre, creado_en, ultimo_uso_en, revocado_en
         FROM mcp_llaves WHERE usuario_id = ? ORDER BY creado_en DESC`,
    )
    .bind(usuarioId)
    .all<LlaveEnLista>();
  return results;
}

/**
 * Revocar.
 *
 * Solo la propia persona revoca las suyas. Una dueña podría revocar las de
 * otra, pero eso es una pantalla de administración que nadie ha pedido, y
 * dárselo a todo el mundo «por si acaso» es cómo se revoca la llave
 * equivocada un viernes.
 */
export async function revocarLlave(
  db: D1Database,
  usuarioId: string,
  id: string,
  ahora: number,
): Promise<Resultado<{ revocada: true }>> {
  const r = await db
    .prepare(
      "UPDATE mcp_llaves SET revocado_en = ? WHERE id = ? AND usuario_id = ? AND revocado_en IS NULL",
    )
    .bind(ahora, id, usuarioId)
    .run();

  if ((r.meta.changes ?? 0) === 0) {
    // No cambió nada. Se le pregunta a la BASE por qué, en vez de deducirlo:
    // no existe, es de otra persona, o ya estaba revocada son tres respuestas
    // distintas y la de en medio no se dice.
    const fila = await db
      .prepare("SELECT usuario_id, revocado_en FROM mcp_llaves WHERE id = ?")
      .bind(id)
      .first<{ usuario_id: string; revocado_en: number | null }>();

    if (fila === null || fila.usuario_id !== usuarioId) {
      // Que una llave ajena conteste «no existe» es a propósito: decir «esa no
      // es suya» confirma que existe.
      return fallo("no_encontrado", "esa llave no existe");
    }
    return fallo("repetido", "esa llave ya estaba revocada");
  }
  return ok({ revocada: true as const });
}

export interface QuienLlama {
  readonly usuarioId: string;
  readonly correo: string;
  readonly nombre: string;
  readonly rol: RolDePanel;
  readonly llaveId: string;
}

/**
 * Quién hay detrás de un token.
 *
 * Tres condiciones, las tres en la misma consulta: la llave existe, NO está
 * revocada, y su persona sigue activa. La tercera importa tanto como las
 * otras: dar de baja a alguien tiene que cerrarle también MCP, y si se
 * comprobara aparte se olvidaría.
 */
export async function quienEs(
  db: D1Database,
  cabecera: string | null,
  ahora: number,
): Promise<QuienLlama | null> {
  if (cabecera === null) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(cabecera.trim());
  if (m === null) return null;
  const token = m[1]!;
  if (!token.startsWith(PREFIJO)) return null;

  const fila = await db
    .prepare(
      `SELECT l.id AS llave_id, u.id AS usuario_id, u.correo, u.nombre, u.rol
         FROM mcp_llaves l
         JOIN usuarios u ON u.id = l.usuario_id
        WHERE l.huella = ? AND l.revocado_en IS NULL AND u.activo = 1`,
    )
    .bind(await huellaDe(token))
    .first<{ llave_id: string; usuario_id: string; correo: string; nombre: string; rol: string }>();

  if (fila === null) return null;
  if (fila.rol !== "duena" && fila.rol !== "asistente" && fila.rol !== "contadora") return null;

  // El último uso se anota sin esperar y sin que un fallo tumbe la petición:
  // es para saber qué llave sobra, no para decidir nada.
  try {
    await db
      .prepare("UPDATE mcp_llaves SET ultimo_uso_en = ? WHERE id = ?")
      .bind(ahora, fila.llave_id)
      .run();
  } catch {
    /* que no se pueda anotar el uso no es motivo para negar el acceso */
  }

  return {
    usuarioId: fila.usuario_id,
    correo: fila.correo,
    nombre: fila.nombre,
    rol: fila.rol,
    llaveId: fila.llave_id,
  };
}
