# Plan del sistema Baby Caleb · resumen

> **El plan completo y técnico está en [`docs/plan/`](plan/README.md)** (versión 2, 29-oct-2026).
> Este archivo es solo el resumen. Lo que la v1 tenía mal o le faltaba está en
> [`docs/plan/00-revision.md`](plan/00-revision.md).
> Versión visual: <https://claude.ai/artifact/JV5WioRHhJhCzEVAix7HN2>.

## En una página

- **Dónde:** en este repo. La web se queda en la raíz, sin mover un archivo; el sistema nace en
  `sistema/`. El CRM (`juancitoads-bot`) sigue en su repo y su Worker.
- **Cómo se conectan:** la web y el CRM le piden al sistema por service binding (RPC); el sistema le
  avisa al CRM por una cola (`bc-avisos`). Todo en la cuenta de Cloudflare de la agencia.
- **Qué guarda el sistema** (D1 `babycaleb-db`): catálogo, existencias por bodega, clientas,
  pedidos, pagos, entregas, compras, gastos y contabilidad en partida doble interna.
- **Pagos en la web:** Yappy (botón directo, total y abono), Tilopay (tarjetas y cuotas, solo total)
  y PayPal (solo total), más el pago manual con comprobante que se usa hoy.
- **Asistente interno:** el equivalente de Brian, en el panel, en Telegram (la consola del CRM) y
  por MCP, con herramientas por niveles y una bitácora que no se borra.
- **Costo:** ≈ $10–15 al mes en total, con el asistente en Meta Muse Spark Contributor (≈ $1.5–3),
  más las comisiones de cada cobro en línea.
- **Plazo:** unas 17 semanas en 9 fases, cada una con algo usable al final.

## Decisiones tomadas

| # | Decisión |
|---|---|
| D-01 | Este repo + `sistema/` |
| D-02 | El CRM sigue aparte |
| D-03 | Cuenta de Cloudflare de la agencia |
| D-04 | Dominio `babycaleb.com` en Cloudflare Registrar |
| D-05 | Yappy, Tilopay y PayPal |
| D-14 | Abono solo con Yappy; total con las tres |
| D-19 | Asistente con Meta Muse Spark Contributor |
| D-20 | Sin datos personales de clientas hacia el modelo |

Las demás (D-06 a D-18) y las preguntas abiertas están en
[`docs/plan/10-riesgos-y-decisiones.md`](plan/10-riesgos-y-decisiones.md).

## Fases

| Fase | Semanas | Qué queda |
|---|---|---|
| F0 Cimientos | 1 | Dominio comprado, trámites de pago en curso, CI y documentos base |
| F1 Web a Cloudflare | 1–2 | La misma web en `babycaleb.com`, metadatos por página y páginas legales |
| F2 Nace el sistema | 2–4 | Worker, D1, panel con la marca, Access, respaldos |
| F3 Un dato, un solo dueño | 4–6 | Un catálogo para web, bot y panel; el chat de la web es el mismo bot |
| F4a Pedidos y entregas | 6–8 | Pedidos, carrito, pago manual, motorizados, guía y seguimiento |
| F4b Pagos en línea | 8–10 | Yappy, Tilopay y PayPal con conciliador |
| F5 Contabilidad | 10–12 | Asientos automáticos, compras, gastos, conciliación, reportes y cierre |
| F6 Asistente completo | 12–14 | Panel, Telegram y MCP, con tope de gasto |
| F7 Crecer | 14–17 | Mi cuenta, recompra con talla siguiente, Socios, Meta, cupones, auditoría |
