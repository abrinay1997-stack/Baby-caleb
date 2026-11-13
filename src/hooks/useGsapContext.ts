import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { prefiereMenosMovimiento } from '../lib/movimiento';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * El contexto de GSAP de un bloque, que **respeta quien pidió menos
 * movimiento**.
 *
 * Quien pide quietud no recibe la animación acortada: no recibe ninguna. Todas
 * las animaciones que pasan por aquí son `gsap.from(...)` —«ven desde aquí
 * hasta donde ya estás»—, así que no ejecutarlas deja cada elemento exactamente
 * donde el diseño lo puso. El porqué largo está en `src/lib/movimiento.ts`.
 *
 * Esta es la puerta por la que pasan casi todos los bloques; el hero usa
 * `gsap.context` directamente y hace la misma comprobación en su archivo.
 */
export function useGsapContext(callback: (context: gsap.Context) => void, dependencies: any[] = []) {
  const containerRef = useRef<HTMLDivElement>(null);

  useIsomorphicLayoutEffect(() => {
    if (prefiereMenosMovimiento()) return;

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
