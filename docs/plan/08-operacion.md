# 08 · Operación

## 1. Entornos

| Entorno | Web | Sistema | Datos | Pasarelas | Quién entra |
|---|---|---|---|---|---|
| Local | `vite` + `wrangler dev` | `wrangler dev` (D1 y colas locales) | Inventados | Respuestas grabadas | Quien programa |
| Staging | `babycaleb-web-staging` (workers.dev) | `babycaleb-sistema-staging` (workers.dev con Access) | `babycaleb-db-staging`, inventados | Modo de pruebas | El equipo, con Access |
| Producción | `babycaleb.com` | `panel.` y `ruta.babycaleb.com` | `babycaleb-db` | Reales | Todo el mundo / el equipo |

Staging nunca recibe datos reales de clientas. El CRM de producción no apunta al sistema de
staging: para probar el contrato con el CRM se usa un CRM de staging o pruebas de contrato.

Trampas de `wrangler.jsonc` que ya costaron en D'Casa (`CONTEXTO_AGENTICO.md` § Cloudflare):

- `routes` se **hereda** en los entornos con nombre: staging necesita `"routes": []` o se lleva el
  dominio de producción.
- Con `routes` y sin `workers_dev`, wrangler apaga workers.dev: se declara siempre explícito.
- El dominio propio no se crea si el nombre ya tiene un registro A o CNAME.
- Las variables del panel de Cloudflare se pierden en un despliegue sin `--keep-vars`; los valores
  van como Secret o en el `wrangler.jsonc`.

## 2. CI/CD

Tres flujos en `.github/workflows/`, separados para que si uno no construye los otros sigan
publicando (lección del puente del CRM).

### `web.yml`

| Disparo | Pasos |
|---|---|
| PR y push a `main` (cambios fuera de `sistema/`) | `npm ci` · `npm run lint` (tsc) · pruebas del Worker y del contenido (precios fuera de `content.json`, códigos válidos) · `vite build` · presupuesto de tamaño · Lighthouse sobre la vista previa |
| PR | `wrangler versions upload` → enlace de vista previa comentado en el PR (con `noindex`) · capturas de las 7 páginas en computadora y teléfono comparadas contra producción |
| Merge a `main` | Despliegue a producción (la web es estática y de bajo riesgo: igual que hoy publica Netlify) · `/api/salud` debe responder con la versión nueva |
| Manual | Despliegue a staging desde cualquier rama |

### `sistema.yml`

| Disparo | Pasos |
|---|---|
| PR (cambios en `sistema/`) | `npm ci` · typecheck · pruebas unitarias e integración en `vitest-pool-workers` · todas las migraciones desde cero · huella del contrato · build del panel · presupuesto de consultas de las pantallas calientes |
| Manual, `entorno = staging`, cualquier rama | Migraciones en `babycaleb-db-staging` → `wrangler deploy --env staging` → `/salud` con versión y migración esperadas → E2E de humo |
| Manual, `entorno = produccion`, solo `main` | Exportación de respaldo (`respaldo_previo = true` por defecto) → migraciones → `wrangler deploy` → `/salud` exige `version` = SHA y `migracion` = la última → prueba de humo → resumen en el run |

Receta de D'Casa que se adopta: cambio en una rama `claude/...` con su prueba → staging → capturas
a la dueña → su visto bueno → PR → `main` → producción a mano. Producción nunca se publica sola.

### Repositorio del CRM

Su `deploy.yml` sigue igual. Se agrega la prueba de huella del contrato y, al cambiar el contrato,
el orden es: sistema primero, CRM después.

## 3. Migraciones

- `wrangler d1 migrations create babycaleb-db <nombre>` crea `sistema/migrations/NNNN_nombre.sql`;
  `wrangler d1 migrations apply` aplica las pendientes y las anota en `d1_migrations`.
- **Siempre compatibles hacia atrás con el código que está publicado**: expandir → migrar →
  contraer. Ejemplo para renombrar una columna: (1) agregar la nueva y escribir en las dos;
  (2) copiar los datos; (3) leer de la nueva; (4) en otra versión, quitar la vieja.
- Nunca un `DROP` en la misma versión que deja de usar lo que borra.
- Toda migración se prueba en CI sobre una base vacía y, antes de producción, sobre una copia de la
  exportación más reciente (en el runner, cifrada, sin subirla como artefacto).
- Regla de D'Casa: **nunca volver a una versión vieja del código sin revisar que la base sea
  compatible con ella**.

## 4. Respaldos y restauración

| Capa | Qué cubre | Cómo |
|---|---|---|
| Time Travel de D1 | Cualquier minuto de los últimos 30 días | `wrangler d1 time-travel restore babycaleb-db --timestamp <iso>`. **Restaura encima de la base actual**: último recurso |
| Exportación diaria | Copia fuera de D1 | `respaldo.yml` a las 08:00 UTC (03:00 Panamá): `wrangler d1 export --remote` → cifrado con `age` (llave pública en el repo, privada como `RESPALDO_CLAVE` en GitHub y fuera de Cloudflare con la dueña) → R2 `babycaleb-respaldos/diario/AAAA-MM-DD.sql.age` |
| Retención | — | Diarios 35 días, el del día 1 de cada mes 12 meses, el del cierre de año 5 años (reglas de ciclo de vida de R2 por prefijo) |
| R2 privado | Comprobantes y fotos | Sin borrado automático salvo lo que marque `archivos.borrar_despues_de`; versionado del bucket si se habilita |
| Simulacro semanal | Que el respaldo sirve | Descifrar el último, importarlo en una D1 de simulacro (o SQLite local), correr las verificaciones (balance que cuadra, existencias = movimientos, conteos) y avisar si falla |

## 5. Salud y observabilidad

`GET panel.babycaleb.com/salud` (y `SistemaWeb.salud()` para la web):

```json
{
  "version": "<sha del commit desplegado>",
  "migracion": "0007_pagos_liquidaciones",
  "humo": { "d1": "ok", "r2": "ok", "cola": "ok", "outbox_pendientes": 0, "dlq": 0 },
  "interruptores": { "checkout": true, "pasarelas": ["yappy"] }
}
```

«Sano» = versión correcta + migración correcta + humo en ok (regla 1 de D'Casa). Un 200 a secas no
cuenta.

- **Workers Logs** encendido (`observability.enabled`), 7 días de retención, 20 millones de eventos
  al mes incluidos. Logs en JSON con `evento`, ids y tiempos; sin nombres, celulares ni montos con
  nombre.
- **Alertas** al equipo por `sistema.alerta` (cola → consola de Telegram), como máximo una por tipo
  cada 10 minutos: errores 5xx en ráfaga, mensajes en colas muertas, outbox atascado, conciliador
  con pagos de más de 24 h, diferencias entre existencias y movimientos, respaldo fallido.
- **Revisión externa**: el cron de la web llama a `SISTEMA.salud()` cada 5 minutos y avisa si dos
  seguidas fallan.
- **Gasto**: alertas de presupuesto de Cloudflare a $10 y $20 (Billing › Billable Usage), como D'Casa.

## 6. Crons

Dos expresiones en `babycaleb-sistema` (UTC; Panamá es UTC−5 todo el año):

| Expresión | Qué despacha |
|---|---|
| `*/5 * * * *` | Republicar outbox pendiente · cada 10 min: conciliador de pagos · cada 15 min: vencer reservas y pedidos web · cada 5 min: purga de `idempotencia` y `controles` vencidos (por lotes) |
| `0 11 * * *` (06:00 Panamá) | Alertas de stock bajo y de reposición · resumen del día anterior a la dueña · verificación existencias = movimientos · borrar archivos vencidos · el día 1: recordatorio de cierre de mes y paquete del mes anterior para la contadora |

En `babycaleb-web`: `*/5 * * * *` para la revisión de salud del sistema. Toda tarea del cron es
idempotente y trabaja por lotes (D1 permite 1.000 consultas por invocación; un `batch` cuenta como
una).

## 7. Runbooks

| Situación | Qué hacer |
|---|---|
| Una pasarela se cae | Apagarla en el panel (`ajustes.pasarelas_activas`). El checkout ofrece las otras y el pago manual. Los pagos en «confirmando» los resuelve el conciliador |
| D1 no responde | La web muestra el catálogo de la copia de respaldo del build; el checkout se apaga solo y ofrece WhatsApp. El bot dice que confirma disponibilidad una persona |
| Mensajes en la cola muerta | Ver el tipo en el panel técnico, corregir la causa, reencolar desde el panel (cada consumidor ignora repetidos) |
| La clienta pagó dos veces | Ver `pagos` del pedido; reembolsar el duplicado (acción sensible) |
| Un motorizado perdió el teléfono | Revocar sus sesiones y cambiarle el PIN desde el panel |
| Se filtró un secreto | Rotarlo en el proveedor y en Cloudflare; desplegar. `PIN_PEPPER` no se rota (documentado) |
| Despliegue malo del sistema | `wrangler rollback` a la versión anterior si la base sigue compatible; si no, migración hacia adelante. Time Travel solo si hay datos dañados |
| Restaurar un respaldo | Primero en una base nueva para revisar; después decidir entre Time Travel o importación. Siempre con la dueña informada |
| **Corte Netlify → Cloudflare (F1)** | Bajar el TTL de DNS un día antes; publicar en Cloudflare; probar con el dominio; cambiar; dejar Netlify vivo 2 semanas; borrar el sitio de Netlify después |
| **Traspaso del catálogo (F3)** | Avisar a la dueña (15 min sin `/venta`) → interruptor del CRM en solo lectura → exportar `catalog_items` y `stock_movements` a R2 → importar al sistema → comparar fila por fila (código, precio, stock por bodega) → `CATALOGO_FUENTE=sistema` → prueba de `/stock` y de una búsqueda del bot → abrir. Vuelta atrás: `CATALOGO_FUENTE=local` (la D1 del CRM queda intacta hasta F5) |
| **Arranque contable (F5)** | El procedimiento de [05 §7](05-contabilidad.md#7-arranque-contable) |

## 8. DNS y correo

Zona `babycaleb.com` en la cuenta de la agencia, comprada en Cloudflare Registrar con Baby Caleb
como titular.

| Registro | Para qué |
|---|---|
| `babycaleb.com`, `panel`, `ruta` | Dominios propios de los Workers (Cloudflare crea el DNS y el certificado) |
| `www` | Regla de redirección 301 a `babycaleb.com` |
| `mapas` | Dominio propio del bucket R2 `babycaleb-mapas` |
| MX + TXT de Email Routing | `hola@babycaleb.com` y lo demás al Gmail del negocio |
| SPF | `v=spf1 include:_spf.mx.cloudflare.net ~all`, más el del proveedor de envío si se usa |
| DKIM | El del proveedor de envío, si se usa |
| DMARC | `p=none` con reportes el primer mes; después `quarantine` |
| TXT de Meta | Verificación del dominio en Business Manager (CAPI y catálogo) |
| TXT de Google | Search Console |

## 9. Documentos vivos

Se crean en F0 y se ponen al día en cada sesión (lo que no se escribe se pierde):

| Documento | Qué tiene |
|---|---|
| `docs/LEEME_PRIMERO.md` | Cómo se trabaja con la dueña, qué necesita su «sí», la receta de producción, trampas conocidas y la bitácora de sesiones |
| `docs/PRIORIDADES.md` | El orden vigente de trabajo |
| `docs/CONTEXTO_AGENTICO.md` | Cada incidente y falla de CI con su causa y su arreglo |
| `docs/FUENTES_DE_VERDAD.md` | Quién es dueño de cada dato (ampliación del del CRM) |
| `docs/CONTRATO_CRM.md` | El contrato vivo con el CRM |
| `docs/RUNBOOK.md` | Los runbooks de §7, ampliados con lo aprendido |
| `docs/plan/` | Este plan; se marca qué ya se construyó |

## 10. Costos y límites

Lo incluido en el plan Workers Paid ($5/mes, ya contratado), según las páginas de precios de
Cloudflare consultadas el 29-oct-2026:

| Servicio | Incluido al mes | Uso esperado de Baby Caleb |
|---|---|---|
| Workers | 10 millones de solicitudes, 30 millones de ms de CPU | Muy por debajo |
| Estáticos de Workers | Ilimitados y gratis | La web entera |
| D1 | 25 mil millones de filas leídas, 50 millones escritas, 5 GB | Muy por debajo |
| Queues | 1 millón de operaciones (~3 por mensaje); después $0.40 por millón | Unos miles de mensajes |
| R2 | 10 GB y operaciones gratis del nivel incluido | Comprobantes, fotos, respaldos, teselas |
| Workers Logs | 20 millones de eventos, 7 días | Por debajo |
| Access | Gratis hasta 50 usuarios | 3–8 personas |
| Turnstile, Email Routing, Web Analytics | Gratis | — |

Límites que el diseño respeta: D1 de 10 GB por base, 1.000 consultas por invocación (un batch es
una), 100 parámetros por consulta, 30 s por consulta, filas de hasta 2 MB; 32 invocaciones
encadenadas por solicitud a través de bindings; rate limiting con periodos de 10 o 60 s.

Total mensual estimado de todo el sistema: **≈ $10–15** (plan + puente actual + bot del CRM +
asistente con Muse Spark Contributor, ≈ $1.5–3 + dominio), más las comisiones de cada cobro en
línea. Detalle del asistente en [06 §6](06-asistente.md#6-modelo-costo-y-caché).
