-- 0004_siguiente_talla.sql · «La siguiente» solo existe donde hay tallas
--
-- La carga inicial encadenó las dos cajas de toallitas: DANY-AW1200 →
-- DANY-AW600. `siguiente_codigo` significa «la talla siguiente, para la
-- recompra» —qué ofrecerle a la clienta cuando al bebé se le queda chica la
-- que compra—, y entre 1.200 y 600 toallitas no hay ninguna talla: hay una
-- caja más chica y más barata. La recompra le habría ofrecido MENOS de lo que
-- ya compraba.
--
-- Pasó porque el guion que generó la carga encadenó cada familia en el orden
-- en que estaba escrita, sin preguntarse si esa familia tiene tallas. Y la
-- prueba que vigila la cadena solo compara PESOS, así que se saltó justo las
-- filas que no tienen peso. Las dos cosas quedan arregladas: esto, y la prueba.
--
-- Va como migración nueva y no como corrección de 0003 porque 0003 ya se
-- aplicó en staging: una migración aplicada no se reescribe, se corrige con
-- otra.

UPDATE variantes
   SET siguiente_codigo = NULL,
       actualizado_en = unixepoch() * 1000
 WHERE siguiente_codigo IS NOT NULL
   AND (talla IS NULL OR peso_min_lb IS NULL);
