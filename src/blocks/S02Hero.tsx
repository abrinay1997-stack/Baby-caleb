import { useEffect, useRef, Suspense } from 'react';
import { gsap } from 'gsap';
import SplitType from 'split-type';
import { getContentData } from '../data/content';
import { Canvas } from '@react-three/fiber';
import { Float, Sphere } from '@react-three/drei';

function SoftShapes() {
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[10, 10, 5]} intensity={1.2} />
      <directionalLight position={[-10, -10, -5]} intensity={0.5} color="#EE924A" />
      <Float speed={2} rotationIntensity={0.5} floatIntensity={1}>
        <Sphere args={[1.8, 64, 64]} position={[4, 0, -4]}>
          <meshStandardMaterial color="#F2EFE5" roughness={0.3} metalness={0.1} />
        </Sphere>
      </Float>
      <Float speed={1.5} rotationIntensity={1} floatIntensity={2}>
        <Sphere args={[1.2, 64, 64]} position={[2.5, -2, -1]}>
          <meshStandardMaterial color="#EE924A" roughness={0.4} metalness={0.1} />
        </Sphere>
      </Float>
      <Float speed={2.5} rotationIntensity={0.8} floatIntensity={1.5}>
        <Sphere args={[0.9, 64, 64]} position={[3.5, 2, -2]}>
          <meshStandardMaterial color="#91C9A2" roughness={0.2} metalness={0.2} />
        </Sphere>
      </Float>
    </>
  );
}

export default function S02Hero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const data = getContentData().hero;

  useEffect(() => {
    let h1Split: SplitType;
    const ctx = gsap.context(() => {
      // Setup split type
      h1Split = new SplitType(h1Ref.current!, { types: 'lines,words' });
      gsap.set(h1Split.lines, { overflow: 'hidden' });
      
      const tl = gsap.timeline();
      
      tl.from('.hero-kicker', {
        opacity: 0,
        y: 20,
        duration: 0.8,
        ease: 'power3.out'
      })
      .from(h1Split.words, {
        yPercent: 120,
        opacity: 0,
        duration: 1.2,
        ease: 'power4.out',
        stagger: 0.04
      }, '-=0.4')
      .from('.hero-sub', {
        opacity: 0,
        y: 20,
        duration: 0.8,
        ease: 'power3.out'
      }, '-=0.8')
      .from('.hero-cta', {
        opacity: 0,
        y: 20,
        duration: 0.8,
        ease: 'power3.out'
      }, '-=0.6')
      .from('.hero-canvas', {
        opacity: 0,
        duration: 2,
        ease: 'power2.out'
      }, '-=1');
    }, containerRef);
    
    return () => {
      ctx.revert();
      if (h1Split) h1Split.revert();
    };
  }, []);

  return (
    <section ref={containerRef} className="relative min-h-[90vh] flex items-center pt-32 md:pt-24 overflow-hidden">
      {/* 3D Canvas Background */}
      <div className="hero-canvas hidden md:block absolute inset-0 md:left-1/3 z-canvas pointer-events-none opacity-40 md:opacity-100">
        <Suspense fallback={null}>
          <Canvas camera={{ position: [0, 0, 6], fov: 45 }}>
            <SoftShapes />
          </Canvas>
        </Suspense>
      </div>

      <div className="container-normal relative z-content grid md:grid-cols-12 gap-8 items-center w-full">
        <div className="md:col-span-8 lg:col-span-7 flex flex-col items-start gap-6">
          <div className="hero-kicker inline-block border border-line px-4 py-2 rounded-pill mono text-sage">
            {data.kicker}
          </div>
          
          <h1 ref={h1Ref} className="text-balance text-4xl sm:text-5xl md:text-[var(--fs-hero)] text-fg tracking-tight leading-tight hyphens-auto break-words" lang="es">
            {data.h1}
          </h1>
          
          <p className="hero-sub text-lg md:text-xl text-muted max-w-lg text-balance leading-relaxed">
            {data.sub}
          </p>
          
          <div className="hero-cta mt-4 w-full md:w-auto">
            <a
              href={data.cta.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full md:inline-flex items-center justify-center bg-accent text-accent-fg px-8 py-4 rounded-pill font-bold text-lg hover:opacity-90 transition-opacity focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-4 shadow-glow"
            >
              {data.cta.label}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
