import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ni una rebaja, ni una cuota, que no venga de un dato.
 *
 * ## Qué pasó
 *
 * El dueño pidió cuatro cosas para la ficha de producto. Dos se hicieron. Las
 * otras dos **no se pueden hacer hoy sin inventarlas**:
 *
 *  - «el descuento, con el precio anterior tachado y el porcentaje». Una
 *    variante trae UN campo de dinero, `precioCents`, y nada más
 *    (`src/hooks/useCatalogo.ts`). El `descuento_cents` del sistema es de un
 *    PEDIDO entero y se prorratea entre sus líneas; `precios_historial` es el
 *    libro de cambios de precio. Ninguno de los dos es un «antes» de este
 *    artículo: sacar de ahí una fila vieja y tacharla fabricaría una rebaja
 *    que la dueña nunca declaró.
 *  - «las cuotas y el precio con transferencia, a la vista». Las cuotas son
 *    del banco y no están en ninguna tabla de este proyecto; la transferencia
 *    es una forma de anotar un pago ya hecho, no una segunda tarifa.
 *
 * ## Por qué hace falta una prueba y no basta con un comentario
 *
 * Porque el daño es invisible al compilar. `<s>$65</s> <span>-23 %</span>` es
 * JSX perfecto: el typecheck pasa, el build pasa, la auditoría de contraste
 * pasa. Lo único que no pasa es la verdad — y en una tienda, un descuento
 * inventado es publicidad engañosa, no un detalle de diseño. Es exactamente la
 * forma del fallo de `test/sin-precios-a-mano.test.ts`: la portada tuvo «Desde
 * $17» escrito a mano durante semanas mientras el pañal más barato costaba
 * $45, y ninguna de las 148 pruebas podía verlo.
 *
 * `CLAUDE.md` lo dice en cuatro palabras: **ninguna cifra a ojo**.
 *
 * ## El día que el dato exista
 *
 * Esta prueba no es un «no, nunca». Es un «no, mientras no haya de dónde».
 * Cuando el sistema mande un segundo campo de dinero por variante —o un ajuste
 * de cuotas—, lo que se hace es añadir aquí el nombre del campo que lo
 * respalda y dejar que la pantalla lo calcule de él. Lo que no se hace es
 * escribir el texto a mano mientras tanto: un aviso que alguien tiene que
 * acordarse de borrar es la siguiente mentira esperando turno
 * (`docs/TRAMPAS.md` §13).
 */

const RAIZ = new URL('..', import.meta.url).pathname;

/**
 * Lo que no se puede decir sin un dato detrás, y qué dato haría falta.
 *
 * Cada entrada lleva su porqué. Una lista de prohibiciones sin explicación se
 * borra entera el día que estorba.
 */
const SIN_DATO: { patron: RegExp; promete: string; haríaFalta: string }[] = [
  {
    patron: /line-through/,
    promete: 'un precio tachado, o sea que antes costaba más',
    haríaFalta: 'un segundo campo de dinero por variante en /api/catalogo',
  },
  {
    patron: /\bahorr(a|as|e|o)\b/i,
    promete: 'que la clienta se ahorra una cantidad',
    haríaFalta: 'el precio anterior, para poder restar',
  },
  {
    patron: /precio\s+(regular|normal|anterior|antes)/i,
    promete: 'que hay otro precio más alto',
    haríaFalta: 'ese otro precio, en el catálogo',
  },
  {
    patron: /\bcuotas?\b/i,
    promete: 'pagar en partes',
    haríaFalta: 'cuántas cuotas y a qué interés, del banco o de un ajuste',
  },
  {
    patron: /sin\s+inter(é|e)s(es)?/i,
    promete: 'que financiar no cuesta nada',
    haríaFalta: 'lo mismo: el plan de cuotas, declarado en algún sitio',
  },
  {
    patron: /meses\s+sin/i,
    promete: 'una promoción de meses',
    haríaFalta: 'lo mismo',
  },
  {
    patron: /\d\s*%\s*(de\s+)?(descuento|dcto|off)/i,
    promete: 'un porcentaje de rebaja',
    haríaFalta: 'el precio anterior, para poder calcularlo',
  },
];

function archivosDe(dir: string): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) salida.push(...archivosDe(rel));
    else if (e.name.endsWith('.tsx')) salida.push(rel);
  }
  return salida;
}

/**
 * Un comentario SÍ puede nombrar lo prohibido: el comentario que explica por
 * qué no se escribe un descuento lleva la palabra «descuento» dentro.
 */
const esComentario = (linea: string): boolean => {
  const l = linea.trim();
  return l.startsWith('*') || l.startsWith('//') || l.startsWith('/*');
};

describe('ninguna rebaja ni cuota inventada', () => {
  it('no hay quien la escriba en las páginas ni en los componentes', () => {
    const archivos = [...archivosDe('src/pages'), ...archivosDe('src/components')];

    // Sin esto, un barrido que no encuentre archivos compararía dos listas
    // vacías y diría que todo está bien: la trampa §1.
    expect(archivos.length, 'no se leyó ningún .tsx').toBeGreaterThan(10);

    const promesas: string[] = [];
    for (const archivo of archivos) {
      const lineas = readFileSync(join(RAIZ, archivo), 'utf8').split('\n');
      lineas.forEach((linea, i) => {
        if (esComentario(linea)) return;
        for (const { patron, promete, haríaFalta } of SIN_DATO) {
          if (patron.test(linea)) {
            promesas.push(
              `${archivo}:${i + 1}  promete ${promete}\n` +
                `    haría falta: ${haríaFalta}\n` +
                `    ${linea.trim().slice(0, 90)}`,
            );
          }
        }
      });
    }

    expect(
      promesas,
      'Esto le promete a la clienta algo que ningún dato respalda.\n' +
        'Si el dato ya existe, nómbrelo en SIN_DATO y haga que la pantalla lo calcule de él.\n' +
        'Si no existe, no se escribe: CLAUDE.md dice «ninguna cifra a ojo».\n\n' +
        promesas.join('\n'),
    ).toEqual([]);
  });
});
