import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { MapPin, Phone, Clock } from 'lucide-react';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S18Coverage() {
  const data = getContentData().nap;

  const containerRef = useGsapContext(() => {
    gsap.from('.cov-content > *', {
      y: 20,
      opacity: 0,
      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      }
    });
    
    gsap.from('.cov-map', {
      opacity: 0,
      scale: 0.95,
      duration: 1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      }
    });
  });

  return (
    <Section ref={containerRef} variant="bg" className="border-t border-line">
      <div className="grid md:grid-cols-2 gap-12 items-center">
        <div className="cov-content flex flex-col gap-8">
          <SectionHeader 
            kicker="05 / Ubicación" 
            title="Encuéntranos en Ancón." 
          />
          
          <div className="space-y-6">
            <div className="flex gap-4">
              <MapPin className="w-6 h-6 text-sage flex-shrink-0" />
              <div>
                <h4 className="font-bold text-fg mb-1">Dirección Física</h4>
                <p className="text-muted">{data.address}</p>
              </div>
            </div>
            
            <div className="flex gap-4">
              <Phone className="w-6 h-6 text-sage flex-shrink-0" />
              <div>
                <h4 className="font-bold text-fg mb-1">Teléfono / WhatsApp</h4>
                <a href={`tel:${data.phone.replace(/ /g, '')}`} className="text-muted hover:text-accent transition-colors">
                  {data.phone}
                </a>
              </div>
            </div>
            
            <div className="flex gap-4">
              <Clock className="w-6 h-6 text-sage flex-shrink-0" />
              <div>
                <h4 className="font-bold text-fg mb-1">Horario</h4>
                {data.hours.map((h, i) => (
                  <p key={i} className="text-muted">{h}</p>
                ))}
              </div>
            </div>
          </div>
        </div>
        
        <div className="cov-map aspect-square md:aspect-auto md:h-[400px] bg-surface rounded-2xl border border-line flex items-center justify-center p-8">
           {/* Map placeholder */}
           <div className="text-center text-muted">
              <MapPin className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="font-mono text-sm uppercase">Mapa (Google Maps Lazy Load)</p>
           </div>
        </div>
      </div>
    </Section>
  );
}
