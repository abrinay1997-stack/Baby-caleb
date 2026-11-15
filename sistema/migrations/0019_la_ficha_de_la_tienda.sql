-- 0019_la_ficha_de_la_tienda.sql · El texto con el que se vende, en el sistema
--
-- EL FALLO QUE CIERRA
--
-- La dueña crea un producto en el panel, le pone precio, le sube la foto, lo
-- publica — y no sale en la tienda. No hay ningún error en ninguna parte. La
-- lista de babycaleb.com se arma con las fichas de `content.json`, un archivo
-- del repositorio de la web que NADIE escribe: todo el código que lo menciona
-- lo lee. Así que el producto tiene su página, tiene su foto y se puede pedir
-- por su enlace directo, pero no entra en la lista hasta que un programador
-- edite ese archivo y despliegue.
--
-- El dueño preguntó por esto cuatro días seguidos. Se le contestó con el
-- síntoma («no tiene ficha») antes que con la causa, y después se le enseñó un
-- motivo en el panel que además nombraba la foto, que ya no faltaba.
--
-- A partir de aquí la lista de la tienda sale del SISTEMA: lo que la dueña
-- publica, se ve. `content.json` queda de respaldo, igual que con el precio y
-- con la foto.
--
-- POR QUÉ DOS COLUMNAS Y NO UNA
--
-- `productos.nombre` ya existe y NO sirve para la tienda. Dice «Pañal Nateen de
-- cierre», «Water wipes Dany Baby», «Fular prearmado Moon»: nombres de
-- operación, los que usa el panel, los que busca el bot y los que ponen de
-- ejemplo las herramientas del asistente. La tienda enseña «Pañales Nateen»,
-- «Wipes de agua Dany Baby», «Fulares Moon».
--
-- Renombrar `nombre` habría cambiado el panel, la búsqueda del bot y tres
-- pruebas, y habría sido decidir por la dueña cómo se llaman sus productos por
-- dentro. Reusarlo para la tienda habría cambiado los nombres visibles de
-- babycaleb.com sin que nadie lo pidiera — y el diseño de la web no se toca sin
-- pedido explícito.
--
-- Son dos nombres porque son dos cosas. El dueño de los dos es esta tabla.
--
-- EL NULO SIGNIFICA ALGO, Y NO ES LO MISMO EN LAS DOS
--
--   nombre_tienda NULL → «llámelo como se llama por dentro». La tienda cae a
--                        `nombre`. Es lo correcto para un producto recién
--                        creado desde el teléfono: sale con su nombre, sin que
--                        nadie tenga que escribir un segundo.
--   descripcion   NULL → «todavía no se ha escrito». NO es un texto vacío
--                        (trampa §7: un vacío afirma que no hay nada que
--                        decir). La tarjeta no pinta el párrafo y el panel
--                        puede avisar de que falta.
--
-- Una cadena en blanco no es ninguna de las dos cosas, así que los CHECK la
-- rechazan: o hay texto, o no hay columna.
--
-- LA CARGA INICIAL ES LO QUE LA TIENDA YA DICE HOY
--
-- Copiado literal de `content.json`, para que el día del despliegue la tienda
-- se vea EXACTAMENTE igual que la víspera. Si esto se dejara vacío, el cambio
-- de dueño borraría de un golpe los cuatro textos de venta que ya estaban
-- escritos, y eso sí sería tocar el diseño de la web.
--
-- `prod-wip` se lleva el texto del Dany Baby y no el de los Wipes Nateen: en
-- `content.json` son dos fichas y en el sistema son un solo producto, y la
-- ficha de Nateen está marcada descatalogada y sin códigos.

ALTER TABLE productos ADD COLUMN nombre_tienda TEXT
  CHECK (nombre_tienda IS NULL OR trim(nombre_tienda) <> '');

ALTER TABLE productos ADD COLUMN descripcion TEXT
  CHECK (descripcion IS NULL OR trim(descripcion) <> '');

UPDATE productos SET
  nombre_tienda = 'Pañales Nateen',
  descripcion   = 'Hipoalergénicos, súper absorbentes, sin cloro ni perfumes, 100% fibras de bambú y biodegradables. Tallas RN a XXL, en caja para todo el mes.'
  WHERE id = 'prod-pan';

UPDATE productos SET
  nombre_tienda = 'Pañales Nateen Pants',
  descripcion   = 'Tipo pantaloncito (pull-ups), con la misma protección hipoalergénica Nateen: sin cloro ni perfumes, 100% fibras de bambú. Caja de 160 para todo el mes. Solo tallas L, XL y XXL.'
  WHERE id = 'prod-pts';

UPDATE productos SET
  nombre_tienda = 'Wipes de agua Dany Baby',
  descripcion   = 'Toallitas de agua 99% pura, sin alcohol ni perfumes, ideales para recién nacidos. Caja de 12 paquetes de 50.'
  WHERE id = 'prod-wip';

UPDATE productos SET
  nombre_tienda = 'Fulares Moon',
  descripcion   = 'Portabebés ergonómico Moon: unitalla y ajustable, de recién nacido hasta ~25 lb. Carga a tu bebé cómoda y segura. Disponibilidad y colores por WhatsApp.'
  WHERE id = 'prod-por';
