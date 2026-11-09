import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';
import { buttonVariants } from '../components/ui/Button';

const WHATSAPP_BASE = 'https://wa.me/50767575065?text=';

export default function S09Products() {
  const data = getContentData().products;

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

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        {data.map((product, idx) => {
          const message = encodeURIComponent(`Hola Baby Caleb, me interesa: ${product.name}`);
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
                  {product.priceFrom != null ? `Desde $${product.priceFrom}` : 'Consultar'}
                </span>
              </div>
              <div className="p-8 flex flex-col flex-grow">
                <h3 className="text-2xl text-fg mb-3 leading-tight">{product.name}</h3>
                <p className="text-muted text-sm mb-6 leading-relaxed">
                  {product.description}
                </p>

                <div className="mb-6">
                  <span className="block mono text-xs text-muted mb-3">Presentaciones</span>
                  <div className="space-y-2">
                    {product.variants.map((v, vIdx) => (
                      <div
                        key={vIdx}
                        className="flex items-center justify-between bg-bg border border-line rounded-lg px-3 py-2 text-xs"
                      >
                        <div>
                          <span className="font-bold text-fg">{v.size}</span>
                          <span className="text-muted"> · {v.units}</span>
                        </div>
                        <span className="font-bold text-accent-strong">{v.price != null ? `$${v.price}` : 'Consultar'}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <a
                  href={`${WHATSAPP_BASE}${message}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Pedir ${product.name} por WhatsApp`}
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
