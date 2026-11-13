import { describe, expect, it } from "vitest";
import { AA_GRANDE, AA_TEXTO, CONTROL, MARCA, aRgb, contraste } from "./marca";

/**
 * Los contrastes que NO son los de la paleta suelta.
 *
 * `marca.test.ts` ya comprueba cada token contra `--bg` y contra `--surface`,
 * y todos pasan. El panel suspendía igual, porque el fallo no estaba en ningún
 * token: estaba en lo que se pinta DEBAJO de uno.
 *
 * El caso que lo enseña es el único renglón del panel que dice dónde está
 * usted. El enlace activo llevaba `bg-accent/10` en la barra lateral y
 * `bg-accent/15` en el cajón: un velo de naranja translúcido. `--accent-strong`
 * está elegido para leerse sobre el crema (4.90) y sobre la superficie (4.60),
 * pero con el velo encima el fondo REAL deja de ser la superficie, y el mismo
 * texto cae a 4.32:1 y a 4.16:1. Lo cazó axe-core midiendo píxeles; las dos
 * comprobaciones que miran tokens —la de `marca.test.ts` y la del auditor—
 * dieron verde las dos, porque las dos leen el primer fondo OPACO que
 * encuentran y se saltan las capas translúcidas.
 *
 * De ahí la forma de estas pruebas: aplanan la capa translúcida sobre su fondo
 * —que es lo que hace el navegador— y miden el resultado. `aRgb(color, fondo)`
 * ya sabía hacerlo; nadie se lo había pedido para este caso.
 */

/** Aplana `velo` sobre `fondo` y devuelve el color resultante en `rgb(...)`. */
function velar(velo: string, fondo: string): string {
  const [r, g, b] = aRgb(velo, aRgb(fondo));
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

describe("el contorno de los controles (WCAG 1.4.11)", () => {
  // 3:1 es el mínimo de la WCAG para el contorno de un control. Si alguien
  // aclara `CONTROL` para que «se note menos», esto se pone rojo.
  for (const fondo of [MARCA.bg, MARCA.surface] as const) {
    it(`se ve sobre ${fondo}`, () => {
      expect(contraste(CONTROL, fondo)).toBeGreaterThanOrEqual(AA_GRANDE);
    });
  }

  it("y no es el mismo gris que separa tarjetas", () => {
    // El borde de un campo y la raya entre dos filas tienen trabajos
    // distintos. Cuando eran el mismo token, el campo heredaba el contraste
    // del adorno: 1.24:1. Esta comprobación es la que impide volver a
    // juntarlos «porque son parecidos».
    expect(CONTROL).not.toBe(MARCA.line);
    expect(contraste(MARCA.line, MARCA.bg)).toBeLessThan(AA_GRANDE);
  });
});

describe("el renglón que dice dónde está usted", () => {
  // La barra lateral vive sobre `surface`; el cajón del teléfono, también.
  const FONDO_DE_LA_NAVEGACION = MARCA.surface;

  it("el texto del activo pasa AA sobre el fondo que de verdad tiene", () => {
    expect(
      contraste(MARCA.accentStrong, FONDO_DE_LA_NAVEGACION),
    ).toBeGreaterThanOrEqual(AA_TEXTO);
  });

  /**
   * La mutación, escrita como prueba.
   *
   * Esto no vigila el panel: documenta por qué el velo se fue, y se pone rojo
   * si algún día el cálculo de aplanado deja de hacer lo que dice. Si alguien
   * vuelve a poner `bg-accent/10` debajo del texto activo, el número que sale
   * aquí es el que va a tener la pantalla.
   */
  it("y por eso el velo naranja no puede volver", () => {
    const conVelo10 = velar("rgba(238, 146, 74, 0.10)", FONDO_DE_LA_NAVEGACION);
    const conVelo15 = velar("rgba(238, 146, 74, 0.15)", FONDO_DE_LA_NAVEGACION);

    // Los dos números que medía axe-core en el panel de verdad: 4.32 y 4.16.
    expect(contraste(MARCA.accentStrong, conVelo10)).toBeLessThan(AA_TEXTO);
    expect(contraste(MARCA.accentStrong, conVelo15)).toBeLessThan(AA_TEXTO);
  });

  it("la barra de 3 px marca el activo sin pedirle nada al color", () => {
    // El activo se señala con cuatro cosas, y tres no son color: la barra,
    // la negrita y `aria-current`. La cuarta es este naranja, que además
    // tiene que leerse — y como borde pide 3:1, no 4.5:1.
    expect(contraste(MARCA.accentEdge, FONDO_DE_LA_NAVEGACION)).toBeGreaterThanOrEqual(
      AA_GRANDE,
    );
  });
});
