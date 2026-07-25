import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function useGsapContext(callback: (context: gsap.Context) => void, dependencies: any[] = []) {
  const containerRef = useRef<HTMLDivElement>(null);

  useIsomorphicLayoutEffect(() => {
    const ctx = gsap.context(callback, containerRef);
    // ScrollTrigger a veces se registra antes de que Lenis o los layouts
    // finales estén listos. Refrescamos en el siguiente frame para que
    // recalcule posiciones y dispare las animaciones ya "en viewport".
    const id = requestAnimationFrame(() => ScrollTrigger.refresh());
    return () => {
      cancelAnimationFrame(id);
      ctx.revert();
    };
  }, dependencies);

  return containerRef;
}
