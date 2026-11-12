import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LARGO_CODIGO_VINCULO,
  MINUTOS_VINCULO,
  canjearCodigo,
  crearCodigoDeVinculo,
  generarCodigoDeVinculo,
  normalizarCodigo,
  usuarioDelChat,
} from "./telegram";

/**
 * Vincular un chat de Telegram a una cuenta del panel.
 *
 * Esto es TODA la llave de la puerta de Telegram: si un código se puede usar
 * dos veces, o después de vencer, o sobre una cuenta a la que ya le quitaron
 * el acceso, entonces un chat cualquiera acaba hablando con Caleb con los
 * permisos de la dueña.
 *
 * Corre contra una D1 de verdad a propósito: lo que sostiene estas reglas no
 * es el `if` de TypeScript, es la fila de `controles` dentro del batch y el
 * `CHECK (ok = 1)` de la tabla. Un simulacro de base no comprobaría nada de
 * eso.
 */

const DUENA = "u-tg-duena";
const OTRA = "u-tg-otra";
const CHAT = "501501501";

const ahora = () => Date.now();

async function sembrar(): Promise<void> {
  await real.DB.batch([
    real.DB.prepare("DELETE FROM telegram_vinculos"),
    real.DB.prepare("UPDATE usuarios SET telegram_chat_id = NULL"),
    real.DB
      .prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, telegram_chat_id, activo, creado_en)
         VALUES (?, 'tg-duena@babycaleb.com', 'Yarielis', 'duena', NULL, 1, ?)
         ON CONFLICT(id) DO UPDATE SET activo = 1, telegram_chat_id = NULL`,
      )
      .bind(DUENA, ahora()),
    real.DB
      .prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, telegram_chat_id, activo, creado_en)
         VALUES (?, 'tg-otra@babycaleb.com', 'Asistente', 'asistente', NULL, 1, ?)
         ON CONFLICT(id) DO UPDATE SET activo = 1, telegram_chat_id = NULL`,
      )
      .bind(OTRA, ahora()),
  ]);
}

beforeEach(sembrar);

const nuevoCodigo = async (para = DUENA, t = ahora()) => {
  const r = await crearCodigoDeVinculo({ db: real.DB, ahora: t }, para, DUENA);
  if (!r.ok) throw new Error(`no se pudo crear el código: ${r.mensaje}`);
  return r.datos;
};

describe("el código", () => {
  it("se lee de un tirón y se normaliza igual", () => {
    const codigo = generarCodigoDeVinculo();
    expect(codigo).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normalizarCodigo(codigo)).toHaveLength(LARGO_CODIGO_VINCULO);
  });

  it("perdona las letras que se confunden al leerlo", () => {
    // Crockford: la I y la L valen 1, la O vale 0. Sin esto, un código bien
    // copiado pero mal leído se encuentra con el silencio de la puerta y no
    // hay forma de saber que el problema era una letra.
    expect(normalizarCodigo("abcd-efgh-jkmn")).toBe(normalizarCodigo("ABCD-EFGH-JKMN"));
    expect(normalizarCodigo("I1L1-0O00-1111")).toBe("111100001111");
  });

  it("no acepta algo que no tenga su forma", () => {
    expect(normalizarCodigo("ABC")).toBeNull();
    expect(normalizarCodigo("")).toBeNull();
    expect(normalizarCodigo("ABCD-EFGH-JKMN-PQRS")).toBeNull();
  });

  it("no sale dos veces el mismo", () => {
    const vistos = new Set(Array.from({ length: 200 }, () => generarCodigoDeVinculo()));
    expect(vistos.size).toBe(200);
  });

  it("no se guarda en la base: lo que queda es su hash", async () => {
    const { codigo } = await nuevoCodigo();
    const fila = await real.DB.prepare(
      "SELECT codigo_hash FROM telegram_vinculos WHERE usuario_id = ?",
    )
      .bind(DUENA)
      .first<{ codigo_hash: string }>();

    expect(fila?.codigo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila?.codigo_hash).not.toContain(normalizarCodigo(codigo));
  });

  it("vence a los minutos que dice la constante, no a los que diga nadie", async () => {
    const t = ahora();
    const { vence_en } = await nuevoCodigo(DUENA, t);
    expect(vence_en).toBe(t + MINUTOS_VINCULO * 60_000);
  });

  it("pedir uno nuevo anula el anterior", async () => {
    // El de hace media hora, el que quedó en una captura de pantalla, el que
    // se mandó por error: todos dejan de servir sin que nadie los retire.
    const viejo = await nuevoCodigo();
    await nuevoCodigo();

    const r = await canjearCodigo({ db: real.DB, ahora: ahora() }, viejo.codigo, CHAT);
    expect(r.ok).toBe(false);
    expect(await usuarioDelChat(real.DB, CHAT)).toBeNull();
  });

  it("no se le hace a quien no tiene acceso al panel", async () => {
    await real.DB.prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").bind(OTRA).run();
    const r = await crearCodigoDeVinculo({ db: real.DB, ahora: ahora() }, OTRA, DUENA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
  });

  it("ni a alguien que no existe", async () => {
    const r = await crearCodigoDeVinculo({ db: real.DB, ahora: ahora() }, "no-existe", DUENA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});

describe("canjearlo", () => {
  it("escribe el chat en la cuenta de esa persona", async () => {
    const { codigo } = await nuevoCodigo();
    const r = await canjearCodigo({ db: real.DB, ahora: ahora() }, codigo, CHAT);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos).toMatchObject({ usuarioId: DUENA, nombre: "Yarielis", rol: "duena" });
    expect(await usuarioDelChat(real.DB, CHAT)).toMatchObject({ id: DUENA, rol: "duena" });
  });

  it("vale UNA vez: el segundo canje no vincula nada", async () => {
    const { codigo } = await nuevoCodigo();
    await canjearCodigo({ db: real.DB, ahora: ahora() }, codigo, CHAT);

    const otra = await canjearCodigo({ db: real.DB, ahora: ahora() }, codigo, "999999");
    expect(otra.ok).toBe(false);
    if (!otra.ok) expect(otra.codigo).toBe("repetido");
    // Y el chat de quien lo intentó NO quedó vinculado a nada.
    expect(await usuarioDelChat(real.DB, "999999")).toBeNull();
  });

  it("no vale después de vencer", async () => {
    const t = ahora();
    const { codigo } = await nuevoCodigo(DUENA, t);
    const tarde = t + MINUTOS_VINCULO * 60_000 + 1;

    const r = await canjearCodigo({ db: real.DB, ahora: tarde }, codigo, CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
    expect(await usuarioDelChat(real.DB, CHAT)).toBeNull();
  });

  it("no vale si entre pedirlo y canjearlo le quitaron el acceso", async () => {
    const { codigo } = await nuevoCodigo();
    await real.DB.prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").bind(DUENA).run();

    const r = await canjearCodigo({ db: real.DB, ahora: ahora() }, codigo, CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");

    const fila = await real.DB.prepare("SELECT telegram_chat_id FROM usuarios WHERE id = ?")
      .bind(DUENA)
      .first<{ telegram_chat_id: string | null }>();
    expect(fila?.telegram_chat_id).toBeNull();
  });

  it("un código inventado no vale", async () => {
    const r = await canjearCodigo({ db: real.DB, ahora: ahora() }, "ABCD-EFGH-JKMN", CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  it("y uno con otra forma tampoco, sin tocar la base", async () => {
    const r = await canjearCodigo({ db: real.DB, ahora: ahora() }, "hola", CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  it("un chat que ya era de otra persona pasa a ser de quien canjea", async () => {
    // Es el MISMO teléfono. Negarse dejaría un chat imposible de volver a
    // vincular sin entrar a la base a mano, y `telegram_chat_id` es UNIQUE.
    const primero = await nuevoCodigo(OTRA);
    await canjearCodigo({ db: real.DB, ahora: ahora() }, primero.codigo, CHAT);
    expect(await usuarioDelChat(real.DB, CHAT)).toMatchObject({ id: OTRA });

    const segundo = await nuevoCodigo(DUENA);
    const r = await canjearCodigo({ db: real.DB, ahora: ahora() }, segundo.codigo, CHAT);

    expect(r.ok).toBe(true);
    expect(await usuarioDelChat(real.DB, CHAT)).toMatchObject({ id: DUENA });
    // Y la otra cuenta se queda sin chat, no con el mismo.
    const antigua = await real.DB.prepare("SELECT telegram_chat_id FROM usuarios WHERE id = ?")
      .bind(OTRA)
      .first<{ telegram_chat_id: string | null }>();
    expect(antigua?.telegram_chat_id).toBeNull();
  });

  it("deja la fila de control de lo que acabó de escribir", async () => {
    const { codigo } = await nuevoCodigo();
    await canjearCodigo({ db: real.DB, ahora: ahora() }, codigo, CHAT);

    const fila = await real.DB.prepare(
      "SELECT ok FROM controles WHERE regla = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(`telegram-vinculo:${DUENA}`)
      .first<{ ok: number }>();
    expect(fila?.ok).toBe(1);
  });
});

describe("de quién es un chat", () => {
  it("de nadie, si no está vinculado", async () => {
    expect(await usuarioDelChat(real.DB, "no-vinculado")).toBeNull();
  });

  it("de nadie, si le quitaron el acceso DESPUÉS de vincularlo", async () => {
    // Se pregunta en cada mensaje por esto: quitarle el acceso a alguien tiene
    // efecto en su siguiente mensaje, sin esperar nada y sin tocar Telegram.
    const { codigo } = await nuevoCodigo();
    await canjearCodigo({ db: real.DB, ahora: ahora() }, codigo, CHAT);
    expect(await usuarioDelChat(real.DB, CHAT)).not.toBeNull();

    await real.DB.prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").bind(DUENA).run();
    expect(await usuarioDelChat(real.DB, CHAT)).toBeNull();
  });
});
