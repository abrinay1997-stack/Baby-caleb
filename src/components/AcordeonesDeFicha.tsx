import { ChevronDown } from 'lucide-react';
import type { ProductoDelSistema, VariantePublica } from '../hooks/useCatalogo';

/**
 * El texto largo de una ficha, abajo y plegado.
 *
 * El dueño lo pidió así: «la descripción larga, abajo, en acordeones». Abajo
 * porque lo que decide una compra es la foto, el precio y el botón, y una
 * parrafada en medio los empuja fuera de la pantalla; plegado porque quien ya
 * sabe lo que quiere no tiene que pasarla.
 *
 * ## `<details>` y no un acordeón de JavaScript
 *
 * El del bloque de preguntas (`S09`… `S14FAQ.tsx`) está hecho a mano con
 * estado de React, `aria-expanded` y `aria-controls`. Funciona, pero hay que
 * acordarse de las tres cosas. `<details>` las trae de fábrica: abre y cierra
 * sin JavaScript, el lector de pantalla ya sabe qué es, el teclado también, y
 * el buscador del navegador (Ctrl+F) encuentra el texto de dentro y abre el
 * bloque solo. Aquí no hay nada que mantener.
 *
 * Ojo con el `<summary>`: **es un botón aunque parezca texto**, así que cuenta
 * como diana táctil. En el panel se cayó una vez por esto, con 21 px.
 *
 * ## De dónde sale el texto
 *
 * La ficha pinta una VARIANTE (una talla, una caja), y una variante no tiene
 * descripción: la tiene el PRODUCTO al que pertenece. Así que se busca por
 * `productoSlug`, que es la clave con la que el sistema agrupa las
 * presentaciones.
 *
 * Y si el sistema no contestó —o contestó con la copia del build, que se
 * generó antes de que el catálogo llevara productos— manda `content.json`,
 * emparejado por el CÓDIGO de la presentación. Es la misma regla, el mismo
 * orden y el mismo motivo que la foto (`FotoDeProducto.tsx`): el sistema es el
 * dueño del dato y el archivo es el respaldo, no una segunda verdad.
 *
 * **Sin texto no hay acordeón.** Un bloque plegado que al abrirlo está vacío
 * es peor que no tenerlo: promete algo y se come un toque para no dar nada.
 */

/** Un bloque plegable: su rótulo y lo que hay dentro. */
export interface SeccionDeFicha {
  readonly titulo: string;
  readonly texto: string;
}

/** `null`, `undefined` y la cadena en blanco son lo mismo aquí: no hay texto. */
const conTexto = (t: string | null | undefined): string | undefined => {
  const limpio = typeof t === 'string' ? t.trim() : '';
  return limpio === '' ? undefined : limpio;
};

/**
 * Qué bloques lleva esta ficha. Vacío cuando no hay nada que contar.
 *
 * Está fuera del JSX para poder probarlo en Node: lo que hay que vigilar no es
 * cómo se pinta un `<details>`, es que un producto sin descripción no saque
 * uno vacío y que la del sistema le gane a la del archivo.
 */
export function seccionesDeLaFicha(
  variante: Pick<VariantePublica, 'productoSlug'> | undefined,
  delSistema: readonly ProductoDelSistema[],
  deContenido: string | null | undefined,
): SeccionDeFicha[] {
  const slug = variante?.productoSlug;
  const delProducto =
    slug === undefined ? undefined : delSistema.find((p) => p.slug === slug)?.descripcion;

  const descripcion = conTexto(delProducto) ?? conTexto(deContenido);
  return descripcion === undefined ? [] : [{ titulo: 'Descripción', texto: descripcion }];
}

export function AcordeonesDeFicha({ secciones }: { readonly secciones: readonly SeccionDeFicha[] }) {
  if (secciones.length === 0) return null;

  return (
    // `h2` y no `h3`: la ficha tiene un `h1` (el nombre) y nada en medio, y
    // saltarse un nivel le dice a quien navega por encabezados que falta una
    // sección (§7k del contrato de diseño).
    <section aria-labelledby="mas-del-producto" className="mt-12 max-w-3xl md:mt-16">
      <h2 id="mas-del-producto" className="text-fg mb-4 text-2xl">
        Más sobre este producto
      </h2>

      <div className="flex flex-col gap-3">
        {secciones.map((s) => (
          <details key={s.titulo} className="group border-line bg-surface rounded-xl border">
            {/* `list-none` + el marcador de WebKit escondido: el triángulo de
                fábrica se dibuja distinto en cada navegador y aquí la flecha la
                pone el icono. */}
            <summary className="text-fg focus-visible:outline-accent-edge flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
              <span>{s.titulo}</span>
              <ChevronDown
                className="text-muted h-5 w-5 shrink-0 transition-transform duration-300 group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <p className="text-muted px-5 pb-5 text-sm leading-relaxed md:text-base">{s.texto}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
