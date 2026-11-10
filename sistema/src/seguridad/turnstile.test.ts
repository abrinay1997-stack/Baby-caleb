import { describe, expect, it } from "vitest";
import { mensajeDeTurnstile, revisarTurnstile } from "./turnstile";

const ENV = { TURNSTILE_SECRETO: "secreto-de-prueba" };
const ok = () => ({ verificar: async () => ({ success: true }) });
const falla = (codigos: string[] = []) => ({
  verificar: async () => ({ success: false, "error-codes": codigos }),
});

describe("revisarTurnstile", () => {
  it("acepta un token que Cloudflare confirma", async () => {
    expect(await revisarTurnstile("token-bueno", ENV, null, ok())).toEqual({ ok: true });
  });

  it("manda el secreto, el token y la IP si se tiene", async () => {
    let visto: FormData | null = null;
    await revisarTurnstile("token-bueno", ENV, "203.0.113.9", {
      verificar: async (cuerpo) => {
        visto = cuerpo;
        return { success: true };
      },
    });
    expect(visto!.get("secret")).toBe("secreto-de-prueba");
    expect(visto!.get("response")).toBe("token-bueno");
    expect(visto!.get("remoteip")).toBe("203.0.113.9");
  });

  it("sin IP no manda el campo vacío", async () => {
    let visto: FormData | null = null;
    await revisarTurnstile("t", ENV, null, {
      verificar: async (cuerpo) => {
        visto = cuerpo;
        return { success: true };
      },
    });
    expect(visto!.has("remoteip")).toBe(false);
  });

  it("sin secreto configurado RECHAZA, no deja pasar", async () => {
    // Un checkout abierto a los robots cuesta más que un checkout cerrado un
    // rato, y para eso existe el interruptor `checkout_activo`.
    for (const env of [{}, { TURNSTILE_SECRETO: "" }, { TURNSTILE_SECRETO: "   " }]) {
      const r = await revisarTurnstile("token", env, null, ok());
      expect(r).toEqual({ ok: false, motivo: "sin configurar" });
    }
  });

  it("sin token no sale a verificar nada", async () => {
    let llamadas = 0;
    const deps = {
      verificar: async () => {
        llamadas += 1;
        return { success: true };
      },
    };
    for (const token of [null, undefined, "", "   "]) {
      expect(await revisarTurnstile(token, ENV, null, deps)).toEqual({
        ok: false,
        motivo: "sin token",
      });
    }
    expect(llamadas).toBe(0);
  });

  it("un token absurdamente largo no se manda a verificar", async () => {
    let llamadas = 0;
    const r = await revisarTurnstile("x".repeat(5_000), ENV, null, {
      verificar: async () => {
        llamadas += 1;
        return { success: true };
      },
    });
    expect(r).toEqual({ ok: false, motivo: "sin token" });
    expect(llamadas).toBe(0);
  });

  it("un token que Cloudflare rechaza es inválido", async () => {
    const r = await revisarTurnstile("malo", ENV, null, falla(["invalid-input-response"]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toBe("token invalido");
      expect(r.codigos).toEqual(["invalid-input-response"]);
    }
  });

  it("un token repetido tiene su propio motivo", async () => {
    // Casi siempre es un doble clic, no un ataque, y lo que hay que decirle a
    // la clienta es distinto.
    const r = await revisarTurnstile("usado", ENV, null, falla(["timeout-or-duplicate"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("token repetido");
  });

  it("si no se pudo preguntar, no se da por bueno", async () => {
    const r = await revisarTurnstile("token", ENV, null, {
      verificar: async () => {
        throw new Error("sin red");
      },
    });
    expect(r).toEqual({ ok: false, motivo: "no se pudo verificar" });
  });

  it("una respuesta rara tampoco se da por buena", async () => {
    for (const respuesta of [null, undefined, {}, { success: "true" }, { success: 1 }, "si"]) {
      const r = await revisarTurnstile("token", ENV, null, { verificar: async () => respuesta });
      expect(r.ok, JSON.stringify(respuesta)).toBe(false);
    }
  });
});

describe("mensajeDeTurnstile", () => {
  it("explica el doble clic distinto del resto", async () => {
    const repetido = mensajeDeTurnstile({ ok: false, motivo: "token repetido" });
    expect(repetido).toContain("dos veces");
  });

  it("no le echa la culpa a la clienta cuando el problema es nuestro", () => {
    for (const motivo of ["sin configurar", "no se pudo verificar"] as const) {
      const texto = mensajeDeTurnstile({ ok: false, motivo });
      expect(texto).toContain("Tuvimos un problema");
      expect(texto).toContain("WhatsApp");
    }
  });

  it("habla de usted y no menciona Turnstile ni códigos técnicos", () => {
    for (const motivo of [
      "sin configurar",
      "sin token",
      "token invalido",
      "token repetido",
      "no se pudo verificar",
    ] as const) {
      const texto = mensajeDeTurnstile({ ok: false, motivo });
      expect(texto).not.toMatch(/turnstile|token|error-code/i);
      expect(texto).not.toMatch(/\b(tu|tus|tienes|puedes|recarga)\b/i);
    }
  });

  it("de un resultado bueno no hay nada que decir", () => {
    expect(mensajeDeTurnstile({ ok: true })).toBe("");
  });
});
