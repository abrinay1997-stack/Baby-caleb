import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';
import { Button, buttonVariants } from '../components/ui/Button';

export default function S09Products() {
  const data = getContentData().products;
  const whatsappBase = "https://wa.me/50767575065?text=";

  const containerRef = useGsapContext(() => {
    gsap.from('.product-card', {
      y: 40,
      opacity: 0,
      duration: 0.8,
      stagger: 0.15,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      }
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
            <div key={idx} className="product-card group flex flex-col h-full bg-surface rounded-xl overflow-hidden shadow-soft border border-line">
              <div className="aspect-[4/3] bg-bg relative overflow-hidden flex items-center justify-center p-8">
                {/* Stylized placeholder for product images */}
                <div className="w-full h-full border-2 border-dashed border-line rounded-lg flex items-center justify-center text-muted font-display text-sm group-hover:border-sage transition-colors duration-300">
                  [ Imagen de {product.name} ]
                </div>
              </div>
              <div className="p-8 flex flex-col flex-grow">
                <h3 className="text-2xl text-fg mb-3 leading-tight">{product.name}</h3>
                <p className="text-muted text-sm mb-6 flex-grow leading-relaxed">{product.description}</p>
                
                <div className="space-y-4 mb-8">
                  <div>
                    <span className="block mono text-xs text-muted mb-2">Tallas</span>
                    <div className="flex flex-wrap gap-2">
                      {product.sizes.map((size, sIdx) => (
                        <span key={sIdx} className="px-3 py-1 bg-bg border border-line rounded-pill text-xs font-medium text-fg">
                          {size}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                
                <a
                  href={`${whatsappBase}${message}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: "outline", className: "w-full" })}
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
