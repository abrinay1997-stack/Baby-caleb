-- 0011_contabilidad.sql · Los libros (F5.1)
--
-- El esquema sale de docs/plan/02-datos.md §10 y el criterio de
-- docs/plan/05-contabilidad.md. Partida doble por dentro, pantallas simples por
-- fuera: la dueña ve «cuánto entró, cuánto debo, cuánto gané» y cada hecho deja
-- su asiento de dos columnas que cuadra solo.
--
-- ## Lo que esta migración hace IMPOSIBLE, no improbable
--
-- «Los libros no se editan ni se borran» (docs/plan/README.md, regla 3) no es
-- una costumbre del código que escribe: es un trigger. Un error se corrige con
-- el asiento contrario (`revierte_id`), nunca con un UPDATE.
--
--   1. `asientos` y `asiento_lineas` no aceptan UPDATE ni DELETE.
--   2. `control_cuadre` tampoco: si se pudiera borrar su fila, se podrían
--      añadir líneas después y el asiento quedaría descuadrado con su control
--      diciendo que cuadra.
--   3. **No se añaden líneas a un asiento ya cuadrado.** Esta es la que de
--      verdad cierra el agujero: sin ella, un segundo batch le mete una línea
--      a un asiento viejo, el `control_cuadre` de aquel día sigue diciendo 0 y
--      el balance se desequilibra sin que nada falle.
--   4. Un asiento no se revierte dos veces (`revierte_id` UNIQUE) ni se
--      revierte a sí mismo (CHECK).
--   5. Ningún asiento lleva fecha de un mes cerrado.
--   6. Una cuenta que ya tiene movimientos no cambia de código ni de
--      naturaleza, y no se borra: cambiarle el tipo reescribiría en silencio
--      todos los informes del pasado.
--   7. De una línea de extracto solo cambian las columnas de conciliación.
--
-- Lo que esto NO impide, y conviene decirlo en vez de dar por hecho que está
-- cubierto: que alguien inserte un asiento y sus líneas SIN la fila de
-- `control_cuadre`. SQLite no tiene restricciones diferidas, así que no hay
-- forma de exigir al final del batch que ese asiento tenga su control. Lo que
-- sí hay es el camino único de `src/db/contabilidad.ts` —que la escribe
-- siempre— y una comprobación en la lista de cierre de mes que cuenta los
-- asientos sin cuadre y no deja cerrar si hay alguno.
--
-- ## Dos columnas que el §10 no trae, y por qué
--
--  * `asientos.hecho`: el NÚMERO del asiento en la tabla de 05 §3 («3b»,
--    «18»…). El plan numeró los dieciocho hechos; guardar cuál es hace que el
--    libro diario pueda decir «Asiento 3 · Entrega del pedido BC-000123» en vez
--    de un apunte sin procedencia. Una cifra que no puede decir de dónde sale
--    invita a creérsela.
--  * `asiento_lineas.detalle`: el asiento 16 (cancelación con el abono aplicado
--    como crédito) tiene sus DOS líneas en la misma cuenta, 2101 — una por el
--    pedido viejo y otra por el nuevo. Sin esta columna el mayor de 2101 enseña
--    dos importes iguales y nadie puede saber cuál es cuál.

-- ---------------------------------------------------------------------------
-- Plan de cuentas
-- ---------------------------------------------------------------------------
-- `codigo` es la llave natural (1101, 4101…) y es lo que usa el código: los
-- asientos se arman nombrando códigos, no ids, porque el código está escrito en
-- la tabla de 05 §2 y el id no significa nada para nadie.
CREATE TABLE cuentas (
  id            TEXT PRIMARY KEY,
  codigo        TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL CHECK (tipo IN ('activo','pasivo','patrimonio','ingreso','costo','gasto')),
  -- 'banco' | 'yappy' | 'efectivo' | 'caja_motorizado' | 'por_liquidar' |
  -- 'por_cobrar' | 'inventario' | 'contra_ingreso' | NULL
  subtipo       TEXT,
  -- Solo las 1104-xx: la caja de UNA persona. El resto en NULL.
  motorizado_id TEXT REFERENCES motorizados(id),
  activa        INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  -- Una caja de motorizado sin motorizado no es la caja de nadie, y una cuenta
  -- del plan general con motorizado tampoco significa nada.
  --
  -- `IS` y no `=`: con `=`, una fila de subtipo NULL hace que el lado izquierdo
  -- valga NULL, el CHECK entero valga NULL, y SQLite deja pasar lo que no es
  -- falso. O sea que «1101 con un motorizado pegado» habría entrado sin más.
  CHECK ((subtipo IS 'caja_motorizado') = (motorizado_id IS NOT NULL))
) STRICT;

-- ---------------------------------------------------------------------------
-- Periodos · el mes cerrado
-- ---------------------------------------------------------------------------
-- La fila NACE CERRADA: existe porque alguien cerró ese mes. Un mes sin fila
-- está abierto, que es lo normal.
--
-- Al reabrir, `estado` vuelve a 'abierto' y `cerrado_por`/`cerrado_en` se
-- quedan con el último cierre: hacen falta para saber quién cerró y cuándo, y
-- borrarlos dejaría la reapertura sin nada que explicar.
CREATE TABLE periodos (
  mes              TEXT PRIMARY KEY CHECK (mes GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  estado           TEXT NOT NULL CHECK (estado IN ('abierto','cerrado')),
  cerrado_por      TEXT NOT NULL,
  cerrado_en       INTEGER NOT NULL,
  reabierto_motivo TEXT,
  -- «Reabrir pide motivo y queda registrado» (05 §9). Un motivo vacío es no
  -- dar motivo, así que también se rechaza: la igualdad obliga a las dos
  -- direcciones — abierto exige motivo, y cerrado no puede llevar uno viejo
  -- que haría creer que sigue reabierto.
  CHECK ((estado = 'abierto') = (reabierto_motivo IS NOT NULL AND trim(reabierto_motivo) <> ''))
) STRICT;

-- ---------------------------------------------------------------------------
-- Asientos
-- ---------------------------------------------------------------------------
CREATE TABLE asientos (
  id              TEXT PRIMARY KEY,
  -- Fecha CONTABLE en hora de Panamá (02-datos §1), no una marca de tiempo.
  -- El GLOB no valida que el día exista —'2026-02-31' pasa— pero sí que lo que
  -- entra tenga forma de fecha: sin él, un `Date.now()` en milisegundos entra
  -- como texto y el mes del asiento sale de `substr()` sobre un número.
  fecha           TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  descripcion     TEXT NOT NULL CHECK (trim(descripcion) <> ''),
  origen          TEXT NOT NULL CHECK (origen IN ('apertura','pago','entrega','cobro','liquidacion',
                    'compra','gasto','inventario','devolucion','reembolso','contracargo','credito','ajuste')),
  -- El número del hecho en la tabla de 05 §3. 'manual' es el asiento que
  -- escribe una persona a mano y no corresponde a ninguno de los dieciocho.
  hecho           TEXT NOT NULL CHECK (hecho IN ('1','2','3','3b','4','4b','5','6','7','8','9','10',
                    '11','12','13','14','15','16','17','18','manual')),
  -- SIN llave foránea a propósito: la referencia apunta a un pedido, a un pago,
  -- a una compra o a un gasto, y `compras` y `gastos` llegan en F5.4 y F5.5.
  -- Una columna por tabla posible sería una columna nueva cada vez.
  referencia_tipo TEXT,
  referencia_id   TEXT,
  -- El contrario que corrige a otro. UNIQUE: un asiento se revierte UNA vez.
  -- Sin esto, dos reversos del mismo error descuentan el doble y el balance
  -- cuadra igual —los dos asientos cuadran por separado— así que no habría
  -- nada que lo delatara.
  revierte_id     TEXT UNIQUE REFERENCES asientos(id),
  creado_por      TEXT NOT NULL,
  creado_en       INTEGER NOT NULL,
  CHECK ((referencia_tipo IS NULL) = (referencia_id IS NULL)),
  CHECK (revierte_id IS NULL OR revierte_id <> id)
) STRICT;

CREATE INDEX asientos_fecha ON asientos (fecha);
-- Para contestar «¿de qué asiento viene esta cifra?» desde el pedido o el pago.
CREATE INDEX asientos_por_referencia ON asientos (referencia_tipo, referencia_id);

CREATE TABLE asiento_lineas (
  id          TEXT PRIMARY KEY,
  asiento_id  TEXT NOT NULL REFERENCES asientos(id),
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id),
  debe_cents  INTEGER NOT NULL DEFAULT 0 CHECK (debe_cents >= 0),
  haber_cents INTEGER NOT NULL DEFAULT 0 CHECK (haber_cents >= 0),
  -- De qué es esta línea, cuando el asiento solo no lo dice. Ver la nota de
  -- arriba sobre el asiento 16.
  detalle     TEXT,
  -- Una línea es de debe o de haber, nunca las dos ni ninguna. Esto ya deja
  -- fuera la línea de cero, así que no hace falta un CHECK aparte para ella.
  CHECK ((debe_cents > 0 AND haber_cents = 0) OR (haber_cents > 0 AND debe_cents = 0))
) STRICT;

CREATE INDEX lineas_cuenta ON asiento_lineas (cuenta_id, asiento_id);

-- La fila de control del cuadre. Último enunciado del batch de cada asiento:
--
--   INSERT INTO control_cuadre
--   SELECT ?1, SUM(debe_cents) - SUM(haber_cents) FROM asiento_lineas WHERE asiento_id = ?1;
--
-- Mira los valores que ESE batch escribió —el id del asiento es nuevo, así que
-- todas sus líneas son de este batch— y no algo que ya era cierto antes. Si el
-- asiento no cuadra, el CHECK tumba el batch entero y el hecho tampoco se
-- escribe. Y si el asiento no tiene ni una línea, `SUM` de cero filas es NULL y
-- el NOT NULL lo tumba igual.
CREATE TABLE control_cuadre (
  asiento_id TEXT PRIMARY KEY REFERENCES asientos(id),
  diferencia INTEGER NOT NULL CHECK (diferencia = 0)
) STRICT;

CREATE TRIGGER asientos_periodo_cerrado BEFORE INSERT ON asientos
WHEN EXISTS (SELECT 1 FROM periodos WHERE mes = substr(NEW.fecha, 1, 7) AND estado = 'cerrado')
BEGIN SELECT RAISE(ABORT, 'periodo_cerrado'); END;

CREATE TRIGGER asientos_no_se_editan BEFORE UPDATE ON asientos
BEGIN SELECT RAISE(ABORT, 'asientos no se editan: registre un asiento contrario'); END;
CREATE TRIGGER asientos_no_se_borran BEFORE DELETE ON asientos
BEGIN SELECT RAISE(ABORT, 'asientos no se borran'); END;

CREATE TRIGGER asiento_lineas_no_se_editan BEFORE UPDATE ON asiento_lineas
BEGIN SELECT RAISE(ABORT, 'asiento_lineas no se editan'); END;
CREATE TRIGGER asiento_lineas_no_se_borran BEFORE DELETE ON asiento_lineas
BEGIN SELECT RAISE(ABORT, 'asiento_lineas no se borran'); END;

-- La que de verdad cierra el agujero: un asiento ya cuadrado está terminado.
CREATE TRIGGER asiento_lineas_no_se_anaden_despues BEFORE INSERT ON asiento_lineas
WHEN EXISTS (SELECT 1 FROM control_cuadre WHERE asiento_id = NEW.asiento_id)
BEGIN SELECT RAISE(ABORT, 'ese asiento ya está cuadrado: lo que falte va en otro asiento'); END;

-- Y su control no se toca, porque es lo único que sostiene la regla de arriba.
CREATE TRIGGER control_cuadre_no_se_edita BEFORE UPDATE ON control_cuadre
BEGIN SELECT RAISE(ABORT, 'el cuadre de un asiento no se edita'); END;
CREATE TRIGGER control_cuadre_no_se_borra BEFORE DELETE ON control_cuadre
BEGIN SELECT RAISE(ABORT, 'el cuadre de un asiento no se borra'); END;

-- Una cuenta con movimientos no cambia de naturaleza. El nombre sí: «Banco
-- (cuál: PENDIENTE)» tiene que poder pasar a «Banco General cuenta 04-xx» el
-- día que la dueña lo diga, sin que eso toque ningún asiento del pasado.
CREATE TRIGGER cuenta_con_movimientos_no_cambia_de_naturaleza BEFORE UPDATE ON cuentas
WHEN (OLD.codigo IS NOT NEW.codigo OR OLD.tipo IS NOT NEW.tipo OR OLD.subtipo IS NOT NEW.subtipo
      OR OLD.motorizado_id IS NOT NEW.motorizado_id)
 AND EXISTS (SELECT 1 FROM asiento_lineas WHERE cuenta_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'esa cuenta ya tiene movimientos: no cambia de código ni de naturaleza'); END;

CREATE TRIGGER cuenta_con_movimientos_no_se_borra BEFORE DELETE ON cuentas
WHEN EXISTS (SELECT 1 FROM asiento_lineas WHERE cuenta_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'esa cuenta ya tiene movimientos: desactívela en vez de borrarla'); END;

-- ---------------------------------------------------------------------------
-- La cuenta a la que entró un pago
-- ---------------------------------------------------------------------------
-- La 0006 dejó `pagos.cuenta_id` como columna suelta y escrito que «F5.1 la
-- crea y añade el índice que la vigila»: SQLite no puede añadir una llave
-- foránea con ALTER, y la 0006 no podía apuntar a una tabla que no existía.
--
-- El índice es para buscar los pagos de una cuenta al conciliar. Los triggers
-- son la llave foránea que ALTER no deja poner: sin ellos, un `cuenta_id` mal
-- escrito deja el pago apuntando a ninguna parte y el dinero no aparece en
-- ninguna cuenta sin que nada falle.
CREATE INDEX pagos_por_cuenta ON pagos (cuenta_id) WHERE cuenta_id IS NOT NULL;

CREATE TRIGGER pago_con_cuenta_que_existe_al_insertar BEFORE INSERT ON pagos
WHEN NEW.cuenta_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cuentas WHERE id = NEW.cuenta_id)
BEGIN SELECT RAISE(ABORT, 'ese pago apunta a una cuenta que no existe'); END;

CREATE TRIGGER pago_con_cuenta_que_existe BEFORE UPDATE OF cuenta_id ON pagos
WHEN NEW.cuenta_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cuentas WHERE id = NEW.cuenta_id)
BEGIN SELECT RAISE(ABORT, 'ese pago apunta a una cuenta que no existe'); END;

-- ---------------------------------------------------------------------------
-- Conciliación · extractos del banco y de Yappy Comercial (05 §8)
-- ---------------------------------------------------------------------------
CREATE TABLE extractos (
  id                TEXT PRIMARY KEY,
  cuenta_id         TEXT NOT NULL REFERENCES cuentas(id),
  archivo_r2        TEXT NOT NULL,
  formato           TEXT NOT NULL,
  desde             TEXT,
  hasta             TEXT,
  saldo_final_cents INTEGER,
  importado_por     TEXT NOT NULL,
  importado_en      INTEGER NOT NULL
) STRICT;

CREATE TABLE extracto_lineas (
  id                  TEXT PRIMARY KEY,
  extracto_id         TEXT NOT NULL REFERENCES extractos(id),
  fecha               TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  descripcion         TEXT NOT NULL,
  -- Con signo: lo que entra es positivo y lo que sale, negativo.
  monto_cents         INTEGER NOT NULL,
  referencia          TEXT,
  -- Evita importar dos veces la misma línea: si el CSV se sube de nuevo, el
  -- UNIQUE rechaza las líneas repetidas y solo entran las nuevas.
  huella              TEXT NOT NULL UNIQUE,
  conciliado_con_tipo TEXT,
  conciliado_con_id   TEXT,
  conciliado_en       INTEGER,
  CHECK ((conciliado_con_tipo IS NULL) = (conciliado_con_id IS NULL)),
  CHECK ((conciliado_con_id IS NULL) = (conciliado_en IS NULL))
) STRICT;

CREATE INDEX extracto_lineas_por_extracto ON extracto_lineas (extracto_id, fecha);
-- Las que faltan por cruzar: es la lista de trabajo de la conciliación y la
-- comprobación del cierre de mes.
CREATE INDEX extracto_lineas_sin_conciliar ON extracto_lineas (fecha) WHERE conciliado_con_id IS NULL;

-- Un extracto es lo que dijo el banco: no se corrige. Lo único que cambia de
-- una línea es con qué se cruzó.
CREATE TRIGGER extracto_lineas_solo_cambian_al_conciliar BEFORE UPDATE ON extracto_lineas
WHEN OLD.id          IS NOT NEW.id
  OR OLD.extracto_id IS NOT NEW.extracto_id
  OR OLD.fecha       IS NOT NEW.fecha
  OR OLD.descripcion IS NOT NEW.descripcion
  OR OLD.monto_cents IS NOT NEW.monto_cents
  OR OLD.referencia  IS NOT NEW.referencia
  OR OLD.huella      IS NOT NEW.huella
BEGIN SELECT RAISE(ABORT, 'de una línea de extracto solo cambia con qué se concilió'); END;

CREATE TRIGGER extracto_lineas_no_se_borran BEFORE DELETE ON extracto_lineas
BEGIN SELECT RAISE(ABORT, 'una línea de extracto no se borra'); END;

-- ---------------------------------------------------------------------------
-- El plan de cuentas de 05 §2, tal cual
-- ---------------------------------------------------------------------------
-- Los ids son legibles porque se leen en consultas y en informes durante años.
-- La caja de cada motorizado (1104-xx) NO está aquí: nace cuando nace el
-- motorizado, con `cuentaDeMotorizado` de src/db/contabilidad.ts.
--
-- Ninguna cifra entra con el plan de cuentas: una cuenta es un sitio donde
-- anotar, y todas empiezan vacías. Los saldos llegan con el asiento de apertura
-- (asiento 17), que necesita el conteo físico y los costos revisados con la
-- contadora (05 §7).
INSERT INTO cuentas (id, codigo, nombre, tipo, subtipo) VALUES
  ('cta-1101', '1101', 'Yappy Comercial (Banco General)',  'activo',     'yappy'),
  -- El nombre lleva el PENDIENTE escrito porque sale en cada informe donde
  -- aparezca la cuenta: la dueña y la contadora son las que dicen qué banco es.
  ('cta-1102', '1102', 'Banco (cuál: PENDIENTE)',          'activo',     'banco'),
  ('cta-1103', '1103', 'Efectivo en caja',                 'activo',     'efectivo'),
  ('cta-1105', '1105', 'Por liquidar Tilopay',             'activo',     'por_liquidar'),
  ('cta-1106', '1106', 'Por liquidar PayPal',              'activo',     'por_liquidar'),
  ('cta-1201', '1201', 'Cuentas por cobrar a clientas',    'activo',     'por_cobrar'),
  ('cta-1301', '1301', 'Inventario',                       'activo',     'inventario'),
  ('cta-2101', '2101', 'Anticipos de clientas',            'pasivo',     NULL),
  ('cta-2102', '2102', 'Cuentas por pagar a proveedores',  'pasivo',     NULL),
  -- Solo se usa si la contadora confirma que el ITBMS aplica y a qué tasa
  -- (05 §10). Mientras `variantes.tasa_itbms_bp` sea NULL, nada escribe aquí.
  ('cta-2201', '2201', 'ITBMS por pagar',                  'pasivo',     NULL),
  ('cta-3101', '3101', 'Capital',                          'patrimonio', NULL),
  ('cta-3201', '3201', 'Resultados acumulados',            'patrimonio', NULL),
  ('cta-4101', '4101', 'Ventas',                           'ingreso',    NULL),
  ('cta-4102', '4102', 'Ingresos por envío',               'ingreso',    NULL),
  -- Ingreso CONTRA: resta de las ventas en vez de sumar. El subtipo es lo que
  -- hace que el estado de resultados no la cuente como un ingreso más.
  ('cta-4901', '4901', 'Devoluciones y descuentos',        'ingreso',    'contra_ingreso'),
  ('cta-5101', '5101', 'Costo de lo vendido',              'costo',      NULL),
  ('cta-5201', '5201', 'Mermas, muestras y regalos',       'costo',      NULL),
  ('cta-6101', '6101', 'Publicidad',                       'gasto',      NULL),
  ('cta-6102', '6102', 'Motorizados y envíos',             'gasto',      NULL),
  ('cta-6103', '6103', 'Comisiones de pasarelas',          'gasto',      NULL),
  ('cta-6104', '6104', 'Empaques',                         'gasto',      NULL),
  ('cta-6105', '6105', 'Software e IA',                    'gasto',      NULL),
  ('cta-6199', '6199', 'Otros gastos',                     'gasto',      NULL);
