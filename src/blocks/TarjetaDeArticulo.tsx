import { Link } from 'react-router-dom';

import { FotoDeProducto, type Foto } from '../components/FotoDeProducto';
import { FilaPresentacion } from '../carrito/FilaPresentacion';
import { PedirPorWhatsapp } from '../components/PedirPorWhatsapp';
import { dolares, type VariantePublica } from '../hooks/useCatalogo';
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
 * Lo que la clienta tiene que poder hacer de un vistazo es comparar, así que
 * el orden de la tarjeta es: la foto, la marca, la talla, el precio, y el
 * botón. El nombre largo del producto va debajo y en pequeño — es lo que menos
 * decide y lo que más ocupa.
 */

/** Cómo se dice cada estado, y de qué color. */
const DISPONIBILIDAD: Readonly<
  Record<string, { titulo: string; clase: string }>
> = {
  disponible: { titulo: 'Disponible', clase: 'text-sage-strong' },
  pocas: { titulo: 'Últimas unidades', clase: 'text-accent-strong' },
  agotado: { titulo: 'Agotado', clase: 'text-muted' },
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
  const estado = DISPONIBILIDAD[articulo.disponibilidad] ?? DISPONIBILIDAD.agotado!;
  const agotado = articulo.disponibilidad === 'agotado';

  return (
    <li
      className={`product-card group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_60px_-25px_rgba(27,50,70,0.25)] ${
        agotado ? 'opacity-75' : ''
      }`}
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-sage/15">
        {foto === undefined ? null : (
          <FotoDeProducto
            foto={foto}
            /*
              `alt` vacío a propósito: la foto no añade nada que el texto de
              al lado no diga ya, y un lector de pantalla que lea «Pañal Nateen
              talla M caja de 144» dos veces seguidas estorba. Si algún día la
              foto enseñara algo que el texto no dice, aquí va su descripción.
            */
            alt=""
            className="h-full w-full object-contain p-4 transition-transform duration-500 group-hover:scale-[1.03]"
            loading="lazy"
          />
        )}
        {/*
          La talla, grande y encima de la foto. Es por lo que la clienta busca
          —su bebé usa una talla, no una marca— y es lo primero que mira al
          barrer la rejilla con la vista.
        */}
        {articulo.talla === null ? null : (
          <span className="absolute left-3 top-3 rounded-pill border border-line bg-bg/90 px-3 py-1.5 text-xs font-bold text-fg backdrop-blur">
            Talla {articulo.talla}
          </span>
        )}
        <span
          className={`absolute right-3 top-3 rounded-pill border border-line bg-bg/90 px-3 py-1.5 text-xs font-bold backdrop-blur ${estado.clase}`}
        >
          {estado.titulo}
        </span>
      </div>

      <div className="flex flex-grow flex-col p-5">
        <p className="mono m-0 mb-1 text-xs text-muted">
          {articulo.marca === null
            ? comoSeLeeLaCategoria(articulo.familia)
            : `${articulo.marca} · ${comoSeLeeLaCategoria(articulo.familia)}`}
        </p>

        {/* Nombre de producto: no se traduce (la marca es la marca). */}
        <h3 translate="no" className="m-0 mb-2 text-lg leading-tight text-fg">
          <Link
            to={`/productos/${articulo.slug}`}
            className="rounded-sm transition-colors hover:text-accent-strong focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            {articulo.producto}
            {articulo.talla === null ? null : (
              /*
                La talla entra en el nombre del enlace aunque ya esté en la
                pastilla de arriba: quien navega saltando de enlace en enlace
                oye solo el nombre, y «Pañales Nateen» cinco veces seguidas no
                le dice a cuál va. Visualmente no se repite.
              */
              <span className="sr-only"> · talla {articulo.talla}</span>
            )}
          </Link>
        </h3>

        <p className="m-0 mb-4 text-sm text-muted">
          {articulo.unidades === null || articulo.unidades === '' ? ' ' : articulo.unidades}
        </p>

        <p className="m-0 mb-4 text-2xl font-bold tabular-nums text-fg">
          {dolares(articulo.precioCents)}
        </p>

        <div className="mt-auto space-y-2">
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
