# El primer cobro de prueba de Yappy

Para Juan. Es el paso que decide si Yappy cobra de verdad, y **se hace en modo
de prueba, sin dinero** — la dueña ya tiene puestas las credenciales de los dos
modos.

Nada de esto se puede sustituir por «las pruebas pasan». Las 2539 pruebas del
sistema comprueban que NOSOTROS hacemos lo que la documentación de Yappy dice;
lo único que comprueba que Yappy esté de acuerdo es un cobro de verdad.

---

## Lo que ya está hecho

| | |
|---|---|
| Adaptador de Yappy | sí — los dos POST, los cuatro estados, el hash |
| Verificación de la firma | sí, en tiempo constante, con vectores calculados aparte |
| La ruta pública del aviso | sí: `https://babycaleb.com/api/pago/yappy` |
| Aplicar el cobro al pedido | sí, con el monto comparado y sin sumar dos veces |
| El asiento contable | sí: Yappy a la cuenta 1101 |
| Preguntar por un aviso | sí: `ver_avisos_de_pago` |
| **El carrito mandando a pagar** | **NO** — `LA_WEB_TIENE_CHECKOUT` sigue en `false` |
| **El botón de Yappy en la página** | **NO** — falta un dato, ver abajo |

---

## Lo que FALTA, y uno de los dos no lo podemos sacar nosotros

### 1 · El fragmento HTML del componente de Yappy

`docs/YAPPY-BOTON.md` §5 lo dice: en la página oficial ese fragmento va dentro
de un resaltador que carga por JavaScript, así que no sale en el HTML servido y
**no se pudo copiar**. Y no se inventa.

Dos formas de conseguirlo, y las dos son de Juan:

- Abrir la página del Botón de Pago en Chrome, con las herramientas de
  desarrollador, y copiar el fragmento ya renderizado.
- Pedírselo a **botondepagoyappy@bgeneral.com**.

Lo que hace falta es cómo se declara el componente (`<btn-yappy …>`) y qué
atributos lleva. Los eventos ya están documentados: `eventClick`,
`eventPayment`, `eventSuccess`, `eventError`, `isYappyOnline`,
`isButtonLoading`.

### 2 · Comprobar el dominio que la dueña declaró

**Esto es lo que más probablemente salga mal, y falla en silencio.**

El dominio que ella escribió al crear el botón viaja en cada llamada y **entra
en el hash de la notificación**. El sistema firma con `babycaleb.com`
(`DOMINIO_DEL_BOTON`, en `sistema/src/pagos/recibir-aviso.ts`). Si ella declaró
otra cosa —`www.babycaleb.com`, o con `https://` delante— las órdenes se crean
igual y **ningún aviso se puede verificar**: todos los pagos quedarían sin
aplicar, y el síntoma parecería un problema de Yappy.

Se mira en Yappy Comercial › Productos › Botón de Pago: ahí quedan a la vista
la URL del sitio y el ID del comercio.

Si no coincide, hay dos salidas: cambiarlo en Yappy, o cambiar
`DOMINIO_DEL_BOTON` en el código. **La primera es mejor** — el código debe
decir la verdad sobre el sitio, no acomodarse a un dato mal escrito.

---

## El ensayo, cuando esas dos cosas estén

1. **Poner Yappy en modo de prueba** desde el panel (Pasarelas › Yappy › «Pasar
   a modo de prueba»). Ella ya tiene las credenciales de prueba puestas: el
   panel dice «Credenciales de modo de prueba · están todas».
2. **Usar un teléfono dado de alta en el programa de pruebas de Yappy.** Con
   cualquier otro número la orden se crea y la solicitud no llega a ningún
   teléfono — y eso se lee como «no funciona» cuando en realidad es ese dato.
3. Hacer un pedido de prueba y pagarlo.
4. **Comprobar las cuatro cosas, en este orden:**
   - el pedido quedó pagado;
   - `ver_avisos_de_pago` con ese número dice que el aviso llegó y decía
     «ejecutado»;
   - el asiento está en la cuenta **1101**, por el monto exacto;
   - `hay_que_mirarlo` es `false`.
5. **Probar también un pago que NO se confirma**: dejar pasar los cinco minutos
   sin confirmar en la app. Tiene que quedar «rechazado» y el pedido sin pagar.
   Un sistema que solo se prueba con el caso bueno no está probado.

---

## Y solo entonces

Encender el checkout es un acto aparte, y en este orden:

1. `LA_WEB_TIENE_CHECKOUT` a `true` (hay una prueba que vigila que esa
   constante y el carrito digan lo mismo, en las dos direcciones).
2. Yappy a **modo real** desde el panel.
3. Un cobro real pequeño, y su reembolso desde Yappy Comercial.
4. Recién ahí, quitar el botón de «pedir por WhatsApp».

**El paso 4 va al final, no antes.** Quitar WhatsApp antes de que el cobro
funcione deja la tienda sin ninguna forma de pedir.

---

## Pendiente aparte: PayPal

Está encendida en modo real y **sin ninguna de sus tres credenciales**. El
sistema lo marca como incoherente. Hoy no cobra nadie porque el carrito termina
en WhatsApp, pero el día que se encienda el checkout ofrecería un botón que no
cobra. Hay que apagarla o completarla.
