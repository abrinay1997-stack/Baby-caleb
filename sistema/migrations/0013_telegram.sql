-- 0013_telegram.sql · Vincular un chat de Telegram a una cuenta del panel
--
-- La puerta de Telegram autentica cruzando el `chat_id` que manda Telegram con
-- `usuarios.telegram_chat_id` y `activo = 1` (06-asistente §4 y §7). Esa
-- columna existe desde 0001 y NADIE la escribía: no había forma de poner un
-- chat ahí que no fuera un UPDATE a mano en la consola de D1, y la dueña de
-- este sistema no usa la terminal. Una puerta cuya única llave se fabrica por
-- SQL es una puerta cerrada.
--
-- Esta tabla es la llave: la dueña genera un código de un solo uso en el panel
-- y lo pega en el chat del bot. El chat que lo canjea queda escrito en
-- `usuarios.telegram_chat_id`.
--
-- POR QUÉ NO SE REUSA `codigos_acceso`: esa tabla es de las CLIENTAS y está
-- llaveada por celular (`celular_e164`), que es su dato de identidad. Aquí la
-- identidad es un usuario del panel y lo que se canjea es un chat. Dos cosas
-- distintas con la misma forma siguen siendo dos cosas distintas, y mezclarlas
-- rompe «un dato, un solo dueño».
--
-- Convenciones de 0001: ids TEXT con ULID, tiempo INTEGER en ms UTC, booleanos
-- INTEGER 0/1, todas STRICT.

CREATE TABLE telegram_vinculos (
  -- UN código vivo por persona, y por eso la llave es el usuario y no el
  -- código: generar uno nuevo REEMPLAZA el anterior, así que el que se pidió
  -- hace media hora y se quedó en una captura de pantalla deja de servir sin
  -- que nadie tenga que acordarse de retirarlo.
  usuario_id  TEXT PRIMARY KEY REFERENCES usuarios(id),
  -- El código NO se guarda: se guarda su SHA-256. Quien lea esta tabla no
  -- puede vincular su propio chat con lo que vea.
  codigo_hash TEXT NOT NULL UNIQUE,
  vence_en    INTEGER NOT NULL,
  -- Un solo uso: `usado_en` se escribe en el mismo batch que el chat_id, con
  -- la guarda `usado_en IS NULL`. Canjearlo dos veces no vincula dos veces.
  usado_en    INTEGER,
  -- Qué chat lo canjeó. Queda para poder reconstruir quién entró por dónde;
  -- es un id de Telegram, no un dato de una clienta.
  usado_por   TEXT,
  creado_por  TEXT NOT NULL REFERENCES usuarios(id),
  creado_en   INTEGER NOT NULL,
  -- Usado es usado: o están los dos campos o no está ninguno. Sin esto se
  -- puede quemar un código sin decir qué chat se lo llevó.
  CHECK ((usado_en IS NULL) = (usado_por IS NULL))
) STRICT;

-- El canje busca por el hash del código, que es lo único que trae quien lo
-- pega. El UNIQUE de arriba ya pone el índice; esto es para el barrido de los
-- vencidos, que se hace por fecha.
CREATE INDEX telegram_vinculos_vence ON telegram_vinculos (vence_en);
