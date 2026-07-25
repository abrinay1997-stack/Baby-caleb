import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S11Testimonials() {
  const data = getContentData().testimonials;

  const containerRef = useGsapContext(() => {
    gsap.from('.test-card', {
      y: 40,
      opacity: 0,
      duration: 0.8,
      stagger: 0.2,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      }
    });
  });

  return (
    <Section ref={containerRef} variant="bg">
      <SectionHeader 
        kicker="03 / Experiencias Reales" 
        title="Lo que dicen nuestras mamás." 
        centered={true}
      />

      <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
        {data.map((item, idx) => (
          <div key={idx} className="test-card bg-surface p-8 rounded-2xl border border-line flex flex-col justify-between">
            <p className="text-lg md:text-xl text-fg mb-8 font-medium leading-relaxed">
              "{item.quote}"
            </p>
            <div className="flex items-center justify-between border-t border-line pt-6">
              <div>
                <p className="font-bold text-fg">{item.name}</p>
                <p className="text-sm text-muted">{item.role}</p>
              </div>
              <div className="text-right">
                <span className="inline-block px-3 py-1 bg-sage/20 text-sage rounded-pill text-xs font-bold mono">
                  {item.result}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
