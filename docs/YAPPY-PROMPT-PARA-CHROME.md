# Instrucción para el agente de Chrome (conseguir las credenciales de Yappy)

Esto se pega tal cual en Claude en Chrome, con la dueña delante. El agente
**guía**; la dueña es la que teclea y la que pulsa.

Por qué así: la clave secreta no debe pasar por un chat, ni por el del agente.
El agente puede leer la pantalla, así que la instrucción le prohíbe
explícitamente transcribir, copiar al chat o repetir ese valor. Lo que hace es
encargarse del orden, que es lo que se rompe cuando se hace sin ayuda.

---

```
Vas a acompañar a la dueña de Baby Caleb a generar las credenciales del Botón
de Pago de Yappy. Ella teclea y ella pulsa: tú lees la pantalla, le dices el
siguiente paso de a uno, y verificas que lo que salió es lo que tenía que salir.

REGLAS QUE NO SE ROMPEN

1. NUNCA escribas, repitas, transcribas ni resumas el valor de la «Clave
   secreta» ni del «ID de comercio». No los pongas en el chat, ni en una nota,
   ni en un resumen al final, ni aunque ella te lo pida. Si aparecen en
   pantalla, descríbelos como «el valor que se ve en pantalla» y nada más.
2. No los copies al portapapeles por tu cuenta ni los pegues tú en ningún
   sitio. Ella copia y ella pega.
3. No pulses «Regenerar» ni «Generar» nada sin que ella lo diga. Regenerar
   desactiva las credenciales anteriores y rompe los cobros que ya estuvieran
   funcionando.
4. Si algo no coincide con lo que esperas, PARA y pregúntale. No improvises
   otro camino.

EL ORDEN IMPORTA, Y ES LA RAZÓN POR LA QUE ESTÁS AQUÍ

Yappy enseña la clave secreta UNA sola vez. Si se cierra esa ventana sin
guardarla, hay que generar otras y las viejas mueren. Así que el panel de Baby
Caleb tiene que estar abierto y listo ANTES de generarla.

PASOS

Paso 0 — Que abra, en una pestaña aparte, https://panel.babycaleb.com y vaya a
  Pasarelas → «Yappy · Botón de Pago». Confirma con ella que ve los campos
  vacíos de «ID de comercio» y «Clave secreta». Esa pestaña se queda abierta.
  No sigas hasta que te confirme que la ve.

Paso 1 — Que entre a Yappy Comercial con su usuario ADMINISTRADOR. Pregúntale
  si el usuario con el que entró es administrador. Si en el paso 2 no aparece
  la opción, es que no lo es: entonces para y dile que necesita entrar con el
  usuario administrador.

Paso 2 — Guíala a «Productos › Botón de Pago».

Paso 3 — «Crear botón de pago».

Paso 4 — El formulario pide los datos del sitio web. El dominio es:
  babycaleb.com
  (sin https://, sin www y sin barra final, salvo que el formulario pida otro
  formato en pantalla). Este dato NO es decorativo: viaja en cada cobro y entra
  en la firma con la que Yappy avisa del resultado, así que si no coincide los
  pagos no cuadran. Verifica con ella lo que escribió antes de que pulse
  «Activar».
  Después de activar, el botón queda en estado «Pendiente». Eso es correcto:
  falta la clave.

Paso 5 — Antes de que pulse «Generar clave secreta», recuérdale que la pestaña
  del panel está abierta y que en cuanto aparezcan los valores los va a pegar
  ahí. Cuando te diga que está lista, que pulse.
  Cuando los valores estén en pantalla: dile que copie el ID de comercio, se
  vaya a la pestaña del panel, lo pegue; que vuelva, copie la clave secreta,
  la pegue también, y GUARDE en el panel.
  Tú no copias nada. Tú solo confirmas que el panel dice que guardó.

Paso 6 — Recién cuando el panel haya guardado, que vuelva a Yappy y pulse
  «Listo».

CÓMO SABER QUE QUEDÓ BIEN

En el panel, en Pasarelas, la fila de Yappy tiene que dejar de pedir «ID de
comercio» y «Clave secreta». Si sigue pidiendo alguno, uno de los dos no se
guardó: que lo vuelva a pegar. El ID de comercio se puede volver a consultar en
Yappy; la clave secreta NO, así que si fue la clave la que falló, avisa a Juan
antes de regenerar nada.

AL TERMINAR

Dile a la dueña, en una frase, si quedó guardado o qué falta. No incluyas
ningún valor. Y dile que esto no significa que Yappy ya esté cobrando: eso lo
prueba Juan con un cobro de prueba.
```
