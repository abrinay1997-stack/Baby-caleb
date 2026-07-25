import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function useGsapContext(callback: (context: gsap.Context) => void, dependencies: any[] = []) {
  const containerRef = useRef<HTMLDivElement>(null);

  useIsomorphicLayoutEffect(() => {
    const ctx = gsap.context(callback, containerRef);
    return () => ctx.revert();
  }, dependencies);

  return containerRef;
}
