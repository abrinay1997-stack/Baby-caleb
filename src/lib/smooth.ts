import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Los .from() de las secciones dejan los elementos en su estado inicial
// (opacity: 0). Si el ScrollTrigger no dispara, los elementos quedan invisibles.
// Con `toggleActions: 'play none none none'` garantizamos que al primer
// contacto con el viewport se reproduzca la animación una vez, sin reset.
ScrollTrigger.defaults({ toggleActions: 'play none none none' });

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

  // Después de que Lenis está listo y todos los ScrollTrigger están registrados,
  // fuerza un refresh para que las secciones que ya estén en viewport disparen.
  requestAnimationFrame(() => ScrollTrigger.refresh());
}

/**
 * Salta al tope de la página. Usa Lenis cuando está activo (para no pelear con
 * su rAF) y cae a window.scrollTo cuando el smooth scroll está deshabilitado
 * (p. ej. con prefers-reduced-motion).
 */
export function scrollToTop() {
  if (typeof window === 'undefined') return;
  if (lenis) {
    lenis.scrollTo(0, { immediate: true });
  } else {
    window.scrollTo(0, 0);
  }
}
