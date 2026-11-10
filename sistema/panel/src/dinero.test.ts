import { describe, expect, it } from "vitest";
import { aCentavos, aPuntosBasicos, deCentavos, dePuntosBasicos } from "./dinero";

describe("lo que se teclea → centavos", () => {
  it("lo normal", () => {
    expect(aCentavos("12.50")).toBe(1250);
    expect(aCentavos("0.99")).toBe(99);
    expect(aCentavos("45")).toBe(4500);
    expect(aCentavos("7.9")).toBe(790);
  });

  it("los montos que la coma flotante estropea", () => {
    // 1.15 * 100 = 114.99999999999999 en coma flotante. Con un floor, esto
    // le cobra un centavo de menos a cada clienta, para siempre, sin que nada
    // falle. Es el motivo entero de que esta función exista.
    expect(aCentavos("1.15")).toBe(115);
    expect(aCentavos("2.29")).toBe(229);
    expect(aCentavos("8.07")).toBe(807);
    expect(aCentavos("10.35")).toBe(1035);
    expect(aCentavos("1000000.01")).toBe(100000001);
  });

  it("acepta lo que la gente escribe de verdad", () => {
    expect(aCentavos("$12.50")).toBe(1250);
    expect(aCentavos("12,50")).toBe(1250); // la coma decimal es lo normal en Panamá
    expect(aCentavos("  12.50  ")).toBe(1250);
  });

  it("no adivina: lo que no es un monto, no lo es", () => {
    for (const malo of ["", "   ", "abc", "12.555", "12.5.0", "-3", "1e3", "12-", "$"]) {
      expect(aCentavos(malo), `«${malo}»`).toBeNull();
    }
  });

  it("ida y vuelta", () => {
    for (const c of [1, 99, 115, 1250, 4500, 100000001]) {
      expect(aCentavos(deCentavos(c)), `${c}`).toBe(c);
    }
  });
});

describe("por ciento → puntos básicos", () => {
  it("7 % son 700", () => {
    expect(aPuntosBasicos("7")).toBe(700);
    expect(aPuntosBasicos("7 %")).toBe(700);
    expect(aPuntosBasicos("0")).toBe(0);
    expect(aPuntosBasicos("10.5")).toBe(1050);
  });

  it("no acepta más del 100 %", () => {
    expect(aPuntosBasicos("101")).toBeNull();
  });

  it("ida y vuelta", () => {
    for (const bp of [0, 700, 1050, 10000]) {
      expect(aPuntosBasicos(dePuntosBasicos(bp)), `${bp}`).toBe(bp);
    }
  });
});
