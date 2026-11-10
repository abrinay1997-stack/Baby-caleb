import { describe, expect, it } from "vitest";
import {
  type PartesDeDireccion,
  normalizarProvincia,
  repartirDireccion,
  sugerirZonaDeEnvio,
  tieneAlgoQueRellenar,
} from "./direccion";
import type { Zona } from "./zonas";

const reparte = (partes: PartesDeDireccion, etiqueta = "etiqueta completa") =>
  repartirDireccion(partes, etiqueta);

describe("repartirDireccion", () => {
  it("junta la calle con su número", () => {
    const d = reparte({ road: "Vía España", house_number: "123" });
    expect(d.texto).toBe("Vía España 123");
  });

  it("quita el «Provincia de» y el «Distrito de»", () => {
    // Son correctos en un mapa y ruidosos en una etiqueta de envío: quien la
    // lee quiere leer «Panamá».
    const d = reparte({ city: "Distrito de Panamá", state: "Provincia de Panamá" });
    expect(d.ciudad).toBe("Panamá");
    expect(d.provincia).toBe("Panamá");
  });

  it("usa el barrio como dirección cuando no hay calle", () => {
    // Es exactamente lo que escribiría a mano quien vive ahí.
    const d = reparte({ neighbourhood: "Villa Lucre", city: "Juan Díaz" });
    expect(d.texto).toBe("Villa Lucre");
    expect(d.ciudad).toBe("Juan Díaz");
  });

  it("no deja el mismo texto en dirección y ciudad", () => {
    // Dos veces el mismo texto en la etiqueta parece un error de la tienda.
    const d = reparte({ suburb: "Villa Lucre" });
    expect(d.texto).toBe("Villa Lucre");
    expect(d.ciudad).not.toBe("Villa Lucre");
  });

  it("sube el barrio a ciudad cuando sí hay calle y no hay ciudad", () => {
    const d = reparte({ road: "Calle 50", neighbourhood: "Bella Vista" });
    expect(d.texto).toBe("Calle 50");
    expect(d.ciudad).toBe("Bella Vista");
  });

  it("devuelve campos vacíos en vez de inventarlos", () => {
    // Un campo en blanco lo rellena la clienta en dos segundos; una calle
    // equivocada la descubre el motorizado en la puerta de otra casa.
    const d = reparte({});
    expect(d).toMatchObject({ texto: "", ciudad: "", provincia: "" });
  });

  it("aguanta que no llegue nada", () => {
    expect(repartirDireccion(undefined, "")).toMatchObject({ texto: "", etiqueta: "" });
  });

  it("guarda la etiqueta completa para poder enseñarla", () => {
    const d = reparte({ road: "Calle 50" }, "  Calle 50, Bella Vista, Panamá  ");
    expect(d.etiqueta).toBe("Calle 50, Bella Vista, Panamá");
  });

  it("prefiere la jerarquía de OSM en el orden que corresponde en Panamá", () => {
    // provincia → distrito → corregimiento cae en state → county → city.
    const d = reparte({ city: "Tocumen", county: "Panamá", state: "Panamá" });
    expect(d.ciudad).toBe("Tocumen");
  });
});

describe("normalizarProvincia", () => {
  it("reconoce la provincia aunque venga sin tildes o en minúsculas", () => {
    expect(normalizarProvincia("chiriqui")).toBe("Chiriquí");
    expect(normalizarProvincia("COCLE")).toBe("Coclé");
    expect(normalizarProvincia("Provincia de Colon")).toBe("Colón");
  });

  it("reconoce las comarcas", () => {
    expect(normalizarProvincia("guna yala")).toBe("Guna Yala");
    expect(normalizarProvincia("Comarca Ngabe-Bugle")).toBe("Ngäbe-Buglé");
  });

  it("respeta lo que no conoce en vez de vaciarlo", () => {
    // Una comarca nueva o un cambio administrativo no debe vaciar el campo.
    expect(normalizarProvincia("Provincia Nueva")).toBe("Nueva");
    expect(normalizarProvincia("Algo Raro")).toBe("Algo Raro");
  });

  it("devuelve vacío cuando no llega nada", () => {
    expect(normalizarProvincia("")).toBe("");
    expect(normalizarProvincia("   ")).toBe("");
  });
});

describe("tieneAlgoQueRellenar", () => {
  it("distingue una dirección vacía de una con un solo campo", () => {
    expect(tieneAlgoQueRellenar({ texto: "", ciudad: "", provincia: "", etiqueta: "x" })).toBe(false);
    expect(tieneAlgoQueRellenar({ texto: "", ciudad: "Tocumen", provincia: "", etiqueta: "" })).toBe(
      true,
    );
  });
});

describe("sugerirZonaDeEnvio", () => {
  const zona = (id: string, nombre: string, alias: string[] = []): Zona => ({
    id,
    nombre,
    alias,
    region: "ciudad",
    metodo: "motorizado",
    tarifa_cents: 350,
    requiere_pago_total: false,
    activa: true,
  });

  const TARIFARIO = [
    zona("z-tocumen", "Tocumen"),
    zona("z-juandiaz", "Juan Díaz"),
    zona("z-24dic", "24 de Diciembre", ["24 dic"]),
  ];

  it("acierta la zona cuando el corregimiento coincide con el tarifario", () => {
    const d = reparte({ road: "Calle Principal", city: "Tocumen", state: "Panamá" });
    const s = sugerirZonaDeEnvio(d, TARIFARIO);
    expect(s.zona?.id).toBe("z-tocumen");
  });

  it("acierta sin tildes, que es como lo escribe el geocodificador a veces", () => {
    const d = reparte({ city: "Juan Diaz" });
    expect(sugerirZonaDeEnvio(d, TARIFARIO).zona?.id).toBe("z-juandiaz");
  });

  it("propone candidatas en vez de adivinar cuando no hay coincidencia exacta", () => {
    // La zona fija la tarifa: acertarla por casualidad es tan malo como
    // fallarla, así que elige la clienta.
    const d = reparte({ city: "Diciembre Alto" });
    const s = sugerirZonaDeEnvio(d, TARIFARIO);
    expect(s.zona).toBeNull();
    expect(s.candidatas.map((z) => z.id)).toContain("z-24dic");
  });

  it("no propone nada cuando la dirección no da pistas", () => {
    const s = sugerirZonaDeEnvio(reparte({}), TARIFARIO);
    expect(s.zona).toBeNull();
    expect(s.candidatas).toEqual([]);
  });

  it("si el corregimiento no está en el tarifario, prueba con la provincia", () => {
    const conInterior = [...TARIFARIO, zona("z-chiriqui", "Chiriquí")];
    const d = reparte({ city: "Dolega", state: "Chiriquí" });
    expect(sugerirZonaDeEnvio(d, conInterior).zona?.id).toBe("z-chiriqui");
  });
});
