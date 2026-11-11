-- 0009_entregas.sql · De la bodega a la puerta (F4.5)
--
-- Hasta aquí el sistema sabía recibir un pedido y cobrarlo a mano. Lo que
-- faltaba es el tramo final: quién lo lleva, en qué orden, a qué hora llegó y
-- qué se cobró en la puerta.
--
-- Tres tablas, de 02-datos.md §5, más una que el documento no nombra:
--
--   rutas         la tanda del día de UN motorizado. No está en 02-datos §5
--                 porque allí el orden vivía suelto en `envios.orden_ruta`, y
--                 un orden sin dueño no se puede despachar, ni cerrar, ni
--                 contar: «¿salió la ruta?» no tiene respuesta si la ruta no
--                 es una fila. El origen desde el que se midió el orden
--                 también necesitaba un sitio.
--   envios        LA PARADA. No hay una tabla `paradas` aparte a propósito: un
--                 envío ya es «este pedido, a esta dirección, con este
--                 motorizado». Dos tablas para eso serían dos dueños del mismo
--                 dato y la pregunta de cuál manda.
--   envio_eventos la bitácora. Es un libro: se escribe y no se toca.
--
-- ## Lo que estas tablas hacen IMPOSIBLE
--
-- No «improbable con cuidado». Cada una de estas es un CHECK o un trigger, y
-- cada una existe porque sin ella el sistema podría escribir algo que nadie
-- puede deshacer:
--
--   * que un envío entregado deje de estarlo (un «entregado» que vuelve a «en
--     ruta» deja a la clienta mirando una mentira, y el stock ya salió);
--   * que se marque entregada una parada de una ruta que no salió de la bodega;
--   * que una parada en la calle se mueva a otra ruta (reescribe quién la
--     llevó);
--   * que el motorizado de una parada no sea el de su ruta (el panel diría una
--     cosa y el teléfono del motorizado otra);
--   * que haya dinero cobrado sin decir cómo, o sin entrega que lo explique;
--   * que una ruta salga vacía, o se cierre con paradas todavía en la calle;
--   * que un pedido tenga dos envíos vivos a la vez (y se descargue dos veces
--     del inventario);
--   * que la bitácora de una entrega se edite o se borre.
--
-- Lo que NO se hace aquí: repetir la máquina de estados de
-- `src/dominio/estado-envio.ts` en SQL. Esa tabla de transiciones tiene un solo
-- dueño y es el dominio, que es quien la prueba. De los triggers de abajo solo
-- uno toca estados, y toca lo único que no se puede deshacer: salir de un
-- estado terminal.

-- ---------------------------------------------------------------------------
-- La tanda del día
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rutas (
  id            TEXT PRIMARY KEY,
  -- 'YYYY-MM-DD' en hora de Panamá (UTC−5, sin horario de verano). El día es
  -- el de aquí: con la fecha en UTC, todo lo que se entrega después de las 7
  -- de la noche contaría como del día siguiente.
  fecha         TEXT NOT NULL,
  motorizado_id TEXT NOT NULL REFERENCES motorizados(id),
  -- De dónde sale. Es la bodega donde carga, y por eso es también el origen
  -- natural con el que se mide el orden de las paradas.
  bodega_id     TEXT NOT NULL REFERENCES bodegas(id),
  estado        TEXT NOT NULL CHECK (estado IN ('borrador','en_curso','cerrada','cancelada')),
  -- El punto desde el que se midió el orden propuesto, y los kilómetros que
  -- medía. Se guardan porque un orden solo se puede explicar —o rehacer—
  -- sabiendo desde dónde se midió: `proponerRuta` no es un servicio de rutas
  -- y el panel tiene que poder decir cuánto prometió ahorrar.
  origen_lat    REAL,
  origen_lng    REAL,
  km_propuestos REAL,
  salio_en      INTEGER,
  cerrada_en    INTEGER,
  creada_por    TEXT NOT NULL,
  creada_en     INTEGER NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  -- Una ruta que salió tiene hora de salida. Sin esto, «en_curso» sin hora
  -- deja sin saber desde cuándo lleva alguien la mercancía encima, que es la
  -- única pregunta que importa cuando una entrega se atrasa.
  CHECK (estado NOT IN ('en_curso','cerrada') OR salio_en IS NOT NULL),
  CHECK (estado <> 'cerrada' OR cerrada_en IS NOT NULL),
  -- Las dos coordenadas o ninguna: media coordenada apunta al golfo.
  CHECK ((origen_lat IS NULL) = (origen_lng IS NULL))
) STRICT;

-- Un motorizado tiene UNA ruta por día. Si tuviera dos, su lista del día
-- estaría partida en dos pantallas y él solo miraría una. Las canceladas no
-- estorban: de eso se trata cancelar.
CREATE UNIQUE INDEX IF NOT EXISTS rutas_una_por_dia
  ON rutas (motorizado_id, fecha) WHERE estado <> 'cancelada';

CREATE INDEX IF NOT EXISTS rutas_del_dia ON rutas (fecha, estado);

-- ---------------------------------------------------------------------------
-- La parada
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envios (
  id              TEXT PRIMARY KEY,
  pedido_id       TEXT NOT NULL REFERENCES pedidos(id),
  estado          TEXT NOT NULL CHECK (estado IN ('pendiente','asignado','recogido','en_ruta',
                    'entregado','fallido','devuelto','anulado')),
  metodo          TEXT NOT NULL CHECK (metodo IN ('motorizado','ferguson','otro')),
  motorizado_id   TEXT REFERENCES motorizados(id),
  bodega_id       TEXT NOT NULL REFERENCES bodegas(id),
  -- 256 bits, para el QR de la guía. No es un ULID: sale impreso en un papel
  -- que viaja, y un ULID dice cuándo se creó y se puede ir probando el de al
  -- lado (ver `token()` en src/ids.ts).
  guia_token      TEXT NOT NULL UNIQUE,
  ruta_id         TEXT REFERENCES rutas(id),
  orden_ruta      INTEGER,
  programado_para TEXT,                        -- 'YYYY-MM-DD' Panamá
  -- De `ajustes.ventanas_entrega`, que vale PENDIENTE hasta que la dueña
  -- decida sus horarios. Texto libre y no un CHECK: cerrar la lista ahora
  -- sería inventarle las ventanas.
  ventana         TEXT,
  -- El saldo que había que cobrar en la puerta. Es una FOTO, no la verdad: la
  -- verdad del saldo es `pedidos.total_cents - pedidos.pagado_cents` y se
  -- vuelve a leer en el momento de entregar. Esta columna dice lo que se le
  -- pidió cobrar al motorizado, que es otra cosa y también hace falta.
  cobro_cents     INTEGER NOT NULL DEFAULT 0 CHECK (cobro_cents >= 0),
  cobrado_cents   INTEGER NOT NULL DEFAULT 0 CHECK (cobrado_cents >= 0),
  cobro_metodo    TEXT CHECK (cobro_metodo IN ('efectivo','yappy','otro')),
  -- La prueba de entrega, en el R2 privado. La llave foránea a `archivos` es
  -- lo que impide que apunte a un archivo que nadie registró — y también que
  -- el barrido se lleve la prueba de una entrega: el DELETE del barrido choca
  -- con esta llave, que es exactamente lo que se quiere de un libro.
  foto_r2         TEXT REFERENCES archivos(r2_key),
  guia_externa    TEXT,                        -- número de guía de Ferguson
  version         INTEGER NOT NULL DEFAULT 1,
  creado_en       INTEGER NOT NULL,
  entregado_en    INTEGER,
  -- Un «entregado» sin hora no sirve de constancia: la pregunta que se le hace
  -- a una entrega, meses después, es a qué hora llegó.
  CHECK (estado <> 'entregado' OR entregado_en IS NOT NULL),
  -- No se cobra más de lo que se pidió cobrar.
  CHECK (cobrado_cents <= cobro_cents),
  -- Dinero sin decir cómo entró es dinero que no se puede conciliar.
  CHECK (cobrado_cents = 0 OR cobro_metodo IS NOT NULL),
  -- Y dinero cobrado en una parada que no se entregó es dinero sin explicación.
  CHECK (cobrado_cents = 0 OR estado = 'entregado'),
  -- En una ruta y sin orden es una parada que no sale en ninguna lista; con
  -- orden y sin ruta es un orden que no ordena nada. O las dos, o ninguna.
  CHECK ((ruta_id IS NULL) = (orden_ruta IS NULL)),
  CHECK (orden_ruta IS NULL OR orden_ruta > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS envios_por_pedido ON envios (pedido_id);
CREATE INDEX IF NOT EXISTS envios_por_ruta ON envios (ruta_id, orden_ruta);
CREATE INDEX IF NOT EXISTS envios_del_dia ON envios (programado_para, estado);

-- Dos paradas con el mismo número de orden en la misma ruta dejan el recorrido
-- sin decidir justo donde se cree que ya está decidido.
CREATE UNIQUE INDEX IF NOT EXISTS envios_orden_en_ruta
  ON envios (ruta_id, orden_ruta) WHERE ruta_id IS NOT NULL;

-- UN envío vivo por pedido.
--
-- Esto es lo que hace segura la descarga de inventario al entregar: la entrega
-- descarga lo que `pedido_linea_componentes` dice que se apartó para el pedido
-- ENTERO, así que con dos envíos vivos a la vez se descargaría dos veces y la
-- segunda dejaría el físico por debajo de la realidad.
--
-- Los terminales no estorban: un pedido con un envío devuelto puede volver a
-- despacharse, y entonces es un envío nuevo con su guía y su token.
CREATE UNIQUE INDEX IF NOT EXISTS envios_uno_vivo_por_pedido
  ON envios (pedido_id) WHERE estado NOT IN ('entregado','devuelto','anulado');

-- ---------------------------------------------------------------------------
-- La bitácora
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envio_eventos (
  id        TEXT PRIMARY KEY,
  envio_id  TEXT NOT NULL REFERENCES envios(id),
  de        TEXT CHECK (de IS NULL OR de IN ('pendiente','asignado','recogido','en_ruta',
                'entregado','fallido','devuelto','anulado')),
  a         TEXT NOT NULL CHECK (a IN ('pendiente','asignado','recogido','en_ruta',
                'entregado','fallido','devuelto','anulado')),
  actor     TEXT NOT NULL,
  nota      TEXT,
  -- Dónde estaba quien lo marcó. Es la parte de la constancia que no se puede
  -- rehacer después: la hora se puede deducir, el sitio no.
  lat       REAL,
  lng       REAL,
  creado_en INTEGER NOT NULL,
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS envio_eventos_por_envio ON envio_eventos (envio_id, creado_en);

-- Los libros no se editan ni se borran (02-datos §1). Esta es la que explica
-- por qué una entrega está donde está, y quién la movió.
CREATE TRIGGER IF NOT EXISTS envio_eventos_no_se_edita
BEFORE UPDATE ON envio_eventos
BEGIN
  SELECT RAISE(ABORT, 'la bitácora de una entrega no se edita');
END;

CREATE TRIGGER IF NOT EXISTS envio_eventos_no_se_borra
BEFORE DELETE ON envio_eventos
BEGIN
  SELECT RAISE(ABORT, 'la bitácora de una entrega no se borra');
END;

-- ---------------------------------------------------------------------------
-- Lo imposible
-- ---------------------------------------------------------------------------

-- 1. De «entregado», «devuelto» o «anulado» no se vuelve.
--
-- Es la única parte de la máquina de estados que se repite en SQL, y se repite
-- porque es la única que no se puede deshacer: al entregar sale el stock, entra
-- el cobro y la clienta recibe su aviso. Volver atrás no desanda nada de eso,
-- solo hace que la base deje de coincidir con el mundo. Coincide con
-- `TRANSICIONES` de src/dominio/estado-envio.ts, donde los tres terminales no
-- tienen salida.
CREATE TRIGGER IF NOT EXISTS envio_terminal_no_vuelve
BEFORE UPDATE OF estado ON envios
WHEN OLD.estado IN ('entregado','devuelto','anulado') AND NEW.estado <> OLD.estado
BEGIN
  SELECT RAISE(ABORT, 'un envío entregado, devuelto o anulado no cambia de estado');
END;

-- 2. No se marca en la calle una parada de una ruta que no salió.
--
-- El caso real: alguien toca «entregado» en el panel por una parada que todavía
-- está en la bodega, y el sistema descarga stock de mercancía que no se movió.
-- Un envío sin ruta (Ferguson, una entrega suelta) queda fuera a propósito: ahí
-- no hay ruta que pueda estar sin salir.
CREATE TRIGGER IF NOT EXISTS envio_no_se_mueve_sin_salir_la_ruta
BEFORE UPDATE OF estado ON envios
WHEN NEW.estado IN ('recogido','en_ruta','entregado')
 AND NEW.ruta_id IS NOT NULL
 AND (SELECT estado FROM rutas WHERE id = NEW.ruta_id) IN ('borrador','cancelada')
BEGIN
  SELECT RAISE(ABORT, 'esta ruta no ha salido de la bodega');
END;

-- 3. Una parada que ya salió no se cambia de ruta.
--
-- Moverla reescribiría quién la llevó, y eso es justo lo que la entrega de
-- ayer tiene que seguir diciendo. Las que todavía no salieron sí se mueven:
-- repartir la carga antes de salir es trabajo normal de quien despacha.
CREATE TRIGGER IF NOT EXISTS envio_en_la_calle_no_cambia_de_ruta
BEFORE UPDATE OF ruta_id ON envios
WHEN NEW.ruta_id IS NOT OLD.ruta_id
 AND OLD.estado NOT IN ('pendiente','asignado')
BEGIN
  SELECT RAISE(ABORT, 'esta parada ya salió: no se cambia de ruta');
END;

-- 4. Una ruta cerrada o cancelada no recibe paradas nuevas.
CREATE TRIGGER IF NOT EXISTS ruta_cerrada_no_recibe_paradas
BEFORE UPDATE OF ruta_id ON envios
WHEN NEW.ruta_id IS NOT NULL
 AND NEW.ruta_id IS NOT OLD.ruta_id
 AND (SELECT estado FROM rutas WHERE id = NEW.ruta_id) IN ('cerrada','cancelada')
BEGIN
  SELECT RAISE(ABORT, 'esa ruta ya está cerrada');
END;

-- 5. El motorizado de una parada es el de su ruta. Los dos triggers, porque la
--    columna se puede escribir al insertar y al actualizar.
--
-- `envios.motorizado_id` existe porque un envío puede ir asignado sin ruta
-- (02-datos §5 lo pide así), pero cuando hay ruta el dueño del dato es la
-- ruta. Sin esto, el panel puede decir que la lleva Luis y la lista del
-- teléfono de Pedro mostrarla igual.
CREATE TRIGGER IF NOT EXISTS envio_con_el_motorizado_de_su_ruta_al_insertar
BEFORE INSERT ON envios
WHEN NEW.ruta_id IS NOT NULL
 AND NEW.motorizado_id IS NOT (SELECT motorizado_id FROM rutas WHERE id = NEW.ruta_id)
BEGIN
  SELECT RAISE(ABORT, 'la parada tiene que llevar el motorizado de su ruta');
END;

CREATE TRIGGER IF NOT EXISTS envio_con_el_motorizado_de_su_ruta
BEFORE UPDATE OF ruta_id, motorizado_id ON envios
WHEN NEW.ruta_id IS NOT NULL
 AND NEW.motorizado_id IS NOT (SELECT motorizado_id FROM rutas WHERE id = NEW.ruta_id)
BEGIN
  SELECT RAISE(ABORT, 'la parada tiene que llevar el motorizado de su ruta');
END;

-- 6. Y la ruta no cambia de motorizado si ya tiene paradas.
--
-- Si la moto se daña a media mañana, lo que corresponde no es reescribir la
-- ruta: las paradas que ya se entregaron las entregó quien las entregó. Se
-- mueven las que no han salido a una ruta nueva (el trigger 3 deja mover
-- exactamente esas) y esta se cierra.
CREATE TRIGGER IF NOT EXISTS ruta_con_paradas_no_cambia_de_motorizado
BEFORE UPDATE OF motorizado_id ON rutas
WHEN NEW.motorizado_id <> OLD.motorizado_id
 AND EXISTS (SELECT 1 FROM envios WHERE ruta_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'esta ruta ya tiene paradas: quítelas antes de cambiar el motorizado');
END;

-- 7. Una ruta no sale vacía. Es un motorizado dando un paseo, y un km que
--    alguien va a tener que explicar.
CREATE TRIGGER IF NOT EXISTS ruta_no_sale_vacia
BEFORE UPDATE OF estado ON rutas
WHEN NEW.estado = 'en_curso' AND OLD.estado = 'borrador'
 AND NOT EXISTS (SELECT 1 FROM envios WHERE ruta_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'esta ruta no tiene paradas');
END;

-- 8. Y no se cierra con paradas todavía en la calle.
--
-- Cerrar es decir «el día terminó». Si queda una parada sin marcar, el día no
-- terminó: queda una caja en una moto y nadie esperándola en ninguna pantalla.
CREATE TRIGGER IF NOT EXISTS ruta_no_se_cierra_con_paradas_abiertas
BEFORE UPDATE OF estado ON rutas
WHEN NEW.estado = 'cerrada'
 AND EXISTS (SELECT 1 FROM envios WHERE ruta_id = OLD.id
              AND estado NOT IN ('entregado','fallido','devuelto','anulado'))
BEGIN
  SELECT RAISE(ABORT, 'quedan paradas sin marcar: esta ruta no se puede cerrar');
END;
