import { describe, expect, it } from "vitest";
import { aReservar, cuantosCombos, loQueFrena } from "./combos";

/**
 * De un combo caben tantos como permita el componente que menos alcance.
 *
 * Es la regla de la que depende que el bot no prometa un combo que no se puede
 * armar — y «prometer» aquí significa que una clienta paga y después hay que
 * llamarla.
 */

const c = (codigo: string, cantidad: number, libres: number) => ({ codigo, cantidad, libres });

describe("cuántos caben", () => {
  it("manda el que menos alcanza, no el que más", () => {
    // 10 pañales de 2 en 2 dan 5; 3 wipes de 1 en 1 dan 3. Caben 3.
    expect(cuantosCombos([c("NAT-M", 2, 10), c("WIPES", 1, 3)])).toBe(3);
  });

  it("uno agotado deja el combo en cero, aunque sobre todo lo demás", () => {
    expect(cuantosCombos([c("NAT-M", 1, 500), c("WIPES", 1, 0)])).toBe(0);
  });

  it("no parte unidades: 7 de 2 en 2 son 3 combos, no 3.5", () => {
    expect(cuantosCombos([c("NAT-M", 2, 7)])).toBe(3);
  });

  it("un solo componente", () => {
    expect(cuantosCombos([c("NAT-M", 1, 4)])).toBe(4);
  });

  it("justo para uno", () => {
    expect(cuantosCombos([c("A", 2, 2), c("B", 3, 3)])).toBe(1);
  });
});

describe("los datos rotos no se interpretan con optimismo", () => {
  it("un combo SIN componentes da 0, no infinito", () => {
    // El caso que parece de laboratorio y no lo es: una receta a medio llenar,
    // o un componente que alguien borró. «Ilimitado» ahí haría que el bot
    // ofreciera sin límite algo que no existe.
    expect(cuantosCombos([])).toBe(0);
  });

  it("una cantidad de cero no divide por cero: da 0", () => {
    expect(cuantosCombos([c("A", 0, 100)])).toBe(0);
  });

  it("una cantidad negativa o rota da 0", () => {
    expect(cuantosCombos([c("A", -1, 100)])).toBe(0);
    expect(cuantosCombos([c("A", 1.5, 100)])).toBe(0);
    expect(cuantosCombos([c("A", Number.NaN, 100)])).toBe(0);
  });

  it("unas existencias negativas dan 0, no un combo imaginario", () => {
    expect(cuantosCombos([c("A", 1, -5)])).toBe(0);
  });
});

describe("qué reponer", () => {
  it("dice cuál frena el combo", () => {
    expect(loQueFrena([c("NAT-M", 2, 10), c("WIPES", 1, 3)])).toEqual(["WIPES"]);
  });

  it("si empatan, los nombra a los dos", () => {
    expect(loQueFrena([c("A", 1, 3), c("B", 1, 3)])).toEqual(["A", "B"]);
  });

  it("con uno agotado, señala el agotado y no el que sobra", () => {
    expect(loQueFrena([c("A", 1, 500), c("B", 1, 0)])).toEqual(["B"]);
  });
});

describe("lo que hay que apartar", () => {
  it("multiplica la receta por los combos vendidos", () => {
    expect(aReservar([c("NAT-M", 2, 10), c("WIPES", 1, 3)], 3)).toEqual([
      { codigo: "NAT-M", cantidad: 6 },
      { codigo: "WIPES", cantidad: 3 },
    ]);
  });

  it("cero o menos no aparta nada", () => {
    expect(aReservar([c("A", 2, 10)], 0)).toEqual([]);
    expect(aReservar([c("A", 2, 10)], -1)).toEqual([]);
  });

  it("lo que se aparta nunca pasa de lo que hay", () => {
    // La propiedad que de verdad importa: si se venden tantos combos como
    // caben, lo apartado de cada componente cabe en sus existencias. Si esto
    // fallara, el pedido reservaría más de lo que hay y el CHECK de la tabla
    // tumbaría la venta — con la clienta esperando.
    const receta = [c("A", 3, 10), c("B", 2, 7), c("C", 1, 4)];
    const caben = cuantosCombos(receta);
    for (const r of aReservar(receta, caben)) {
      const comp = receta.find((x) => x.codigo === r.codigo);
      expect(r.cantidad, r.codigo).toBeLessThanOrEqual(comp?.libres ?? 0);
    }
  });
});
