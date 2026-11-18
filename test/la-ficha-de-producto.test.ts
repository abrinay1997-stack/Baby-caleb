import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { seccionesDeLaFicha } from '../src/components/AcordeonesDeFicha';
import { fraseDeDisponibilidad } from '../src/components/PrecioDeLaFicha';
import type { ProductoDelSistema } from '../src/hooks/useCatalogo';

/**
 * Lo que decide la ficha de un producto, sin montar un navegador.
 *
 * Son las dos decisiones que no se ven mirando la pantalla:
 *
 *  1. **De dónde sale la descripción.** La ficha pinta una VARIANTE y una
 *     variante no tiene descripción: la tiene el producto. Si la búsqueda
 *     falla, el acordeón sale vacío o no sale, y en una captura las dos cosas
 *     se ven igual de bien.
 *  2. **Que sin texto no haya acordeón.** Un bloque plegado que al abrirlo no
 *     tiene nada se come un toque para no dar nada.
 */

const UNA_VARIANTE = { productoSlug: 'panales-nateen' };

const DEL_SISTEMA: ProductoDelSistema[] = [
  {
    slug: 'panales-nateen',
    nombre: 'Pañales Nateen',
    descripcion: 'Lo que la dueña escribió en su panel.',
    orden: 1,
  },
];

describe('los acordeones de la ficha', () => {
  it('sin descripción en ningún sitio, no sale ningún acordeón', () => {
    expect(seccionesDeLaFicha(UNA_VARIANTE, [], undefined)).toEqual([]);
    expect(seccionesDeLaFicha(UNA_VARIANTE, [], null)).toEqual([]);
    // Un texto en blanco es lo mismo que no tener texto: un acordeón con tres
    // espacios dentro es un acordeón vacío con mejor disfraz.
    expect(seccionesDeLaFicha(UNA_VARIANTE, [], '   \n  ')).toEqual([]);
    expect(
      seccionesDeLaFicha(UNA_VARIANTE, [{ ...DEL_SISTEMA[0], descripcion: '  ' }], undefined),
    ).toEqual([]);
  });

  it('manda la del sistema: es la que la dueña edita en su panel', () => {
    const [seccion] = seccionesDeLaFicha(UNA_VARIANTE, DEL_SISTEMA, 'La vieja, del archivo.');
    expect(seccion.texto).toBe('Lo que la dueña escribió en su panel.');
  });

  it('sin sistema queda la de content.json, que es lo que se enseñaba ayer', () => {
    const [seccion] = seccionesDeLaFicha(UNA_VARIANTE, [], 'La del archivo.');
    expect(seccion.texto).toBe('La del archivo.');
  });

  it('un producto del sistema que no es el suyo no le presta su texto', () => {
    // Si se buscara mal —por ejemplo tomando el primero de la lista— esta
    // variante acabaría describiendo el producto de otra.
    const [seccion] = seccionesDeLaFicha({ productoSlug: 'toallitas' }, DEL_SISTEMA, 'La del archivo.');
    expect(seccion.texto).toBe('La del archivo.');
  });

  it('una variante sin producto del sistema todavía usa el archivo', () => {
    // `productoSlug` es opcional: la copia del build se generó antes de que el
    // catálogo llevara productos.
    const [seccion] = seccionesDeLaFicha({}, DEL_SISTEMA, 'La del archivo.');
    expect(seccion.texto).toBe('La del archivo.');
  });

  it('sin variante no hay nada que describir', () => {
    expect(seccionesDeLaFicha(undefined, DEL_SISTEMA, undefined)).toEqual([]);
  });

  /**
   * Y la que de verdad importa: que HOY salga. Lo demás comprueba que la
   * función funciona; esto comprueba que está enchufada a datos de verdad
   * (`docs/TRAMPAS.md` §12), porque el sistema no manda productos todavía y
   * todo el texto de la tienda sale del archivo.
   */
  it('hoy, cada presentación de content.json tiene su texto', () => {
    const contenido = JSON.parse(
      readFileSync(new URL('../content.json', import.meta.url), 'utf8'),
    ) as { products: { description?: string; variants?: { codigo?: string }[] }[] };

    const sinTexto: string[] = [];
    for (const p of contenido.products) {
      for (const v of p.variants ?? []) {
        if (typeof v.codigo !== 'string' || v.codigo === '') continue;
        // Sin productos del sistema: el camino que la tienda recorre hoy.
        if (seccionesDeLaFicha({}, [], p.description).length === 0) sinTexto.push(v.codigo);
      }
    }
    expect(
      sinTexto,
      `estas presentaciones abrirían su ficha sin descripción: ${sinTexto.join(', ')}`,
    ).toEqual([]);
  });
});

describe('lo que se dice de la existencia', () => {
  it('dice si hay o no hay, y nunca cuántas quedan', () => {
    expect(fraseDeDisponibilidad('disponible')).toBe('Disponible para entrega.');
    expect(fraseDeDisponibilidad('pocas')).toBe('Quedan pocas cajas.');
    expect(fraseDeDisponibilidad('agotado')).toContain('agotado');

    // La cantidad exacta es del negocio y el sistema tampoco la manda hasta
    // aquí: ninguna de las tres frases puede llevar un número.
    for (const d of ['disponible', 'pocas', 'agotado'] as const) {
      expect(fraseDeDisponibilidad(d), `«${fraseDeDisponibilidad(d)}» lleva una cifra`).not.toMatch(
        /\d/,
      );
    }
  });
});
