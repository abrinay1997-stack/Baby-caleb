# Las trampas de este proyecto

Esta no es una bitácora de fallos. Es una **lista de reglas**, y cada una está
aquí porque ya mordió — en este repositorio, no en general. Al lado de cada
una va cuándo mordió y dónde vive la explicación larga, para que nadie la
suavice por no saber lo que costó.

**Se lee antes de empezar, no después de romper algo.** Ese es el problema que
este archivo resuelve: las lecciones ya estaban escritas, pero cada una vivía
en el archivo que protege, así que solo se leían estando ya dentro — o sea,
tarde. Tres de ellas se repitieron por eso.

Cuando una regla la pueda comprobar una máquina, **la comprueba la máquina**.
Una regla que depende de que alguien se acuerde vale la mitad. La columna
«vigilada por» dice cuál ya está cerrada y cuál sigue dependiendo de la
cabeza de quien escribe.

---

## 1. Un control que comprueba algo que ya era cierto no protege nada

**Mordió TRES veces.** Es la campeona.

Una fila de `controles` solo vale si comprueba **los valores que ESE batch
acaba de escribir**. Si comprueba algo que ya era verdad antes —«¿el pago está
aprobado?», «¿reservado ≥ 0?» cuando la tabla ya tiene ese CHECK— pasa siempre,
no detecta nada, y encima hace creer que algo está vigilado.

> `src/db/transiciones.ts` · `src/db/contabilidad.ts` · `src/db/entregas.ts`

**Cómo se comprueba:** neutralice el control (déjelo en `ok = 1` fijo) y corra
las pruebas. Si ninguna se pone roja, ese control no defiende nada: o se
arregla, o se quita y se escribe por qué no hace falta.

**Vigilada por:** nadie todavía. Es la candidata número uno a convertirse en
prueba.

---

## 2. No adivine el texto de un error ajeno

**Mordió una vez y casi dos.**

El guion de las colas toleraba «already exists» para saber que una cola ya
estaba. Cloudflare dice «is already taken». El despliegue falló por una cola
que SÍ existía. Y hoy casi se repite: el flujo de la web sacaba la URL del
sitio con un `grep` de la salida de `wrangler`.

Adivinar la redacción de un error o de una salida ajena es apostar a que nadie
la cambie ni la traduzca, y se pierde en silencio.

**La regla:** no lea el mensaje — **pregunte** (pida la lista y mire si está) o
**lea la configuración** (el propio repositorio declara sus nombres y sus URLs).

> commit `4302917` · `.github/scripts/colas.sh` · `.github/workflows/web.yml`

**Vigilada por:** nadie. Se revisa al leer cualquier guion de CI.

---

## 3. Una tubería convierte un fallo en un éxito

En bash, el código de salida de una tubería es el del **último** comando. Un
`wrangler deploy | tee salida.txt` que falla da por bueno el paso, porque `tee`
salió bien. Pasó de verdad, en el camino de despliegue, que es el peor sitio
donde tener un fallo mudo.

**La regla:** `set -o pipefail` en todo guion de CI con tuberías. Y después del
comando, **comprobar que produjo lo que tenía que producir**.

> commit `9ec343f`

**Vigilada por:** nadie. Mírelo en cada guion nuevo.

---

## 4. Las pruebas en verde no dicen cómo se ve

El auditor del §7 ha encontrado **tres desbordes laterales** en el teléfono con
el typecheck y la suite entera en verde. Un desborde de 92 px no lo ve ninguna
prueba de unidad: solo se mide leyendo el estilo ya calculado en un navegador.

> `sistema/scripts/auditar-panel.mjs` · `sistema/docs/design-system.md` §7

**Vigilada por:** ✅ el auditor, en CI. Mide todas las pantallas del panel, el
cajón abierto, las hojas —donde viven los campos— y la frontera de errores, en
teléfono y en computadora. Aquí NO va el número de pantallas que mide: ese
número ha quedado desactualizado tres veces y dos agentes distintos chocaron
corrigiéndolo. El número lo dice el propio auditor al correr.

**Lo que hay que hacer con cada pantalla u hoja NUEVA, y son dos cosas:**
añadirla a `scripts/auditar-panel.mjs` Y poner sus datos en
`scripts/panel-de-muestra.mjs`. Sin las dos, el auditor la ve como un 404 y
sigue diciendo «sin fallas» sobre las que ya estaban. Una pantalla que no se
mide no dice «está bien»: no dice nada.

**Y mide dónde SALE la hoja, no solo que salga.** La hoja estuvo desde el
primer día pegada a la esquina de arriba a la izquierda en computadora —en cada
pedido, cada ajuste y cada movimiento de inventario— porque el bloque de hojas
se escribió para el cajón del teléfono y nadie las abría en escritorio. Una
captura enseña que algo aparece; no enseña que aparezca donde debe.

---

## 5. Mire la captura, no solo el número

El auditor puede decir «sin fallas» y la pantalla estar mal. Lo han demostrado:
una burbuja de chat encima del botón «Quitar»; un subtítulo cortado a media
palabra; nueve filas en singular que perdían justo el dato accionable; el
carrito hablando de «usted» cuando el resto del sitio tutea.

**La regla:** después de cada auditoría, **abra la imagen**. Los números dicen
que no se rompe; la imagen dice si se entiende.

**Vigilada por:** nadie, y no se puede. Es trabajo de mirar.

---

## 6. Una prueba que pasa con el código roto no vigila nada

**Mordió dos veces anoche**, las dos en pruebas recién escritas por mí:

- La casilla «todas las entregas tienen su asiento» sobrevivió a ponerla en
  `ok` fijo: mis pruebas solo la veían decir «ok», que es lo que una casilla
  rota también dice.
- La prueba del error mal etiquetado tampoco cazaba la mutación, porque una
  guarda de la ruta cortaba antes de llegar al código que se probaba.

**La regla:** toda prueba se valida **rompiendo a propósito lo que vigila**. Si
no se pone roja, no vigila eso. Y si la mutación sobrevive porque hay otra
capa delante, pruebe la capa de abajo directamente.

**Vigilada por:** nadie. Es disciplina al escribir.

---

## 7. Cero no es «no sé»

Un cero es una afirmación: dice que la cifra es cero. Si no se sabe, no se
escribe.

El caso caro: el costo de una entrega sin promedio cargado. Un cero ahí dice
que la mercancía no costó nada y pone el margen en **100 %** — la ganancia más
bonita y más falsa que hay. Por eso el asiento del costo **falla** en vez de
escribir cero, y el pedido cae en «entregados sin costo» del cierre.

**La regla:** lo que falta queda `PENDIENTE` y se ve. Nunca aproximado, nunca
rellenado «porque suena razonable».

> `sistema/src/dominio/contabilidad.ts` · `HUECOS`

**Vigilada por:** ✅ en parte — las casillas del cierre y la lista de huecos del
panel. Pero la decisión de no inventar la toma quien escribe.

---

## 8. Hay una lista de configuración que alguien tiene que acordarse de tocar

Añadir una ruta, una cola o un recurso casi siempre implica **otra lista en
otro archivo**. Olvidarla no da error de compilación: da un fallo en vivo.

Ya pasó dos veces: `run_worker_first` sin las rutas nuevas (26 imágenes rotas),
y las ocho colas que `wrangler deploy` no crea y se negó a desplegar sin ellas.

**La regla:** al añadir algo, busque **dónde más se nombra lo que acaba de
añadir**. `grep` del nombre de lo anterior suele encontrar la lista.

**Vigilada por:** ✅ las colas, que ahora las crea el flujo. El resto, no.

---

## 9. Un parámetro que se ignora en silencio

`?limite=` no funcionaba en tres rutas. No daba error ni 400: `entero()` pedía
un `number` y `c.req.query()` devuelve `string`, así que siempre salía
`undefined` y la ruta usaba su valor por defecto. Ninguna prueba lo notó
**porque todas pedían sin límite**.

**La regla:** si una ruta acepta un parámetro, hay una prueba que **se lo pasa**
y comprueba que cambió algo.

> `sistema/src/api/panel.ts` · `enteroDeTexto`

**Vigilada por:** una prueba, ahora. La regla general no.

---

## 10. Un error mal etiquetado manda a buscar al sitio equivocado

`registrarComprobante` respondía «ese comprobante ya estaba registrado» a
**cualquier** restricción de la tabla, porque en SQLite «UNIQUE constraint» y
«CHECK constraint» dicen las dos «constraint». Un `tipo` malo devolvía 409
«repetido», y quien lo recibiera se pondría a buscar un duplicado que no
existe.

Lo mismo con el mes cerrado reportado como «algo cambió, vuelva a intentarlo»:
reintentar fallaba igual.

**La regla:** cada código de error nombra **su** causa. Si dos causas distintas
caen en el mismo mensaje, sepárelas.

> `sistema/src/db/pagos.ts` · `sistema/src/db/entregas.ts`

**Vigilada por:** pruebas de esos dos casos. La regla general no.

---

## 11. Lo que falla en CI no siempre es nuestro

El 11 de noviembre cayeron tres corridas seguidas con «Temporary failure
resolving 'archive.ubuntu.com'»: la red de la máquina efímera de GitHub, no el
repositorio, no un permiso, no el plan. El mismo paso había pasado bien dos
horas antes.

Y el despliegue a staging falló dos veces con «binding DB of type d1 failed to
generate — please try again later», que es de Cloudflare.

**La regla:** antes de tocar nada, **lea el error entero y pregunte de quién
es**. Si es de fuera: un reintento, y si persiste se dice y se para. Un
reintento se usa para confirmar que el fallo no es nuestro, nunca para que
pase. **Una prueba que pasa al tercer intento no pasó.**

> `.github/scripts/navegador.sh`

**Vigilada por:** ✅ el reintento de la instalación del navegador, que además
dice dónde mirar cuando se rinde.

---

## 12. Una pieza terminada que nadie llama

**Mordió TRES veces, y es la que más caro sale**, porque no se parece a un
fallo: todo está en verde.

- Los **veinte constructores de asientos**: escritos, cuadrando, con 1 224
  líneas de pruebas propias. Nadie los llamaba. Una entrega descontaba el
  inventario y dejaba los libros vacíos.
- El **módulo de cobros** entero: probado desde F4.4, sin una sola ruta. Un
  comprobante entraba en «confirmando» y se quedaba ahí para siempre.
- **`crearPedido`**: escrito y probado, sin ruta en el panel y sin método en
  el entrypoint de la web. Hoy no se puede crear un pedido desde ningún sitio.

Las pruebas pasaban las tres veces, y pasaban con razón: **comprueban que la
pieza funciona, no que esté enchufada**. Por eso el dueño ve un sistema muerto
teniendo el motor construido, y por eso esto no sale en ningún informe.

**La regla:** una pieza no está terminada cuando sus pruebas pasan. Está
terminada cuando **algo la llama desde fuera** —una ruta, un entrypoint, otra
capa— y hay una prueba que la llama **por donde la va a llamar el usuario**.
Si escribe un módulo y no puede nombrar quién lo invoca en producción, no ha
terminado: ha dejado una pieza en la mesa.

> `src/db/pagos.ts` · `src/dominio/contabilidad.ts` · `src/db/pedidos.ts`

**Vigilada por:** nadie todavía, y **se puede cerrar**: el grafo de imports es
exacto, no hace falta adivinar. Un guion que liste lo exportado por `src/db/`
y `src/dominio/` que no importe ningún archivo de fuera de su propio módulo
—sin contar pruebas— habría marcado los tres casos. Es la siguiente
herramienta a escribir, junto a `scripts/controles-que-no-vigilan.mjs`.

---

## Lo que este archivo NO es

No es una lista de todo lo que salió mal: la mayoría de los fallos se arreglan
y se olvidan, y está bien. Aquí solo entra lo que **se repitió o pudo
repetirse**, y entra con la regla que lo evita.

Si añade una entrada: diga cuándo mordió, qué regla lo evita y cómo se
comprueba. Si no tiene las tres cosas, todavía no es una entrada — es una
anécdota.
