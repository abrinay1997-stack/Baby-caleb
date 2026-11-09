import { describe, expect, it } from "vitest";
import { CENTRO_CIUDAD_PANAMA, type Punto } from "./geo";
import { type Parada, ahorroDeLaRuta, distanciaKm, proponerRuta } from "./rutas";

const BODEGA: Punto = CENTRO_CIUDAD_PANAMA;
const parada = (id: string, lat: number, lng: number): Parada => ({ id, punto: { lat, lng } });

describe("distanciaKm", () => {
  it("un punto consigo mismo son cero kilómetros", () => {
    expect(distanciaKm(BODEGA, BODEGA)).toBe(0);
  });

  it("da kilómetros, no grados ni metros", () => {
    // Un grado de latitud son unos 111 km en cualquier parte del planeta.
    const d = distanciaKm({ lat: 8, lng: -79 }, { lat: 9, lng: -79 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it("es simétrica", () => {
    const a = { lat: 8.9, lng: -79.5 };
    const b = { lat: 9.1, lng: -79.4 };
    expect(distanciaKm(a, b)).toBeCloseTo(distanciaKm(b, a), 10);
  });

  it("una coordenada inválida da infinito, no un número que engañe", () => {
    expect(distanciaKm(BODEGA, { lat: Number.NaN, lng: 0 })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("proponerRuta", () => {
  it("ordena en fila lo que llegó desordenado", () => {
    // Cuatro paradas en línea hacia el este, mezcladas a la entrada.
    const paradas = [
      parada("d", 8.98, -79.40),
      parada("b", 8.98, -79.48),
      parada("a", 8.98, -79.51),
      parada("c", 8.98, -79.44),
    ];
    const ruta = proponerRuta({ lat: 8.98, lng: -79.52 }, paradas);
    expect(ruta.orden.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("el orden propuesto nunca es peor que el que llegó", () => {
    const paradas = [
      parada("1", 9.05, -79.40),
      parada("2", 8.95, -79.55),
      parada("3", 9.00, -79.45),
      parada("4", 8.90, -79.60),
      parada("5", 9.10, -79.35),
    ];
    const ruta = proponerRuta(BODEGA, paradas);
    expect(ruta.distanciaKm).toBeLessThanOrEqual(ruta.distanciaOriginalKm + 1e-9);
  });

  it("deshace los cruces que el vecino más cercano deja, y se nota", () => {
    // Un zigzag: el vecino más cercano cae en la trampa y el 2-opt lo arregla.
    const paradas = [
      parada("a", 8.98, -79.50),
      parada("b", 9.02, -79.46),
      parada("c", 8.98, -79.46),
      parada("d", 9.02, -79.50),
    ];
    const ruta = proponerRuta({ lat: 8.98, lng: -79.52 }, paradas);
    expect(ruta.distanciaKm).toBeLessThan(ruta.distanciaOriginalKm);
  });

  it("aparta las paradas sin punto en el mapa en vez de ponerlas al final", () => {
    // No son un problema de orden sino de datos: quien reparte va a tener que
    // llamar por teléfono, y eso se planifica distinto.
    const paradas: Parada[] = [parada("con", 8.98, -79.50), { id: "sin", punto: null }];
    const ruta = proponerRuta(BODEGA, paradas);
    expect(ruta.orden.map((p) => p.id)).toEqual(["con"]);
    expect(ruta.sinUbicar.map((p) => p.id)).toEqual(["sin"]);
  });

  it("una coordenada rota cuenta como sin ubicar", () => {
    const ruta = proponerRuta(BODEGA, [{ id: "rota", punto: { lat: 999, lng: 0 } }]);
    expect(ruta.sinUbicar.map((p) => p.id)).toEqual(["rota"]);
  });

  it("sin paradas devuelve una ruta vacía y no revienta", () => {
    const ruta = proponerRuta(BODEGA, []);
    expect(ruta.orden).toEqual([]);
    expect(ruta.distanciaKm).toBe(0);
  });

  it("con una sola parada el orden es esa parada", () => {
    const ruta = proponerRuta(BODEGA, [parada("sola", 8.98, -79.5)]);
    expect(ruta.orden.map((p) => p.id)).toEqual(["sola"]);
  });

  it("no pierde ni duplica paradas", () => {
    const paradas = [
      parada("1", 9.05, -79.40),
      parada("2", 8.95, -79.55),
      { id: "3", punto: null },
      parada("4", 8.90, -79.60),
    ];
    const ruta = proponerRuta(BODEGA, paradas);
    const ids = [...ruta.orden, ...ruta.sinUbicar].map((p) => p.id).sort();
    expect(ids).toEqual(["1", "2", "3", "4"]);
  });
});

describe("ahorroDeLaRuta", () => {
  it("mide lo que se ahorra en kilómetros y en porcentaje", () => {
    const paradas = [
      parada("a", 8.98, -79.50),
      parada("b", 9.02, -79.46),
      parada("c", 8.98, -79.46),
      parada("d", 9.02, -79.50),
    ];
    const ahorro = ahorroDeLaRuta(proponerRuta({ lat: 8.98, lng: -79.52 }, paradas));
    expect(ahorro.km).toBeGreaterThan(0);
    expect(ahorro.porcentaje).toBeGreaterThan(0);
    expect(ahorro.porcentaje).toBeLessThanOrEqual(100);
  });

  it("con el orden ya óptimo el ahorro es cero, no negativo", () => {
    const paradas = [parada("a", 8.98, -79.51), parada("b", 8.98, -79.48)];
    const ahorro = ahorroDeLaRuta(proponerRuta({ lat: 8.98, lng: -79.52 }, paradas));
    expect(ahorro.km).toBeGreaterThanOrEqual(0);
  });

  it("sin paradas no divide por cero", () => {
    const ahorro = ahorroDeLaRuta(proponerRuta(BODEGA, []));
    expect(ahorro).toEqual({ km: 0, porcentaje: 0 });
  });
});
