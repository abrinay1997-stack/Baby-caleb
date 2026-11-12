# Plan técnico del sistema Baby Caleb

> **Versión 2 · 29 de octubre de 2026.** Reemplaza al plan v1 del 28-oct (`docs/PLAN-SISTEMA.md`,
> que ahora es solo el resumen). La v2 sale de revisar la v1 contra el código real de los cuatro
> repositorios y contra los límites publicados de Cloudflare; lo que estaba mal o faltaba está en
> [`00-revision.md`](00-revision.md).
>
> Versión visual (diagramas para la dueña): <https://claude.ai/artifact/JV5WioRHhJhCzEVAix7HN2>.

## Qué es esto

El plan para que Baby Caleb tenga su propio sistema en Cloudflare: la web de siempre (con carrito y
pago en línea), un Worker nuevo con pedidos, inventario, entregas, contabilidad y un asistente
interno con IA, y el CRM actual (el bot de atención) conectado a todo eso. Sin contenedores nuevos
ni servidores encendidos las 24 horas.

Fuentes que se leyeron para escribirlo:

| Repositorio | Qué aporta |
|---|---|
| `abrinay1997-stack/Baby-caleb` (este) | La web: React 19 + Vite + Tailwind 4, marca en `brand.json`, hoy en Netlify |
| `juanarrietabusiness-pixel/CRM-Baby-Caleb` | El bot y la consola de la dueña: Worker `juancitoads-bot`, D1, Vectorize, puente de WhatsApp |
| `juanarrietabusiness-pixel/tommalopty` (Nébula) | Lógica de pedidos, abonos, envíos, motorizados y pagos en TypeScript puro con pruebas |
| `dcasapty/D_Casa_new_word` (D'Casa) | El criterio: contabilidad, inventario, Brian, seguridad, despliegue y la bitácora de incidentes |

## Una regla que atraviesa todo el plan: MCP

**Todo lleva MCP, y en el mismo cambio.** Un ajuste nuevo, un campo nuevo o una capacidad nueva no
están terminados hasta que se pueden usar también por MCP. No es una fase posterior: se construye
en paralelo, en el mismo trabajo. Lo que hoy no tiene MCP también tiene que tenerlo.

Esto vale para **todo documento de este plan y para todo plan futuro**. Una fase que describe una
capacidad y no dice cómo se pide por MCP está incompleta y hay que devolverla. Si lo que propone no
tiene sentido por MCP, se escribe el motivo; lo que no se admite es no haberlo pensado.

Lo pidió el dueño del proyecto. El porqué está en [`../TRAMPAS.md`](../TRAMPAS.md) §13, y lo
comprueba `sistema/scripts/sin-mcp.mjs`, que corre en CI: una ruta nueva sin decidir si MCP la
cubre pone la ejecución en rojo.

Estado de hoy (2026-11-12): **72 capacidades en el panel, 9 alcanzables por MCP, 6 que solo tienen
sentido en el panel y 57 pendientes.** El número de pendientes tiene que bajar, no subir — las tres
capacidades nuevas de hoy (las dos de cotizaciones y el veredicto del checkout) entraron con su
herramienta en el mismo cambio, que es la regla. El guion también comprueba que la herramienta
nombrada EXISTA: decir que algo se puede por MCP sin que se pueda es peor que decir «PENDIENTE»,
porque nadie vuelve a mirarlo.

## Cómo leerlo

| Documento | Qué contiene |
|---|---|
| [`00-revision.md`](00-revision.md) | **Fallos y huecos de la v1** y cómo quedan resueltos en la v2 |
| [`01-arquitectura.md`](01-arquitectura.md) | Workers, recursos, dominios, rutas, cables entre piezas, estructura del repo, secuencias |
| [`02-datos.md`](02-datos.md) | Modelo de datos de D1 con su DDL, convenciones e índices |
| [`03-contratos.md`](03-contratos.md) | Contratos entre la web, el sistema y el CRM: RPC, eventos de cola y errores |
| [`04-pagos.md`](04-pagos.md) | Yappy, Tilopay, PayPal y el pago manual: flujos, verificación, conciliador y reembolsos |
| [`05-contabilidad.md`](05-contabilidad.md) | Plan de cuentas, asientos automáticos, costo promedio, reportes y cierre de mes |
| [`06-asistente.md`](06-asistente.md) | El asistente interno: registro de herramientas, permisos, canales, modelo y costo |
| [`07-seguridad.md`](07-seguridad.md) | Accesos, roles, secretos, datos personales (Ley 81) y amenazas |
| [`08-operacion.md`](08-operacion.md) | Entornos, CI/CD, migraciones, respaldos, salud, crons, runbooks y costos |
| [`09-fases.md`](09-fases.md) | Las fases con tareas numeradas, dependencias y criterios de aceptación |
| [`10-riesgos-y-decisiones.md`](10-riesgos-y-decisiones.md) | Riesgos, registro de decisiones y preguntas abiertas |

## Decisiones tomadas

| # | Fecha | Decisión |
|---|---|---|
| D-01 | 2026-10-28 | Se construye en este repo: la web se queda en la raíz y el sistema nace en `sistema/` |
| D-02 | 2026-10-28 | El CRM sigue siendo su propio Worker y repo; se conecta por service bindings y colas |
| D-03 | 2026-10-28 | Todo vive en la cuenta de Cloudflare de la agencia, donde ya está el CRM |
| D-04 | 2026-10-28 | Dominio `babycaleb.com` (por comprar, en Cloudflare Registrar) |
| D-05 | 2026-10-28 | Cobro en la web con Yappy, Tilopay y PayPal |
| D-14 | 2026-10-29 | El abono en línea, solo con Yappy (y el pago manual); el total, con las tres pasarelas |
| D-19 | 2026-10-29 | El asistente usa Meta Muse Spark Contributor, sabiendo que Meta entrena con lo que recibe |
| D-20 | 2026-10-29 | Al modelo del asistente no le llegan datos personales de clientas |

El registro completo, con alternativas y motivos, está en
[`10-riesgos-y-decisiones.md`](10-riesgos-y-decisiones.md).

## Reglas que este plan da por sentadas

1. **Un dato, un solo dueño** (`CRM-Baby-Caleb/docs/FUENTES_DE_VERDAD.md`). Precio, existencias y
   costo viven solo en la D1 del sistema; las políticas que el bot explica, en la KB del CRM.
2. **Ninguna cifra a ojo.** Montos, comisiones, impuestos y puntos salen de la dueña o de una
   fuente citada. Lo que falta se escribe `PENDIENTE` y el sistema no lo rellena.
3. **Los libros no se editan**: inventario, dinero, puntos y bitácoras se corrigen con un
   movimiento contrario y su motivo.
4. **El navegador no decide un pago**: un pedido pasa a pagado cuando el servidor verifica a la
   pasarela, y los montos los calcula siempre el servidor.
5. **El código y la base van juntos** (regla 2 de `D_Casa_new_word/docs/CONTEXTO_AGENTICO.md`):
   migraciones compatibles hacia atrás, aplicadas antes de publicar el código que las usa.
6. **Secretos fuera del chat y datos de clientas fuera de GitHub.**
7. **La marca de `brand.json` manda** en la web y en el panel; `📤SUBIR-CONTENIDO/` no se mueve.
8. **Lo que no se escribe se pierde**: cada sesión deja su entrada en la bitácora.
