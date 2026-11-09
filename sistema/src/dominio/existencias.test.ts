import { describe, expect, it } from "vitest";
import {
  type Existencia,
  consolidar,
  disponible,
  etiqueta,
  faltantes,
  nivel,
  puedeDespachar,
} from "./existencias";

function existencia(cambios: Partial<Existencia> = {}): Existencia {
  return { fisico: 10, reservado: 0, minimo: 5, ...cambios };
}

describe("disponibilidad", () => {
  it("descuenta lo comprometido en pedidos sin entregar", () => {
    expect(disponible(existencia({ fisico: 10, reservado: 4 }))).toBe(6);
  });

  it("no da disponibilidad negativa aunque la reserva supere el físico", () => {
    // La base lo impide con un CHECK, pero el dominio no se apoya en eso.
    expect(disponible(existencia({ fisico: 2, reservado: 5 }))).toBe(0);
  });

  it("no deja vender más de lo disponible", () => {
    expect(puedeDespachar(existencia({ fisico: 3, reservado: 1 }), 3)).toBe(false);
    expect(puedeDespachar(existencia({ fisico: 3, reservado: 1 }), 2)).toBe(true);
  });

  it("rechaza cantidades cero, negativas o partidas", () => {
    expect(puedeDespachar(existencia(), 0)).toBe(false);
    expect(puedeDespachar(existencia(), -1)).toBe(false);
    expect(puedeDespachar(existencia(), 1.5)).toBe(false);
  });

  it("no hay pedidos pendientes: lo que no hay, no se vende", () => {
    // Nébula permitía backorder; `existencias` de Baby Caleb no tiene esa
    // columna y el negocio entrega de bodega.
    expect(puedeDespachar(existencia({ fisico: 0 }), 1)).toBe(false);
  });
});

describe("nivel y etiqueta", () => {
  it("clasifica según el umbral de la variante", () => {
    expect(nivel(existencia({ fisico: 20 }))).toBe("hay");
    expect(nivel(existencia({ fisico: 3 }))).toBe("poco");
    expect(nivel(existencia({ fisico: 0 }))).toBe("agotado");
  });

  it("sin umbral no avisa de poco, solo de agotado", () => {
    expect(nivel(existencia({ fisico: 1, minimo: null }))).toBe("hay");
    expect(nivel(existencia({ fisico: 0, minimo: null }))).toBe("agotado");
  });

  it("cuenta lo reservado para decidir el nivel", () => {
    expect(nivel(existencia({ fisico: 10, reservado: 10 }))).toBe("agotado");
    expect(nivel(existencia({ fisico: 10, reservado: 7 }))).toBe("poco");
  });

  it("la etiqueta no revela nunca la cantidad exacta", () => {
    for (const e of [
      existencia({ fisico: 500 }),
      existencia({ fisico: 3 }),
      existencia({ fisico: 0 }),
    ]) {
      const texto = etiqueta(e);
      expect(texto).not.toMatch(/\d/);
    }
    expect(etiqueta(existencia({ fisico: 500 }))).toBe("Disponible");
    expect(etiqueta(existencia({ fisico: 3 }))).toBe("Quedan pocas");
    expect(etiqueta(existencia({ fisico: 0 }))).toBe("Agotado por ahora");
  });
});

describe("consolidar bodegas", () => {
  it("suma físico y reservado", () => {
    const total = consolidar([
      { fisico: 4, reservado: 1, minimo: null },
      { fisico: 6, reservado: 2, minimo: null },
    ]);
    expect(total.fisico).toBe(10);
    expect(total.reservado).toBe(3);
    expect(disponible(total)).toBe(7);
  });

  it("toma el umbral más exigente de las bodegas que lo tienen", () => {
    expect(
      consolidar([
        { fisico: 5, reservado: 0, minimo: 2 },
        { fisico: 5, reservado: 0, minimo: 8 },
        { fisico: 5, reservado: 0, minimo: null },
      ]).minimo,
    ).toBe(8);
  });

  it("sin ninguna bodega con umbral, no hay umbral", () => {
    expect(consolidar([{ fisico: 5, reservado: 0, minimo: null }]).minimo).toBeNull();
  });

  it("de una lista vacía sale cero, no NaN", () => {
    expect(consolidar([])).toEqual({ fisico: 0, reservado: 0, minimo: null });
  });
});

describe("faltantes de un pedido", () => {
  const bodega = new Map<string, Existencia>([
    ["NAT-M", { fisico: 5, reservado: 1, minimo: null }],
    ["NAT-L", { fisico: 0, reservado: 0, minimo: null }],
  ]);
  const buscar = (c: string) => bodega.get(c);

  it("no reporta nada cuando todo alcanza", () => {
    expect(faltantes([{ codigo: "NAT-M", cantidad: 4 }], buscar)).toEqual([]);
  });

  it("reporta la línea que no alcanza con lo que sí hay", () => {
    expect(faltantes([{ codigo: "NAT-M", cantidad: 5 }], buscar)).toEqual([
      { codigo: "NAT-M", pedidas: 5, disponibles: 4 },
    ]);
  });

  it("trata como agotado un código que no existe en la bodega", () => {
    expect(faltantes([{ codigo: "NO-EXISTE", cantidad: 1 }], buscar)).toEqual([
      { codigo: "NO-EXISTE", pedidas: 1, disponibles: 0 },
    ]);
  });

  it("revisa todas las líneas, no se detiene en la primera", () => {
    expect(
      faltantes(
        [
          { codigo: "NAT-M", cantidad: 99 },
          { codigo: "NAT-L", cantidad: 1 },
        ],
        buscar,
      ).map((f) => f.codigo),
    ).toEqual(["NAT-M", "NAT-L"]);
  });
});
