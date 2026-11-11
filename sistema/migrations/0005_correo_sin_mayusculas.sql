-- El correo de `usuarios` es la LLAVE DE ENTRADA al panel, y en SQLite
-- `WHERE correo = ?` distingue mayúsculas.
--
-- Access siempre entrega el correo en minúsculas (`src/seguridad/access.ts`
-- lo normaliza al leer el token), pero las filas de `usuarios` se escriben a
-- mano: hoy por SQL, mañana desde la pestaña Usuarios. Basta que alguien
-- teclee «Yarielis@Gmail.com» para que esa persona NO PUEDA ENTRAR NUNCA, y
-- el síntoma es un «no autorizado» sin ninguna pista — en un panel cuya dueña
-- no usa la terminal, eso es un callejón sin salida.
--
-- Y el `UNIQUE` de la columna tampoco ayudaba: distingue mayúsculas, así que
-- deja convivir dos filas para la misma persona, una de ellas inalcanzable.
--
-- Este índice cierra las dos cosas a la vez. La consulta del panel pasa a
-- comparar con COLLATE NOCASE, así que una fila mal tecleada SÍ casa; y dos
-- filas que solo se diferencian en mayúsculas dejan de poder existir.
--
-- No se recrea la tabla para ponerle COLLATE NOCASE a la columna: en SQLite
-- eso obliga a copiar la tabla entera, y `usuarios` tiene claves foráneas
-- apuntándole. Un índice hace el mismo trabajo sin tocar los datos.

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_correo_nocase
  ON usuarios (correo COLLATE NOCASE);
