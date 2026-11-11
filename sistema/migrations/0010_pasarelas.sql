-- 0010_pasarelas.sql · Dónde se configuran los conectores de cobro (F4.6–4.8)
--
-- El dueño lo pidió así: «necesitamos poder poner los conectores o pasarelas de
-- pago en el panel administrativo, poder integrarlos así como en Odoo». Esto es
-- el sitio donde viven esas configuraciones. No depende de los trámites
-- bancarios: los trámites bloquean COBRAR de verdad, no tener dónde pegar las
-- credenciales el día que lleguen.
--
-- Tres tablas, y lo importante es qué NO hay en ellas:
--
--   pasarelas              en qué modo está cada una (prueba o real) y nada más.
--   pasarela_credenciales  el baúl: una fila por (pasarela, modo, credencial)
--                          con el secreto CIFRADO. Aquí no hay un solo secreto
--                          legible, ni para quien pueda leer la base entera.
--   pasarela_bitacora      el libro de los cambios: quién tocó qué y por qué.
--                          No tiene ninguna columna donde pudiera caber un
--                          valor, y eso es a propósito.
--
-- ## No hay columna «activa», y es la decisión de diseño principal
--
-- Qué pasarelas están encendidas ya tiene dueño: `ajustes.pasarelas_activas`
-- (reglas.json, `src/dominio/ajustes.ts`), que nació vacío, tiene historial con
-- firma y motivo, y es lo que lee el checkout. Una columna `activa` aquí sería
-- un segundo dueño del mismo dato: el día que discreparan, el checkout haría
-- caso a uno y el panel enseñaría el otro, y nadie sabría cuál creer. Así que
-- encender una pasarela es cambiar un ajuste, con todo lo que eso ya trae.
--
-- Efecto secundario que viene gratis y que el pedido exige: **una pasarela nace
-- apagada**. No porque haya un `DEFAULT 0` que alguien pueda cambiar, sino
-- porque la lista de encendidas arranca vacía y configurar una credencial no la
-- toca. Encender es un acto aparte.
--
-- ## Prueba y real
--
-- Son dos juegos de credenciales distintos, no un interruptor: el modo es parte
-- de la LLAVE del baúl. Cobrar de verdad con credenciales de prueba (o al
-- revés) es el fallo caro de esta pieza, y lo que lo impide son tres cosas que
-- se solapan: filas distintas por modo, el cifrado atado al modo (ver abajo) y
-- la regla de que no se cambia de modo con la pasarela encendida
-- (`src/db/pasarelas.ts`).
--
-- ## Lo que estas tablas hacen IMPOSIBLE
--
--   * que un secreto entre sin cifrar — la columna exige la marca `aesgcm1.`
--     que pone `src/seguridad/cifrado.ts`, un largo que no cabe sin nonce y
--     etiqueta, y un alfabeto en el que no entra ni un espacio; una clave
--     pegada a mano en la consola de D1 se rechaza;
--   * que el mismo criptograma aparezca en dos sitios (UNIQUE), que es como se
--     vería un intento de copiar la credencial de prueba al modo real;
--   * que una credencial cambie de pasarela o de modo sin dejar de ser la
--     misma fila;
--   * que una credencial se reescriba sin subir de versión — que es lo que
--     convierte un cambio simultáneo en un error en vez de en un cambio
--     perdido;
--   * que el libro de cambios se edite o se borre;
--   * que una línea del libro diga que cambió una credencial sin decir cuál, o
--     que cambió el modo nombrando una credencial.
--
-- Y lo que NINGUNA restricción puede hacer, dicho aquí para que nadie lo
-- suponga: que el criptograma sea de verdad descifrable. Eso lo dice el
-- cifrado, no el esquema. El `CHECK` de forma es una puerta contra el descuido,
-- no una prueba.

-- ---------------------------------------------------------------------------
-- En qué modo está cada pasarela
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pasarelas (
  -- Las tres de docs/plan/04-pagos.md §2. `manual` no es una pasarela: no tiene
  -- credenciales, no se enciende ni se apaga, y su flujo ya vive en `pagos`.
  pasarela          TEXT PRIMARY KEY CHECK (pasarela IN ('yappy','tilopay','paypal')),
  modo              TEXT NOT NULL CHECK (modo IN ('prueba','real')),
  -- NULL los dos = nació así, nadie lo ha cambiado. Es distinto de «lo cambió
  -- la instalación», que sería una firma inventada en el historial.
  modo_cambiado_por TEXT,
  modo_cambiado_en  INTEGER,
  CHECK ((modo_cambiado_por IS NULL) = (modo_cambiado_en IS NULL))
) STRICT;

-- Las tres nacen en `prueba`, que es el modo que no cobra. La fila existe desde
-- el principio para que la pantalla pueda enseñar las tres aunque nadie haya
-- tocado nada: una pasarela que no aparece en la lista es una que nadie busca.
INSERT INTO pasarelas (pasarela, modo) VALUES ('yappy', 'prueba')
  ON CONFLICT (pasarela) DO NOTHING;
INSERT INTO pasarelas (pasarela, modo) VALUES ('tilopay', 'prueba')
  ON CONFLICT (pasarela) DO NOTHING;
INSERT INTO pasarelas (pasarela, modo) VALUES ('paypal', 'prueba')
  ON CONFLICT (pasarela) DO NOTHING;

-- ---------------------------------------------------------------------------
-- El baúl
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pasarela_credenciales (
  pasarela        TEXT NOT NULL REFERENCES pasarelas(pasarela),
  modo            TEXT NOT NULL CHECK (modo IN ('prueba','real')),
  -- El nombre del campo, como lo declara `src/dominio/pasarelas.ts`
  -- ('id_comercio', 'clave_secreta', 'client_id'…). Minúsculas con guion bajo:
  -- es lo que buscará el adaptador, y un nombre con mayúscula o con espacio
  -- sería la misma credencial con dos nombres.
  credencial      TEXT NOT NULL CHECK (
                    credencial GLOB '[a-z]*'
                    AND credencial NOT GLOB '*[^a-z0-9_]*'
                    AND length(credencial) BETWEEN 2 AND 64
                  ),
  -- Sube 1 en cada reescritura. Es el candado contra el cambio perdido: ver el
  -- trigger `pasarela_credencial_sube_de_version`.
  version         INTEGER NOT NULL CHECK (version > 0),
  -- El secreto, cifrado con AES-GCM. Formato:
  --   'aesgcm1.' + base64url(nonce(12) ‖ criptograma ‖ etiqueta(16))
  --
  -- El CHECK exige las tres cosas que distinguen un sobre de este sistema de
  -- un secreto pegado a mano: la marca del algoritmo, un largo que no cabe sin
  -- nonce ni etiqueta (8 + 38 = 46), y el alfabeto de base64url más el punto.
  -- Una clave de PayPal escrita en claro en esta columna no pasa.
  secreto_cifrado TEXT NOT NULL CHECK (
                    secreto_cifrado LIKE 'aesgcm1.%'
                    AND length(secreto_cifrado) >= 46
                    AND secreto_cifrado NOT GLOB '*[^A-Za-z0-9_.-]*'
                  ),
  -- Huella de la LLAVE MAESTRA con que se cifró, no del secreto. Una huella del
  -- secreto sería un oráculo para comprobar conjeturas; la de la llave solo
  -- sirve para saber que un sobre viejo ya no se puede abrir.
  llave_id        TEXT NOT NULL CHECK (length(llave_id) BETWEEN 1 AND 64),
  puesta_por      TEXT NOT NULL CHECK (length(trim(puesta_por)) > 0),
  puesta_en       INTEGER NOT NULL,
  PRIMARY KEY (pasarela, modo, credencial),
  -- Dos filas con el mismo criptograma no pasan nunca por casualidad: cada
  -- cifrado lleva su propio nonce al azar, así que dos sobres del MISMO secreto
  -- salen distintos. Si dos filas coincidieran es porque alguien copió el texto
  -- de una a otra, y eso es exactamente el intento de usar la credencial de
  -- prueba en el modo real. El cifrado ya lo impide (va atado a su sitio); esto
  -- lo deja además imposible de escribir.
  UNIQUE (secreto_cifrado)
) STRICT;

-- Una credencial SÍ se puede quitar, y conviene que se pueda.
--
-- La tentación era prohibir el DELETE, como en la bitácora. Es al revés: «ya no
-- uso PayPal, quíteme la clave» es una petición de seguridad, y un sistema que
-- no la puede cumplir se queda con un secreto descifrable para siempre. Lo que
-- no se puede borrar es el LIBRO: la línea que cuenta que se quitó, y quién.
-- Por eso quitar una credencial pasa por `quitarCredencial` en
-- `src/db/pasarelas.ts`, que borra la fila y escribe la línea en el mismo lote.
--
-- Una credencial no se muda. Las tres columnas de la llave son la IDENTIDAD de la
-- credencial: cambiarlas con un UPDATE sería mover el secreto de Yappy al sitio
-- de PayPal, o el de prueba al de real, conservando la firma de quien puso otra
-- cosa.
CREATE TRIGGER IF NOT EXISTS pasarela_credencial_no_se_muda
BEFORE UPDATE ON pasarela_credenciales
WHEN NEW.pasarela <> OLD.pasarela OR NEW.modo <> OLD.modo OR NEW.credencial <> OLD.credencial
BEGIN
  SELECT RAISE(ABORT, 'esta credencial no se pasa a otra pasarela ni a otro modo');
END;

-- Cada reescritura sube exactamente una versión. Esto es el candado contra el
-- cambio perdido, y es el que de verdad trabaja: dos personas que ponen la
-- misma credencial a la vez leen la versión 1 y las dos escriben la 2; la
-- primera entra, y la segunda llega con NEW.version = 2 sobre una fila que ya
-- está en 2, así que 2 <> 3 y el lote entero se cae. La segunda recibe un
-- conflicto y vuelve a intentarlo sobre lo que hay, en vez de pisar en
-- silencio la credencial que acaba de entrar.
CREATE TRIGGER IF NOT EXISTS pasarela_credencial_sube_de_version
BEFORE UPDATE ON pasarela_credenciales
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'otra persona cambió esta credencial: vuelva a abrirla antes de guardar');
END;

-- ---------------------------------------------------------------------------
-- El libro
-- ---------------------------------------------------------------------------
-- Lo que contesta «¿quién cambió la clave de Yappy, cuándo y por qué?». Se
-- escribe en el MISMO lote que el cambio que cuenta, así que no puede haber un
-- cambio sin su línea.
--
-- **Aquí no entra ningún valor, y la forma de la tabla es la garantía**: no hay
-- una columna donde cupiera. Lo que se guarda es «se cambió la clave secreta de
-- Yappy, modo prueba, versión 2» — nunca la clave. `motivo` lo escribe una
-- persona y está acotado a 500 caracteres, como el de `ajustes`: un motivo es
-- una frase, no un sitio donde pegar media pantalla.
CREATE TABLE IF NOT EXISTS pasarela_bitacora (
  id         TEXT PRIMARY KEY,
  pasarela   TEXT NOT NULL REFERENCES pasarelas(pasarela),
  accion     TEXT NOT NULL CHECK (
               accion IN ('credencial_puesta','credencial_cambiada',
                          'credencial_quitada','modo_cambiado')
             ),
  -- El modo al que se refiere la línea: el de la credencial, o el modo nuevo.
  modo       TEXT NOT NULL CHECK (modo IN ('prueba','real')),
  credencial TEXT,
  -- La versión que quedó en el baúl tras este cambio.
  version    INTEGER CHECK (version IS NULL OR version > 0),
  llave_id   TEXT,
  actor      TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  motivo     TEXT NOT NULL CHECK (length(trim(motivo)) > 0 AND length(motivo) <= 500),
  creado_en  INTEGER NOT NULL,
  -- Una línea de credencial dice CUÁL; una de modo no nombra ninguna. Sin esto
  -- caben líneas que no se pueden leer: «se cambió una credencial de Yappy»
  -- sin decir cuál no contesta nada.
  CHECK ((credencial IS NULL) = (accion = 'modo_cambiado')),
  -- La versión y la huella de la llave son del secreto que QUEDÓ guardado, así
  -- que una línea de «se quitó» no las lleva: no quedó ninguno. Escribirlas
  -- igual haría creer que todavía hay algo en el baúl.
  CHECK ((version IS NULL) = (accion IN ('modo_cambiado','credencial_quitada'))),
  CHECK ((llave_id IS NULL) = (accion IN ('modo_cambiado','credencial_quitada')))
) STRICT;

CREATE TRIGGER IF NOT EXISTS pasarela_bitacora_no_se_edita
BEFORE UPDATE ON pasarela_bitacora
BEGIN
  SELECT RAISE(ABORT, 'el libro de las pasarelas no se edita');
END;

CREATE TRIGGER IF NOT EXISTS pasarela_bitacora_no_se_borra
BEFORE DELETE ON pasarela_bitacora
BEGIN
  SELECT RAISE(ABORT, 'el libro de las pasarelas no se borra');
END;

-- La consulta de la pantalla: las últimas líneas, por pasarela y por fecha.
CREATE INDEX IF NOT EXISTS pasarela_bitacora_por_fecha
  ON pasarela_bitacora (creado_en);
CREATE INDEX IF NOT EXISTS pasarela_bitacora_por_pasarela
  ON pasarela_bitacora (pasarela, creado_en);
