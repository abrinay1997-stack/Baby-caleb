import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Un dato, un solo dueño — vigilado desde el repositorio (F3.5).
 *
 * El precio vive en la D1 del sistema y la web lo pide a `/api/catalogo`.
 * Nada impide que mañana alguien escriba un `"price": 45` en `content.json`
 * «para que se vea rápido»: el sitio lo mostraría, nadie fallaría, y la web
 * volvería a decir una cosa mientras el bot dice otra. Esa es exactamente la
 * forma en que se pierde una fuente de verdad: en silencio y con buena
 * intención.
 *
 * Estas pruebas son el contrato que lo impide (03-contratos.md §2).
 */

const RAIZ = resolve(import.meta.dirname, '..');
const leer = (r: string) => readFileSync(join(RAIZ, r), 'utf8');

interface Variante {
  codigo?: string;
  size: string;
  units?: string;
}
interface Producto {
  id: string;
  name: string;
  descatalogado?: boolean;
  variants: Variante[];
}

const contenido = JSON.parse(leer('content.json')) as { products: Producto[] };
const respaldo = JSON.parse(leer('src/data/catalogo.respaldo.json')) as {
  variantes: { codigo: string; precioCents: number }[];
};
const EN_EL_CATALOGO = new Set(respaldo.variantes.map((v) => v.codigo));

describe('content.json no guarda precios', () => {
  it('ni `price` ni `priceFrom` en ninguna parte', () => {
    const crudo = leer('content.json');
    expect(crudo).not.toMatch(/"price"/);
    expect(crudo).not.toMatch(/"priceFrom"/);
  });

  it('y tampoco un monto en dólares escrito a mano', () => {
    // Un `"desde $45"` metido en una descripción esquiva la comprobación de
    // arriba y engaña igual a la clienta.
    const crudo = leer('content.json');
    const montos = crudo.match(/\$\s?\d/g) ?? [];
    expect(montos, `montos encontrados: ${montos.join(', ')}`).toEqual([]);
  });
});

describe('cada variante que se pinta existe en el catálogo', () => {
  const visibles = contenido.products.filter((p) => p.descatalogado !== true);

  it('todas tienen código', () => {
    const sinCodigo = visibles.flatMap((p) =>
      p.variants.filter((v) => !v.codigo).map((v) => `${p.id} · ${v.size}`)
    );
    expect(sinCodigo, `sin código: ${sinCodigo.join(', ')}`).toEqual([]);
  });

  it('y su código existe de verdad en la copia del catálogo', () => {
    // Si esto falla, la web está ofreciendo algo que el sistema no tiene: una
    // clienta puede pedirlo y el bot le dirá que no existe.
    const fantasmas = visibles.flatMap((p) =>
      p.variants
        .filter((v) => v.codigo && !EN_EL_CATALOGO.has(v.codigo))
        .map((v) => `${p.id} · ${v.size} (${v.codigo})`)
    );
    expect(fantasmas, `códigos que no están en el catálogo: ${fantasmas.join(', ')}`).toEqual([]);
  });

  it('la copia del catálogo no está vacía', () => {
    // Una copia vacía haría pasar en verde la prueba de arriba por la razón
    // equivocada: sin códigos que comprobar, no hay fantasma que encontrar.
    expect(respaldo.variantes.length).toBeGreaterThan(0);
  });
});

describe('lo descatalogado se marca, no se deja suelto', () => {
  it('un producto sin códigos tiene que estar marcado como descatalogado', () => {
    const sospechosos = contenido.products
      .filter((p) => p.descatalogado !== true)
      .filter((p) => p.variants.every((v) => !v.codigo))
      .map((p) => p.id);
    expect(sospechosos, `sin un solo código y sin marcar: ${sospechosos.join(', ')}`).toEqual([]);
  });
});

describe('el Worker no escribe montos a mano', () => {
  const archivos = (dir: string): string[] =>
    readdirSync(join(RAIZ, dir)).flatMap((n) => {
      const r = join(dir, n);
      if (statSync(join(RAIZ, r)).isDirectory()) return archivos(r);
      return r.endsWith('.ts') && !r.endsWith('.test.ts') ? [r] : [];
    });

  it('ningún `$<número>` fuera de los formateadores', () => {
    // El único sitio donde un símbolo de dólar es correcto es la función que
    // convierte centavos a texto. En cualquier otro, es un precio escrito a
    // mano que el catálogo no puede corregir.
    const culpables: string[] = [];
    for (const r of archivos('worker')) {
      leer(r)
        .split('\n')
        .forEach((linea, i) => {
          // `${` es interpolación de plantilla, no un monto.
          const limpia = linea.replace(/\$\{/g, '');
          if (/\$\s?\d/.test(limpia)) culpables.push(`${r}:${i + 1} ${linea.trim()}`);
        });
    }
    expect(culpables, culpables.join('\n')).toEqual([]);
  });
});
