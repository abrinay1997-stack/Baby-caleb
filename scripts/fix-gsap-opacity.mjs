// Elimina `opacity: 0,` de todos los gsap.from(...) en src/blocks.
// Motivo: los inline opacity:0 quedaban aplicados por GSAP y el
// ScrollTrigger no siempre disparaba a tiempo (Lenis + timing) dejando
// elementos invisibles. Al eliminar opacity, la animación queda solo
// slide-up (y/x translate) — sigue viéndose bien y NUNCA hay fantasmas.
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('src/blocks');
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.tsx'));

for (const f of files) {
  const p = path.join(dir, f);
  let src = await fs.readFile(p, 'utf8');
  const before = src;

  // Quita "opacity: 0," + espacios/newline siguientes
  src = src.replace(/^\s*opacity:\s*0(\.\d+)?,\s*\n/gm, '');
  // Quita casos inline "opacity: 0, " en la misma línea que otras props
  src = src.replace(/opacity:\s*0(\.\d+)?,\s*/g, '');

  if (src !== before) {
    await fs.writeFile(p, src, 'utf8');
    console.log('✓', f);
  }
}
