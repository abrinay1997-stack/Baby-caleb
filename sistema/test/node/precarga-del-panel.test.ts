import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La lista de precarga no puede quedarse vieja en silencio.
 *
 * `main.tsx` lanza la petición de la pantalla que se está abriendo antes de
 * montar React, para que viaje a la vez que `/api/yo` en vez de esperarla. El
 * problema es que eso crea una SEGUNDA lista —la de «qué pide cada pantalla»—
 * que alguien tiene que acordarse de tocar cuando una pantalla cambie de ruta.
 *
 * Esa es, literalmente, la clase de fallo que este repositorio lleva todo el
 * día cerrando: una lista a mano que se separa de la verdad sin que nada lo
 * diga. Una precarga que apunta a una ruta que ya no existe no rompe nada
 * —la pantalla vuelve a pedir— y por eso nadie se enteraría: lo único que
 * pasa es que se manda una consulta de más y la lentitud vuelve.
 *
 * Así que la lista se comprueba contra las pantallas de verdad: cada camino
 * tiene que estar en el enrutador, y la ruta que se precarga tiene que ser una
 * que esa pantalla pida.
 *
 * Vive en `test/node/` porque lee archivos, y dentro de workerd `node:fs` no
 * existe: ahí se saltaría en verde.
 */

const raiz = join(import.meta.dirname, "..", "..");
const leer = (...partes: string[]): string =>
  readFileSync(join(raiz, ...partes), "utf8");

const main = leer("panel", "src", "main.tsx");
const app = leer("panel", "src", "App.tsx");

/** Lo que `main.tsx` precarga: camino de la pantalla → ruta de la API. */
function laLista(): [string, string][] {
  const bloque = main.match(/DATOS_DE_LA_PANTALLA[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (bloque === null) throw new Error("no encontré DATOS_DE_LA_PANTALLA en main.tsx");
  return [...(bloque[1] as string).matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(
    (m) => [m[1] as string, m[2] as string],
  );
}

/** Qué archivo de pantalla pinta cada camino, según el enrutador. */
function pantallaDe(camino: string): string | null {
  if (camino === "/") {
    const m = app.match(/<Route index element=\{<(\w+)/);
    return m === null ? null : (m[1] as string);
  }
  const limpio = camino.replace(/^\//, "");
  const m = app.match(new RegExp(`path="${limpio}"\\s+element=\\{<(\\w+)`));
  return m === null ? null : (m[1] as string);
}

describe("lo que el panel precarga es lo que la pantalla pide", () => {
  it("la lista existe y no está vacía", () => {
    expect(laLista().length).toBeGreaterThan(0);
    // Y `/api/yo` se precarga siempre, que es la mitad del arreglo.
    expect(main).toContain('precargar("/api/yo")');
  });

  it("cada camino de la lista existe en el enrutador", () => {
    const perdidos = laLista()
      .map(([camino]) => camino)
      .filter((camino) => pantallaDe(camino) === null);
    expect(
      perdidos,
      `estos caminos se precargan y el enrutador no los conoce: ${perdidos.join(", ")}`,
    ).toEqual([]);
  });

  it("y cada ruta precargada es una que ESA pantalla pide de verdad", () => {
    const malas: string[] = [];
    for (const [camino, ruta] of laLista()) {
      const pantalla = pantallaDe(camino);
      if (pantalla === null) continue;
      const fuente = leer("panel", "src", "pantallas", `${pantalla}.tsx`);
      // Sin la parte de la consulta: la pantalla la arma con variables.
      const base = (ruta.split("?")[0] ?? ruta);
      if (!fuente.includes(base)) {
        malas.push(`${camino} precarga «${ruta}» y ${pantalla}.tsx no pide «${base}»`);
      }
    }
    expect(malas, malas.join(" · ")).toEqual([]);
  });

  it("no se precarga nada que no sea del propio panel", () => {
    // Una precarga apuntando fuera sería mandar la sesión de la dueña a otro
    // sitio en cuanto abre el panel, sin que nadie lo pida.
    for (const [, ruta] of laLista()) {
      expect(ruta.startsWith("/api/"), `«${ruta}» no es una ruta del panel`).toBe(true);
    }
  });
});
