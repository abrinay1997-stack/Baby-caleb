import { Link } from 'react-router-dom';

import { FotoDeProducto, type Foto } from '../components/FotoDeProducto';
import { FilaPresentacion } from '../carrito/FilaPresentacion';
import { PedirPorWhatsapp } from '../components/PedirPorWhatsapp';
import { dolares, type Disponibilidad, type VariantePublica } from '../hooks/useCatalogo';
import type { ArticuloDeLaTienda } from '../tienda/articulos';
import { comoSeLeeLaCategoria } from './FiltrosDelCatalogo';

/**
 * UN artículo: una talla de una marca, con su precio y su botón.
 *
 * Antes la tienda tenía una tarjeta por PRODUCTO con sus tallas dentro. Para
 * comparar la M de Nateen con la M de Velvee había que abrir dos tarjetas y
 * acordarse de un precio; con quince dólares de diferencia entre las dos, eso
 * es dejar la venta en la mesa. El dueño lo pidió tres veces: «todo debería
 * estar separado, no en grupos».
 *
 * ## El orden de la tarjeta, y por qué este
 *
 * «Aún no me gusta el catálogo, no se ve profesional ni parece de Shopify».
 * Mirando la rejilla a 1440 px se veía por qué, y no era el color:
 *
 *  · **Cuatro tarjetas seguidas con el mismo titular.** «Pañales Nateen»,
 *    «Pañales Nateen», «Pañales Nateen», «Pañales Nateen». Lo único que las
 *    distingue —la talla— era una pastilla pequeña encima de la foto, o sea
 *    que el texto MÁS GRANDE de cada tarjeta era el que no decía nada y el
 *    dato que la clienta viene a buscar iba en lo más pequeño. Ahora la talla
 *    va dentro del titular: cuatro titulares distintos, que es lo que hace
 *    que una rejilla se pueda barrer con la vista.
 *  · **Cinco cosas pidiendo atención a la vez**: dos pastillas sobre la foto
 *    (talla y disponibilidad), marca·categoría, nombre, unidades, precio y la
 *    fila de agregar — que repetía la talla, las unidades Y el precio. Se
 *    quedan: una pastilla (y solo cuando hay algo que decir), el rótulo, el
 *    titular con su talla, el precio y la acción.
 *  · **«Disponible» en casi todas las tarjetas.** Una etiqueta que sale
 *    siempre no informa de nada: es el estado normal. Una tienda avisa de lo
 *    que es noticia —que se está acabando, o que se acabó—, y por eso esa
 *    pastilla ahora solo aparece en esos dos casos. Quien no ve la pantalla
 *    no se queda sin el dato: la fila de agregar lo dice con palabras.
 *
 * ## La foto
 *
 * Las fotos vienen con SU PROPIO fondo quemado dentro del archivo, y distinto
 * en cada una: verde liso en las cajas, un degradado con letras en las de
 * pants, y las toallitas Dany Baby ni siquiera tienen foto —llevan el logo—.
 * Puestas sobre un fondo verde claro se veía un rectángulo de color dentro de
 * otro rectángulo de color, uno distinto por tarjeta, y de ahí salía la
 * sensación de rejilla desigual. El plato ahora es neutro y el mismo en las
 * doce, que es lo más cerca de «todas de la misma sesión» que se puede llegar
 * sin volver a fotografiar el catálogo.
 */

/**
 * Cómo se dice cada estado, y de qué color.
 *
 * `disponible` no lleva pastilla a propósito: ver más abajo.
 */
const DISPONIBILIDAD: Readonly<
  Record<Disponibilidad, { titulo: string; clase: string } | null>
> = {
  disponible: null,
  pocas: { titulo: 'Últimas unidades', clase: 'bg-accent text-accent-fg' },
  // Navy lleno y no crema: la etiqueta se dibuja ENCIMA de la foto, y una
  // pastilla color `surface` sobre una foto clara no tiene forma. Además
  // separa los dos avisos de un vistazo — el naranja empuja («corra»), el
  // navy cierra («hoy no»). El par está medido en 12.21 (brand.json).
  agotado: { titulo: 'Agotado', clase: 'bg-fg text-bg' },
};

export function TarjetaDeArticulo({
  articulo,
  variante,
  foto,
  cargando,
}: {
  articulo: ArticuloDeLaTienda;
  variante: VariantePublica | undefined;
  foto: Foto | undefined;
  cargando: boolean;
}) {
  const agotado = articulo.disponibilidad === 'agotado';
  const aviso = DISPONIBILIDAD[articulo.disponibilidad] ?? null;

  /*
   * LO AGOTADO YA NO SE APAGA CON `opacity`.
   *
   * La tarjeta llevaba `opacity-75` entera. Medido con el navegador sobre la
   * rejilla de verdad: el rótulo de la marca caía a 3.01:1, la talla del
   * titular a 3.01 y «Avísenme cuando entre» a 2.98, contra el mínimo de 4.5
   * de AA. La `opacity` la aplica el ancestro al pintar, así que baja el
   * contraste de TODO lo que lleva dentro aunque cada color por separado esté
   * bien — y justo en la tarjeta que más hay que leer, porque es la que pide
   * que avisen cuando entre.
   *
   * Es el mismo fallo que ya se arregló en `FilaPresentacion` (hay una prueba
   * que lo vigila allí). Lo que apaga una tarjeta agotada ahora es la FOTO en
   * gris, que no lleva información, más la etiqueta «Agotado» y la palabra
   * «Agotado» en la fila: dos de ellas con letras, así que tampoco se está
   * comunicando solo con el color (WCAG 1.4.1).
   */
  return (
    <li className="product-card group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft transition-all duration-300 hover:-translate-y-1 hover:border-accent-edge hover:shadow-[0_20px_60px_-25px_rgba(27,50,70,0.25)]">
      {/*
        El plato de la foto: neutro, el mismo en las doce, y sin relleno.

        Era verde claro (`bg-sage/15`) con 16 px de relleno alrededor. Las
        fotos traen su propio fondo quemado dentro del archivo, así que lo que
        se veía era un rectángulo de color flotando dentro de otro rectángulo
        de color, con un margen de aire entre los dos — y como cada foto tiene
        su proporción, ese margen era distinto en cada tarjeta. De ahí salía
        la rejilla desigual.

        Sin relleno, la foto llega al borde: las proporciones que coinciden con
        el plato lo llenan de lado a lado y las que no dejan dos franjas
        SIMÉTRICAS del mismo crema en todas. Cuadrado y no 4:3 porque es lo que
        mejor le sienta a lo que hay: de las doce fotos de hoy, nueve son
        cuadradas o verticales.

        `object-contain` y no `cover`: recortar llenaría el plato perfecto,
        pero con fotos de 0.83 a 1.41 de proporción habría que cortarle a
        alguna un 30 % — y nadie sabe qué proporción traerá la que la dueña
        suba mañana desde el panel. Un producto cortado por la mitad es peor
        que dos franjas de crema.
      */}
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-bg">
        {/*
          Sin foto, el plato NO se queda en blanco.

          Pasa de verdad hoy: la caja de 1 200 toallitas de Dany Baby no tiene
          foto subida en el sistema y tampoco ficha en `content.json` de donde
          sacar una de respaldo, así que su tarjeta salía con un hueco crema del
          tamaño de la foto — y un hueco en medio de una rejilla se lee como
          una página a medio cargar, no como «este producto todavía no tiene
          foto». Con la marca del sitio dentro, la tarjeta conserva su forma y
          la rejilla su ritmo.

          `aria-hidden`: el nombre, la talla y el precio ya están al lado en
          texto; quien escucha no gana nada con un «sin foto».

          El arreglo de verdad es que la dueña suba la foto desde su panel —
          esto es lo que se enseña mientras tanto, no un sustituto.
        */}
        {foto === undefined ? (
          <span
            aria-hidden="true"
            className="mono px-4 text-center text-xs leading-relaxed text-sage-strong"
          >
            Baby Caleb
          </span>
        ) : (
          <FotoDeProducto
            foto={foto}
            /*
              `alt` vacío a propósito: la foto no añade nada que el texto de
              al lado no diga ya, y un lector de pantalla que lea «Pañal Nateen
              talla M caja de 144» dos veces seguidas estorba. Si algún día la
              foto enseñara algo que el texto no dice, aquí va su descripción.
            */
            alt=""
            className={`h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.04] ${
              agotado ? 'grayscale' : ''
            }`}
            loading="lazy"
          />
        )}
        {/*
          UNA pastilla, y solo cuando hay algo que decir.

          Eran dos —la talla y la disponibilidad—, una en cada esquina, encima
          de la foto. La de la talla sobra desde que la talla está en el
          titular, y la de disponibilidad decía «Disponible» en casi todas: una
          etiqueta que sale siempre no es un aviso, es ruido. Queda la que de
          verdad cambia una decisión: «Últimas unidades» y «Agotado».

          Va rellena y sin borde para que se lea como una etiqueta de tienda y
          no como un recuadro más. El naranja de marca es relleno, nunca texto
          (ver `themes/babycaleb.css`), y encima va el navy: ese par está
          medido en 5.56.
        */}
        {aviso === null ? null : (
          <span
            className={`absolute left-3 top-3 rounded-pill px-3 py-1.5 text-xs font-bold shadow-soft ${aviso.clase}`}
          >
            {aviso.titulo}
          </span>
        )}
      </div>

      <div className="flex flex-grow flex-col gap-1 p-3 sm:p-5">
        {/*
          El rótulo dice la MARCA, y ya no «marca · categoría».

          Dos motivos, y el segundo es el de peso. Uno: en una tarjeta de 169
          px —dos columnas en un teléfono— «NATEEN · PAÑALES» con la
          interlínea de `.mono` no cabe en un renglón, y partido en dos deja
          cuatro líneas de texto antes del precio. Dos: la categoría ya está
          en el nombre del producto, que va justo debajo —«Pañales Nateen»,
          «Pañales Nateen Pants», «Wipes de agua Dany Baby»—, así que era la
          misma palabra dos veces seguidas en letra distinta.

          Sin marca puesta se queda la categoría, que es lo que había: más
          vale un rótulo con la familia que una tarjeta que empieza en blanco.
        */}
        <p className="mono m-0 text-xs text-muted">
          {articulo.marca === null ? comoSeLeeLaCategoria(articulo.familia) : articulo.marca}
        </p>

        {/*
          El titular LLEVA LA TALLA, y ése es el arreglo.

          Nombre de producto: no se traduce (la marca es la marca). Y ya no
          hace falta el `sr-only` que antes metía la talla solo para el lector
          de pantalla: ahora la talla se ve y se oye, que era el punto.
        */}
        <h3 translate="no" className="m-0 text-base leading-snug text-fg sm:text-lg">
          <Link
            to={`/productos/${articulo.slug}`}
            className="rounded-sm transition-colors hover:text-accent-strong focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            {articulo.producto}
            {articulo.talla === null ? null : (
              <span className="text-muted"> · Talla {articulo.talla}</span>
            )}
          </Link>
        </h3>

        {/*
          El precio, pegado al titular y con sitio por delante.

          Las unidades se fueron de aquí: la fila de agregar ya dice «M · 144
          uds», así que esta línea era la misma frase escrita dos veces en la
          misma tarjeta. `mt-auto` empuja el precio y la acción al pie, y eso
          es lo que alinea los precios de una fila entre sí aunque los
          titulares ocupen una o dos líneas — la rejilla deja de verse
          descuadrada sin tocar el alto de nada.
        */}
        <p className="m-0 mt-auto pt-3 text-2xl font-bold tabular-nums leading-none text-fg">
          {dolares(articulo.precioCents)}
        </p>

        {/*
          `grid` y no `space-y`: el botón de WhatsApp es un `inline-flex` que
          le llega de `buttonVariants`, así que suelto se encoge al ancho de
          su texto y queda flotando a la izquierda de la tarjeta. Como hijo de
          una rejilla se estira solo a la columna, sin tener que pasarle
          clases desde fuera a un componente que las comparte con la ficha.
        */}
        <div className="mt-3 grid gap-2">
          <FilaPresentacion
            codigo={articulo.codigo}
            talla={articulo.talla ?? 'Única'}
            unidades={articulo.unidades ?? ''}
            variante={variante}
            cargando={cargando}
          />
          {/*
            El botón de WhatsApp de ESTA talla, no uno genérico del producto.

            La rejilla vieja tenía uno por tarjeta que escribía «me interesa:
            Pañales Nateen» y no respetaba el interruptor del panel: la dueña
            podía apagar «pedir por WhatsApp» en una variante y el botón salía
            igual. `PedirPorWhatsapp` sí lo respeta —se esconde solo si está
            apagado o si no hay celular puesto— y ahora que cada tarjeta es una
            variante, encaja donde no encajaba antes.
          */}
          {variante === undefined ? null : (
            <PedirPorWhatsapp variante={variante} agotado={agotado} />
          )}
        </div>
      </div>
    </li>
  );
}
