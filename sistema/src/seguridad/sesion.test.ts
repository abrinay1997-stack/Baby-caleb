import { describe, expect, it } from "vitest";
import {
  COOKIE_CLIENTE,
  COOKIE_MOTORIZADO,
  DIAS_CLIENTE,
  DURACION_MS,
  type FilaSesion,
  HORAS_MOTORIZADO,
  cookieBorrada,
  crearSesion,
  esVigente,
  estadoDeSesion,
  idDeLaPeticion,
  nuevoId,
  origenPermitido,
} from "./sesion";

const HMAC = "secreto-de-prueba";
const T = 1_800_000_000_000;

const conCookie = (valor: string) =>
  new Request("https://ruta.babycaleb.com/", { headers: { Cookie: valor } });

describe("las duraciones son las del plan", () => {
  it("14 horas el motorizado, 30 días la clienta", () => {
    expect(HORAS_MOTORIZADO).toBe(14);
    expect(DIAS_CLIENTE).toBe(30);
    expect(DURACION_MS.motorizado).toBe(14 * 3_600_000);
    expect(DURACION_MS.cliente).toBe(30 * 86_400_000);
  });
});

describe("nuevoId", () => {
  it("son 256 bits en base64url", () => {
    const id = nuevoId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("no se repite", () => {
    const vistos = new Set(Array.from({ length: 200 }, () => nuevoId()));
    expect(vistos.size).toBe(200);
  });
});

describe("crearSesion", () => {
  it("arma la fila y la cookie con los atributos que exige el plan", async () => {
    const s = await crearSesion("motorizado", "mot-1", HMAC, T);

    expect(s.fila).toMatchObject({
      sujeto_tipo: "motorizado",
      sujeto_id: "mot-1",
      creado_en: T,
      vence_en: T + 14 * 3_600_000,
      revocada_en: null,
    });

    expect(s.setCookie).toContain(`${COOKIE_MOTORIZADO}=`);
    expect(s.setCookie).toContain("HttpOnly");
    expect(s.setCookie).toContain("Secure");
    expect(s.setCookie).toContain("SameSite=Strict");
    expect(s.setCookie).toContain("Path=/");
    expect(s.setCookie).toContain(`Max-Age=${14 * 3600}`);
    // `__Host-` prohíbe el atributo Domain: una cookie así no la puede poner un
    // subdominio comprometido.
    expect(s.setCookie).not.toContain("Domain=");
  });

  it("la clienta usa su propia cookie y sus 30 días", async () => {
    const s = await crearSesion("cliente", "cli-1", HMAC, T);
    expect(s.setCookie).toContain(`${COOKIE_CLIENTE}=`);
    expect(s.fila.vence_en).toBe(T + 30 * 86_400_000);
  });

  it("el valor de la cookie es el id con su firma", async () => {
    const s = await crearSesion("motorizado", "mot-1", HMAC, T);
    const valor = s.setCookie.split(";")[0]!.split("=")[1]!;
    expect(valor.split(".")).toHaveLength(2);
    expect(valor.startsWith(s.fila.id)).toBe(true);
  });
});

describe("idDeLaPeticion", () => {
  it("devuelve el id cuando la firma cuadra", async () => {
    const s = await crearSesion("motorizado", "mot-1", HMAC, T);
    const valor = s.setCookie.split(";")[0]!;
    expect(await idDeLaPeticion(conCookie(valor), "motorizado", HMAC)).toBe(s.fila.id);
  });

  it("rechaza una cookie firmada con otro secreto", async () => {
    const s = await crearSesion("motorizado", "mot-1", HMAC, T);
    const valor = s.setCookie.split(";")[0]!;
    expect(await idDeLaPeticion(conCookie(valor), "motorizado", "otro-secreto")).toBeNull();
  });

  it("rechaza un id cambiado aunque se conserve la firma", async () => {
    const s = await crearSesion("motorizado", "mot-1", HMAC, T);
    const firma = s.setCookie.split(";")[0]!.split(".")[1]!;
    const otroId = nuevoId();
    expect(
      await idDeLaPeticion(conCookie(`${COOKIE_MOTORIZADO}=${otroId}.${firma}`), "motorizado", HMAC),
    ).toBeNull();
  });

  it("no confunde la cookie del motorizado con la de la clienta", async () => {
    const s = await crearSesion("cliente", "cli-1", HMAC, T);
    const valor = s.setCookie.split(";")[0]!;
    expect(await idDeLaPeticion(conCookie(valor), "motorizado", HMAC)).toBeNull();
    expect(await idDeLaPeticion(conCookie(valor), "cliente", HMAC)).toBe(s.fila.id);
  });

  it("devuelve null sin cookie, con mala forma o con un id imposible", async () => {
    for (const cookie of [
      "",
      "otra=cosa",
      `${COOKIE_MOTORIZADO}=sin-punto`,
      `${COOKIE_MOTORIZADO}=.solo-firma`,
      `${COOKIE_MOTORIZADO}=corto.firma`,
      `${COOKIE_MOTORIZADO}=${"x".repeat(43)}.`,
    ]) {
      expect(await idDeLaPeticion(conCookie(cookie), "motorizado", HMAC), cookie).toBeNull();
    }
    expect(
      await idDeLaPeticion(new Request("https://ruta.babycaleb.com/"), "motorizado", HMAC),
    ).toBeNull();
  });

  it("encuentra su cookie entre otras", async () => {
    const s = await crearSesion("motorizado", "mot-1", HMAC, T);
    const valor = s.setCookie.split(";")[0]!;
    const r = conCookie(`otra=1; ${valor}; tercera=2`);
    expect(await idDeLaPeticion(r, "motorizado", HMAC)).toBe(s.fila.id);
  });
});

describe("estadoDeSesion", () => {
  const fila = (cambios: Partial<FilaSesion> = {}): FilaSesion => ({
    id: nuevoId(),
    sujeto_tipo: "motorizado",
    sujeto_id: "mot-1",
    creado_en: T,
    vence_en: T + 60_000,
    revocada_en: null,
    ...cambios,
  });

  it("la fila de D1 es la que manda", () => {
    expect(estadoDeSesion(fila(), T)).toBe("vigente");
    expect(estadoDeSesion(fila({ vence_en: T }), T)).toBe("vencida");
    expect(estadoDeSesion(fila({ revocada_en: T - 1 }), T)).toBe("revocada");
    expect(estadoDeSesion(null, T)).toBe("no_existe");
  });

  it("revocar gana sobre el vencimiento: se dice lo que de verdad pasó", () => {
    expect(estadoDeSesion(fila({ vence_en: T - 1, revocada_en: T - 2 }), T)).toBe("revocada");
  });

  it("esVigente es el atajo de lo mismo", () => {
    expect(esVigente(fila(), T)).toBe(true);
    expect(esVigente(fila({ revocada_en: T }), T)).toBe(false);
    expect(esVigente(null, T)).toBe(false);
  });
});

describe("cookieBorrada", () => {
  it("vacía la cookie con Max-Age=0", () => {
    expect(cookieBorrada("motorizado")).toContain(`${COOKIE_MOTORIZADO}=;`);
    expect(cookieBorrada("motorizado")).toContain("Max-Age=0");
  });
});

describe("origenPermitido", () => {
  const PANEL = ["https://panel.babycaleb.com"];
  const post = (origen?: string) =>
    new Request("https://panel.babycaleb.com/api/precios", {
      method: "POST",
      ...(origen ? { headers: { Origin: origen } } : {}),
    });

  it("deja pasar las lecturas sin mirar el origen", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const r = new Request("https://panel.babycaleb.com/api/pedidos", { method });
      expect(origenPermitido(r, PANEL), method).toBe(true);
    }
  });

  it("exige el origen del panel para cambiar algo", () => {
    expect(origenPermitido(post("https://panel.babycaleb.com"), PANEL)).toBe(true);
    expect(origenPermitido(post("https://evil.com"), PANEL)).toBe(false);
    expect(origenPermitido(post("https://babycaleb.com"), PANEL)).toBe(false);
  });

  it("un POST sin Origin se rechaza", () => {
    // Los navegadores lo mandan siempre: si no viene, al otro lado no hay un
    // navegador.
    expect(origenPermitido(post(), PANEL)).toBe(false);
  });

  it("es la segunda capa, además de SameSite", () => {
    // SameSite lo aplica el navegador y esto lo aplica el servidor: si un
    // navegador viejo no respeta la primera, queda la segunda.
    expect(origenPermitido(post("null"), PANEL)).toBe(false);
  });
});
