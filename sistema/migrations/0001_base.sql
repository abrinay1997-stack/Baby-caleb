-- 0001_base.sql · Esquema de partida de babycaleb-db
--
-- Alcance (F2.2 de docs/plan/09-fases.md): catálogo, inventario, clientes,
-- envíos SIN pedidos, sistema y controles. Las tablas que llevan llave foránea
-- a `pedidos` (reservas, envios, envio_eventos, pagos…) nacen en F4a; las de
-- contabilidad en F5; las del asistente en F6.
--
-- Convenciones (docs/plan/02-datos.md §1):
--   · ids TEXT con ULID            · dinero INTEGER en centavos (*_cents)
--   · tiempo INTEGER en ms UTC     · fechas contables TEXT 'YYYY-MM-DD' (Panamá, UTC-5)
--   · booleanos INTEGER 0/1        · todas las tablas STRICT
--   · los libros no se editan: triggers que abortan UPDATE y DELETE
--
-- Orden: por dependencias, no por tema.

-- ---------------------------------------------------------------------------
-- Controles · cómo se garantiza una condición sin transacciones interactivas
-- ---------------------------------------------------------------------------
-- D1 no tiene transacciones interactivas. db.batch() es todo o nada, pero un
-- UPDATE que no encuentra su fila cambia cero filas y el batch sigue. Para que
-- la condición tumbe el batch se inserta después una fila cuya restricción
-- solo se cumple si el cambio ocurrió. SELECT RAISE() no sirve fuera de un
-- trigger; esta fila sí. Se purga cada día.
CREATE TABLE controles (
  id        TEXT PRIMARY KEY,
  regla     TEXT NOT NULL,
  ok        INTEGER NOT NULL CHECK (ok = 1),
  creado_en INTEGER NOT NULL
) STRICT;

CREATE TABLE secuencias (
  nombre TEXT PRIMARY KEY,
  valor  INTEGER NOT NULL
) STRICT;
INSERT INTO secuencias (nombre, valor) VALUES ('pedido', 0), ('compra', 0);

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
CREATE TABLE productos (
  id        TEXT PRIMARY KEY,
  familia   TEXT NOT NULL,                -- 'panal' | 'pants' | 'wipes' | 'portabebe'
  nombre    TEXT NOT NULL,                -- «Pañal Nateen»
  slug      TEXT NOT NULL UNIQUE,         -- para /productos/:slug
  marca     TEXT,
  activo    INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  orden     INTEGER NOT NULL DEFAULT 0,
  creado_en INTEGER NOT NULL
) STRICT;

-- El costo NUNCA está aquí: vive en valor_inventario y solo lo leen gerencia y
-- contabilidad. Así una consulta del bot o de la web no puede traerlo por error.
CREATE TABLE variantes (
  codigo            TEXT PRIMARY KEY,              -- NAT-M, NAT-P-XL, WIPESNAT, DANY-AW600, MOON-FUL
  producto_id       TEXT NOT NULL REFERENCES productos(id),
  nombre            TEXT NOT NULL,                 -- lo que repite el bot, completo
  talla             TEXT,                          -- RN, S, M, L, XL, XXL; NULL si no aplica
  peso_min_lb       REAL,
  peso_max_lb       REAL,
  unidades_por_caja INTEGER NOT NULL CHECK (unidades_por_caja > 0),
  precio_cents      INTEGER NOT NULL CHECK (precio_cents > 0),
  tasa_itbms_bp     INTEGER,                       -- puntos básicos (700 = 7 %). NULL = PENDIENTE
  publicado         INTEGER NOT NULL DEFAULT 0 CHECK (publicado IN (0,1)),
  activo            INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  siguiente_codigo  TEXT REFERENCES variantes(codigo),  -- talla siguiente, para la recompra
  imagen            TEXT,                          -- ruta pública en la web (/img/…)
  version           INTEGER NOT NULL DEFAULT 1,
  actualizado_en    INTEGER NOT NULL
) STRICT;

CREATE TABLE precios_historial (
  id            TEXT PRIMARY KEY,
  codigo        TEXT NOT NULL REFERENCES variantes(codigo),
  precio_cents  INTEGER NOT NULL,
  vigente_desde INTEGER NOT NULL,
  cambiado_por  TEXT NOT NULL,
  motivo        TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- Inventario
-- ---------------------------------------------------------------------------
CREATE TABLE bodegas (
  id     TEXT PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1))
) STRICT;

-- Disponible = fisico - reservado. Una fila por (variante, bodega).
CREATE TABLE existencias (
  codigo    TEXT NOT NULL REFERENCES variantes(codigo),
  bodega_id TEXT NOT NULL REFERENCES bodegas(id),
  fisico    INTEGER NOT NULL DEFAULT 0 CHECK (fisico >= 0),
  reservado INTEGER NOT NULL DEFAULT 0 CHECK (reservado >= 0),
  minimo    INTEGER,                              -- umbral de alerta; NULL = sin alerta
  CHECK (reservado <= fisico),
  PRIMARY KEY (codigo, bodega_id)
) STRICT;

CREATE TABLE movimientos_inventario (
  id               TEXT PRIMARY KEY,
  codigo           TEXT NOT NULL,
  bodega_id        TEXT NOT NULL,
  delta            INTEGER NOT NULL CHECK (delta <> 0),
  tipo             TEXT NOT NULL CHECK (tipo IN ('apertura','compra','venta','devolucion','ajuste',
                      'merma','muestra','regalo','traslado_salida','traslado_entrada','conteo')),
  costo_unit_cents INTEGER,                       -- costo con que entra o sale (para el asiento)
  referencia_tipo  TEXT,                          -- 'pedido' | 'compra' | 'traslado' | 'conteo' …
  referencia_id    TEXT,
  motivo           TEXT,                          -- obligatorio en ajuste, merma, muestra, regalo y conteo
  actor            TEXT NOT NULL,                 -- usuario, 'crm:telegram' o 'sistema'
  revierte_id      TEXT REFERENCES movimientos_inventario(id),
  creado_en        INTEGER NOT NULL,
  FOREIGN KEY (codigo, bodega_id) REFERENCES existencias(codigo, bodega_id),
  CHECK (tipo NOT IN ('ajuste','merma','muestra','regalo','conteo') OR motivo IS NOT NULL)
) STRICT;

CREATE TRIGGER movimientos_inventario_no_se_edita BEFORE UPDATE ON movimientos_inventario
BEGIN SELECT RAISE(ABORT, 'movimientos_inventario no se edita: registre un movimiento contrario'); END;
CREATE TRIGGER movimientos_inventario_no_se_borra BEFORE DELETE ON movimientos_inventario
BEGIN SELECT RAISE(ABORT, 'movimientos_inventario no se borra'); END;

-- Costo promedio ponderado por variante = valor_cents / unidades (ver 05-contabilidad §4).
CREATE TABLE valor_inventario (
  codigo      TEXT PRIMARY KEY REFERENCES variantes(codigo),
  unidades    INTEGER NOT NULL CHECK (unidades >= 0),
  valor_cents INTEGER NOT NULL CHECK (valor_cents >= 0)
) STRICT;

-- Un traslado son dos movimientos (salida al enviar, entrada al recibir);
-- mientras viaja no cuenta en ninguna bodega.
CREATE TABLE traslados (
  id          TEXT PRIMARY KEY,
  desde_id    TEXT NOT NULL REFERENCES bodegas(id),
  hacia_id    TEXT NOT NULL REFERENCES bodegas(id),
  estado      TEXT NOT NULL CHECK (estado IN ('en_camino','recibido','anulado')),
  creado_por  TEXT NOT NULL,
  creado_en   INTEGER NOT NULL,
  recibido_en INTEGER,
  CHECK (desde_id <> hacia_id)
) STRICT;

CREATE TABLE traslado_lineas (
  traslado_id TEXT NOT NULL REFERENCES traslados(id),
  codigo      TEXT NOT NULL REFERENCES variantes(codigo),
  cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
  PRIMARY KEY (traslado_id, codigo)
) STRICT;

CREATE TABLE conteos (
  id          TEXT PRIMARY KEY,
  bodega_id   TEXT NOT NULL REFERENCES bodegas(id),
  estado      TEXT NOT NULL CHECK (estado IN ('abierto','aplicado','anulado')),
  creado_por  TEXT NOT NULL,
  creado_en   INTEGER NOT NULL,
  aplicado_en INTEGER
) STRICT;

CREATE TABLE conteo_lineas (
  conteo_id TEXT NOT NULL REFERENCES conteos(id),
  codigo    TEXT NOT NULL,
  contado   INTEGER NOT NULL CHECK (contado >= 0),
  sistema   INTEGER NOT NULL,
  PRIMARY KEY (conteo_id, codigo)
) STRICT;

-- ---------------------------------------------------------------------------
-- Envíos · zonas y motorizados (envios y envio_eventos nacen en F4a: llevan
-- llave foránea a pedidos). zonas_envio va antes que direcciones.
-- ---------------------------------------------------------------------------
CREATE TABLE zonas_envio (
  id                  TEXT PRIMARY KEY,
  nombre              TEXT NOT NULL UNIQUE,         -- «Tocumen»
  alias_json          TEXT NOT NULL DEFAULT '[]',   -- otras formas de escribirla
  region              TEXT NOT NULL CHECK (region IN ('ciudad','interior')),
  metodo              TEXT NOT NULL CHECK (metodo IN ('motorizado','ferguson','otro')),
  tarifa_cents        INTEGER,                      -- NULL = se cotiza a mano (interior)
  requiere_pago_total INTEGER NOT NULL DEFAULT 0 CHECK (requiere_pago_total IN (0,1)),
  bodega_preferida_id TEXT REFERENCES bodegas(id),
  activa              INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  actualizado_en      INTEGER NOT NULL
) STRICT;

CREATE TABLE motorizados (
  id              TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL,
  celular_e164    TEXT NOT NULL UNIQUE,
  estado          TEXT NOT NULL CHECK (estado IN ('activo','pausa','inactivo')),
  vehiculo        TEXT CHECK (vehiculo IN ('moto','auto','bicicleta','a_pie')),
  pin_hash        TEXT,                             -- PBKDF2-SHA256 + sal + pepper
  pin_fallos      INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta INTEGER,
  pago_regla_json TEXT,                             -- cómo se le paga: PENDIENTE de la dueña
  creado_en       INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Clientes
-- ---------------------------------------------------------------------------
CREATE TABLE clientes (
  id                    TEXT PRIMARY KEY,
  nombre                TEXT,
  celular_e164          TEXT UNIQUE,               -- 5076XXXXXXX sin '+'. Opcional
  correo                TEXT,
  consentimiento_mkt    INTEGER NOT NULL DEFAULT 0 CHECK (consentimiento_mkt IN (0,1)),
  consentimiento_en     INTEGER,
  consentimiento_origen TEXT,                      -- 'web_checkout' | 'chat' | 'panel'
  fusionado_en_id       TEXT REFERENCES clientes(id),
  anonimizado_en        INTEGER,
  notas                 TEXT,
  creado_en             INTEGER NOT NULL,
  actualizado_en        INTEGER NOT NULL
) STRICT;

CREATE TABLE identidades (
  canal      TEXT NOT NULL CHECK (canal IN ('web','whatsapp_qr','whatsapp_cloud','instagram',
                'messenger','telegram','panel')),
  id_externo TEXT NOT NULL,                        -- celular, IGSID/PSID, chat_id…
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  creado_en  INTEGER NOT NULL,
  PRIMARY KEY (canal, id_externo)
) STRICT;

CREATE TABLE direcciones (
  id         TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  zona_id    TEXT NOT NULL REFERENCES zonas_envio(id),
  texto      TEXT NOT NULL,                        -- calle, casa o edificio, piso
  referencia TEXT,                                 -- «frente al súper»
  lat        REAL,
  lng        REAL,
  precision  TEXT CHECK (precision IN ('gps','pin','geocodificado','manual')),
  activa     INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  creado_en  INTEGER NOT NULL
) STRICT;

CREATE TABLE fusiones_cliente (
  id        TEXT PRIMARY KEY,
  de_id     TEXT NOT NULL,
  a_id      TEXT NOT NULL,
  motivo    TEXT NOT NULL,
  actor     TEXT NOT NULL,
  creado_en INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Sistema
-- ---------------------------------------------------------------------------
CREATE TABLE usuarios (
  id               TEXT PRIMARY KEY,
  correo           TEXT NOT NULL UNIQUE,           -- el de Cloudflare Access
  nombre           TEXT NOT NULL,
  rol              TEXT NOT NULL CHECK (rol IN ('duena','asistente','contadora')),
  telegram_chat_id TEXT UNIQUE,                    -- para el asistente por la consola del CRM
  activo           INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  creado_en        INTEGER NOT NULL
) STRICT;

-- Reglas con cifras, con historial. Valor vigente = la versión más alta con
-- vigente_desde <= ahora. Si no hay ninguna, el de sistema/reglas.json.
CREATE TABLE ajustes (
  clave         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  valor_json    TEXT NOT NULL,
  vigente_desde INTEGER NOT NULL,                  -- solo hacia adelante
  cambiado_por  TEXT NOT NULL,
  motivo        TEXT,
  PRIMARY KEY (clave, version)
) STRICT;

CREATE TABLE idempotencia (
  clave          TEXT PRIMARY KEY,
  ruta           TEXT NOT NULL,
  huella_entrada TEXT NOT NULL,
  respuesta_json TEXT,
  creado_en      INTEGER NOT NULL,
  vence_en       INTEGER NOT NULL
) STRICT;

-- Outbox: todo cambio de estado escribe su evento aquí dentro del mismo batch.
CREATE TABLE eventos_salida (
  id           TEXT PRIMARY KEY,
  cola         TEXT NOT NULL CHECK (cola IN ('bc-avisos','bc-tareas')),
  tipo         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  datos_json   TEXT NOT NULL,
  creado_en    INTEGER NOT NULL,
  publicado_en INTEGER,
  intentos     INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Las colas entregan al menos una vez: cada consumidor guarda el id y no repite.
CREATE TABLE eventos_recibidos (
  id           TEXT PRIMARY KEY,
  tipo         TEXT NOT NULL,
  procesado_en INTEGER NOT NULL
) STRICT;

CREATE TABLE archivos (
  r2_key             TEXT PRIMARY KEY,
  tipo               TEXT NOT NULL,
  mime               TEXT NOT NULL,
  bytes              INTEGER NOT NULL,
  sensible           INTEGER NOT NULL DEFAULT 1 CHECK (sensible IN (0,1)),
  subido_por         TEXT NOT NULL,
  referencia_tipo    TEXT,
  referencia_id      TEXT,
  borrar_despues_de  INTEGER,
  creado_en          INTEGER NOT NULL
) STRICT;

-- Motorizados y clientas. El equipo no usa sesiones: entra por Access.
CREATE TABLE sesiones (
  id          TEXT PRIMARY KEY,
  sujeto_tipo TEXT NOT NULL CHECK (sujeto_tipo IN ('motorizado','cliente')),
  sujeto_id   TEXT NOT NULL,
  creado_en   INTEGER NOT NULL,
  vence_en    INTEGER NOT NULL,
  revocada_en INTEGER
) STRICT;

CREATE TABLE codigos_acceso (
  celular_e164 TEXT NOT NULL,
  codigo_hash  TEXT NOT NULL,
  intentos     INTEGER NOT NULL DEFAULT 0,
  vence_en     INTEGER NOT NULL,
  usado_en     INTEGER,
  creado_en    INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Índices de las consultas calientes (solo los de las tablas de esta migración)
-- ---------------------------------------------------------------------------
CREATE INDEX movs_codigo_fecha    ON movimientos_inventario (codigo, creado_en);
CREATE INDEX outbox_pendientes    ON eventos_salida (publicado_en) WHERE publicado_en IS NULL;
CREATE INDEX identidades_cliente  ON identidades (cliente_id);
CREATE INDEX codigos_acceso_vence ON codigos_acceso (celular_e164, vence_en);
