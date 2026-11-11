import { describe, expect, it, vi } from "vitest";
import { chat } from "./chat";
import type { Env, CanalWebBinding } from "./env";

/**
 * `/api/chat` cuando habla con el CRM (F3.6).
 *
 * Lo que se vigila: que el camino nuevo se encienda solo cuando el binding
 * está, que mande el ÚLTIMO mensaje de la clienta y no el historial entero, y
 * que un bot pausado no salga por pantalla como un error.
 */

const crm = (sobre: Partial<CanalWebBinding> = {}): CanalWebBinding => ({
  async mensajeWeb() {
    return { ok: true, trozos: ["Con gusto.", "¿Qué talla busca?"] };
  },
  ...sobre,
});

const env = (extra: Partial<Env> = {}): Env =>
  ({ GROQ_API_KEY: "no-se-usa", ...extra }) as unknown as Env;

const pedir = (cuerpo: unknown, e: Env) =>
  chat(
    new Request("https://babycaleb.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    }),
    e,
  );

const SESION = "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

describe("con el CRM conectado", () => {
  it("los trozos vuelven como un solo texto", async () => {
    const r = await pedir(
      { sesion: SESION, messages: [{ role: "user", content: "hola" }] },
      env({ CRM: crm() }),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { reply: string }).reply).toBe("Con gusto.\n\n¿Qué talla busca?");
  });

  it("se manda el ÚLTIMO mensaje de la clienta, no el historial", async () => {
    // El CRM lleva su propia memoria de la conversación, que es más fiel que
    // lo que el navegador tenga en pantalla. Mandar el historial sería pagar
    // tokens por contarle algo que ya sabe — y arriesgarse a que una pestaña
    // vieja le reescriba lo que pasó.
    const espia = vi.fn(async () => ({ ok: true as const, trozos: ["ok"] }));
    await pedir(
      {
        sesion: SESION,
        messages: [
          { role: "user", content: "hola" },
          { role: "assistant", content: "¿en qué le ayudo?" },
          { role: "user", content: "¿tienen talla M?" },
        ],
      },
      env({ CRM: crm({ mensajeWeb: espia }) }),
    );
    expect(espia).toHaveBeenCalledWith({ sesion: SESION, texto: "¿tienen talla M?" });
  });

  it("sin sesión no se atiende", async () => {
    const r = await pedir({ messages: [{ role: "user", content: "hola" }] }, env({ CRM: crm() }));
    expect(r.status).toBe(400);
  });

  it("sin un mensaje de la clienta tampoco", async () => {
    const r = await pedir(
      { sesion: SESION, messages: [{ role: "assistant", content: "hola" }] },
      env({ CRM: crm() }),
    );
    expect(r.status).toBe(400);
  });

  it("un bot pausado NO es un error en pantalla", async () => {
    // Si saliera 4xx, la interfaz enseñaría «algo salió mal» justo cuando todo
    // salió como debía: la dueña pausó el bot a propósito.
    const r = await pedir(
      { sesion: SESION, messages: [{ role: "user", content: "hola" }] },
      env({
        CRM: crm({
          async mensajeWeb() {
            return {
              ok: false,
              codigo: "sin_respuesta",
              mensaje: "en este momento le responde una persona del equipo",
            };
          },
        }),
      }),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { reply: string }).reply).toContain("una persona");
  });

  it("una entrada que el CRM rechaza sí es un 400", async () => {
    const r = await pedir(
      { sesion: SESION, messages: [{ role: "user", content: "hola" }] },
      env({
        CRM: crm({
          async mensajeWeb() {
            return { ok: false, codigo: "entrada_invalida", mensaje: "sesión inválida" };
          },
        }),
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe("sin el CRM, el camino de siempre", () => {
  it("sigue pidiendo el historial y la clave de Groq", async () => {
    // Mientras el binding no esté, el chat tiene que seguir funcionando como
    // hoy. Apagar Groq antes de que el CRM esté desplegado dejaría el chat
    // mudo en producción.
    const r = await pedir({ messages: "no es un array" }, env());
    expect(r.status).toBe(400);

    const sinClave = await pedir(
      { messages: [{ role: "user", content: "hola" }] },
      { ...env(), GROQ_API_KEY: undefined } as unknown as Env,
    );
    expect(sinClave.status).toBe(500);
  });
});

describe("lo que no cambia", () => {
  it("sigue siendo POST", async () => {
    const r = await chat(
      new Request("https://babycaleb.com/api/chat"),
      env({ CRM: crm() }),
    );
    expect(r.status).toBe(405);
  });
});
