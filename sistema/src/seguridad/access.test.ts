import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CABECERA_TOKEN,
  type ConfigAccess,
  configAccess,
  reiniciarCacheJwks,
  revisarPeticion,
  revisarToken,
} from "./access";

// Estas pruebas firman tokens con un par de llaves RSA DE VERDAD y le dan al
// módulo un listado de llaves inyectado. Así se comprueba la verificación real
// de la firma, no un simulacro: un token firmado con otra llave tiene que
// rechazarse porque la criptografía dice que no, no porque una prueba lo finja.

const EQUIPO = "https://babycaleb.cloudflareaccess.com";
const AUD = "a".repeat(64);
const CFG: ConfigAccess = { equipo: EQUIPO, aud: AUD };
const KID = "llave-1";

const codificador = new TextEncoder();

function aBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const parteJson = (o: unknown) => aBase64Url(codificador.encode(JSON.stringify(o)));

let par: CryptoKeyPair;
let otroPar: CryptoKeyPair;
let jwkPublica: JsonWebKey;

async function generar(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

beforeAll(async () => {
  par = await generar();
  otroPar = await generar();
  // exportKey está declarado como ArrayBuffer | JsonWebKey; con "jwk" es lo segundo.
  jwkPublica = (await crypto.subtle.exportKey("jwk", par.publicKey)) as JsonWebKey;
});

beforeEach(() => {
  // El listado de llaves vive en memoria del isolate: sin esto, una prueba se
  // apoyaría en lo que cargó la anterior.
  reiniciarCacheJwks();
});

/** El listado que devolvería `<equipo>/cdn-cgi/access/certs`. */
const jwks = () => ({ keys: [{ ...jwkPublica, kid: KID, alg: "RS256", use: "sig" }] });

const AHORA_MS = 1_800_000_000_000;
const AHORA_S = Math.floor(AHORA_MS / 1000);

async function token(
  cambios: {
    carga?: Record<string, unknown>;
    cabecera?: Record<string, unknown>;
    privada?: CryptoKey;
  } = {},
): Promise<string> {
  const cabecera = { alg: "RS256", kid: KID, typ: "JWT", ...cambios.cabecera };
  const carga = {
    iss: EQUIPO,
    aud: AUD,
    email: "dueña@babycaleb.com".replace("ñ", "n"),
    exp: AHORA_S + 3600,
    iat: AHORA_S - 60,
    ...cambios.carga,
  };
  const cuerpo = `${parteJson(cabecera)}.${parteJson(carga)}`;
  const firma = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cambios.privada ?? par.privateKey,
    codificador.encode(cuerpo),
  );
  return `${cuerpo}.${aBase64Url(new Uint8Array(firma))}`;
}

const deps = () => ({ traerJwks: async () => jwks(), ahora: () => AHORA_MS });

const motivo = async (t: string | null, cfg = CFG) => {
  const r = await revisarToken(t, cfg, deps());
  return "rechazo" in r ? r.rechazo.motivo : null;
};

describe("un token bueno", () => {
  it("abre y devuelve el correo en minúsculas", async () => {
    const r = await revisarToken(
      await token({ carga: { email: "  DUENA@BabyCaleb.com  " } }),
      CFG,
      deps(),
    );
    expect("identidad" in r).toBe(true);
    if ("identidad" in r) {
      expect(r.identidad.correo).toBe("duena@babycaleb.com");
      expect(r.identidad.exp).toBe(AHORA_S + 3600);
    }
  });

  it("acepta la audiencia también cuando viene en lista", async () => {
    const r = await revisarToken(
      await token({ carga: { aud: ["otra".padEnd(64, "0"), AUD] } }),
      CFG,
      deps(),
    );
    expect("identidad" in r).toBe(true);
  });
});

describe("lo que se rechaza antes de mirar la firma", () => {
  it("sin token", async () => {
    expect(await motivo(null)).toBe("sin token");
    expect(await motivo("")).toBe("sin token");
  });

  it("con mala forma", async () => {
    expect(await motivo("solo-una-parte")).toBe("forma");
    expect(await motivo("a.b")).toBe("forma");
    expect(await motivo("a..c")).toBe("forma");
  });

  it("ilegible", async () => {
    expect(await motivo("$$$.$$$.$$$")).toBe("ilegible");
  });

  it("un algoritmo que no es RS256", async () => {
    // `none` y HS256 son la puerta de atrás clásica de los JWT: si el
    // verificador se cree el `alg` del propio token, cualquiera firma el suyo.
    for (const alg of ["none", "HS256", "RS512", "ES256"]) {
      expect(await motivo(await token({ cabecera: { alg } })), alg).toBe("algoritmo");
    }
  });

  it("sin kid", async () => {
    expect(await motivo(await token({ cabecera: { kid: undefined } }))).toBe("sin kid");
    expect(await motivo(await token({ cabecera: { kid: "" } }))).toBe("sin kid");
  });
});

describe("la firma", () => {
  it("rechaza un token firmado con otra llave", async () => {
    expect(await motivo(await token({ privada: otroPar.privateKey }))).toBe("firma");
  });

  it("rechaza un token al que le cambiaron la carga después de firmar", async () => {
    const bueno = await token();
    const [cab, , firma] = bueno.split(".");
    const otraCarga = parteJson({ iss: EQUIPO, aud: AUD, email: "otra@x.com", exp: AHORA_S + 3600 });
    expect(await motivo(`${cab}.${otraCarga}.${firma}`)).toBe("firma");
  });

  it("dice «llave desconocida» cuando el kid no está en el listado", async () => {
    expect(await motivo(await token({ cabecera: { kid: "llave-que-no-existe" } }))).toBe(
      "llave desconocida",
    );
  });

  it("dice «llaves no disponibles» si no se pudieron bajar", async () => {
    const r = await revisarToken(await token(), CFG, {
      traerJwks: async () => {
        throw new Error("sin red");
      },
      ahora: () => AHORA_MS,
    });
    expect("rechazo" in r && r.rechazo.motivo).toBe("llaves no disponibles");
  });
});

describe("lo que se revisa con la firma ya comprobada", () => {
  it("emisor distinto", async () => {
    const r = await revisarToken(
      await token({ carga: { iss: "https://otro.cloudflareaccess.com" } }),
      CFG,
      deps(),
    );
    expect("rechazo" in r && r.rechazo.motivo).toBe("emisor");
    // El emisor se puede mostrar porque tiene forma de equipo: es la pista de
    // «el PIN lo pidió otro equipo».
    expect("rechazo" in r && r.rechazo.emisor).toBe("https://otro.cloudflareaccess.com");
  });

  it("audiencia distinta, y dice los últimos 6 de cada una", async () => {
    const otra = "b".repeat(64);
    const r = await revisarToken(await token({ carga: { aud: otra } }), CFG, deps());
    expect("rechazo" in r && r.rechazo.motivo).toBe("audiencia");
    if ("rechazo" in r) {
      expect(r.rechazo.audRecibida).toBe("bbbbbb");
      expect(r.rechazo.audEsperada).toBe("aaaaaa");
    }
  });

  it("vencido", async () => {
    expect(await motivo(await token({ carga: { exp: AHORA_S - 3600 } }))).toBe("vencido");
    expect(await motivo(await token({ carga: { exp: "ayer" } }))).toBe("vencido");
    expect(await motivo(await token({ carga: { exp: undefined } }))).toBe("vencido");
  });

  it("perdona un desfase de reloj de medio minuto", async () => {
    // Vencido hace 10 segundos: el margen lo cubre.
    const r = await revisarToken(await token({ carga: { exp: AHORA_S - 10 } }), CFG, deps());
    expect("identidad" in r).toBe(true);
  });

  it("todavía no vale", async () => {
    expect(await motivo(await token({ carga: { nbf: AHORA_S + 600 } }))).toBe("todavia no vale");
  });

  it("emitido en el futuro", async () => {
    expect(await motivo(await token({ carga: { iat: AHORA_S + 600 } }))).toBe(
      "emitido en el futuro",
    );
  });

  it("sin correo o con un correo imposible", async () => {
    for (const email of [undefined, "", "sin-arroba", "a b@x.com", "con|barra@x.com", 42]) {
      expect(await motivo(await token({ carga: { email } })), String(email)).toBe("sin correo");
    }
  });
});

describe("el listado de llaves no castiga a Cloudflare", () => {
  it("una sola descarga para muchas peticiones seguidas", async () => {
    let descargas = 0;
    const d = {
      traerJwks: async () => {
        descargas += 1;
        return jwks();
      },
      ahora: () => AHORA_MS,
    };
    const t = await token();
    for (let i = 0; i < 5; i++) {
      const r = await revisarToken(t, CFG, d);
      expect("identidad" in r).toBe(true);
    }
    expect(descargas).toBe(1);
  });

  it("una ráfaga simultánea tampoco hace una descarga por petición", async () => {
    let descargas = 0;
    const d = {
      traerJwks: async () => {
        descargas += 1;
        return jwks();
      },
      ahora: () => AHORA_MS,
    };
    const t = await token();
    const resultados = await Promise.all([1, 2, 3, 4, 5].map(() => revisarToken(t, CFG, d)));
    for (const r of resultados) expect("identidad" in r).toBe(true);
    expect(descargas).toBe(1);
  });

  it("tras un fallo no insiste de inmediato", async () => {
    let intentos = 0;
    const d = {
      traerJwks: async () => {
        intentos += 1;
        throw new Error("sin red");
      },
      ahora: () => AHORA_MS,
    };
    const t = await token();
    await revisarToken(t, CFG, d);
    await revisarToken(t, CFG, d);
    await revisarToken(t, CFG, d);
    // Una ráfaga de peticiones con un token raro no se convierte en una ráfaga
    // de descargas contra Cloudflare.
    expect(intentos).toBe(1);
  });

  it("si la descarga falla después, sigue sirviendo la llave que ya tenía", async () => {
    let falla = false;
    const d = {
      traerJwks: async () => {
        if (falla) throw new Error("sin red");
        return jwks();
      },
      ahora: () => AHORA_MS,
    };
    const t = await token();
    expect("identidad" in (await revisarToken(t, CFG, d))).toBe(true);

    falla = true;
    // Una llave vieja que todavía sirve es mejor que dejar al equipo fuera
    // porque Cloudflare tardó un segundo.
    expect("identidad" in (await revisarToken(t, CFG, d))).toBe(true);
  });

  it("una llave rara en el listado no invalida las demás", async () => {
    const d = {
      traerJwks: async () => ({
        keys: [
          { kty: "oct", kid: "rara" },
          { kty: "RSA", kid: "incompleta" },
          { ...jwkPublica, kid: KID, alg: "RS256" },
        ],
      }),
      ahora: () => AHORA_MS,
    };
    expect("identidad" in (await revisarToken(await token(), CFG, d))).toBe(true);
  });
});

describe("configAccess", () => {
  it("acepta lo bien formado y lo normaliza", () => {
    expect(
      configAccess({
        ACCESS_EQUIPO: "  HTTPS://BabyCaleb.cloudflareaccess.com/  ",
        ACCESS_AUD: AUD.toUpperCase(),
      }),
    ).toEqual({ equipo: EQUIPO, aud: AUD });
  });

  it("devuelve null ante cualquier cosa rara", () => {
    for (const malo of [
      {},
      { ACCESS_EQUIPO: EQUIPO },
      { ACCESS_AUD: AUD },
      { ACCESS_EQUIPO: "http://babycaleb.cloudflareaccess.com", ACCESS_AUD: AUD },
      { ACCESS_EQUIPO: "https://evil.com", ACCESS_AUD: AUD },
      { ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: "corta" },
      { ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: "z".repeat(64) },
    ]) {
      expect(configAccess(malo), JSON.stringify(malo)).toBeNull();
    }
  });
});

describe("revisarPeticion", () => {
  it("sin configurar NO abre: el panel no tiene otra puerta detrás", async () => {
    // En D'Casa la puerta sin configurar se apagaba y el sitio seguía porque
    // Odoo tenía su propio login. Aquí eso dejaría el panel abierto.
    const r = await revisarPeticion(new Request("https://panel.babycaleb.com/"), {}, deps());
    expect("rechazo" in r && r.rechazo.motivo).toBe("sin configurar");
  });

  it("lee el token de la cabecera que pone Access", async () => {
    const r = await revisarPeticion(
      new Request("https://panel.babycaleb.com/", {
        headers: { [CABECERA_TOKEN]: await token() },
      }),
      { ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD },
      deps(),
    );
    expect("identidad" in r).toBe(true);
  });

  it("sin la cabecera, rechaza por falta de token", async () => {
    const r = await revisarPeticion(
      new Request("https://panel.babycaleb.com/"),
      { ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD },
      deps(),
    );
    expect("rechazo" in r && r.rechazo.motivo).toBe("sin token");
  });
});
