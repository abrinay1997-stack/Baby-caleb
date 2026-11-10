-- Pedidos y pagos (F4.1), de 02-datos.md §6 y §7.
--
-- `secuencias` e `idempotencia` ya venían en la 0001, así que aquí entran solo
-- las tablas nuevas. Lo que estas tablas tienen que impedir, con CHECK y no con
-- buenas intenciones:
--
--  * que un total no cuadre con sus partes;
--  * que se cobre más de lo que vale el pedido;
--  * que un pedido pase a un estado que no existe;
--  * que el mismo aviso de una pasarela se aplique dos veces.
--
-- Lo que un CHECK no puede impedir —que un pedido pase de `por_abonar` a
-- `agendado` sin haber cobrado el abono— va en F4.2, con el patrón de fila de
-- control que ya usa el inventario: una fila con CHECK que se inserta DESPUÉS
-- del UPDATE, en el mismo batch, y que revienta si el UPDATE no tocó nada.
-- D1 no tiene transacciones interactivas; esto es lo que hace sus veces.

CREATE TABLE IF NOT EXISTS pedidos (
  id                  TEXT PRIMARY KEY,
  -- Para hablar: «su pedido BC-000123». NUNCA para entrar: es adivinable.
  numero              TEXT NOT NULL UNIQUE,
  -- Para los enlaces públicos (seguimiento). 256 bits, no adivinable.
  token               TEXT NOT NULL UNIQUE,
  cliente_id          TEXT NOT NULL REFERENCES clientes(id),
  origen              TEXT NOT NULL CHECK (origen IN ('web','whatsapp','instagram','messenger','telegram','panel')),
  conversacion_ref    TEXT,
  estado              TEXT NOT NULL CHECK (estado IN ('por_abonar','agendado','en_ruta','entregado','cancelado','devuelto')),
  estado_pago         TEXT NOT NULL CHECK (estado_pago IN ('sin_pago','abonado','pagado','reembolso_parcial','reembolsado')),
  direccion_id        TEXT REFERENCES direcciones(id),
  zona_id             TEXT REFERENCES zonas_envio(id),
  subtotal_cents      INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  envio_cents         INTEGER NOT NULL DEFAULT 0 CHECK (envio_cents >= 0),
  descuento_cents     INTEGER NOT NULL DEFAULT 0 CHECK (descuento_cents >= 0),
  itbms_cents         INTEGER NOT NULL DEFAULT 0 CHECK (itbms_cents >= 0),
  total_cents         INTEGER NOT NULL,
  pagado_cents        INTEGER NOT NULL DEFAULT 0 CHECK (pagado_cents >= 0),
  -- Copiado de `ajustes` al crear, a propósito: si la dueña sube el abono
  -- mínimo el martes, el pedido del lunes se cierra con la regla del lunes.
  -- Una regla que cambia a mitad de un pedido es una discusión con la clienta.
  abono_minimo_cents  INTEGER NOT NULL,
  requiere_pago_total INTEGER NOT NULL DEFAULT 0 CHECK (requiere_pago_total IN (0,1)),
  vence_en            INTEGER,
  notas_cliente       TEXT,
  notas_internas      TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  creado_en           INTEGER NOT NULL,
  actualizado_en      INTEGER NOT NULL,
  -- El total no se guarda «a ver si cuadra»: tiene que cuadrar o no entra.
  CHECK (total_cents = subtotal_cents + envio_cents - descuento_cents + itbms_cents),
  -- Nadie puede haber pagado más de lo que vale el pedido. Un reembolso baja
  -- `pagado_cents`; un cobro de más es un error que hay que ver al escribirlo.
  CHECK (pagado_cents <= total_cents)
) STRICT;

CREATE INDEX IF NOT EXISTS pedidos_por_cliente ON pedidos (cliente_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS pedidos_por_estado ON pedidos (estado, creado_en DESC);
-- Los que están por vencer: el cron que libera reservas los busca así.
CREATE INDEX IF NOT EXISTS pedidos_por_vencer ON pedidos (vence_en) WHERE estado = 'por_abonar';

CREATE TABLE IF NOT EXISTS pedido_lineas (
  id                TEXT PRIMARY KEY,
  pedido_id         TEXT NOT NULL REFERENCES pedidos(id),
  codigo            TEXT NOT NULL REFERENCES variantes(codigo),
  -- Copia del nombre al momento de la venta. No es redundancia: si mañana se
  -- renombra la variante, el pedido de hoy tiene que seguir diciendo lo que la
  -- clienta compró.
  nombre            TEXT NOT NULL,
  cantidad          INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unit_cents INTEGER NOT NULL CHECK (precio_unit_cents >= 0),
  itbms_bp          INTEGER NOT NULL DEFAULT 0 CHECK (itbms_bp >= 0),
  -- Se fija AL ENTREGAR, con el costo promedio de ese momento. Nulo antes: no
  -- se sabe, y poner un cero sería afirmar que no costó nada.
  costo_unit_cents  INTEGER CHECK (costo_unit_cents IS NULL OR costo_unit_cents >= 0),
  bodega_id         TEXT NOT NULL REFERENCES bodegas(id)
) STRICT;

CREATE INDEX IF NOT EXISTS pedido_lineas_por_pedido ON pedido_lineas (pedido_id);

CREATE TABLE IF NOT EXISTS pedido_eventos (
  id         TEXT PRIMARY KEY,
  pedido_id  TEXT NOT NULL REFERENCES pedidos(id),
  tipo       TEXT NOT NULL,
  de         TEXT,
  a          TEXT,
  actor      TEXT NOT NULL,
  datos_json TEXT,
  creado_en  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS pedido_eventos_por_pedido ON pedido_eventos (pedido_id, creado_en);

-- La bitácora de un pedido no se edita ni se borra, como los movimientos de
-- inventario: es lo que explica por qué un pedido está donde está.
CREATE TRIGGER IF NOT EXISTS pedido_eventos_no_se_borra
BEFORE DELETE ON pedido_eventos
BEGIN
  SELECT RAISE(ABORT, 'la bitácora de un pedido no se borra');
END;

CREATE TRIGGER IF NOT EXISTS pedido_eventos_no_se_edita
BEFORE UPDATE ON pedido_eventos
BEGIN
  SELECT RAISE(ABORT, 'la bitácora de un pedido no se edita');
END;

CREATE TABLE IF NOT EXISTS pagos (
  id             TEXT PRIMARY KEY,
  pedido_id      TEXT NOT NULL REFERENCES pedidos(id),
  proveedor      TEXT NOT NULL CHECK (proveedor IN ('yappy','tilopay','paypal','manual')),
  metodo         TEXT NOT NULL,
  tipo           TEXT NOT NULL CHECK (tipo IN ('abono','total','saldo')),
  estado         TEXT NOT NULL CHECK (estado IN ('creado','esperando_cliente','confirmando','aprobado','rechazado','expirado','reembolsado','reembolso_parcial')),
  monto_cents    INTEGER NOT NULL CHECK (monto_cents > 0),
  -- Estimada al aprobar, real al liquidar. Nula mientras no se sepa.
  comision_cents INTEGER CHECK (comision_cents IS NULL OR comision_cents >= 0),
  proveedor_ref  TEXT,
  -- NUESTRO id hacia la pasarela. Único: es lo que impide que un reintento se
  -- cobre dos veces.
  intento_ref    TEXT NOT NULL UNIQUE,
  comprobante_r2 TEXT,
  confirmado_por TEXT,
  confirmado_en  INTEGER,
  -- La cuenta a la que entra el dinero llega con la contabilidad (F5.1). Se
  -- deja como columna SIN llave foránea porque `cuentas` todavía no existe, y
  -- SQLite no permite añadir una llave foránea con ALTER: la 0006 no puede
  -- apuntar a una tabla del futuro. F5.1 la crea y añade el índice que la
  -- vigila.
  cuenta_id      TEXT,
  creado_en      INTEGER NOT NULL,
  actualizado_en INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS pagos_por_pedido ON pagos (pedido_id, creado_en);
CREATE INDEX IF NOT EXISTS pagos_por_estado ON pagos (estado, creado_en DESC);

CREATE TABLE IF NOT EXISTS eventos_pasarela (
  id            TEXT PRIMARY KEY,
  proveedor     TEXT NOT NULL,
  -- El id que manda la pasarela, o el hash del cuerpo si no manda ninguno.
  evento_id     TEXT NOT NULL,
  firma_valida  INTEGER NOT NULL CHECK (firma_valida IN (0,1)),
  cuerpo_sha256 TEXT NOT NULL,
  resultado     TEXT,
  recibido_en   INTEGER NOT NULL,
  -- Lo que impide aplicar DOS VECES el mismo aviso. Las pasarelas reintentan
  -- cuando no reciben un 200 a tiempo, y sin esto un reintento confirmaría un
  -- pago por segunda vez.
  UNIQUE (proveedor, evento_id)
) STRICT;

CREATE TABLE IF NOT EXISTS reembolsos (
  id            TEXT PRIMARY KEY,
  pago_id       TEXT NOT NULL REFERENCES pagos(id),
  monto_cents   INTEGER NOT NULL CHECK (monto_cents > 0),
  motivo        TEXT NOT NULL,
  via           TEXT NOT NULL CHECK (via IN ('pasarela','manual')),
  proveedor_ref TEXT,
  estado        TEXT NOT NULL CHECK (estado IN ('pendiente','hecho','fallido')),
  actor         TEXT NOT NULL,
  creado_en     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS reembolsos_por_pago ON reembolsos (pago_id);

CREATE TABLE IF NOT EXISTS liquidaciones (
  id             TEXT PRIMARY KEY,
  proveedor      TEXT NOT NULL,
  fecha          TEXT NOT NULL,
  bruto_cents    INTEGER NOT NULL,
  comision_cents INTEGER NOT NULL,
  neto_cents     INTEGER NOT NULL,
  referencia     TEXT,
  conciliado     INTEGER NOT NULL DEFAULT 0 CHECK (conciliado IN (0,1)),
  creado_en      INTEGER NOT NULL,
  CHECK (neto_cents = bruto_cents - comision_cents)
) STRICT;

CREATE TABLE IF NOT EXISTS liquidacion_pagos (
  liquidacion_id TEXT NOT NULL REFERENCES liquidaciones(id),
  pago_id        TEXT NOT NULL REFERENCES pagos(id),
  PRIMARY KEY (liquidacion_id, pago_id)
) STRICT;
