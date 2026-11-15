import { describe, expect, it } from 'vitest';

import {
  comoSeLlamaLaPresentacion,
  laListaDeLaTienda,
  type Catalogo,
  type FichaDelArchivo,
  type ProductoDelSistema,
  type VariantePublica,
} from '../src/hooks/useCatalogo';

/**
 * La lista de la tienda sale del SISTEMA.
 *
 * EL FALLO QUE CIERRA. La dueña creaba un producto en el panel, le ponía
 * precio, le subía la foto y lo publicaba — y no aparecía en babycaleb.com. No
 * había error: la lista se armaba con las fichas de `content.json`, un archivo
 * de este repositorio que nadie escribe desde ningún sitio. El producto tenía
 * su página y su foto y se podía pedir por su enlace directo, pero no entraba
 * en la lista hasta que un programador editara ese archivo y desplegara. El
 * dueño preguntó cuatro días seguidos.
 *
 * Lo que estas pruebas fijan son las dos mitades: que lo publicado SALGA, y que
 * lo que ya decía la tienda no cambie de paso.
 */

const v = (codigo: string, productoSlug: string, extra: Partial<VariantePublica> = {}): VariantePublica => ({
  codigo,
  slug: `${productoSlug}-${codigo.toLowerCase()}`,
  nombre: codigo,
  talla: 'M',
  pesoMinLb: null,
  pesoMaxLb: null,
  unidadesPorCaja: 144,
  precioCents: 5000,
  disponibilidad: 'disponible',
  productoSlug,
  ...extra,
});

const mapa = (...vs: VariantePublica[]): Catalogo => new Map(vs.map((x) => [x.codigo, x]));
const listo = { cargando: false };

const FICHA_NATEEN: FichaDelArchivo = {
  id: 'nateen-diapers',
  name: 'Pañales Nateen',
  description: 'Hipoalergénicos y de bambú.',
  image: '/img/producto-panal-nateen-s.png',
  variants: [
    { codigo: 'NAT-M', size: 'Caja M', units: '144 uds' },
    { codigo: 'NAT-L', size: 'Caja L', units: '128 uds' },
  ],
};

const PROD_NATEEN: ProductoDelSistema = {
  slug: 'panales-nateen-cierre',
  nombre: 'Pañales Nateen',
  descripcion: 'Hipoalergénicos y de bambú.',
  orden: 1,
};

describe('un producto creado en el panel', () => {
  it('SALE en la tienda aunque no tenga ficha en content.json', () => {
    // Esta es la prueba del fallo de los cuatro días.
    const nuevo: ProductoDelSistema = {
      slug: 'babero-impermeable',
      nombre: 'Babero impermeable',
      descripcion: null,
      orden: 9,
    };
    const lista = laListaDeLaTienda([nuevo], [FICHA_NATEEN], mapa(v('BAB-1', 'babero-impermeable')), listo);

    expect(lista.map((p) => p.clave)).toContain('babero-impermeable');
    expect(lista[0]?.nombre).toBe('Babero impermeable');
    expect(lista[0]?.codigos).toEqual(['BAB-1']);
  });

  it('sin texto de venta sale igual, y el texto viene en null para no pintar un hueco', () => {
    const nuevo: ProductoDelSistema = { slug: 'babero', nombre: 'Babero', descripcion: null, orden: 9 };
    const lista = laListaDeLaTienda([nuevo], [], mapa(v('BAB-1', 'babero')), listo);
    expect(lista[0]?.descripcion).toBeNull();
  });

  it('y sus presentaciones se nombran solas, sin ficha que las redacte', () => {
    const nuevo: ProductoDelSistema = { slug: 'babero', nombre: 'Babero', descripcion: null, orden: 9 };
    const lista = laListaDeLaTienda(
      [nuevo],
      [],
      mapa(v('BAB-1', 'babero', { talla: null, unidadesPorCaja: 1 })),
      listo,
    );
    expect(lista[0]?.presentaciones[0]).toEqual({ codigo: 'BAB-1', talla: 'Única', unidades: '1 unidad' });
  });
});

describe('lo que la tienda ya decía no cambia', () => {
  it('conserva las palabras redactadas de la ficha, no las deduce', () => {
    // «Caja M · 144 uds» está escrito a mano. Deducirlo del sistema daría
    // «M · 144 uds», y en el fular «Caja Unitalla · 1 uds».
    const lista = laListaDeLaTienda(
      [PROD_NATEEN],
      [FICHA_NATEEN],
      mapa(v('NAT-M', 'panales-nateen-cierre'), v('NAT-L', 'panales-nateen-cierre')),
      listo,
    );
    expect(lista[0]?.presentaciones).toEqual([
      { codigo: 'NAT-M', talla: 'Caja M', units: undefined, unidades: '144 uds' },
      { codigo: 'NAT-L', talla: 'Caja L', units: undefined, unidades: '128 uds' },
    ].map(({ codigo, talla, unidades }) => ({ codigo, talla, unidades })));
  });

  it('empareja la ficha por los CÓDIGOS, no por el id: los slugs no coinciden', () => {
    // El sistema lo llama `panales-nateen-cierre` y la ficha `nateen-diapers`.
    // Emparejar por id habría dejado a los cuatro productos de siempre sin su
    // foto de respaldo el día del despliegue.
    const lista = laListaDeLaTienda(
      [PROD_NATEEN],
      [FICHA_NATEEN],
      mapa(v('NAT-M', 'panales-nateen-cierre')),
      listo,
    );
    expect(lista[0]?.ficha?.image).toBe('/img/producto-panal-nateen-s.png');
  });
});

describe('cuando el sistema no contesta, la tienda no se queda vacía', () => {
  it('mientras carga, enseña lo de content.json', () => {
    const lista = laListaDeLaTienda([], [FICHA_NATEEN], new Map(), { cargando: true });
    expect(lista).toHaveLength(1);
    expect(lista[0]?.nombre).toBe('Pañales Nateen');
  });

  it('sin productos del sistema —la copia vieja del build— también', () => {
    // La copia del build se generó antes de que el catálogo llevara
    // productos: llega con variantes y sin productos. Eso no es «no hay
    // productos», es «no se sabe».
    const lista = laListaDeLaTienda([], [FICHA_NATEEN], mapa(v('NAT-M', 'panales-nateen-cierre')), listo);
    expect(lista).toHaveLength(1);
    expect(lista[0]?.nombre).toBe('Pañales Nateen');
  });

  it('un producto sin ninguna presentación visible no deja una tarjeta vacía', () => {
    const lista = laListaDeLaTienda([PROD_NATEEN], [], mapa(v('OTRO-1', 'otra-cosa')), listo);
    expect(lista).toHaveLength(0);
  });
});

describe('cómo se nombra una presentación sin ficha', () => {
  it('sin talla, «Única»; de una en una, «1 unidad»', () => {
    expect(comoSeLlamaLaPresentacion(v('X', 'y', { talla: null, unidadesPorCaja: 1 }))).toEqual({
      talla: 'Única',
      unidades: '1 unidad',
    });
    expect(comoSeLlamaLaPresentacion(v('X', 'y', { talla: '  ', unidadesPorCaja: 160 }))).toEqual({
      talla: 'Única',
      unidades: '160 uds',
    });
  });
});
