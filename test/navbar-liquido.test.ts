import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contrato del navbar de vidrio líquido.
 *
 * Existe por un fallo concreto y repetido, en palabras del dueño: «cuando se
 * pone aparece el líquido en la primera carga, pero si cambio de página vuelve
 * a estar la barra mate».
 *
 * La causa de ese fallo es SIEMPRE la misma y no es el CSS: el efecto se
 * aplica desde JavaScript —una propiedad que se pone al montar y se QUITA al
 * desmontar— así que cualquier cosa que desmonte el componente se lo lleva.
 * En D'CASA eso es necesario, porque el empaquetador de Odoo reescribe
 * `url(#…)` en el CSS como si fuera la ruta de un archivo. Vite no lo hace.
 *
 * Así que aquí el efecto no depende de JavaScript, y estas pruebas vigilan
 * justo eso. No comprueban que se vea bonito: comprueban que no haya por dónde
 * se apague.
 */

const raiz = join(import.meta.dirname, "..");
const leer = (p: string) => readFileSync(join(raiz, p), "utf8");

const html = leer("index.html");
const css = leer("src/styles/tokens.css");

describe("el filtro vive en el HTML, no en React", () => {
  it("está declarado en index.html", () => {
    expect(html).toContain('id="bc-liquido"');
    expect(html).toContain("feDisplacementMap");
  });

  it("está ANTES de #root, así que React no puede montarlo ni desmontarlo", () => {
    const filtro = html.indexOf("bc-liquido");
    const root = html.indexOf('id="root"');
    expect(filtro).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(-1);
    // Si el filtro estuviera dentro de #root, React lo borraría al
    // re-renderizar y el efecto se caería — exactamente el fallo que esto
    // existe para impedir.
    expect(filtro).toBeLessThan(root);
  });

  it("el movimiento es SMIL, no un bucle de JavaScript", () => {
    expect(html).toMatch(/<animate[^>]+attributeName="baseFrequency"/);
    expect(html).toMatch(/repeatCount="indefinite"/);
  });
});

describe("la referencia vive en el CSS", () => {
  it("el líquido se aplica desde la hoja de estilos", () => {
    expect(css).toContain("url(#bc-liquido)");
  });

  // El `@supports` DEL LÍQUIDO, no el primero del archivo: `tokens.css` ya
  // tenía otro antes, y comparar contra él daba un resultado sin sentido. Que
  // la prueba se cayera por eso es justo lo que tenía que pasar.
  const iLiquido = css.indexOf("url(#bc-liquido)");
  const iSupports = css.lastIndexOf("@supports", iLiquido);

  it("detrás de @supports, no de un `if` en JavaScript", () => {
    // Sin @supports, un navegador que no entiende `backdrop-filter: url()`
    // descarta la declaración ENTERA y la barra se queda sin vidrio ninguno
    // —ni líquido ni mate—. En iPhone eso es todos los navegadores.
    expect(iSupports).toBeGreaterThan(-1);
    const condicion = css.slice(iSupports, css.indexOf("{", iSupports));
    expect(condicion).toContain("backdrop-filter");
  });

  it("deja una capa mate SIEMPRE, por debajo de la líquida", () => {
    // La base no está condicionada a nada: donde no hay refracción, se ve el
    // vidrio de antes y nadie ve un hueco.
    const base = css.indexOf(".bc-vidrio::before");
    expect(base).toBeGreaterThan(-1);
    expect(base).toBeLessThan(iSupports);
  });
});

describe("NINGÚN JavaScript toca el efecto", () => {
  /** Todos los .ts/.tsx de src/ y worker/, sin node_modules. */
  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(join(raiz, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) fuentes(rel, acc);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes(".test.")) acc.push(rel);
    }
    return acc;
  }

  const archivos = [...fuentes("src"), ...fuentes("worker")];

  it("encuentra archivos que revisar (si no, la prueba no prueba nada)", () => {
    expect(archivos.length).toBeGreaterThan(20);
  });

  it("nadie nombra el filtro desde el código", () => {
    const culpables = archivos.filter((f) => leer(f).includes("bc-liquido"));
    expect(
      culpables,
      "el filtro se aplica desde CSS. Nombrarlo en JavaScript es cómo vuelve el fallo: " +
        "lo que se pone al montar, se quita al desmontar.",
    ).toEqual([]);
  });

  it("nadie escribe backdrop-filter desde el código", () => {
    const culpables = archivos.filter((f) => {
      const t = leer(f);
      return /setProperty\(\s*["'`]--[^"'`]*(refrac|vidrio|glass)/i.test(t) || /\.style\.(webkitB|b)ackdropFilter/.test(t);
    });
    expect(culpables, "el vidrio lo pinta el CSS, siempre").toEqual([]);
  });

  it("el navbar solo manda estado, no el efecto", () => {
    const nav = leer("src/blocks/S01Nav.tsx");
    expect(nav).toContain("bc-vidrio");
    // `data-scrolled` es estado (¿bajó la página?). El vidrio lo decide el CSS.
    expect(nav).toContain("data-scrolled");
    expect(nav).not.toContain("backdrop-blur");
  });
});
