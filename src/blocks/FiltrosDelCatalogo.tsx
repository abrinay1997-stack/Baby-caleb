import { useState } from 'react';
import type { Filtros, Opciones, Orden } from '../tienda/articulos';

/**
 * Los filtros de la tienda: marca, categoría y talla, más el orden.
 *
 * ## Por qué casillas de verdad y no «chips» hechos con divs
 *
 * Lo que se ve es una pastilla, pero por debajo cada una es un `<input
 * type="checkbox">` dentro de su `<label>`. Eso no es purismo: es lo que hace
 * que funcione el tabulador, la barra espaciadora, el lector de pantalla y el
 * control por voz, gratis y sin escribir una línea de JavaScript. Un `<div
 * role="checkbox">` con `onClick` se ve igual y deja fuera a quien no usa el
 * ratón — y hay que reimplementarle a mano el foco, el teclado y el estado.
 *
 * El `<input>` se esconde con `sr-only` (sigue existiendo y sigue recibiendo
 * el foco), y el recuadro de foco se pinta en la pastilla con
 * `peer-focus-visible`.
 *
 * ## Qué agrupa a qué
 *
 * Cada grupo es un `<fieldset>` con su `<legend>`. Sin eso, un lector de
 * pantalla anuncia «Nateen, casilla» y quien escucha no sabe si Nateen es una
 * marca, una talla o una categoría. Con la leyenda dice «Marca: Nateen,
 * casilla», que es la frase completa.
 *
 * ## Por qué en el teléfono empieza cerrado
 *
 * Era una caja con fondo propio, borde y relleno de 20 px, con tres grupos de
 * pastillas abiertos y el orden debajo. Medido a 390 px: **el primer producto
 * caía por debajo de los 1 900 px**, o sea tres pantallazos de filtros antes
 * de ver nada que se pueda comprar. Nadie entra a una tienda a mirar filtros.
 *
 * Así que en el teléfono los grupos viven dentro de un `<details>` y lo que
 * queda siempre a la vista es lo que de verdad se usa sin pensar: **cuántos
 * artículos hay** y **el orden**. En la computadora sobra el sitio, así que
 * nace abierto y el `<summary>` ni se enseña.
 *
 * Es un `<details>` de verdad, no un `div` con `onClick`: trae el teclado, el
 * estado («contraído»/«expandido») y el anuncio del lector de pantalla
 * puestos. Lo único que hay que vigilar es su alto táctil, y de eso se encarga
 * `min-h-11` — la clase `tactil` que había aquí **no existe en la web**: vive
 * en la hoja del panel (`sistema/panel/src/estilos.css`), así que Tailwind la
 * dejaba pasar y no ponía ninguna altura mínima a nada.
 *
 * Y la cuenta de resultados se queda FUERA del `<details>`: dentro de algo
 * cerrado, un `aria-live` no se anuncia, y es justo cuando más falta hace
 * saber que la lista cambió.
 */

const ORDENES: ReadonlyArray<{ valor: Orden; titulo: string }> = [
  { valor: 'tienda', titulo: 'Los de la tienda' },
  { valor: 'precio-asc', titulo: 'Precio: de menor a mayor' },
  { valor: 'precio-desc', titulo: 'Precio: de mayor a menor' },
  { valor: 'disponibles', titulo: 'Disponibles primero' },
  { valor: 'ultimas', titulo: 'Últimas unidades primero' },
];

/** Cómo se lee una categoría. La base las guarda en corto. */
const CATEGORIAS: Readonly<Record<string, string>> = {
  panal: 'Pañales',
  pants: 'Pants',
  wipes: 'Toallitas',
  portabebe: 'Portabebés',
  otro: 'Otros',
};

export const comoSeLeeLaCategoria = (familia: string): string =>
  CATEGORIAS[familia] ?? familia.charAt(0).toUpperCase() + familia.slice(1);

/**
 * Si la pantalla da para enseñar los filtros abiertos desde el principio.
 *
 * Se lee UNA vez, al montar, y no se escucha el cambio de tamaño: nadie gira
 * el teléfono para que se le abran los filtros, y un `matchMedia` escuchando
 * volvería a abrir lo que la persona acaba de cerrar. 768 px es el `md` de
 * Tailwind, que es donde la rejilla ya enseña dos columnas.
 */
const naceAbierto = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;

function Pastilla({
  nombre,
  valor,
  titulo,
  cuantos,
  marcada,
  alCambiar,
}: {
  nombre: string;
  valor: string;
  titulo: string;
  cuantos: number;
  marcada: boolean;
  alCambiar: (marcada: boolean) => void;
}) {
  /*
   * El contorno es `accent-edge` y no `line`, también sin marcar.
   *
   * `--line` es rgba(27,50,70,0.12): 1.24:1 contra el crema. Eso vale para
   * separar dos tarjetas —ahí la raya solo insinúa— y no vale para dibujar un
   * control, que es lo único que dice dónde empieza y dónde acaba algo que se
   * toca (WCAG 1.4.11 pide 3:1). Con el fondo de la pastilla y el de la página
   * casi iguales, una pastilla sin marcar se quedaba en una palabra suelta
   * flotando. `--accent-edge` existe justo para esto —«bordes, aros de foco e
   * iconos de marca», 3.20 sobre el fondo— y así la pastilla marcada es la
   * misma forma, rellena.
   */
  return (
    <label
      className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-pill border border-accent-edge px-3.5 text-sm font-bold transition-colors ${
        marcada ? 'bg-accent text-accent-fg' : 'bg-bg text-fg hover:bg-surface'
      }`}
    >
      <input
        type="checkbox"
        name={nombre}
        value={valor}
        checked={marcada}
        onChange={(e) => alCambiar(e.target.checked)}
        /*
          `text-base` en algo que nadie ve: la regla de los 16 px (§7b) mide
          `input, select, textarea` sin preguntar cuál, y esta casilla heredaba
          los 14 px de la pastilla. Quince casillas, quince rojos. Que iOS no
          haga zoom al tocar una casilla —no abre teclado— no es motivo para
          dejar una regla señalando algo cada vez que se mide: a un informe con
          quince rojos que hay que descartar a mano se le deja de hacer caso
          entero, y con él a los que sí eran de verdad (`docs/TRAMPAS.md` §14).
          Cuesta una clase y no mueve un píxel.
        */
        className="peer sr-only text-base"
      />
      <span className="peer-focus-visible:outline-accent-edge peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 rounded-sm">
        {titulo}
      </span>
      {/*
        La cuenta va aparte y oculta al lector: él ya oye «marcada» o «sin
        marcar», y «Nateen 9» suena a que la marca se llama «Nateen 9».
        Quien ve la pantalla sí necesita el número para saber si vale la pena
        tocarla.
      */}
      {/*
        La cuenta se distingue por el PESO, no por la opacidad.

        Llevaba `opacity-70` cuando la pastilla está marcada, y medido sobre la
        pastilla de verdad eso dejaba el número en 3.35:1 contra el 4.5 de AA:
        el navy sobre el naranja está en 5.56, pero la opacidad la aplica el
        navegador al pintar y se lleva por delante un par que estaba medido.
        En letra normal al lado de un título en negrita se lee igual de
        secundario y se lee.
      */}
      <span aria-hidden="true" className={`font-normal ${marcada ? '' : 'text-muted'}`}>
        {cuantos}
      </span>
    </label>
  );
}

function Grupo({
  leyenda,
  children,
}: {
  leyenda: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mono mb-2 block text-xs text-muted">{leyenda}</legend>
      {/*
        En el teléfono las pastillas se envuelven en varias líneas en vez de
        irse a un carrusel horizontal: un carrusel esconde opciones detrás de
        un gesto que no se anuncia, y la clienta no sabe que hay más marcas si
        no se le ocurre arrastrar.
      */}
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

export function FiltrosDelCatalogo({
  opciones,
  filtros,
  alCambiar,
  cuantosSalen,
  cuantosHay,
}: {
  opciones: Opciones;
  filtros: Filtros;
  alCambiar: (f: Filtros) => void;
  cuantosSalen: number;
  cuantosHay: number;
}) {
  const [abierto, setAbierto] = useState(naceAbierto);

  const alterna = (lista: readonly string[], valor: string, marcada: boolean): string[] =>
    marcada ? [...lista, valor] : lista.filter((x) => x !== valor);

  const puestos = filtros.marcas.length + filtros.familias.length + filtros.tallas.length;
  const hayFiltros = puestos > 0;

  return (
    <div className="mb-8 md:mb-10">
      {/*
        La fila que no se esconde nunca: cuántos hay y en qué orden.

        Va ARRIBA del todo y pegada a una raya en vez de dentro de una caja con
        fondo. La caja añadía un borde, un relleno de 20 px y un color de fondo
        para envolver tres controles — aire que en el teléfono se paga en
        productos que no se ven.
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line pb-3">
        {/*
          Cuántos quedan, anunciado.

          Sin esto, quien no ve la pantalla marca «Velvee» y no se entera de
          nada: la lista cambia en silencio. `aria-live="polite"` lo dice sin
          interrumpir lo que esté leyendo.
        */}
        <p role="status" aria-live="polite" className="m-0 text-sm font-bold text-fg">
          {cuantosSalen === cuantosHay
            ? `${cuantosHay} artículos`
            : `${cuantosSalen} de ${cuantosHay} artículos`}
        </p>

        <label className="flex items-center gap-2 text-sm">
          <span className="mono shrink-0 text-xs text-muted">Ordenar</span>
          <select
            value={filtros.orden}
            onChange={(e) => alCambiar({ ...filtros, orden: e.target.value as Orden })}
            /*
              16 px en el campo, como en el panel y por el mismo motivo: por
              debajo de eso, Safari en iPhone hace zoom al tocarlo y deja la
              página torcida. `text-base` son 16, y el §7b del contrato lo
              mide en el navegador.
            */
            className="min-h-11 rounded-md border border-accent-edge bg-bg px-3 text-base font-bold text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          >
            {ORDENES.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.titulo}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/*
        Y los filtros: cerrados en el teléfono, abiertos en la computadora.

        El `<summary>` se esconde donde el `<details>` nace abierto — un
        desplegable que no se puede plegar no necesita su tirador, y así la
        computadora enseña los tres grupos sin un renglón de más.
      */}
      <details
        open={abierto}
        onToggle={(e) => setAbierto(e.currentTarget.open)}
        className="border-b border-line"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-bold text-fg [&::-webkit-details-marker]:hidden md:hidden">
          <span>Filtrar</span>
          {hayFiltros ? (
            <span className="rounded-pill bg-accent px-2 py-0.5 text-xs font-bold text-accent-fg">
              {puestos}
            </span>
          ) : null}
          <span aria-hidden="true" className="text-muted">
            {abierto ? '−' : '+'}
          </span>
        </summary>

        <div className="grid gap-5 pb-5 sm:grid-cols-2 md:grid-cols-3 md:pt-4">
          {opciones.familias.length > 1 ? (
            <Grupo leyenda="Categoría">
              {opciones.familias.map((o) => (
                <Pastilla
                  key={o.valor}
                  nombre="categoria"
                  valor={o.valor}
                  titulo={comoSeLeeLaCategoria(o.valor)}
                  cuantos={o.cuantos}
                  marcada={filtros.familias.includes(o.valor)}
                  alCambiar={(m) => alCambiar({ ...filtros, familias: alterna(filtros.familias, o.valor, m) })}
                />
              ))}
            </Grupo>
          ) : null}

          {opciones.marcas.length > 1 ? (
            <Grupo leyenda="Marca">
              {opciones.marcas.map((o) => (
                <Pastilla
                  key={o.valor}
                  nombre="marca"
                  valor={o.valor}
                  titulo={o.valor}
                  cuantos={o.cuantos}
                  marcada={filtros.marcas.includes(o.valor)}
                  alCambiar={(m) => alCambiar({ ...filtros, marcas: alterna(filtros.marcas, o.valor, m) })}
                />
              ))}
            </Grupo>
          ) : null}

          {opciones.tallas.length > 1 ? (
            <Grupo leyenda="Talla">
              {opciones.tallas.map((o) => (
                <Pastilla
                  key={o.valor}
                  nombre="talla"
                  valor={o.valor}
                  titulo={o.valor}
                  cuantos={o.cuantos}
                  marcada={filtros.tallas.includes(o.valor)}
                  alCambiar={(m) => alCambiar({ ...filtros, tallas: alterna(filtros.tallas, o.valor, m) })}
                />
              ))}
            </Grupo>
          ) : null}
        </div>
      </details>

      {/*
        «Quitar los filtros» solo existe cuando hay algo que quitar, y vive
        fuera del desplegable: si los filtros están puestos y plegados, el
        botón de deshacerlos tiene que verse igual.
      */}
      {hayFiltros ? (
        <div className="pt-3">
          <button
            type="button"
            onClick={() => alCambiar({ marcas: [], familias: [], tallas: [], orden: filtros.orden })}
            className="inline-flex min-h-11 items-center rounded-pill text-sm font-bold text-fg underline transition-colors hover:text-accent-strong focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Quitar los filtros
          </button>
        </div>
      ) : null}
    </div>
  );
}
