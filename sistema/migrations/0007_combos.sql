-- Combos: un producto que se arma con otros (F4.19).
--
-- Un combo NO tiene existencias propias. No hay una caja en la bodega que
-- ponga «combo»: lo que hay son sus componentes, y de un combo caben tantos
-- como permita el que menos alcance (`src/dominio/combos.ts`).
--
-- ## Por qué un combo no puede llevar otro combo
--
-- Porque si pudiera, A podría llevar B y B llevar A. Eso no es un caso raro de
-- laboratorio: basta con que dos personas armen dos combos el mismo día. Y una
-- consulta de existencias sobre un ciclo no termina nunca — o peor, termina
-- con un número inventado.
--
-- Se podría permitir con un límite de profundidad y detección de ciclos. No se
-- hace: Baby Caleb vende cajas de pañales juntas, no combos de combos, y el
-- código que nadie necesita es código que nadie prueba. Si algún día hace
-- falta, se quita el trigger y se añade la detección de verdad.

ALTER TABLE variantes ADD COLUMN es_combo INTEGER NOT NULL DEFAULT 0 CHECK (es_combo IN (0,1));

CREATE TABLE IF NOT EXISTS combo_componentes (
  combo_codigo TEXT NOT NULL REFERENCES variantes(codigo),
  codigo       TEXT NOT NULL REFERENCES variantes(codigo),
  -- Cuántas unidades de este componente lleva UN combo.
  cantidad     INTEGER NOT NULL CHECK (cantidad > 0),
  PRIMARY KEY (combo_codigo, codigo),
  -- Un combo que se lleva a sí mismo es el ciclo más corto que existe.
  --
  -- Hoy esto es un cinturón de más: el trigger de abajo ya lo caza, porque el
  -- dueño de una receta tiene que ser un combo y un componente no puede serlo.
  -- Probado quitándolo: las pruebas siguen verdes. Se queda porque no cuesta
  -- nada y sobrevive a que alguien toque los triggers, pero quien lo lea no
  -- debe creer que es lo que está defendiendo.
  CHECK (combo_codigo <> codigo)
) STRICT;

CREATE INDEX IF NOT EXISTS combo_componentes_por_componente
  ON combo_componentes (codigo);

-- El componente NO puede ser un combo. Esto, más el CHECK de arriba, deja los
-- ciclos imposibles con una sola regla local: si nadie puede meter un combo
-- dentro de otro, no hay cadena que dé la vuelta.
CREATE TRIGGER combo_componente_no_es_combo
BEFORE INSERT ON combo_componentes
WHEN (SELECT es_combo FROM variantes WHERE codigo = NEW.codigo) = 1
BEGIN SELECT RAISE(ABORT, 'un combo no puede llevar otro combo dentro'); END;

-- Y el que ya es componente de alguien no puede volverse combo. Sin esto, la
-- regla de arriba se esquiva en dos pasos: primero se mete como componente
-- normal y después se marca como combo.
CREATE TRIGGER combo_no_se_marca_si_es_componente
BEFORE UPDATE OF es_combo ON variantes
WHEN NEW.es_combo = 1 AND OLD.es_combo = 0
 AND EXISTS (SELECT 1 FROM combo_componentes WHERE codigo = NEW.codigo)
BEGIN SELECT RAISE(ABORT, 'esta variante ya es parte de un combo: no puede ser un combo'); END;

-- El dueño de una receta tiene que ser un combo.
--
-- Sin esto se pueden meter componentes a una variante normal: datos que nadie
-- consulta —porque nada sabe que es un combo— pero que quedan ahí y mienten.
-- Y además es lo que hace que el CHECK de arriba sea redundante en vez de
-- imprescindible: con esta regla, los dos extremos de una fila son
-- necesariamente de tipos distintos.
CREATE TRIGGER combo_duenno_es_combo
BEFORE INSERT ON combo_componentes
WHEN (SELECT es_combo FROM variantes WHERE codigo = NEW.combo_codigo) <> 1
BEGIN SELECT RAISE(ABORT, 'esta variante no es un combo: no puede tener receta'); END;

-- Y un combo con receta no puede dejar de ser combo. Si pudiera, su receta se
-- quedaría colgando de algo que ya no es un combo — el mismo dato que miente,
-- por el otro lado.
CREATE TRIGGER combo_con_receta_sigue_siendo_combo
BEFORE UPDATE OF es_combo ON variantes
WHEN NEW.es_combo = 0 AND OLD.es_combo = 1
 AND EXISTS (SELECT 1 FROM combo_componentes WHERE combo_codigo = NEW.codigo)
BEGIN SELECT RAISE(ABORT, 'este combo tiene receta: quítele los componentes antes'); END;
