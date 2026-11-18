# Tilopay — lo que dice la documentación oficial, y el hueco que deja

**Leído el 2026-11-18** de `https://tilopay.com/en/developers/*`. Cada página de
esa documentación trae su propia fecha de verificación (`last_verified`), que va
citada al lado de cada dato: van del **2026-08-28 al 2026-10-22**.

Este archivo es para Tilopay lo que `docs/YAPPY-BOTON.md` es para Yappy: la
documentación oficial transcrita **antes** de programar, porque el repositorio ya
decidió que *«no se escribe código con nombres adivinados»*
(`docs/plan/04-pagos.md` §4.1). La diferencia incómoda es que aquí el código ya
está escrito —`sistema/src/pagos/tilopay.ts`, con 33 pruebas en verde— y se
escribió sin esta lectura. El §18 compara las dos cosas renglón por renglón.

Todo lo de aquí está **copiado** de la documentación, no deducido. Lo que no
está, lleva 🔴 y dice a quién se le pregunta. La regla del repositorio es que
**un dato inventado aquí acaba en un cobro mal hecho**, así que diez `PENDIENTE`
honestos valen más que una suposición elegante.

> **Soporte de Tilopay:** se abre un caso en <https://tilopay.com/en/soporte>.
> El panel del comercio es `admin.tilopay.com`.

**Ayuda para leer esto:** cada página de su documentación sirve su **Markdown
crudo** añadiendo `.md` a la ruta, que es como se leyeron (el HTML esconde los
bloques de código en un resaltador). Y está el **OpenAPI 3.1** completo en
`https://tilopay.com/developers/openapi.json`: es la fuente más exacta que
tienen, porque dice sin prosa de por medio qué campo es obligatorio.

---

## 1 · Las tres cosas que cambian el plan

Antes del detalle, porque el detalle es largo y estas tres mueven decisiones ya
tomadas:

1. **Tilopay SÍ tiene webhook, también en el flujo que usamos.** El adaptador
   dice en su cabecera que no lo tiene. Lo dice su página de webhooks con todas
   las letras (§7). Lo que no es público es el *contrato* del payload: se pide
   abriendo un caso. O sea: la decisión del repositorio («la verdad es la
   consulta») **sigue siendo la correcta y ahora la respalda su propia
   documentación**, pero el hecho en el que se apoyaba era falso.
2. **La consulta, que es lo único que aprueba un pago, está leyendo la
   respuesta equivocada.** La respuesta real de `consult` viene envuelta en
   `response`, **que es un array**; el adaptador busca la envoltura en `data`,
   `result` o `transaction`. Con la respuesta de verdad delante, todo cobro
   saldría **«pendiente» con monto `null`**, para siempre (§18, fila 8). Las
   pruebas no lo ven porque los datos de prueba están inventados.
3. **`processPayment` pide 18 campos obligatorios y el adaptador manda 6.**
   Faltan los doce de facturación (`billTo*`), `subscription` y `platform`
   (§5). Un cobro así probablemente no se crea.

Y una cuarta que no cambia el plan pero sí una pantalla: **poner Tilopay en
«modo de prueba» en nuestro panel no hace que Tilopay cobre de prueba** (§12).
Es el caso de `checkout_activo` otra vez —un ajuste que nadie consulta— y está
en `docs/TRAMPAS.md` §13.

---

## 2 · Las cuatro vías de cobro, y la única pregunta que importa

La pregunta que decide todo es **dónde quedan los datos de la tarjeta**, porque
eso decide si el servidor de Baby Caleb entra en alcance PCI DSS. Tilopay lo
tiene tabulado en
[Four integration paths](https://tilopay.com/en/developers/api/caminos-de-integracion)
(`last_verified: 2026-10-20`), y el resumen es suyo, no mío:

| Vía | Quién hace el formulario | Por dónde viajan los datos de la tarjeta | Qué exige |
|---|---|---|---|
| **1 · Sin código** | La plataforma (plugin) | *«Never pass through your systems»* | Configurar dentro de la plataforma |
| **2 · Página de pago alojada** (la nuestra) | Tilopay | *«Your customer types them on a secure Tilopay page; you never see a card number»* | Servidor: pedir la URL y atender la vuelta |
| **3 · SDK de JavaScript** | Nuestro sitio | *«Typed on your page but sent from the browser straight to Tilopay; they do not pass through your server»* | Frontend JS + backend para el token |
| **4 · Servidor a servidor** | Nuestro sitio | *«Card data passes through your server»* | **Certificación PCI del comercio** + URL dada a mano |

Y el aviso, literal, de esa misma página:

> **Warning:** Path 4 is not self-serve: it is exclusive to merchants holding PCI
> certification, and the URL is provisioned individually. **It is also the only
> path that puts your server inside PCI DSS scope.** Paths 2 and 3 avoid that
> cost and you can start them today.

### ¿Entramos en alcance PCI? NO, y está escrito

Con la vía 2 —la que ya eligió `04-pagos.md` §4.2— **no**. La frase que lo
cierra es *«you never see a card number»*: la clienta teclea la tarjeta en
`secure.tilopay.com`, no en `babycaleb.com`. La vía 3 tampoco entra, aunque el
formulario se vea en nuestra página, porque *«the data travels from the browser
straight to Tilopay»*.

La vía 4 **sí** entraría, y además no se puede ni empezar: pide certificación
PCI y una URL con su `tx-proxy-key` que Tilopay entrega comercio por comercio
([Server-to-server](https://tilopay.com/en/developers/server-to-server),
`last_verified: 2026-10-20`). O sea que el adaptador acierta al no usarla, pero
la razón que escribe está a medias: no es que la página alojada «no traiga
devolución» (sí la trae, §15), es que la vía 4 es la única con alcance PCI.

### Qué sí convendría comparar: la vía 3

La vía 2 manda a la clienta a `secure.tilopay.com` y la trae de vuelta. La vía 3
—SDK v2.1.1, [JavaScript SDK](https://tilopay.com/en/developers/sdk),
`last_verified: 2026-10-22`— deja el formulario dentro de nuestra página con el
mismo alcance PCI (ninguno), y su `Tilopay.Init()` devuelve el campo
**`environment`**, que es la única señal en tiempo de ejecución de si la cuenta
está en prueba o en producción (§12). No propongo cambiar de vía en esta tarea;
lo dejo anotado porque resuelve dos cosas a la vez (la fricción del redirect y la
ceguera del modo) y porque el día que se evalúe, la decisión tiene que estar
escrita y no improvisada.

---

## 3 · Autenticación

De [API · Authentication](https://tilopay.com/en/developers/api/autenticacion) y
[API · Get API token](https://tilopay.com/en/developers/api/autenticacion/token-api)
(las dos `last_verified: 2026-10-20`).

Un solo host para todo, prueba incluida: **`https://app.tilopay.com`**.

| Operación | Ruta | Para qué |
|---|---|---|
| Token de API | `POST /api/v1/login` | Llamadas servidor a servidor |
| Token de SDK | `POST /api/v1/loginSdk` | El que recibe `Tilopay.Init()` |

**Cuerpo del login** (y nada más: el OpenAPI declara exactamente dos campos
obligatorios y ninguno opcional):

```json
{ "apiuser": "<api_user>", "password": "<api_password>" }
```

**Respuesta:**

```json
{ "access_token": "<jwt>", "token_type": "bearer", "expires_in": 86400 }
```

- `expires_in`: *«Token lifetime as an **integer in seconds** (for example
  `86400`). The exact value comes in this response: do not assume it on the
  client.»*
- **Vigencia: 24 h** el token de API; **1 h** el del SDK (y ahí `expires_in`
  llega como texto de fecha, `"2023-06-05 13:32:06"`, no como número — dos
  formatos para el mismo nombre de campo).
- Se manda así: `Authorization: bearer <token>` (minúscula en su ejemplo).
- Credenciales inválidas → **HTTP 401** con `{"error": "Unauthorized"}`.

**Tres cosas que no se adivinan y cambian el diseño:**

- *«**Tokens cannot be revoked.** If a token leaks there is no operation to
  invalidate it: treat the leak as an incident and rotate credentials with
  Tilopay.»*
- *«**There is no limit** on concurrent tokens per merchant. You can request one
  per process without invalidating the previous ones.»* — **esto vindica** la
  decisión del adaptador de no cachear el token: pedir uno por cobro no rompe
  nada. Su documentación recomienda cachearlo (*«Cache it server-side and renew
  on expiry»*), así que es un intercambio consciente: dos viajes HTTP por cobro a
  cambio de no guardar el secreto de un comercio en memoria compartida de un
  Worker. Queda escrito que es a propósito.
- *«Never put `apiuser` or `password` in the browser. The login runs on your
  server; only the SDK token reaches the browser.»*

Las tres credenciales —`apiuser`, `password` y **`key`**— salen del panel del
comercio, en **Admin panel · Platform integrations**
(`admin.tilopay.com/platform-integrations`). Esto confirma letra por letra lo que
ya declara `sistema/src/dominio/pasarelas.ts`.

---

## 4 · Cómo se consiguen credenciales de prueba

De [Developer registration](https://tilopay.com/en/developers/registro)
(`last_verified: 2026-08-29`):

> There are no shared or public sandbox credentials: every developer registers and
> receives their own.

1. Registrarse en <https://tilopay.com/en/developers/registro>.
2. Tilopay habilita una **cuenta de prueba** y emite las credenciales de ese
   comercio.
3. Con esas credenciales se pide el token de API o el del SDK.

Esto conviene no mezclarlo con el §12: una **cuenta de desarrollo** tiene
credenciales propias, pero **dentro de una misma cuenta** las credenciales no
cambian entre modo prueba y modo real.

---

## 5 · El cobro: `processPayment`

De [API · processPayment](https://tilopay.com/en/developers/api/hosted-payment-page/process-payment)
(`last_verified: 2026-10-20`) y del OpenAPI.

```http
POST /api/v1/processPayment
Authorization: bearer <token>
Content-Type: application/json
```

### Los 18 campos OBLIGATORIOS

El OpenAPI los lista como `required`. Son dieciocho, y el adaptador manda seis.

| Campo | Qué es |
|---|---|
| `redirect` | *«Site where you wait for the transaction response… It must support the **GET** method.»* |
| `key` | La llave de integración del comercio |
| `amount` | El importe de la compra (texto; el ejemplo es `"1.00"`) |
| `currency` | ISO, p. ej. `USD`, `CRC`, `GTQ` |
| `orderNumber` | *«it can be alphanumeric»* |
| `capture` | *«Capture and authorize: 1 yes, 0 no.»* — declarado **`type: string`** |
| `billToFirstName` | Nombre |
| `billToLastName` | Apellidos |
| `billToAddress` | Dirección |
| `billToAddress2` | Dirección 2 |
| `billToCity` | Ciudad |
| `billToState` | Provincia **en ISO**, p. ej. `CR-SJ` o `US-CA` |
| `billToZipPostCode` | Código postal |
| `billToCountry` | País **ISO Alpha-2**, p. ej. `CR`, `US`, `GT` |
| `billToTelephone` | Teléfono |
| `billToEmail` | Correo de quien compra |
| `subscription` | *«1 to force the customer to save the card in Tilopay, 0 not to.»* |
| `platform` | *«Name of the platform where the transaction is generated.»* (su ejemplo: `"api"`) |

**Opcionales:** todos los `shipTo*`, más `returnData` (*«Sending a base 64 string
is recommended»*), `hashVersion` (`V1` por omisión, `V2`; *«Only used when
implementing hash verification»*) y `token_version` (*«Send as value "v2"»*).

**Lo que esto le exige a Baby Caleb y hoy no tenemos:** el pedido de la web se
crea con nombre y celular (`sistema/src/pagos/cobrar-carrito.ts`), sin correo, sin
dirección estructurada, sin provincia ISO y sin código postal. Tilopay los pide
obligatorios. Dos salidas, y hay que elegir a conciencia:

- **Pedirle los datos a la clienta** en la pantalla de pago (el correo hace falta
  de todas formas para el comprobante; dirección y provincia también sirven a la
  entrega).
- **Rellenar lo que no aplique con lo que ya tenemos del pedido** (la zona de
  envío ya dice la provincia). 🔴 **No está documentado si Tilopay valida el
  contenido** de `billToState`, `billToZipPostCode` o `billToCountry`, ni qué
  pasa con un valor de relleno. Panamá no usa código postal como Costa Rica, y
  qué poner ahí **es una pregunta para soporte**, no una decisión nuestra: un
  relleno a ojo aquí es exactamente la cifra inventada que `CLAUDE.md` prohíbe.

### La respuesta

```json
{
  "type": "100",
  "html": "Use url redirect",
  "url": "https://secure.tilopay.com/htmls/1212122_574572148file.html"
}
```

> `"type": "100"` means the form URL was generated: redirect the customer to
> `url` so they can complete the payment.

Los nombres son **`type`, `html`, `url`** y no hay otros. **Errores:** HTTP
**300, 400, 402 y 403**, todos con la forma `{"type": "...", "message": "..."}`.

---

## 6 · La vuelta del navegador

De la sección *«Parameters that arrive at the redirect»* de la misma página. La
clienta vuelve a nuestra `redirect` **por GET**, con:

| Parámetro | Qué es |
|---|---|
| `code` | `1` = aprobada; **cualquier otro valor = rechazada** |
| `description` | Texto del resultado |
| `auth` | Código de autorización |
| `order` | El `orderNumber` que mandamos |
| `tpt` y `tilopay-transaction` | El id de la transacción en Tilopay |
| `OrderHash` | Hash único de la transacción |
| `returnData` | Lo que mandamos en la petición |

El ejemplo literal de su propia página trae además `crd=` y `form_update=ok`,
que la tabla no explica (🔴).

Y el cierre, que es el que manda:

> Before delivering the product or releasing the service, confirm the transaction
> status with `POST /api/v1/consult` **from your server**.

O sea: **la vuelta del navegador no aprueba nada**, y lo dice Tilopay, no
nosotros. Coincide con `CLAUDE.md` («el navegador no decide un pago»).

**Ojo a una confusión que el código ya tiene:** `redirect` es **a dónde va la
clienta**, una página que ella va a mirar. No es la dirección del aviso
servidor-a-servidor. En Yappy esas dos cosas son `ipnUrl` y nada más; en Tilopay
son dos (`redirect` y el webhook del §7), y hoy `OrdenDeCobro` solo tiene un
campo, `urlAviso` (§18, fila 4).

---

## 7 · ¿Hay webhook? SÍ — y el adaptador dice que no

Esta es la corrección más importante del documento. De
[API · Webhooks](https://tilopay.com/en/developers/api/webhooks)
(`last_verified: 2026-10-20`), sección *«Main flow webhook»*, literal:

> **processPayment also has a webhook.** Its technical specification (the fields
> it sends) we deliver it when you request it, so your team can implement it:
> open a case in Support to receive it.

Y hay webhooks además en otros dos sitios:

- **Enlaces de pago:** `webhook_url` *«is configured when creating the link»*.
- **Recurrencia** (planes): seis campos del plan —`webhook_subscribe`,
  `webhook_payment`, `webhook_rejected`, `webhook_unsubscribe`,
  `webhook_reactive`— más `thanks_url`, que *«Not a webhook: it is a GET
  callback»*.

### Reintentos y qué contestar

| Origen | Intentos | Cuándo reintenta |
|---|---|---|
| Recurrencia | 5 | Si contestamos 400, 404, 502, 504 o 403 |
| **Compras** | **1** | **—** |

> Delivery is considered successful on an HTTP 200. Respond 200 as soon as you
> receive the event and process it separately: anything else counts as a failure,
> **and purchases have no second attempt.**

**Una compra tiene un solo intento de aviso.** Eso es lo contrario de Yappy, que
reintenta, y cambia la ruta: hay que contestar 200 de inmediato y hacer el
trabajo aparte. Formato: **JSON** (y el webhook de compras, a diferencia del de
recurrencia, manda el token de la tarjeta: *«Sent and usable»*).

### Y por qué la consulta sigue mandando

> **Origin verification.** The only origin verification available is the
> `orderHash`, and **its algorithm is not public**: it is requested by opening a
> case in Support.
>
> Until you have the algorithm, **do not take irreversible business decisions
> from webhook content alone: confirm the state against the API** before shipping
> or releasing a service.

Es, palabra por palabra, la decisión que el repositorio ya había tomado. El
adaptador tiene razón en el fondo y se equivoca en el hecho: no es que no haya
webhook, es que **el webhook no se puede verificar**, así que sirve como
disparador («mira a ver») y no como prueba.

**Lo que esto cambia en el plan:** el webhook no es un lujo. Sin él, un pago cuya
clienta cierra el navegador antes de volver se queda esperando al conciliador
(hasta 10 minutos, `04-pagos.md` §6); con él, la confirmación llega en segundos y
el conciliador queda como red de abajo. Pero **hay que pedir el contrato del
payload a soporte antes de escribir el receptor**, porque los nombres de sus
campos no son públicos — y adivinarlos es exactamente lo que prohíbe el §4.1 del
plan.

---

## 8 · `OrderHash` y la firma

Confirmado tal cual lo decía el adaptador, en dos sitios:

- `processPayment`: *«`OrderHash` is a unique string per transaction: **its
  algorithm is not public** and is requested by opening a case in Support.»*
- Webhooks: *«The only origin verification available is the `orderHash`, and its
  algorithm is not public.»*

Lo que **añade** la documentación y el adaptador no sabía:

- Hay **dos versiones** del esquema, que se eligen al cobrar con
  `hashVersion: V1 | V2` (`V1` por omisión), *«Only used when implementing hash
  verification»*. 🔴 En qué se diferencian, no está documentado.
- `processModification` también devuelve `OrderHash` (§15).
- En el payload de ejemplo del webhook de un **enlace de pago**, `orderHash`
  llega **vacío** (`"orderHash": ""`). 🔴 Si eso es el caso normal o el del
  ejemplo, no se dice.

**Qué garantiza entonces la integridad del retorno: nada.** Y por eso la única
defensa es la del repositorio: comparar contra `consult` **el estado y el
monto**. Mientras el algoritmo no llegue, `OrderHash` se guarda y no se usa para
decidir — que es justo lo que el adaptador ya escribe en su comentario.

---

## 9 · `consult`: la consulta que aprueba

De [API · consult](https://tilopay.com/en/developers/api/procesos-operativos/consult)
(`last_verified: 2026-10-20`).

```http
POST /api/v1/consult
Authorization: bearer <token>
```

Parámetros: **`key`** (obligatorio), **`orderNumber`** (obligatorio) y
`merchantId` (opcional).

### LA RESPUESTA DE VERDAD

Esto es lo que el adaptador no está leyendo. Va completa, de su ejemplo:

```json
{
  "type": "200",
  "message": "",
  "response": [
    {
      "id_tilopay": 734312,
      "orderNumber": "1212122",
      "amount": "5.00",
      "currency": "USD",
      "merchantId": "88803956",
      "code": "1",
      "response": "Transacción aprobada",
      "auth": "123456",
      "commission": 0.18,
      "iva_commission": 0.02,
      "retention_iva": 0.27,
      "retention_rent": 0.09,
      "cost": 0.35,
      "cost_iva": 0.05,
      "net_to_liquidate": "4.04",
      "capture": "Capture",
      "card": "4021",
      "last": "5221",
      "environment": "Test",
      "type": "Payment",
      "date": "2024-07-31 16:59:20"
    }
  ]
}
```

Cuatro detalles que se pueden equivocar por separado, y el adaptador se equivoca
en los cuatro:

1. **La envoltura se llama `response`, y es un ARRAY.** No `data`, no `result`,
   no `transaction`.
2. **`response` también es el nombre de un campo DENTRO** de cada elemento (el
   texto del resultado, `"Transacción aprobada"`). El mismo nombre en dos
   niveles.
3. **`type` también aparece en dos niveles** con significados distintos:
   `"200"` arriba (¿fue bien la consulta?) y `"Payment"` dentro (qué clase de
   transacción es).
4. **Los importes son texto (`"5.00"`) y las comisiones son número** (`0.18`).
   En la misma respuesta, las dos cosas.

El estado de la transacción es **`code`** dentro del elemento: `"1"` =
`"Transacción aprobada"`.

### La comisión: cuidado, son SEIS deducciones

El adaptador suma `commission + iva_commission`. Con los números de su propio
ejemplo eso son **$0.20**… y lo que Tilopay se quedó fueron **$0.96**:

```
5.00 − 0.18 − 0.02 − 0.27 − 0.09 − 0.35 − 0.05 = 4.04 = net_to_liquidate
     commission  iva_c  ret_iva  ret_rent  cost  cost_iva
```

O sea que `commission + iva_commission` recoge **el 21 %** de lo que de verdad
costó el cobro. Un asiento de liquidación con esa cifra descuadra cada venta, y
es precisamente el fallo que `04-pagos.md` §8 quiere evitar.

**Lo robusto es `amount − net_to_liquidate`**, porque es la resta que Tilopay
misma hace y no depende de que mañana añadan una séptima retención. 🔴 Y una
pregunta de verdad para soporte: **`retention_iva` y `retention_rent` son
retenciones fiscales costarricenses** — en Panamá seguramente no aplican, y es
posible que lleguen en cero. Sea lo que sea, `amount − net_to_liquidate` acierta
en los dos casos y la suma de seis campos no.

### `environment`: la única señal de si el cobro fue de verdad

`"environment": "Test"`. Lo retomo en el §12 porque es más grave de lo que
parece.

### La consulta también sirve para conciliar

Existe además `POST /api/v1/consultTransactions` (en el OpenAPI y en el índice
de [procesos operativos](https://tilopay.com/en/developers/api/procesos-operativos)),
y ese índice aclara algo útil:

> These operations are cross-cutting: **they work for any of the four integration
> paths, no matter how the charge was originated.**

Eso es lo que hace legítimo usar `consult` **y** `processModification` (§15)
desde la página de pago alojada.

---

## 10 · Montos, moneda y formato

De [API · Response conventions](https://tilopay.com/en/developers/api/convenciones)
(`last_verified: 2026-10-20`):

> **Warning:** Amounts, discounts and totals are **serialized as strings**:
> `"discount": "40.00"`, `"amount": "0.00"`… Any typed deserialization that
> declares those fields as numbers fails. Declare them as strings and convert
> them yourself, **with your language's decimal type, not with floating point**.

Esto respalda `sistema/src/pagos/importes.ts` tal como está: centavos enteros
adentro, texto con dos decimales afuera.

Y una segunda convención que hay que tolerar:

> In acquiring API responses, **`status` and `type` may be numbers or strings**…
> Accept both types when reading these indicators.

| Pregunta | Respuesta |
|---|---|
| Formato del importe | Texto. Su ejemplo: `"1.00"`. 🔴 **No hay una regla formal escrita** (ni separador de miles, ni número de decimales obligatorio) |
| Moneda | ISO; `USD` entre las de ejemplo. Panamá cobra en USD, y `04-pagos.md` §1.5 ya fija «moneda USD, sin conversión» |
| Mínimo por cobro | 🔴 **No documentado.** Yappy sí publica `0.01`; Tilopay no dice nada |
| Máximo | 🔴 No documentado |
| Decimales de la comisión | Número con dos decimales en el ejemplo (`0.18`) |

El `deTextoDeDinero` del repositorio rechaza `"12,50"` por ambiguo y convierte
números pasando por su texto. Las dos decisiones siguen siendo correctas y ahora
se sabe que la segunda hace falta de verdad: **las comisiones llegan como
número**.

---

## 11 · Idempotencia: no hay, y el `orderNumber` se gasta

De [Safe retries and orderNumber](https://tilopay.com/en/developers/reintentos-seguros)
(`last_verified: 2026-10-20`). Es la página que más diseño cambia y no la cita
ningún archivo del repositorio.

> **Warning:** The Tilopay acquiring API **is not idempotent**. There is no
> idempotency key and no retry that returns the original transaction. If you come
> from other processors, this is the assumption to dismantle before writing code.

- **`orderNumber` es único por comercio para siempre.** *«It does not reset
  daily, monthly or seasonally.»*
- Si se repite, **la transacción nueva se rechaza** con `"Transacción
  duplicada"`. *«It does not return the original transaction: it returns a
  rejection.»*
- En un timeout **no hay reintento seguro**: reintentar con el mismo número da
  rechazo por duplicado aunque el primero sí pasara; con un número nuevo se
  arriesga un **doble cargo**.

Lo que sí se hace:

1. `POST /api/v1/consult` con el `orderNumber` original.
2. Si la transacción existe, se usa su resultado. **No se reintenta.**
3. Si no existe, se puede reintentar — *«and you can reuse the same
   `orderNumber`, because it was not consumed»*.

> **Design consequences.** Generate the `orderNumber` in your system **before**
> calling the payment and persist it… Never derive the `orderNumber` from
> something that can repeat… A *«Transacción duplicada»* does not mean the charge
> failed: it means that `orderNumber` was already used. **Query before showing the
> customer an error.**

**Cómo encaja con lo que ya hay.** Bien, en parte: `iniciarCobro` ya escribe
`pagos.intento_ref` (UNIQUE) **antes** de llamar a la pasarela, que es
exactamente lo que piden. Lo que no encaja es el final feliz: `CobroCreado` tiene
un caso `tipo: "ya_estaba"` pensado para el `E007` de Yappy («el pedido ya estaba
registrado», que no es un fallo). **En Tilopay un `orderNumber` repetido es un
rechazo, no un «ya estaba»**, y hay que consultar antes de decirle nada a la
clienta. Y hace falta un estado más que hoy no existe: **«esa orden no existe en
Tilopay»**, que es distinto de «pendiente» y es el único que autoriza reintentar.

---

## 12 · Entornos: un solo host, y el modo no lo manda nuestro panel

De [Environments: testing and production](https://tilopay.com/en/developers/entornos)
(`last_verified: 2026-10-21`).

> **Warning:** **There is no sandbox host.** Testing and production use the same
> host: `app.tilopay.com`. **The URL does not tell you which mode you are in.**

> The mode is switched **from the account in the Tilopay portal**, not from the
> integration. **There is no parameter, header or alternate URL that changes it
> from code.**
>
> **Credentials are the same in both modes.** What changes is your account's
> active mode: turn Test mode on or off from the Tilopay dashboard.

Y el aviso que hay que leer dos veces:

> **The real risk.** Because the host is the same, an integrator can believe they
> are testing while actually being in production, **taking real money**. Verify
> that `environment` is `"TEST"` before assuming you are testing; make an
> unexpected `"PROD"` fail loudly in development.

### Esto es `checkout_activo` otra vez

El adaptador dice, en el comentario de `HOST`: *«el `modo` viaja hasta aquí,
porque las CREDENCIALES sí son distintas por modo»*. **Para Tilopay eso es
falso**, según su propia página. Y la consecuencia no es un comentario mal
escrito, son dos cosas de verdad:

1. **La pantalla de Pasarelas miente.** Poner Tilopay en «Modo de prueba» en
   nuestro panel no hace que Tilopay cobre de prueba: lo único que hace es elegir
   qué fila del baúl se lee. El modo real vive en `admin.tilopay.com`. Un ajuste
   que parece hacer algo y no lo hace es exactamente la trampa §13 de
   `docs/TRAMPAS.md`, y ya mordió con `checkout_activo`.
2. **Un cobro de prueba puede entrar como pago bueno.** Si la cuenta está en Test
   y nosotros tenemos credenciales en la fila `real`, `consult` devolverá
   `code: "1"` —aprobada— por una tarjeta de prueba, y el sistema marcaría el
   pedido pagado **sin que haya entrado un dólar**. Es el fallo más caro de todo
   este documento y la defensa está a la vista: **`consult` devuelve
   `environment`**.

**Lo que hay que hacer** (y es la salida honesta que el repositorio ya usó para
`checkout_activo`: que el dato diga la verdad en vez de poner un cartel que
alguien tenga que acordarse de borrar):

- Leer `environment` en la consulta y **negarse a aprobar** un pago cuyo
  `environment` no case con el modo en que está nuestra pasarela. Un `"Test"` en
  modo `real` no es un pago: es un ensayo, y tiene que fallar en voz alta.
- Que la pantalla de Pasarelas **diga** que el modo de Tilopay no lo decide
  ella, con la misma honestidad con que hoy dice «Encendido, pero todavía sin
  efecto».

El baúl por modos **no se tira**: sigue sirviendo, porque una cuenta de
desarrollo (§4) sí tiene credenciales propias y distintas. Lo que cambia es que
`modo` para Tilopay es «qué credenciales uso», no «cómo cobra Tilopay».

---

## 13 · Tarjetas de prueba

De [Test cards](https://tilopay.com/en/developers/tarjetas-de-prueba)
(`last_verified: 2026-10-21`). Son **27**, y funcionan *«only when the account is
in testing mode»*.

| Campo | Qué se pone |
|---|---|
| Vencimiento | Cualquier fecha futura |
| CVV | Cualquier valor |
| Código de la pantalla 3DS | **`3ds2`** |

> **Warning:** On the 3DS challenge screen the code to enter is `3ds2`. There is
> no other code and nothing is sent over SMS in testing.

La marca sale del prefijo: `4` Visa, `51`–`55` Mastercard, `34` American
Express. Una muestra de cada final que hace falta para probar (la lista completa
está en su página):

| Número | Marca | Resultado | 3DS |
|---|---|---|---|
| `4111111111111111` | Visa | Aprobada | sin fricción |
| `5100270000000072` | Mastercard | Aprobada | sin fricción |
| `341111000000009` | American Express | Aprobada | sin fricción |
| `4012000000020071` | Visa | Aprobada | **con reto 3DS** |
| `4112613451591116` | Visa | **Fondos insuficientes** | con reto 3DS |
| `4523080346468525` | Visa | **CVV incorrecto** | sin fricción |
| `4549179990476733` | Visa | **Tarjeta restringida** | sin fricción |
| `4012000000020121` | Visa | **Rechazada** | sin fricción |
| `5100270000000098` | Mastercard | Rechazada | con reto 3DS |

Y un dato que ahorra una tarde de desconcierto: *«The expected result is always
the same: **the card determines the response, not the amount**.»*

---

## 14 · Catálogo de errores: no hay catálogo

De [How to read an error response](https://tilopay.com/en/developers/api/procesos-operativos/errors)
(`last_verified: 2026-10-22`). El título de su propia sección lo dice:

> **An HTTP 200 does not mean success.**
>
> **Warning:** There is **no defined standard** for when the API responds HTTP 4xx
> and when it responds HTTP 200 with the error in the body. Both forms coexist,
> and there are **five different error envelopes** depending on the endpoint.
>
> Practical consequence: your error handling must **always look at the body**, not
> only the status code, and tolerate more than one body shape.

### Las cinco envolturas

| Envoltura | Endpoints |
|---|---|
| `{"error": "Unauthorized"}` | `login`, `loginSdk` |
| `{"type", "message"}` | **`processPayment`**, `processModification` |
| `{"type", "result"}` | `processRecurrentPayment`, `processTokenize` |
| `{"code", "description", "error"}` | servidor a servidor |
| `{"code", "description"}` | rechazo del emisor |

### Y la lista de códigos que se esperaba, no existe

🔴 **Tilopay no publica un catálogo de códigos.** Lo que dice de `code` y
`description` es que son *«The issuer decline code»* y *«The decline text»*, sin
enumerar ni uno. Y da la instrucción contraria a la que uno escribiría:

> - Treat `code` and `description` **as data to log and display, not as an
>   enumeration to branch on**.
> - Do not write `if (status === 200) success`. Check the body.
> - **Store the raw response of every decline:** it is what lets you reconstruct
>   your merchant's decline pattern.

Lo único enumerado en toda la documentación: **`code = "1"` es aprobada** y
cualquier otro valor es rechazo; `type = "100"` es «la operación se procesó»;
`type = "200"` es «la consulta salió bien»; `type` 300/400/402/403 son errores.
Y para `processModification`, **`ReasonCode = "1101"` es aprobada** (§15).

Esto tiene una consecuencia directa en el código: `EstadoTilopay` solo puede
tener tres valores salidos de `code === "1"` o no, **y no se puede distinguir
«rechazada por fondos» de «rechazada por CVV» con una tabla nuestra**. El texto
se guarda y se muestra; no se ramifica sobre él. Que es, casualmente, lo que
`estadoDeCodigo` ya hace.

---

## 15 · Reembolsos y contracargos

De [API · processModification](https://tilopay.com/en/developers/api/procesos-operativos/process-modification)
(`last_verified: 2026-10-22`) y del OpenAPI, donde la operación se resume como
*«Capture, refund or reverse a transaction»*.

**Sí hay reembolso por API, y el adaptador dice que no.**

```http
POST /api/v1/processModification
Authorization: bearer <token>
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `orderNumber` | sí | *«Number of the order sent in the original charge»* |
| `type` | sí | **`1` = captura, `2` = reembolso, `3` = reversión** |
| `amount` | sí | Importe a modificar |
| `key` | sí | La llave de integración |

**La respuesta tiene una trampa que hay que escribir antes de programarla:**

> `type: "100"` means the **modification was processed**; its outcome is in
> `ReasonCode` and `ReasonCodeDescription`. **`1101` = approved.**

```json
{"type":"100","transactionId":954183,"ReasonCode":"1101","ReasonCodeDescription":"Transaccion aprobada","OrderHash":"<order_hash>"}
```

Y un **rechazo también llega con `type: "100"`**:

```json
{"type":"100","transactionId":954183,"ReasonCode":"3","ReasonCodeDescription":"Invalid Retrieval reference number","OrderHash":"<order_hash>"}
```

O sea: `type: "100"` significa «te contesté», no «te devolví el dinero». Quien
lea `type` y se quede ahí dará por bueno un reembolso rechazado. Lo que decide
es **`ReasonCode === "1101"`**.

Que esto valga para la página de pago alojada no es una deducción: el índice de
procesos operativos dice que estas operaciones *«work for any of the four
integration paths, no matter how the charge was originated»*.

**`type: "1"` (captura)** abre además una puerta que hoy no se usa: cobrar con
`capture: "0"` (solo autorizar) y capturar después. No hace falta para Baby
Caleb —se cobra el total— pero conviene saber que existe antes de que alguien la
pida.

### Contracargos

🔴 **No hay nada documentado.** Ni endpoint, ni webhook, ni aviso. `04-pagos.md`
§7 ya lo da por hecho («Contracargo de tarjeta (Tilopay)… a mano para Tilopay»),
y la documentación no lo contradice ni lo confirma: simplemente no habla del
tema. **Pregunta para soporte.** Hasta entonces, el contracargo se entera por el
banco o por el panel de Tilopay y se registra a mano con
`registrar_contracargo`, que ya existe.

---

## 16 · Cuotas: no están en la documentación de desarrolladores

`04-pagos.md` §2 promete «Tarjeta de crédito o débito, **cuotas BAC**» por
Tilopay, y es lo que Baby Caleb quiere ofrecer.

🔴 **La documentación para desarrolladores no menciona las cuotas en ningún
sitio.** Lo comprobé de dos maneras: buscando `installment`, `cuota`, `tasa
cero`, `meses` y `months` en las páginas descargadas y en el OpenAPI 3.1
completo. El único resultado es la **frecuencia de facturación de los planes de
suscripción** (`1 = daily, 2 = weekly, 3 = monthly…`), que es otra cosa: una
suscripción recurrente, no una compra diferida a cuotas del banco.

Lo que sí está, y **no es documentación técnica**:

- Su página de tarifas lista **«Tasa Cero BAC Credomatic»** y **«Minicuotas BAC
  Credomatic»** como métodos con tarifa propia
  (<https://tilopay.com/en/tarifas>), con varios tramos de porcentaje — lo que
  implica varios plazos.
- Su página de métodos de pago (<https://tilopay.com/metodos-de-pago>) se arma en
  el navegador y no se pudo leer como texto.

**Conclusión honesta: no sé cómo se piden las cuotas por API, y no lo voy a
adivinar.** Las tres preguntas concretas para Tilopay:

1. ¿Se activan **por comercio** (y entonces la clienta las elige en la página de
   pago sin que nosotros mandemos nada), o hay que mandar un parámetro en
   `processPayment` que la documentación no lista?
2. ¿**Tasa Cero y Minicuotas están disponibles en Panamá**, o solo en Costa
   Rica? (BAC opera en los dos, pero la tarifa y el reglamento son por país.)
3. ¿Qué bancos, además de BAC, y qué plazos?

Mientras eso no esté por escrito, **el cobro a cuotas no se programa**. Y si se
activa por comercio sin parámetro, la buena noticia es que no hay nada que
programar: aparece solo en la página alojada.

---

## 17 · Comisiones: PENDIENTE, y no es pereza

La regla del repositorio es «ninguna cifra a ojo», y aquí hay tres cifras
distintas en circulación:

| Fuente | Qué dice | Cuándo se vio |
|---|---|---|
| Formulario de afiliación de Tilopay (Panamá) | Tarjetas **3.75 % + $0.50 + ITBMS**; Yappy por Tilopay **1 % + ITBMS** | 2026-11-11, citado en `04-pagos.md` §4.2 |
| Página pública de tarifas | **4.25 % + un fijo por transacción** para Visa/Mastercard/Amex | 2026-11-18 (hoy) |
| Guías de terceros | varias | — |

La página de tarifas tiene un selector de país que incluye Panamá
(`<option value="pa">`), **pero el cuadro de cifras se arma en el navegador**: lo
que se lee en el HTML servido es el país por omisión, y que ese sea Costa Rica lo
delata la presencia de **SINPE Móvil**, que es costarricense. **No puedo
atribuir el 4.25 % a Panamá** y no lo voy a hacer.

Y su propia letra pequeña, literal, cierra la discusión:

> \* The final price depends on Tilopay and may be adjusted according to the
> **integration model, financial institutions, and local regulations of each
> country**. Consult an advisor for the rates applicable to your type of business.

**Decisión: `ajustes.comisiones` se queda en `PENDIENTE` para tilopay**, como ya
dice `04-pagos.md` §4.2, hasta que llegue el contrato firmado.

**Y lo importante: para los libros no hace falta.** `consult` reporta la comisión
**de esa transacción** (§9), y eso es lo que manda en el asiento de liquidación.
La tarifa configurada sirve para estimar antes de cobrar; para cuadrar después,
manda lo que Tilopay reportó. Esa distinción ya está escrita en `04-pagos.md` §8
y es la que vuelve el `PENDIENTE` soportable: **podemos cobrar y cuadrar sin
saber la tarifa**.

🔴 Lo que no se sabe y hace falta preguntar: **la tasa del ITBMS que aplican** y
si el fijo por transacción lleva ITBMS aparte.

---

## 18 · El hueco: `sistema/src/pagos/tilopay.ts`, renglón por renglón

El adaptador tiene **33 pruebas en verde** y, con la documentación delante, no
puede cobrar. Las dos cosas son verdad a la vez, y el motivo es el del §6 de
`docs/TRAMPAS.md` aplicado a los datos de prueba: **los fixtures están
inventados**. La prueba *«mira dentro de la respuesta si viene envuelta»* recorre
`data`, `result` y `transaction` — tres nombres que no existen en Tilopay — y
pasa, porque prueba el código contra la suposición del código.

Es una variante que merece nombre propio: *una prueba cuyo dato de entrada se
adivinó no vigila la pasarela, vigila la adivinanza*. El repositorio ya tenía la
regla para el código (*«no se escribe código con nombres adivinados»*); le
faltaba para los fixtures.

### Lo que está bien

| | Por qué |
|---|---|
| `HOST` único, sin sandbox aparte | Confirmado (§12) |
| Un login por cobro, sin caché en módulo | Confirmado seguro: *«no limit on concurrent tokens»* (§3) |
| No usar la vía servidor a servidor | Correcto: es la única con alcance PCI (§2) |
| «La verdad es la consulta» | Correcto, y ahora respaldado por su propia documentación (§7) |
| Las tres credenciales y de dónde salen | Confirmado letra por letra (§3) |
| `key` va además del token | Confirmado: obligatoria en `processPayment` y en `consult` |
| `OrderHash` no verificable | Confirmado en dos páginas (§8) |
| Importes como texto de dos decimales | Confirmado (§10) |
| `deTextoDeDinero` rechaza `"12,50"` y acepta números | Las comisiones llegan como número: hacía falta (§10) |
| `estadoDeCodigo` tolera número o texto | Confirmado: *«`status` and `type` may be numbers or strings»* |
| No meter el cuerpo del error en el mensaje | Buena práctica propia; nada lo contradice |
| `comisionCents = null` si no se reporta | Correcto: «cero no es no sé» (TRAMPAS §7) |

### Lo que está mal

| # | Dónde | Qué dice el código | Qué dice la documentación |
|---|---|---|---|
| 1 | cabecera, línea 16 | *«Tilopay no tiene webhook en esta API»* | *«processPayment also has a webhook»* (§7) |
| 2 | `createPayment`, cuerpo | Manda **6** campos | **18 obligatorios** (§5) |
| 3 | `createPayment` | `capture: 1` (número) | Declarado `type: string`; su ejemplo `"1"` |
| 4 | `createPayment` | `redirect: orden.urlAviso` | `redirect` es **a dónde va la clienta**, no la dirección del aviso. Hoy aterrizaría en el endpoint del aviso, que contesta `"OK"` en texto plano (§6) |
| 5 | `createPayment` | Busca `url`, `urlPayment`, `payment_url`, `processUrl` | Solo existe **`url`**. Los otros tres son nombres adivinados |
| 6 | `createPayment` | No comprueba `type` | **`type: "100"`** es lo que dice que la URL se generó (§5) |
| 7 | `createPayment`, error | Lee el código de `code` / `status` | Viene en **`type`**. Hoy `codigo_tilopay` sale siempre `"sin_codigo"`: la bitácora pierde el único dato que quería |
| 8 | `consultarDetalle` | Envoltura en `data` / `result` / `transaction` | Es **`response`, y es un array** (§9). **Todo cobro saldría «pendiente» con monto `null`, para siempre** |
| 9 | `consultarDetalle` | `if (!r.ok …)` y nada más | *«An HTTP 200 does not mean success»*: hay que mirar **`type: "200"`** en el cuerpo (§14) |
| 10 | `consultarDetalle` | `comisión = commission + iva_commission` | Son **seis** deducciones; eso recoge el 21 % del costo real. Lo robusto es `amount − net_to_liquidate` (§9) |
| 11 | `consultarDetalle` | Ignora `environment` | Es **la única señal** de si el cobro fue de prueba. Sin ella, un ensayo entra como pago bueno (§12) |
| 12 | `HOST`, comentario | *«las CREDENCIALES sí son distintas por modo»* | *«Credentials are the same in both modes»* (§12) |
| 13 | `refundPayment` | *«Tilopay no devuelve dinero por esta API»* | **`processModification` con `type: "2"`** (§15) |
| 14 | `verifyWebhook` | Recibe el resultado de la consulta | Ahora que el webhook existe, el nombre miente y falta la pieza de verdad: recibir el POST, contestar 200 al instante y disparar la consulta — **un solo intento, sin reintento** (§7) |
| 15 | todo el archivo | — | **Nada llama a `tilopay()`.** `cobrarCarrito` y `recibirAvisoDeYappy` traen `yappy` escrito a mano; no hay ruta, ni entrypoint, ni herramienta MCP. Es `docs/TRAMPAS.md` §12, que ya mordió tres veces |
| 16 | `HORAS_TOKEN`, `FINALES` | Exportados | **No los usa nadie**, ni sus propias pruebas. `leerVuelta`, solo las pruebas |
| 17 | `proveedor.ts`, línea 82 | *«Tilopay acepta la larga»* (no implementa `referenciaDeOrden`) | 🔴 Su documentación dice *«it can be alphanumeric»* y **no publica un largo máximo**. Que acepte 35 caracteres con guiones es una suposición, no un dato |
| 18 | — | No hay nada sobre duplicados | `orderNumber` **se gasta para siempre**; repetirlo da rechazo, no «ya estaba». En timeout hay que consultar antes de reintentar (§11). Falta el estado **«no existe»** |

---

## 19 · Plan de implementación, por piezas

Cada pieza dice **qué toca** y **qué prueba la vigila**. La regla de `CLAUDE.md`
manda: *un ajuste nuevo, un campo nuevo o una capacidad nueva no están terminados
hasta que se pueden usar también por MCP*, en el mismo cambio. Y la de
`TRAMPAS.md` §12: *no está terminada hasta que algo la llama desde fuera*.

### Pieza 0 · Preguntar a Tilopay (bloquea a 3, 4 y 8)

No se programa nada aquí. Se abre **un caso en soporte** con la lista del §20 y
se anota la respuesta en este archivo. Lo urgente son tres: el **contrato del
payload del webhook**, qué poner en los `billTo*` que Panamá no usa, y **cómo se
piden las cuotas**.

- **Toca:** este documento.
- **Vigila:** nada automático. Es trabajo de preguntar.

### Pieza 1 · Arreglar la consulta (la que desbloquea todo)

`consultarDetalle` leyendo la respuesta real: envoltura `response` como array,
`type: "200"` en el cuerpo, `code` del elemento, `amount`, `auth`, `environment`,
y la comisión por `amount − net_to_liquidate`. Añadir el estado **`no_existe`**
(array vacío), separado de `pendiente`.

- **Toca:** `sistema/src/pagos/tilopay.ts`.
- **MCP:** nada nuevo todavía; lo consume la Pieza 7.
- **Vigila:** `tilopay.test.ts`, con los fixtures **copiados del ejemplo de su
  documentación**, no inventados — incluida la respuesta completa del §9 con sus
  seis deducciones, y una prueba de que `comisionCents` sale **96** y no 20. Y,
  por TRAMPAS §6, cada prueba validada rompiendo a propósito lo que vigila.

### Pieza 2 · El modo que dice la verdad

Negarse a aprobar un pago cuyo `environment` no case con el modo de la pasarela,
y que la pantalla de Pasarelas diga que el modo de Tilopay lo decide
`admin.tilopay.com`, no ella.

- **Toca:** `sistema/src/pagos/tilopay.ts`, `sistema/src/db/cobros-en-linea.ts`,
  `sistema/src/dominio/pasarelas.ts` (el texto del conector),
  `sistema/panel/src/` (pantalla Pasarelas).
- **MCP:** `ver_pasarelas` tiene que **devolver ese mismo aviso**, no solo
  pintarlo el panel; y `cambiar_modo_de_pasarela`, al cambiar Tilopay, tiene que
  avisar de que el modo de verdad está en su portal.
- **Vigila:** una prueba de que un `environment: "Test"` en modo `real` **no
  aprueba** (y que se pone roja si se quita la comprobación);
  `npm run panel:auditar` con la pantalla en **las dos** listas (TRAMPAS §4);
  `node scripts/sin-mcp.mjs`.

### Pieza 3 · Los datos de facturación del pedido

Los `billTo*` obligatorios. Decidir —con la respuesta de la Pieza 0— qué se le
pide a la clienta y qué sale del pedido. El correo hace falta de todas formas.

- **Toca:** `sistema/src/db/pedidos.ts` (campos), migración D1,
  `sistema/src/pagos/cobrar-carrito.ts`, `src/carrito/PantallaDePago.tsx`,
  `sistema/src/contrato/esquemas.ts`.
- **MCP:** `crear_pedido` y `corregir_ficha_de_clienta` tienen que aceptar y
  devolver los campos nuevos, o un pedido creado por MCP no se podrá cobrar con
  tarjeta — media capacidad, que es la trampa §13.
- **Vigila:** una prueba que crea un pedido **por MCP** y lo cobra por Tilopay
  sin tocar la web; el auditor del panel para la pantalla nueva.

### Pieza 4 · `createPayment` de verdad

Los 18 campos, `capture: "1"` como texto, `type: "100"` comprobado, solo el
nombre `url`, el código de error leído de `type`, `platform` con un valor
nuestro, `hashVersion` 🔴 (hasta saber en qué se diferencian V1 y V2), y
**`redirect` y webhook como dos URLs distintas** — lo que exige partir
`OrdenDeCobro.urlAviso` en `urlRetorno` y `urlAviso`.

- **Toca:** `sistema/src/pagos/tilopay.ts`, `sistema/src/pagos/proveedor.ts`
  (el tipo), `sistema/src/pagos/yappy.ts` **solo** para seguir compilando con el
  campo renombrado — y eso con cuidado, que Yappy está en producción.
- **MCP:** nada nuevo; lo consume la Pieza 6.
- **Vigila:** `tilopay.test.ts` comprobando que el cuerpo lleva **los
  dieciocho** (contados contra la lista `required` del OpenAPI, no contra una
  copia a mano); y `yappy.test.ts` entero en verde, sin cambiarle el
  comportamiento.

### Pieza 5 · El `orderNumber` y los duplicados

`referenciaDeOrden` para Tilopay 🔴 (si soporte confirma un largo máximo), y la
regla de los reintentos: ante `"Transacción duplicada"` o un timeout,
**consultar antes de decir nada**; reusar el mismo número solo si la consulta
dice que no existe.

- **Toca:** `sistema/src/pagos/tilopay.ts`, `sistema/src/db/cobros-en-linea.ts`.
- **MCP:** nada nuevo; lo consume la Pieza 7.
- **Vigila:** una prueba del timeout que comprueba que **se consulta antes de
  reintentar**, y otra de que un duplicado no se le enseña a la clienta como
  error.

### Pieza 6 · El cobro con tarjeta, de punta a punta

`cobrarCarrito` eligiendo pasarela en vez de traer `yappy` escrito a mano; la
ruta de retorno que recibe a la clienta, llama a `consult` y le enseña el
resultado; la ruta del webhook que contesta **200 al instante** y hace el trabajo
aparte.

- **Toca:** `sistema/src/pagos/cobrar-carrito.ts`, un
  `sistema/src/pagos/recibir-aviso-tilopay.ts` nuevo, `worker/pago.ts`,
  `worker/iniciar-pago.ts`, `worker/visibilidad.ts` (eximir la ruta nueva de la
  redirección, como ya se hizo con la de Yappy), `src/carrito/PantallaDePago.tsx`
  y `src/carrito/ResultadoDelPago.tsx`.
- **MCP:** `ver_checkout` tiene que contar la verdad sobre Tilopay igual que
  cuenta la de Yappy — **calculada de los datos**, no escrita a mano
  (TRAMPAS §13).
- **Vigila:** una prueba de punta a punta que **entra por donde entra la
  clienta** (TRAMPAS §12): carrito → cobro → vuelta → consulta → pedido pagado,
  con el `fetch` grabado de los ejemplos oficiales. Y otra de que el webhook
  contesta 200 incluso cuando el trabajo de abajo falla.

### Pieza 7 · El conciliador

Tilopay en el cron de cada 10 minutos de `04-pagos.md` §6: consultar los pagos en
`esperando_cliente`/`confirmando`, aplicar con las mismas reglas, y anotar cada
consulta en `eventos_pasarela`. Es la red que sostiene el único intento del
webhook.

- **Toca:** el consumidor de `pago.consultar`,
  `sistema/src/db/cobros-en-linea.ts`.
- **MCP:** una herramienta para **forzar la consulta de un pago** («pregúntale a
  Tilopay por el pedido BC-000123»), que es lo que la dueña va a querer cuando
  una clienta diga «yo pagué».
- **Vigila:** una prueba de que un pago cuyo webhook se perdió **termina
  aprobado** por el conciliador; y el guion de TRAMPAS §1 sobre cualquier fila de
  `controles` que se añada.

### Pieza 8 · El reembolso por API

`refundPayment` con `processModification` `type: "2"`, leyendo
**`ReasonCode === "1101"`** y no `type: "100"`.

- **Toca:** `sistema/src/pagos/tilopay.ts`, `sistema/src/db/pagos.ts`.
- **MCP:** `registrar_reembolso` hoy **anota** un reembolso hecho a mano. Hace
  falta poder **ejecutarlo**, y es acción sensible: la aprueba una persona
  (`04-pagos.md` §7).
- **Vigila:** una prueba de que un `ReasonCode` que no sea `1101` **no** marca el
  pago como reembolsado — con el fixture de rechazo del §15, que llega con
  `type: "100"`.

### Pieza 9 · Comisiones y liquidación

El asiento con la comisión **que reportó Tilopay**, no la estimada.
`ajustes.comisiones` sigue `PENDIENTE` y eso no bloquea nada (§17).

- **Toca:** `sistema/src/dominio/contabilidad.ts`,
  `sistema/src/db/contabilidad.ts`.
- **MCP:** `ver_contabilidad` y `ver_libro_diario` ya lo enseñan; hay que
  comprobar que el asiento nuevo sale por ahí y no solo en el panel.
- **Vigila:** una prueba de que el asiento cuadra con `net_to_liquidate` del
  ejemplo oficial (los $4.04 de $5.00), y la casilla del cierre.

### Lo que NO entra en este plan

- **Cuotas** (§16): no se programa sin la respuesta de la Pieza 0.
- **Contracargos** (§15): no hay API. Se registran a mano.
- **Vía servidor a servidor** (§2): alcance PCI. No.
- **Cambiar a la vía 3 (SDK)**: se evalúa aparte, con su propia decisión escrita.

---

## 20 · Lo que quedó 🔴, y a quién se le pregunta

Todo esto va a **un caso en <https://tilopay.com/en/soporte>**. Lo comercial
(tarifas, cuotas en Panamá) va además por el asesor de la afiliación, que se
envió el 2026-11-11.

**Bloquean código:**

1. **El contrato del payload del webhook de `processPayment`** — qué campos
   manda. Lo entregan al pedirlo. Sin esto no se escribe el receptor (§7).
2. **Los `billTo*` en Panamá** — qué poner en `billToZipPostCode` (Panamá no usa
   código postal como Costa Rica), en `billToState` (¿`PA-8`?) y si validan el
   contenido. Qué pasa con un valor de relleno (§5).
3. **Cuotas**: ¿se activan por comercio o llevan parámetro? ¿Tasa Cero y
   Minicuotas **existen en Panamá**? ¿Qué bancos y qué plazos? (§16).
4. **El largo máximo de `orderNumber`** — no lo publican; de ahí depende si
   Tilopay necesita su `referenciaDeOrden` (§18, fila 17).
5. **`hashVersion` V1 vs V2** — en qué se diferencian, y si importa elegir sin
   tener el algoritmo (§8).

**No bloquean, pero hay que saberlos:**

6. **El algoritmo del `OrderHash`** — lo entregan por caso. Con él, el retorno y
   el webhook pasarían a ser verificables y dejaríamos de depender solo de la
   consulta (§8).
7. **Las tarifas de Panamá por escrito**, **la tasa del ITBMS** que aplican y si
   el fijo lo lleva aparte. Hasta entonces, `PENDIENTE` (§17).
8. **Contracargos**: ¿hay aviso, webhook o endpoint? (§15).
9. **Mínimo y máximo por transacción** — no documentados (§10).
10. **Regla de formato del importe** — su ejemplo es `"1.00"` pero no hay regla
    escrita (§10).
11. **`retention_iva` y `retention_rent` en Panamá** — ¿aplican o llegan en
    cero? (§9. Da igual para el cálculo si se usa `amount − net_to_liquidate`,
    pero cambia cómo se explica el asiento.)
12. **`crd` y `form_update`**, que salen en su ejemplo del retorno y no están en
    la tabla (§6).
13. **Si `consult` distingue «no existe» de «pendiente»** — de eso depende el
    estado `no_existe` de la Pieza 1 y la regla de reintento del §11.

---

## 21 · Las páginas que se leyeron

Todas de `https://tilopay.com`, con su `last_verified` tal como lo declara cada
una. Cada página sirve su Markdown crudo añadiendo `.md` a la ruta, que es como
se leyeron (el HTML esconde los bloques de código en un resaltador).

| Página | Ruta | `last_verified` |
|---|---|---|
| Índice de desarrolladores | `/en/developers` | 2026-08-29 |
| Cuatro vías de integración | `/en/developers/api/caminos-de-integracion` | 2026-10-20 |
| Autenticación | `/en/developers/api/autenticacion` | 2026-10-20 |
| Token de API | `/en/developers/api/autenticacion/token-api` | 2026-10-20 |
| `processPayment` | `/en/developers/api/hosted-payment-page/process-payment` | 2026-10-20 |
| Página de pago alojada | `/en/developers/hosted-payment-page` | 2026-08-28 |
| `consult` | `/en/developers/api/procesos-operativos/consult` | 2026-10-20 |
| `processModification` | `/en/developers/api/procesos-operativos/process-modification` | 2026-10-22 |
| Procesos operativos | `/en/developers/api/procesos-operativos` | 2026-08-29 |
| **Webhooks** | `/en/developers/api/webhooks` | 2026-10-20 |
| Convenciones de respuesta | `/en/developers/api/convenciones` | 2026-10-20 |
| Cómo leer un error | `/en/developers/api/procesos-operativos/errors` | 2026-10-22 |
| Reintentos seguros | `/en/developers/reintentos-seguros` | 2026-10-20 |
| Entornos | `/en/developers/entornos` | 2026-10-21 |
| Tarjetas de prueba | `/en/developers/tarjetas-de-prueba` | 2026-10-21 |
| Registro de desarrollador | `/en/developers/registro` | 2026-08-29 |
| Servidor a servidor | `/en/developers/server-to-server` | 2026-10-20 |
| SDK de JavaScript | `/en/developers/sdk` | 2026-10-22 |
| Crear enlace de pago | `/en/developers/api/links-de-pago/create-link-payment` | 2026-08-29 |
| Tarifas (comercial, no técnica) | `/en/tarifas` | — |
| **OpenAPI 3.1** | `/developers/openapi.json` | `info.version: v1` |

**Nada de este documento se llamó con credenciales de verdad.** No se hizo ni un
cobro, ni una consulta, ni se tocó una pasarela del panel: todo sale de leer su
documentación y su OpenAPI.
