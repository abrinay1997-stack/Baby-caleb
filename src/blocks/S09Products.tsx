import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';
import { buttonVariants } from '../components/ui/Button';
import { Link } from 'react-router-dom';
import { useCatalogoConEstado, desdeDe } from '../hooks/useCatalogo';
import { FilaPresentacion } from '../carrito/FilaPresentacion';
import { whatsappCon } from '../data/contacto';

export default function S09Products() {
  const { catalogo, cargando, copiaVieja } = useCatalogoConEstado();
  // Lo descatalogado no se pinta: vender lo que no existe acaba en un pedido
  // que nadie puede cumplir, y en un bot diciéndole a la clienta lo contrario
  // que la web.
  const data = getContentData().products.filter((p) => p.descatalogado !== true);

  const containerRef = useGsapContext(() => {
    gsap.from('.product-card', {
      y: 40,
      duration: 0.8,
      stagger: 0.15,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      },
    });
  });

  return (
    <Section id="productos" ref={containerRef} variant="bg">
      <SectionHeader
        kicker="01 / Catálogo"
        title="Esenciales diseñados para proteger su piel."
      />

      {/*
        Cuando el sistema no contesta, la web sigue en pie con una copia de los
        precios del día del despliegue, y hasta hoy no lo decía en ninguna
        parte: el `fetch` contesta 200 igual, así que el navegador tomaba la
        copia por el catálogo de verdad. Lo que se enseñaba era todo «agotado»,
        con precios viejos y sin botón de pedir — una tienda muerta con cara de
        tienda sana.

        Enseñar un precio viejo en silencio es peor que no enseñar ninguno:
        quien lo lee se lo cree y escribe pidiéndolo. Así que se dice, y se
        dice en términos de lo que le importa a quien está comprando —si puede
        fiarse del precio— y no del fallo técnico que lo causó.
      */}
      {copiaVieja ? (
        <p
          role="status"
          className="mb-8 rounded-2xl border border-line bg-surface px-5 py-4 text-sm text-muted"
        >
          <strong className="font-semibold text-fg">Estamos actualizando el catálogo.</strong>{' '}
          Los precios y la disponibilidad que ve aquí pueden no estar al día. Antes de
          hacer su pedido, confírmelos con nosotras por WhatsApp.
        </p>
      ) : null}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        {data.map((product, idx) => {
          // La ficha de la primera presentación: es donde viven la foto
          // grande, el rango de peso y los datos estructurados que lee Google.
          // Sin este enlace esas páginas existían y no se llegaba a ninguna.
          const primera = product.variants[0]?.codigo;
          const slug = primera === undefined ? undefined : catalogo.get(primera)?.slug;
          return (
            <div
              key={idx}
              className="product-card group flex flex-col h-full bg-surface rounded-2xl overflow-hidden shadow-soft border border-line hover:shadow-[0_20px_60px_-25px_rgba(27,50,70,0.25)] hover:-translate-y-1 transition-all duration-300"
            >
              <div className="aspect-[4/3] bg-sage/15 relative overflow-hidden flex items-center justify-center">
                <img
                  src={product.image}
                  alt={product.name}
                  className="w-full h-full object-contain p-4 group-hover:scale-[1.03] transition-transform duration-500"
                  loading="lazy"
                  decoding="async"
                />
                <span className="absolute top-4 left-4 bg-bg/90 backdrop-blur text-fg font-bold text-xs px-3 py-1.5 rounded-pill border border-line">
                  {desdeDe(catalogo, product.variants.map((v) => v.codigo))}
                </span>
              </div>
              <div className="p-8 flex flex-col flex-grow">
                {/* Nombre de producto: no se traduce (ver FichaProducto). */}
                <h3 translate="no" className="text-2xl text-fg mb-3 leading-tight">
                  {slug === undefined ? (
                    product.name
                  ) : (
                    <Link
                      to={`/productos/${slug}`}
                      className="hover:text-accent-strong focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4 rounded-sm transition-colors"
                    >
                      {product.name}
                    </Link>
                  )}
                </h3>
                <p className="text-muted text-sm mb-6 leading-relaxed">
                  {product.description}
                </p>

                <div className="mb-6">
                  <span className="block mono text-xs text-muted mb-3">
                    Presentaciones · toca una para agregarla
                  </span>
                  <div className="space-y-2">
                    {product.variants.map((v, vIdx) => (
                      <FilaPresentacion
                        key={vIdx}
                        codigo={v.codigo}
                        talla={v.size}
                        unidades={v.units}
                        variante={v.codigo === undefined ? undefined : catalogo.get(v.codigo)}
                        cargando={cargando}
                      />
                    ))}
                  </div>
                </div>

                <a
                  href={whatsappCon(`Hola Baby Caleb, me interesa: ${product.name}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  // El nombre accesible EMPIEZA por el texto visible. Decía
                  // «Pedir <producto> por WhatsApp», y entonces «Pedir por
                  // WhatsApp» —lo que se lee en la pantalla— no estaba dentro
                  // del nombre: quien dicta por voz «pulsa Pedir por WhatsApp»
                  // no acertaba el botón. Es WCAG 2.5.3, Nivel A, y axe lo
                  // marcaba en las cuatro tarjetas.
                  aria-label={`Pedir por WhatsApp: ${product.name}`}
                  className={buttonVariants({ variant: 'outline', className: 'w-full mt-auto' })}
                >
                  Pedir por WhatsApp
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
