-- 0013_cotizaciones.sql · Una cotización es un pedido que todavía no aparta
-- nada
--
-- EL ENCARGO, Y POR QUÉ ESTA FORMA
--
-- Lo pidió el dueño «tomando el modelo de Odoo»: una cotización, al
-- confirmarse, SE CONVIERTE en pedido. No son dos documentos que se copian uno
-- en otro — es el mismo documento cambiando de estado, con su mismo número, sus
-- mismas líneas y sus mismos precios.
--
-- De ahí sale que `cotizacion` sea un valor de `pedidos.estado` y no una tabla
-- aparte. Una tabla `cotizaciones` obligaría a copiar las líneas al confirmar,
-- y ese día habría dos documentos con dos números y la pregunta «¿de cuál
-- salió esta venta?» tendría dos respuestas. El estado nuevo va ANTES de
-- `por_abonar`:
--
--   cotizacion --> por_abonar   (confirmar: AQUÍ se aparta el inventario)
--   cotizacion --> cancelado    (caduca o la clienta desiste: no hubo venta)
--
-- LO ESENCIAL: UNA COTIZACIÓN NO APARTA STOCK
--
-- `existencias.reservado` no se toca mientras el documento sea una cotización.
-- Eso es lo que la distingue de un pedido y es lo que la hace útil: se pueden
-- tener diez cotizaciones abiertas por la misma caja sin que el inventario
-- mienta. El apartado ocurre en la transición a `por_abonar`, que es el camino
-- que ya existía y que ya tiene su fila de control.
--
-- Y por eso tampoco se escribe ninguna fila en `pedido_linea_componentes`
-- mientras sea cotización: esa tabla guarda LO APARTADO, y no hay nada
-- apartado. La receta de un combo se resuelve al confirmar, que es cuando se
-- quita la mercancía de verdad.
--
-- NINGÚN ASIENTO CONTABLE
--
-- Una cotización no es un hecho económico: no hay venta, no hay cobro, no hay
-- mercancía que salga. Esta migración no toca contabilidad y el código que la
-- crea o la confirma no escribe ni un asiento más de los que ya escribía un
-- pedido. La venta se sigue reconociendo al ENTREGAR
-- (docs/plan/05-contabilidad.md), que no cambia.
--
-- POR QUÉ HAY QUE RECREAR LA TABLA
--
-- `estado` lleva un `CHECK (estado IN (...))` y SQLite no sabe ensanchar un
-- CHECK: la única forma es recrear la tabla. Es el procedimiento que la propia
-- documentación de SQLite describe y el que docs/plan/02-datos.md §1 da por
-- supuesto («Las migraciones que recrean tablas usan PRAGMA
-- defer_foreign_keys = on»).
--
-- `defer_foreign_keys` hace falta porque cuatro tablas apuntan a `pedidos`
-- (`pedido_lineas`, `pedido_eventos`, `pagos`, `envios`). Con la comprobación
-- inmediata, el `DROP TABLE pedidos` reventaría —SQLite hace un DELETE
-- implícito antes de borrar— aunque la tabla vuelva a existir dos enunciados
-- después. Diferida, la comprobación se hace al cerrar, cuando `pedidos` ya
-- está de vuelta con todas sus filas.
--
-- LA FILA DE CONTROL, Y QUÉ COMPRUEBA
--
-- Recrear una tabla es el único sitio de este sistema donde se puede perder
-- una venta sin que nada falle: un `INSERT ... SELECT` que copie de menos no da
-- error, solo deja filas atrás. Así que antes de borrar la vieja se compara lo
-- COPIADO contra lo que había, y `controles.ok CHECK (ok = 1)` tumba la
-- migración entera si no cuadra.
--
-- Compara tres cosas y no una: el número de filas (que no falte ninguna) y las
-- dos sumas de dinero (que ninguna columna se haya copiado en la posición
-- equivocada, que es el otro error de un INSERT ... SELECT y el que el conteo
-- no ve).
--
-- Las sumas se comparan con `IS` y NO con `=`. `SUM()` de una tabla vacía es
-- NULL, y `NULL = NULL` da NULL, no verdadero: con `=`, esta migración fallaría
-- en una base recién creada —justo donde corre cada prueba— por cuadrar
-- perfectamente. `IS` compara NULL con NULL y dice que sí.

PRAGMA defer_foreign_keys = on;

CREATE TABLE pedidos_nueva (
  id                  TEXT PRIMARY KEY,
  numero              TEXT NOT NULL UNIQUE,
  token               TEXT NOT NULL UNIQUE,
  cliente_id          TEXT NOT NULL REFERENCES clientes(id),
  origen              TEXT NOT NULL CHECK (origen IN ('web','whatsapp','instagram','messenger','telegram','panel')),
  conversacion_ref    TEXT,
  -- `cotizacion` es el único valor nuevo. Va escrito primero porque es el
  -- primero del recorrido, no por orden alfabético.
  estado              TEXT NOT NULL CHECK (estado IN ('cotizacion','por_abonar','agendado','en_ruta','entregado','cancelado','devuelto')),
  estado_pago         TEXT NOT NULL CHECK (estado_pago IN ('sin_pago','abonado','pagado','reembolso_parcial','reembolsado')),
  direccion_id        TEXT REFERENCES direcciones(id),
  zona_id             TEXT REFERENCES zonas_envio(id),
  subtotal_cents      INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  envio_cents         INTEGER NOT NULL DEFAULT 0 CHECK (envio_cents >= 0),
  descuento_cents     INTEGER NOT NULL DEFAULT 0 CHECK (descuento_cents >= 0),
  itbms_cents         INTEGER NOT NULL DEFAULT 0 CHECK (itbms_cents >= 0),
  total_cents         INTEGER NOT NULL,
  pagado_cents        INTEGER NOT NULL DEFAULT 0 CHECK (pagado_cents >= 0),
  abono_minimo_cents  INTEGER NOT NULL,
  requiere_pago_total INTEGER NOT NULL DEFAULT 0 CHECK (requiere_pago_total IN (0,1)),
  -- Ahora significa dos cosas según el estado, y las dos son «hasta cuándo
  -- vale esto»: en `cotizacion`, hasta cuándo vale la cotización; en
  -- `por_abonar`, hasta cuándo se le guarda el apartado. Al pasar a `agendado`
  -- se queda en NULL, como antes.
  vence_en            INTEGER,
  notas_cliente       TEXT,
  notas_internas      TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  creado_en           INTEGER NOT NULL,
  actualizado_en      INTEGER NOT NULL,
  CHECK (total_cents = subtotal_cents + envio_cents - descuento_cents + itbms_cents),
  CHECK (pagado_cents <= total_cents)
) STRICT;

-- Las columnas se nombran UNA POR UNA en los dos lados. Un `INSERT INTO ...
-- SELECT *` casa por posición, así que el día que alguien añada una columna a
-- una de las dos tablas y no a la otra, copiaría el token en el nombre del
-- cliente sin que nada se queje.
INSERT INTO pedidos_nueva (
  id, numero, token, cliente_id, origen, conversacion_ref, estado, estado_pago,
  direccion_id, zona_id, subtotal_cents, envio_cents, descuento_cents, itbms_cents,
  total_cents, pagado_cents, abono_minimo_cents, requiere_pago_total, vence_en,
  notas_cliente, notas_internas, version, creado_en, actualizado_en
)
SELECT
  id, numero, token, cliente_id, origen, conversacion_ref, estado, estado_pago,
  direccion_id, zona_id, subtotal_cents, envio_cents, descuento_cents, itbms_cents,
  total_cents, pagado_cents, abono_minimo_cents, requiere_pago_total, vence_en,
  notas_cliente, notas_internas, version, creado_en, actualizado_en
FROM pedidos;

INSERT INTO controles (id, regla, ok, creado_en)
VALUES (
  'ctl-migracion-0013-pedidos',
  'migracion_0013:pedidos_copiados',
  (SELECT CASE
     WHEN (SELECT COUNT(*) FROM pedidos_nueva) = (SELECT COUNT(*) FROM pedidos)
      AND (SELECT SUM(total_cents) FROM pedidos_nueva) IS (SELECT SUM(total_cents) FROM pedidos)
      AND (SELECT SUM(pagado_cents) FROM pedidos_nueva) IS (SELECT SUM(pagado_cents) FROM pedidos)
     THEN 1 ELSE 0 END),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

DROP TABLE pedidos;

ALTER TABLE pedidos_nueva RENAME TO pedidos;

-- Los índices se van con la tabla vieja, así que se vuelven a crear. Son los
-- tres de la 0006, con el mismo nombre y la misma forma: el de `vence_en`
-- sigue filtrando por `por_abonar` a propósito —el cron que libera apartados
-- es el que lo usa, y una cotización no tiene nada apartado que liberar.
CREATE INDEX IF NOT EXISTS pedidos_por_cliente ON pedidos (cliente_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS pedidos_por_estado ON pedidos (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS pedidos_por_vencer ON pedidos (vence_en) WHERE estado = 'por_abonar';
-- Y uno nuevo: las cotizaciones vencidas, que es la lista que mira quien
-- limpia. Va aparte del de arriba porque los dos son índices parciales y un
-- índice parcial solo sirve a la consulta que repite su propio `WHERE`.
CREATE INDEX IF NOT EXISTS cotizaciones_por_vencer ON pedidos (vence_en) WHERE estado = 'cotizacion';
