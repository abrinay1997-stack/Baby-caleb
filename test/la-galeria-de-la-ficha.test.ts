import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fotoDeVariante, fotosDeVariante } from '../src/components/FotoDeProducto';
import type { VariantePublica } from '../src/hooks/useCatalogo';
import { jsonLdProducto } from '../src/seo/producto';
import { soloCodigo } from './sin-comentarios';

/**
 * La ficha enseña TODAS las fotos de la caja, no solo la primera.
 *
 * La clienta mandó dos de cada presentación: la de frente y la del dorso, con
 * la tabla de pesos y las unidades. La segunda es la que contesta la pregunta
 * que más llega por WhatsApp —«¿esta talla le sirve a mi bebé?»— y estaba en el
 * repositorio sin que ninguna pantalla la pintara. Eso es tenerla en ninguna
 * parte (`docs/TRAMPAS.md` §12).
 *
 * ## Romper a propósito
 *
 * Quite el `aria-pressed` de `GaleriaDeProducto.tsx`, o el recorte que ajusta
 * `activa` cuando la lista se acorta, o el `images` de una variante de
 * `content.json`. Cada uno pone roja su propia casilla — los tres lo hicieron
 * al validar esto.
 */

const RAIZ = resolve(import.meta.dirname, '..');
const leer = (r: string) => readFileSync(join(RAIZ, r), 'utf8');

const DEL_SISTEMA = '/foto/catalogo/NAT-M/01HXQ2W3E4R5T6Y7U8I9O0P1A2.webp';
const FRENTE = '/img/producto-nateen-cierre-m.webp';
const DORSO = '/img/producto-nateen-cierre-m-2.webp';

const variante = (imagen?: string | null): Pick<VariantePublica, 'imagen'> =>
  imagen === undefined ? {} : { imagen };

describe('qué fotos tiene una variante', () => {
  it('la del archivo primero y las demás detrás, en ese orden', () => {
    expect(fotosDeVariante(variante(null), { image: FRENTE, images: [DORSO] })).toEqual([
      { src: FRENTE },
      { src: DORSO },
    ]);
  });

  it('una sola foto sigue siendo una sola: la ficha no pinta miniaturas', () => {
    // Es el caso de los otros artículos — toallitas, fular, pañitos.
    expect(fotosDeVariante(variante(null), { image: FRENTE })).toEqual([{ src: FRENTE }]);
  });

  it('sin ninguna foto, la lista está vacía y no se pinta caja', () => {
    expect(fotosDeVariante(variante(null), {})).toEqual([]);
    expect(fotosDeVariante(undefined, undefined)).toEqual([]);
  });

  it('la galería tiene UN dueño: la del panel no arrastra las del archivo', () => {
    // Si la dueña subió una foto desde el panel, las segundas del archivo son
    // las de OTRA foto — pueden ser de otra caja. Enseñarlas juntas sería
    // mezclar dos verdades en una galería que nadie decidió.
    //
    // El precio de esto hay que decirlo: esa variante pasa de dos fotos a una
    // el día que suba una. Al sistema le falta guardar varias y es su propia
    // pieza; hoy no hay ninguna subida, así que hoy no le quita nada a nadie.
    expect(fotosDeVariante(variante(DEL_SISTEMA), { image: FRENTE, images: [DORSO] })).toEqual([
      { src: DEL_SISTEMA, respaldo: FRENTE },
    ]);
  });

  it('las vacías no cuentan y las repetidas no se repiten', () => {
    // Un `<img src="">` pide la PÁGINA otra vez: no falla, no avisa, y deja un
    // hueco. Y dos miniaturas de la misma foto son dos botones que hacen lo
    // mismo, que es peor que uno.
    expect(
      fotosDeVariante(variante(null), { image: FRENTE, images: ['', '   ', FRENTE, DORSO] }),
    ).toEqual([{ src: FRENTE }, { src: DORSO }]);
  });

  it('sin la primera, la segunda pasa a ser la primera', () => {
    expect(fotosDeVariante(variante(null), { image: '', images: [DORSO] })).toEqual([
      { src: DORSO },
    ]);
  });

  it('y la foto de siempre es la PRIMERA de la galería, no otra regla', () => {
    // Las tarjetas del catálogo siguen enseñando una. Si un día cambia quién
    // gana, tiene que cambiar en un sitio y para las dos.
    const casos = [
      { v: variante(DEL_SISTEMA), c: { image: FRENTE, images: [DORSO] } },
      { v: variante(null), c: { image: FRENTE, images: [DORSO] } },
      { v: variante(null), c: {} as { image?: string } },
    ];
    for (const caso of casos) {
      expect(fotoDeVariante(caso.v, caso.c.image)).toEqual(fotosDeVariante(caso.v, caso.c)[0]);
    }
  });
});

/**
 * Las segundas fotos del archivo tienen que EXISTIR.
 *
 * Una ruta mal escrita en `content.json` no rompe el build, no rompe ninguna
 * prueba de tipos y deja una miniatura con un icono roto en la pantalla donde
 * se decide la compra.
 */
describe('las fotos extra de content.json', () => {
  interface Variante {
    codigo?: string;
    image: string;
    images?: string[];
  }
  const contenido = JSON.parse(leer('content.json')) as {
    products: { id: string; variants: Variante[] }[];
  };
  const conExtras = contenido.products.flatMap((p) =>
    p.variants.filter((v) => v.images !== undefined).map((v) => ({ producto: p.id, ...v })),
  );

  it('hay segundas fotos de verdad — si no, esto no vigila nada', () => {
    // La trampa §1: un control que comprueba lo que ya era cierto. Sin esta
    // línea, borrar los nueve `images` dejaría las de abajo en verde.
    expect(conExtras.length).toBeGreaterThanOrEqual(9);
  });

  it('cada una existe en public/img/', () => {
    const faltan = conExtras.flatMap((v) =>
      (v.images ?? [])
        .filter((ruta) => !existsSync(join(RAIZ, 'public', ruta)))
        .map((ruta) => `${v.producto} · ${v.codigo ?? '?'} → ${ruta}`),
    );
    expect(faltan, `fotos que no están en disco: ${faltan.join(', ')}`).toEqual([]);
  });

  it('todas salen de /img/ y ninguna de otro dominio', () => {
    const raras = conExtras.flatMap((v) =>
      (v.images ?? []).filter((ruta) => !ruta.startsWith('/img/')),
    );
    expect(raras, `rutas que no son del sitio: ${raras.join(', ')}`).toEqual([]);
  });

  it('y ninguna repite la principal ni se repite a sí misma', () => {
    const repetidas = conExtras
      .filter((v) => {
        const todas = [v.image, ...(v.images ?? [])];
        return new Set(todas).size !== todas.length;
      })
      .map((v) => `${v.producto} · ${v.codigo ?? '?'}`);
    expect(repetidas, `variantes con fotos repetidas: ${repetidas.join(', ')}`).toEqual([]);
  });
});

/**
 * Y que la galería se pueda USAR: con el dedo, con el teclado y sin ver.
 *
 * Se mira el código y no el navegador por lo mismo que en
 * `teclado-y-anuncios.test.ts`: el comportamiento lo comprueba
 * `npm run auditar:web`, que abre las páginas, y esto es la otra mitad — que
 * las piezas que lo hacen posible sigan ahí después de la próxima
 * refactorización.
 */
describe('las miniaturas se pueden usar', () => {
  const fuente = soloCodigo('src/components/GaleriaDeProducto.tsx');

  it('son botones de verdad, no un div que escucha clics', () => {
    // Un `<div onClick>` no entra con el tabulador, no responde a Espacio y no
    // se anuncia como algo que se pueda tocar.
    expect(fuente).toMatch(/<button\s/);
    expect(fuente).not.toMatch(/<div[^>]*onClick/);
  });

  it('dicen cuál son y cuál está puesta', () => {
    expect(fuente).toMatch(/aria-label=\{`Ver la foto \$\{i \+ 1\} de \$\{fotos\.length\}`\}/);
    expect(fuente).toMatch(/aria-pressed=\{i === indice\}/);
  });

  it('la diana mide 64 px en el teléfono, que es la que manda', () => {
    // La tienda se mide con la 2.5.8 —24×24 px o separación suficiente—, que es
    // su contrato; los 44 px son del panel (`docs/design-system.md` §7a).
    //
    // En escritorio sube a 80 px porque al lado de una foto de 750 px una
    // miniatura de 64 no se ve. El que se mide es el de abajo: en el teléfono
    // la diana es el dedo.
    expect(fuente).toMatch(/h-16 w-16/);
    expect(fuente).toMatch(/md:h-20 md:w-20/);
  });

  it('con una sola foto no se pinta ninguna miniatura', () => {
    expect(fuente).toMatch(/fotos\.length > 1 &&/);
  });

  it('y un índice fuera de la lista no deja la ficha en blanco', () => {
    // Al cambiar de producto, el efecto que vuelve a la primera corre DESPUÉS
    // del pintado: en ese pintado `activa` apunta fuera y sin este recorte
    // `fotos[activa]` sería `undefined`.
    expect(fuente).toMatch(/activa < fotos\.length \? activa : 0/);
  });
});

describe('el JSON-LD lleva las fotos', () => {
  const M = {
    codigo: 'NAT-M',
    slug: 'panales-nateen-cierre-nat-m',
    nombre: 'Pañales Nateen M',
    talla: 'M',
    pesoMinLb: 13,
    pesoMaxLb: 20,
    unidadesPorCaja: 144,
    precioCents: 5000,
    disponibilidad: 'disponible' as const,
  };
  const EN_LA_WEB = (ruta: string) => `https://babycaleb.com${ruta}`;

  it('las que se le pasan, tal cual y en orden', () => {
    const ld = jsonLdProducto(M, 'https://babycaleb.com/productos/x', [
      EN_LA_WEB(FRENTE),
      EN_LA_WEB(DORSO),
    ]);
    expect(ld.image).toEqual([EN_LA_WEB(FRENTE), EN_LA_WEB(DORSO)]);
  });

  it('sin fotos no escribe el campo, que no es decir que no hay', () => {
    expect(jsonLdProducto(M, 'x')).not.toHaveProperty('image');
    expect(jsonLdProducto(M, 'x', [])).not.toHaveProperty('image');
  });

  it('y una ruta relativa no llega a Google', () => {
    // Google no tiene siempre la página delante para resolverla. Una foto que
    // no se puede abrir es peor que ninguna: se la cree y la intenta.
    expect(jsonLdProducto(M, 'x', [FRENTE])).not.toHaveProperty('image');
    expect(jsonLdProducto(M, 'x', [FRENTE, EN_LA_WEB(DORSO)]).image).toEqual([
      EN_LA_WEB(DORSO),
    ]);
  });
});
