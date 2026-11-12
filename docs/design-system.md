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

### 7b · 16 px en los campos

`input`, `select`, `textarea`. Con menos, iOS hace zoom al enfocar y la
pantalla se descoloca sola — y quien está escribiendo pierde de vista lo que
escribía.

### 7c · Nada de texto por debajo de 12 px

Ni aunque sea una nota al pie. Si no se puede leer, no está.

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

## Lo que el auditor NO puede ver

Mide, no mira. Ha dado «sin fallas» sobre:

- una hoja que salía **pegada a la esquina** en computadora, porque medía los
  tamaños y no la posición (se añadió una comprobación de centrado);
- burbujas **sin color**, porque una clase de Tailwind que no existe se
  descarta en silencio y un fondo invisible no rompe ningún tamaño;
- un título **repetido** que en un teléfono se come media pantalla.

Por eso las capturas se miran, no solo se cuentan. Quedan en `.capturas/`.

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
