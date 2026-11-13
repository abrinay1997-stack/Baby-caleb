import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { MapPin, Phone, Clock, Truck, MessageCircle } from 'lucide-react';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S18Coverage() {
  const { nap, coverage } = getContentData();

  const containerRef = useGsapContext(() => {
    gsap.from('.cov-content > *', {
      y: 20,
      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      },
    });
    gsap.from('.cov-block', {
      y: 20,
      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      },
    });
  });

  return (
    <Section ref={containerRef} variant="bg" className="border-t border-line">
      <div className="grid md:grid-cols-2 gap-12 items-start">
        <div className="cov-content flex flex-col gap-8">
          <SectionHeader
            kicker="05 / Cobertura"
            title="Vendemos online y te lo llevamos."
          />

          <div className="space-y-6">
            <div className="flex gap-4">
              <Phone className="w-6 h-6 text-sage-strong flex-shrink-0" />
              <div>
                <h3 className="font-bold text-fg mb-1">Teléfono / WhatsApp</h3>
                <a
                  href={`tel:${nap.phone.replace(/ /g, '')}`}
                  className="text-muted hover:text-accent-strong transition-colors"
                >
                  {nap.phone}
                </a>
              </div>
            </div>

            <div className="flex gap-4">
              <Clock className="w-6 h-6 text-sage-strong flex-shrink-0" />
              <div>
                <h3 className="font-bold text-fg mb-1">Horario</h3>
                {nap.hours.map((h, i) => (
                  <p key={i} className="text-muted">
                    {h}
                  </p>
                ))}
              </div>
            </div>

            <div className="flex gap-4">
              <MapPin className="w-6 h-6 text-sage-strong flex-shrink-0" />
              <div>
                <h3 className="font-bold text-fg mb-1">Cobertura</h3>
                <p className="text-muted">{nap.address}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-6">
          <div className="cov-block bg-surface border border-line rounded-2xl p-6 md:p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-sage/20 flex items-center justify-center text-sage-strong">
                <Truck size={20} />
              </div>
              <h3 className="font-bold text-lg text-fg">Delivery</h3>
            </div>
            <ul className="space-y-3">
              {coverage.delivery.map((d, i) => (
                <li key={i} className="flex items-start justify-between gap-4 text-sm border-b border-line last:border-b-0 pb-3 last:pb-0">
                  <span className="text-fg">{d.zona}</span>
                  <span className="mono text-xs text-accent-strong whitespace-nowrap">{d.costo}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="cov-block bg-surface border border-line rounded-2xl p-6 md:p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-sage/20 flex items-center justify-center text-sage-strong">
                <MessageCircle size={20} />
              </div>
              <h3 className="font-bold text-lg text-fg">Cómo pedir</h3>
            </div>
            <p className="text-sm text-muted leading-relaxed">
              Vendemos únicamente online. Escríbenos por WhatsApp o por DM de Instagram
              <span className="text-fg font-bold"> (@babycalebpanama)</span>, elegimos juntos la
              talla y coordinamos la entrega a domicilio. El costo del delivery depende de tu zona
              y te lo confirmamos antes de cerrar el pedido.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
