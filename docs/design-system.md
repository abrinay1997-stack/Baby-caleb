# El §7 del panel: móvil y accesibilidad

**Esto es contrato, no estilo.** El panel se usa desde el teléfono tanto como
desde la computadora, y estas reglas son lo que hace que se pueda usar con una
mano, de pie, con un bebé encima.

Existían solo dentro de `sistema/scripts/auditar-panel.mjs`, que es quien las
comprueba. Estaban escritas, pero para leerlas había que abrir un guion — y una
regla que hay que ir a buscar no se cumple. Aquí están para leerlas; **el guion
sigue siendo quien manda**, porque es el que mide.

```
cd sistema
npm run panel:muestra          # en otra terminal, o con PUERTO=4180
CHROMIUM_PATH=/opt/pw-browsers/chromium npm run panel:auditar
```

## Las reglas

### 7a · 44 px de alto en todo lo que se toca

Botones, enlaces, `role="button"` y `<summary>`. Un dedo no acierta en menos.

Un enlace dentro de un párrafo **no** cuenta: lo táctil es lo que existe para
tocarse, no una palabra subrayada en medio de una frase.

> Un `<summary>` es un botón aunque parezca texto. Se cayó por esto una vez,
> con 21 px.

**Los 44 px son el contrato DEL PANEL, no una norma universal.** La WCAG 2.5.8
(AA, nueva en la 2.2) pide 24×24 px **o** separación suficiente: una diana más
pequeña cumple igual si el círculo de 24 px centrado en ella no toca el de
ninguna otra. El panel pide casi el doble a propósito — se usa con una mano,
con prisa, a veces al sol y con el teléfono en la otra mano.

La **tienda** se mide con la 2.5.8, no con esto. Medirla con los 44 px del
panel daba 434 fallas, y al comprobarlas una por una **ninguna** incumplía la
2.5.8: eran listas densas de enlaces de pie y de navegación, separadas de
sobra. Un informe de 434 rojos que un revisor con criterio descarta no se lee:
se descarta entero (`docs/TRAMPAS.md` §14). Cada superficie con su norma, y el
informe dice con cuál — el mismo medidor, con `opciones`.

Y en las dos: **una diana tapada no es una diana.** Se le pregunta al navegador
qué hay de verdad en su centro, y si hay otra capa encima no se le exige
tamaño, porque nadie la va a pulsar. Que algo quede tapado lo vigila su propia
regla, la 7d, que es la que sabe distinguir «tapado mientras hay un diálogo
abierto» de «tapado siempre».

### 7b · 16 px en los campos

`input`, `select`, `textarea`. Con menos, iOS hace zoom al enfocar y la
pantalla se descoloca sola — y quien está escribiendo pierde de vista lo que
escribía.

### 7c · Nada de texto por debajo de 12 px

Ni aunque sea una nota al pie. Si no se puede leer, no está.

### 7d · La burbuja de Caleb no se sienta encima de nada que se toque

Flota en todas las pantallas, así que lo que tape lo tapa doce veces. Es la
hermana de la 7f y falla por lo mismo: la burbuja está **fija**, así que en una
captura de página entera se dibuja una sola vez, donde estuviera el viewport, y
eso es el artefacto. El fallo de verdad es que el contenido no reserve su hueco.

Se mide con la página **abajo del todo**, que es donde la última fila queda más
cerca. Tapaba «No cuadra» en Cobros, al lado de «Confirmar: el dinero entró».

### 7e · Ni `100vh` ni `min-width` en píxeles

- **`100vh`**: en el teléfono, la barra del navegador se come una parte, y lo
  que queda fuera es justo el pie — donde están Guardar y Borrar. Se usa `dvh`,
  que sí sigue a la barra.
- **`min-width` en píxeles**: obliga a hacer scroll de lado. Una pantalla que
  se mueve en horizontal se siente rota aunque funcione.

Se miran las hojas de estilo, no el estilo calculado: es ahí donde se escriben.

### 7f · La barra inferior no tapa el contenido

La barra de navegación del teléfono es `position: fixed`, así que no empuja
nada. Si el contenido no reserva su alto, la última fila queda **debajo** de
ella: a la dueña le falta el último producto de la lista y nada se lo dice.

No se estima: se mide. El hueco se escribe una vez en el CSS y el alto de la
barra cambia cada vez que alguien le toca un renglón.

### 7g · No se desborda de lado

Es el síntoma de todo lo anterior cuando se escapa.

### 7h · Contraste de 4.5:1 en el texto, 3:1 en lo grande

Medido en píxeles, no en tokens. Un token puede estar bien y aplicarse sobre un
fondo que no era el que se pensó; lo que cuenta es el color que sale. «Grande»
es 24 px, o 18,66 px en negrita.

El gris claro sobre blanco es el fallo más común y el más invisible, porque en
la pantalla de quien lo escribe se lee perfectamente. En el teléfono de la
dueña, al sol, no.

### 7i · Todo lo que se enfoca, se ve enfocado

El aro lo pone `:focus-visible` en `estilos.css`, una vez para todo el panel. Un
`outline: none` suelto en un componente lo apaga solo ahí, y quien navega con
teclado —o con el teclado del teléfono abierto encima de media pantalla—
pierde el sitio sin ninguna señal.

Un elemento apagado o detrás de una hoja abierta no cuenta: ahí lo correcto es
justo que no se pueda enfocar.

### 7j · Cada campo con su etiqueta, cada icono con su nombre

Un texto **al lado** no es una etiqueta. El lector de pantalla lee el campo
solo, y dice «cuadro de edición» sin más. Hace falta un `<label for="…">`, el
campo dentro del `<label>`, o un `aria-label`.

Lo mismo con un botón que solo lleva un icono: sin nombre se anuncia como
«botón», que no le sirve a nadie. La papelera y la equis son las que más se
olvidan.

### 7k · Los encabezados no saltan niveles

Quien usa un lector de pantalla salta de encabezado en encabezado: ésa es su
tabla de contenidos. De `h1` a `h3` lo que oye es que falta una sección.

Y los rótulos de un menú no son encabezados del documento: son etiquetas de
grupos de navegación. Puestos como `<h2>` antes del `<h1>`, el esquema de cada
pantalla empieza por el menú.

### 7l · En el teléfono, la cifra que se viene a buscar va arriba a la derecha

Solo en el teléfono: en la computadora las filas son columnas de tabla y la
regla es otra.

Comparte el **primer renglón** con el título y toca el **borde derecho**. Se
rompía sin que nada lo dijera: cuando la celda del título crecía a dos líneas,
la cifra se caía al renglón de abajo y aterrizaba entre dos datos sueltos. En
Bodegas se leía «Principal 412 Productos 96 unidades» —otro número metido entre
el dato y su unidad— y en Existencias se caía justo en las filas bajas de stock,
que son las que se viene a mirar.

Se mide contra el alto de **una** línea del título, no contra su caja entera:
con dos líneas, la caja abarca también el renglón de abajo y daría por buena
justo la forma que esto vigila.

### 7m · El contorno de un control se ve (3:1)

La 7h mide **texto**. El borde de un campo no es texto, y es lo único que dice
dónde empieza el campo. Estaba a **1.24:1 en todos los campos del panel**,
porque `--line` hacía dos trabajos distintos: separar tarjetas —donde está
bien— y dibujar un control, donde no. Son dos tokens: `--line` para las rayas
y `--control` para los contornos.

Se mide contra el fondo que hay detrás, que es lo que pide la WCAG 1.4.11. Y se
mide en el elemento, no en el token: un token correcto que no llega al elemento
se ve exactamente igual que no tenerlo.

## Lo que el auditor NO puede ver

Mide, no mira. Ha dado «sin fallas» sobre:

- una hoja que salía **pegada a la esquina** en computadora, porque medía los
  tamaños y no la posición (se añadió una comprobación de centrado);
- burbujas **sin color**, porque una clase de Tailwind que no existe se
  descarta en silencio y un fondo invisible no rompe ningún tamaño;
- un título **repetido** que en un teléfono se come media pantalla.

Por eso las capturas se miran, no solo se cuentan. Quedan en `.capturas/`.

## El auditor se prueba a sí mismo

Cada regla de aquí tiene en `sistema/scripts/medir-el-panel.mjs` un par de
muestras: un trozo de HTML que **tiene que suspender** y otro que **tiene que
aprobar**. El auditor las corre antes de mirar el panel y se para si una regla
deja de señalar su propia muestra.

Hace falta porque ya pasó al revés: dos arreglos de CSS se rompieron a propósito
y el auditor siguió diciendo «sin fallas», porque medía todo menos justo eso
(`docs/TRAMPAS.md` §11). Un control que aprueba siempre no es un control: es un
permiso. Romper la regla a mano encontró el hueco una vez; la muestra lo
encuentra siempre.

Si cambia la forma del panel y una muestra deja de representarla, se corrige la
muestra. Lo que no se hace es borrar la regla porque molesta.

## Y la regla que más se olvida

**Una pantalla u hoja nueva no se mide sola.** Hay que añadirla a **las dos**:

1. `sistema/scripts/auditar-panel.mjs` — para que la visite
2. `sistema/scripts/panel-de-muestra.mjs` — para que tenga datos que enseñar

Sin las dos, el auditor la ve como un 404 y sigue diciendo «sin fallas» sobre
las que ya estaban. Una pantalla que no se mide no dice «está bien»: no dice
nada. Está en `docs/TRAMPAS.md` §4.

## Los colores

Son variables CSS en `sistema/panel/src/estilos.css`, y en Tailwind se usan por
su nombre: `bg-accent`, `text-accent-fg`, `bg-surface`, `bg-bg`, `text-fg`,
`text-muted`, `border-line`, `outline-accent-edge`.

**No invente nombres.** Tailwind descarta en silencio una clase que no conoce,
así que un token inventado no da error: da un elemento sin color. Pasó con
`bg-acento` y `text-sobre-acento`, que no existen.
