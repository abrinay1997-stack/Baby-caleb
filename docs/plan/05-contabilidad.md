# 05 · Contabilidad

## 1. Alcance

Contabilidad **gerencial** con partida doble por dentro: la dueña ve pantallas simples (cuánto
entró, cuánto debo, cuánto gané) y el sistema registra cada hecho en asientos que siempre cuadran.
No reemplaza a la contadora ni declara impuestos. Inspirada en `dcasa_contabilidad`
(`D_Casa_new_word/docs/CONTABILIDAD.md`), sin su peso: no hay plan contable oficial completo, ni
consolidación, ni nómina.

Por qué partida doble y no un «libro de caja»: con un libro de caja no se pueden representar a la
vez los anticipos de clientas, lo que cobra el motorizado, lo que retienen las pasarelas, el
inventario y lo que se le debe al proveedor. Con asientos de dos columnas sí, y el balance cuadra
solo.

## 2. Plan de cuentas mínimo

| Código | Cuenta | Tipo | Notas |
|---|---|---|---|
| 1101 | Yappy Comercial (Banco General) | activo · yappy | |
| 1102 | Banco (cuál: PENDIENTE) | activo · banco | |
| 1103 | Efectivo en caja | activo · efectivo | |
| 1104-xx | Caja de cada motorizado | activo · caja_motorizado | Una subcuenta por persona |
| 1105 | Por liquidar Tilopay | activo · por_liquidar | |
| 1106 | Por liquidar PayPal | activo · por_liquidar | |
| 1201 | Cuentas por cobrar a clientas | activo · por_cobrar | Saldos de pedidos entregados |
| 1301 | Inventario | activo · inventario | Al costo puesto en bodega |
| 2101 | Anticipos de clientas | pasivo | Abonos de pedidos aún no entregados |
| 2102 | Cuentas por pagar a proveedores | pasivo | |
| 2201 | ITBMS por pagar | pasivo | Solo si la contadora confirma que aplica |
| 3101 | Capital | patrimonio | Apertura y aportes |
| 3201 | Resultados acumulados | patrimonio | |
| 4101 | Ventas | ingreso | Sin ITBMS |
| 4102 | Ingresos por envío | ingreso | |
| 4901 | Devoluciones y descuentos | ingreso (contra) | |
| 5101 | Costo de lo vendido | costo | |
| 5201 | Mermas, muestras y regalos | costo | |
| 6101 | Publicidad | gasto | Meta Ads y demás |
| 6102 | Motorizados y envíos | gasto | |
| 6103 | Comisiones de pasarelas | gasto | |
| 6104 | Empaques | gasto | |
| 6105 | Software e IA | gasto | Cloudflare, proveedor de IA, dominio |
| 6199 | Otros gastos | gasto | |

Criterio de D'Casa que se adopta (`docs/LEEME_PRIMERO.md` de D'Casa, «Criterio contable»): ventas,
costo y ganancia **sin ITBMS**; el dinero que se mueve (cobrado, por cobrar, caja) **con ITBMS**.

## 3. Asientos automáticos

Cada hecho genera su asiento en el mismo batch que el hecho. Montos en centavos; `T` = total del
pedido, `S` = subtotal, `E` = envío, `I` = ITBMS (0 mientras sea PENDIENTE), `A` = lo abonado antes
de entregar, `C` = costo promedio × unidades.

| # | Hecho | Debe | Haber |
|---|---|---|---|
| 1 | Abono o pago antes de entregar, por Yappy o manual | 1101 / 1102 / 1103 (monto) | 2101 Anticipos |
| 2 | Pago aprobado por Tilopay o PayPal | 1105 / 1106 (bruto) | 2101 Anticipos |
| 3 | Entrega del pedido | 2101 (A) + 1201 (T − A) | 4101 (S − descuento) + 4102 (E) + 2201 (I) |
| 3b | Costo de la entrega | 5101 (C) | 1301 (C) |
| 4 | El motorizado cobra el saldo en efectivo | 1104-xx | 1201 |
| 4b | El motorizado cobra el saldo por Yappy | 1101 | 1201 |
| 5 | Liquidación del motorizado (entrega el efectivo) | 1103 o 1102 | 1104-xx |
| 6 | Pago al motorizado por sus viajes | 6102 | 1103 / 1101 |
| 7 | Liquidación de Tilopay o PayPal | 1102 (neto) + 6103 (comisión) | 1105 / 1106 (bruto) |
| 8 | Comisión de Yappy (del extracto) | 6103 | 1101 |
| 9 | Compra recibida | 1301 (costo puesto) | 2102 (o 1102 si se pagó al contado) |
| 10 | Pago al proveedor | 2102 | 1102 |
| 11 | Gasto | 6xxx | Cuenta de pago |
| 12 | Merma, muestra o regalo | 5201 | 1301 |
| 13 | Devolución que vuelve al inventario | 4901 (S) + 1301 (C) | 1201 o 2101 (lo reintegrado) + 5101 (C) |
| 14 | Reembolso | 2101 o 4901 | Cuenta de donde sale |
| 15 | Contracargo | 4901 | 1105 / 1106 o 1102 |
| 16 | Cancelación con abono aplicado como crédito | 2101 (pedido viejo) | 2101 (pedido nuevo) |
| 17 | Apertura | Activos (inventario, cuentas) | 3101 |
| 18 | Ajuste de redondeo del costo promedio | 5101 o 1301 | 1301 o 5101 |

Ningún asiento se edita ni se borra (triggers en [02 §10](02-datos.md#10-contabilidad)); un error se
corrige con el asiento contrario (`revierte_id`) y uno nuevo. Cada batch de asiento termina con la
fila de `control_cuadre`, que tumba el batch si el asiento no cuadra.

## 4. Costo promedio y prorrateo

**Costo promedio ponderado por variante** (`valor_inventario`):

- Entrada de `q` unidades a costo puesto `c`: `unidades += q`, `valor_cents += q × c`.
- Salida de `q` unidades: `costo = round(valor_cents × q / unidades)` (redondeo bancario), luego
  `unidades -= q`, `valor_cents -= costo`. Cuando `unidades` llega a 0, el `valor_cents` que quede
  (centavos de redondeo) se ajusta con el asiento 18.
- El costo de la salida queda copiado en `pedido_lineas.costo_unit_cents` y en el movimiento: un
  cambio posterior del promedio no reescribe ventas pasadas.

**Costo puesto en bodega** (compras importadas): los gastos de la compra (`compra_gastos`: flete,
aduana, impuestos, acarreo) se reparten entre sus líneas:

- por **valor** (de fábrica): `gasto_linea = gastos_totales × (q × costo_unit) / Σ(q × costo_unit)`;
- o por **unidades**, si la dueña lo elige para esa compra.

El residuo de centavos del reparto va a la línea de mayor valor. `costo_puesto_unit_cents =
costo_unit + gasto_linea / q`, redondeado; la diferencia de redondeo va al asiento de la compra.

## 5. Reportes

Todos con la regla de fechas de D'Casa (`CONTABILIDAD.md`, «Cómo leer las fechas»): un **saldo** es
«al día X» y solo usa la fecha final; un **movimiento** es «del X al Y». Cada tarjeta dice cuál es.
Atajos: Hoy · Esta semana (lunes a hoy) · Esta quincena · Este mes · Mes pasado · Este año. Hora de
Panamá.

| Reporte | Qué muestra | Cómo se calcula |
|---|---|---|
| Resumen para la dueña | Dinero en cada cuenta (al), te deben (al), ventas, ganancia bruta, gastos y ganancia neta (del—al), alertas | Saldos de 11xx y 1201; movimientos de 4xxx, 5xxx, 6xxx |
| Estado de resultados | Ventas − devoluciones − costo de lo vendido − mermas = ganancia bruta; − gastos = ganancia neta | Suma por tipo de cuenta en el periodo |
| Balance | Activos = pasivos + patrimonio | Saldos al día |
| Flujo de caja (directo) | Entradas y salidas de 11xx por origen | Líneas de asiento de 1101–1106 |
| Por cobrar | Saldos por clienta con antigüedad (0–7, 8–30, más de 30 días) | 1201 por pedido entregado |
| Margen por producto y talla | Ventas, costo, margen y % por código | `pedido_lineas` entregadas |
| Ventas por canal | Web, WhatsApp, Instagram, Messenger, Telegram, panel | `pedidos.origen` |
| Publicidad | Gasto en 6101 contra pedidos y clientas nuevas del periodo | Costo por clienta nueva = 6101 ÷ clientas con su primer pedido entregado |
| Reponer | Ritmo de venta, alcanza para, viene en camino, cuánto pedir | Fórmula de D'Casa (§6) |
| Mermas | Por motivo, contra el total vendido, con aviso si pasa de 0.5 % | Movimientos `merma` |

«Sin costo de ventas no es ganancia»: si en el periodo hubo ventas con costo cero (variante sin
costo de apertura), la tarjeta de ganancia lo dice y no muestra un margen de 100 % (regla de
D'Casa).

## 6. Reponer (de D'Casa, `docs/OPERACION.md` § Reponer)

Por variante y proveedor:

| Columna | Fórmula |
|---|---|
| Vendido en N meses | Unidades entregadas en los últimos N meses menos devoluciones (N de fábrica: 5) |
| Se vende al mes | Vendido ÷ N |
| Disponible hoy | Σ(fisico − reservado) en todas las bodegas |
| Viene en camino | Compras `confirmada` sin recibir |
| Alcanza para | (Disponible + En camino) ÷ Se vende al mes, en meses o días (mes = 30 días) |
| Tarda en llegar | `proveedores.dias_llegada`; si es NULL, la fila dice «Falta» y no calcula |
| Pedir | ⌈Se vende al mes × (meses que tarda + meses de reserva) − Disponible − En camino⌉, si > 0 |
| Aviso | Pedir ya · Pedir · Falta el tiempo de llegada · Sin proveedor · Alcanza |

Advertencia que la pantalla repite: si una talla estuvo agotada, su ritmo sale más bajo de lo real.

## 7. Arranque contable

1. Se elige la fecha de corte: el día 1 de un mes (`fecha_arranque` en `ajustes`).
2. Conteo físico en las tres bodegas ese día (pantalla de conteos).
3. Costo de apertura por variante: el último costo conocido (`cost_price` del CRM, o la factura del
   proveedor), revisado con la contadora.
4. Saldo de cada cuenta de dinero al cierre del día anterior (extractos).
5. Abonos recibidos de pedidos todavía no entregados → 2101 Anticipos, pedido por pedido.
6. Un solo asiento de apertura (asiento 17) que cuadra contra 3101 Capital.
7. Meses anteriores a la fecha de corte quedan cerrados desde el inicio.

## 8. Conciliación

- **Importar extracto:** CSV de Yappy Comercial y del banco (lector tolerante como el de D'Casa:
  detecta separador, codificación, columnas de débito/crédito y montos `1,234.56` / `(45.00)`), con
  vista previa antes de guardar y `huella` única por línea para no importar dos veces.
- **Sugerencias de cruce:** monto exacto + fecha ±3 días + referencia o nombre. Lo inequívoco se
  cruza solo; lo demás queda para revisar a mano.
- **Lo que se cruza:** pagos (`pagos`), liquidaciones de pasarelas, gastos y pagos a proveedores.
- **Después:** la Integración Core de Yappy (lee movimientos por API; ya escrita en
  `tommalopty/packages/integrations/src/yappy/`) reemplaza el CSV de Yappy cuando haya credenciales.

## 9. Cierre de mes

Lista de chequeo con datos reales, como el Cierre de mes de D'Casa:

- Extractos del mes importados y sin líneas por cruzar.
- Pagos aprobados sin conciliar = 0; liquidaciones de pasarelas recibidas.
- Cajas de motorizados en 0 (todo liquidado).
- Pedidos entregados sin costo = 0.
- Compras recibidas sin factura adjunta (aviso).
- Diferencia entre existencias y movimientos = 0.
- Balance que cuadra.

Si nada lo impide, la dueña cierra el mes (`periodos.estado = 'cerrado'`): ningún asiento puede
llevar fecha de ese mes. Reabrir pide motivo y queda registrado. Al cerrar se genera, en
`bc-tareas`, el paquete para la contadora:

- Excel con libro diario, mayor por cuenta, ventas, compras, gastos y por cobrar;
- ZIP con los comprobantes del mes (pagos manuales, recibos de gastos, facturas de proveedor)
  guardados en R2, con un `INDICE.csv`. D'Casa los guarda 5 años porque así lo pide la DGI; aquí se
  aplica la misma retención.

## 10. Lo que espera a la contadora

- Si pañales, wipes y fulares llevan ITBMS y a qué tasa (`variantes.tasa_itbms_bp` queda NULL y
  `itbms_cents = 0` hasta entonces).
- Si Baby Caleb emite factura fiscal o debe emitir factura electrónica, y con qué proveedor. El
  sistema solo emite un **comprobante de pedido** con la marca y su QR; no lo llama factura.
- El banco y las cuentas reales.
- Si el reconocimiento de la venta al entregar le sirve, o prefiere otro criterio.
