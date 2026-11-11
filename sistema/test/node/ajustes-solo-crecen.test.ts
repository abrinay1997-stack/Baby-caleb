import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `ajustes` solo crece: nadie edita ni borra una versión.
 *
 * Es la propiedad que hace que la tabla sirva para contestar «¿quién bajó la
 * comisión en marzo?», y es una AUSENCIA: hoy ningún `UPDATE` toca `ajustes`,
 * pero nada impide que mañana alguien añada uno «para arreglar una errata en el
 * motivo». Ese día desaparecería una respuesta y ninguna prueba de
 * comportamiento se enteraría, porque el comportamiento visible sería el mismo.
 *
 * Así que esto mira el código fuente. Vive en `test/node/` y no al lado del
 * módulo porque `node:fs` no existe dentro de workerd: ahí la prueba se
 * saltaría en silencio, pasando en verde sin comprobar nada. Es la misma
 * lección que dejó escrita `scripts/panel-de-muestra.test.ts`.
 */

const fuente = await readFile(
  join(import.meta.dirname, "..", "..", "src", "db", "ajustes.ts"),
  "utf8",
);

describe("el módulo de ajustes", () => {
  it("no actualiza ni borra ninguna versión", () => {
    expect(fuente).not.toMatch(/UPDATE\s+ajustes/i);
    expect(fuente).not.toMatch(/DELETE\s+FROM\s+ajustes/i);
    // `OR REPLACE` y `OR IGNORE` son las dos formas de pisar o de no escribir
    // sin que nada falle: la primera borra la versión de otro, la segunda deja
    // el batch seguir como si hubiera guardado.
    expect(fuente).not.toMatch(/INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO\s+ajustes/i);
  });

  it("y sí inserta la versión siguiente", () => {
    // Sin esto, borrar el INSERT entero dejaría las tres comprobaciones de
    // arriba en verde: una tabla a la que nadie escribe tampoco se edita.
    expect(fuente).toMatch(/INSERT INTO ajustes/);
  });
});
