import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { buttonVariants } from '../components/ui/Button';
import { useCatalogo } from '../hooks/useCatalogo';
import {
  jsonLdProducto,
  metaDeProducto,
  precioLegible,
  rangoDePeso,
} from '../seo/producto';
import { getContentData } from '../data/content';
import { useCarrito } from '../carrito/useCarrito';
import { CompartirProducto } from '../components/CompartirProducto'
import { PedirPorWhatsapp } from '../components/PedirPorWhatsapp'

/** Cuánto se queda el «Agregado» antes de volver a su texto normal. */
const AVISO_MS = 2000;

/**
 * La ficha de una variante: `/productos/<slug>` (F3.7).
 *
 * Todo lo que se ve —nombre, talla, peso, unidades, precio, si hay o no hay—
 * sale del catálogo del sistema. Lo único que viene de `content.json` es la
 * foto, que es lo que `content.json` sigue siendo dueño de decir.
 *
 * No hay diseño nuevo: usa `Section` y los botones que ya existen. Una ficha
 * de producto que se vea distinta al resto del sitio no es una mejora, es una
 * página que parece de otra tienda.
 */
export default function FichaProducto() {
  const { slug } = useParams<{ slug: string }>();
  const catalogo = useCatalogo();
  const { agregar } = useCarrito();

  // Los hooks van ANTES del `return` temprano de más abajo: React exige que se
  // llamen siempre y en el mismo orden, y una ficha sin variante sale por ahí.
  const [agregado, setAgregado] = useState(false);

  // El aviso se borra solo. El `clearTimeout` no es adorno: sin él, agregar y
  // salir de la página deja un temporizador tocando un componente desmontado.
  useEffect(() => {
    if (!agregado) return;
    const t = window.setTimeout(() => setAgregado(false), AVISO_MS);
    return () => window.clearTimeout(t);
  }, [agregado]);

  // Cambiar de producto limpia el aviso: si no, la ficha siguiente abre
  // diciendo «Agregado» de algo que no es lo que se está mirando.
  useEffect(() => {
    setAgregado(false);
  }, [slug]);

  const variante = slug === undefined ? undefined : [...catalogo.values()].find((v) => v.slug === slug);

  // La foto sigue en content.json: se busca por el código de la variante.
  const foto = getContentData()
    .products.flatMap((p) => p.variants.map((v) => ({ codigo: v.codigo, image: v.image })))
    .find((v) => v.codigo === variante?.codigo)?.image;

  if (variante === undefined) {
    // El catálogo puede estar cargando todavía, o el slug puede no existir. En
    // los dos casos lo honesto es lo mismo: no enseñar una ficha a medias ni
    // inventar un producto. El Worker ya marcó la página noindex si el slug no
    // está, así que esto no deja basura en Google.
    return (
      <main id="main-content" className="pt-32 md:pt-24 min-h-dvh flex flex-col">
        <Section variant="bg">
          <h1 className="text-3xl text-fg mb-4">No encontramos ese producto</h1>
          <p className="text-muted mb-8 max-w-prose">
            Puede que ya no esté en el catálogo o que el enlace esté incompleto. En el
            catálogo completo está todo lo que tenemos hoy.
          </p>
          <Link to="/productos" className={buttonVariants({ variant: 'outline' })}>
            Ver el catálogo
          </Link>
        </Section>
      </main>
    );
  }

  const peso = rangoDePeso(variante);
  const agotado = variante.disponibilidad === 'agotado';
  const url = `${window.location.origin}/productos/${variante.slug}`;

  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-dvh flex flex-col">
      <Seo
        ruta={`/productos/${variante.slug}`}
        meta={metaDeProducto(variante)}
        jsonLd={jsonLdProducto(variante, url)}
      />

      <Section variant="bg">
        <nav aria-label="Migas de pan" className="mb-8 text-sm text-muted">
          <Link to="/productos" className="underline hover:text-fg">
            Catálogo
          </Link>
          <span aria-hidden="true"> · </span>
          <span translate="no">{variante.nombre}</span>
        </nav>

        <div className="grid md:grid-cols-2 gap-8 md:gap-12 items-start">
          {foto !== undefined && (
            // `aspect-[4/3]`: la MISMA caja que usan las tarjetas del catálogo
            // en `S09Products`, y por la misma razón — reserva el sitio antes
            // de que la foto llegue.
            //
            // Sin ella, en un teléfono (una sola columna: foto arriba, datos
            // debajo) la columna de la derecha saltaba 223 px hacia abajo en
            // cuanto cargaba la imagen. Medido con la red a 400 kbps: CLS de
            // 0.194 en la ficha, que es la pantalla donde se decide la compra
            // — el precio y el botón se mueven justo cuando el pulgar va a
            // tocarlos. El umbral de «bien» es 0.1.
            //
            // `object-contain` ya estaba y se queda: las cajas no tienen todas
            // la misma proporción y recortarlas para cuadrarlas sería enseñar
            // media caja.
            <div className="bg-sage/15 border border-line rounded-lg overflow-hidden flex aspect-[4/3] items-center justify-center">
              <img
                src={foto}
                alt={`Caja de ${variante.nombre}`}
                className="w-full h-full object-contain p-6"
                // Es la imagen más grande de la pantalla y la que decide cuándo
                // se ve «cargada»: se pide antes que el resto.
                loading="eager"
                fetchPriority="high"
                decoding="async"
              />
            </div>
          )}

          <div className="flex flex-col gap-6">
            {/* Sin traducir: los nombres llevan marca y término técnico
                —«Nateen», «Dany Baby», «pants»— y «pants» traducido a
                «pantalones» describiría otra cosa. */}
            <h1 translate="no" className="text-3xl md:text-4xl text-fg leading-tight">
              {variante.nombre}
            </h1>

            <dl className="flex flex-col gap-2 text-sm">
              {variante.talla !== null && (
                <div className="flex gap-2">
                  <dt className="text-muted min-w-28">Talla</dt>
                  <dd className="text-fg font-bold">{variante.talla}</dd>
                </div>
              )}
              {peso !== null && (
                <div className="flex gap-2">
                  <dt className="text-muted min-w-28">Peso del bebé</dt>
                  <dd className="text-fg font-bold">{peso}</dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="text-muted min-w-28">Por caja</dt>
                <dd className="text-fg font-bold">{variante.unidadesPorCaja} unidades</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted min-w-28">Precio</dt>
                <dd className="text-accent-strong font-bold text-lg">
                  {precioLegible(variante.precioCents)}
                </dd>
              </div>
            </dl>

            {/* Se dice si hay o no hay. NUNCA cuántas quedan: eso es del
                negocio, y el sistema tampoco lo manda hasta aquí. */}
            <p className={agotado ? 'text-muted text-sm' : 'text-sm text-fg'}>
              {agotado
                ? 'Ahora mismo está agotado. Escríbenos y te avisamos cuando entre.'
                : variante.disponibilidad === 'pocas'
                  ? 'Quedan pocas cajas.'
                  : 'Disponible para entrega.'}
            </p>

            <div className="flex flex-col gap-3 sm:flex-row">
              {/* Sale o no sale según lo que diga el panel: el ajuste
                  «Dejar pedir por WhatsApp» más lo que tenga decidido ESTE
                  artículo en su ficha. La decisión llega resuelta del sistema y
                  el número también; aquí no se combina nada ni se escribe
                  ningún celular a mano. */}
              <PedirPorWhatsapp variante={variante} agotado={agotado} />

              {/* Agotado no se agrega: el carrito acabaría pidiendo algo que no
                  hay, y quien lo descubre es la clienta al final. */}
              {agotado ? null : (
                <button
                  type="button"
                  onClick={() => {
                    agregar(variante.codigo);
                    setAgregado(true);
                  }}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {agregado ? 'Agregado ✓' : 'Agregar al carrito'}
                </button>
              )}
            </div>

            {/* Se dice en texto además del botón: el número de la barra puede
                quedar fuera de la vista si la página está desplazada. */}
            <p aria-live="polite" className="text-muted min-h-5 text-xs">
              {agregado ? 'Lo agregamos a tu carrito.' : ''}
            </p>

            <CompartirProducto slug={slug} nombre={variante.nombre} />

            <p className="text-muted text-xs">
              El delivery va aparte del precio del producto y se cotiza por zona.
            </p>
          </div>
        </div>
      </Section>
    </main>
  );
}
