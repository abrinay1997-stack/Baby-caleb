# Conseguir las credenciales del Botón de Pago de Yappy

Para la dueña. Son dos valores: **ID de comercio** y **Clave secreta**. Sin
ellos el sistema no puede cobrar por Yappy.

Los pasos salen de la página oficial de Yappy, transcrita en
`docs/YAPPY-BOTON.md` §2. Si Yappy cambia su panel, manda lo que se vea en
pantalla, no este archivo.

---

## Lo que hay que saber ANTES de empezar

Tres cosas, y la primera es la que hace que esto se tenga que hacer bien a la
primera.

### 1 · La clave secreta se ve UNA sola vez

Yappy la muestra en el momento de generarla y no la vuelve a mostrar. Y
—textual de su página— **regenerar las credenciales desactiva las anteriores**.
O sea que si se cierra esa ventana sin guardar la clave, el arreglo no es
«volver a mirarla»: es generar unas nuevas, y las viejas dejan de funcionar.

**Por eso el panel de Baby Caleb se abre PRIMERO**, en la pantalla de Pasarelas,
antes de tocar nada en Yappy. Cuando Yappy enseñe la clave, se pega de una vez.

### 2 · Hace falta un usuario administrador

Con un usuario que no sea administrador, la opción de crear el botón **no
aparece**. No es que esté escondida: no está.

### 3 · El dominio que se declare es el que cuenta

Yappy pide el sitio web donde va el botón, y ese dominio **viaja en cada cobro**
y entra en la firma con la que Yappy avisa del resultado. Si no coincide, los
pagos no cuadran.

El dominio de Baby Caleb es:

```
babycaleb.com
```

Sin `https://`, sin `www`, sin barra al final — salvo que el formulario de Yappy
pida otra cosa en pantalla.

---

## El paso a paso

**Paso 0.** Abrir el panel de Baby Caleb en una pestaña:
`https://panel.babycaleb.com` → **Pasarelas** → **Yappy · Botón de Pago**. Dejarla
ahí, abierta, sin cerrarla.

**Paso 1.** En otra pestaña, entrar a **Yappy Comercial** con el usuario
**administrador**.

**Paso 2.** Ir a **Productos › Botón de Pago**.

**Paso 3.** Pulsar **Crear botón de pago**.

**Paso 4.** Llenar los datos del sitio web (el dominio de arriba) y pulsar
**Activar**. El botón queda en estado **Pendiente**: eso es normal, falta la
clave.

**Paso 5.** Pulsar **Generar clave secreta**. Yappy enseña los dos valores:

- **ID de comercio**
- **Clave secreta**

Aquí no se cierra nada. Se pasa a la pestaña del panel y se pegan los dos en sus
campos. Se guarda. Y recién entonces se vuelve a Yappy y se pulsa **Listo**.

**Paso 6.** De vuelta en el menú del Botón de Pago quedan a la vista la **URL del
sitio** y el **ID del comercio**. El ID se puede volver a consultar siempre; la
clave, no.

---

## Reglas de seguridad

- **La clave secreta no se manda por WhatsApp, ni por correo, ni se escribe en
  un chat.** Se teclea o se pega directo en la pantalla de Pasarelas del panel,
  que la cifra antes de guardarla.
- Si alguien pide esa clave por mensaje, la respuesta es no. El sistema nunca la
  pide por ahí.
- Si se sospecha que se filtró: generar unas nuevas en Yappy y pegarlas en el
  panel. Las viejas quedan muertas en ese momento.

---

## Cómo saber que quedó bien

En el panel, en **Pasarelas**, la fila de Yappy deja de decir que le falta algo.
Si sigue pidiendo «ID de comercio» o «Clave secreta», es que uno de los dos no
se guardó.

Que el sistema diga que puede encenderse **no** significa que Yappy ya cobre.
Eso solo lo prueba un cobro de verdad en modo prueba, y ese paso lo hace Juan.
