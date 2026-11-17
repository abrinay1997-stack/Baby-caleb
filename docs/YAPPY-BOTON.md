# Yappy · Botón de Pago (V2) — lo que dice la documentación oficial

**Leído el 2026-11-17** de
<https://www.yappy.com.pa/comercial/desarrolladores/boton-de-pago-yappy-nueva-integracion/>.

Este archivo existe porque `docs/plan/04-pagos.md` §4.1 lo exigía con todas las
letras: *«la tarea F4.6.1 es leer la documentación oficial y escribir
`docs/YAPPY-BOTON.md` antes de programar. No se escribe código con nombres
adivinados.»* Sesiones anteriores no pudieron abrir `yappy.com.pa` —la red del
entorno lo bloqueaba— y por eso la pieza llevaba meses parada. Ya se puede.

Todo lo de aquí está COPIADO de esa página, no deducido. Lo que no está, se dice
que no está.

> **Soporte de Yappy para esto:** botondepagoyappy@bgeneral.com

---

## 1 · Yappy tiene DOS integraciones, y no son la misma

Es la confusión que ya costó una vuelta entera, así que va primero.

| | **Botón de Pago** | **Integración Core** |
|---|---|---|
| Para qué | **cobrar** en la web | **leer** lo que ya pasó |
| Dónde se generan sus credenciales | Yappy Comercial › **Productos › Botón de Pago** | Yappy Comercial › **Integraciones** |
| Qué entrega | ID de comercio + clave secreta (**2**) | Código de semilla + clave secreta + API Key (**3**) |
| Sirve para cobrar | **sí** | **no** — no tiene ni un endpoint que cobre |

La Core solo expone sesión, historial de movimientos y consulta de métodos de
cobro. Su manual (`Yappy APIs - Manual de Integración v1.0.0`) está en poder del
dueño. **Sirve para otra cosa que sí hace falta:** confirmar solo los pagos que
entran, en vez de que alguien mire el comprobante a mano. Son dos piezas
distintas y las dos valen; esta nota es solo para que nadie vuelva a poner las
credenciales de una donde van las de la otra.

---

## 2 · Generar las credenciales (el paso a paso oficial)

1. Entrar a Yappy Comercial **con un usuario administrador**. Con un usuario que
   no sea administrador la opción no aparece.
2. Ir a **Productos › Botón de Pago**.
3. **Crear botón de pago**.
4. Llenar los datos **del sitio web** donde va el botón y pulsar **Activar**.
   El botón queda en estado **Pendiente**: falta la clave.
5. **Generar clave secreta**. Ahí Yappy entrega las dos credenciales:
   - **ID de comercio**
   - **Clave secreta**
   Se copian y se pulsa **Listo**.
6. De vuelta en el menú del Botón de Pago quedan a la vista la **URL del sitio
   creado** y el **ID del comercio**.

**Dos avisos de la propia página:**

- **Regenerar las credenciales desactiva las anteriores.** Los valores nuevos no
  se propagan solos: hay que volver a pegarlos a mano donde estén configurados.
- El dominio que se declare en el paso 4 **es el que viaja en cada llamada**
  (`urlDomain` / `domain`) y el que entra en el hash de la notificación. No es
  decorativo: si no coincide, no cuadra.

---

## 3 · Los dos entornos

| | Producción | Pruebas |
|---|---|---|
| API | `https://apipagosbg.bgeneral.cloud` | `https://api-comecom-uat.yappycloud.com` |
| CDN del botón | `https://bt-cdn.yappy.cloud/v1/cdn/web-component-btn-yappy.js` | `https://bt-cdn-uat.yappycloud.com/v1/cdn/web-component-btn-yappy.js` |

Encaja con el diseño que ya tiene el sistema: `pasarela_credenciales` guarda un
juego por modo (`prueba` / `real`) y el modo es parte de la llave del baúl.

---

## 4 · El cobro son dos POST, y los dos van desde el SERVIDOR

La página lo subraya: *«se deben hacer los llamados de estas API's dentro de su
backend»*. La clave secreta no puede llegar al navegador.

### Paso 1 · Validar el comercio → token

```
POST {API}/payments/validate/merchant
Content-Type: application/json

{ "merchantId": "<ID de comercio>", "urlDomain": "<dominio del paso 4>" }
```

Respuesta: `status.code`, `status.description`, y dentro de `body`:
`body.epochTime` y **`body.token`** (token de sesión).

### Paso 2 · Crear la orden

```
POST {API}/payments/payment-wc
Authorization: <el token del paso 1>
Content-Type: application/json
```

| Campo | Qué es |
|---|---|
| `merchantId` | el ID de comercio |
| `orderId` | **alfanumérico, de 1 a 15 caracteres** |
| `domain` | el dominio configurado en el paso 4 |
| `paymentDate` | fecha en formato epoch |
| `aliasYappy` | teléfono panameño **registrado en el programa de pruebas** de Yappy App, sin prefijo |
| `ipnUrl` | la URL que recibirá la notificación de pago |
| `discount` | `"0.00"` · mínimo `"0.00"` |
| `taxes` | `"0.00"` · mínimo `"0.00"` |
| `subtotal` | `"0.00"` · mínimo `"0.00"` |
| `total` | `"0.00"` · **mínimo `"0.01"`** |

Respuesta, dentro de `body`: **`transactionId`**, **`token`** y
**`documentName`** — los tres se le pasan al botón del navegador.

Los importes van como **cadena con dos decimales**, no como número. El sistema
guarda centavos enteros, así que el adaptador tiene que formatear al mandar y
volver a centavos al recibir.

---

## 5 · El botón del navegador

Es un componente web que se carga del CDN. Dispara estos eventos:

| Evento / propiedad | Qué hace |
|---|---|
| `eventClick` | la clienta tocó el botón → aquí se llama a NUESTRO endpoint, que a su vez hace los dos POST |
| `eventPayment` | recibe `{ transactionId, token, documentName }` — lo que devolvió el paso 2 |
| `eventSuccess` | la transacción salió bien |
| `eventError` | la transacción falló |
| `isYappyOnline` | `true` si el canal de Yappy está disponible. Con `false` hay que decirle a la clienta POR QUÉ está deshabilitado el botón, en vez de dejarlo muerto |
| `isButtonLoading` | pone o quita el estado de «cargando» |

**Aviso de la página:** si la transacción está en curso y se refresca la página,
el contador del modal se cierra.

**Lo único que no pude copiar:** el fragmento HTML exacto de cómo se declara el
componente. En la página va dentro de un resaltador que carga por JavaScript y
no sale en el HTML servido. Hay que sacarlo del navegador (o pedirlo a
botondepagoyappy@bgeneral.com) antes de escribir el frontend. **No se inventa.**

---

## 6 · La notificación de pago (IPN) — y cómo se valida

Un endpoint **GET**, abierto, cuya URL se manda como `ipnUrl` al crear la orden.

Llega con: `orderId`, `hash`, `status`, `domain` y —en el ejemplo .NET—
`confirmationNumber`.

### Los estados

| | |
|---|---|
| `E` | **Ejecutado.** La clienta confirmó el pago y la compra se completó. |
| `R` | **Rechazado.** No confirmó dentro de los **cinco minutos** que dura el pedido. |
| `C` | **Cancelado.** Empezó y canceló en la app de Yappy o de Banco General. |
| `X` | **Expirado.** Nunca inició el pago y la solicitud del comercio venció. |

Solo `E` es un pago. Los otros tres son finales distintos y la clienta merece un
mensaje distinto en cada uno.

### El hash

Esto es lo que `docs/plan/04-pagos.md` daba por desconocido. Del ejemplo oficial
en Node.js de la propia página:

```js
const values = Buffer.from(CLAVE_SECRETA, "base64").toString("utf-8");
const secrete = values.split(".");
const signature = crypto
  .createHmac("sha256", secrete[0])
  .update(orderId + status + domain)
  .digest("hex");
const success = hash === signature;
```

En palabras, y los cuatro detalles que se pueden equivocar:

1. La clave secreta **viene en base64**: primero se decodifica a texto.
2. Ese texto **se parte por el punto** y se usa **solo el primer trozo**.
3. Se firma **`orderId + status + domain`** concatenado, sin separadores y **en
   ese orden**.
4. HMAC-SHA256, en **hexadecimal minúsculas** (el ejemplo .NET hace
   `.ToLower()` explícito).

El ejemplo de .NET hace exactamente lo mismo, lo que confirma la lectura.

**Al implementarlo:** la comparación tiene que ser en tiempo constante, no un
`===` — un `===` filtra, por lo que tarda, cuánto del hash acertó quien lo
intenta. El ejemplo oficial usa `===` porque es un ejemplo, no una referencia de
seguridad.

Y el IPN **no es la verdad por sí solo**: es un GET abierto que cualquiera puede
llamar. Lo que lo hace confiable es el hash. Sin verificar, cualquiera marca
pedidos como pagados escribiendo una URL.

---

## 7 · Catálogo de errores

| | |
|---|---|
| `E002`, `E006`, `E008`, `E012` | «Algo salió mal. Intenta nuevamente.» |
| `E005` | Este número no está registrado en Yappy. |
| `E007` | El pedido ya ha sido registrado. |
| `E009` | ID de la orden mayor a 15 dígitos. |
| `E010` | El valor de los montos no es el correcto. |
| `E011` | Error en los campos de URL. |
| `E100` | Bad Request. |

`E007` importa más de lo que parece: es lo que contesta si se reintenta una orden
ya creada. El adaptador tiene que tratarlo como «ya estaba», no como un fallo.

---

## 8 · Lo que sigue sin confirmarse

- **El fragmento HTML del componente** (§5).
- **La comisión.** `04-pagos.md` cita 1 % + ITBMS, mínimo $0.02, de una guía de
  terceros. No sale de esta página oficial. Hasta que lo confirme Yappy por
  escrito, el ajuste `comisiones` se queda en `PENDIENTE` para yappy — una cifra
  a ojo en una comisión descuadra la liquidación de cada venta.
- **Cómo se pide el acceso al programa de pruebas** y qué teléfono vale como
  `aliasYappy`.
- **Si hay devolución por API.** La interfaz del sistema tiene `refundPayment` y
  esta página no la menciona.
