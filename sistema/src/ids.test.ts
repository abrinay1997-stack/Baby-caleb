import { beforeEach, describe, expect, it } from "vitest";
import { LARGO_ULID, esUlid, msDeUlid, reiniciarUlid, token, ulid } from "./ids";

beforeEach(() => {
  // El contador de monotonía vive en el módulo: sin esto una prueba se apoyaría
  // en lo que dejó la anterior.
  reiniciarUlid();
});

const T = 1_800_000_000_000;

describe("forma", () => {
  it("son 26 caracteres del alfabeto de Crockford", () => {
    const id = ulid(T);
    expect(id).toHaveLength(LARGO_ULID);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("no usa I, L, O ni U, para que nadie los confunda al leerlos", () => {
    const muchos = Array.from({ length: 200 }, (_, i) => ulid(T + i)).join("");
    for (const letra of ["I", "L", "O", "U"]) {
      expect(muchos.includes(letra), letra).toBe(false);
    }
  });

  it("esUlid reconoce los buenos y rechaza el resto", () => {
    expect(esUlid(ulid(T))).toBe(true);
    for (const malo of [
      "",
      "corto",
      ulid(T).slice(0, 25),
      ulid(T) + "X",
      ulid(T).replace(/^./, "I"),
      ulid(T).toLowerCase(),
      42,
      null,
      undefined,
    ]) {
      expect(esUlid(malo), String(malo)).toBe(false);
    }
  });
});

describe("ordenables por tiempo", () => {
  it("un id posterior es mayor como texto", () => {
    const a = ulid(T);
    const b = ulid(T + 1);
    const c = ulid(T + 1000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("ordenar como texto es ordenar por fecha", () => {
    // El tiempo avanza, que es como pasa en la realidad.
    const tiempos = [T, T + 1, T + 100, T + 5_000, T + 50_000];
    const ids = tiempos.map((t) => ulid(t));
    expect([...ids].sort()).toEqual(ids);
    expect(ids.map((id) => msDeUlid(id))).toEqual(tiempos);
  });

  it("dos del MISMO milisegundo también salen en orden", () => {
    // Sin monotonía, el orden de dos pedidos creados en el mismo milisegundo
    // sería el del azar, y `ORDER BY id` los devolvería al revés de como
    // pasaron.
    const seguidos = Array.from({ length: 50 }, () => ulid(T));
    expect([...seguidos].sort()).toEqual(seguidos);
  });

  it("si el reloj va hacia atrás, no devuelve un id del pasado", () => {
    const antes = ulid(T);
    const despues = ulid(T - 10_000);
    expect(despues > antes).toBe(true);
    // Y conserva el tiempo del último visto, no el que se le pidió: un id con
    // fecha anterior rompería el orden, que es justo lo que el ULID garantiza.
    expect(msDeUlid(despues)).toBe(T);
  });
});

describe("únicos", () => {
  it("no se repite ni dentro del mismo milisegundo", () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => ulid(T)));
    expect(ids.size).toBe(2_000);
  });

  it("ni a lo largo de varios milisegundos", () => {
    const ids = new Set(Array.from({ length: 2_000 }, (_, i) => ulid(T + (i % 7))));
    expect(ids.size).toBe(2_000);
  });
});

describe("msDeUlid", () => {
  it("devuelve los milisegundos que trae dentro", () => {
    expect(msDeUlid(ulid(T))).toBe(T);
    reiniciarUlid(); // si no, la guardia de monotonía conservaría T
    expect(msDeUlid(ulid(0))).toBe(0);
  });

  it("devuelve null si no es un ULID", () => {
    expect(msDeUlid("cualquier-cosa")).toBeNull();
  });
});

describe("tiempos imposibles", () => {
  it("lanza con un tiempo que no cabe en 48 bits o no es un entero", () => {
    for (const malo of [-1, Number.NaN, 281_474_976_710_656, Number.POSITIVE_INFINITY]) {
      expect(() => ulid(malo), String(malo)).toThrow(RangeError);
    }
  });
});

describe("token", () => {
  it("son 256 bits en base64url", () => {
    expect(token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("no se repite", () => {
    expect(new Set(Array.from({ length: 500 }, () => token())).size).toBe(500);
  });

  it("NO es ordenable, y eso es a propósito", () => {
    // Un token sale en un enlace que cualquiera puede recibir: si fuera un
    // ULID, diría cuándo se creó el pedido y se podría ir probando el de al
    // lado. Esto es azar puro.
    const seguidos = Array.from({ length: 30 }, () => token());
    expect([...seguidos].sort()).not.toEqual(seguidos);
    for (const t of seguidos) expect(esUlid(t)).toBe(false);
  });
});
