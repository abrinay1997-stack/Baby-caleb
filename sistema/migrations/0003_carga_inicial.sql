-- 0003_carga_inicial.sql · El catálogo, las bodegas y las zonas de verdad
--
-- F3.1 de docs/plan/09-fases.md. GENERADO leyendo las fuentes de verdad del
-- CRM, no transcrito a mano: 45 zonas copiadas a ojo es un error garantizado.
--
-- De dónde sale cada cosa:
--   bodegas  ← SUCURSALES de CRM-Baby-Caleb/src/catalog/validation.ts
--   nombres  ← CRM-Baby-Caleb/src/db/verdad-2026-09.sql
--   precios  ← CRM-Baby-Caleb/test/babycaleb/verdad-del-cliente.ts, que es la
--              transcripción de PREGUNTAS_BABY_CALEB_usted.docx (2026-09)
--   pesos    ← TALLAS del mismo archivo
--   zonas    ← CRM-Baby-Caleb/member/zonas-envio.ts, con sus alias
--
-- TODO ENTRA EN CERO Y SIN PUBLICAR. Las existencias se cargan después, con un
-- conteo de verdad: inventar un número aquí sería exactamente lo que este
-- sistema existe para no volver a hacer. Y mientras `publicado` sea 0, la web
-- y el bot no lo ofrecen, así que un catálogo a medio cargar no se ve fuera.
--
-- El ITBMS queda en NULL = PENDIENTE a propósito (pregunta P4 del plan). Con
-- NULL, `precios.ts` se niega a calcular un total en vez de inventar un
-- impuesto: el precio sale mal y ruidoso, no mal y callado.

-- ---------------------------------------------------------------------------
-- Bodegas
-- ---------------------------------------------------------------------------
-- Los ids son legibles a propósito: se leen en la bitácora y en los
-- movimientos de inventario durante años.
INSERT INTO bodegas (id, nombre, activa) VALUES ('bod-1', 'Bodega Ciudad de Panamá', 1);
INSERT INTO bodegas (id, nombre, activa) VALUES ('bod-2', 'Bodega Panamá Oeste', 1);
INSERT INTO bodegas (id, nombre, activa) VALUES ('bod-3', 'Bodega Ciudad de Panamá Este Línea 2', 1);

-- ---------------------------------------------------------------------------
-- Productos
-- ---------------------------------------------------------------------------
INSERT INTO productos (id, familia, nombre, slug, marca, activo, orden, creado_en)
  VALUES ('prod-pan', 'panal', 'Pañal Nateen de cierre', 'panales-nateen-cierre', 'Nateen', 1, 1, unixepoch() * 1000);
INSERT INTO productos (id, familia, nombre, slug, marca, activo, orden, creado_en)
  VALUES ('prod-pts', 'pants', 'Pañal Nateen pants', 'panales-nateen-pants', 'Nateen', 1, 2, unixepoch() * 1000);
INSERT INTO productos (id, familia, nombre, slug, marca, activo, orden, creado_en)
  VALUES ('prod-wip', 'wipes', 'Water wipes Dany Baby', 'water-wipes-dany-baby', 'Dany Baby', 1, 3, unixepoch() * 1000);
INSERT INTO productos (id, familia, nombre, slug, marca, activo, orden, creado_en)
  VALUES ('prod-por', 'portabebe', 'Fular prearmado Moon', 'fular-prearmado-moon', 'Moon', 1, 4, unixepoch() * 1000);

-- ---------------------------------------------------------------------------
-- Variantes
-- ---------------------------------------------------------------------------
-- `siguiente_codigo` es la talla de después: con eso el sistema sabe qué
-- ofrecer cuando a una clienta se le queda chica la que compra. Se pone en
-- un UPDATE aparte porque apunta a filas de esta misma tabla.
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-RN', 'prod-pan', 'Pañal Nateen Talla RN de cierre — caja de 160 (4–11 lbs / 2–5 kg)', 'RN', 4, 11, 160, 5000, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-S', 'prod-pan', 'Pañal Nateen Talla S de cierre — caja de 160 (6–13 lbs / 3–6 kg)', 'S', 6, 13, 160, 5000, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-M', 'prod-pan', 'Pañal Nateen Talla M de cierre — caja de 144 (8–19 lbs / 4–9 kg)', 'M', 8, 19, 144, 5000, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-L', 'prod-pan', 'Pañal Nateen Talla L de cierre — caja de 128 (15–39 lbs / 7–18 kg)', 'L', 15, 39, 128, 4500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-XL', 'prod-pan', 'Pañal Nateen Talla XL de cierre — caja de 112 (26–55 lbs / 12–25 kg)', 'XL', 26, 55, 112, 4500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-XXL', 'prod-pan', 'Pañal Nateen Talla XXL de cierre — caja de 112 (+55 lbs / +25 kg)', 'XXL', 55, NULL, 112, 4500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-P-L', 'prod-pts', 'Pañal Nateen Talla L de pants — caja de 160 (15–39 lbs / 7–18 kg)', 'L', 15, 39, 160, 5500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-P-XL', 'prod-pts', 'Pañal Nateen Talla XL de pants — caja de 160 (26–55 lbs / 12–25 kg)', 'XL', 26, 55, 160, 5500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('NAT-P-XXL', 'prod-pts', 'Pañal Nateen Talla XXL de pants — caja de 160 (+55 lbs / +25 kg)', 'XXL', 55, NULL, 160, 5500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('DANY-AW1200', 'prod-wip', 'Water wipes hipoalergénicas Dany Baby — 1,200 toallitas (24 paquetes de 50)', NULL, NULL, NULL, 1200, 4000, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('DANY-AW600', 'prod-wip', 'Water wipes hipoalergénicas Dany Baby — caja de 600 toallitas (12 paquetes de 50)', NULL, NULL, NULL, 600, 2500, NULL, 0, 1, 1, unixepoch() * 1000);
INSERT INTO variantes (codigo, producto_id, nombre, talla, peso_min_lb, peso_max_lb,
  unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version, actualizado_en)
  VALUES ('MOON-FUL', 'prod-por', 'Fular prearmado Moon de bambú — unitalla ajustable XS a 3XL (RN hasta ~25 lbs)', 'Unitalla', NULL, NULL, 1, 4600, NULL, 0, 1, 1, unixepoch() * 1000);

UPDATE variantes SET siguiente_codigo = 'NAT-S' WHERE codigo = 'NAT-RN';
UPDATE variantes SET siguiente_codigo = 'NAT-M' WHERE codigo = 'NAT-S';
UPDATE variantes SET siguiente_codigo = 'NAT-L' WHERE codigo = 'NAT-M';
UPDATE variantes SET siguiente_codigo = 'NAT-XL' WHERE codigo = 'NAT-L';
UPDATE variantes SET siguiente_codigo = 'NAT-XXL' WHERE codigo = 'NAT-XL';
UPDATE variantes SET siguiente_codigo = 'NAT-P-XL' WHERE codigo = 'NAT-P-L';
UPDATE variantes SET siguiente_codigo = 'NAT-P-XXL' WHERE codigo = 'NAT-P-XL';
UPDATE variantes SET siguiente_codigo = 'DANY-AW600' WHERE codigo = 'DANY-AW1200';

-- ---------------------------------------------------------------------------
-- Existencias: una fila por variante y bodega, TODAS EN CERO
-- ---------------------------------------------------------------------------
-- La fila tiene que existir aunque esté en cero: `movimientos_inventario`
-- lleva llave foránea a (codigo, bodega_id), así que sin ella no se puede
-- registrar ni la primera entrada.
INSERT INTO existencias (codigo, bodega_id, fisico, reservado, minimo)
  SELECT v.codigo, b.id, 0, 0, NULL FROM variantes v, bodegas b;

-- ---------------------------------------------------------------------------
-- Zonas de envío
-- ---------------------------------------------------------------------------
-- Tarifas en centavos. Los alias son las otras formas en que una clienta
-- escribe el sitio («loteria» por «La Lotería»): sin ellos, la búsqueda
-- falla justo con quien escribe sin tildes, que son casi todas.
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-001', '12 de Octubre', '["doce de octubre"]', 'ciudad', 'motorizado', 300, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-002', 'Betania', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-003', 'Bella Vista', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-004', 'Calle 50', '["calle cincuenta"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-005', 'Condado del Rey', '["condado"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-006', 'Fernández de Córdoba', '["fernandez cordoba"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-007', 'Iglesia del Carmen', '["el carmen"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-008', 'Ingenio', '["el ingenio"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-009', 'La Lotería', '["loteria"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-010', 'Los Andes', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-011', 'Albrook Mall', '["albrook"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-012', 'Multiplaza', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-013', 'Obarrio', '["el obarrio"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-014', 'Paitilla', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-015', 'Punta Pacífica', '["punta pacifica"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-016', 'San Francisco', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-017', 'San Miguelito', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-018', 'Santo Tomás', '["hospital santo tomas"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-019', 'Tumba Muerto', '[]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-020', 'Vía Argentina', '["via argentina"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-021', 'Vía Brasil', '["via brasil"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-022', 'Vía España', '["via espana"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-023', '5 de Mayo', '["cinco de mayo"]', 'ciudad', 'motorizado', 400, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-024', 'Brisas del Golf', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-025', 'Chanis', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-026', 'Coco del Mar', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-027', 'Crisol', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-028', 'Diablo', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-029', 'Juan Díaz', '["juan diaz"]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-030', 'Metromall', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-031', 'Parque Lefevre', '["lefevre"]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-032', 'Río Abajo', '["rio abajo"]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-033', 'San Isidro', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-034', 'Villa Lucre', '[]', 'ciudad', 'motorizado', 500, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-035', 'Cerro Viento', '[]', 'ciudad', 'motorizado', 600, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-036', 'Pedregal', '[]', 'ciudad', 'motorizado', 600, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-037', 'Brisas', '[]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-038', 'Ciudad Radial', '[]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-039', 'Concepción', '["concepcion"]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-040', 'Don Bosco', '[]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-041', 'Las Acacias', '[]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-042', 'Mañanitas', '["mananitas", "las mananitas"]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-043', 'Villa Zaita', '[]', 'ciudad', 'motorizado', 700, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-044', '24 de Diciembre', '["veinticuatro de diciembre"]', 'ciudad', 'motorizado', 800, 0, 'bod-1', 1, unixepoch() * 1000);
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-045', 'Tocumen', '[]', 'ciudad', 'motorizado', 800, 0, 'bod-1', 1, unixepoch() * 1000);

-- Panamá Oeste no tiene tarifa fija: el documento dice «de $3 a $6 según la
-- distancia» ($3.00–$6.00). No se inventa un punto medio — con
-- `tarifa_cents` en NULL el sistema reconoce la zona y pasa con una persona,
-- que es lo que hace la dueña. Sus alias son todas las formas del documento.
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-oeste', 'Panamá Oeste', '["Arraiján", "Arraijan", "La Chorrera", "Chorrera", "Panama Oeste"]', 'ciudad', 'motorizado', NULL, 0, 'bod-2', 1, unixepoch() * 1000);

-- El interior va por Ferguson y se paga completo antes de despachar: la caja
-- sale de la ciudad y ya no vuelve. El motorizado cobra $2.50 por llevarla
-- a Ferguson, y eso es aparte de lo que cobre Ferguson por el envío, que no
-- lo pone Baby Caleb. Por eso `tarifa_cents` es NULL y no 250.
INSERT INTO zonas_envio (id, nombre, alias_json, region, metodo, tarifa_cents,
  requiere_pago_total, bodega_preferida_id, activa, actualizado_en)
  VALUES ('zon-interior', 'Interior (por Ferguson)', '["interior", "ferguson", "encomienda", "provincia"]', 'interior', 'ferguson', NULL, 1, 'bod-1', 1, unixepoch() * 1000);

-- Descatalogados del documento, que por eso NO están arriba:
--   NAT-WIP
