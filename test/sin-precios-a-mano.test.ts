import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ningún precio escrito a mano en la web.
 *
 * El CLAUDE.md lo dice desde el principio —«Un dato, un solo dueño: precio,
 * existencias y costo viven solo en la D1 del sistema. Nunca escribas un
 * precio en `content.json` ni en el código»— y aun así la portada tuvo
 * `Desde $17` escrito a mano durante semanas, en el bloque más visible del
 * sitio, mientras el pañal más barato costaba $45.
 *
 * Veintiocho dólares de diferencia, prometidos a una clienta, en lo primero
 * que se ve al entrar.
 *
 * NINGUNA PRUEBA PODÍA VERLO, y ese es el punto de esta. Un número escrito a
 * mano dentro de un JSX es sintácticamente perfecto: el typecheck pasa, el
 * build pasa, las 148 pruebas pasaban. Lo encontró una persona auditando el
 * panel y comparándolo con la web.
 *
 * Una regla que solo vive en un documento se rompe. Esta la comprueba una
 * máquina en cada empujón.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

/** `$` seguido de un dígito: `$17`, `$ 45`, `$1,200`. */
const PRECIO = /\$\s?\d/;

function archivosDe(dir: string, ext: string[]): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) salida.push(...archivosDe(rel, ext));
    else if (ext.some((x) => e.name.endsWith(x))) salida.push(rel);
  }
  return salida;
}

/**
 * Lo que NO es un precio aunque lleve `$`.
 *
 * Se listan de una en una y con su motivo. Una lista de excepciones que
 * crece sin explicación acaba tragándose la regla entera.
 */
const PERMITIDO: { archivo: string; porque: string }[] = [
  // `dolares()` y `desdeDe()` FORMATEAN un precio que viene del catálogo:
  // el `$` es del formato, no del número.
  { archivo: 'src/hooks/useCatalogo.ts', porque: 'formatea el precio del catálogo' },
  { archivo: 'src/carrito/carrito.ts', porque: 'formatea, no decide' },
];

describe('ningún precio escrito a mano', () => {
  it('ni en los bloques de la página ni en las páginas', () => {
    const sospechosos: string[] = [];

    for (const archivo of [...archivosDe('src/blocks', ['.tsx']), ...archivosDe('src/pages', ['.tsx'])]) {
      if (PERMITIDO.some((p) => p.archivo === archivo)) continue;
      const lineas = readFileSync(join(RAIZ, archivo), 'utf8').split('\n');
      lineas.forEach((linea, i) => {
        // Las líneas de comentario sí pueden nombrar una cifra: el comentario
        // que explica POR QUÉ no se escribe un precio lleva un precio dentro.
        const limpia = linea.trim();
        if (limpia.startsWith('*') || limpia.startsWith('//')) return;
        if (PRECIO.test(linea)) sospechosos.push(`${archivo}:${i + 1}  ${limpia.slice(0, 80)}`);
      });
    }

    expect(
      sospechosos,
      `Precio escrito a mano. El precio tiene UN dueño: la D1 del sistema.\n` +
        `Use \`useCatalogo()\` con \`dolares()\` o \`desdeDe()\`, como hace el resto del sitio.\n\n` +
        sospechosos.join('\n'),
    ).toEqual([]);
  });

  it('ni en content.json, que es texto y no cifras', () => {
    const crudo = readFileSync(join(RAIZ, 'content.json'), 'utf8');
    const malas = crudo
      .split('\n')
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter(({ l }) => PRECIO.test(l));

    expect(
      malas.map(({ l, n }) => `content.json:${n}  ${l.slice(0, 80)}`),
      'content.json describe el producto, no lo tarifa. El precio sale del sistema.',
    ).toEqual([]);
  });
});
