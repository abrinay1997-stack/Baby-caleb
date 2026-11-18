import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = new URL('..', import.meta.url).pathname;

/**
 * Un archivo del repositorio, sin una sola línea de comentario.
 *
 * ## Por qué existe, y por qué vive en UN solo sitio
 *
 * Varias pruebas de `test/` leen el código fuente y comprueban que algo esté
 * —o que algo ya NO esté—. En este repositorio eso choca de frente con una
 * costumbre buena: los comentarios cuentan lo que se quitó y por qué, con las
 * palabras dentro. `FilaPresentacion.tsx` explica por qué ya no lleva
 * `opacity-60`; `NoEncontrada.tsx` cuenta que antes no había `<h1>`;
 * `Chatbot.tsx` nombra el `role="log"` al explicar que faltaba.
 *
 * Resultado: una prueba que busca esas palabras las encuentra en la
 * explicación y aprueba con el código roto. Pasó tres veces seguidas al
 * validar estas mismas pruebas rompiendo a propósito lo que vigilan
 * (`docs/TRAMPAS.md` §6), y las tres veces la causa fue la misma.
 *
 * Está aquí y no copiado en cada prueba porque las tres primeras copias ya se
 * habían separado: una quitaba `*` y `//`, otra `/*`, y ninguna los
 * comentarios de JSX —`{/* … *}`— que son los que más se usan dentro del
 * marcado. Una regla copiada tres veces es tres reglas distintas esperando a
 * discrepar.
 *
 * No es un analizador de JavaScript y no pretende serlo: una cadena de texto
 * que contenga `//` se recorta de más. Para lo que se usa —comprobar que una
 * clase, un atributo o una llamada siguen en el código— eso no estorba, y
 * equivocarse por ese lado es el lado seguro: de más, nunca de menos.
 */
export function soloCodigo(rel: string): string {
  return (
    readFileSync(join(RAIZ, rel), 'utf8')
      // Los comentarios de JSX —`{/* … *}`— primero, porque ocupan varias
      // líneas y ninguna de ellas empieza por `/*`.
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      // Y los bloques `/* … */` de JavaScript, incluidos los docstrings.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
  );
}

/**
 * Lo mismo, pero conservando el NÚMERO de cada línea.
 *
 * `soloCodigo` borra las líneas de comentario, así que lo que queda ya no se
 * puede citar por número: la línea 40 de su resultado no es la 40 del archivo.
 * Para una prueba que solo busca si algo está, da igual; para una que señala
 * DÓNDE está lo que encontró —«src/x.tsx:78»— un número corrido manda a quien
 * lo lee a la línea equivocada.
 *
 * Aquí el comentario se sustituye por sus propios saltos de línea: desaparece
 * el texto y el archivo conserva su forma. Es la misma regla de arriba y vive
 * en el mismo archivo a propósito — copiarla sería volver a tener dos.
 *
 * Nació porque el escáner de precios escritos a mano llevaba su propia versión
 * —saltarse las líneas que empiezan por `*` o `//`— que no conocía los
 * comentarios de JSX, los que más se usan dentro del marcado. Marcó como
 * precio a mano el comentario que explica por qué una etiqueta lleva
 * `translate="no"`, y ese comentario lleva un «$50» dentro por fuerza.
 */
export function codigoPorLineas(rel: string): string[] {
  const soloSaltos = (trozo: string): string => trozo.replace(/[^\n]/g, '');
  return (
    readFileSync(join(RAIZ, rel), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, soloSaltos)
      .replace(/\/\*[\s\S]*?\*\//g, soloSaltos)
      .split('\n')
      .map((l) => (l.trim().startsWith('//') ? '' : l))
  );
}

/** El archivo tal cual, cuando lo que se quiere mirar ES el texto entero. */
export const leerCrudo = (rel: string): string => readFileSync(join(RAIZ, rel), 'utf8');
