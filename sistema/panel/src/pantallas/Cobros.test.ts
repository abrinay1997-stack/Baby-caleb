import { describe, expect, it } from "vitest";
import { textoDeConfirmar } from "./Cobros";

/**
 * El botón que mete el dinero en los libros dice la cifra.
 *
 * No es cosmética: es un botón de UN toque, sin segunda pregunta, repetido
 * idéntico en cada ficha de la bandeja. Decía «Confirmar: el dinero entró»,
 * así que lo único que distinguía confirmar $15.00 de confirmar $315.00 era
 * acordarse de a qué ficha se estaba apuntando. Con la cifra dentro, el botón
 * se verifica solo contra la captura que se tiene delante.
 *
 * Validada por mutación: devolver el texto sin el monto pone roja la primera.
 */
describe("el botón de confirmar un cobro", () => {
  it("lleva la cifra que se está confirmando", () => {
    expect(textoDeConfirmar(3150)).toBe("Confirmar que entraron $31.50");
    expect(textoDeConfirmar(1500)).toBe("Confirmar que entraron $15.00");
  });

  it("no dice lo mismo para dos montos distintos", () => {
    expect(textoDeConfirmar(1500)).not.toBe(textoDeConfirmar(31500));
  });

  it("escribe los centavos enteros, que es como se lee un comprobante", () => {
    // $5.05 y no $5.5: un comprobante de banco no se lee a ojo.
    expect(textoDeConfirmar(505)).toBe("Confirmar que entraron $5.05");
    expect(textoDeConfirmar(5)).toBe("Confirmar que entraron $0.05");
  });
});
