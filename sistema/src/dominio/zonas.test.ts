import { describe, expect, it } from "vitest";
import { type Zona, buscarZona, cotizarEnvio, exigePagoTotal, normalizar, sugerirZonas } from "./zonas";

function zona(cambios: Partial<Zona> = {}): Zona {
  return {
    id: "z-tocumen",
    nombre: "Tocumen",
    alias: [],
    region: "ciudad",
    metodo: "motorizado",
    tarifa_cents: 350,
    requiere_pago_total: false,
    activa: true,
    ...cambios,
  };
}

const TARIFARIO: Zona[] = [
  zona(),
  zona({ id: "z-24dic", nombre: "24 de Diciembre", alias: ["24 dic", "veinticuatro de diciembre"] }),
  zona({ id: "z-juandiaz", nombre: "Juan Díaz", alias: ["juandiaz"] }),
  zona({ id: "z-pacora", nombre: "Pacora", tarifa_cents: 500 }),
  // Interior: se cotiza a mano y exige pago total.
  zona({
    id: "z-chiriqui",
    nombre: "Chiriquí",
    region: "interior",
    metodo: "ferguson",
    tarifa_cents: null,
    requiere_pago_total: true,
  }),
  zona({ id: "z-vieja", nombre: "Zona Vieja", activa: false }),
];

describe("normalizar", () => {
  it("quita tildes, mayúsculas y puntuación", () => {
    expect(normalizar("Tocúmen")).toBe("tocumen");
    expect(normalizar("  JUAN  DÍAZ ")).toBe("juan diaz");
    expect(normalizar("24 de Diciembre!")).toBe("24 de diciembre");
  });

  it("pliega la ñ a n, porque quien escribe deprisa tampoco la pone", () => {
    // Así «pena blanca» encuentra «Peña Blanca».
    expect(normalizar("Peña")).toBe("pena");
  });

  it("de un texto vacío sale vacío", () => {
    expect(normalizar("   ")).toBe("");
  });
});

describe("buscarZona", () => {
  it("encuentra por nombre, sin importar tildes ni mayúsculas", () => {
    // Quien escribe por WhatsApp no pone tildes.
    expect(buscarZona("tocumen", TARIFARIO)?.id).toBe("z-tocumen");
    expect(buscarZona("TOCÚMEN", TARIFARIO)?.id).toBe("z-tocumen");
    expect(buscarZona(" Juan Diaz ", TARIFARIO)?.id).toBe("z-juandiaz");
  });

  it("encuentra por alias", () => {
    expect(buscarZona("24 dic", TARIFARIO)?.id).toBe("z-24dic");
    expect(buscarZona("juandiaz", TARIFARIO)?.id).toBe("z-juandiaz");
  });

  it("no devuelve zonas desactivadas", () => {
    expect(buscarZona("Zona Vieja", TARIFARIO)).toBeNull();
  });

  it("devuelve null en vez de adivinar: adivinar la zona es adivinar la tarifa", () => {
    expect(buscarZona("tocu", TARIFARIO)).toBeNull();
    expect(buscarZona("", TARIFARIO)).toBeNull();
    expect(buscarZona("Barrio que no existe", TARIFARIO)).toBeNull();
  });

  it("si dos zonas activas responden al mismo texto, no elige ninguna", () => {
    // El dato está mal y hay que arreglarlo, no desempatarlo a la suerte.
    const duplicadas = [zona({ id: "a" }), zona({ id: "b", nombre: "tocumen" })];
    expect(buscarZona("Tocumen", duplicadas)).toBeNull();
  });
});

describe("sugerirZonas", () => {
  it("pone delante lo que empieza por lo escrito", () => {
    const r = sugerirZonas("pa", TARIFARIO).map((z) => z.nombre);
    expect(r[0]).toBe("Pacora");
  });

  it("también encuentra por el medio del nombre", () => {
    expect(sugerirZonas("diciembre", TARIFARIO).map((z) => z.id)).toContain("z-24dic");
  });

  it("busca en los alias", () => {
    expect(sugerirZonas("veinticuatro", TARIFARIO).map((z) => z.id)).toEqual(["z-24dic"]);
  });

  it("sin texto devuelve la lista completa en orden alfabético", () => {
    const r = sugerirZonas("", TARIFARIO, 99).map((z) => z.nombre);
    expect(r).toEqual([...r].sort((a, b) => a.localeCompare(b, "es")));
    expect(r).not.toContain("Zona Vieja");
  });

  it("respeta el máximo", () => {
    expect(sugerirZonas("", TARIFARIO, 2)).toHaveLength(2);
  });

  it("no sugiere desactivadas", () => {
    expect(sugerirZonas("vieja", TARIFARIO)).toEqual([]);
  });
});

describe("cotizarEnvio", () => {
  it("devuelve la tarifa de la zona", () => {
    const r = cotizarEnvio(zona({ tarifa_cents: 350 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.tarifa_cents).toBe(350);
      expect(r.datos.zona).toBe("Tocumen");
      expect(r.datos.requiere_pago_total).toBe(false);
    }
  });

  it("una zona sin tarifa NO vale cero: se cotiza a mano", () => {
    // Devolver 0 aquí sería regalar el envío al interior.
    const r = cotizarEnvio(zona({ nombre: "Chiriquí", tarifa_cents: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.mensaje).toContain("se cotiza a mano");
      expect(r.mensaje).toContain("Chiriquí");
    }
  });

  it("una zona desactivada no se cotiza", () => {
    const r = cotizarEnvio(zona({ activa: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  it("una tarifa de cero sí es cero: envío gratis declarado", () => {
    // Cero declarado y null son cosas distintas, y por eso la columna admite
    // null en vez de usar 0 como «no se sabe».
    const r = cotizarEnvio(zona({ tarifa_cents: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.tarifa_cents).toBe(0);
  });
});

describe("exigePagoTotal", () => {
  it("lo exige cuando la zona lo dice", () => {
    expect(exigePagoTotal(zona({ requiere_pago_total: true }))).toBe(true);
  });

  it("lo exige siempre que el envío sea por Ferguson", () => {
    expect(exigePagoTotal(zona({ metodo: "ferguson", requiere_pago_total: false }))).toBe(true);
  });

  it("no lo exige en una entrega normal con motorizado", () => {
    expect(exigePagoTotal(zona())).toBe(false);
  });
});
