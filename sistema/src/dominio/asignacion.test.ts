import { describe, expect, it } from "vitest";
import {
  MAX_ENTREGAS_POR_MOTORIZADO,
  type MotorizadoDisponible,
  mejorCandidato,
  sugerirMotorizado,
} from "./asignacion";
import type { Punto } from "./geo";

const TOCUMEN = "z-tocumen";
const JUANDIAZ = "z-juandiaz";

const destino: Punto = { lat: 9.07, lng: -79.38 };
const cerca: Punto = { lat: 9.071, lng: -79.381 };
const lejos: Punto = { lat: 8.95, lng: -79.6 };

function motorizado(cambios: Partial<MotorizadoDisponible> = {}): MotorizadoDisponible {
  return { id: "m1", nombre: "Ana", estado: "activo", entregas: [], ...cambios };
}

describe("la zona manda", () => {
  it("quien ya va a la zona va primero, aunque el otro esté más cerca", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      // Más cerca en línea recta, pero no lleva nada en esta zona.
      motorizado({ id: "cerca", nombre: "Beto", entregas: [{ zona_id: JUANDIAZ, punto: cerca }] }),
      // Más lejos, pero ya va para allá.
      motorizado({ id: "zona", nombre: "Ana", entregas: [{ zona_id: TOCUMEN, punto: lejos }] }),
    ]);
    expect(r[0]!.motorizado_id).toBe("zona");
    expect(r[0]!.yaVaALaZona).toBe(true);
  });

  it("entre dos que ya van a la zona, gana el que tiene entregas cerca", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ id: "lejos", nombre: "Ana", entregas: [{ zona_id: TOCUMEN, punto: lejos }] }),
      motorizado({ id: "cerca", nombre: "Beto", entregas: [{ zona_id: TOCUMEN, punto: cerca }] }),
    ]);
    expect(r[0]!.motorizado_id).toBe("cerca");
  });
});

describe("la carga se paga en kilómetros", () => {
  it("por eso quien va cargado puede perder contra alguien más lejos", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      // Pegado al destino pero con cuatro entregas encima: 0 km + 4 × 2 = 8.
      motorizado({
        id: "cargado",
        nombre: "Ana",
        entregas: Array.from({ length: 4 }, () => ({ zona_id: TOCUMEN, punto: cerca })),
      }),
      // A ~20 km pero con una sola: habría que medirlo, así que se comprueba el
      // orden por el coste, que es lo que decide.
      motorizado({
        id: "libre",
        nombre: "Beto",
        entregas: [{ zona_id: TOCUMEN, punto: { lat: 9.08, lng: -79.39 } }],
      }),
    ]);
    expect(r[0]!.motorizado_id).toBe("libre");
    expect(r[0]!.coste).toBeLessThan(r[1]!.coste);
  });

  it("quien va vacío no queda penalizado por no tener grupo", () => {
    // Es justo a quien conviene darle la primera entrega de una zona nueva.
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ id: "vacio", nombre: "Ana" }),
      motorizado({
        id: "conTres",
        nombre: "Beto",
        entregas: Array.from({ length: 3 }, () => ({ zona_id: TOCUMEN, punto: cerca })),
      }),
    ]);
    const vacio = r.find((c) => c.motorizado_id === "vacio")!;
    expect(vacio.km_al_grupo).toBeNull();
    expect(vacio.coste).toBe(0);
  });
});

describe("a quién no se le propone", () => {
  it("a quien está en pausa", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ id: "pausa", estado: "pausa" }),
    ]);
    expect(r[0]!.proponible).toBe(false);
    expect(r[0]!.motivo).toContain("No está activo");
  });

  it("a quien está inactivo", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ id: "fuera", estado: "inactivo" }),
    ]);
    expect(r[0]!.proponible).toBe(false);
  });

  it("a quien está saturado, por cerca que esté", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({
        id: "saturado",
        entregas: Array.from({ length: MAX_ENTREGAS_POR_MOTORIZADO }, () => ({
          zona_id: TOCUMEN,
          punto: cerca,
        })),
      }),
    ]);
    expect(r[0]!.proponible).toBe(false);
    expect(r[0]!.motivo).toContain(`Ya lleva ${MAX_ENTREGAS_POR_MOTORIZADO} entregas`);
  });

  it("pero salen todos igualmente, al final y con su motivo", () => {
    // Saber POR QUÉ no se propone a alguien vale tanto como la propuesta.
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ id: "pausa", nombre: "Ana", estado: "pausa" }),
      motorizado({ id: "activo", nombre: "Beto" }),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]!.motorizado_id).toBe("activo");
    expect(r[1]!.motorizado_id).toBe("pausa");
    for (const c of r) expect(c.motivo).toBeTruthy();
  });
});

describe("sin coordenada", () => {
  it("ordena por zona y carga, porque no hay más información", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino: null }, [
      motorizado({
        id: "dos",
        nombre: "Ana",
        entregas: [
          { zona_id: TOCUMEN, punto: cerca },
          { zona_id: TOCUMEN, punto: cerca },
        ],
      }),
      motorizado({ id: "una", nombre: "Beto", entregas: [{ zona_id: TOCUMEN, punto: cerca }] }),
    ]);
    expect(r[0]!.motorizado_id).toBe("una");
    expect(r[0]!.km_al_grupo).toBeNull();
    expect(r[0]!.motivo).toContain("va vacío");
  });

  it("una entrega encima sin punto no rompe la cercanía", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ id: "sinPunto", entregas: [{ zona_id: TOCUMEN, punto: null }] }),
    ]);
    expect(r[0]!.km_al_grupo).toBeNull();
    expect(Number.isFinite(r[0]!.coste)).toBe(true);
  });
});

describe("bordes", () => {
  it("sin motorizados no revienta", () => {
    expect(sugerirMotorizado({ zona_id: TOCUMEN, destino }, [])).toEqual([]);
    expect(mejorCandidato([])).toBeNull();
  });

  it("si nadie es proponible, mejorCandidato devuelve null", () => {
    const r = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [
      motorizado({ estado: "inactivo" }),
    ]);
    expect(mejorCandidato(r)).toBeNull();
  });

  it("empata siempre igual, para que el orden no baile entre recargas", () => {
    const gemelos = [
      motorizado({ id: "b", nombre: "Beto" }),
      motorizado({ id: "a", nombre: "Ana" }),
      motorizado({ id: "c", nombre: "Carlos" }),
    ];
    const una = sugerirMotorizado({ zona_id: TOCUMEN, destino }, gemelos).map((c) => c.nombre);
    const otra = sugerirMotorizado({ zona_id: TOCUMEN, destino }, [...gemelos].reverse()).map(
      (c) => c.nombre,
    );
    expect(una).toEqual(["Ana", "Beto", "Carlos"]);
    expect(otra).toEqual(una);
  });
});
