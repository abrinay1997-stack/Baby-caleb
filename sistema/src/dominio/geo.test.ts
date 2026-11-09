import { describe, expect, it } from "vitest";
import {
  CENTRO_CIUDAD_PANAMA,
  PRECISIONES,
  type Anillo,
  enlacesDeNavegacion,
  esPrecision,
  esPuntoConfiable,
  esPuntoValido,
  estaEnPanama,
  leerPoligono,
  puntoEnPoligono,
  redondearCoordenada,
} from "./geo";

describe("esPuntoValido", () => {
  it("acepta coordenadas reales", () => {
    expect(esPuntoValido(CENTRO_CIUDAD_PANAMA)).toBe(true);
    expect(esPuntoValido({ lat: 0, lng: 0 })).toBe(true);
  });

  it("rechaza lo que está fuera del rango del planeta", () => {
    expect(esPuntoValido({ lat: 91, lng: 0 })).toBe(false);
    expect(esPuntoValido({ lat: 0, lng: 181 })).toBe(false);
  });

  it("rechaza lo que no es un número", () => {
    expect(esPuntoValido({ lat: Number.NaN, lng: 0 })).toBe(false);
    expect(esPuntoValido({ lat: 0, lng: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe("estaEnPanama", () => {
  it("reconoce Ciudad de Panamá", () => {
    expect(estaEnPanama(CENTRO_CIUDAD_PANAMA)).toBe(true);
  });

  it("reconoce David, en Chiriquí", () => {
    expect(estaEnPanama({ lat: 8.4333, lng: -82.4333 })).toBe(true);
  });

  it("detecta las coordenadas invertidas", () => {
    // El error clásico: lat y lng al revés. Panamá queda en lng negativa, así
    // que invertirlas saca el punto del país.
    expect(estaEnPanama({ lat: -79.5199, lng: 8.9824 })).toBe(false);
  });

  it("rechaza otros países", () => {
    expect(estaEnPanama({ lat: 40.4168, lng: -3.7038 })).toBe(false); // Madrid
    expect(estaEnPanama({ lat: 4.711, lng: -74.0721 })).toBe(false); // Bogotá
  });

  it("rechaza el (0,0), que es lo que sale de un formulario vacío", () => {
    expect(estaEnPanama({ lat: 0, lng: 0 })).toBe(false);
  });
});

describe("redondearCoordenada", () => {
  it("redondea a siete decimales", () => {
    expect(redondearCoordenada(8.98241234567891)).toBe(8.9824123);
  });

  it("no toca lo que ya cabe", () => {
    expect(redondearCoordenada(8.9824)).toBe(8.9824);
    expect(redondearCoordenada(-79.5199)).toBe(-79.5199);
  });
});

describe("puntoEnPoligono", () => {
  // Un cuadrado de 2x2 centrado en el origen, en orden GeoJSON [lng, lat].
  const cuadrado: Anillo = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];

  it("reconoce un punto interior", () => {
    expect(puntoEnPoligono({ lat: 0, lng: 0 }, cuadrado)).toBe(true);
  });

  it("rechaza un punto exterior", () => {
    expect(puntoEnPoligono({ lat: 5, lng: 5 }, cuadrado)).toBe(false);
  });

  it("no confunde el orden de los ejes", () => {
    // Un rectángulo ancho en lng y estrecho en lat: si se leyera [lat, lng] el
    // resultado se invertiría y esta prueba lo caza.
    const ancho: Anillo = [
      [-10, -1],
      [10, -1],
      [10, 1],
      [-10, 1],
    ];
    expect(puntoEnPoligono({ lat: 0, lng: 9 }, ancho)).toBe(true);
    expect(puntoEnPoligono({ lat: 9, lng: 0 }, ancho)).toBe(false);
  });

  it("funciona con un polígono cóncavo", () => {
    // Una «L»: el hueco de la esquina queda fuera.
    const ele: Anillo = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ];
    expect(puntoEnPoligono({ lat: 0.5, lng: 0.5 }, ele)).toBe(true);
    expect(puntoEnPoligono({ lat: 1.5, lng: 1.5 }, ele)).toBe(false);
  });

  it("funciona con coordenadas negativas, que es el caso real de Panamá", () => {
    const ciudad: Anillo = [
      [-79.6, 8.9],
      [-79.4, 8.9],
      [-79.4, 9.1],
      [-79.6, 9.1],
    ];
    expect(puntoEnPoligono(CENTRO_CIUDAD_PANAMA, ciudad)).toBe(true);
    expect(puntoEnPoligono({ lat: 8.4333, lng: -82.4333 }, ciudad)).toBe(false);
  });

  it("devuelve false con un polígono que no encierra nada", () => {
    expect(puntoEnPoligono({ lat: 0, lng: 0 }, [])).toBe(false);
    expect(
      puntoEnPoligono({ lat: 0, lng: 0 }, [
        [0, 0],
        [1, 1],
      ]),
    ).toBe(false);
  });

  it("devuelve false con un punto inválido", () => {
    expect(puntoEnPoligono({ lat: Number.NaN, lng: 0 }, cuadrado)).toBe(false);
  });
});

describe("leerPoligono", () => {
  it("lee un anillo correcto", () => {
    expect(
      leerPoligono([
        [-79.6, 8.9],
        [-79.4, 8.9],
        [-79.4, 9.1],
      ]),
    ).toEqual([
      [-79.6, 8.9],
      [-79.4, 8.9],
      [-79.4, 9.1],
    ]);
  });

  it("descarta el anillo entero si algún par está mal", () => {
    // Un anillo a medio leer es peor que uno vacío: haría que puntoEnPoligono
    // respondiera que sí a puntos que no.
    for (const malo of [
      [[0, 0], [1, 0], ["a", 1]],
      [[0, 0], [1, 0], [1]],
      [[0, 0], [1, 0], [1, Number.NaN]],
    ]) {
      expect(leerPoligono(malo)).toEqual([]);
    }
  });

  it("descarta los anillos que no encierran nada", () => {
    expect(leerPoligono([[0, 0], [1, 1]])).toEqual([]);
  });

  it("devuelve vacío cuando no es un array", () => {
    for (const malo of [null, undefined, 42, "[]", {}]) {
      expect(leerPoligono(malo)).toEqual([]);
    }
  });
});

describe("enlacesDeNavegacion", () => {
  it("arma los enlaces de Waze y Google Maps", () => {
    const e = enlacesDeNavegacion(CENTRO_CIUDAD_PANAMA);
    expect(e?.waze).toBe("https://waze.com/ul?ll=8.9824%2C-79.5199&navigate=yes");
    expect(e?.googleMaps).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=8.9824%2C-79.5199",
    );
  });

  it("redondea antes de armar el enlace", () => {
    const e = enlacesDeNavegacion({ lat: 8.98241234567891, lng: -79.51991234567891 });
    expect(e?.waze).toContain("8.9824123%2C-79.5199123");
  });

  it("devuelve null con un punto inválido, en vez de un enlace roto", () => {
    expect(enlacesDeNavegacion({ lat: Number.NaN, lng: 0 })).toBeNull();
  });
});

describe("precisión del punto", () => {
  it("son las cuatro del CHECK de direcciones, con «geocodificado» en español", () => {
    expect([...PRECISIONES]).toEqual(["gps", "pin", "geocodificado", "manual"]);
    // Nébula la llamaba «geocoded»; la base de Baby Caleb no la aceptaría.
    expect(esPrecision("geocoded")).toBe(false);
  });

  it("reconoce las cuatro y rechaza el resto", () => {
    for (const p of PRECISIONES) expect(esPrecision(p)).toBe(true);
    expect(esPrecision("")).toBe(false);
    expect(esPrecision("GPS")).toBe(false);
  });

  it("gps y pin son confiables; lo deducido y lo escrito a mano, no", () => {
    expect(esPuntoConfiable("gps")).toBe(true);
    expect(esPuntoConfiable("pin")).toBe(true);
    expect(esPuntoConfiable("geocodificado")).toBe(false);
    expect(esPuntoConfiable("manual")).toBe(false);
  });
});
