import { describe, expect, it } from "vitest";
import {
  CODIGOS_POR_HORA,
  INTENTOS_CODIGO,
  ITERACIONES,
  MINUTOS_CODIGO,
  crearCodigo,
  esPinValido,
  generarCodigo,
  hashearSecreto,
  igualesSinAtajo,
  mensajeDeCodigo,
  revisarCodigo,
  verificarSecreto,
} from "./pin";

const PEPPER = "pimienta-de-prueba";
// 100.000 iteraciones son lo correcto en producción y lentas en una prueba. Se
// usan pocas para lo que se comprueba aquí (que la comparación funcione) y hay
// una prueba aparte que confirma que el valor de fábrica es el del plan.
const RAPIDO = 1_000;

describe("las cifras son las del plan", () => {
  it("100.000 iteraciones, 10 minutos, 5 intentos, 3 por hora", () => {
    expect(ITERACIONES).toBe(100_000);
    expect(MINUTOS_CODIGO).toBe(10);
    expect(INTENTOS_CODIGO).toBe(5);
    expect(CODIGOS_POR_HORA).toBe(3);
  });
});

describe("esPinValido", () => {
  it("exige seis dígitos exactos", () => {
    expect(esPinValido("123456")).toBe(true);
    for (const malo of ["12345", "1234567", "12345a", "", " 123456", "12 456"]) {
      expect(esPinValido(malo), malo).toBe(false);
    }
  });
});

describe("hashear y verificar", () => {
  it("el PIN correcto coincide y el equivocado no", async () => {
    const guardado = await hashearSecreto("123456", PEPPER, RAPIDO);
    expect(await verificarSecreto("123456", guardado, PEPPER)).toBe(true);
    expect(await verificarSecreto("123457", guardado, PEPPER)).toBe(false);
  });

  it("dos PIN iguales dan hashes distintos, porque la sal es por persona", async () => {
    const a = await hashearSecreto("123456", PEPPER, RAPIDO);
    const b = await hashearSecreto("123456", PEPPER, RAPIDO);
    expect(a).not.toBe(b);
    // Y los dos verifican.
    expect(await verificarSecreto("123456", a, PEPPER)).toBe(true);
    expect(await verificarSecreto("123456", b, PEPPER)).toBe(true);
  });

  it("sin la pimienta correcta no verifica", async () => {
    // Por eso PIN_PEPPER no se rota nunca: rotarlo invalida todos los PIN a la
    // vez y deja a los motorizados fuera en plena ruta.
    const guardado = await hashearSecreto("123456", PEPPER, RAPIDO);
    expect(await verificarSecreto("123456", guardado, "otra-pimienta")).toBe(false);
  });

  it("guarda el algoritmo y las iteraciones dentro del propio texto", async () => {
    // Así se podrán subir las iteraciones el día que WebCrypto admita más, sin
    // invalidar los PIN que ya existen.
    const guardado = await hashearSecreto("123456", PEPPER, RAPIDO);
    expect(guardado.startsWith(`pbkdf2-sha256$${RAPIDO}$`)).toBe(true);
    expect(guardado.split("$")).toHaveLength(4);
  });

  it("verifica un PIN guardado con otras iteraciones que las de hoy", async () => {
    const viejo = await hashearSecreto("123456", PEPPER, 2_000);
    expect(await verificarSecreto("123456", viejo, PEPPER)).toBe(true);
  });

  it("devuelve false ante cualquier cosa rara en vez de lanzar", async () => {
    // Quien llama está en una pantalla de entrar, y un error técnico ahí no se
    // distingue de un sí.
    for (const malo of [
      null,
      "",
      "cualquier-cosa",
      "md5$1000$sal$hash",
      "pbkdf2-sha256$1000$sal",
      "pbkdf2-sha256$abc$c2Fs$aGFzaA",
      "pbkdf2-sha256$1$c2Fs$aGFzaA",
      "pbkdf2-sha256$99999999$c2Fs$aGFzaA",
      "pbkdf2-sha256$1000$$aGFzaA",
      "pbkdf2-sha256$1000$c2Fs$",
      "pbkdf2-sha256$1000$no-base64-url!$aGFzaA",
    ]) {
      expect(await verificarSecreto("123456", malo, PEPPER), String(malo)).toBe(false);
    }
  });
});

describe("igualesSinAtajo", () => {
  it("compara bien", () => {
    expect(igualesSinAtajo(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(igualesSinAtajo(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(igualesSinAtajo(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(igualesSinAtajo(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

describe("generarCodigo", () => {
  it("da seis dígitos, con los ceros de delante", () => {
    for (let i = 0; i < 50; i++) {
      expect(generarCodigo()).toMatch(/^\d{6}$/);
    }
  });

  it("no repite el mismo código una y otra vez", () => {
    const vistos = new Set(Array.from({ length: 50 }, () => generarCodigo()));
    // Con un millón de posibilidades, 50 tiradas casi nunca repiten.
    expect(vistos.size).toBeGreaterThan(45);
  });

  it("cubre todo el rango, incluidos los que empiezan por cero", () => {
    const muchos = Array.from({ length: 2_000 }, () => generarCodigo());
    expect(muchos.some((c) => c.startsWith("0"))).toBe(true);
    expect(muchos.every((c) => Number(c) >= 0 && Number(c) <= 999_999)).toBe(true);
  });
});

describe("códigos de un solo uso", () => {
  const T = 1_800_000_000_000;

  it("se crea con su vencimiento a los diez minutos", async () => {
    const c = await crearCodigo(PEPPER, T);
    expect(c.codigo).toMatch(/^\d{6}$/);
    expect(c.vence_en).toBe(T + 10 * 60_000);
    expect(await verificarSecreto(c.codigo, c.hash, PEPPER)).toBe(true);
  });

  const fila = (cambios: Partial<Parameters<typeof revisarCodigo>[1]> = {}) => ({
    codigo_hash: "",
    intentos: 0,
    vence_en: T + 60_000,
    usado_en: null,
    ...cambios,
  });

  it("acepta el código bueno", async () => {
    const codigo_hash = await hashearSecreto("123456", PEPPER, RAPIDO);
    expect(await revisarCodigo("123456", fila({ codigo_hash }), PEPPER, T)).toEqual({ ok: true });
  });

  it("rechaza el código equivocado", async () => {
    const codigo_hash = await hashearSecreto("123456", PEPPER, RAPIDO);
    expect(await revisarCodigo("000000", fila({ codigo_hash }), PEPPER, T)).toEqual({
      ok: false,
      motivo: "incorrecto",
    });
  });

  it("revisa primero lo que no depende del código", async () => {
    // Para no gastar 100.000 iteraciones en un código que ya no valía.
    expect(await revisarCodigo("123456", fila({ usado_en: T - 1 }), PEPPER, T)).toEqual({
      ok: false,
      motivo: "usado",
    });
    expect(await revisarCodigo("123456", fila({ vence_en: T }), PEPPER, T)).toEqual({
      ok: false,
      motivo: "vencido",
    });
    expect(
      await revisarCodigo("123456", fila({ intentos: INTENTOS_CODIGO }), PEPPER, T),
    ).toEqual({ ok: false, motivo: "sin intentos" });
  });

  it("al quinto intento se queda sin intentos, no al sexto", async () => {
    const codigo_hash = await hashearSecreto("123456", PEPPER, RAPIDO);
    // Con cuatro fallos todavía se puede.
    expect(
      (await revisarCodigo("123456", fila({ codigo_hash, intentos: 4 }), PEPPER, T)).ok,
    ).toBe(true);
    // Con cinco, no.
    const r = await revisarCodigo("123456", fila({ codigo_hash, intentos: 5 }), PEPPER, T);
    expect(r).toEqual({ ok: false, motivo: "sin intentos" });
  });

  it("los mensajes hablan de usted y no dan pistas de más", async () => {
    for (const motivo of ["vencido", "usado", "sin intentos", "incorrecto"] as const) {
      const texto = mensajeDeCodigo({ ok: false, motivo });
      expect(texto).not.toMatch(/\b(tu|tus|tienes|puedes|pide)\b/i);
      expect(texto.length).toBeGreaterThan(10);
    }
  });
});
