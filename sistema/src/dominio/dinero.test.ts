import { describe, expect, it } from "vitest";
import {
  aDolares,
  aplicarPuntosBasicos,
  desdeDolares,
  esCentavos,
  formatear,
  multiplicar,
  prorratear,
  sumar,
} from "./dinero";

describe("centavos enteros", () => {
  it("suma y multiplica sin error de coma flotante", () => {
    // Lo que en dólares daba 0.30000000000000004 aquí es exacto por construcción.
    expect(sumar([10, 20])).toBe(30);
    expect(multiplicar(2998, 3)).toBe(8994);
    expect(sumar(Array.from({ length: 100 }, () => 7))).toBe(700);
  });

  it("un carrito vacío da cero, no NaN", () => {
    expect(sumar([])).toBe(0);
  });

  it("rechaza lo que no es un entero seguro", () => {
    expect(esCentavos(5000)).toBe(true);
    expect(esCentavos(50.5)).toBe(false);
    expect(esCentavos(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(esCentavos("5000")).toBe(false);
  });
});

describe("tasas en puntos básicos", () => {
  it("aplica el 7 % del ITBMS", () => {
    expect(aplicarPuntosBasicos(10_000, 700)).toBe(700);
    expect(aplicarPuntosBasicos(5_000, 700)).toBe(350);
  });

  it("redondea medio centavo lejos del cero", () => {
    // 50 centavos al 7 % son 3.5 centavos
    expect(aplicarPuntosBasicos(50, 700)).toBe(4);
    expect(aplicarPuntosBasicos(-50, 700)).toBe(-4);
  });

  it("tasa cero no cobra nada", () => {
    expect(aplicarPuntosBasicos(9_999, 0)).toBe(0);
  });
});

describe("prorrateo", () => {
  it("reparte sin perder ni inventar un centavo", () => {
    const partes = prorratear(100, [1, 1, 1]);
    expect(sumar(partes)).toBe(100);
    expect(partes).toEqual([34, 33, 33]);
  });

  it("reparte por peso", () => {
    const partes = prorratear(1_000, [3_000, 1_000]);
    expect(partes).toEqual([750, 250]);
    expect(sumar(partes)).toBe(1_000);
  });

  it("cuadra con pesos que no dividen bien", () => {
    const partes = prorratear(1_000, [333, 333, 334]);
    expect(sumar(partes)).toBe(1_000);
  });

  it("sin pesos reparte parejo", () => {
    expect(sumar(prorratear(10, [0, 0, 0]))).toBe(10);
  });

  it("acepta lista vacía y rechaza pesos negativos", () => {
    expect(prorratear(100, [])).toEqual([]);
    expect(() => prorratear(100, [1, -1])).toThrow(RangeError);
  });

  it("reparte también un monto negativo cuadrando", () => {
    expect(sumar(prorratear(-100, [1, 1, 1]))).toBe(-100);
  });
});

describe("leer lo que escribe una persona", () => {
  it("convierte sin pasar por coma flotante", () => {
    // parseFloat('29.98') * 100 da 2998.0000000000005
    expect(desdeDolares("29.98")).toBe(2998);
    expect(desdeDolares("50")).toBe(5000);
    expect(desdeDolares("50.5")).toBe(5050);
    expect(desdeDolares("$50.50")).toBe(5050);
    expect(desdeDolares(" 45.00 ")).toBe(4500);
    expect(desdeDolares("-12.30")).toBe(-1230);
  });

  it("acepta la coma solo como separador de miles bien formado", () => {
    expect(desdeDolares("1,234.56")).toBe(123_456);
    expect(desdeDolares("1,234")).toBe(123_400);
    expect(desdeDolares("12,345,678.90")).toBe(1_234_567_890);
  });

  it("rechaza la coma decimal porque es ambigua", () => {
    // «50,5» es cincuenta con cinco en media América y quinientos cinco en la
    // otra. Leerlo mal es cobrar diez veces de más: mejor null que adivinar.
    for (const ambiguo of ["50,5", "50,50", "1,23", "1,2345", "0,99"]) {
      expect(desdeDolares(ambiguo), ambiguo).toBeNull();
    }
  });

  it("devuelve null en vez de adivinar", () => {
    for (const malo of ["", "abc", "50.123", "1.2.3", "$", "12 pesos", "--5", "5."]) {
      expect(desdeDolares(malo), malo).toBeNull();
    }
  });
});

describe("mostrar", () => {
  it("formatea en dólares", () => {
    expect(formatear(5000)).toBe("$50.00");
    expect(formatear(5)).toBe("$0.05");
    expect(formatear(123_456)).toBe("$1234.56");
    expect(formatear(-1230)).toBe("-$12.30");
    expect(formatear(0)).toBe("$0.00");
  });

  it("aDolares es solo para pantalla", () => {
    expect(aDolares(5000)).toBe(50);
  });
});
