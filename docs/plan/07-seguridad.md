# 07 · Seguridad y datos personales

## 1. Quién entra por dónde

| Superficie | Quién | Cómo se identifica | Qué puede |
|---|---|---|---|
| `babycaleb.com` | Cualquiera | Nadie | Ver catálogo, crear pedido, pagar, ver un pedido con su enlace secreto |
| `babycaleb.com/mi-cuenta` | Clienta | Celular + código de un solo uso (o PIN) | Sus pedidos, saldo, seguimiento, repetir pedido |
| `panel.babycaleb.com` | Dueña, asistente, contadora | Cloudflare Access + JWT validado | Según su rol |
| `ruta.babycaleb.com` | Motorizado | Celular + PIN | Solo sus entregas del día |
| `panel.babycaleb.com/mcp` | Equipo desde un cliente MCP | OAuth o token personal | Herramientas de su rol |
| `/api/pagos/*/aviso` | Pasarelas | Firma o consulta a la pasarela | Avisar un pago |
| RPC `SistemaWeb`, `SistemaCRM` | La web y el CRM | Service binding (no sale a internet) | Su entrypoint, con `actor` revisado |

### Roles

| Permiso | dueña | asistente | contadora | motorizado |
|---|---|---|---|---|
| Ver y crear pedidos | ✓ | ✓ | ver | sus entregas |
| Confirmar abonos y cobros | ✓ | — | — | cobrar el saldo de su entrega |
| Ver costo y margen | ✓ | — | ✓ | — |
| Cambiar precios, ajustar stock, mermas | ✓ | — | — | — |
| Compras y gastos | ✓ | gastos | ver | — |
| Contabilidad, conciliación, cierre | ✓ | — | ✓ (no cierra) | — |
| Ajustes e interruptores | ✓ | — | — | — |
| Asistente | todo su rol | su rol | lectura | — |

## 2. Cloudflare Access en el panel

- Aplicación de Access para `panel.babycaleb.com` (y otra para staging), con política por correo
  de las personas de `usuarios`. Access es gratis hasta 50 usuarios.
- **El Worker valida el JWT** de `Cf-Access-Jwt-Assertion` en cada solicitud: firma con las llaves
  de `https://<equipo>.cloudflareaccess.com/cdn-cgi/access/certs` (en caché), `aud` igual a
  `ACCESS_AUD`, `iss` igual al dominio del equipo, vigencia. Falla cerrado y responde con el motivo
  (sin token, audiencia, vencido, firma) como `D_Casa_new_word/edge/src/puerta.ts` desde el
  incidente 4 de D'Casa. El código se porta de ahí, con sus pruebas.
- El correo del JWT se cruza con `usuarios.correo` y `activo = 1`; si no está, 403.
- `workers_dev = false` y `preview_urls = false` en producción; si se apagara solo en el panel de
  Cloudflare, el siguiente despliegue lo volvería a encender.
- `/mcp` y `ruta.*` quedan fuera de la aplicación de Access y tienen su propia puerta.
- Cambios de estado del panel exigen `Origin` igual al del panel (defensa CSRF además de la cookie
  de Access con `SameSite`).

## 3. Motorizados y clientas

**Motorizados** (`ruta.babycaleb.com`):

- Celular + PIN de 6 dígitos que pone la dueña desde el panel.
- PIN guardado con PBKDF2-SHA256, 100.000 iteraciones (el máximo que acepta WebCrypto en Workers),
  sal por motorizado y `PIN_PEPPER` secreto. `PIN_PEPPER` no se rota nunca (rotarlo invalida todos
  los PIN; misma regla que `DCASA_PIN_PEPPER`).
- 5 fallos → bloqueo de 15 minutos, contado en D1 (no en el rate limiting del runtime, que es
  aproximado).
- Sesión: cookie `HttpOnly; Secure; SameSite=Strict`, firmada con HMAC (`SESION_HMAC`), 14 horas,
  revocable desde el panel (fila en `sesiones`).
- Solo ve las entregas que tiene asignadas hoy; no ve montos de pedidos, solo el saldo a cobrar.

**Clientas** (`/mi-cuenta`, F7):

- Código de 6 dígitos por WhatsApp con una **plantilla de autenticación de la Cloud API** (la manda
  el CRM por `bc-avisos`); nunca por el puente QR. Alternativa: PIN como Socios de D'Casa.
- El código vence a los 10 minutos, se guarda con hash, 5 intentos, y no se pide más de 3 veces por
  hora por celular.
- Sesión firmada de 30 días, revocable.

## 4. Superficie pública de la web

| Ruta | Defensa |
|---|---|
| `POST /api/pedidos` | Turnstile verificado en el servidor, rate limiting (10 por minuto por celular), cuerpo ≤ 16 KB, zod, precios del servidor, idempotencia |
| `POST /api/pedidos/:token/pago` | Token de 256 bits, idempotencia, monto calculado por el servidor |
| `GET /api/pedidos/:token` | Token de 256 bits; no devuelve nombre, celular ni dirección completa |
| `POST /api/pagos/*/aviso` | Cuerpo crudo ≤ 64 KB, firma o consulta, evento único, monto igual |
| `POST /api/chat` | Rate limiting, tope de largo, sesión anónima con cookie, la misma defensa contra abuso que el CRM (`src/spam.ts`) |
| `GET /api/geo/*` | Solo hacia Nominatim (no hay URL libre: sin SSRF), caché, rate limiting |
| `POST /api/cuenta/*` | Turnstile, candados en D1 |

El rate limiting del runtime (`[[ratelimits]]`, periodo de 10 o 60 s) es aproximado y por
ubicación: frena abuso, no garantiza un tope exacto. Lo que exige un tope exacto (PIN, códigos) se
cuenta en D1.

## 5. Cabeceras

Los estáticos llevan las cabeceras en `public/_headers` (lo mismo que hoy está en `netlify.toml`).
El HTML que reescribe el Worker y todo `/api/*` las ponen en el código, porque `_headers` no se
aplica a respuestas del Worker.

| Cabecera | Valor |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`; `script-src` con el propio sitio, el componente de Yappy, el SDK de PayPal, Turnstile y el píxel de Meta (F7); `frame-src` para PayPal y Turnstile; `img-src 'self' data: blob:` y `mapas.babycaleb.com`; `connect-src 'self'` y lo que pida cada pasarela. Se escribe en F4 con la lista exacta de cada proveedor |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (después de confirmar que todo subdominio tiene HTTPS) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(self), camera=(), microphone=()` en la web; `camera=(self)` en `ruta.*` para la foto de entrega |
| `X-Robots-Tag` | `noindex` en `panel.*`, `ruta.*`, staging, `/seguimiento/*`, `/mi-cuenta/*`, `/pedido/*` |

## 6. Datos personales (Ley 81 de 2019)

Panamá regula los datos personales con la Ley 81 de 2019 y su reglamento (Decreto Ejecutivo 285 de
2021). Este plan aplica lo básico; el texto final del aviso de privacidad lo revisa un abogado.

| Dato | Para qué | Dónde | Cuánto tiempo |
|---|---|---|---|
| Nombre, celular, correo | Pedido, entrega, avisos | D1 `clientes` | Mientras sea clienta; anonimizable a pedido |
| Dirección y coordenadas | Entrega | D1 `direcciones` | Igual |
| Fotos de entrega | Prueba de entrega | R2 privado | 90 días (PENDIENTE de la dueña) |
| Comprobantes de pago y recibos | Contabilidad | R2 privado | 5 años (como D'Casa por la DGI) |
| Conversaciones | Atención | D1 del CRM | Lo que ya purga el CRM |
| Mensajes con el asistente | Trabajo interno | D1 | 180 días sin actividad |
| Lo que el asistente le manda al modelo | Contestar al equipo | Meta (Muse Spark Contributor, entrena con lo que recibe) | Lo que decida Meta: por eso no lleva datos personales de clientas ([06 §7](06-asistente.md#7-defensas)) |

Reglas:

- **Consentimiento**: el checkout separa lo necesario para el pedido (aceptado al comprar) del
  permiso para mensajes de seguimiento y recompra (casilla aparte, sin marcar). Se guarda cuándo y
  dónde se dio (`consentimiento_en`, `consentimiento_origen`). El seguimiento del CRM respeta esa
  marca.
- **Derechos de la persona** (acceso, rectificación, cancelación, oposición): desde el panel la
  dueña exporta los datos de una clienta o la anonimiza (los pedidos y asientos se conservan por
  obligación contable).
- **Mínimo necesario**: el bot y la web nunca reciben dirección completa ni datos de otra clienta;
  el motorizado ve solo lo de su entrega.
- **Fuera de GitHub**: ningún dato real en el repositorio, en pruebas ni en documentos (regla de
  D'Casa). Las pruebas usan datos inventados.
- **Registros sin datos personales**: los logs llevan ids, nunca nombres, celulares ni montos con
  nombre.
- **Meta CAPI**: celular y correo normalizados y con hash SHA-256 antes de salir; solo de quien dio
  el consentimiento de marketing.
- El aviso de privacidad de la web reemplaza al genérico y enlaza desde el checkout. Dice que el
  equipo usa un asistente de IA de Meta y que a ese asistente no se le envían datos personales de
  las clientas.

## 7. Secretos

Todos como **Secret** en Cloudflare (nunca *Text*: los de tipo Text se pierden en el siguiente
despliegue, como documenta el CRM), cargados desde GitHub Environments en el despliegue o pegados
por la dueña en el panel de Cloudflare. Nunca en el chat ni en el repo.

| Worker | Secreto | Para qué |
|---|---|---|
| sistema | `ACCESS_AUD`, `ACCESS_EQUIPO` | Validar el JWT de Access (no son secretos fuertes, pero van juntos) |
| sistema | `PIN_PEPPER` | PIN de motorizados y clientas. No se rota |
| sistema | `SESION_HMAC` | Firmar sesiones |
| sistema | `TURNSTILE_SECRET` | Verificar Turnstile |
| sistema | `META_API_KEY` | Asistente (Muse Spark). No es el token de Messenger ni de Instagram |
| sistema | `YAPPY_ID_COMERCIO`, `YAPPY_CLAVE_SECRETA` | Botón de Pago |
| sistema | `TILOPAY_*` (los que pida su API) | Tilopay |
| sistema | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` | PayPal |
| sistema | `META_CAPI_TOKEN` | Conversions API (F7) |
| sistema | `NOMINATIM_CONTACTO` | Identificarse ante Nominatim (variable, no secreto) |
| web | `TURNSTILE_SITEKEY` | Variable pública |
| CRM | Los de hoy + ninguno nuevo | Habla con el sistema por binding, sin llave |
| GitHub | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RESPALDO_CLAVE` | Despliegue y respaldos |

El sistema **no guarda tokens de WhatsApp ni de Meta Messaging**: los avisos los manda el CRM, que
ya los tiene. Menos secretos en más sitios.

## 8. Archivos

- Subidas (comprobantes, recibos, fotos de entrega, adjuntos del asistente): tipo revisado por
  contenido (no por extensión), ≤ 10 MB, imágenes y PDF únicamente.
- Todo va a R2 privado con una llave aleatoria y su fila en `archivos`.
- Se sirven a través del sistema, con permiso revisado, como respuesta directa o URL firmada de 5
  minutos. Nunca un enlace público.
- El asistente marca los archivos como datos y no les obedece (§7 de [06](06-asistente.md)).

## 9. Amenazas y respuesta

| Amenaza | Defensa |
|---|---|
| Alterar el precio desde el navegador | El servidor ignora precios; recalcula todo |
| Aviso de pago falso | Firma o consulta a la pasarela, evento único, monto igual |
| Adivinar enlaces de pedido o guía | Tokens de 256 bits; el número legible no abre nada |
| Fuerza bruta de PIN o código | Candados en D1, bloqueo temporal, Turnstile |
| Inyección de instrucciones al asistente por mensajes de clientas o archivos | Datos marcados, confirmación en construcción, sin herramientas prohibidas |
| Vender la última caja dos veces | `CHECK` de existencias dentro del batch |
| Doble cobro por doble clic | Idempotencia por intento |
| Panel expuesto por workers.dev | `workers_dev = false`, JWT validado en el Worker |
| Secreto filtrado | Rotar en Cloudflare y en el proveedor; `PIN_PEPPER` es la excepción documentada |
| XSS guardado (nombres, notas) | React escapa; nada se inserta como HTML; CSP |
| SSRF por el geocodificador | Destino fijo, sin URL libre |
| Borrado de evidencia contable | Triggers que impiden editar y borrar libros |

## 10. Auditoría

Quedan registrados, sin poder editarse: `acciones` (asistente), `pedido_eventos`, `envio_eventos`,
`movimientos_inventario`, `asientos`, `eventos_pasarela`, `precios_historial`, `fusiones_cliente` y
las versiones de `ajustes`. El panel muestra «quién y cuándo» en cada pedido, pago y precio.
