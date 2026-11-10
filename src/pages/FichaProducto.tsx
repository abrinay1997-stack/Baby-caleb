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

const WHATSAPP_BASE = 'https://wa.me/50767575065?text=';

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
      <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
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
  const mensaje = encodeURIComponent(
    `Hola Baby Caleb, quiero pedir: ${variante.nombre} (${precioLegible(variante.precioCents)})`
  );

  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
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
          <span>{variante.nombre}</span>
        </nav>

        <div className="grid md:grid-cols-2 gap-8 md:gap-12 items-start">
          {foto !== undefined && (
            <div className="bg-sage/15 border border-line rounded-lg overflow-hidden flex items-center justify-center">
              <img
                src={foto}
                alt={variante.nombre}
                className="w-full h-full object-contain p-6"
                loading="eager"
                decoding="async"
              />
            </div>
          )}

          <div className="flex flex-col gap-6">
            <h1 className="text-3xl md:text-4xl text-fg leading-tight">{variante.nombre}</h1>

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

            <a
              href={`${WHATSAPP_BASE}${mensaje}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Pedir ${variante.nombre} por WhatsApp`}
              className={buttonVariants({ variant: agotado ? 'outline' : 'accent' })}
            >
              {agotado ? 'Avísenme cuando entre' : 'Pedir por WhatsApp'}
            </a>

            <p className="text-muted text-xs">
              El delivery va aparte del precio del producto y se cotiza por zona.
            </p>
          </div>
        </div>
      </Section>
    </main>
  );
}
