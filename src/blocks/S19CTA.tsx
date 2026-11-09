import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';

export default function S19CTA() {
  const data = getContentData().hero.cta;

  const containerRef = useGsapContext(() => {
    gsap.from('.cta-content > *', {
      y: 40,      duration: 1,
      stagger: 0.15,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 75%',
      }
    });
  });

  return (
    <Section ref={containerRef} variant="sage" className="text-center" padding={true}>
      <div className="cta-content">
        <h2 className="text-4xl md:text-6xl lg:text-7xl text-balance mb-12 max-w-4xl mx-auto text-fg leading-tight">
          Dale a tu bebé el cuidado que su piel merece.
        </h2>
        <div>
          <a
            href={data.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex md:inline-flex w-full md:w-auto items-center justify-center bg-accent text-accent-fg px-8 py-4 md:px-10 md:py-5 rounded-pill font-bold text-lg md:text-xl hover:scale-105 transition-transform duration-300 focus-visible:outline-accent-edge shadow-glow"
          >
            {data.label}
          </a>
        </div>
      </div>
    </Section>
  );
}
