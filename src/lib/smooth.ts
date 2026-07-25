import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

let lenis: Lenis | null = null;

export function initSmoothScroll() {
  if (typeof window === 'undefined') return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  
  if (lenis) {
    lenis.destroy();
  }

  lenis = new Lenis({
    lerp: 0.1,
    smoothWheel: !reduce,
    syncTouch: false, // Don't force smooth scroll on touch devices to avoid fighting native scroll
  });

  lenis.on('scroll', ScrollTrigger.update);

  gsap.ticker.add((time) => {
    lenis?.raf(time * 1000);
  });

  gsap.ticker.lagSmoothing(0);

  if (reduce) {
    lenis.destroy();
    lenis = null;
  }
}
