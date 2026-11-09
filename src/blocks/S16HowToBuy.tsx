import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S16HowToBuy() {
  const data = getContentData().howToBuy;

  const containerRef = useGsapContext(() => {
    gsap.from('.buy-step', {
      x: -30,      duration: 0.8,
      stagger: 0.15,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 75%',
      }
    });
    
    gsap.from('.buy-line', {
      scaleY: 0,
      transformOrigin: 'top center',
      duration: 1.5,
      ease: 'power3.inOut',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 75%',
      }
    });
  });

  return (
    <Section id="como-comprar" ref={containerRef} variant="surface">
      <div className="grid md:grid-cols-2 gap-16 items-center">
        <div>
          <SectionHeader 
            kicker="04 / Cómo Comprar" 
            title="Simple, directo y sin complicaciones." 
            description="Hacer tu pedido es tan fácil como enviar un mensaje. Nosotros nos encargamos del resto."
          />
        </div>
        
        <div className="relative pl-8 md:pl-12">
          <div className="buy-line absolute left-0 top-2 bottom-2 w-px bg-line"></div>
          
          <div className="space-y-12">
            {data.map((step, idx) => (
              <div key={idx} className="buy-step relative">
                <div className="absolute -left-[33px] md:-left-[49px] top-1 w-2 h-2 bg-accent rounded-full"></div>
                <span className="mono text-sage-strong text-sm mb-2 block">PASO {step.step}</span>
                <h3 className="text-xl md:text-2xl font-bold text-fg mb-2">{step.title}</h3>
                <p className="text-muted text-sm md:text-base">{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
