-- Un casillero para cada presentación que nació sin él (F4.x, destapado probando).
--
-- ## Qué estaba roto
--
-- En todo el repositorio había UN solo `INSERT INTO existencias`: el de
-- `src/db/bodegas.ts`, que al crear una bodega le reparte un casillero a cada
-- presentación que existía en ese momento. `crearVariante` no creaba ninguno
-- —había incluso una prueba que lo exigía— así que cualquier presentación dada
-- de alta DESPUÉS de las bodegas nacía sin sitio donde contarla.
--
-- Y sin casillero no se le puede mover mercancía: `aplicar()` actualiza con
-- `WHERE codigo = ? AND bodega_id = ?`, no casa con nada, la fila de control
-- tumba el lote y quien lo intenta lee «no está dado de alta en esa bodega».
-- Eso está BIEN —«no se sabe cuánto hay» no es «hay cero», y confundirlos
-- convertiría un código mal tecleado en una entrada de inventario— pero no
-- había forma de arreglarlo salvo crear una bodega nueva, que no se borra.
--
-- Los doce artículos de producción funcionan solo porque nacieron en la misma
-- migración que las bodegas (la 0003). El primero que la dueña diera de alta
-- después no se habría podido inventariar nunca.
--
-- El código ya quedó arreglado: `crearVariante` y `crearProductoConVariante`
-- crean los casilleros en el mismo lote. Esto es para los que ya nacieron sin
-- ellos.
--
-- ## Por qué así
--
-- `fisico = 0` y `reservado = 0` porque es lo que una presentación recién dada
-- de alta tiene de verdad: nada. No inventa existencias; crea el sitio donde
-- contarlas. `minimo` queda NULL, que es «sin aviso de stock bajo», igual que
-- hace `bodegas.ts`.
--
-- Los combos quedan fuera, como en `bodegas.ts`: un combo no se guarda, se
-- arma, y sus unidades libres salen de sus componentes. Darle casillero
-- invitaría a contarlos como cajas en un estante.
--
-- Es idempotente: el `WHERE NOT EXISTS` deja intactas las 36 filas que ya hay.

INSERT INTO existencias (codigo, bodega_id, fisico, reservado, minimo)
SELECT v.codigo, b.id, 0, 0, NULL
  FROM variantes v
 CROSS JOIN bodegas b
 WHERE v.es_combo = 0
   AND NOT EXISTS (
     SELECT 1 FROM existencias e
      WHERE e.codigo = v.codigo AND e.bodega_id = b.id
   );
