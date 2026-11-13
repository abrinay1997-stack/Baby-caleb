import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { soloCodigo } from './sin-comentarios';

/**
 * Los estados que nadie diseña, y las etiquetas que nadie lee en voz alta.
 *
 * Esto vigila cuatro cosas que se midieron rotas el 2026-11-13 en la tienda
 * pública y que una prueba de unidad corriente no puede ver, porque todas son
 * sintácticamente perfectas.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

function archivosDe(dir: string, ext = ['.tsx']): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) salida.push(...archivosDe(rel, ext));
    else if (ext.some((x) => e.name.endsWith(x))) salida.push(rel);
  }
  return salida;
}

/**
 * ## 1 · La dirección que no existe tiene página
 *
 * Sin una ruta comodín, `<Routes>` no pinta NADA: queda la barra arriba, el
 * pie debajo y un hueco en medio, sin `<main>`, sin encabezado y sin salida.
 * En un teléfono el logo del pie quedaba pegado bajo la barra y lo que se veía
 * era una tienda rota.
 *
 * No es un caso raro: el sitio reparte enlaces cortos `/p/<slug>` por WhatsApp
 * e Instagram, y un slug viejo cae justo aquí.
 *
 * Romper a propósito: quite la línea de `<Route path="*"` de `App.tsx`.
 */
describe('la dirección que no existe', () => {
  it('tiene su propia ruta', () => {
    const app = soloCodigo('src/App.tsx');
    expect(
      /<Route\s+path="\*"/.test(app),
      'Falta la ruta comodín en App.tsx. Sin ella, cualquier dirección mala pinta\n' +
        'la barra y el pie con un hueco en medio: sin <main>, sin <h1> y sin salida.',
    ).toBe(true);
  });

  it('y esa página tiene landmark, encabezado y por dónde salir', () => {
    const p = soloCodigo('src/pages/NoEncontrada.tsx');
    expect(p, 'la página de 404 necesita un <main> con el destino del salto al contenido')
      .toContain('id="main-content"');
    expect(p, 'necesita un <h1>: es lo primero que busca un lector de pantalla').toContain('<h1');
    expect(p, 'necesita llevar al catálogo').toContain('to="/productos"');
  });
});

/**
 * ## 2 · Un artículo que no se puede agregar dice POR QUÉ, y lo dice a la vista
 *
 * La fila de una presentación agotada se apagaba con `opacity-60` y la palabra
 * —«Agotado», «Máximo», «Un momento…»— vivía en un `sr-only`. O sea: quien usa
 * lector de pantalla se enteraba y quien MIRA la pantalla, no. Veía una fila
 * grisácea, sin el «+», sin saber si no hay existencias, si ya llegó al máximo
 * o si la página sigue cargando.
 *
 * Son dos fallos a la vez: comunicar solo con la opacidad (WCAG 1.4.1) y
 * dejar el texto en 2.35 contra el mínimo de 4.5 (WCAG 1.4.3), porque
 * `opacity` se aplica al pintar y hunde el contraste de verdad.
 *
 * Romper a propósito: devuelva `opacity-60` a `clases`, o vuelva a poner la
 * palabra dentro de un `sr-only`.
 */
describe('la presentación que no se puede agregar', () => {
  // Sin las líneas de comentario: el archivo EXPLICA por qué ya no lleva
  // `opacity-60`, y esa explicación lleva las palabras dentro.
  const fila = soloCodigo('src/carrito/FilaPresentacion.tsx');

  it('no se comunica apagando el texto', () => {
    expect(
      /opacity-\d/.test(fila),
      'Vuelve a haber una opacidad en FilaPresentacion. `opacity` se aplica al pintar:\n' +
        'hunde el contraste del texto por debajo de AA y, encima, deja el motivo contado\n' +
        'solo con el color. Baje el borde o el fondo, nunca el texto.',
    ).toBe(false);
  });

  it('enseña el motivo, no solo se lo cuenta al lector de pantalla', () => {
    // `dice` es la variable con el motivo. Lo que se vigila es que salga en
    // un nodo visible y no dentro de un `sr-only`.
    expect(fila, 'el motivo tiene que pintarse').toMatch(/\{dice\}/);
    expect(
      /sr-only[^>]*>\s*\{dice\}/.test(fila),
      'El motivo volvió a un `sr-only`: quien mira la pantalla se queda sin saber\n' +
        'por qué esa talla no se puede agregar.',
    ).toBe(false);
  });
});

/**
 * ## 3 · El nombre accesible CONTIENE el texto que se ve
 *
 * WCAG 2.5.3 (*Label in Name*), Nivel A. Un `aria-label` que no empieza por el
 * texto visible rompe el control por voz: quien dice «pulsa Pedir por
 * WhatsApp» no acierta un botón cuyo nombre es «Pedir Pañal Nateen Talla M por
 * WhatsApp». axe lo marcaba en seis sitios.
 *
 * La forma que se usa en todo el sitio es `texto visible: detalle`.
 *
 * Romper a propósito: cambie el `aria-label` de `PedirPorWhatsapp` a
 * `Pedir ${variante.nombre} por WhatsApp`.
 */
describe('el nombre accesible empieza por el texto visible', () => {
  /**
   * Las parejas que se vigilan: archivo, lo que se lee en pantalla y cómo
   * tiene que empezar el `aria-label`.
   */
  const PAREJAS: { archivo: string; visible: string }[] = [
    { archivo: 'src/components/PedirPorWhatsapp.tsx', visible: 'Pedir por WhatsApp' },
    { archivo: 'src/components/PedirPorWhatsapp.tsx', visible: 'Avísenme cuando entre' },
    { archivo: 'src/blocks/S09Products.tsx', visible: 'Pedir por WhatsApp' },
    { archivo: 'src/components/CompartirProducto.tsx', visible: 'Compartir este producto' },
  ];

  for (const { archivo, visible } of PAREJAS) {
    it(`«${visible}» en ${archivo.split('/').pop()}`, () => {
      const crudo = soloCodigo(archivo);
      // El texto se ve en la pantalla…
      expect(crudo, `«${visible}» ya no aparece como texto visible`).toContain(visible);
      // …y hay un `aria-label` que empieza por él. Se busca la plantilla
      // literal, que es como se escribe: `` `Pedir por WhatsApp: ${…}` ``.
      expect(
        crudo.includes('`' + visible + ':'),
        `El nombre accesible de «${visible}» no empieza por el texto visible.\n` +
          'WCAG 2.5.3: quien maneja el teléfono por voz pide el botón por lo que LEE.\n' +
          'La forma del sitio es `texto visible: detalle`.',
      ).toBe(true);
    });
  }
});

/**
 * ## 4 · Nada de letra por debajo de 12 px escrita a mano
 *
 * `--fs-mono` valía 11 px y además GANABA a cualquier `text-xs`, porque la
 * clase `.mono` vive fuera de toda capa y las utilidades de Tailwind v4 van en
 * `@layer utilities`. Encima había `text-[10px]` y `text-[11px]` sueltos.
 * Medido a 390 px: once textos por debajo del piso en cinco páginas.
 *
 * El piso de 12 px es el §7c de `docs/design-system.md`.
 *
 * Romper a propósito: ponga `text-[10px]` en cualquier bloque, o devuelva
 * `--fs-mono` a `0.6875rem`.
 */
describe('el piso de 12 px', () => {
  it('ningún tamaño arbitrario por debajo de 12 px en el código', () => {
    const malos: string[] = [];
    for (const archivo of [...archivosDe('src')]) {
      const crudo = soloCodigo(archivo);
      for (const [i, linea] of crudo.split('\n').entries()) {
        const t = linea.trim();
        if (t.startsWith('*') || t.startsWith('//')) continue;
        for (const m of linea.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
          if (Number(m[1]) < 12) malos.push(`${archivo}:${i + 1}  ${m[0]}`);
        }
      }
    }
    expect(
      malos,
      'Texto por debajo del piso de 12 px (§7c de docs/design-system.md).\n' +
        'Si no se puede leer en el teléfono de una mamá al sol, no está.\n\n' +
        malos.join('\n'),
    ).toEqual([]);
  });

  it('y el token de los rótulos tampoco baja de ahí', () => {
    const tokens = readFileSync(join(RAIZ, 'src/styles/tokens.css'), 'utf8');
    const m = /--fs-mono:\s*([0-9.]+)rem/.exec(tokens);
    expect(m, 'ya no se encuentra --fs-mono en tokens.css').not.toBeNull();
    const px = Number(m![1]) * 16;
    expect(
      px,
      `--fs-mono vale ${px}px. Es el tamaño de los rótulos que ordenan la página\n` +
        '(«01 / Catálogo»), y la clase `.mono` le gana a `text-xs` porque va sin capa.',
    ).toBeGreaterThanOrEqual(12);
  });
});
