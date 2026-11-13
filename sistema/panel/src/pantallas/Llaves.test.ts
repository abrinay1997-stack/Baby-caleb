import { describe, expect, it } from "vitest";
import { textoDeRevocadas } from "./Llaves";

/**
 * «1 llave revocada», no «1 revocada(s)».
 *
 * El paréntesis de plural es la forma de no decidir, y encima se había comido
 * el sustantivo: revocada ¿qué? Es el mismo fallo que ya se arregló en nueve
 * filas del Resumen («1 entrega» a secas) y que Ajustes resuelve escribiendo
 * las dos formas enteras.
 *
 * Validada por mutación: volver a «${n} revocada(s)» pone rojas las dos.
 */
describe("cuántas llaves revocadas", () => {
  it("dice el sustantivo, en singular y en plural", () => {
    expect(textoDeRevocadas(1)).toBe("1 llave revocada");
    expect(textoDeRevocadas(3)).toBe("3 llaves revocadas");
  });

  it("no deja paréntesis de plural en ningún caso", () => {
    for (const n of [0, 1, 2, 11]) {
      expect(textoDeRevocadas(n), `con ${n}`).not.toMatch(/\(s\)/);
      expect(textoDeRevocadas(n), `con ${n}`).toMatch(/llaves?/);
    }
  });
});
