import { describe, expect, it } from 'vitest';
import {
  dolares,
  precioDe,
  desdeDe,
  type Catalogo,
  type VariantePublica,
} from '../src/hooks/useCatalogo';

/**
 * El dinero que se le enseña a una clienta.
 *
 * Los centavos entran como enteros —`5000`— y salen como texto —`$50`—. Es
 * una conversión de dos líneas y es justo donde vive el error de factor cien:
 * `$5000` o `$0.50` se leen como un precio plausible y nadie mira dos veces
 * hasta que alguien paga.
 */

const v = (codigo: string, precioCents: number): [string, VariantePublica] => [
  codigo,
  {
    codigo,
    slug: codigo.toLowerCase(),
    nombre: codigo,
    talla: null,
    pesoMinLb: null,
    pesoMaxLb: null,
    unidadesPorCaja: 1,
    precioCents,
    disponibilidad: 'disponible',
  },
];

const CATALOGO: Catalogo = new Map([v('NAT-M', 5000), v('NAT-L', 4500), v('MOON-FUL', 4650)]);

describe('centavos a dólares', () => {
  it('un precio redondo no arrastra decimales', () => {
    expect(dolares(5000)).toBe('$50');
    expect(dolares(4500)).toBe('$45');
    expect(dolares(100)).toBe('$1');
  });

  it('y uno con centavos sí los lleva', () => {
    expect(dolares(4650)).toBe('$46.50');
    expect(dolares(1)).toBe('$0.01');
    expect(dolares(99)).toBe('$0.99');
  });

  it('el cero es cero, no vacío', () => {
    expect(dolares(0)).toBe('$0');
  });
});

describe('el precio de una variante', () => {
  it('sale del catálogo', () => {
    expect(precioDe(CATALOGO, 'NAT-M')).toBe('$50');
    expect(precioDe(CATALOGO, 'MOON-FUL')).toBe('$46.50');
  });

  it('un código que no está dice «Consultar», no un número', () => {
    // «Consultar» es lo que la web ya decía cuando un producto no llevaba
    // precio. Que un código ausente signifique lo mismo es deliberado: vale
    // más pedir que confirmen a enseñar una cifra que nadie respaldó.
    expect(precioDe(CATALOGO, 'NAT-WIP')).toBe('Consultar');
    expect(precioDe(CATALOGO, undefined)).toBe('Consultar');
  });
});

describe('el «desde $X» de un producto', () => {
  it('es el más barato de sus variantes', () => {
    expect(desdeDe(CATALOGO, ['NAT-M', 'NAT-L'])).toBe('Desde $45');
  });

  it('ignora los códigos que no están en vez de romperse', () => {
    expect(desdeDe(CATALOGO, ['NAT-WIP', 'NAT-M'])).toBe('Desde $50');
  });

  it('si no se sabe ninguno, no inventa un mínimo', () => {
    expect(desdeDe(CATALOGO, ['NAT-WIP'])).toBe('Consultar');
    expect(desdeDe(CATALOGO, [])).toBe('Consultar');
    expect(desdeDe(CATALOGO, [undefined])).toBe('Consultar');
  });
});
