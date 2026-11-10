-- Qué se apartó por cada combo vendido (F4.19).
--
-- Un combo no tiene existencias propias: al venderlo se aparta de SUS
-- COMPONENTES. El problema es cancelar después. Si el pedido guardara solo
-- «combo X», para devolver lo apartado habría que volver a leer la receta — y
-- la receta puede haber cambiado. Se liberaría una cantidad distinta de la que
-- se apartó, y la diferencia se queda bloqueada para siempre sin que nada
-- falle.
--
-- Así que se guarda LO QUE SE APARTÓ, no la receta de donde salió. Es el mismo
-- principio por el que `pedido_lineas` copia el nombre del producto: el pedido
-- de ayer tiene que seguir diciendo lo que pasó ayer.
CREATE TABLE IF NOT EXISTS pedido_linea_componentes (
  linea_id  TEXT NOT NULL REFERENCES pedido_lineas(id),
  codigo    TEXT NOT NULL REFERENCES variantes(codigo),
  bodega_id TEXT NOT NULL REFERENCES bodegas(id),
  -- Unidades apartadas EN TOTAL por esta línea: la receta por la cantidad
  -- pedida, ya multiplicada. Guardar la receta y multiplicar al cancelar
  -- sería volver a depender de un dato que puede cambiar.
  cantidad  INTEGER NOT NULL CHECK (cantidad > 0),
  PRIMARY KEY (linea_id, codigo, bodega_id)
) STRICT;

CREATE INDEX IF NOT EXISTS pedido_linea_componentes_por_linea
  ON pedido_linea_componentes (linea_id);

-- Lo apartado no se edita ni se borra, igual que el resto de los libros: si una
-- cantidad estuviera mal, se corrige liberando y volviendo a apartar, con su
-- rastro. Editarla a mano dejaría `existencias.reservado` diciendo una cosa y
-- esta tabla otra, y nadie sabría cuál creer.
CREATE TRIGGER pedido_linea_componentes_no_se_edita
BEFORE UPDATE ON pedido_linea_componentes
BEGIN SELECT RAISE(ABORT, 'lo apartado por un combo no se edita'); END;
