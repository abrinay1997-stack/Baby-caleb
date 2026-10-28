# Plan del sistema Baby Caleb

> **Estado: propuesta del 2026-10-28, con tres decisiones tomadas el mismo día (sección 0).
> Las preguntas que quedan están en la sección 9.**
> Versión visual, con los diagramas: <https://claude.ai/artifact/JV5WioRHhJhCzEVAix7HN2>.
> Sale de leer cuatro repositorios: esta web, `CRM-Baby-Caleb`, `tommalopty` (Nébula) y
> `D_Casa_new_word`. La cuenta de Cloudflare no se vio en vivo (el conector no estaba
> autorizado): todo lo de Cloudflare sale de los archivos de configuración.

## 0. Decidido el 2026-10-28

1. **Cuenta de Cloudflare: la de la agencia**, donde ya vive el CRM. El CRM no se muda, los
   service bindings funcionan desde el primer día y el plan de $5 ya está pagado. Si un día
   Baby Caleb necesita su propia cuenta, esa mudanza es un proyecto aparte.
2. **Dominio: `babycaleb.com`**, todavía sin comprar. El 28-oct aparecía disponible (consulta
   en GoDaddy). Se compra en Cloudflare Registrar, en la misma cuenta, con Baby Caleb como
   titular. Es urgente: ninguna pasarela aprueba un comercio en `workers.dev`.
3. **Cobro en la web con pasarela: Yappy, Tilopay y PayPal.** El cobro entra en la fase 4 (no
   al final, como en Nébula) y los trámites arrancan en la fase 0.

## 1. La decisión del repositorio

| Opción | Diseño de Baby Caleb | Todo en Cloudflare | Catálogos | Riesgo para el CRM |
|---|---|---|---|---|
| A · Nébula como base | Se rehace en Next.js | No (Supabase) | 2 | Bajo |
| B · Construir dentro del CRM | El panel es de Juancito Ads | Sí | 1 | Alto |
| C · Repositorio nuevo | Se copia | Sí | 1 | Bajo, pero otro repo y la carpeta de subidas partida |
| **D · Este repo + carpeta `sistema/`** | **Intacto** | **Sí** | **1** | **Bajo** |

Se recomienda **D**:

- La web se queda donde está, sin mover un archivo. Al lado nace `sistema/`: un Worker
  (`babycaleb-sistema`, Hono + D1 + R2) con pedidos, inventario, dinero, panel y asistente.
- **El CRM sigue siendo su propio Worker** (`juancitoads-bot`). Se conecta al sistema por
  service bindings con un contrato escrito, como Juan con Odoo en D'Casa. Su único cambio de
  fondo: deja de guardar el catálogo y se lo pregunta al sistema.
- **Nébula es donante de piezas**: `packages/domain` (lógica pura con pruebas), Yappy Core,
  bóveda de credenciales, Meta CAPI, guía 4×6 y despacho. Supabase y Next.js se quedan atrás.
- **D'Casa es el manual**: contabilidad, inventario, Brian, reglas y forma de trabajar,
  reescritos livianos en TypeScript. Nada de Odoo, Python ni contenedores 24/7.

## 2. Cómo se conecta

```
Clienta web ──> babycaleb-web (estáticos + /api) ──chat──> juancitoads-bot (CRM) <── clientas por mensajería
                      │                                       │   ▲        └── puente-wa (WhatsApp QR)
       catálogo · pedido · seguimiento          consulta y registra │ avisa a la clienta (HTTPS + llave)
                      ▼                                       ▼   │
                         babycaleb-sistema  <── Cloudflare Access <── dueña · equipo · motorizados · contadora
                         │        │        │            (la dueña sigue usando Telegram con el CRM)
                     D1 sistema  R2 privado  IA · Meta · Yappy · Tilopay · PayPal
```

## 3. Un dato, un solo dueño

| Dato | Vive en | Hoy está en |
|---|---|---|
| Productos, precio, unidades por caja | D1 del sistema | D1 del CRM + `content.json` + prompt de `netlify/functions/chat.ts` |
| Costo (nunca al bot ni a la web) | D1 del sistema | D1 del CRM |
| Existencias por bodega (bot y web: solo disponible · pocas · agotado) | D1 del sistema | D1 del CRM |
| Tarifas de envío por zona | D1 del sistema, editables en el panel | `member/zonas-envio.ts` del CRM |
| Clientes (celular = llave) | D1 del sistema | leads del CRM |
| Pedidos, abonos, entregas, dinero | D1 del sistema | no existen |
| Pagos en línea y avisos de pasarela (cada aviso una sola vez) | D1 del sistema | no existen |
| Credenciales de Yappy, Tilopay y PayPal | secretos de Cloudflare | no existen |
| Reglas con cifras (abono mínimo, puntos) | `sistema/reglas.json` versionado | texto de la KB |
| Políticas para el bot, conversaciones, seguimiento | CRM (no cambia) | CRM |
| Textos, fotos y diseño de la web | código de este repo | igual, menos los precios |
| Comprobantes, fotos de entrega, respaldos | R2 privado (nunca GitHub) | Telegram de la dueña |

## 4. Pagos en la web

El navegador nunca decide si un pedido está pagado. Cada pasarela confirma por su camino y las
tres llegan a un solo punto del servidor, que guarda cada aviso una vez (la interfaz
`PaymentProvider` y la tabla de eventos de Nébula). Los montos los calcula siempre el servidor.

| Pasarela | Qué cobra | Comisión publicada (confirmar) | Cómo confirma | Qué hay que pedir | Para qué |
|---|---|---|---|---|---|
| Yappy, botón directo | Yappy | 1 % + ITBMS, mínimo $0.02 (guías de terceros) | aviso de Yappy al servidor, con firma | ID de comercio y clave secreta en Yappy Comercial › Productos › Botón de Pago, y el dominio | total y abono; la primera en integrarse |
| Tilopay | tarjetas, cuotas BAC (también Yappy, al 2 %) | tarjetas: 3.75 % + $0.35 según su web | el servidor consulta el estado (`consult`) y valida el `OrderHash` (algoritmo: soporte@tilopay.com) | afiliación en línea, datos del negocio y cuenta donde deposita | solo el total |
| PayPal | saldo PayPal y tarjetas del exterior | tabla regional para Panamá: 5.40 % a 4.70 % + cargo fijo | webhook verificado | cuenta PayPal Business; retiro a banco panameño por MetroBank | solo el total, la más cara |

Notas:

- Yappy retiró la versión vieja del Botón de Pago; la nueva se integra por API con documentación
  oficial y ejemplos en Node. El adaptador `yappy.ts` de Nébula esperaba justo esa especificación.
- Abono en línea solo con Yappy: con tarjeta, el cargo fijo (~$0.35) ya es casi el 7 % de un
  abono de $5 antes del porcentaje.
- La sesión del 28-oct no podía abrir `tilopay.com` ni `yappy.com.pa` (red del entorno): las
  cifras salen de resultados de búsqueda. Para implementar hay que permitir esos dominios.
- Fuentes: [Tilopay processPayment](https://tilopay.com/en/developers/api/hosted-payment-page/process-payment),
  [Tilopay y Yappy](https://tilopay.com/yappy),
  [Yappy, nueva integración](https://www.yappy.com.pa/comercial/desarrolladores/boton-de-pago-yappy-nueva-integracion/),
  [guía de Yappy en la web](https://catalyxstudio.com/guias/yappy-en-tu-pagina-web),
  [tarifas regionales de PayPal](https://www.paypalobjects.com/marketing/ua/OA/merchant-fees/es-ROW-102826.pdf),
  [PayPal y MetroBank](https://panamaamerica.com.pa/economia/empresas-panamenas-podran-integrarse-la-plataforma-de-paypal-1200697).

## 5. Fases

Semanas de trabajo estimadas (quince en total); dependen de las respuestas de la sección 9.

**F0 · Cimientos (semana 1).** Comprar `babycaleb.com` en Cloudflare Registrar; arrancar los
trámites de pago (Botón de Pago en Yappy Comercial, afiliación a Tilopay, PayPal Business);
respuestas a las preguntas; conector de Cloudflare e inventario
en vivo; `CLAUDE.md` ampliado, `docs/LEEME_PRIMERO.md`, `docs/PRIORIDADES.md`,
`docs/CONTEXTO_AGENTICO.md`, `docs/FUENTES_DE_VERDAD.md`; CI en cada PR; limpiar restos de AI
Studio (`express`, `@google/genai`, `dotenv`, `metadata.json`); alertas de presupuesto a $10 y $20.

**F1 · La web a Cloudflare (semanas 1–2).** `wrangler.jsonc` del Worker `babycaleb-web`
(assets de `dist/`, respaldo de página única, `_headers` con lo de `netlify.toml`); fijar
`SITE_URL` en el build (hoy lo pone Netlify con `URL`); `/api/chat` al Worker tal cual;
publicación por GitHub Actions; prueba de píxeles de las 7 páginas; dominio a Cloudflare con
Netlify dos semanas de respaldo; la web sale en `babycaleb.com`; páginas que piden las
pasarelas (términos, privacidad, cambios y devoluciones, envíos), con texto aprobado por la dueña.

**F2 · Nace el sistema (semanas 2–4).** `sistema/` con Hono, D1 (`babycaleb-db` y staging), R2
privado y Vitest; migraciones: productos, bodegas, existencias, movimientos (no se editan),
clientes, usuarios y roles, bitácora de acciones; panel `/panel` detrás de Access con los tokens
de `brand.json` y reglas de teléfono del CRM; registro de herramientas del asistente por niveles;
Time Travel + copia a R2 + simulacro en CI; dinero, stock y precios de Nébula; staging y
producción separados.

**F3 · Un dato, un dueño (semanas 4–5).** Traspaso del catálogo y los movimientos del CRM con
conteo y comparación; `docs/CONTRATO_CRM.md`; en el CRM, `catalogQuery`, `/stock`, `/venta`,
`/devolucion` y `/ajuste` contra el sistema detrás de `CATALOGO_FUENTE`; tarifas de envío al
panel; la web lee precio y disponibilidad del sistema con caché y copia de respaldo, y una prueba
falla si vuelve un precio a `content.json`; el chat de la web pasa a ser un canal del CRM (de
usted, con catálogo y tickets) y se apaga Groq.

**F4 · Pedidos, pagos y entregas (semanas 5–9).** Estados: borrador → por abonar → agendado
(abono confirmado, aparta cajas) → en ruta (guía con QR) → entregado (sale del stock + costo) →
pagado, más cancelado; `sistema/reglas.json`; comprobantes a R2 y confirmación de un toque por
Telegram para lo que se paga fuera de la web; carrito en la web (precio recalculado en el
servidor, Turnstile, total o abono); interfaz única de pagos y tabla de avisos sin repetir;
Yappy por botón directo (total y abono); Tilopay (tarjetas y cuotas, solo total); PayPal (solo
total); las tres primero en modo de prueba;
dirección con pin, guía 4×6, seguimiento público, app del motorizado; `/venta` crea pedidos;
avisos a la clienta por su canal.

**F5 · Contabilidad gerencial (semanas 9–11).** Cuentas de dinero y libro que no se edita;
compras a proveedor con costo promedio; gastos con foto; costo de lo vendido al entregar;
resumen para la dueña con fechas claras; conciliación por CSV y reportes de Tilopay y PayPal, con cada comisión anotada como gasto, y
después API de Yappy; reponer
por ritmo de venta; cierre de mes, Excel y ZIP para la contadora; ITBMS y factura solo con la
respuesta de la contadora.

**F6 · El asistente del negocio (semanas 11–13).** Unas 30 herramientas; chat en el panel con
pasos y «Permitir / Rechazar»; la consola de Telegram del CRM gana las herramientas del sistema;
MCP; tope de IA, adjuntos como datos, cifras siempre del código; pruebas con guion fijo.

**F7 · Crecer (semanas 13–15).** Mi cuenta con el celular y «Repetir mi pedido»; recompra con
la talla siguiente; Socios (puntos y referidos); catálogo de Meta, píxel y Purchase desde el
servidor; auditoría por rondas.

## 6. Costos estimados al mes

D'Casa: ~$35 (contenedor `standard-1` 24/7 con Odoo y PostgreSQL, más IA). Baby Caleb objetivo:
**≈ $10–15**: el plan Workers Paid de $5 que ya paga el contenedor del puente, la web gratis,
D1 y R2 dentro de lo incluido, la IA (~$1–2 del bot, ~$2–5 del asistente con tope) y el dominio
(cerca de $1 al mes, pagado por año). Aparte, la comisión de cada cobro en línea (sección 4).

## 7. Hallazgos

1. El precio está en tres lugares: `content.json`, el prompt de `netlify/functions/chat.ts` y la
   D1 del CRM.
2. El bot de la web (Groq, Llama 3.3) tutea, y dice que el delivery y los pagos «no están
   confirmados» cuando el CRM ya tiene tarifas por zona y Yappy Comercial con abono mínimo.
3. La web no tiene píxel de Meta ni analítica.
4. `vite.config.ts` depende de la variable `URL` de Netlify: fuera de Netlify hay que fijar
   `SITE_URL`.
5. La web no está en la cuenta de Netlify conectada a la sesión (solo `juancitoads.com`); da
   igual para la mudanza, porque se publica desde GitHub.

## 8. Reglas desde el primer commit

Un dato, un solo dueño · los libros no se editan · ninguna cifra a ojo (lo que falta queda
«PENDIENTE») · el navegador no decide un pago · secretos fuera del chat · datos de clientas fuera de GitHub · capturas → visto
bueno → pruebas → staging → producción · el panel es de teléfono · la marca de `brand.json`
manda y `📤SUBIR-CONTENIDO/` nunca se mueve · cada sesión deja su entrada en la bitácora.

## 9. Preguntas pendientes

Las dos primeras frenan los trámites de pago.

1. ¿Baby Caleb está registrado como negocio (RUC o aviso de operación) y tiene cuenta bancaria a
   su nombre? ¿Quién es titular del Yappy Comercial?
2. ¿En línea se cobra solo el total, o también el abono? (Recomendado: total con las tres, abono
   solo con Yappy.)
3. ¿Factura fiscal, contadora, ITBMS? ¿Qué cuentas de dinero existen?
4. ¿Motorizados propios o de terceros, y cómo se les paga? ¿Quién lleva Ferguson?
5. ¿A quién se le compra, cada cuánto y cuánto tarda en llegar?
6. ¿Quién usará el panel?
7. ¿El CRM sigue recibiendo actualizaciones de la plantilla Juancito Ads?
8. ¿El código de Nébula se puede reutilizar en Baby Caleb?
9. ¿Nombre del asistente interno?
10. ¿Tope mensual de IA?
11. ¿Programa de puntos y referidos?
