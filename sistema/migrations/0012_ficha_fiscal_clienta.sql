-- 0012_ficha_fiscal_clienta.sql · Lo que falta para cobrar con tarjeta y para
-- facturar
--
-- Hoy una clienta son tres datos: `nombre` —uno solo, con el apellido dentro—,
-- `celular_e164` y `correo`. Con eso se entrega un pedido y se cobra por Yappy,
-- y por eso nadie había echado en falta el resto. Las dos cosas que no alcanzan
-- son las que aún no se hacen:
--
-- 1. LA TARJETA. El `processPayment` de Tilopay exige los campos de
--    facturación, y los exige TODOS: nombre y apellido POR SEPARADO
--    (`billToFirstName`, `billToLastName`), correo, teléfono, la dirección en
--    dos líneas, ciudad, provincia EN ISO (`PA-8` y similares), código postal
--    y país (`PA`). Un `nombre` con todo dentro no se parte en dos de forma
--    fiable —«María de los Ángeles Villarreal Quintero» no tiene un sitio
--    obvio donde cortar— así que el apellido se guarda aparte o se adivina en
--    cada cobro.
--
-- 2. LA FACTURA DE LA DGI. La pasarela NO tiene campo de cédula, así que la
--    identificación fiscal jamás va a volver de ella: o vive aquí, o no existe
--    cuando haya que emitir. Y la factura se teclea a mano en el facturador
--    gratuito de la DGI, que no tiene API (docs/plan/00-revision.md, M3), así
--    que «prepararle los datos a quien teclea» es todo lo que el sistema puede
--    hacer — y no puede hacerlo con datos que no tiene.
--
-- PENDIENTE, y se dice en vez de rellenarse: el §4.2 de docs/plan/04-pagos.md
-- describe la integración de Tilopay (credenciales, consulta, comisiones) pero
-- NO lista sus campos de facturación. Hay que copiarlos ahí desde su
-- documentación, con los DOS que aquí no se nombran: de los doce obligatorios
-- se conocen diez, y los otros dos no se inventan.
--
-- TODO LO NUEVO NACE NULO Y PUEDE QUEDARSE NULO
--
-- Ya hay clientas en la base sin ninguno de estos datos: una columna NOT NULL
-- reventaría la migración, y un DEFAULT los daría por sabidos. Aquí NULL
-- significa «todavía no se lo hemos preguntado», que es distinto de «no tiene»
-- — y la pantalla de Clientas lo dice con esas palabras.
--
-- Nada de esto se le pregunta a la clienta en el chat ni en la web: se llena
-- desde el panel, cuando haga falta cobrar con tarjeta o emitir una factura.

-- ---------------------------------------------------------------------------
-- La clienta
-- ---------------------------------------------------------------------------

-- El apellido aparte del nombre. `nombre` NO se toca ni se reparte: lo que hay
-- escrito ahí es lo que la dueña reconoce al leerlo, y partirlo con un guion
-- automático acertaría en «Ana Gómez» y fallaría en la mitad de los nombres
-- panameños, que llevan dos apellidos y a veces un «de».
ALTER TABLE clientes ADD COLUMN apellido TEXT;

-- La cédula o el RUC, tal cual se escriben. SIN validación de formato: la
-- cédula panameña tiene formas muy distintas (`8-123-4567`, `PE-12-345`,
-- `E-8-12345`, `N-20-1234`) y el RUC lleva DV. Una expresión regular escrita de
-- memoria rechazaría a una clienta de verdad, y ese fallo se descubre con ella
-- esperando. PENDIENTE: si la dueña quiere que el sistema compruebe el DV, hace
-- falta la regla de la DGI escrita, no una aproximación.
ALTER TABLE clientes ADD COLUMN identificacion TEXT;

-- Qué es ese número. Hace falta para la factura: no se factura igual a una
-- persona con cédula que a una empresa con RUC, y «8-123-4567» no se distingue
-- de un RUC mirándolo.
--
-- NULL pasa el CHECK —en SQLite un CHECK solo falla si da FALSO, y
-- `NULL IN (...)` da NULL—, que es justo lo que se quiere: «todavía no se sabe».
--
-- Solo los dos valores que pidió el encargo. No se añade «pasaporte» por si
-- acaso: una clienta extranjera con pasaporte es un caso que nadie ha
-- confirmado, y el precio de equivocarse al revés también se dice aquí —
-- ensanchar un CHECK en SQLite obliga a recrear la tabla, y `clientes` tiene
-- llaves foráneas apuntándole.
ALTER TABLE clientes ADD COLUMN identificacion_tipo TEXT
  CHECK (identificacion_tipo IN ('cedula', 'ruc'));

-- ---------------------------------------------------------------------------
-- La dirección
-- ---------------------------------------------------------------------------
--
-- `texto` y `referencia` SE QUEDAN, y se quedan siendo lo principal: son lo que
-- el motorizado lee para llegar a la puerta, y ninguna de las columnas nuevas
-- sirve para eso. En el cobro con tarjeta hacen de las dos líneas de dirección
-- (`billToAddress` y `billToAddress2`), así que tampoco hacía falta inventarlas
-- otra vez.
--
-- La zona (`zona_id`) tampoco se toca: es quien manda la tarifa de envío, y
-- «ciudad» no es un sustituto suyo — son dos preguntas distintas («¿cuánto
-- cuesta llevarlo?» y «¿qué pone en la factura?»).

ALTER TABLE direcciones ADD COLUMN ciudad TEXT;

-- La provincia EN ISO 3166-2 (`PA-8` es Panamá), porque es como la pide la
-- pasarela. Sin CHECK a propósito: la lista de códigos vive en
-- `src/dominio/direccion.ts`, junto a la de nombres de provincia que ya
-- existía, y cuál acepta Tilopay exactamente está PENDIENTE de confirmar con
-- ellos. Corregir un código tiene que costar una línea de código, no una
-- migración que recrea la tabla.
ALTER TABLE direcciones ADD COLUMN provincia_iso TEXT;

-- Panamá no usa código postal para entregar, pero la pasarela lo pide igual.
-- Queda NULL hasta que alguien lo escriba: un «0000» inventado es una cifra a
-- ojo con aspecto de dato.
ALTER TABLE direcciones ADD COLUMN codigo_postal TEXT;

-- El país en ISO de dos letras (`PA`). Sin DEFAULT: poner 'PA' aquí lo
-- afirmaría de todas las direcciones que ya existen, y una afirmación que nadie
-- ha hecho es justo lo que no debe entrar en la base. Lo propone la pantalla al
-- escribir una dirección nueva, que es otra cosa.
ALTER TABLE direcciones ADD COLUMN pais TEXT;
