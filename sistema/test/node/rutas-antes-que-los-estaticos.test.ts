import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cada ruta del Worker tiene que estar en `run_worker_first`.
 *
 * El Worker del sistema sirve DOS cosas en el mismo dominio: el panel, que son
 * archivos estáticos, y sus propias rutas. Cloudflare atiende primero los
 * archivos, y `run_worker_first` es la lista de excepciones. Una ruta que no
 * esté ahí no se llega a ejecutar en producción: `not_found_handling` es
 * `single-page-application`, así que en vez de un 404 sale el `index.html` del
 * panel con un 200 — o, detrás de Access, el 302 al login.
 *
 * Eso es exactamente la trampa nº 8: una lista de configuración que alguien
 * tiene que acordarse de tocar. Ya mordió con `/mcp`, que estuvo meses en la
 * lista apuntando a una ruta que no existía, y volvió a morder con `/foto/*`
 * al contrario: la ruta existía en la web y el panel la pedía a su propio
 * dominio, así que la foto de un producto no se veía NUNCA y quien la subía
 * leía «no se puede poner una foto». Las dos mitades estaban bien; faltaba la
 * línea de configuración.
 *
 * Una prueba por caso no habría servido: lo que falla es la clase entera, así
 * que esto compara las dos listas y se pondrá roja con la PRÓXIMA ruta que
 * alguien monte sin declararla, sin que nadie se acuerde de añadir nada aquí.
 *
 * Vive en `test/node/` porque `node:fs` no existe dentro de workerd, donde se
 * saltaría en silencio pasando en verde.
 */

const raiz = join(import.meta.dirname, "..", "..");
const fuente = await readFile(join(raiz, "src", "index.ts"), "utf8");
const wrangler = await readFile(join(raiz, "wrangler.jsonc"), "utf8");

/**
 * Las rutas que `src/index.ts` monta en el Worker de verdad.
 *
 * Se leen del código y no de una lista escrita a mano, que es el punto: una
 * lista a mano es otra cosa de la que acordarse.
 */
function rutasMontadas(): string[] {
  const encontradas = new Set<string>();
  for (const m of fuente.matchAll(/\bapp\.(?:get|post|put|patch|delete|all|route)\(\s*"([^"]+)"/g)) {
    const ruta = m[1] as string;
    // El `*` final es el 404 de todo lo demás, y ése NO va en la lista: si
    // fuera, el Worker contestaría antes que los archivos del panel y el panel
    // dejaría de cargar.
    if (ruta === "*") continue;
    encontradas.add(ruta);
  }
  return [...encontradas];
}

/** Cada `run_worker_first` del archivo, uno por entorno desplegado. */
function listasDeclaradas(): string[][] {
  const listas: string[][] = [];
  for (const m of wrangler.matchAll(/"run_worker_first"\s*:\s*\[([^\]]*)\]/g)) {
    listas.push([...(m[1] as string).matchAll(/"([^"]+)"/g)].map((x) => x[1] as string));
  }
  return listas;
}

/** ¿Alguna entrada de la lista cubre esta ruta? */
const cubierta = (ruta: string, lista: readonly string[]): boolean =>
  lista.some((e) => e === ruta || e === `${ruta}/*` || e === ruta.replace(/\/\*$/, ""));

describe("las rutas del Worker se sirven antes que los archivos del panel", () => {
  it("hay una lista por cada entorno que se despliega", () => {
    // Staging y producción. El nivel raíz no sirve el panel —en local lo sirve
    // `vite dev`— así que no lleva lista. Si mañana hay un tercer entorno
    // desplegado, esto obliga a declararla también.
    expect(listasDeclaradas()).toHaveLength(2);
  });

  it("y cada ruta montada está en TODAS las listas", () => {
    const rutas = rutasMontadas();
    // Si esto se queda corto, el que falla es el lector de rutas y no el
    // sistema: mejor romper aquí que dar por buena una lista vacía.
    expect(rutas.length).toBeGreaterThanOrEqual(5);

    const faltantes: string[] = [];
    for (const lista of listasDeclaradas()) {
      for (const ruta of rutas) {
        if (!cubierta(ruta, lista)) faltantes.push(`${ruta} falta en [${lista.join(", ")}]`);
      }
    }
    expect(faltantes).toEqual([]);
  });

  it("la foto del catálogo está montada y declarada", () => {
    // El caso que costó el fallo, fijado por su nombre: si alguien quita la
    // ruta o la saca de la lista «porque la sirve la web», esto lo dice.
    expect(fuente).toContain('app.get("/foto/*"');
    for (const lista of listasDeclaradas()) expect(lista).toContain("/foto/*");
  });
});
