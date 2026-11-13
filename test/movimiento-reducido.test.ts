import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nadie anima sin preguntar antes.
 *
 * ## Qué pasó
 *
 * `src/index.css` tenía desde el principio el bloque de siempre:
 *
 *     @media (prefers-reduced-motion: reduce) { *, *::before, *::after {
 *       animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
 *
 * y la web entera parecía cubierta. No lo estaba. Ese bloque apaga animaciones
 * y transiciones **de CSS**, y aquí quien anima es GSAP: calcula cada cuadro y
 * escribe un `transform` en el atributo `style`. Una regla de CSS no puede
 * apagar lo que no es CSS.
 *
 * Medido con el navegador en `reduce` el 2026-11-13: el titular seguía
 * entrando palabra por palabra, las tarjetas seguían subiendo al llegar al
 * viewport y `.hero-float` seguía oscilando con `repeat: -1` — o sea, para
 * siempre. Eso último es WCAG 2.2.2 (*Pause, Stop, Hide*), Nivel A.
 *
 * ## Por qué esta prueba mira el CÓDIGO y no el navegador
 *
 * Porque el comportamiento ya lo mide el navegador en `npm run auditar:web`, y
 * lo que hace falta además es que **el siguiente bloque que se escriba** no
 * vuelva a saltarse la pregunta. Esta prueba vigila la puerta: todo lo que
 * llame a `gsap.context`, `gsap.to`, `gsap.from` o `gsap.timeline` tiene que
 * pasar por `useGsapContext` —que ya pregunta— o preguntar él mismo con
 * `prefiereMenosMovimiento`.
 *
 * Es la trampa §12 al revés: la pieza que decide existe, y lo que hay que
 * vigilar es que la llamen.
 *
 * ## Cómo se rompe a propósito
 *
 * Quite la línea `if (prefiereMenosMovimiento()) return;` de `S02Hero.tsx`.
 * Esta prueba se pone roja nombrando ese archivo.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

/** Lo que de verdad mueve algo. `gsap.set` no: pone un valor y ya. */
const ANIMA = /\bgsap\s*\.\s*(context|to|from|fromTo|timeline)\s*\(/;

function archivosDe(dir: string): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) salida.push(...archivosDe(rel));
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) salida.push(rel);
  }
  return salida;
}

/** El archivo donde vive la pregunta. No se le exige que se pregunte a sí mismo. */
const EL_GUARDIAN = 'src/lib/movimiento.ts';

/**
 * `smooth.ts` arranca Lenis y ya consultaba la preferencia a su manera
 * (`matchMedia` directo, y destruye Lenis si es que sí). Se le permite seguir
 * con la suya: no anima elementos, configura el desplazamiento de la página.
 */
const CON_SU_PROPIA_PREGUNTA = ['src/lib/smooth.ts'];

describe('quien pidió menos movimiento no recibe ninguno', () => {
  it('todo lo que anima con GSAP pregunta antes', () => {
    const sinPreguntar: string[] = [];

    for (const archivo of archivosDe('src')) {
      if (archivo === EL_GUARDIAN) continue;
      const crudo = readFileSync(join(RAIZ, archivo), 'utf8');

      // Las líneas de comentario no cuentan: este archivo mismo nombra
      // `gsap.from` para explicar por qué existe.
      const codigo = crudo
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');

      if (!ANIMA.test(codigo)) continue;
      if (CON_SU_PROPIA_PREGUNTA.includes(archivo)) continue;

      // SE EXIGE LA LLAMADA, NO LA PALABRA. La primera versión de esto
      // buscaba `includes('prefiereMenosMovimiento')` y se le escapó la
      // mutación: al quitar la línea `if (prefiereMenosMovimiento()) return;`
      // de `S02Hero.tsx`, el `import` se quedaba arriba, la palabra seguía
      // apareciendo y la prueba seguía en verde. O sea que vigilaba que
      // alguien hubiera escrito el nombre alguna vez, que no es lo mismo que
      // preguntar. `docs/TRAMPAS.md` §6.
      const pregunta =
        /\bprefiereMenosMovimiento\s*\(/.test(codigo) ||
        /\bconMovimiento\s*\(/.test(codigo) ||
        /\buseGsapContext\s*\(/.test(codigo);

      if (!pregunta) sinPreguntar.push(archivo);
    }

    expect(
      sinPreguntar,
      'Estos archivos animan con GSAP sin mirar `prefers-reduced-motion`.\n' +
        'El bloque de `index.css` NO los cubre: solo apaga animaciones de CSS, y GSAP\n' +
        'escribe estilos en línea. Use `useGsapContext`, que ya pregunta, o llame a\n' +
        '`prefiereMenosMovimiento()` de `src/lib/movimiento.ts`.\n\n' +
        sinPreguntar.join('\n'),
    ).toEqual([]);
  });

  it('el hook por el que pasan los bloques pregunta de verdad', () => {
    // Si alguien le quita la guarda al hook, los diez bloques que lo usan se
    // quedan sin protección de golpe y la prueba de arriba seguiría en verde,
    // porque sigue viendo la palabra `useGsapContext` en cada uno.
    const hook = readFileSync(join(RAIZ, 'src/hooks/useGsapContext.ts'), 'utf8');
    expect(hook).toContain('prefiereMenosMovimiento');
    expect(hook).toMatch(/if\s*\(\s*prefiereMenosMovimiento\(\)\s*\)\s*return/);
  });

  it('lo que anima `motion/react` obedece la preferencia del sistema', () => {
    // `MotionConfig reducedMotion="user"` cubre toda la librería de una vez.
    // Sin él, el menú del teléfono entraba animado igual.
    const app = readFileSync(join(RAIZ, 'src/App.tsx'), 'utf8');
    expect(app).toContain('MotionConfig');
    expect(app).toMatch(/reducedMotion=["']user["']/);
  });
});
