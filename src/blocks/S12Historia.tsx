import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';

export default function S12Historia() {
  const { about, brand } = getContentData();

  const containerRef = useGsapContext(() => {
    gsap.from('.about-copy > *', {
      y: 24,
      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: { trigger: containerRef.current, start: 'top 80%' },
    });
    gsap.from('.about-visual', {
      scale: 0.96,
      duration: 1.2,
      ease: 'power3.out',
      scrollTrigger: { trigger: containerRef.current, start: 'top 80%' },
    });
  });

  return (
    <Section ref={containerRef} variant="bg">
      <div className="grid md:grid-cols-2 gap-12 lg:gap-20 items-center">
        <div className="about-copy flex flex-col gap-6">
          <SectionHeader kicker={about.kicker} title={about.title} />
          <p className="text-lg text-muted leading-relaxed max-w-lg">{about.body}</p>

          <div className="border-l-4 border-sage-edge pl-6 py-4 bg-surface rounded-r-lg">
            <p className="text-fg italic leading-relaxed">
              «En Baby Caleb Panamá pensamos en cada etapa de tu bebé.»
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-4">
            <div>
              <span className="block font-display font-bold text-4xl text-accent-strong">6</span>
              <span className="block text-xs text-muted mt-1">tallas, de RN a XXL</span>
            </div>
            <div>
              <span className="block font-display font-bold text-4xl text-accent-strong">2024</span>
              <span className="block text-xs text-muted mt-1">cuidando bebés en Panamá</span>
            </div>
            <div>
              <span className="block font-display font-bold text-4xl text-accent-strong">100%</span>
              <span className="block text-xs text-muted mt-1">online con delivery</span>
            </div>
          </div>
        </div>

        <div className="about-visual relative">
          <div className="aspect-square rounded-3xl overflow-hidden bg-sage/20 shadow-[0_30px_80px_-30px_rgba(27,50,70,0.35)]">
            <img
              src={about.image}
              alt="Familia Nateen — línea completa de pañales hipoalergénicos"
              className="w-full h-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </div>
          <img
            src={brand.badge}
            alt="Baby Caleb"
            className="absolute -bottom-8 -left-8 w-28 h-28 object-contain drop-shadow-xl bg-bg rounded-full p-2"
            loading="lazy"
          />
        </div>
      </div>
    </Section>
  );
}
