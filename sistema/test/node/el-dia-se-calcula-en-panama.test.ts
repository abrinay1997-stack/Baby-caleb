import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ninguna prueba calcula un día con `toISOString()`.
 *
 * El sistema trabaja en hora de Panamá, cinco horas antes que UTC, y tiene una
 * sola función que convierte un instante en el día del negocio
 * (`fechaDePanama` / `fechaPanama`). Una prueba que calcula ese día por su
 * cuenta con `new Date(ms).toISOString().slice(0, 10)` obtiene el día de UTC,
 * que entre las 7 de la tarde y la medianoche de Panamá —de 00:00 a 05:00
 * UTC— es el día SIGUIENTE.
 *
 * Eso no da una prueba frágil: da una prueba que está **roja cinco horas cada
 * noche y verde el resto del día**. Pasó de verdad en
 * `devoluciones.test.ts`: el «ayer» que calculaba la prueba era el «hoy» del
 * código, así que la ruta sí se encontraba y la aserción fallaba. Nadie lo
 * había visto porque nadie corre la suite de madrugada; se destapó al correrla
 * a las 23:28 de Panamá, camino de un despliegue.
 *
 * Lo venenoso es que una prueba así enseña a reintentar. Se pone roja, se
 * vuelve a correr una hora después, sale verde, y se archiva como «cosa rara».
 * El día que haya un fallo de verdad a esa hora, va a recibir el mismo trato.
 *
 * Una prueba que calcula una fecha de otra manera que el código no está
 * probando el código: está probando otro sistema parecido.
 *
 * Vive en `test/node/` porque lee archivos, y dentro de workerd `node:fs` no
 * existe: ahí se saltaría en verde.
 */

const raiz = join(import.meta.dirname, "..", "..");

/** Todos los archivos de prueba del sistema, estén donde estén. */
function archivosDePrueba(dir: string, hasta: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === "node_modules" || entrada.name === "dist") continue;
    const camino = join(dir, entrada.name);
    if (entrada.isDirectory()) archivosDePrueba(camino, hasta);
    else if (entrada.name.endsWith(".test.ts")) hasta.push(camino);
  }
  return hasta;
}

describe("el día del negocio se calcula en un solo sitio", () => {
  const archivos = [
    ...archivosDePrueba(join(raiz, "src")),
    ...archivosDePrueba(join(raiz, "test")),
  ];

  it("hay pruebas que mirar", () => {
    // Si el recorrido se queda corto, el que falla es el recorrido: mejor
    // romper aquí que aprobar una lista vacía.
    expect(archivos.length).toBeGreaterThan(50);
  });

  it("ninguna recorta un día de un `toISOString()`", () => {
    const culpables: string[] = [];
    for (const archivo of archivos) {
      // Este archivo se salta a sí mismo: el patrón que busca está escrito en
      // su propia explicación de arriba, y sin esto la guardia se acusaría a
      // sí misma para siempre. Es la única excepción, y va por nombre exacto
      // para que no tape a ningún otro.
      if (archivo.endsWith("el-dia-se-calcula-en-panama.test.ts")) continue;
      const fuente = readFileSync(archivo, "utf8");
      // `toISOString()` entero está bien: lo que rompe es quedarse con los
      // diez primeros caracteres, que es justo el día.
      const lineas = fuente.split("\n");
      lineas.forEach((linea, i) => {
        if (/toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(linea)) {
          culpables.push(`${archivo.slice(raiz.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(
      culpables,
      `estas líneas calculan el día en UTC y el sistema trabaja en hora de ` +
        `Panamá: use \`fechaDePanama\` (db/entregas) o \`fechaPanama\` ` +
        `(dominio/metricas), que es el dueño de esa conversión. ` +
        `${culpables.join(", ")}`,
    ).toEqual([]);
  });

  it("y la función que lo convierte sigue existiendo donde se dice", () => {
    // Sin esto, la regla de arriba mandaría a usar algo que ya no está, y la
    // siguiente persona la borraría por inútil en vez de arreglarla.
    const entregas = readFileSync(join(raiz, "src", "db", "entregas.ts"), "utf8");
    const metricas = readFileSync(join(raiz, "src", "dominio", "metricas.ts"), "utf8");
    expect(entregas).toContain("export function fechaDePanama");
    expect(metricas).toContain("export function fechaPanama");
  });
});
