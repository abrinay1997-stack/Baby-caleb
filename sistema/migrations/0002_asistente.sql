-- 0002_asistente.sql · El asistente del negocio
--
-- Alcance (F2.7 de docs/plan/09-fases.md): el registro de herramientas, la
-- política y la BITÁCORA. Las herramientas que escriben llegan después; estas
-- tablas nacen ahora porque la bitácora tiene que existir antes que la primera
-- herramienta, no después.
--
-- (La cabecera de 0001 decía «las del asistente en F6». La tabla de fases pone
-- `acciones` en F2.7, que es esta. Manda la tabla de fases.)
--
-- Las formas salen de docs/plan/06-asistente.md §8, literales. Lo que aquí se
-- añade son los triggers, que el documento describe en una línea de comentario
-- y que es donde de verdad se sostiene la regla.
--
-- Convenciones de 0001: ids TEXT con ULID, tiempo INTEGER en ms UTC, booleanos
-- INTEGER 0/1, todas STRICT, y los libros no se editan ni se borran.

-- ---------------------------------------------------------------------------
-- Conversaciones y mensajes
-- ---------------------------------------------------------------------------
-- Se borran solas a los 180 días sin actividad (06-asistente §8). Por eso la
-- bitácora NO lleva llave foránea hacia aquí: ver más abajo.

CREATE TABLE asistente_conversaciones (
  id         TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  canal      TEXT NOT NULL CHECK (canal IN ('panel','telegram','mcp')),
  titulo     TEXT,
  creado_en  INTEGER NOT NULL,
  ultima_en  INTEGER NOT NULL
) STRICT;

-- Para el barrido de los 180 días y para listar «mis conversaciones».
CREATE INDEX asistente_conversaciones_por_actividad ON asistente_conversaciones (ultima_en);
CREATE INDEX asistente_conversaciones_por_usuario ON asistente_conversaciones (usuario_id, ultima_en DESC);

CREATE TABLE asistente_mensajes (
  id             TEXT PRIMARY KEY,
  conversacion_id TEXT NOT NULL REFERENCES asistente_conversaciones(id) ON DELETE CASCADE,
  rol            TEXT NOT NULL CHECK (rol IN ('user','assistant','tool')),
  contenido_json TEXT NOT NULL,
  adjuntos_json  TEXT,
  creado_en      INTEGER NOT NULL
) STRICT;

CREATE INDEX asistente_mensajes_por_conversacion ON asistente_mensajes (conversacion_id, creado_en);

-- ---------------------------------------------------------------------------
-- acciones · la bitácora
-- ---------------------------------------------------------------------------
-- Cada ejecución de una herramienta deja una fila aquí: quién, por dónde, con
-- qué argumentos, qué salió y si había adjuntos o texto escrito por una
-- clienta. No se edita y no se borra.
--
-- `conversacion_id` NO lleva llave foránea a propósito: las conversaciones se
-- borran a los 180 días y la bitácora se conserva siempre (06-asistente §8).
-- Con una llave foránea, el barrido chocaría con la bitácora y habría que
-- elegir entre perder el rastro o no poder barrer.

CREATE TABLE acciones (
  id              TEXT PRIMARY KEY,
  herramienta     TEXT NOT NULL,
  nivel           TEXT NOT NULL CHECK (nivel IN ('lectura','construccion','sensible')),
  categoria       TEXT,
  canal           TEXT NOT NULL CHECK (canal IN ('panel','telegram','mcp')),
  usuario_id      TEXT NOT NULL REFERENCES usuarios(id),
  conversacion_id TEXT,
  argumentos_json TEXT NOT NULL,
  resultado_json  TEXT,
  error           TEXT,
  resumen         TEXT,
  estado          TEXT NOT NULL CHECK (estado IN
                    ('hecha','error','bloqueada','por_confirmar','rechazada','vencida')),
  con_adjuntos    INTEGER NOT NULL DEFAULT 0 CHECK (con_adjuntos IN (0,1)),
  texto_externo   INTEGER NOT NULL DEFAULT 0 CHECK (texto_externo IN (0,1)),
  creado_en       INTEGER NOT NULL,
  cerrada_en      INTEGER,
  -- Una acción cerrada tiene fecha de cierre; una que espera, no. Sin esto se
  -- puede marcar «hecha» sin decir cuándo, y la bitácora deja de servir para
  -- reconstruir qué pasó y en qué orden.
  CHECK ((estado = 'por_confirmar') = (cerrada_en IS NULL))
) STRICT;

CREATE INDEX acciones_por_usuario ON acciones (usuario_id, creado_en DESC);
-- Para vencer las que esperan: se buscan por estado y por antigüedad.
CREATE INDEX acciones_pendientes ON acciones (estado, creado_en) WHERE estado = 'por_confirmar';

-- La bitácora no se borra. Nunca, ni para «limpiar».
CREATE TRIGGER acciones_no_se_borra BEFORE DELETE ON acciones
BEGIN SELECT RAISE(ABORT, 'acciones no se borra: es la bitácora'); END;

-- Lo único que puede cambiar de una acción es su desenlace, y solo mientras
-- está esperando confirmación. Todo lo demás —quién, qué, con qué argumentos,
-- por dónde, cuándo— queda como se escribió.
--
-- Esto es además la idempotencia de las confirmaciones: confirmar dos veces no
-- la ejecuta dos veces, porque el segundo UPDATE encuentra la fila ya cerrada
-- y aborta. El id de la acción ES la llave de idempotencia (06-asistente §3).
CREATE TRIGGER acciones_solo_se_cierran_una_vez BEFORE UPDATE ON acciones
WHEN OLD.estado <> 'por_confirmar'
BEGIN SELECT RAISE(ABORT, 'esta acción ya está cerrada: no se vuelve a tocar'); END;

-- Y cerrarla significa cerrarla: un UPDATE no puede dejarla esperando otra vez,
-- porque entonces una acción sensible podría estirarse más allá de sus 30
-- minutos sin que nadie lo note.
CREATE TRIGGER acciones_cerrar_es_cerrar BEFORE UPDATE ON acciones
WHEN NEW.estado = 'por_confirmar'
BEGIN SELECT RAISE(ABORT, 'una acción que se actualiza tiene que quedar cerrada'); END;

-- `IS NOT` y no `<>`: con `<>`, dos NULL dan NULL (ni cierto ni falso) y el
-- trigger dejaría pasar un cambio de NULL a NULL... y también de NULL a algo.
CREATE TRIGGER acciones_lo_demas_no_se_edita BEFORE UPDATE ON acciones
WHEN OLD.id              IS NOT NEW.id
  OR OLD.herramienta     IS NOT NEW.herramienta
  OR OLD.nivel           IS NOT NEW.nivel
  OR OLD.categoria       IS NOT NEW.categoria
  OR OLD.canal           IS NOT NEW.canal
  OR OLD.usuario_id      IS NOT NEW.usuario_id
  OR OLD.conversacion_id IS NOT NEW.conversacion_id
  OR OLD.argumentos_json IS NOT NEW.argumentos_json
  OR OLD.resumen         IS NOT NEW.resumen
  OR OLD.con_adjuntos    IS NOT NEW.con_adjuntos
  OR OLD.texto_externo   IS NOT NEW.texto_externo
  OR OLD.creado_en       IS NOT NEW.creado_en
BEGIN SELECT RAISE(ABORT, 'de una acción solo cambian estado, resultado y cerrada_en'); END;

-- ---------------------------------------------------------------------------
-- asistente_uso · lo que cuesta
-- ---------------------------------------------------------------------------
-- El tope mensual se cuenta aquí, y lo cuenta EN MICRODÓLARES enteros: en
-- centavos, una llamada de $0.0006 redondea a cero y mil llamadas suman cero
-- (06-asistente §6). La consola del CRM también escribe aquí, para que el tope
-- sea uno solo y no dos.

CREATE TABLE asistente_uso (
  id              TEXT PRIMARY KEY,
  usuario_id      TEXT NOT NULL REFERENCES usuarios(id),
  canal           TEXT NOT NULL CHECK (canal IN ('panel','telegram','mcp')),
  modelo          TEXT NOT NULL,
  entrada         INTEGER NOT NULL CHECK (entrada >= 0),
  salida          INTEGER NOT NULL CHECK (salida >= 0),
  cache_leida     INTEGER NOT NULL DEFAULT 0 CHECK (cache_leida >= 0),
  cache_escrita   INTEGER NOT NULL DEFAULT 0 CHECK (cache_escrita >= 0),
  costo_micro_usd INTEGER NOT NULL CHECK (costo_micro_usd >= 0),
  mes             TEXT NOT NULL,                  -- 'YYYY-MM' en hora de Panamá
  creado_en       INTEGER NOT NULL
) STRICT;

-- El tope global del mes y el de cada persona: las dos consultas que se hacen
-- antes de CADA llamada al modelo, así que las dos van por índice.
CREATE INDEX asistente_uso_por_mes ON asistente_uso (mes);
CREATE INDEX asistente_uso_por_persona ON asistente_uso (mes, usuario_id);

-- Lo que se gastó tampoco se reescribe: si se corrige una tarifa, se anota
-- otra fila, no se cambia la vieja.
CREATE TRIGGER asistente_uso_no_se_edita BEFORE UPDATE ON asistente_uso
BEGIN SELECT RAISE(ABORT, 'asistente_uso no se edita: anote otra fila'); END;
CREATE TRIGGER asistente_uso_no_se_borra BEFORE DELETE ON asistente_uso
BEGIN SELECT RAISE(ABORT, 'asistente_uso no se borra'); END;

-- ---------------------------------------------------------------------------
-- Referencias de clientas · lo que el modelo puede ver de una persona
-- ---------------------------------------------------------------------------
-- Decisión D-20 (06-asistente §7): el modelo del asistente es un Contributor y
-- Meta entrena con lo que recibe. Las cifras del negocio sí van; los datos de
-- las CLIENTAS no, porque son terceras personas que no acordaron nada.
--
-- Así que hacia el modelo una clienta es «C-0042» y nada más. El panel o
-- Telegram ponen el nombre DESPUÉS, al mostrar la respuesta.
--
-- La referencia es estable y vive en la fila de la clienta —no es un apodo que
-- dura lo que la conversación— porque queda escrita en `acciones`, y una
-- bitácora que dentro de un año diga «C-7» sin poder decir quién era no sirve
-- para reconstruir nada.
ALTER TABLE clientes ADD COLUMN referencia INTEGER;
CREATE UNIQUE INDEX clientes_referencia_unica ON clientes (referencia) WHERE referencia IS NOT NULL;
