import { describe, expect, it } from 'vitest';
import {
  jsonLdProducto,
  metaDeProducto,
  precioPlano,
  rangoDePeso,
  slugDeRuta,
  type VarianteParaFicha,
} from '../src/seo/producto';

/**
 * Los textos y los datos estructurados de una ficha de producto (F3.7).
 *
 * Esto es lo que Google guarda y lo que WhatsApp enseña al pegar un enlace.
 * Un dato estructurado equivocado es peor que uno ausente: Google lo cree, lo
 * muestra en los resultados, y corregirlo tarda semanas en propagarse.
 */

const M: VarianteParaFicha = {
  codigo: 'NAT-M',
  slug: 'panales-nateen-cierre-nat-m',
  nombre: 'Pañal Nateen Talla M de cierre — caja de 144',
  talla: 'M',
  pesoMinLb: 8,
  pesoMaxLb: 19,
  unidadesPorCaja: 144,
  precioCents: 5000,
  disponibilidad: 'disponible',
};

const FULAR: VarianteParaFicha = {
  codigo: 'MOON-FUL',
  slug: 'fular-prearmado-moon-moon-ful',
  nombre: 'Fular prearmado Moon de bambú — unitalla',
  talla: 'Unitalla',
  pesoMinLb: null,
  pesoMaxLb: null,
  unidadesPorCaja: 1,
  precioCents: 4600,
  disponibilidad: 'agotado',
};

describe('el precio para schema.org', () => {
  it('va como número con dos decimales, sin símbolo', () => {
    // Google lo parsea. Un `$50` ahí no es un precio, es texto que no valida.
    expect(precioPlano(5000)).toBe('50.00');
    expect(precioPlano(4650)).toBe('46.50');
    expect(precioPlano(0)).toBe('0.00');
  });
});

describe('el rango de peso', () => {
  it('se dice en libras, que es como pregunta una mamá', () => {
    expect(rangoDePeso(M)).toBe('de 8 a 19 lb');
  });

  it('con tope abierto dice «desde»', () => {
    expect(rangoDePeso({ ...M, pesoMaxLb: null })).toBe('desde 8 lb');
  });

  it('y un producto sin peso no inventa uno', () => {
    expect(rangoDePeso(FULAR)).toBeNull();
  });
});

describe('el título y la descripción', () => {
  it('usan el nombre del catálogo tal cual', () => {
    // El mismo nombre que ve la dueña en su panel. Dos nombres para lo mismo
    // es cómo empiezan las confusiones en un pedido.
    const meta = metaDeProducto(M);
    expect(meta.title).toContain('Pañal Nateen Talla M de cierre');
    expect(meta.title).toContain('Baby Caleb Panamá');
  });

  it('la descripción trae talla, peso, caja y precio', () => {
    const d = metaDeProducto(M).description;
    expect(d).toContain('Talla M');
    expect(d).toContain('de 8 a 19 lb');
    expect(d).toContain('caja de 144');
    expect(d).toContain('$50');
  });

  it('un producto sin talla ni peso no deja huecos en el texto', () => {
    const d = metaDeProducto({ ...FULAR, talla: null }).description;
    expect(d).not.toMatch(/· ·|null|undefined/);
    expect(d).toContain('$46');
  });
});

describe('el JSON-LD', () => {
  it('lleva el precio y el código, y dice que hay', () => {
    const ld = jsonLdProducto(M, 'https://babycaleb.com/productos/x') as Record<string, never>;
    expect(ld['@type']).toBe('Product');
    expect(ld.sku).toBe('NAT-M');
    expect((ld.offers as Record<string, unknown>).price).toBe('50.00');
    expect((ld.offers as Record<string, unknown>).availability).toBe(
      'https://schema.org/InStock'
    );
  });

  it('agotado se dice, y «quedan pocas» sigue siendo que HAY', () => {
    const agotado = jsonLdProducto(FULAR, 'x').offers as Record<string, unknown>;
    expect(agotado.availability).toBe('https://schema.org/OutOfStock');

    const pocas = jsonLdProducto({ ...M, disponibilidad: 'pocas' }, 'x').offers as Record<
      string,
      unknown
    >;
    expect(pocas.availability).toBe('https://schema.org/InStock');
  });

  it('NUNCA la cantidad exacta ni el costo', () => {
    // La regla de todo el sistema, también donde el dato se lo lleva Google.
    //
    // Se miran las CLAVES, no el texto serializado: un patrón sobre el texto
    // caza `https://schema.org/InStock`, que es el valor correcto de
    // disponibilidad. Lo que se quiere prohibir es un CAMPO con la cantidad o
    // el costo, no la palabra.
    const claves = (o: unknown): string[] =>
      o !== null && typeof o === 'object' && !Array.isArray(o)
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [k, ...claves(v)])
        : [];

    const prohibidas = claves(jsonLdProducto(M, 'x')).filter((k) =>
      /inventoryLevel|quantity|stockLevel|cost/i.test(k)
    );
    expect(prohibidas, `campos prohibidos: ${prohibidas.join(', ')}`).toEqual([]);

    // Y por si alguien los mete con otro nombre: ningún número del documento
    // puede ser la cantidad en existencia.
    expect(JSON.stringify(jsonLdProducto({ ...M }, 'x'))).not.toContain('"144"');
  });

  it('no inventa una marca', () => {
    // El catálogo guarda un nombre, no una marca. Deducirla del texto
    // («empieza por Nateen») funciona hasta el día que no, y Google se lo cree.
    expect(jsonLdProducto(M, 'x')).not.toHaveProperty('brand');
  });
});

describe('el slug de la ruta', () => {
  it('se saca de /productos/<slug>', () => {
    expect(slugDeRuta('/productos/panales-nateen-cierre-nat-m')).toBe(
      'panales-nateen-cierre-nat-m'
    );
    expect(slugDeRuta('/productos/x/')).toBe('x');
  });

  it('el listado NO es una ficha', () => {
    expect(slugDeRuta('/productos')).toBeNull();
    expect(slugDeRuta('/productos/')).toBeNull();
  });

  it('ni nada de dos niveles más abajo', () => {
    expect(slugDeRuta('/productos/x/y')).toBeNull();
    expect(slugDeRuta('/faq')).toBeNull();
    expect(slugDeRuta('/')).toBeNull();
  });
});
