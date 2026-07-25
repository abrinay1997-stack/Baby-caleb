import { gsap } from 'gsap';
import { Leaf, DropletOff, Recycle, Heart } from 'lucide-react';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';

const iconMap: Record<string, React.ElementType> = {
  'leaf': Leaf,
  'droplet-off': DropletOff,
  'recycle': Recycle,
  'heart': Heart,
};

export default function S04Trust() {
  const data = getContentData().trust;

  const containerRef = useGsapContext((ctx) => {
    gsap.from('.trust-item', {
      y: 30,
      opacity: 0,
      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 85%',
      }
    });
  });

  return (
    <Section ref={containerRef} variant="surface" className="py-12 md:py-20 border-y border-line" padding={false}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-4">
        {data.map((item, idx) => {
          const Icon = iconMap[item.icon] || Heart;
          return (
            <div key={idx} className="trust-item flex flex-col items-center text-center gap-4">
              <div className="w-16 h-16 rounded-full bg-bg flex items-center justify-center text-sage shadow-soft">
                <Icon size={32} strokeWidth={1.5} />
              </div>
              <span className="font-display font-bold text-fg text-sm md:text-base">
                {item.label}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
