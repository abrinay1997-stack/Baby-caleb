import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISOS, permisosDe } from "../src/seguridad/roles";

/**
 * El panel de muestra tiene que decir la verdad.
 *
 * `panel-de-muestra.mjs` sirve el panel con datos inventados para poder
 * auditarlo y hacerle capturas. Lo inventado es a propósito —montarlo contra
 * una D1 de verdad metería datos de clientas en un proceso que existe para
 * hacer capturas—, pero la FORMA no se inventa: si los permisos de la muestra
 * se separan de los de verdad, la auditoría aprueba una navegación que en
 * producción sale distinta, y como es un `.mjs` no lo vigila el typecheck.
 *
 * Esta prueba corre en Node (vitest.node.config.ts) y no en workerd, donde
 * `node:fs` no existe y se saltaría en silencio.
 */

// Ruta de texto y no `new URL(...)`: el proyecto carga los tipos de workerd,
// cuyo `URL` no es el de Node, y la sobrecarga de `readFile` no casa.
const fuente = await readFile(join(import.meta.dirname, "panel-de-muestra.mjs"), "utf8");

/** Lee un objeto literal del guion, por su nombre. */
function clavesDe(nombre: string): string[] {
  const bloque = new RegExp(`const ${nombre} = \\{([\\s\\S]*?)\\n\\};`).exec(fuente);
  if (bloque === null) throw new Error(`no encontré ${nombre} en panel-de-muestra.mjs`);
  return [...bloque[1]!.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!).sort();
}

describe("el panel de muestra", () => {
  it("usa los permisos de verdad de la dueña, ni uno más ni uno menos", () => {
    expect(clavesDe("PERMISOS_DUENA")).toEqual(Object.keys(permisosDe("duena")).sort());
  });

  it("y esos permisos son los que declara el contrato de roles", () => {
    // Si alguien añade un permiso a PERMISOS y se olvida de la matriz, esto lo
    // dice antes de que la muestra y la realidad se separen por ahí.
    expect(Object.keys(permisosDe("duena")).sort()).toEqual([...PERMISOS].sort());
  });

  it("responde a todas las rutas que el panel pide al abrir", async () => {
    const rutas = [...fuente.matchAll(/"(\/api\/[a-z]+)":/g)].map((m) => m[1]!);
    // Las siete pantallas más `/yo`. Si se añade una pantalla y no su muestra,
    // la auditoría la vería como un 404 y no como una pantalla.
    for (const r of ["/api/yo", "/api/resumen", "/api/catalogo", "/api/existencias",
                     "/api/bodegas", "/api/zonas", "/api/ajustes", "/api/usuarios"]) {
      expect(rutas, `falta la muestra de ${r}`).toContain(r);
    }
  });
});
