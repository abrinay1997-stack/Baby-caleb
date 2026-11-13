import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fotoDeVariante, fotoDelProducto } from '../src/components/FotoDeProducto';
import type { Catalogo, VariantePublica } from '../src/hooks/useCatalogo';
import { soloCodigo } from './sin-comentarios';

/**
 * La foto que la dueña sube en el panel tiene que llegar a la TIENDA.
 *
 * La cadena existía entera menos el último eslabón: la foto se subía, se
 * convertía, se guardaba en R2 y `/foto/<clave>` la servía con un 200 — pero el
 * catálogo público no llevaba el campo, así que la tienda seguía pintando la de
 * `content.json` y la foto subida no se veía en ninguna parte. Desde el panel
 * eso se lee como «no se puede poner una foto», que es lo único que se puede
 * leer cuando no aparece nada.
 *
 * Lo que se vigila aquí es QUIÉN GANA y QUÉ PASA CUANDO LA FOTO NO ESTÁ. La
 * forma de la ruta la vigila el sistema, que es su dueño
 * (`sistema/src/rpc/foto-del-catalogo.test.ts`).
 */

const RAIZ = resolve(import.meta.dirname, '..');
const leer = (r: string) => readFileSync(join(RAIZ, r), 'utf8');

const DEL_SISTEMA = '/foto/catalogo/NAT-M/01HXQ2W3E4R5T6Y7U8I9O0P1A2.webp';
const DE_CONTENIDO = '/img/producto-caja-m.png';

/** Una variante del catálogo con lo justo para esta decisión. */
const variante = (imagen?: string | null): Pick<VariantePublica, 'imagen'> =>
  imagen === undefined ? {} : { imagen };

describe('la foto de una ficha de producto', () => {
  it('si el sistema tiene foto, manda la del sistema', () => {
    expect(fotoDeVariante(variante(DEL_SISTEMA), DE_CONTENIDO)).toEqual({
      src: DEL_SISTEMA,
      // La de `content.json` no desaparece: se queda detrás por si la otra no
      // carga. No es una segunda verdad, es la red.
      respaldo: DE_CONTENIDO,
    });
  });

  it('sin foto subida, se enseña la de content.json — como hasta hoy', () => {
    // Es el caso de los doce artículos reales: ninguno tiene foto todavía.
    expect(fotoDeVariante(variante(null), DE_CONTENIDO)).toEqual({ src: DE_CONTENIDO });
    expect(fotoDeVariante(variante(undefined), DE_CONTENIDO)).toEqual({ src: DE_CONTENIDO });
    // La copia del build puede ser anterior a este campo: ausente es «no hay».
    expect(fotoDeVariante({}, DE_CONTENIDO)).toEqual({ src: DE_CONTENIDO });
  });

  it('una cadena vacía es «no hay foto», no una foto vacía', () => {
    // Un `<img src="">` pide la PÁGINA otra vez: no falla, no avisa, y deja un
    // hueco con una petición de más.
    expect(fotoDeVariante(variante(''), DE_CONTENIDO)).toEqual({ src: DE_CONTENIDO });
    expect(fotoDeVariante(variante('   '), DE_CONTENIDO)).toEqual({ src: DE_CONTENIDO });
  });

  it('y sin ninguna de las dos no se pinta ninguna caja', () => {
    // La ficha lleva así desde siempre con los productos sin foto: no hay
    // marco vacío, no hay icono roto.
    expect(fotoDeVariante(variante(null), undefined)).toBeUndefined();
    expect(fotoDeVariante(undefined, undefined)).toBeUndefined();
  });

  it('sin variante en el catálogo, la de content.json sigue saliendo', () => {
    // Pasa mientras el catálogo no ha llegado todavía.
    expect(fotoDeVariante(undefined, DE_CONTENIDO)).toEqual({ src: DE_CONTENIDO });
  });
});

describe('la foto de una tarjeta del catálogo', () => {
  const catalogo = (fotos: Record<string, string | null>): Catalogo =>
    new Map(
      Object.entries(fotos).map(([codigo, imagen]) => [
        codigo,
        { codigo, imagen } as VariantePublica,
      ]),
    );

  const producto = {
    image: '/img/producto-panal-nateen-s.png',
    variants: [{ codigo: 'NAT-RN' }, { codigo: 'NAT-S' }, { codigo: 'NAT-M' }],
  };

  it('la primera presentación con foto subida es la que se enseña', () => {
    // La dueña sube la foto de UNA caja y la tarjeta ya cambia: no hay que
    // subir las seis para ver algo.
    const r = fotoDelProducto(producto, catalogo({ 'NAT-RN': null, 'NAT-S': DEL_SISTEMA }));
    expect(r).toEqual({ src: DEL_SISTEMA, respaldo: producto.image });
  });

  it('y se respeta el orden en que la tarjeta las lista', () => {
    const otra = '/foto/catalogo/NAT-M/01HXQ2W3E4R5T6Y7U8I9O0P1B3.webp';
    const r = fotoDelProducto(producto, catalogo({ 'NAT-S': DEL_SISTEMA, 'NAT-M': otra }));
    expect(r?.src).toBe(DEL_SISTEMA);
  });

  it('si ninguna tiene foto, la del producto en content.json', () => {
    const r = fotoDelProducto(producto, catalogo({ 'NAT-S': null }));
    expect(r).toEqual({ src: producto.image });
  });

  it('una presentación sin código no rompe la tarjeta', () => {
    // Las toallitas sueltas y el fular no los maneja el sistema.
    const r = fotoDelProducto(
      { image: producto.image, variants: [{}, { codigo: 'NAT-S' }] },
      catalogo({ 'NAT-S': DEL_SISTEMA }),
    );
    expect(r?.src).toBe(DEL_SISTEMA);
  });

  it('un producto sin foto ninguna no pinta nada', () => {
    expect(fotoDelProducto({ variants: [{ codigo: 'NAT-S' }] }, catalogo({}))).toBeUndefined();
  });
});

/**
 * El prefijo `/foto/` se escribe en TRES sitios y tiene que ser el mismo.
 *
 * Lo guarda el panel al subir la foto, lo sirve el sistema en `/foto/*` y lo
 * sirve la web en `worker/imagenes.ts`. Si uno cambia sin los otros, todas las
 * fotos se quedan en 404 — y eso ya pasó una vez con `/img/`, que dejó el sitio
 * entero sin imágenes en producción. Es la trampa §8: la lista de configuración
 * que alguien tiene que acordarse de tocar.
 *
 * Se leen como TEXTO a propósito: `sistema/` tiene su propio tsconfig y sus
 * propios tipos de Workers, así que importarlo desde aquí rompe `npm run lint`.
 */
describe('el prefijo de las fotos es el mismo en los dos lados', () => {
  const constante = (archivo: string, nombre: string): string => {
    const m = new RegExp(`${nombre}\\s*=\\s*"([^"]+)"`).exec(leer(archivo));
    expect(m, `no se encontró ${nombre} en ${archivo}`).not.toBeNull();
    return m?.[1] ?? '';
  };

  it('el que publica el sistema es el que sirve la web', () => {
    expect(constante('sistema/src/rpc/catalogo.ts', 'PREFIJO_FOTO')).toBe(
      constante('worker/imagenes.ts', 'PREFIJO'),
    );
  });

  it('y la web no lo sirve bajo /img/, que ya es de las imágenes del sitio', () => {
    expect(constante('worker/imagenes.ts', 'PREFIJO')).toBe('/foto/');
  });
});

/**
 * La copia del build es la OTRA puerta por la que una foto entra en la tienda.
 *
 * Lo que viene del sistema pasa por `fotoPublica`, que no deja salir nada
 * absoluto. La copia del build no pasa por ahí: es un archivo de este
 * repositorio que el navegador lee tal cual, así que un `https://panel…` metido
 * a mano se saltaría la guarda entera y la foto no se vería nunca — el fallo
 * original, otra vez y por la puerta de al lado.
 *
 * Hoy ninguna variante de la copia trae foto (en producción no hay ninguna
 * subida todavía), así que esta prueba no acusa a nadie: existe para el día que
 * la haya. Se comprobó que se pone roja poniéndole una absoluta a mano.
 */
describe('la copia del build no mete fotos de otro dominio', () => {
  it('toda foto de la copia es una ruta relativa del sistema', () => {
    const copia = JSON.parse(leer('src/data/catalogo.respaldo.json')) as {
      variantes: { codigo: string; imagen?: string | null }[];
    };
    const malas = copia.variantes
      .filter((v) => typeof v.imagen === 'string' && !v.imagen.startsWith('/foto/'))
      .map((v) => `${v.codigo} → ${v.imagen}`);
    expect(malas, `fotos que no son del sistema: ${malas.join(', ')}`).toEqual([]);
  });
});

/**
 * Y que la pieza esté ENCHUFADA, que es la trampa §12.
 *
 * Las funciones de arriba pueden estar perfectas y probadas y no servir de
 * nada: eso es exactamente lo que pasó con el campo del catálogo —todo
 * construido menos el último cable— y lo que volvería a pasar si mañana
 * alguien pinta una foto de `content.json` a mano «porque es más corto».
 *
 * Son las tres pantallas que enseñan la foto de un producto: la ficha, la
 * tarjeta del catálogo y la rejilla de presentaciones. Si nace una cuarta,
 * esta lista hay que tocarla (trampa §8: la otra lista que alguien tiene que
 * acordarse de tocar).
 */
describe('las pantallas que enseñan fotos preguntan quién gana', () => {
  const PANTALLAS = [
    'src/pages/FichaProducto.tsx',
    'src/blocks/S09Products.tsx',
    'src/blocks/S10Gallery.tsx',
  ];

  it('las tres pintan la foto con el decisor, no con un <img> suyo', () => {
    for (const pantalla of PANTALLAS) {
      expect(soloCodigo(pantalla), pantalla).toMatch(/<FotoDeProducto/);
    }
  });

  it('y ninguna pinta la de content.json directamente', () => {
    // `src={product.image}` era el código de ayer: la tienda enseñando la foto
    // del repositorio mientras la del panel no se veía en ninguna parte.
    for (const pantalla of PANTALLAS) {
      expect(soloCodigo(pantalla), pantalla).not.toMatch(/src=\{[^}]*\.image\}/);
    }
  });
});
