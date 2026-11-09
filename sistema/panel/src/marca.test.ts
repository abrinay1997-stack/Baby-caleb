import { describe, expect, it } from "vitest";
import brand from "../../../brand.json";
import {
  AA_GRANDE,
  AA_TEXTO,
  MARCA,
  TACTIL_MIN_PX,
  TELEFONO_MAX_PX,
  TIPOGRAFIA,
  TIPOS,
  USO,
  contraste,
} from "./marca";

// Dos cosas se vigilan aquí, y las dos se rompen en silencio si nadie las mira:
// que la copia de la marca no se separe del original, y que ningún color que
// lleve texto baje de AA. La segunda es la que importa de verdad: la dueña va a
// leer cifras en un teléfono, a veces con sol.

describe("la copia de brand.json sigue siendo la misma", () => {
  it("los colores", () => {
    expect(MARCA.bg).toBe(brand.color.bg);
    expect(MARCA.surface).toBe(brand.color.surface);
    expect(MARCA.fg).toBe(brand.color.fg);
    expect(MARCA.muted).toBe(brand.color.muted);
    expect(MARCA.line).toBe(brand.color.line);
    expect(MARCA.accent).toBe(brand.color.accent);
    expect(MARCA.accentFg).toBe(brand.color["accent-fg"]);
    expect(MARCA.accentStrong).toBe(brand.color["accent-strong"]);
    expect(MARCA.accentEdge).toBe(brand.color["accent-edge"]);
    expect(MARCA.sage).toBe(brand.color.sage);
    expect(MARCA.sageStrong).toBe(brand.color["sage-strong"]);
    expect(MARCA.sageEdge).toBe(brand.color["sage-edge"]);
  });

  it("la tipografía", () => {
    expect(TIPOGRAFIA.display).toBe(brand.type.display);
    expect(TIPOGRAFIA.body).toBe(brand.type.body);
    expect(TIPOGRAFIA.utility).toBe(brand.type.utility);
    expect(TIPOGRAFIA.displayWeight).toBe(brand.type.displayWeight);
  });

  it("y no se copió ningún color que brand.json no tenga", () => {
    const enMarca = new Set(Object.keys(MARCA));
    const aCamello = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const enBrand = new Set(Object.keys(brand.color).map(aCamello));
    expect([...enMarca].sort()).toEqual([...enBrand].sort());
  });
});

describe("todo lo que lleva texto pasa AA", () => {
  for (const fondo of [MARCA.bg, MARCA.surface] as const) {
    it(`el texto principal, sobre ${fondo}`, () => {
      expect(contraste(USO.texto, fondo)).toBeGreaterThanOrEqual(AA_TEXTO);
    });

    it(`el texto de apoyo, sobre ${fondo}`, () => {
      // Pasa con poco margen (4.95 / 4.80), igual que el `--dim` del CRM.
      // Aclarar el fondo un pelo lo rompería, y es el token del texto chico.
      expect(contraste(USO.apoyo, fondo)).toBeGreaterThanOrEqual(AA_TEXTO);
    });

    it(`el naranja de texto, sobre ${fondo}`, () => {
      expect(contraste(USO.textoMarca, fondo)).toBeGreaterThanOrEqual(AA_TEXTO);
    });

    it(`el naranja de titulares, sobre ${fondo}`, () => {
      expect(contraste(USO.textoMarcaGrande, fondo)).toBeGreaterThanOrEqual(AA_GRANDE);
    });
  }

  it("el texto encima de un botón naranja", () => {
    expect(contraste(USO.sobreRelleno, USO.relleno)).toBeGreaterThanOrEqual(AA_TEXTO);
  });
});

describe("lo que NO se puede usar como texto, y por qué", () => {
  it("el naranja de la marca no llega ni a texto grande", () => {
    // 2.20 sobre el fondo. Por eso `USO.relleno` dice «NUNCA texto» y existe
    // `USO.textoMarca`, que es el mismo tono oscurecido.
    expect(contraste(MARCA.accent, MARCA.bg)).toBeLessThan(AA_GRANDE);
  });

  it("el verde tampoco", () => {
    expect(contraste(MARCA.sage, MARCA.bg)).toBeLessThan(AA_GRANDE);
  });

  it("`accent-fg` NO puede volver a ser crema", () => {
    // Era #F9F6ED sobre el naranja: 2.20, y es el par de los botones
    // principales y del chat. Se corrigió en brand.json al navy. Esta prueba
    // está para que no vuelva.
    expect(MARCA.accentFg).not.toBe(MARCA.bg);
    expect(contraste(MARCA.accentFg, MARCA.accent)).toBeGreaterThanOrEqual(AA_TEXTO);
  });

  it("el navy es legible encima del verde, que es la otra superficie de relleno", () => {
    expect(contraste(MARCA.fg, MARCA.sage)).toBeGreaterThanOrEqual(AA_TEXTO);
  });

  it("los tonos de texto conservan el tono, no son otro color", () => {
    // Oscurecer multiplicando mantiene el matiz. Si alguien los cambia por un
    // marrón o un gris cualquiera, esto lo nota.
    const canales = (c: string) => {
      const n = c.slice(1);
      return [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16)) as [number, number, number];
    };
    for (const naranja of [MARCA.accent, MARCA.accentStrong, MARCA.accentEdge]) {
      const [r, g, b] = canales(naranja);
      expect(r, naranja).toBeGreaterThan(g);
      expect(g, naranja).toBeGreaterThan(b);
    }
    for (const verde of [MARCA.sage, MARCA.sageStrong, MARCA.sageEdge]) {
      const [r, g, b] = canales(verde);
      expect(g, verde).toBeGreaterThan(r);
      expect(g, verde).toBeGreaterThan(b);
    }
  });
});

describe("las medidas del §7 son las del contrato", () => {
  it("un solo punto de quiebre, en 767", () => {
    expect(TELEFONO_MAX_PX).toBe(767);
  });

  it("los campos miden 16 px, que no es una preferencia", () => {
    // Por debajo, Safari de iPhone hace zoom al enfocar y deja la página
    // descuadrada.
    expect(TIPOS.campo).toBe(16);
  });

  it("el piso del texto de apoyo es 12 px", () => {
    expect(TIPOS.apoyo).toBe(12);
    // Y nada en la escala baja de ahí.
    for (const [nombre, px] of Object.entries(TIPOS)) {
      expect(px, nombre).toBeGreaterThanOrEqual(12);
    }
  });

  it("las cifras grandes no pasan de 34, porque se parten", () => {
    expect(TIPOS.cifra).toBeGreaterThanOrEqual(30);
    expect(TIPOS.cifra).toBeLessThanOrEqual(34);
  });

  it("lo que se toca mide 44", () => {
    expect(TACTIL_MIN_PX).toBe(44);
  });
});
