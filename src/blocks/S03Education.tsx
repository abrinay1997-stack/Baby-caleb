import { useRef } from 'react';
import { gsap } from 'gsap';
import SplitType from 'split-type';
import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';

export default function S03Education() {
  const qRef = useRef<HTMLHeadingElement>(null);
  const data = getContentData().education[0];

  const containerRef = useGsapContext((ctx) => {
    let qSplit = new SplitType(qRef.current!, { types: 'words' });
    
    gsap.from(qSplit.words, {      duration: 1,
      ease: 'none',
      stagger: 0.1,
      scrollTrigger: {
        trigger: containerRef.current,
        start: 'top 75%',
        end: 'center center',
        scrub: true,
      }
    });
    
    gsap.from('.edu-ans', {      y: 20,
      duration: 0.8,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: '.edu-ans',
        start: 'top 85%',
      }
    });

    return () => {
      if (qSplit) qSplit.revert();
    };
  });

  return (
    <Section ref={containerRef} variant="sage" className="relative overflow-hidden">
      <div className="relative z-content text-center max-w-4xl mx-auto">
        <h2 ref={qRef} className="text-3xl md:text-5xl lg:text-6xl text-balance mb-12 leading-tight">
          {data.question}
        </h2>
        <p className="edu-ans text-lg md:text-2xl text-fg/90 max-w-3xl mx-auto font-medium leading-relaxed">
          {data.answer}
        </p>
      </div>
    </Section>
  );
}
