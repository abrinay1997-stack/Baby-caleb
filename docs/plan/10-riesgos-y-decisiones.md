# 10 · Riesgos, decisiones y preguntas abiertas

## 1. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | WhatsApp banea el número del puente QR | Media | Alto | Ningún mensaje saliente nuevo por el puente; avisos por plantillas de la Cloud API; la Cloud API sigue conectada (ya es la regla del CRM) |
| R2 | Una pasarela tarda en aprobar o pide documentos que el negocio no tiene | Alta | Medio | Trámites desde la semana 1; F4b por pasarela; el pago manual siempre disponible |
| R3 | Tilopay no entrega el algoritmo de `OrderHash` | Media | Bajo | La consulta (`consult`) es la verdad; el hash es una capa extra |
| R4 | La documentación de Yappy cambia o tiene huecos | Media | Medio | Se lee y se resume en `docs/YAPPY-BOTON.md` antes de programar; adaptador aislado |
| R5 | Un cambio rompe la atención del CRM | Media | Alto | Interruptor `CATALOGO_FUENTE`, pruebas de contrato con huella, staging del CRM, ventana de traspaso |
| R6 | Se vende una caja que no hay | Baja | Medio | `CHECK` de existencias en el batch; prueba de concurrencia en CI |
| R7 | Pérdida de datos | Baja | Alto | Time Travel 30 días + exportación diaria cifrada + simulacro semanal |
| R8 | El gasto de IA se dispara (clave filtrada o bucle) | Baja | Medio | Tope mensual global y por persona; límite en el panel del proveedor de IA; alertas de Cloudflare |
| R9 | Incumplir la Ley 81 de datos personales | Media | Alto | Consentimiento separado, aviso de privacidad revisado por abogado, anonimización, mínimo necesario |
| R10 | Todo en la cuenta de la agencia y el negocio quiere llevárselo | Baja | Medio | Procedimiento de traspaso (§4) escrito desde ya |
| R11 | Una sola persona entiende el sistema | Alta | Alto | Documentos vivos, contratos y runbooks; bitácora por sesión |
| R12 | El sistema crece hasta parecerse a D'Casa | Media | Medio | Cada pantalla o tabla nueva necesita un pedido concreto de la dueña; nada de módulos «por si acaso» |
| R13 | El plazo se alarga | Alta | Bajo | Margen del 20 %; fases que entregan algo usable cada una; F4b y F7 pueden correrse sin frenar a las demás |
| R14 | Límites de D1 o de Workers | Baja | Medio | Consultas por lotes, índices, presupuesto de consultas por pantalla en CI |
| R15 | Una migración deja el código y la base desalineados | Media | Alto | Expandir → migrar → contraer; `/salud` exige versión y migración; nunca bajar código sin revisar la base |
| R16 | Datos de clientas terminan en el entrenamiento de Meta | Media | Alto | Capa de referencias (D-20) con su prueba; sin fotos de comprobantes; aviso de privacidad |
| R17 | La puerta de Meta tiene diferencias con la de Anthropic (herramientas, streaming, límites) o se cae | Media | Medio | Lo aprendido en el CRM (`provider.ts`), pruebas con guion fijo, evaluación de 30 preguntas antes de encender, modelo de respaldo |

## 2. Registro de decisiones

| # | Fecha | Decisión | Alternativas descartadas | Por qué |
|---|---|---|---|---|
| D-01 | 2026-10-28 | Construir en este repo; la web en la raíz y el sistema en `sistema/` | Nébula como base; dentro del CRM; repo nuevo | Diseño intacto, un solo catálogo, sin riesgo para el CRM, la carpeta de subidas sigue en un lugar |
| D-02 | 2026-10-28 | El CRM sigue aparte | Fusionarlo con el sistema | Funciona; si la contabilidad falla no debe caerse la atención |
| D-03 | 2026-10-28 | Cuenta de Cloudflare de la agencia | Cuenta propia de Baby Caleb | Decisión del dueño del proyecto; el CRM ya vive ahí y los bindings funcionan sin mudanza |
| D-04 | 2026-10-28 | Dominio `babycaleb.com` en Cloudflare Registrar | Otro registrador | Precio de costo y DNS en el mismo lugar |
| D-05 | 2026-10-28 | Yappy, Tilopay y PayPal en la web | Solo pago manual | Decisión del dueño del proyecto |
| D-06 | 2026-10-29 | Del sistema al CRM, por cola (`bc-avisos`) | HTTPS con token; binding circular | HTTPS entre Workers de la misma cuenta da 1042; la cola reintenta y no exige orden de despliegue |
| D-07 | 2026-10-29 | Stock garantizado con `CHECK` + `batch` + filas de control | Durable Object que serialice; Postgres externo | D1 no tiene transacciones interactivas; las restricciones resuelven sin pieza nueva |
| D-08 | 2026-10-29 | Partida doble interna | Libro de caja | Representa anticipos, por cobrar, cajas de motorizados, pasarelas e inventario a la vez |
| D-09 | 2026-10-29 | La venta se reconoce al entregar; el abono es anticipo | Ingreso al cobrar | Un pedido cancelado no deja una venta fantasma (pendiente de visto bueno de la contadora) |
| D-10 | 2026-10-29 | Avisos fuera de una conversación abierta por plantillas de la Cloud API | Por el canal de la clienta siempre | Protege el número del puente QR |
| D-11 | 2026-10-29 | `<head>` por ruta con `HTMLRewriter` en la web | SSR; prerender en el build | Cero cambios de diseño; precios del momento en el JSON-LD |
| D-12 | 2026-10-29 | Mapa con Protomaps en R2; la zona la elige la clienta | Proveedor de teselas con plan; polígonos | Sin cuota mensual; el tarifario de la dueña es por nombre |
| D-13 | 2026-10-29 | Panel en React + Vite servido por el sistema | Hono con HTML del servidor, como el CRM | Mismo stack y tokens de la web; pantallas ricas en el teléfono |
| D-14 | 2026-10-29 | Abono en línea solo con Yappy (y manual); tarjeta y PayPal solo total | Cualquier método para abono | El cargo fijo de tarjeta se come el abono mínimo. Confirmado por el dueño del proyecto el 2026-10-29 |
| D-15 | 2026-10-29 | El bucle del asistente en Telegram corre en el CRM; en panel y MCP, en el sistema; política y bitácora siempre en el sistema | Todo el bucle en el sistema | El sistema no tiene binding al CRM; la consola ya tiene memoria y herramientas propias |
| D-16 | 2026-10-29 | La web se publica sola al unir a `main`; el sistema, solo a mano | Todo a mano o todo automático | La web es estática y de bajo riesgo; el sistema toca dinero |
| D-17 | 2026-10-29 | Herramientas completas en orden fijo | Preselección por mensaje (Brian) | Con Muse Spark Contributor preseleccionar no ahorra nada que importe; la lista fija es más predecible y deja lista la caché si se cambia de modelo |
| D-18 | 2026-10-29 | Motorizados por `ruta.babycaleb.com` con PIN | Access por correo | No todos tienen correo; acceso limitado a sus entregas |
| D-19 | 2026-10-29 | El asistente usa Meta Muse Spark Contributor (`muse-spark-1.2-contributor`) | Claude Haiku/Sonnet/Opus 5.5; Muse Spark 1.3 | Decisión del dueño del proyecto, sabiendo que Meta entrena con lo que recibe. ≈ $1.5–3 al mes. Solo para el asistente interno, no para el bot de clientas |
| D-20 | 2026-10-29 | Al modelo no le llegan datos personales de clientas: referencias en vez de nombres, celulares y direcciones | Mandar todo tal cual | Las clientas son terceras personas y no aceptaron que Meta entrene con sus datos (Ley 81); las cifras del negocio sí van |

Toda decisión nueva se agrega aquí con fecha, alternativas y motivo.

### Corrección del 2026-11-09 (al implementar F2.7)

El §6 de `06-asistente.md` justificaba cinco detalles del proveedor de Meta
—formato de mensajes de Anthropic en `/v1/messages`, `eager_input_streaming`
que hace fallar cada mensaje, `max_tokens` mínimo de 16, nada de
`cache_control`, y una prueba que vigila que el token de Messenger no viaje a
`api.meta.ai`— diciendo que era «lo que el CRM ya aprendió» en
`src/llm/provider.ts`.

**En el CRM no hay nada de eso.** Su proveedor es Anthropic / OpenAI / xAI; no
menciona a Meta en ninguna línea, no existe `META_API_KEY` ni `muse-spark` en
ningún archivo, y `src/pricing.ts` no tiene tarifa para esos modelos. Esas
cinco afirmaciones no están comprobadas contra código que exista.

Lo que sí se verificó el 2026-11-09, en fuentes públicas:

- El Model API de Meta vive en `api.meta.ai/v1` y sirve Muse Spark 1.1, 1.2 y 1.3.
- El nivel **Contributor existe** y es real: ≈ $0.10 / $0.20 por millón contra
  $1.25 / $4.25 del estándar, **a cambio de permiso para entrenar con los
  prompts y las respuestas**. D-19 y D-20 se sostienen.
- El nivel se elige por el id del modelo (`muse-spark-1.3` contra
  `muse-spark-1.3-contributor`), como daba por hecho el plan.
- Contributor está limitado a ~100 peticiones por minuto contra las ~3.000 del
  estándar. Para 30 consultas al día sobra, pero conviene saberlo.
- **No se pudo verificar la RUTA ni el formato exacto**: unas fuentes dicen
  formato de Anthropic (`/v1/messages`), otras el de OpenAI (`/v1/responses` o
  `/v1/chat/completions`).

Qué se hizo con eso en `sistema/src/asistente/proveedor.ts`: la base y la ruta
son **configuración**, no están escritas en el código, así que si el formato
resulta ser el otro es un ajuste y no un despliegue; `leerRespuesta()` no
revienta ante una forma distinta, devuelve una respuesta vacía; y la guarda del
token de Graph —la prueba que el plan decía que existía en el CRM— se
implementó aquí, en el código, con su prueba.

**Queda pendiente** confirmar la ruta con una llamada de verdad en cuanto haya
llave. Hasta entonces, `meta()` no se da por bueno.

### Preguntas ya respondidas

| # | Pregunta | Respuesta (2026-10-29) |
|---|---|---|
| P1 | ¿Negocio registrado, cuenta bancaria propia, titular del Yappy Comercial? | Todo en regla a nombre del negocio. Los trámites de pago arrancan ya |
| P2 | ¿Abono solo con Yappy y total con las tres pasarelas? | Sí (D-14) |
| P3a | ¿Qué modelo usa el asistente? | Meta Muse Spark Contributor (D-19) |

## 3. Preguntas abiertas

| # | Pregunta | Frena |
|---|---|---|
| P3 | ¿Cuál es el tope mensual de IA del asistente (propuesta: $10)? ¿Qué modelo de respaldo usa si Meta falla? ¿Cómo se llama? | F6 (se pueden cambiar después) |
| P4 | ¿Factura fiscal o electrónica? ¿Hay contadora? ¿ITBMS en pañales, wipes y fulares? ¿Qué banco y qué cuentas? | F5 |
| P5 | ¿Motorizados propios o de terceros? ¿Cómo se les paga (viaje, zona, día)? ¿Quién lleva Ferguson? | F4.5 y F5.6 |
| P6 | ¿A qué proveedores se les compra, cada cuánto y cuántos días tardan? | F5.4 y Reponer |
| P7 | ¿Quién usa el panel y con qué correo? | F2.6 |
| P8 | ¿El CRM sigue recibiendo actualizaciones de la plantilla Juancito Ads? | Forma de los cambios en el CRM (F3.3) |
| P9 | ¿El código de Nébula se puede reutilizar en Baby Caleb? | F2.3 |
| P10 | ¿Interesa el programa de puntos y referidos? | F7.3 |
| P11 | ¿Cuánto dura la reserva de un pedido sin abono, pagando en línea y con comprobante? | F4.4 |
| P12 | Si se cancela un pedido con abono: ¿reembolso o crédito para el siguiente? | F4.4 |
| P13 | ¿Cuántos días se guardan las fotos de entrega? | F4.5 |
| P14 | ¿Ventanas de entrega (mañana, tarde) y días sin entregas? | F4.5 |
| P15 | ¿Desde qué fecha arranca la contabilidad? | F5.3 |

## 4. Si un día Baby Caleb se lleva su sistema a su propia cuenta

Escrito ahora para que no sea una sorpresa (riesgo R10):

1. Crear la cuenta de Cloudflare de Baby Caleb con el plan Workers Paid.
2. Crear allí D1, R2, colas, Access, Turnstile y rate limits con los mismos nombres.
3. Exportar la D1 del sistema y la del CRM (`wrangler d1 export`) e importarlas.
4. Copiar los buckets de R2 (migración de datos de R2 de Cloudflare o copia con una herramienta
   compatible con S3).
5. Volver a cargar todos los secretos (no se pueden leer: se pegan de nuevo desde su origen).
6. Reindexar la KB del CRM en el Vectorize nuevo.
7. Volver a registrar los webhooks de Telegram, Meta y las pasarelas con las URL nuevas, y volver
   a vincular el WhatsApp por QR.
8. Mover el dominio a la cuenta nueva con el procedimiento vigente de Cloudflare.
9. Cambiar `CLOUDFLARE_ACCOUNT_ID` y el token en GitHub y desplegar los tres Workers.
10. Mantener la cuenta vieja en solo lectura dos semanas.
