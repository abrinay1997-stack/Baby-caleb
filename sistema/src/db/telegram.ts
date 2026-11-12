import { fallo, ok, type Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import { MINUTOS_CODIGO } from "../seguridad/pin";
import type { Rol } from "../seguridad/roles";

/**
 * Vincular un chat de Telegram a una cuenta del panel.
 *
 * La puerta de Telegram no tiene sesión de Access: lo único que Telegram
 * manda es un `chat_id`, y ese número solo significa algo si antes alguien
 * dijo de quién es. Eso es lo que hace este archivo.
 *
 * El camino es: la dueña genera un código en el panel, lo pega en el chat del
 * bot, y el chat que lo canjea queda escrito en `usuarios.telegram_chat_id`.
 * Un solo uso, y vence.
 *
 * ## Por qué el código se guarda hasheado y sin pimienta
 *
 * Lo que se guarda es el SHA-256 del código, no el código: quien pueda leer la
 * tabla no puede vincular su chat con lo que vea. Y a diferencia del PIN del
 * motorizado —que vive meses y solo tiene seis dígitos, así que lleva PBKDF2 y
 * `PIN_PEPPER`— este código son 60 bits de azar y vive diez minutos: no hay
 * nada que derivar a 100.000 iteraciones para proteger un secreto que caduca
 * antes de que termine el primer millonésimo del espacio de búsqueda. Y un
 * hash directo se puede buscar por índice, que es lo que permite canjearlo sin
 * recorrer la tabla probando fila por fila.
 *
 * ## Por qué un chat solo puede ser de una persona
 *
 * `usuarios.telegram_chat_id` es UNIQUE desde la migración 0001. Si ese chat
 * ya era de otra cuenta, el canje se lo quita a la otra en el mismo batch en
 * vez de fallar: es el MISMO teléfono, y la alternativa —negarse— dejaría un
 * chat imposible de volver a vincular sin entrar a la base a mano.
 */

export interface ContextoTelegram {
  readonly db: D1Database;
  readonly ahora: number;
}

/**
 * El alfabeto del código: base32 de Crockford, sin I, L, O ni U.
 *
 * El mismo criterio que los ULID (`src/ids.ts`) y por el mismo motivo: nadie
 * confunde un 1 con una I ni un 0 con una O al leerlo de una pantalla, y no
 * sale ninguna palabra fea por casualidad. Se declara aquí y no se importa de
 * `ids.ts` porque son dos decisiones independientes que hoy coinciden: el
 * alfabeto de los ids es parte de su formato y no puede cambiar, el de un
 * código de un solo uso sí.
 */
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 12 letras, que son 60 bits.
 *
 * El código se guarda con un hash rápido y sin pimienta, así que el largo es
 * lo único que lo protege si la tabla se filtrara: con 60 bits no hay fuerza
 * bruta que llegue antes de que venza. Con los seis dígitos de
 * `seguridad/pin.ts` —que se defienden con PBKDF2 y un candado de intentos—
 * no alcanzaría.
 */
export const LARGO_CODIGO_VINCULO = 12;

/**
 * Cuánto vale el código: los mismos diez minutos que los códigos de las
 * clientas (07-seguridad §3).
 *
 * No es una cifra nueva: es la que el proyecto ya decidió para un código de un
 * solo uso que una persona copia y pega. Inventar otra ventana aquí sería
 * añadir un número que nadie acordó.
 */
export const MINUTOS_VINCULO = MINUTOS_CODIGO;

/** Un código nuevo, en grupos de cuatro para poder leerlo de un tirón. */
export function generarCodigoDeVinculo(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LARGO_CODIGO_VINCULO));
  let letras = "";
  // `b & 31` sobre 32 letras reparte los 256 valores de un byte en ocho cada
  // una: exactamente uniforme, sin sesgo que explicar.
  for (const b of bytes) letras += ALFABETO[b & 31]!;
  return (letras.match(/.{1,4}/g) ?? []).join("-");
}

/**
 * El código tal como se compara: en mayúsculas, sin guiones y con las letras
 * que se confunden traducidas.
 *
 * Las sustituciones son las de Crockford: una I o una L que alguien teclee
 * valen 1, y una O vale 0. Sin esto, un código bien copiado pero mal leído se
 * encuentra con el silencio de la puerta —que es lo que se le contesta a un
 * código malo— y no hay forma de saber que el problema era una letra.
 */
export function normalizarCodigo(crudo: string): string | null {
  const limpio = crudo
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (limpio.length !== LARGO_CODIGO_VINCULO) return null;
  for (const letra of limpio) if (!ALFABETO.includes(letra)) return null;
  return limpio;
}

async function huellaDelCodigo(normalizado: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizado));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Generar
// ---------------------------------------------------------------------------

export interface CodigoDeVinculo {
  /** Lo que se le enseña UNA vez a quien lo pidió. No se guarda en ningún sitio. */
  readonly codigo: string;
  readonly vence_en: number;
  /** De quién va a ser el chat. */
  readonly usuario_id: string;
  readonly nombre: string;
}

/**
 * Un código nuevo para vincular el chat de alguien.
 *
 * Reemplaza el que esa persona tuviera: el de hace media hora, el que quedó en
 * una captura de pantalla, el que se mandó por error a otro lado — todos dejan
 * de servir en cuanto se pide uno nuevo, sin que nadie tenga que acordarse de
 * retirarlos.
 *
 * Sin fila de control: es un solo enunciado que o entra o revienta, igual que
 * el alta de un usuario. Lo que hay que vigilar es el CANJE, y eso se vigila
 * donde se escribe el chat.
 */
export async function crearCodigoDeVinculo(
  ctx: ContextoTelegram,
  usuarioId: string,
  pedidoPor: string,
): Promise<Resultado<CodigoDeVinculo>> {
  const quien = await ctx.db
    .prepare("SELECT id, nombre, activo FROM usuarios WHERE id = ?")
    .bind(usuarioId)
    .first<{ id: string; nombre: string; activo: number }>();

  if (quien === null) return fallo("no_encontrado", "no existe esa persona");
  if (quien.activo !== 1) {
    // Un código para quien no entra al panel no serviría de nada: la puerta de
    // Telegram cruza el chat con `activo = 1` en cada mensaje.
    return fallo(
      "transicion_invalida",
      `${quien.nombre} no tiene acceso al panel. Devuélvale el acceso antes de vincular su Telegram.`,
    );
  }

  const codigo = generarCodigoDeVinculo();
  const normalizado = normalizarCodigo(codigo)!;
  const vence_en = ctx.ahora + MINUTOS_VINCULO * 60_000;

  try {
    await ctx.db
      .prepare(
        `INSERT INTO telegram_vinculos
           (usuario_id, codigo_hash, vence_en, usado_en, usado_por, creado_por, creado_en)
         VALUES (?,?,?,NULL,NULL,?,?)
         ON CONFLICT(usuario_id) DO UPDATE SET
           codigo_hash = excluded.codigo_hash,
           vence_en    = excluded.vence_en,
           usado_en    = NULL,
           usado_por   = NULL,
           creado_por  = excluded.creado_por,
           creado_en   = excluded.creado_en`,
      )
      .bind(usuarioId, await huellaDelCodigo(normalizado), vence_en, pedidoPor, ctx.ahora)
      .run();
  } catch {
    // `creado_por` tiene llave foránea: quien pide el código tiene que ser
    // alguien de `usuarios`. Por la puerta del panel siempre lo es —el usuario
    // sale de cruzar el correo de Access con esa tabla— así que esto solo pasa
    // llamando desde otro sitio. Se dice CUÁL es el problema en vez de dejar
    // escapar un error de SQLite: un error sin causa manda a buscar al sitio
    // equivocado (trampa nº 10).
    const pide = await ctx.db
      .prepare("SELECT id FROM usuarios WHERE id = ?")
      .bind(pedidoPor)
      .first<{ id: string }>();
    if (pide === null) {
      return fallo("no_autorizado", "quien pide el código no es una cuenta del panel");
    }
    return fallo("interno", "no se pudo preparar el código");
  }

  return ok({ codigo, vence_en, usuario_id: usuarioId, nombre: quien.nombre });
}

// ---------------------------------------------------------------------------
// Canjear
// ---------------------------------------------------------------------------

export interface ChatVinculado {
  readonly usuarioId: string;
  readonly nombre: string;
  readonly rol: Rol;
}

/**
 * Canjear un código: este chat pasa a ser de esa persona.
 *
 * Todo lo que tiene que ser cierto se comprueba DENTRO del batch, no antes:
 * los tres `UPDATE` de abajo pueden afectar cero filas sin fallar —un código
 * ya usado, un código vencido, una cuenta desactivada entre que se pidió el
 * código y se canjeó— y «cero filas» no es un error en SQLite. Lo que convierte
 * eso en un fallo es la fila de `controles`, que mira lo que este batch acaba
 * de escribir: el código quemado EN ESTE instante por ESTE chat, y la cuenta
 * activa con ESTE chat puesto. Un control que mirara otra cosa no defendería
 * nada (trampa nº 1).
 */
export async function canjearCodigo(
  ctx: ContextoTelegram,
  crudo: string,
  chatId: string,
): Promise<Resultado<ChatVinculado>> {
  const normalizado = normalizarCodigo(crudo);
  if (normalizado === null) {
    return fallo("entrada_invalida", "ese código no tiene la forma de un código");
  }

  const hash = await huellaDelCodigo(normalizado);
  const fila = await ctx.db
    .prepare(
      `SELECT v.usuario_id, v.vence_en, v.usado_en, u.nombre, u.rol, u.activo
         FROM telegram_vinculos v JOIN usuarios u ON u.id = v.usuario_id
        WHERE v.codigo_hash = ?`,
    )
    .bind(hash)
    .first<{
      usuario_id: string;
      vence_en: number;
      usado_en: number | null;
      nombre: string;
      rol: string;
      activo: number;
    }>();

  // Un código que no existe y uno que ya se usó se contestan igual a
  // propósito: los dos son «eso no vale», y distinguirlos le diría a quien
  // está probando códigos que acertó uno.
  if (fila === null) return fallo("no_encontrado", "ese código no vale");

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE telegram_vinculos SET usado_en = ?, usado_por = ?
            WHERE codigo_hash = ? AND usado_en IS NULL AND vence_en > ?`,
        )
        .bind(ctx.ahora, chatId, hash, ctx.ahora),
      // Ese chat deja de ser de quien fuera antes. `telegram_chat_id` es
      // UNIQUE, así que sin esto el enunciado de abajo chocaría con el índice
      // y el batch se caería por algo que tiene arreglo: es el mismo teléfono.
      ctx.db
        .prepare("UPDATE usuarios SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND id <> ?")
        .bind(chatId, fila.usuario_id),
      ctx.db
        .prepare("UPDATE usuarios SET telegram_chat_id = ? WHERE id = ? AND activo = 1")
        .bind(chatId, fila.usuario_id),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT CASE WHEN
               (SELECT COUNT(*) FROM telegram_vinculos
                 WHERE codigo_hash = ? AND usado_en = ? AND usado_por = ?) = 1
           AND (SELECT COUNT(*) FROM usuarios
                 WHERE id = ? AND activo = 1 AND telegram_chat_id = ?) = 1
             THEN 1 ELSE 0 END), ?)`,
        )
        .bind(
          ulid(ctx.ahora),
          `telegram-vinculo:${fila.usuario_id}`,
          hash,
          ctx.ahora,
          chatId,
          fila.usuario_id,
          chatId,
          ctx.ahora,
        ),
    ]);
  } catch {
    return porQueNoSePudo(fila, ctx.ahora);
  }

  return { ok: true, datos: { usuarioId: fila.usuario_id, nombre: fila.nombre, rol: fila.rol as Rol } };
}

/**
 * Por qué se cayó el batch, mirando lo que ya se había leído.
 *
 * El batch es todo o nada, así que nada cambió y el estado de antes sigue
 * valiendo. Cada causa lleva su propio código: un error mal etiquetado manda a
 * buscar al sitio equivocado (trampa nº 10). Quien llama decide qué contesta —
 * la puerta de Telegram no contesta nada de esto a un chat desconocido.
 */
function porQueNoSePudo(
  fila: { vence_en: number; usado_en: number | null; activo: number; nombre: string },
  ahora: number,
): Resultado<never> {
  if (fila.usado_en !== null) return fallo("repetido", "ese código ya se usó");
  if (fila.vence_en <= ahora) return fallo("transicion_invalida", "ese código ya venció");
  if (fila.activo !== 1) {
    return fallo("no_autorizado", `${fila.nombre} no tiene acceso al panel`);
  }
  return fallo("interno", "no se pudo vincular ese chat");
}

// ---------------------------------------------------------------------------
// Quién es un chat
// ---------------------------------------------------------------------------

/**
 * De quién es este chat, o `null`.
 *
 * Es TODA la autenticación de la puerta de Telegram: el `chat_id` cruzado con
 * `usuarios.telegram_chat_id` y `activo = 1`. Se pregunta en cada mensaje y no
 * una vez al vincular, por lo mismo que el panel cruza el correo en cada
 * petición: quitarle el acceso a alguien tiene efecto en su siguiente mensaje,
 * sin esperar nada y sin tocar Telegram.
 */
export async function usuarioDelChat(
  db: D1Database,
  chatId: string,
): Promise<{ id: string; correo: string; nombre: string; rol: Rol } | null> {
  const fila = await db
    .prepare(
      "SELECT id, correo, nombre, rol FROM usuarios WHERE telegram_chat_id = ? AND activo = 1",
    )
    .bind(chatId)
    .first<{ id: string; correo: string; nombre: string; rol: string }>();

  return fila === null ? null : { ...fila, rol: fila.rol as Rol };
}
