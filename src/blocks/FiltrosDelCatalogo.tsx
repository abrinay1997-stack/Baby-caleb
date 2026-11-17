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
  return (
    <label
      className={`tactil inline-flex cursor-pointer items-center gap-2 rounded-pill border px-4 py-2.5 text-sm font-bold transition-colors ${
        marcada
          ? 'border-accent-edge bg-accent text-accent-fg'
          : 'border-line bg-surface text-fg hover:border-accent-edge'
      }`}
    >
      <input
        type="checkbox"
        name={nombre}
        value={valor}
        checked={marcada}
        onChange={(e) => alCambiar(e.target.checked)}
        className="peer sr-only"
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
      <span aria-hidden="true" className={marcada ? 'opacity-70' : 'text-muted'}>
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
      <legend className="mono mb-3 block text-xs text-muted">{leyenda}</legend>
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
  const alterna = (lista: readonly string[], valor: string, marcada: boolean): string[] =>
    marcada ? [...lista, valor] : lista.filter((x) => x !== valor);

  const hayFiltros =
    filtros.marcas.length > 0 || filtros.familias.length > 0 || filtros.tallas.length > 0;

  return (
    <div className="mb-10 rounded-lg border border-line bg-surface p-5 sm:p-6">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
        <label className="flex items-center gap-3 text-sm">
          <span className="mono shrink-0 text-xs text-muted">Ordenar</span>
          <select
            value={filtros.orden}
            onChange={(e) => alCambiar({ ...filtros, orden: e.target.value as Orden })}
            /*
              16 px en el campo, como en el panel y por el mismo motivo: por
              debajo de eso, Safari en iPhone hace zoom al tocarlo y deja la
              página torcida.
            */
            className="tactil rounded-md border border-line bg-bg px-3 py-2 text-base font-bold text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          >
            {ORDENES.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.titulo}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-4">
          {/*
            Cuántos quedan, anunciado.

            Sin esto, quien no ve la pantalla marca «Velvee» y no se entera de
            nada: la lista cambia en silencio. `aria-live="polite"` lo dice sin
            interrumpir lo que esté leyendo.
          */}
          <p role="status" aria-live="polite" className="m-0 text-sm text-muted">
            {cuantosSalen === cuantosHay
              ? `${cuantosHay} artículos`
              : `${cuantosSalen} de ${cuantosHay} artículos`}
          </p>
          {hayFiltros ? (
            <button
              type="button"
              onClick={() => alCambiar({ marcas: [], familias: [], tallas: [], orden: filtros.orden })}
              className="tactil rounded-pill px-4 py-2 text-sm font-bold text-fg underline transition-colors hover:text-accent-strong focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Quitar los filtros
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
