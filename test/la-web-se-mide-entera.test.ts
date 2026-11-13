import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ninguna página de la tienda se queda sin medir.
 *
 * `scripts/auditar-la-web.mjs` abre una lista de direcciones en un navegador de
 * verdad y mide contraste, §7 y accesibilidad. La lista está escrita a mano, y
 * las rutas de la tienda están escritas en otro sitio (`src/App.tsx`). Nadie
 * las compara, así que se separaron: la auditoría visitaba siete páginas y la
 * tienda tenía doce rutas. Las que faltaban eran **la ficha de un producto —la
 * página con la que se vende—, el carrito, las dos legales y la de «esta
 * dirección no existe»**.
 *
 * Y una página que no está en la lista no sale como fallo: sale como nada. El
 * informe dice «sin fallos» y se lee como «está bien». Es la trampa §4 del
 * repositorio, y el panel ya tenía esta misma prueba para sus pantallas
 * (`sistema/test/node/precarga-del-panel.test.ts`); la tienda no.
 *
 * Esta prueba no mide nada: solo comprueba que lo que hay que medir esté en la
 * lista de lo que se mide.
 */

const raiz = join(import.meta.dirname, '..');

/** Las rutas que la tienda declara en su router. */
function rutasDeLaTienda(): string[] {
  const app = readFileSync(join(raiz, 'src', 'App.tsx'), 'utf8');
  return [...app.matchAll(/<Route\s+path=(?:"|')([^"']+)(?:"|')/g)].map((m) => m[1]);
}

/** Las direcciones que la auditoría visita. */
function paginasAuditadas(): string[] {
  const guion = readFileSync(join(raiz, 'scripts', 'auditar-la-web.mjs'), 'utf8');
  const desde = guion.indexOf('const paginas = [');
  const lista = guion.slice(desde, guion.indexOf('];', desde));
  return [...lista.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('la tienda se mide entera', () => {
  const rutas = rutasDeLaTienda();
  const auditadas = paginasAuditadas();

  it('las dos listas se leyeron de verdad', () => {
    // Sin esto, un `matchAll` que se queda a cero compararía dos listas vacías
    // y diría que todo cuadra: la trampa §1.
    expect(rutas.length, 'no se leyó ninguna <Route> de src/App.tsx').toBeGreaterThan(8);
    expect(auditadas.length, 'no se leyó ninguna página de auditar-la-web.mjs').toBeGreaterThan(8);
  });

  it('cada ruta de la tienda tiene una dirección que la audite', () => {
    const sinMedir: string[] = [];
    for (const ruta of rutas) {
      if (ruta === '*') {
        // El comodín no es una dirección: se cubre visitando algo que no
        // exista, para que la página de «no existe» también se mida.
        const hayInventada = auditadas.some((d) => !rutas.includes(d) && /no-existe|no existe/.test(d));
        if (!hayInventada) sinMedir.push('* (la página de «no existe»)');
        continue;
      }
      if (ruta.includes(':')) {
        // Una ruta con parámetro se audita con un valor concreto: basta con que
        // alguna dirección empiece por su parte fija.
        const fija = ruta.slice(0, ruta.indexOf(':'));
        if (!auditadas.some((d) => d.startsWith(fija) && d !== fija)) {
          sinMedir.push(`${ruta} (hace falta una dirección de ejemplo)`);
        }
        continue;
      }
      if (!auditadas.includes(ruta)) sinMedir.push(ruta);
    }

    expect(
      sinMedir,
      `estas rutas existen en la tienda y la auditoría no las visita, así que ` +
        `nadie ha medido su contraste ni su accesibilidad. Añádalas a \`paginas\` ` +
        `en scripts/auditar-la-web.mjs. Sin medir: ${sinMedir.join(', ')}`,
    ).toEqual([]);
  });

  it('la auditoría no visita direcciones que la tienda ya no tiene', () => {
    // Al revés también importa: una dirección que se quedó atrás se audita
    // como la página de «no existe» y da por buena una página que ya no está.
    const inventadas = auditadas.filter((d) => {
      if (rutas.includes(d)) return false;
      if (/no-existe/.test(d)) return false; // a propósito
      const conParametro = rutas.filter((r) => r.includes(':'));
      return !conParametro.some((r) => d.startsWith(r.slice(0, r.indexOf(':'))));
    });
    expect(
      inventadas,
      `estas direcciones se auditan y no corresponden a ninguna ruta de la ` +
        `tienda: ${inventadas.join(', ')}`,
    ).toEqual([]);
  });
});
