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

---

# Segunda lectura — 2026-11-18

Un agente leyó la documentación entera desde el navegador, incluidos los bloques
de código que no salen en el HTML servido, y la comparó contra lo que hay
construido. De 33 puntos: **21 correctos, 1 señalado, 2 parciales y 9 sin
documentar**.

Lo que sigue corrige y completa lo de arriba.

## 9 · El fragmento del componente — RESUELTO

Era el hueco que dejaba el pago parado. El resaltador de la página (CodeMirror)
guarda el código original en un `<textarea>` oculto, y de ahí salió literal.

```html
<script type="module" src="https://bt-cdn.yappy.cloud/v1/cdn/web-component-btn-yappy.js"></script>

<btn-yappy theme="blue"></btn-yappy>
```

**LOS TRES VALORES NO VAN COMO ATRIBUTOS.** Esto es lo que no se habría
adivinado: se pasan llamando al método `eventPayment` del elemento, dentro del
manejador de `eventClick`, después de que NUESTRO backend creó la orden.

```js
const btnyappy = document.querySelector("btn-yappy");

btnyappy.addEventListener("eventClick", async () => {
  // Aquí se llama a NUESTRO endpoint, que hace los dos POST con la clave
  // secreta. La clave nunca baja al navegador.
  const r = await fetch("/api/pago/yappy/iniciar", { method: "POST" });
  const result = await r.json();
  btnyappy.eventPayment({
    transactionId: result.body.transactionId,
    documentName: result.body.documentName,
    token: result.body.token,
  });
});

btnyappy.addEventListener("eventSuccess", (e) => { /* e.detail = transactionId */ });
btnyappy.addEventListener("eventError",   (e) => { /* e.detail = EXPIRED | FAILED | DENIED | DUPLICATED_TRANSACTION | CANCELLED */ });
```

| Nombre | Cómo se usa | Qué acepta |
|---|---|---|
| `theme` | atributo HTML | `blue`, `darkBlue`, `orange`, `dark`, `sky`, `light` (por defecto `sky`) |
| `rounded` | atributo HTML | `"true"` para bordes redondeados |
| `isButtonLoading` | propiedad JS | `true`/`false`. **Se pone solo en «cargando» al hacer clic: hay que sacarlo a mano si nuestro backend falla**, o el botón se queda girando para siempre |
| `eventPayment` | método JS | `{ transactionId, token, documentName }` |
| `isYappyOnline` | evento | `false` = el canal de Yappy no está. **Hay que decirle a la clienta POR QUÉ el botón está deshabilitado**, no dejarlo muerto |

### La trampa del CDN

La tabla de entornos dice `bt-cdn.yappy.cloud`. **El ejemplo de Frontend usa
otro host**, `bt-cdn.yappycloud.com`, que **no respondió** desde el navegador.

Vale el de la tabla, que es el que ya está en `src/pagos/yappy.ts`. Quien copie
el ejemplo de la página se queda sin botón y sin un solo pago, y el síntoma no
dice que el problema sea el host.

### El frontend NO es la fuente de verdad

En el código del componente, `eventSuccess` se emite para los estados internos
`COMPLETED`, `C` y `EXECUTED`; `eventError` para los cinco de la tabla; y otros,
como `REJECTED`, **no disparan ninguno de los dos**. Ese `C` interno no es la
«C» de Cancelado del aviso.

O sea: el navegador puede decir «salió bien» y puede no decir nada. **Un pedido
se marca pagado solo por el aviso firmado**, que es lo que ya hace
`recibirAvisoDeYappy`.

## 10 · La comisión — YA NO ESTÁ PENDIENTE

Documentada en el Centro de Ayuda de Yappy Comercial, pregunta «¿Cuánto cuesta
cobrar por Yappy Comercial?»:

- **1 % + ITBMS** del monto de cada transacción.
- **Comisión mínima de $0.02** por transacción.
- Se cobra en un solo débito diario a la cuenta asociada. **La clienta no la
  paga.** El reporte sale de Banca en Línea → Reportes → filtrar por comisiones.

### Ojo al traducirlo a nuestro ajuste

`Comision` en `src/dominio/ajustes.ts` guarda `{ porcentaje_bp, fijo_cents,
lleva_itbms }`, y **`fijo_cents` es un cargo FIJO que se suma, no un MÍNIMO**.
Son dos cosas distintas y confundirlas descuadra cada venta.

Para Yappy lo correcto es:

```
porcentaje_bp: 100    // 1 %
fijo_cents:      0    // NO 2: los $0.02 son un piso, no un cargo
lleva_itbms:  true
```

El mínimo no se modela, y aquí no hace falta: el 1 % de cualquier caja de Baby
Caleb —de $20 a $55— va de $0.20 a $0.55, siempre por encima de los $0.02. El
piso solo mordería en una venta **por debajo de $2.00**, que hoy no existe. Si
algún día se vende algo así, hay que modelar el mínimo, no poner un fijo.

Lo que la página NO dice: la tasa del ITBMS, ni si el mínimo de $0.02 la
incluye.

## 11 · Lo que corrige de lo construido

**`confirmationNumber` no es un parámetro documentado del aviso.** Solo aparece
leído en el ejemplo de .NET, sin explicar qué es ni qué formato tiene.

Nuestro código ya lo trata bien —es opcional, se guarda como referencia
informativa y **no hace falta para aceptar un aviso**: se decide con `orderId`,
`status`, `domain` y `hash`— pero queda escrito aquí porque el riesgo es real:
si algún día alguien lo exigiera, un aviso sin él rechazaría un pago bueno; y si
se usara como prueba del pago, **no está firmado**, así que lo puede cambiar
cualquiera que tenga una URL de aviso válida.

## 12 · La firma, confirmada

Los **cuatro** ejemplos oficiales (Node, .NET, PHP y Python — no hay Java) hacen
los mismos cuatro pasos, y coinciden con lo implementado. Dos notas:

- **Solo el ejemplo de Python compara en tiempo constante** (`hmac.compare_digest`).
  Node usa `===`, .NET `==` y PHP `strcmp`. Nuestra implementación usa
  `igualesSinAtajo`, o sea el camino de Python.
- Los cuatro usan el `domain` **que llega en la URL del aviso**. Nosotros
  comprobamos ADEMÁS que sea el nuestro antes de firmar, que es lo que impide
  que una firma hecha para otro dominio cuadre consigo misma.

## 13 · Los códigos de error (para los mensajes a la clienta)

| Código | Lo que dice Yappy | Qué es de verdad |
|---|---|---|
| E002, E006, E008, E012 | «Algo salió mal. Intenta nuevamente.» | Genéricos, **no se pueden distinguir entre sí** |
| E005 | «Este número no está registrado en Yappy.» | Dato de la clienta |
| E007 | «El pedido ya ha sido registrado.» | `orderId` repetido |
| E009 | «ID de la orden mayor a 15 dígitos.» | Petición mal escrita |
| E010 | «El valor de los montos no es el correcto.» | Petición mal escrita |
| E011 | «Error en los campos de URL.» | Petición o configuración |
| E100 | «Bad Request.» | Petición mal escrita |

**Ningún código significa «el banco dijo que no».** Eso llega por el aviso (R, C
o X) o por `eventError` en pantalla. Faltan E001, E003 y E004 sin explicación, y
la página no dice en qué campo ni con qué código HTTP llegan.

## 14 · El entorno de pruebas: cómo se entra

1. Registrarse en el programa de pruebas de **Yappy App con una cuenta de
   Gmail** — preferiblemente la que ya está en el teléfono Android.
2. Escribir a **botondepagoyappy@bgeneral.com** con: nombre del comercio, correo
   usado en la app, número de celular panameño y **versión de Android**.
3. Yappy confirma por correo cuando manda las invitaciones.

Ese número, sin prefijo, es el `aliasYappy`.

**No está documentado el soporte para iPhone.** Si la dueña solo tiene iPhone,
hay que preguntarlo antes de contar con el ensayo.

## 15 · Lo que sigue sin documentar, y a quién se le pregunta

Vigencia del token del paso 1 · si `Authorization` lleva «Bearer» · si
`paymentDate` va en segundos o milisegundos · si `aliasYappy` es obligatorio en
producción · la regla de cuadre de los importes · reintentos del aviso, código
de respuesta esperado, duplicados, orden de los estados e IPs de origen ·
consulta del estado de una orden · devoluciones · límites de peticiones y
montos.

Dos correos: **botondepagoyappy@bgeneral.com** para dudas de la guía y
**yappy@bgeneral.com** para problemas de integración.

### La consulta de estado, que es el hueco que más duele

Hoy, si el aviso se pierde, no hay forma de preguntarle a Yappy qué pasó. La vía
más prometedora es **Integraciones Yappy** —la otra API, la que el dueño generó
primero— cuya página de producto dice que consulta el historial de
transacciones, da el detalle de un pago y verifica por qué método entró cada
uno. **Su documentación técnica está DENTRO de Yappy Comercial, tras iniciar
sesión**, así que no se pudo leer.

No está confirmado que permita buscar un pago del Botón de Pago por nuestro
`orderId`. Es hipótesis, y hay que leerla.

## 16 · La versión vieja ya no existe

El Botón de Pago legacy se descontinuó el 31-dic-2025 y dejó de procesar pagos
el 30-abr-2026. No se puede reactivar y no hay excepciones. Se reconoce porque
manda a la clienta a pagar fuera de la tienda, en `pagosbg.bgeneral.com`, sin
APIs. **Lo que hay construido aquí es la V2.**
