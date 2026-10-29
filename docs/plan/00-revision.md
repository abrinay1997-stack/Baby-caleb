# Revisión del plan v1: fallos y huecos

Revisión del plan del 28-oct contra el código de los cuatro repositorios y la documentación de
Cloudflare consultada el 29-oct. Cada punto dice qué estaba mal o faltaba, por qué importa y dónde
queda resuelto en la v2.

- **Grave**: con el plan v1 eso no funciona o pierde datos o dinero.
- **Importante**: funciona, pero deja un hueco que tarde o temprano cuesta.
- **Menor**: omisión que conviene dejar escrita.

## Graves

### G1. El aviso «sistema → CRM por HTTPS con llave» falla en la misma cuenta

La v1 copió el regreso de Odoo a Juan de D'Casa (HTTPS + token). Pero Odoo corre en un contenedor;
aquí los dos lados son Workers, y una llamada de un Worker a otro por su URL pública dentro de la
misma cuenta devuelve el error 1042. El CRM ya lo dejó escrito para su puente
(`CRM-Baby-Caleb/src/env.ts`: «Worker a Worker por URL pública da error 1042»). Con la decisión D-03
(todo en la cuenta de la agencia) la flecha de la v1 no funcionaría.

**v2:** el CRM llama al sistema por service binding RPC; el sistema le habla al CRM por una
**Cloudflare Queue** (`bc-avisos`), con reintentos y cola de mensajes muertos. Así no hay bindings
circulares (un binding exige que el destino exista antes del primer despliegue) y un aviso no se
pierde si el CRM está caído. → [`01-arquitectura.md` §4](01-arquitectura.md#4-los-cables-entre-piezas)

### G2. D1 no tiene transacciones interactivas

El pedido atómico de Nébula es una función de PostgreSQL que bloquea filas, lee el stock, decide y
escribe. En D1, `db.batch()` es una transacción (todo o nada, en orden), pero no deja leer y decidir
a mitad de camino, y no hay `BEGIN/COMMIT` desde el Worker. Portar el pedido «tal cual» vende la
última caja dos veces.

**v2:** la base impide el error y no el código: `CHECK (reservado <= fisico)` y
`CHECK (fisico >= 0)` en `existencias`; el pedido, sus líneas, sus reservas y su evento de salida
van en un solo `batch`; si una línea dejaría el stock en negativo, la restricción tumba el batch
entero. El número de pedido sale de una tabla `secuencias` actualizada dentro del mismo batch.
→ [`02-datos.md` §3](02-datos.md#3-inventario)

### G3. Cloudflare Access no basta para cerrar el panel

Access protege el dominio, pero la URL `*.workers.dev` del Worker y sus URLs de vista previa siguen
públicas mientras no se apaguen (`workers_dev = false`) o se protejan aparte. Si se apaga solo en
el panel de Cloudflare, el siguiente `wrangler deploy` la vuelve a encender. Además, los webhooks de
las pasarelas no pueden quedar detrás de Access, porque Yappy o PayPal no inician sesión.

**v2:** el Worker valida el token de Access (`Cf-Access-Jwt-Assertion`) contra los certificados del
equipo y falla cerrado (como `D_Casa_new_word/edge/src/puerta.ts`); `workers_dev = false` en
producción; staging protegido con Access; los webhooks entran por la web (`/api/pagos/*`) y pasan
al sistema por binding. → [`07-seguridad.md` §2](07-seguridad.md#2-cloudflare-access-en-el-panel)

### G4. «El celular es la llave» no sirve para todas las clientas

Por Instagram, Messenger y Telegram la clienta llega con un ID del canal, no con celular
(`conversations.channel_user_id` en el CRM). Con el celular como única llave, esas clientas no
tienen ficha o se duplican.

**v2:** tabla `identidades (canal, id_externo) → cliente_id`; el celular es opcional y único cuando
existe; dos fichas se fusionan con registro cuando aparece el mismo celular.
→ [`02-datos.md` §4](02-datos.md#4-clientes)

### G5. Los enlaces compartidos de la web siempre muestran la portada

`src/components/Seo.tsx` cambia título y metadatos con JavaScript. WhatsApp, Facebook, Instagram y
el catálogo de Meta leen el HTML sin ejecutar JavaScript, así que cualquier enlace muestra los datos
de `index.html`. Las fichas de producto que pide Meta y el SEO no existen.

**v2:** el Worker de la web reescribe el `<head>` por ruta con `HTMLRewriter` (título, descripción,
Open Graph, JSON-LD de `Product` con precio del sistema) sin tocar el diseño ni pasar a SSR, y se
agrega la ficha `/productos/:slug` con los bloques que ya existen.
→ [`01-arquitectura.md` §3](01-arquitectura.md#3-dominios-y-rutas)

### G6. Los avisos de pedido por el puente QR arriesgan el número

La v1 mandaba «pedido agendado, en camino, entregado» por el canal de la clienta. Para quien
escribió por WhatsApp eso es el puente QR, que no es la API oficial: el propio CRM advierte que
WhatsApp puede banear el número. Mensajes salientes en volumen, fuera de una conversación abierta,
son justo lo que dispara un baneo.

**v2:** los avisos fuera de una conversación abierta salen por la Cloud API oficial con plantillas
de categoría utilidad (el CRM ya manda plantillas: tabla `template_sends`, tope
`WA_DAILY_TEMPLATE_CAP`); dentro de una conversación abierta en las últimas 24 h, por el canal donde
está la clienta. Cada plantilla se aprueba en Meta y tiene costo por mensaje.
→ [`03-contratos.md` §4](03-contratos.md#4-eventos-de-cola)

### G7. Pagos cobrados que el sistema no ve

Si la clienta paga y el aviso de la pasarela no llega (o cierra el navegador antes de volver), el
pedido se queda «por abonar» con el dinero cobrado. La v1 no tenía nada para eso. Peor: la API de
página de pago alojada de Tilopay (`processPayment`) no documenta un webhook; el resultado vuelve en
la redirección y se confirma consultando (`consult`).

**v2:** un conciliador cada 10 minutos consulta a la pasarela todo intento en «confirmando» con más
de 15 minutos. Para Tilopay la consulta es el mecanismo principal, no un respaldo.
→ [`04-pagos.md` §6](04-pagos.md#6-el-conciliador-de-pagos)

### G8. El abono se contaba como venta

La v1 heredaba de Nébula «ingreso es el dinero que entró». Un abono de $5 antes de entregar es un
**anticipo** (un pasivo: se le debe la mercancía a la clienta), no una venta. Contado como venta,
un pedido cancelado deja una venta fantasma y el mes cierra con ventas que no existieron.

**v2:** contabilidad en partida doble interna (la dueña ve pantallas simples): el abono va a
«Anticipos de clientes», la venta se reconoce al entregar, y el costo de lo vendido sale en ese
mismo momento. → [`05-contabilidad.md` §3](05-contabilidad.md#3-asientos-automáticos)

## Importantes

| # | Hueco | Resolución v2 |
|---|---|---|
| I1 | Sin **saldos de apertura** (inventario valorizado, dinero en cada cuenta) los reportes arrancan mal | Fecha de corte el día 1 de un mes, conteo físico y asiento de apertura → [05 §7](05-contabilidad.md#7-arranque-contable) |
| I2 | El costo real de una caja importada incluye flete, aduana, impuestos y acarreo; sin prorratearlos la ganancia sale inflada | `compras_proveedor` con gastos de importación prorrateados por valor → [05 §4](05-contabilidad.md#4-costo-promedio-y-prorrateo) |
| I3 | El saldo que cobra el motorizado no está en ninguna cuenta hasta que lo entrega | Cuenta «Caja del motorizado» por persona y liquidación diaria → [05 §3](05-contabilidad.md#3-asientos-automáticos) |
| I4 | Tilopay y PayPal depositan neto de comisión y otro día; no cuadra con los cobros brutos | Cuentas puente «Por liquidar» y conciliación de liquidaciones → [04 §8](04-pagos.md#8-comisiones-y-liquidaciones) |
| I5 | Faltaban devoluciones, reembolsos y contracargos | Flujos y asientos propios → [04 §7](04-pagos.md#7-reembolsos-y-contracargos) |
| I6 | El CRM tiene 3 bodegas pero no traslados ni conteo físico | Movimientos `traslado_salida`/`traslado_entrada` y `conteo` → [02 §3](02-datos.md#3-inventario) |
| I7 | No se decía de qué bodega sale cada pedido | Bodega por zona de envío, editable en el pedido → [02 §5](02-datos.md#5-envíos) |
| I8 | Pedidos web sin pagar apartaban stock para siempre | Reserva con vencimiento y cron que la libera → [04 §5](04-pagos.md#5-reservas-y-vencimientos) |
| I9 | Un número de pedido secuencial en un enlace expone el historial (Nébula lo aprendió) | Número legible `BC-000123` + token aleatorio de 256 bits para enlaces → [02 §6](02-datos.md#6-pedidos) |
| I10 | Doble clic en «Pagar», doble toque en Telegram, reintentos de webhooks y de la cola | Claves de idempotencia y eventos con índice único → [03 §5](03-contratos.md#5-idempotencia-y-errores) |
| I11 | El CRM reaplica `schema.sql` entero: sirve para crear, no para cambiar columnas | Migraciones versionadas de D1 con política expandir → migrar → contraer → [08 §3](08-operacion.md#3-migraciones) |
| I12 | «Sano» no puede ser un 200 (incidente #97 de D'Casa) | `/salud` con versión, última migración y prueba de humo → [08 §5](08-operacion.md#5-salud-y-observabilidad) |
| I13 | Las teselas públicas de OpenStreetMap no permiten producción (fallo abierto en Nébula); el tarifario es por nombre de zona, no por polígono | Mapa con Protomaps (PMTiles) en R2; el pin es para el motorizado, la zona la elige la clienta → [01 §6](01-arquitectura.md#6-mapa-y-direcciones) |
| I14 | `content.json` no tiene códigos de producto: «Caja M» no se puede unir con `NAT-M` | Campo `codigo` en cada variante y prueba que lo exige → [03 §2](03-contratos.md#2-sistemaweb-lo-que-la-web-puede-pedir) |
| I15 | El CRM tiene `NAT-WIP` (viejo) y `WIPESNAT` (vigente) en archivos distintos | El traspaso usa `DESCATALOGADOS` de `test/babycaleb/verdad-del-cliente.ts` → [09 F3](09-fases.md#f3--un-dato-un-solo-dueño-semanas-46) |
| I16 | Datos personales sin plan: Ley 81 de 2019 de Panamá | Inventario de datos, consentimiento, retención, anonimización → [07 §6](07-seguridad.md#6-datos-personales-ley-81-de-2019) |
| I17 | Meta pide verificar el dominio; el correo del dominio no estaba | TXT de Meta, Email Routing para `hola@babycaleb.com`, SPF/DKIM/DMARC si se envía → [08 §8](08-operacion.md#8-dns-y-correo) |
| I18 | Apagar una pasarela o el carrito exigía desplegar | Interruptores en `ajustes`, editables desde el panel con historial → [02 §9](02-datos.md#9-sistema) |
| I19 | `reglas.json` en el repo obligaba a desplegar para cambiar el abono mínimo | Valores de fábrica en JSON + capa editable con versión y vigencia (patrón `dcasa.vend.reglas`) → [02 §9](02-datos.md#9-sistema) |
| I20 | Los motorizados no siempre tienen correo para Access | Hostname aparte `ruta.babycaleb.com` con celular + PIN → [07 §3](07-seguridad.md#3-motorizados-y-clientas) |
| I21 | El código de «Mi cuenta» por WhatsApp no puede ir por el puente QR | Plantilla de autenticación de la Cloud API, o PIN → [07 §3](07-seguridad.md#3-motorizados-y-clientas) |
| I22 | La preselección de herramientas de Brian cambia la lista en cada mensaje y rompe la caché de prompts | Herramientas completas en orden fijo y cacheadas; fecha y pantalla al final → [06 §6](06-asistente.md#6-modelo-costo-y-caché) |
| I23 | El costo de IA (~$2–5) solo vale para un modelo de gama Haiku | Tabla de costos por modelo; la elección es de la dueña → [06 §6](06-asistente.md#6-modelo-costo-y-caché) |
| I24 | El CRM y el sistema están en repos distintos: un cambio de contrato rompe al otro sin aviso | Esquemas zod copiados con huella y pruebas de contrato en los dos CI → [03 §6](03-contratos.md#6-versionado-y-pruebas-de-contrato) |
| I25 | Mover el catálogo mientras la dueña registra ventas puede perder un movimiento | Ventana de congelamiento con interruptor, verificación y vuelta atrás → [08 §7](08-operacion.md#7-runbooks) |
| I26 | Time Travel restaura toda la base encima de la actual (30 días) | Exportación diaria cifrada a R2 y simulacro semanal en una base aparte → [08 §4](08-operacion.md#4-respaldos-y-restauración) |
| I27 | El rate limiting de Workers es aproximado y por ubicación | Candados de PIN y código en D1; el binding solo frena abuso → [07 §4](07-seguridad.md#4-superficie-pública-de-la-web) |
| I28 | `_headers` no se aplica a respuestas que genera el Worker | Cabeceras de seguridad del HTML reescrito puestas en el código → [07 §5](07-seguridad.md#5-cabeceras) |
| I29 | La web tiene `bun.lock` y `package-lock.json` | Se queda npm; se borra `bun.lock` → [09 F0](09-fases.md#f0--cimientos-semana-1) |
| I30 | La v1 mezclaba en un solo diagrama el estado del pedido y el del pago | Dos máquinas de estado separadas (patrón de Nébula) → [02 §6](02-datos.md#6-pedidos) |
| I31 | `compras` ya existe en el CRM (marca «compró» de una clienta) | En el sistema se llama `compras_proveedor` → [02 §8](02-datos.md#8-compras-y-gastos) |
| I32 | Envíos al interior (Ferguson) no tenían flujo | Método de entrega aparte: pago total antes y tarifa cotizada a mano → [02 §5](02-datos.md#5-envíos) |
| I33 | Las pasarelas no tenían plan B si se caen | Interruptor + flujo de comprobante por WhatsApp siempre disponible → [08 §7](08-operacion.md#7-runbooks) |
| I34 | Una sola persona sabe cómo funciona todo | Léeme, prioridades, contexto agéntico, contratos y runbooks en el repo → [08 §9](08-operacion.md#9-documentos-vivos) |

## Menores

| # | Omisión | Resolución v2 |
|---|---|---|
| M1 | La web no promete fechas, igual que el revisor del CRM | Ventanas de entrega definidas por la dueña en `ajustes` |
| M2 | Promociones y cupones no estaban | Fase 7, con la validación no enumerable de Nébula (`validate_discount`) |
| M3 | Factura electrónica: no se sabe si aplica | Pregunta a la contadora; adaptador vacío, nunca un PAC inventado |
| M4 | Avisos al equipo de pedido nuevo y pago confirmado | Por la consola de Telegram existente, vía `bc-avisos` |
| M5 | Analítica de la web | Cloudflare Web Analytics (sin cookies) desde F1; píxel de Meta en F7 |
| M6 | 15 semanas sin holgura y con trámites externos | 17 semanas con margen y dependencias explícitas → [09](09-fases.md) |
| M7 | Todo en la cuenta de la agencia: riesgo el día que el negocio quiera llevárselo | Procedimiento de traspaso documentado → [10](10-riesgos-y-decisiones.md) |
| M8 | Presupuesto de rendimiento para lo nuevo de la web | Carrito y fichas cargados bajo demanda; Lighthouse en CI → [08 §2](08-operacion.md#2-cicd) |
| M9 | Contrato de servicio entre el bot y la web (qué responde el chat de la web) | El canal web del CRM usa la misma KB, el mismo revisor y el trato de usted |

## Lo que se mantiene de la v1

La decisión de repo, el CRM aparte, Nébula como donante y D'Casa como manual siguen en pie. Lo que
cambia es cómo se conectan las piezas (colas y RPC en vez de HTTPS), cómo se garantiza el stock sin
transacciones interactivas, cómo se cuenta el dinero (partida doble interna) y todo lo que faltaba
alrededor de pagos, seguridad y operación.
