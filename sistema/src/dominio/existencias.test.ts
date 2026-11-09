import { describe, expect, it } from "vitest";
import {
  type Existencia,
  UMBRAL_POCAS,
  consolidar,
  debeAlertar,
  disponibilidad,
  disponibilidadDe,
  disponible,
  etiqueta,
  faltantes,
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

describe("la etiqueta que sale hacia el bot y la web", () => {
  it("usa los tres valores del CRM, no unos nuevos", () => {
    // El CRM ya los usa y el bot ya los dice: renombrarlos sería cambiar lo que
    // la clienta lee, sin ganar nada.
    expect(disponibilidad(20)).toBe("disponible");
    expect(disponibilidad(3)).toBe("pocas");
    expect(disponibilidad(0)).toBe("agotado");
  });

  it("el umbral de fábrica es el STOCK_BAJO del CRM", () => {
    expect(UMBRAL_POCAS).toBe(5);
  });

  it("compara con < estricto, igual que el CRM", () => {
    // Con el umbral en 5: cinco son «disponible» y cuatro son «pocas». Es la
    // diferencia entre que el bot diga lo mismo antes y después del traspaso.
    expect(disponibilidad(5)).toBe("disponible");
    expect(disponibilidad(4)).toBe("pocas");
  });

  it("acepta otro umbral, porque la dueña lo puede cambiar en ajustes", () => {
    expect(disponibilidad(8, 10)).toBe("pocas");
    expect(disponibilidad(8, 5)).toBe("disponible");
  });

  it("nunca da negativo ni se confunde con lo reservado", () => {
    expect(disponibilidadDe(existencia({ fisico: 10, reservado: 10 }))).toBe("agotado");
    expect(disponibilidadDe(existencia({ fisico: 10, reservado: 7 }))).toBe("pocas");
    expect(disponibilidadDe(existencia({ fisico: 2, reservado: 5 }))).toBe("agotado");
  });

  it("la etiqueta no revela nunca la cantidad exacta", () => {
    for (const e of [
      existencia({ fisico: 500 }),
      existencia({ fisico: 3 }),
      existencia({ fisico: 0 }),
    ]) {
      expect(etiqueta(e)).not.toMatch(/\d/);
    }
    expect(etiqueta(existencia({ fisico: 500 }))).toBe("Disponible");
    expect(etiqueta(existencia({ fisico: 3 }))).toBe("Quedan pocas");
    expect(etiqueta(existencia({ fisico: 0 }))).toBe("Agotado por ahora");
  });
});

describe("el aviso a la dueña es otra cosa que la etiqueta", () => {
  // El umbral de lo que se le DICE a la clienta es uno y global; el de cuándo
  // se AVISA a la dueña es por variante y bodega.
  it("avisa cuando lo libre llega al mínimo de esa bodega", () => {
    expect(debeAlertar(existencia({ fisico: 5, minimo: 5 }))).toBe(true);
    expect(debeAlertar(existencia({ fisico: 6, minimo: 5 }))).toBe(false);
    expect(debeAlertar(existencia({ fisico: 0, minimo: 5 }))).toBe(true);
  });

  it("un mínimo en NULL apaga el aviso, pero no la etiqueta", () => {
    const sinMinimo = existencia({ fisico: 1, minimo: null });
    expect(debeAlertar(sinMinimo)).toBe(false);
    // Y sin embargo la clienta sigue viendo que quedan pocas.
    expect(disponibilidadDe(sinMinimo)).toBe("pocas");
  });

  it("cuenta lo reservado, no solo el físico", () => {
    expect(debeAlertar(existencia({ fisico: 20, reservado: 16, minimo: 5 }))).toBe(true);
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
