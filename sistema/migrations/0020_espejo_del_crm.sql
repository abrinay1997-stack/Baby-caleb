-- 0020_espejo_del_crm.sql · El catálogo del sistema se pone al día con el CRM
--
-- POR QUÉ EXISTE ESTA MIGRACIÓN
--
-- La dueña del negocio decidió que, mientras dure el traspaso, el catálogo
-- VIVO del CRM es la verdad del precio y de las existencias. El sistema venía
-- de `0003_carga_inicial.sql`, que cargó el catálogo a CERO a propósito —
-- «inventar un número aquí sería exactamente lo que este sistema existe para
-- no volver a hacer»— y ese cero nunca se llenó.
--
-- Consecuencia medida en babycaleb.com el 2026-11-17: **once de los doce
-- artículos de la tienda decían «agotado»** mientras el negocio tenía
-- mercancía en bodega, los wipes Dany Baby se ofrecían a $25.00 cuando el CRM
-- los vende a $20.00, y tres pañales Velvee con existencias no aparecían.
--
-- DE DÓNDE SALE CADA CIFRA
--
-- De `catalog_items` de la base del CRM (`juancitoads-bot-db`, D1
-- 13acf414-7f62-4723-bd20-64612442dc07), leída el 2026-11-17: las 22 filas con
-- `active = 1`, que son 14 códigos repartidos en tres bodegas. Ninguna cifra
-- de aquí se escribió a ojo ni se redondeó.
--
-- Las bodegas se emparejan por nombre, y los tres nombres coinciden exactos
-- entre las dos bases:
--   bod-1 = Bodega Ciudad de Panamá
--   bod-2 = Bodega Panamá Oeste
--   bod-3 = Bodega Ciudad de Panamá Este Línea 2
--
-- LO QUE ESTA MIGRACIÓN *NO* HACE
--
--  · No carga el COSTO. El CRM lo tiene (`cost_price`), pero cargarlo bien
--    exige mover `valor_inventario` y el asiento de apertura, que es trabajo
--    aparte y con contabilidad de por medio. Los movimientos de aquí van con
--    `costo_unit_cents` en NULL, que es «no se sabe qué costó» — no un cero,
--    que afirmaría que la mercancía fue gratis (TRAMPAS §7). Hasta entonces la
--    entrega de estas variantes sigue saliendo con `costoDesconocido`, igual
--    que hoy: no empeora nada, pero tampoco lo arregla.
--
--  · No carga las EXISTENCIAS. Eso va por la ruta `POST /existencias/movimientos`,
--    que escribe el libro como se debe; el porqué está en la sección 5. Aquí
--    solo se dejan las filas en cero que el libro necesita para apuntar.
--
--  · No es un espejo permanente. El CRM sigue vendiendo después de esto, así
--    que el precio de aquí envejece desde el minuto en que se aplica. Es la
--    puesta al día que faltaba, no una sincronización; el conteo y el repaso de
--    precios se vuelven a pasar el día del cambio.
--
-- LO QUE SE ENCONTRÓ DE PASO, Y QUE NO SE ARREGLA AQUÍ
--
--  1. El CRM guarda un PRECIO dentro del NOMBRE de un producto («Promoción: 2
--     cajas … por $35.00» en DANY-AW600). Eso es un precio con dos dueños. En
--     el sistema la promoción pasa a ser un combo con su propio
--     `precio_cents`, y el nombre se queda sin cifras de dinero.
--  2. El CRM BORRA las filas que deja de vender en vez de desactivarlas: no
--     tiene ni una fila con `active = 0`. Así no queda rastro de qué se dejó
--     de vender ni cuándo. NAT-L estaba el 2026-11-16 y el 2026-11-17 ya no.
--  3. Velvee está en el CRM vivo desde el 2026-11-12 y NO aparece en el
--     documento de la dueña que el repositorio usa como verdad escrita.

-- ---------------------------------------------------------------------------
-- 1 · Precios: manda el CRM
-- ---------------------------------------------------------------------------
-- Un precio que cambia se anota en `precios_historial`. Es el libro de los
-- precios: sin la fila, mañana nadie sabe que la tienda cobró $25.00 por algo
-- que valía $20.00, ni desde cuándo dejó de hacerlo.
INSERT INTO precios_historial (id, codigo, precio_cents, vigente_desde, cambiado_por, motivo)
  VALUES ('precio-esp20-dany600', 'DANY-AW600', 2000, unixepoch() * 1000, 'sistema',
          'Espejo del catálogo vivo del CRM (2026-11-17): el CRM vende a $20.00 y el sistema decía $25.00.');
INSERT INTO precios_historial (id, codigo, precio_cents, vigente_desde, cambiado_por, motivo)
  VALUES ('precio-esp20-dany1200', 'DANY-AW1200', 3500, unixepoch() * 1000, 'sistema',
          'Espejo del CRM (2026-11-17): la promoción de 2 cajas que el CRM anuncia son $35.00, no $40.00.');

UPDATE variantes SET
  precio_cents   = 2000,
  -- El empaque también estaba mal: el CRM dice 6 paquetes de 100 y el sistema
  -- decía 12 de 50. Son las mismas 600 toallitas, pero lo que la clienta
  -- recibe en la caja no es lo mismo, y es lo que va a reclamar.
  nombre         = 'Water wipes hipoalergénicas Dany Baby — caja de 600 toallitas (6 paquetes de 100)',
  version        = version + 1,
  actualizado_en = unixepoch() * 1000
WHERE codigo = 'DANY-AW600';

-- ---------------------------------------------------------------------------
-- 2 · La promoción de 2 cajas pasa a ser un COMBO
-- ---------------------------------------------------------------------------
-- Estaba como una variante suelta con existencias propias, y sus existencias
-- propias eran cero: por eso la tienda la daba por agotada aunque hubiera 28
-- cajas de las que la componen. Un combo no tiene existencias propias (ver
-- `0007_combos.sql`): de él caben tantos como permita el componente que menos
-- alcance, así que con 28 cajas de DANY-AW600 salen 14 promociones.
--
-- El orden importa: el trigger `combo_duenno_es_combo` exige que el dueño de
-- una receta ya sea un combo antes de meterle el primer componente.
UPDATE variantes SET
  es_combo       = 1,
  precio_cents   = 3500,
  nombre         = 'Water wipes hipoalergénicas Dany Baby — promoción de 2 cajas, 1,200 toallitas (12 paquetes de 100)',
  version        = version + 1,
  actualizado_en = unixepoch() * 1000
WHERE codigo = 'DANY-AW1200';

INSERT INTO combo_componentes (combo_codigo, codigo, cantidad)
  VALUES ('DANY-AW1200', 'DANY-AW600', 2);

-- La descripción de la tienda repetía el empaque viejo. Lo demás es texto de
-- la dueña y no se toca.
UPDATE productos SET
  descripcion = 'Toallitas de agua 99% pura, sin alcohol ni perfumes, ideales para recién nacidos. Caja de 6 paquetes de 100.'
WHERE id = 'prod-wip';

-- ---------------------------------------------------------------------------
-- 3 · Lo que el CRM ya no vende se despublica (no se borra)
-- ---------------------------------------------------------------------------
-- NAT-L no está en el catálogo del CRM. Se despublica —deja de ofrecerse en la
-- tienda y en el bot— pero se queda `activo = 1`: la fila sobrevive, su
-- historial sobrevive, y la dueña la vuelve a publicar con un toque en el
-- panel el día que reponga. Borrarla sería hacer lo que se le critica al CRM
-- tres párrafos más arriba.
UPDATE variantes SET
  publicado      = 0,
  version        = version + 1,
  actualizado_en = unixepoch() * 1000
WHERE codigo = 'NAT-L';

-- Y la cadena de «talla siguiente» tiene que saltarse la talla retirada, o la
-- recompra manda a la clienta a un artículo que ya no se vende. NAT-M apuntaba
-- a NAT-L; NAT-L apuntaba a NAT-XL.
UPDATE variantes SET
  siguiente_codigo = 'NAT-XL',
  version          = version + 1,
  actualizado_en   = unixepoch() * 1000
WHERE codigo = 'NAT-M';

-- ---------------------------------------------------------------------------
-- 4 · Los productos que el CRM vende y el sistema no conocía
-- ---------------------------------------------------------------------------
-- `descripcion` y `nombre_tienda` quedan como están: el título se pone porque
-- es el nombre de la marca y no hay nada que inventar, y la descripción se
-- queda en NULL porque el texto de venta lo escribe la dueña. El panel ya
-- avisa, fila por fila, cuál le falta; rellenarlo yo sería ponerle palabras en
-- la boca a su negocio.
INSERT INTO productos (id, familia, nombre, slug, marca, activo, orden, creado_en, nombre_tienda, descripcion)
  VALUES ('prod-vel', 'panal', 'Pañal Velvee', 'panales-velvee', 'Velvee', 1, 5, unixepoch() * 1000,
          'Pañales Velvee', NULL);
INSERT INTO productos (id, familia, nombre, slug, marca, activo, orden, creado_en, nombre_tienda, descripcion)
  VALUES ('prod-wnt', 'wipes', 'Water wipes Nateen', 'water-wipes-nateen', 'Nateen', 1, 6, unixepoch() * 1000,
          'Wipes de agua Nateen', NULL);

-- Los nombres son los del CRM tal cual (solo se juntaron los espacios dobles):
-- es el texto que el bot ya le dice a las clientas, y cambiarlo aquí haría que
-- el bot dijera una cosa antes del cambio y otra después.
--
-- La `talla` sí se normaliza a la del resto del catálogo: el CRM las llama P,
-- M y G, y la tienda tiene que poder comparar la M de Velvee con la M de
-- Nateen. La letra del CRM se conserva dentro del nombre.
--
-- `tasa_itbms_bp` va en 0 como las otras doce variantes, no en NULL: con NULL
-- el cálculo del total se niega a operar —a propósito— y el carrito se
-- quedaría roto justo en los artículos nuevos.
--
-- Y entran SIN PUBLICAR, la misma regla de `0003_carga_inicial.sql`: «mientras
-- `publicado` sea 0, la web y el bot no lo ofrecen, así que un catálogo a medio
-- cargar no se ve fuera». Aquí es literal — esta migración no carga las
-- existencias (sección 5), así que publicarlas ahora las pondría en la tienda
-- diciendo «agotado», que es exactamente el problema que vino a arreglar. Se
-- publican después del conteo, cuando ya tengan algo que ofrecer.
-- Van de la talla MAYOR a la menor, y no es cosmético: `siguiente_codigo`
-- lleva llave foránea a `variantes`, así que la P no puede apuntar a la M
-- antes de que la M exista. Insertarlas en el orden natural —P, M, L— falla
-- con «FOREIGN KEY constraint failed», que no dice ni cuál de las tres fue.
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
    unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, siguiente_codigo,
    es_combo, actualizado_en)
  VALUES ('VELVEE-L', 'prod-vel', 'Pañal Velvee Talla G (L): (20 - 27 lb) (9 - 12.5 kg) 126 pañales',
          'L', 20, 27, 126, 3300, 0, 0, 1, NULL, 0, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
    unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, siguiente_codigo,
    es_combo, actualizado_en)
  VALUES ('VELVEE-M', 'prod-vel', 'Pañal Velvee Talla M (M): (12 - 21 lb) (5.5 - 9.5 kg) 132 pañales',
          'M', 12, 21, 132, 3500, 0, 0, 1, 'VELVEE-L', 0, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
    unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, siguiente_codigo,
    es_combo, actualizado_en)
  VALUES ('VELVEE-P', 'prod-vel', 'Pañal Velvee Talla P (S): (7.5 - 13 lb) (3.5 - 6 kg) 150 pañales',
          'S', 7.5, 13, 150, 3500, 0, 0, 1, 'VELVEE-M', 0, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
    unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, siguiente_codigo,
    es_combo, actualizado_en)
  VALUES ('WIPESNAT', 'prod-wnt', 'Water wipes hipoalergénicas Nateen — Caja de 960 toallitas (12 paquetes de 80)',
          NULL, NULL, NULL, 960, 4500, 0, 0, 1, NULL, 0, unixepoch() * 1000);

-- La fila de existencias tiene que existir aunque vaya a quedar en cero:
-- `movimientos_inventario` lleva llave foránea a (codigo, bodega_id), así que
-- sin ella no se puede registrar ni la primera entrada. Mismo criterio que
-- `0003_carga_inicial.sql`.
INSERT INTO existencias (codigo, bodega_id, fisico, reservado, minimo)
  SELECT v.codigo, b.id, 0, 0, NULL
    FROM variantes v, bodegas b
   WHERE v.codigo IN ('VELVEE-P', 'VELVEE-M', 'VELVEE-L', 'WIPESNAT');

-- ---------------------------------------------------------------------------
-- 5 · Las existencias NO se cargan aquí
-- ---------------------------------------------------------------------------
-- Se intentó, y el repositorio tenía razón antes que yo.
--
-- `movimientos_inventario` es el libro del inventario y tiene dos triggers que
-- impiden editarlo y borrarlo. Una migración que escriba ahí deja la base de
-- las pruebas imposible de vaciar —`DELETE FROM existencias` choca con la
-- llave foránea del movimiento, y el movimiento no se puede borrar— y eso
-- rompió 64 pruebas de golpe.
--
-- No es un estorbo del esquema: es el diseño. `0003_carga_inicial.sql` ya lo
-- había dicho con todas las letras —«las existencias se cargan después, con un
-- conteo de verdad»— y para eso existen `registrar()` en `src/db/inventario.ts`
-- y la ruta `POST /existencias/movimientos`: validan, calculan el delta contra
-- lo que hay en ese momento, escriben el libro y dejan el asiento donde va.
-- Una migración se salta todo eso y además congela en SQL un número que
-- envejece desde el día en que se escribe.
--
-- Así que aquí solo queda la FILA en cero, que es lo que el libro necesita
-- para poder apuntar a ella (llave foránea a (codigo, bodega_id)); está al
-- final de la sección 4. El conteo contra el CRM entra por la ruta, en una
-- sola llamada con todos los renglones, y queda firmado por quien lo aprobó.

-- ---------------------------------------------------------------------------
-- 6 · Los productos de prueba salen del catálogo
-- ---------------------------------------------------------------------------
-- «PRUEBA — no vender (borrar)» y «PRUEBA 13» están en el catálogo real. No se
-- publican, así que nadie de fuera los ve, pero ensucian cada pantalla del
-- panel y cada conteo. Se desactivan, no se borran: `EWRTYFGUHIJ` tiene filas
-- de existencias y el día que alguien le registre un movimiento, borrar la
-- variante dejaría el libro apuntando a un producto que no existe.
UPDATE variantes SET
  publicado      = 0,
  activo         = 0,
  version        = version + 1,
  actualizado_en = unixepoch() * 1000
WHERE codigo = 'EWRTYFGUHIJ';

UPDATE productos SET activo = 0
 WHERE id IN ('01M7852J0BTAH4CNN35H7P2EX1', '01M7JG51N4669SMYK8J0754R4K');
