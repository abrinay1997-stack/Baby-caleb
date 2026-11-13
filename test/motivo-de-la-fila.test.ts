import { describe, expect, it } from 'vitest';
import { motivoDeLaFila } from '../src/carrito/FilaPresentacion';

/**
 * La palabra que una fila del catálogo enseña cuando no se deja tocar.
 *
 * ## Por qué esta prueba existe
 *
 * Esa palabra vivía en un `sr-only`: la oía un lector de pantalla y no la veía
 * nadie más. Quien mira la pantalla solo tenía la fila apagada con
 * `opacity-60` —comunicar con el color y nada más, WCAG 1.4.1— y, de paso, el
 * texto por debajo de AA, porque `opacity` se aplica al pintar (2.35 medido
 * contra el mínimo de 4.5).
 *
 * Al sacar la palabra a la vista apareció el hueco que llevaba escondido todo
 * el tiempo: una presentación cuyo código ya no está en el catálogo decía
 * **«Agregar»** sin dejarse tocar. Nadie podía verlo porque nadie la veía.
 *
 * ## La regla que vigila
 *
 * Si la fila no se puede tocar, la palabra NUNCA puede ser «Agregar». Eso es
 * lo que invita a tocar justo lo que no funciona.
 */

const BASE = {
  cargando: false,
  agregado: false,
  enElCatalogo: true,
  agotado: false,
  lleno: false,
};

describe('la palabra de una fila', () => {
  it('«Agregar» solo cuando de verdad se puede agregar', () => {
    expect(motivoDeLaFila(BASE)).toBe('Agregar');
  });

  it('mientras no se sabe, no se afirma nada', () => {
    // La copia del build trae las doce variantes en `agotado`. Decir «Agotado»
    // durante los primeros cientos de milisegundos sería decir que no hay nada
    // de nada, y cambiarlo solo medio segundo después.
    expect(motivoDeLaFila({ ...BASE, cargando: true })).toBe('Un momento…');
    expect(motivoDeLaFila({ ...BASE, cargando: true, agotado: true })).toBe('Un momento…');
    expect(motivoDeLaFila({ ...BASE, cargando: true, enElCatalogo: false })).toBe('Un momento…');
  });

  it('sin ficha en el catálogo no se dice «Agotado», se dice qué hacer', () => {
    // Sin ficha no sabemos si hay existencias: afirmar que no hay sería
    // inventarlo (`docs/TRAMPAS.md` §7, el cero no es «no sé»).
    expect(motivoDeLaFila({ ...BASE, enElCatalogo: false })).toBe('Pregúntanos');
    expect(motivoDeLaFila({ ...BASE, enElCatalogo: false, agotado: true })).toBe('Pregúntanos');
  });

  it('agotado y máximo dicen lo suyo', () => {
    expect(motivoDeLaFila({ ...BASE, agotado: true })).toBe('Agotado');
    expect(motivoDeLaFila({ ...BASE, lleno: true })).toBe('Máximo');
    // Agotado manda sobre lleno: no poder pedir más de algo que no hay es una
    // consecuencia, no el motivo.
    expect(motivoDeLaFila({ ...BASE, agotado: true, lleno: true })).toBe('Agotado');
  });

  it('el acuse de lo que se acaba de hacer gana a todo lo demás', () => {
    expect(motivoDeLaFila({ ...BASE, agregado: true, lleno: true })).toBe('Agregado');
  });

  /**
   * La regla entera, sobre las 32 combinaciones posibles.
   *
   * Una por una se escriben las que a uno se le ocurren; así se comprueban
   * también las que no.
   */
  it('NINGUNA combinación que no se pueda tocar dice «Agregar»', () => {
    const fallos: string[] = [];
    for (const cargando of [false, true])
      for (const agregado of [false, true])
        for (const enElCatalogo of [false, true])
          for (const agotado of [false, true])
            for (const lleno of [false, true]) {
              const estado = { cargando, agregado, enElCatalogo, agotado, lleno };
              // La misma condición que usa el componente para decidir si pinta
              // un `<button>` o un `<div>` que no se toca.
              const sePuede = !cargando && enElCatalogo && !agotado && !lleno;
              const palabra = motivoDeLaFila(estado);
              if (!sePuede && palabra === 'Agregar') {
                fallos.push(JSON.stringify(estado));
              }
            }
    expect(
      fallos,
      'Hay filas que no se dejan tocar y aun así dicen «Agregar».\n' +
        'Esa palabra invita a hacer exactamente lo que no va a funcionar.\n\n' +
        fallos.join('\n'),
    ).toEqual([]);
  });
});
