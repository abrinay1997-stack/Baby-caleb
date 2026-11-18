import { buttonVariants } from './ui/Button';
import { precioLegible } from '../seo/producto';

/**
 * La barra de comprar: el precio y el botón, pegados abajo mientras se lee.
 *
 * El dueño lo pidió así: «el botón de comprar, del color más llamativo, y fijo
 * abajo». El color más llamativo de la marca es `--accent` (#EE924A) y el
 * botón que lo lleva es `buttonVariants({ variant: 'accent' })`, que además es
 * el único par con el contraste ya medido y arreglado: navy sobre naranja,
 * 5.56 (`src/styles/themes/babycaleb.css`). `accent-strong` es texto sobre
 * claro y `accent-edge` es un borde: ninguno de los dos vale para rellenar un
 * botón.
 *
 * ## `sticky`, no `fixed`, y es lo único importante de este archivo
 *
 * Una barra `fixed` no empuja nada: se dibuja encima del contenido, así que la
 * última fila de la página queda DEBAJO de ella y nadie se entera — a la dueña
 * le falta el último renglón y nada se lo dice. Es el §7f del contrato de
 * diseño, y la única forma de cumplirlo con `fixed` es escribir el hueco a
 * mano en el CSS y acordarse de volver a medirlo cada vez que alguien le toque
 * un renglón a la barra.
 *
 * `position: sticky` no tiene ese problema **por construcción**: el elemento
 * sigue en el flujo y ocupa su propio alto, así que el hueco no se estima, no
 * se escribe y no se puede olvidar. Mientras se lee la ficha la barra se queda
 * pegada al borde de abajo de la pantalla; al llegar al final del contenido se
 * sienta en su sitio y no tapa nada. Lo mide
 * `scripts/auditar-la-web.mjs`, con la página abajo del todo, que es donde el
 * fallo se vería.
 *
 * ## El hueco de la derecha tampoco es decorativo
 *
 * La burbuja del chat de Caleb es `fixed bottom-6 right-6` y mide 56 px
 * (`src/components/Chatbot.tsx`): ocupa desde `ancho - 80` hasta `ancho - 24`.
 * Sin reservarle sitio, se sienta ENCIMA del botón de comprar en el teléfono —
 * que es el §7d, y es exactamente el fallo que ya tapó «No cuadra» en el panel
 * de Cobros. Por eso la fila termina 72 px antes del borde hasta `2xl`, que es
 * el primer ancho en el que el contenedor del sitio ya deja ese hueco solo.
 * También lo mide el auditor, con la barra pegada, que es cuando coinciden.
 */
export function BarraDeCompra({
  nombre,
  precioCents,
  agregado,
  onAgregar,
}: {
  /** Para el nombre accesible del botón: hay otro igual más arriba. */
  readonly nombre: string;
  readonly precioCents: number;
  readonly agregado: boolean;
  readonly onAgregar: () => void;
}) {
  return (
    <div
      // Lo lee el auditor para saber cuál es la barra sin adivinar por clases.
      data-barra-de-compra=""
      className="border-line bg-surface sticky bottom-0 z-40 border-t"
    >
      <div className="container-normal">
        <div className="flex items-center gap-3 py-3 pe-18 2xl:pe-0">
          {/* El precio viaja con el botón: quien baja a leer los acordeones
              deja de ver el de arriba, y decidir sin el precio delante es
              justo lo que esta barra viene a evitar. */}
          <p translate="no" className="text-accent-strong shrink-0 text-lg leading-none font-bold">
            {precioLegible(precioCents)}
          </p>
          <button
            type="button"
            onClick={onAgregar}
            // El nombre accesible EMPIEZA por el texto visible (WCAG 2.5.3) y
            // sigue con el producto, porque en esta página hay DOS botones de
            // agregar —éste y el de la columna— y «botón, Agregar al carrito»
            // dos veces no distingue cuál es cuál.
            aria-label={`Agregar al carrito: ${nombre}`}
            className={buttonVariants({
              variant: 'accent',
              className: 'ms-auto shrink-0 whitespace-nowrap',
            })}
          >
            {agregado ? 'Agregado ✓' : 'Agregar al carrito'}
          </button>
        </div>
      </div>
    </div>
  );
}
