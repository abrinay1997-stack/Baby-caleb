import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { buttonVariants } from '../components/ui/Button';
import { useCatalogo } from '../hooks/useCatalogo';
import { jsonLdProducto, metaDeProducto, rangoDePeso } from '../seo/producto';
import { getContentData } from '../data/content';
import { useCarrito } from '../carrito/useCarrito';
import { CompartirProducto } from '../components/CompartirProducto'
import { PedirPorWhatsapp } from '../components/PedirPorWhatsapp'
import { fotosDeVariante } from '../components/FotoDeProducto'
import { GaleriaDeProducto } from '../components/GaleriaDeProducto'
import { PrecioDeLaFicha } from '../components/PrecioDeLaFicha'
import { BarraDeCompra } from '../components/BarraDeCompra'
import { AcordeonesDeFicha, seccionesDeLaFicha } from '../components/AcordeonesDeFicha'
import { productosDeLaTiendaDelSistema } from '../hooks/useCatalogo'

/** Cuánto se queda el «Agregado» antes de volver a su texto normal. */
const AVISO_MS = 2000;

/**
 * La ficha de una variante: `/productos/<slug>` (F3.7).
 *
 * Todo lo que se ve —nombre, talla, peso, unidades, precio, si hay o no hay—
 * sale del catálogo del sistema, la foto incluida desde hoy: la que la dueña
 * sube en su panel manda, y la de `content.json` queda como respaldo para los
 * artículos que todavía no tienen foto subida (hoy, todos) y para cuando la
 * del sistema no cargue. Quién gana lo decide `fotoDeVariante`, en un sitio.
 *
 * No hay diseño nuevo: usa `Section` y los botones que ya existen. Una ficha
 * de producto que se vea distinta al resto del sitio no es una mejora, es una
 * página que parece de otra tienda.
 *
 * ## Cómo está ordenada, y por qué
 *
 * El dueño pidió tres cosas para esta pantalla y las tres viven en un sitio
 * cada una, no repartidas por el JSX:
 *
 *  1. **El precio arriba, grande, pegado a la foto** — `PrecioDeLaFicha`. Era
 *     la cuarta fila de un `<dl>`, a 807 px del inicio en un teléfono de
 *     844 px de alto: el último centímetro de la pantalla, y eso sin contar la
 *     barra del navegador. Ahora encabeza la columna de datos, que en el
 *     teléfono es lo que va justo debajo de la foto.
 *  2. **El botón de comprar, del color más llamativo y fijo abajo** —
 *     `BarraDeCompra`, pegada con `sticky` para que reserve su propio hueco.
 *  3. **La descripción larga, abajo y en acordeones** — `AcordeonesDeFicha`,
 *     con `<details>` de verdad.
 *
 * Las otras dos que pidió —un precio tachado con su porcentaje y las cuotas—
 * **no están, y no es un olvido**: no hay dato que las respalde. El porqué
 * largo está en `PrecioDeLaFicha.tsx`, y que no se cuelen inventadas lo
 * vigila `test/sin-rebajas-inventadas.test.ts`.
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

  // Las del sistema si las hay; si no, las de `content.json`, que se siguen
  // buscando por el código de la variante. Todas salen de aquí y el relevo
  // —si la del sistema no carga— lo pone `FotoDeProducto`.
  const fotos = fotosDeVariante(
    variante,
    getContentData()
      .products.flatMap((p) =>
        p.variants.map((v) => ({ codigo: v.codigo, image: v.image, images: v.images })),
      )
      .find((v) => v.codigo === variante?.codigo),
  );

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

  // Agregar al carrito se hace desde DOS sitios —la columna y la barra de
  // abajo— y el aviso de «Agregado» es uno solo. La acción vive aquí para que
  // los dos botones hagan exactamente lo mismo; escrita dos veces, un día uno
  // de ellos se olvidaría de avisar.
  const agregarAlCarrito = () => {
    agregar(variante.codigo);
    setAgregado(true);
  };

  // La ficha de `content.json` a la que pertenece esta presentación, buscada
  // por el CÓDIGO y no por el `id`: nadie garantiza que el `id` del archivo
  // coincida con el slug del sistema. Es de donde sale la descripción cuando
  // el sistema no la manda — la misma regla que la foto.
  const delArchivo = getContentData().products.find((p) =>
    p.variants.some((v) => v.codigo === variante.codigo),
  );

  const secciones = seccionesDeLaFicha(
    variante,
    productosDeLaTiendaDelSistema(),
    delArchivo?.description,
  );

  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-dvh flex flex-col">
      <Seo
        ruta={`/productos/${variante.slug}`}
        meta={metaDeProducto(variante)}
        jsonLd={jsonLdProducto(
          variante,
          url,
          // Absolutas y contra el origen de ESTA página, no contra un dominio
          // escrito a mano: en producción es babycaleb.com y en una vista
          // previa es la del despliegue, y las dos tienen que servir la foto.
          fotos.map((f) => new URL(f.src, window.location.origin).href),
        )}
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
          {/* La caja, el `aspect-[4/3]` y el porqué del CLS se mudaron a
              `GaleriaDeProducto`: ahí viven ahora la foto grande y las
              miniaturas, que son una sola pieza. Con una sola foto se ve igual
              que ayer — la galería no pinta miniaturas. */}
          <GaleriaDeProducto fotos={fotos} nombre={variante.nombre} />

          <div className="flex flex-col gap-6">
            {/* PRIMERO el precio, y no por capricho de orden: en el teléfono
                esta columna va DEBAJO de la foto, así que encabezarla es la
                única forma de quedar «pegado a la foto». El nombre va justo
                después — a esa altura la foto ya dice qué es. */}
            <PrecioDeLaFicha
              precioCents={variante.precioCents}
              disponibilidad={variante.disponibilidad}
            />

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
            </dl>

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
                  onClick={agregarAlCarrito}
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

        {/* El texto largo, abajo del todo y plegado: lo que decide la compra es
            la foto, el precio y el botón, y una parrafada en medio los empuja
            fuera de la pantalla. Sin descripción no sale nada — no hay bloque
            vacío que abrir. */}
        <AcordeonesDeFicha secciones={secciones} />
      </Section>

      {/* Agotado no lleva barra: no hay nada que comprar, y un botón que no se
          puede usar pegado abajo todo el rato es ruido. La columna de arriba
          ya dice qué pasa y ofrece que avisemos por WhatsApp. */}
      {agotado ? null : (
        <BarraDeCompra
          nombre={variante.nombre}
          precioCents={variante.precioCents}
          agregado={agregado}
          onAgregar={agregarAlCarrito}
        />
      )}
    </main>
  );
}
