import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La tienda y el sistema tienen que estar de acuerdo sobre QUÉ productos hay.
 *
 * Esta prueba existe por un fallo que nadie podía ver y que destapó el dueño
 * mirando la página con sus propios ojos.
 *
 * El precio viene vivo de la base: eso funciona. Pero **qué productos existen**
 * lo decide `content.json`, una lista escrita a mano en este repositorio. Son
 * dos fuentes para un mismo hecho, y en cuanto hay dos, se separan:
 *
 *   - `DANY-AW1200` —las toallitas de 1 200— está sembrado por la migración
 *     0003, publicado, con precio y con ficha propia viva en el sitio. No está
 *     en la lista de ningún producto de `content.json`, así que la tienda no lo
 *     enseña, el bot ni siquiera tiene el código y el chat de la web dice que
 *     «ya no hay combo de 2 cajas». Un producto de 40 dólares que ningún canal
 *     sabe vender.
 *   - Y al revés: un producto nuevo dado de alta desde el panel sale con su
 *     pastilla verde «En la web» y **no aparece en la tienda jamás**, porque
 *     nadie editó este archivo. La dueña lo configura, lo ve en verde, y no
 *     pasa nada.
 *
 * Lo que se vigila es la DESCONEXIÓN, no un catálogo concreto: que no se pueda
 * añadir una presentación por un lado y olvidarla por el otro sin que algo se
 * ponga rojo. Es «un dato, un solo dueño» del `CLAUDE.md`, comprobado en vez
 * de prometido.
 *
 * Esto NO sustituye a mirar la producción: la base en vivo puede tener
 * productos que ninguna migración siembra (los que se dan de alta desde el
 * panel). Para eso está `sistema/scripts/cables.mjs`, que compara contra la
 * web de verdad. Esta prueba es la que corre en cada cambio, sin credenciales,
 * y caza la desconexión antes de que llegue a producción.
 */

const raiz = join(import.meta.dirname, '..');

/** Los códigos que el repositorio siembra en la base del sistema. */
function codigosDelSistema(): Set<string> {
  const dir = join(raiz, 'sistema', 'migrations');
  const codigos = new Set<string>();
  for (const archivo of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, archivo), 'utf8');
    // Solo los bloques que insertan variantes. Buscar códigos en todo el
    // archivo cazaría los de un comentario o los de otra tabla.
    for (const bloque of sql.split(/INSERT\s+INTO\s+variantes/i).slice(1)) {
      const hasta = bloque.indexOf(';');
      for (const m of (hasta === -1 ? bloque : bloque.slice(0, hasta)).matchAll(
        /'([A-Z]{2,}[A-Z0-9-]*)'/g,
      )) {
        const c = m[1] as string;
        // Las tallas y las familias también van entre comillas en esas filas.
        if (/^(RN|S|M|L|XL|XXL|PANAL|TOALLITA|PORTEO)$/.test(c)) continue;
        codigos.add(c);
      }
    }
  }
  return codigos;
}

/** Los códigos que la tienda pinta de verdad. */
function codigosDeLaTienda(): Set<string> {
  const contenido = JSON.parse(readFileSync(join(raiz, 'content.json'), 'utf8')) as {
    products?: { descatalogado?: boolean; variants?: { codigo?: string }[] }[];
  };
  const codigos = new Set<string>();
  for (const p of contenido.products ?? []) {
    // Un producto descatalogado no se pinta (`S09Products.tsx` lo filtra), así
    // que sus códigos no cuentan como «la tienda los enseña».
    if (p.descatalogado === true) continue;
    for (const v of p.variants ?? []) if (v.codigo) codigos.add(v.codigo);
  }
  return codigos;
}

/**
 * Lo que está en el sistema y NO en la tienda **a propósito**.
 *
 * La lista es la válvula que hace honesta a esta prueba: sin ella, la única
 * forma de ponerla en verde sería enseñar todo, y alguien acabaría borrándola.
 * Con ella, dejar algo fuera sigue siendo posible — pero hay que escribir aquí
 * por qué, y eso es justo lo que no pasó con DANY-AW1200.
 */
const FUERA_A_PROPOSITO: Record<string, string> = {
  'DANY-AW1200':
    'PENDIENTE de decisión de la dueña. Está publicado y con precio en el sistema ' +
    '($40) y con ficha viva, pero no lo enseña la tienda, no lo tiene el bot y el ' +
    'chat de la web dice que ya no existe. O se enseña en los tres sitios o se ' +
    'retira en el sistema; hoy es un producto que nadie puede comprar.',
};

describe('la tienda y el sistema dicen los mismos productos', () => {
  it('el repositorio siembra un catálogo que se puede leer', () => {
    // Si el lector se queda corto, el que falla es el lector y no el sistema:
    // mejor romper aquí que dar por buena una comparación de listas vacías.
    expect(codigosDelSistema().size).toBeGreaterThanOrEqual(10);
    expect(codigosDeLaTienda().size).toBeGreaterThanOrEqual(10);
  });

  it('todo lo que publica el sistema se enseña en la tienda', () => {
    const sistema = codigosDelSistema();
    const tienda = codigosDeLaTienda();
    const invisibles = [...sistema].filter(
      (c) => !tienda.has(c) && FUERA_A_PROPOSITO[c] === undefined,
    );
    expect(
      invisibles,
      `están en el sistema y la tienda no los enseña: ${invisibles.join(', ')}. ` +
        'O se añaden a content.json, o se declaran en FUERA_A_PROPOSITO con el motivo.',
    ).toEqual([]);
  });

  it('y la tienda no promete nada que el sistema no tenga', () => {
    // Este lado es el peor de los dos: una clienta tocando «Pedir» sobre un
    // código que no existe en la base.
    const sistema = codigosDelSistema();
    const fantasmas = [...codigosDeLaTienda()].filter((c) => !sistema.has(c));
    expect(
      fantasmas,
      `la tienda los ofrece y el sistema no los tiene: ${fantasmas.join(', ')}`,
    ).toEqual([]);
  });

  it('lo que se deja fuera a propósito lleva su motivo escrito', () => {
    for (const [codigo, motivo] of Object.entries(FUERA_A_PROPOSITO)) {
      // Un motivo de tres palabras no es un motivo: es una casilla marcada.
      expect(motivo.length, `«${codigo}» necesita un motivo de verdad`).toBeGreaterThan(40);
      // Y tiene que seguir existiendo en el sistema: si ya se retiró, la
      // excepción sobra y hay que quitarla de aquí.
      expect(
        codigosDelSistema().has(codigo),
        `«${codigo}» ya no está en el sistema: quite la excepción`,
      ).toBe(true);
    }
  });
});
