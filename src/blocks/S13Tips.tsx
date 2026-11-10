import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S13Tips() {
  const data = getContentData().tips;

  const containerRef = useGsapContext(() => {
    gsap.from('.tip-card', {
      y: 30,
      duration: 0.8,
      stagger: 0.08,
      ease: 'power3.out',
      scrollTrigger: { trigger: containerRef.current, start: 'top 80%' },
    });
  });

  return (
    <Section ref={containerRef} variant="bg">
      <SectionHeader
        kicker="Tips & Educación"
        title="Cuidar la piel de tu bebé, mejor informada."
        description="Lo que aprendimos vendiendo pañales hipoalergénicos, resumido en 6 lecturas breves."
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {data.map((tip, idx) => (
          <article
            key={tip.id}
            className="tip-card group flex flex-col bg-surface rounded-2xl overflow-hidden border border-line hover:border-sage-edge hover:-translate-y-1 transition-all duration-300 shadow-soft"
          >
            <div className="aspect-[4/5] overflow-hidden bg-bg">
              <img
                src={tip.image}
                alt={tip.title}
                className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"
                loading={idx < 3 ? 'eager' : 'lazy'}
                decoding="async"
              />
            </div>
            <div className="p-6 flex flex-col gap-3 flex-grow">
              <span className="mono text-xs text-sage-strong">Tip 0{idx + 1}</span>
              <h3 className="font-bold text-lg text-fg leading-snug">{tip.title}</h3>
              <p className="text-sm text-muted leading-relaxed flex-grow">{tip.excerpt}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-16 text-center">
        <p className="text-muted mb-4">¿Tienes una duda que no está aquí?</p>
        <a
          href="https://wa.me/50767575065"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center bg-accent text-accent-fg px-8 py-4 rounded-pill font-bold hover:opacity-90 transition-opacity shadow-glow"
        >
          Pregúntanos por WhatsApp
        </a>
      </div>
    </Section>
  );
}
