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

/** El archivo tal cual, cuando lo que se quiere mirar ES el texto entero. */
export const leerCrudo = (rel: string): string => readFileSync(join(RAIZ, rel), 'utf8');
