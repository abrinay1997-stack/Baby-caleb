import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S08Differentiators() {
  const data = getContentData().differentiators;

  const containerRef = useGsapContext(() => {
    gsap.from('.diff-card', {
      y: 30,      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      }
    });
  });

  return (
    <Section id="beneficios" ref={containerRef} variant="surface">
      <SectionHeader 
        kicker="02 / Por qué Baby Caleb" 
        title="Más allá de un pañal, un servicio pensado para ti." 
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {data.map((item, idx) => (
          <div key={idx} className="diff-card bg-bg p-8 rounded-xl border border-line flex flex-col gap-4">
            <span className="mono text-sage-strong text-2xl">0{idx + 1}</span>
            <h3 className="text-xl font-bold text-fg leading-tight">{item.title}</h3>
            <p className="text-muted text-sm leading-relaxed">{item.text}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
