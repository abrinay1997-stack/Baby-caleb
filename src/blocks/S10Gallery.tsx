import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

const WHATSAPP_BASE = 'https://wa.me/50767575065?text=';

export default function S10Gallery() {
  const data = getContentData().products;

  const containerRef = useGsapContext(() => {
    gsap.from('.gallery-item', {
      y: 30,
      duration: 0.7,
      stagger: 0.06,
      ease: 'power3.out',
      scrollTrigger: { trigger: containerRef.current, start: 'top 80%' },
    });
  });

  // Flatten all variants across products for a full visual grid
  const items = data.flatMap((p) =>
    p.variants.map((v) => ({
      productName: p.name,
      productId: p.id,
      ...v,
    }))
  );

  return (
    <Section ref={containerRef} variant="surface">
      <SectionHeader
        kicker="02 / Galería completa"
        title="Todas las presentaciones, con precio."
        description="Cada variante disponible con foto y precio. Ordena por WhatsApp con un solo tap."
      />

      <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        {items.map((item, idx) => {
          const message = encodeURIComponent(
            `Hola Baby Caleb, quiero pedir: ${item.productName} — ${item.size} (${item.units}) por $${item.price}`
          );
          return (
            <a
              key={idx}
              href={`${WHATSAPP_BASE}${message}`}
              target="_blank"
              rel="noopener noreferrer"
              className="gallery-item group flex flex-col bg-bg rounded-2xl overflow-hidden border border-line hover:border-accent hover:-translate-y-1 transition-all duration-300 shadow-soft focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              <div className="aspect-square bg-sage/15 overflow-hidden flex items-center justify-center">
                <img
                  src={item.image}
                  alt={`${item.productName} ${item.size}`}
                  className="w-full h-full object-contain p-3 group-hover:scale-[1.04] transition-transform duration-500"
                  loading={idx < 4 ? 'eager' : 'lazy'}
                  decoding="async"
                />
              </div>
              <div className="p-4 flex flex-col gap-1">
                <span className="mono text-[10px] text-sage">{item.productName}</span>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-bold text-fg leading-tight">{item.size}</span>
                  <span className="font-display font-bold text-accent">${item.price}</span>
                </div>
                <span className="text-xs text-muted">{item.range}</span>
                <span className="text-xs text-muted">{item.units}</span>
              </div>
            </a>
          );
        })}
      </div>
    </Section>
  );
}
