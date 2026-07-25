import { useState } from 'react';
import { gsap } from 'gsap';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { ChevronDown } from 'lucide-react';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';
import { cn } from '../components/ui/Section';

export default function S14FAQ() {
  const data = getContentData().faq;
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const containerRef = useGsapContext(() => {
    gsap.from('.faq-item', {
      y: 20,      duration: 0.8,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 80%',
      }
    });
  });

  return (
    <Section id="faq" ref={containerRef} variant="surface">
      <SectionHeader 
        kicker="06 / Preguntas Frecuentes" 
        title="Resolvemos tus dudas." 
        centered={true}
      />

      <div className="max-w-3xl mx-auto space-y-4">
        {data.map((faq, idx) => {
          const isOpen = openIndex === idx;
          return (
            <div key={idx} className="faq-item bg-bg border border-line rounded-xl overflow-hidden">
              <button
                className="w-full text-left px-6 py-6 flex items-center justify-between focus-visible:outline-accent"
                onClick={() => setOpenIndex(isOpen ? null : idx)}
                aria-expanded={isOpen}
              >
                <span className="font-bold text-fg pr-8">{faq.q}</span>
                <ChevronDown
                  className={cn("w-5 h-5 text-muted transition-transform duration-300", isOpen && "rotate-180")}
                />
              </button>
              <div
                className={cn(
                  "grid transition-all duration-300 ease-in-out",
                  isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                )}
              >
                <div className="overflow-hidden">
                  <p className="px-6 pb-6 text-muted text-sm md:text-base leading-relaxed">
                    {faq.a}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
