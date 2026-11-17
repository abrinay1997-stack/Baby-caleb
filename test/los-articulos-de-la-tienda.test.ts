import { describe, expect, it } from 'vitest';

import {
  articulosDeLaTienda,
  compararTallas,
  filtrar,
  opcionesDe,
  SIN_FILTROS,
  type ArticuloDeLaTienda,
  type Filtros,
} from '../src/tienda/articulos';
import type { Catalogo, Disponibilidad, ProductoDelSistema } from '../src/hooks/useCatalogo';

/**
 * La tienda desagrupada, artículo por artículo.
 *
 * Los datos son los de verdad: el catálogo que quedó después de poner el
 * sistema al día con el CRM, con las dos marcas de pañal que es justo lo que
 * hace falta para poder comparar. Con una sola marca, media prueba de aquí
 * pasaría sin medir nada.
 */

const PRODUCTOS: ProductoDelSistema[] = [
  { slug: 'panales-nateen-cierre', nombre: 'Pañales Nateen', descripcion: 'x', orden: 1, marca: 'Nateen', familia: 'panal' },
  { slug: 'panales-velvee', nombre: 'Pañales Velvee', descripcion: null, orden: 5, marca: 'Velvee', familia: 'panal' },
  { slug: 'water-wipes-dany-baby', nombre: 'Wipes Dany Baby', descripcion: 'y', orden: 3, marca: 'Dany Baby', familia: 'wipes' },
];

function v(
  codigo: string,
  productoSlug: string,
  talla: string | null,
  precioCents: number,
  disponibilidad: Disponibilidad,
) {
  return {
    codigo,
    slug: `${productoSlug}-${codigo.toLowerCase()}`,
    nombre: codigo,
    talla,
    pesoMinLb: null,
    pesoMaxLb: null,
    unidadesPorCaja: 160,
    precioCents,
    disponibilidad,
    productoSlug,
  };
}

const CATALOGO: Catalogo = new Map(
  (
    [
      v('NAT-S', 'panales-nateen-cierre', 'S', 5000, 'pocas'),
      v('NAT-M', 'panales-nateen-cierre', 'M', 5000, 'disponible'),
      v('NAT-XXL', 'panales-nateen-cierre', 'XXL', 4500, 'pocas'),
      v('VELVEE-P', 'panales-velvee', 'S', 3500, 'pocas'),
      v('VELVEE-M', 'panales-velvee', 'M', 3500, 'pocas'),
      v('VELVEE-L', 'panales-velvee', 'L', 3300, 'agotado'),
      v('DANY-AW600', 'water-wipes-dany-baby', null, 2000, 'disponible'),
    ] as never[]
  ).map((x: { codigo: string }) => [x.codigo, x]),
) as Catalogo;

const sinFoto = () => undefined;
const sinUnidades = () => ({ talla: null, unidades: null });

const articulos = () => articulosDeLaTienda(PRODUCTOS, CATALOGO, sinFoto, sinUnidades);
const con = (f: Partial<Filtros>) => filtrar(articulos(), { ...SIN_FILTROS, ...f });
const codigos = (as: readonly ArticuloDeLaTienda[]) => as.map((a) => a.codigo);

describe('desagrupar el catálogo', () => {
  it('saca un artículo por presentación, con la marca de su producto', () => {
    const as = articulos();
    expect(as).toHaveLength(7);
    const velvee = as.filter((a) => a.marca === 'Velvee');
    expect(codigos(velvee).sort()).toEqual(['VELVEE-L', 'VELVEE-M', 'VELVEE-P']);
    expect(velvee.every((a) => a.familia === 'panal')).toBe(true);
  });

  it('una presentación sin su producto no se pinta a medias', () => {
    const huerfana: Catalogo = new Map([
      ...CATALOGO,
      ['RARO', v('RARO', 'producto-que-no-llego', 'M', 100, 'disponible')],
    ] as never) as Catalogo;
    const as = articulosDeLaTienda(PRODUCTOS, huerfana, sinFoto, sinUnidades);
    // Siete, no ocho: sin producto no hay nombre ni marca, y una tarjeta con el
    // título en blanco es peor que una tarjeta que no está.
    expect(as).toHaveLength(7);
    expect(codigos(as)).not.toContain('RARO');
  });

  it('un producto sin familia cae en «otro», no desaparece del filtro', () => {
    const sinFamilia: ProductoDelSistema[] = [
      { slug: 'algo', nombre: 'Algo', descripcion: null, orden: 9 },
    ];
    const uno: Catalogo = new Map([['X', v('X', 'algo', null, 500, 'disponible')]] as never) as Catalogo;
    const as = articulosDeLaTienda(sinFamilia, uno, sinFoto, sinUnidades);
    expect(as[0]?.familia).toBe('otro');
    expect(as[0]?.marca).toBeNull();
    // Y con «otro» sigue siendo filtrable, que es el punto.
    expect(opcionesDe(as).familias).toEqual([{ valor: 'otro', cuantos: 1 }]);
  });
});

describe('las tallas se ordenan como el cuerpo de un bebé', () => {
  it('RN antes que S, y XXL al final', () => {
    const revueltas = ['XXL', 'M', 'RN', 'XL', 'S', 'L'];
    expect([...revueltas].sort(compararTallas)).toEqual(['RN', 'S', 'M', 'L', 'XL', 'XXL']);
  });

  it('alfabéticamente saldría mal, que es por lo que esto existe', () => {
    // El contrapeso: sin esta prueba, alguien podría cambiar `compararTallas`
    // por un `localeCompare` y las dos de arriba… no, la de arriba se pondría
    // roja. Esto deja escrito POR QUÉ, con el orden que saldría.
    expect([...['XXL', 'M', 'RN', 'XL', 'S', 'L']].sort((a, b) => a.localeCompare(b, 'es'))).toEqual(
      ['L', 'M', 'RN', 'S', 'XL', 'XXL'],
    );
  });

  it('una talla que no conoce va al final, pero va', () => {
    expect([...['M', 'Prematuro', 'RN']].sort(compararTallas)).toEqual(['RN', 'M', 'Prematuro']);
  });
});

describe('los filtros', () => {
  it('sin marcar nada se ven TODOS, no ninguno', () => {
    // El fallo clásico de un filtro por casillas: la lista vacía se interpreta
    // como «ninguno seleccionado, no enseñes nada» y la tienda abre vacía.
    expect(con({})).toHaveLength(7);
  });

  it('una marca deja solo esa marca', () => {
    expect(codigos(con({ marcas: ['Velvee'] })).sort()).toEqual([
      'VELVEE-L',
      'VELVEE-M',
      'VELVEE-P',
    ]);
  });

  it('dos marcas dejan las dos: es la comparación que pidió el cliente', () => {
    const m = con({ marcas: ['Nateen', 'Velvee'], tallas: ['M'] });
    expect(codigos(m)).toEqual(['NAT-M', 'VELVEE-M']);
    // Y con el precio a la vista, que es lo que decide la compra.
    expect(m.map((a) => a.precioCents)).toEqual([5000, 3500]);
  });

  it('una talla cruza las marcas sola', () => {
    // Sin elegir marca, la talla S tiene que traer las dos: eso es lo que la
    // tienda agrupada por familia no podía hacer.
    expect(codigos(con({ tallas: ['S'] })).sort()).toEqual(['NAT-S', 'VELVEE-P']);
  });

  it('la familia separa los pañales de los wipes', () => {
    expect(codigos(con({ familias: ['wipes'] }))).toEqual(['DANY-AW600']);
    expect(con({ familias: ['panal'] })).toHaveLength(6);
  });

  it('los filtros se acumulan, no se reemplazan', () => {
    expect(codigos(con({ marcas: ['Nateen'], tallas: ['M'] }))).toEqual(['NAT-M']);
    // Una combinación sin resultados devuelve vacío, no «todo»: si al cruzar
    // dos filtros reapareciera el catálogo entero, nadie entendería nada.
    expect(con({ marcas: ['Velvee'], familias: ['wipes'] })).toEqual([]);
  });
});

describe('el orden', () => {
  it('lo agotado va al final, y no se esconde', () => {
    // Esconderlo haría que la clienta que busca su talla se fuera creyendo que
    // no la vendemos. Viéndola agotada, pregunta cuándo llega.
    for (const orden of ['tienda', 'precio-asc', 'precio-desc', 'ultimas'] as const) {
      const as = con({ orden });
      expect(as).toHaveLength(7);
      expect(as.at(-1)?.codigo).toBe('VELVEE-L');
    }
  });

  it('por precio, de menor a mayor entre lo que sí se puede comprar', () => {
    const as = con({ orden: 'precio-asc' });
    const comprables = as.filter((a) => a.disponibilidad !== 'agotado');
    expect(comprables.map((a) => a.precioCents)).toEqual([2000, 3500, 3500, 4500, 5000, 5000]);
  });

  it('por precio al revés, de mayor a menor', () => {
    const comprables = con({ orden: 'precio-desc' }).filter((a) => a.disponibilidad !== 'agotado');
    expect(comprables.map((a) => a.precioCents)).toEqual([5000, 5000, 4500, 3500, 3500, 2000]);
  });

  it('«disponibles» pone primero lo que hay de sobra', () => {
    const as = con({ orden: 'disponibles' });
    expect(as.slice(0, 2).map((a) => a.disponibilidad)).toEqual(['disponible', 'disponible']);
    expect(as.at(-1)?.disponibilidad).toBe('agotado');
  });

  it('«últimas» pone primero lo que se está acabando', () => {
    const as = con({ orden: 'ultimas' });
    expect(as[0]?.disponibilidad).toBe('pocas');
    // Y lo agotado sigue al final: de eso no queda ninguno que mover.
    expect(as.at(-1)?.disponibilidad).toBe('agotado');
  });

  it('el orden de la tienda es el que decidió el panel', () => {
    // `orden` es la columna del producto. Nateen es 1, los wipes 3 y Velvee 5:
    // si la tienda ordenara por nombre o por precio, esto saldría distinto.
    const as = con({ orden: 'tienda' }).filter((a) => a.disponibilidad !== 'agotado');
    expect(as.map((a) => a.marca)).toEqual([
      'Nateen',
      'Nateen',
      'Nateen',
      'Dany Baby',
      'Velvee',
      'Velvee',
    ]);
  });
});

describe('las opciones del filtro', () => {
  it('salen de lo que hay, con la cuenta de cada una', () => {
    const o = opcionesDe(articulos());
    expect(o.marcas).toEqual([
      { valor: 'Dany Baby', cuantos: 1 },
      { valor: 'Nateen', cuantos: 3 },
      { valor: 'Velvee', cuantos: 3 },
    ]);
    expect(o.familias).toEqual([
      { valor: 'panal', cuantos: 6 },
      { valor: 'wipes', cuantos: 1 },
    ]);
  });

  it('las tallas vienen en orden de bebé y sin la que no tiene', () => {
    // Los wipes no llevan talla: si un `null` se colara, el filtro tendría una
    // opción en blanco que no filtra nada.
    expect(opcionesDe(articulos()).tallas).toEqual([
      { valor: 'S', cuantos: 2 },
      { valor: 'M', cuantos: 2 },
      { valor: 'L', cuantos: 1 },
      { valor: 'XXL', cuantos: 1 },
    ]);
  });
});
