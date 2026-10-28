# Plan del sistema Baby Caleb

> **Estado: propuesta del 2026-10-28, pendiente de las respuestas de la sección 8.**
> Versión visual, con los diagramas: <https://claude.ai/artifact/JV5WioRHhJhCzEVAix7HN2>.
> Sale de leer cuatro repositorios: esta web, `CRM-Baby-Caleb`, `tommalopty` (Nébula) y
> `D_Casa_new_word`. La cuenta de Cloudflare no se vio en vivo (el conector no estaba
> autorizado): todo lo de Cloudflare sale de los archivos de configuración.

## 1. La decisión

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
                     D1 sistema  R2 privado  IA · Meta · Yappy
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
| Reglas con cifras (abono mínimo, puntos) | `sistema/reglas.json` versionado | texto de la KB |
| Políticas para el bot, conversaciones, seguimiento | CRM (no cambia) | CRM |
| Textos, fotos y diseño de la web | código de este repo | igual, menos los precios |
| Comprobantes, fotos de entrega, respaldos | R2 privado (nunca GitHub) | Telegram de la dueña |

## 4. Fases

Semanas de trabajo estimadas; dependen de las respuestas de la sección 8.

**F0 · Cimientos (semana 1).** Respuestas a las preguntas; conector de Cloudflare e inventario
en vivo; `CLAUDE.md` ampliado, `docs/LEEME_PRIMERO.md`, `docs/PRIORIDADES.md`,
`docs/CONTEXTO_AGENTICO.md`, `docs/FUENTES_DE_VERDAD.md`; CI en cada PR; limpiar restos de AI
Studio (`express`, `@google/genai`, `dotenv`, `metadata.json`); alertas de presupuesto a $10 y $20.

**F1 · La web a Cloudflare (semanas 1–2).** `wrangler.jsonc` del Worker `babycaleb-web`
(assets de `dist/`, respaldo de página única, `_headers` con lo de `netlify.toml`); fijar
`SITE_URL` en el build (hoy lo pone Netlify con `URL`); `/api/chat` al Worker tal cual;
publicación por GitHub Actions; prueba de píxeles de las 7 páginas; dominio a Cloudflare con
Netlify dos semanas de respaldo.

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

**F4 · Pedidos, abonos y entregas (semanas 5–8).** Estados: borrador → por abonar → agendado
(abono confirmado, aparta cajas) → en ruta (guía con QR) → entregado (sale del stock + costo) →
pagado, más cancelado; `sistema/reglas.json`; comprobantes a R2 y confirmación de un toque por
Telegram; carrito en la web si se aprueba (precio recalculado en el servidor, Turnstile);
dirección con pin, guía 4×6, seguimiento público, app del motorizado; `/venta` crea pedidos;
avisos a la clienta por su canal.

**F5 · Contabilidad gerencial (semanas 8–10).** Cuentas de dinero y libro que no se edita;
compras a proveedor con costo promedio; gastos con foto; costo de lo vendido al entregar;
resumen para la dueña con fechas claras; conciliación por CSV y después API de Yappy; reponer
por ritmo de venta; cierre de mes, Excel y ZIP para la contadora; ITBMS y factura solo con la
respuesta de la contadora.

**F6 · El asistente del negocio (semanas 10–12).** Unas 30 herramientas; chat en el panel con
pasos y «Permitir / Rechazar»; la consola de Telegram del CRM gana las herramientas del sistema;
MCP; tope de IA, adjuntos como datos, cifras siempre del código; pruebas con guion fijo.

**F7 · Crecer (semanas 12–14).** Mi cuenta con el celular y «Repetir mi pedido»; recompra con
la talla siguiente; Socios (puntos y referidos); catálogo de Meta, píxel y Purchase desde el
servidor; Botón de Pago de Yappy; auditoría por rondas.

## 5. Costos estimados al mes

D'Casa: ~$35 (contenedor `standard-1` 24/7 con Odoo y PostgreSQL, más IA). Baby Caleb objetivo:
**≈ $10–15**: el plan Workers Paid de $5 que ya paga el contenedor del puente, la web gratis,
D1 y R2 dentro de lo incluido, y la IA (~$1–2 del bot, ~$2–5 del asistente con tope). Si se abre
una cuenta propia de Cloudflare, esa cuenta lleva su propio plan de $5.

## 6. Hallazgos

1. El precio está en tres lugares: `content.json`, el prompt de `netlify/functions/chat.ts` y la
   D1 del CRM.
2. El bot de la web (Groq, Llama 3.3) tutea, y dice que el delivery y los pagos «no están
   confirmados» cuando el CRM ya tiene tarifas por zona y Yappy Comercial con abono mínimo.
3. La web no tiene píxel de Meta ni analítica.
4. `vite.config.ts` depende de la variable `URL` de Netlify: fuera de Netlify hay que fijar
   `SITE_URL`.
5. La web no está en la cuenta de Netlify conectada a la sesión (solo `juancitoads.com`).

## 7. Reglas desde el primer commit

Un dato, un solo dueño · los libros no se editan · ninguna cifra a ojo (lo que falta queda
«PENDIENTE») · secretos fuera del chat · datos de clientas fuera de GitHub · capturas → visto
bueno → pruebas → staging → producción · el panel es de teléfono · la marca de `brand.json`
manda y `📤SUBIR-CONTENIDO/` nunca se mueve · cada sesión deja su entrada en la bitácora.

## 8. Preguntas pendientes

1. ¿Cuenta de Cloudflare de la agencia o cuenta propia de Baby Caleb? (Los service bindings solo
   funcionan dentro de una misma cuenta; con cuenta propia, el CRM se muda en F2.)
2. ¿Qué dominio usa la web y en qué cuenta de Netlify está?
3. ¿Carrito y «Hacer mi pedido» en la web, o la web sigue mandando todo a WhatsApp?
4. ¿RUC, factura fiscal, contadora, ITBMS? ¿Qué cuentas de dinero existen?
5. ¿Motorizados propios o de terceros, y cómo se les paga? ¿Quién lleva Ferguson?
6. ¿A quién se le compra, cada cuánto y cuánto tarda en llegar?
7. ¿Quién usará el panel?
8. ¿El CRM sigue recibiendo actualizaciones de la plantilla Juancito Ads?
9. ¿El código de Nébula se puede reutilizar en Baby Caleb?
10. ¿Nombre del asistente interno?
11. ¿Tope mensual de IA?
12. ¿Programa de puntos y referidos?
