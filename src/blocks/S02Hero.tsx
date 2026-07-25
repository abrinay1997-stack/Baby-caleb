import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { gsap } from 'gsap';
import SplitType from 'split-type';
import { getContentData } from '../data/content';

export default function S02Hero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const data = getContentData().hero;

  useEffect(() => {
    let h1Split: SplitType;
    const ctx = gsap.context(() => {
      h1Split = new SplitType(h1Ref.current!, { types: 'lines,words' });
      gsap.set(h1Split.lines, { overflow: 'hidden' });

      const tl = gsap.timeline();

      tl.from('.hero-kicker', {
        y: 20,
        duration: 0.8,
        ease: 'power3.out',
      })
        .from(
          h1Split.words,
          { yPercent: 120, duration: 1.2, ease: 'power4.out', stagger: 0.04 },
          '-=0.4'
        )
        .from('.hero-sub', { y: 20, duration: 0.8, ease: 'power3.out' }, '-=0.8')
        .from('.hero-cta', { y: 20, duration: 0.8, ease: 'power3.out' }, '-=0.6')
        .from(
          '.hero-visual',
          { scale: 0.95, duration: 1.4, ease: 'power3.out' },
          '-=1'
        )
        .from(
          '.hero-blob',
          { scale: 0.6, duration: 1.2, ease: 'power3.out', stagger: 0.15 },
          '-=1.2'
        );

      gsap.to('.hero-float', {
        y: -12,
        duration: 3,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: -1,
      });
    }, containerRef);

    return () => {
      ctx.revert();
      if (h1Split!) h1Split.revert();
    };
  }, []);

  return (
    <section
      ref={containerRef}
      className="relative min-h-[90vh] flex items-center pt-32 md:pt-24 overflow-hidden"
    >
      <div className="hero-blob absolute -top-24 -left-24 w-96 h-96 rounded-full bg-sage/25 blur-3xl pointer-events-none" />
      <div className="hero-blob absolute top-1/2 -right-32 w-[28rem] h-[28rem] rounded-full bg-accent/15 blur-3xl pointer-events-none" />

      <div className="container-normal relative z-content grid md:grid-cols-12 gap-8 items-center w-full">
        <div className="md:col-span-7 lg:col-span-6 flex flex-col items-start gap-6">
          <div className="hero-kicker inline-block border border-line bg-bg/60 backdrop-blur px-4 py-2 rounded-pill mono text-sage">
            {data.kicker}
          </div>

          <h1
            ref={h1Ref}
            className="text-balance text-4xl sm:text-5xl md:text-[var(--fs-hero)] text-fg tracking-tight leading-tight hyphens-auto break-words"
            lang="es"
          >
            {data.h1}
          </h1>

          <p className="hero-sub text-lg md:text-xl text-muted max-w-lg text-balance leading-relaxed">
            {data.sub}
          </p>

          <div className="hero-cta mt-4 w-full md:w-auto flex flex-col sm:flex-row gap-3">
            <a
              href={data.cta.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full sm:inline-flex items-center justify-center bg-accent text-accent-fg px-8 py-4 rounded-pill font-bold text-lg hover:opacity-90 transition-opacity focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-4 shadow-glow"
            >
              {data.cta.label}
            </a>
            <Link
              to="/productos"
              className="flex w-full sm:inline-flex items-center justify-center border border-line bg-bg/60 backdrop-blur text-fg px-8 py-4 rounded-pill font-bold text-lg hover:border-accent hover:text-accent transition-colors focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              Ver catálogo
            </Link>
          </div>
        </div>

        <div className="md:col-span-5 lg:col-span-6 relative">
          <div className="hero-visual relative aspect-[4/5] max-w-md md:max-w-none mx-auto">
            <img
              src={data.image}
              alt="Bebé recién nacido cuidado con Nateen"
              className="hero-float w-full h-full object-cover rounded-3xl shadow-[0_30px_80px_-30px_rgba(27,50,70,0.35)]"
              loading="eager"
              decoding="async"
            />
            <div className="hero-float absolute -bottom-6 -left-6 md:-left-10 bg-bg/95 backdrop-blur rounded-2xl border border-line shadow-soft p-4 pr-6 flex items-center gap-3 max-w-[16rem]">
              <img
                src="/img/producto-panal-nateen-s.png"
                alt="Pañal Nateen"
                className="w-16 h-16 object-contain rounded-lg bg-sage/20"
              />
              <div>
                <span className="block mono text-[10px] text-sage">Desde talla Prematuro</span>
                <span className="block font-bold text-fg leading-tight">Pañal Nateen</span>
                <span className="block text-xs text-muted">Desde $17</span>
              </div>
            </div>
            <div className="hero-float absolute -top-4 right-4 md:right-8 bg-sage text-bg font-bold text-xs px-4 py-2 rounded-pill shadow-soft flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-bg" />
              TCF · Sin cloro
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
