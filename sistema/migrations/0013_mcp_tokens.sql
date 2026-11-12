-- 0013 · Las llaves personales para MCP
--
-- MCP vive FUERA de Cloudflare Access: un cliente de MCP no tiene navegador,
-- no puede iniciar sesión con Google y no trae la cookie de Access. Así que
-- necesita su propia llave, y esa llave tiene que decir QUIÉN es — porque la
-- política del asistente decide por el rol de la persona, no por el canal.
--
-- Una llave por persona y por sitio ("mi portátil", "el servidor de casa"),
-- revocable de una en una. Si se revoca la llave del portátil, el del servidor
-- sigue funcionando: una sola llave compartida obliga a cambiarla en todas
-- partes cada vez que una se pierde, y por eso nadie la cambia nunca.

CREATE TABLE mcp_llaves (
  id            TEXT PRIMARY KEY,
  usuario_id    TEXT NOT NULL REFERENCES usuarios(id),
  -- Para qué es. Sin esto, revocar es adivinar cuál de las cuatro sobra.
  nombre        TEXT NOT NULL,
  -- El SHA-256 del token en hexadecimal, NUNCA el token.
  --
  -- Si la base se filtra, lo que se lleva el que la lea son hashes, no llaves
  -- que funcionan. Y como el token es aleatorio de 256 bits, un SHA-256 a
  -- secas basta: no hay diccionario que lo adivine. (Un PIN de seis dígitos sí
  -- necesita PBKDF2 — ver `src/seguridad/pin.ts`; una llave aleatoria no.)
  huella        TEXT NOT NULL UNIQUE,
  creado_en     INTEGER NOT NULL,
  -- Para poder ver cuál no usa nadie y apagarla.
  ultimo_uso_en INTEGER,
  -- Revocar NO borra la fila: la bitácora de `acciones` apunta al usuario y
  -- hay que poder reconstruir por dónde entró cada cosa.
  revocado_en   INTEGER
) STRICT;

CREATE INDEX mcp_llaves_por_usuario ON mcp_llaves (usuario_id);

-- Una llave revocada no se vuelve a activar: se crea otra. Reactivar una llave
-- que estuvo apagada deja un hueco en el que nadie sabe si se usó mientras
-- tanto.
CREATE TRIGGER mcp_llaves_no_se_reactivan
BEFORE UPDATE OF revocado_en ON mcp_llaves
WHEN OLD.revocado_en IS NOT NULL AND NEW.revocado_en IS NULL
BEGIN
  SELECT RAISE(ABORT, 'una llave revocada no se reactiva: cree otra');
END;

-- Y la huella no se edita. Cambiarla sería cambiar la llave sin que nadie se
-- entere, dejando la misma fila y el mismo historial.
CREATE TRIGGER mcp_llaves_la_huella_no_se_edita
BEFORE UPDATE OF huella, usuario_id, creado_en ON mcp_llaves
BEGIN
  SELECT RAISE(ABORT, 'la huella, el dueño y la fecha de una llave no se editan');
END;
