import { describe, expect, it, vi } from "vitest";
import {
  MAX_TOKENS_MINIMO,
  type Peticion,
  type Proveedor,
  conRespaldo,
  guionFijo,
  leerRespuesta,
  meta,
  pareceTokenDeGraph,
} from "./proveedor";

const peticion: Peticion = {
  sistema: "Eres el asistente de Baby Caleb.",
  mensajes: [{ rol: "user", contenido: "¿cuánto hay de BC-001-03?" }],
  herramientas: [
    { name: "ver_stock", description: "Cuánto hay.", input_schema: { type: "object" } },
  ],
};

/** Una respuesta con la forma que se espera del proveedor. */
const respuestaCruda = {
  model: "muse-spark-1.2-contributor",
  content: [
    { type: "text", text: "Quedan 12." },
    { type: "tool_use", id: "t1", name: "ver_stock", input: { codigo: "BC-001-03" } },
  ],
  usage: { input_tokens: 8000, output_tokens: 600 },
};

describe("el proveedor de guion fijo", () => {
  it("contesta lo que dice el guion, sin tocar la red", async () => {
    const p = guionFijo([{ texto: "hola" }, { texto: "adiós" }]);
    expect((await p.responder(peticion)).texto).toBe("hola");
    expect((await p.responder(peticion)).texto).toBe("adiós");
  });

  it("guarda lo que se le pidió", async () => {
    // Así se comprueba que al modelo no le llegó lo que no debía llegarle.
    const p = guionFijo([{ texto: "ok" }]);
    await p.responder(peticion);
    expect(p.pedido[0]?.sistema).toContain("Baby Caleb");
  });

  it("se queja claro si el bucle pide más de lo que hay", async () => {
    // Sin esto, un bucle sin salida se vería como un `undefined` raro media
    // hora después, en otra parte.
    const p = guionFijo([{ texto: "uno" }]);
    await p.responder(peticion);
    await expect(p.responder(peticion)).rejects.toThrow(/al bucle le falta una salida/);
  });
});

describe("la llave que se le manda a Meta", () => {
  it("un token de Graph no sale de aquí", async () => {
    // Los tokens de Messenger/Instagram/WhatsApp empiezan por EAA: dan acceso a
    // las páginas y a los mensajes de las clientas, y una API de modelos no los
    // necesita. El plan dice que el CRM tiene una prueba que lo vigila; no la
    // tiene, así que la guarda vive en el código.
    expect(pareceTokenDeGraph("EAAJZCabc123")).toBe(true);
    expect(() => meta({ clave: "EAAJZCabc123", modelo: "muse-spark-1.2-contributor" })).toThrow(
      /token de Graph/,
    );
  });

  it("una llave vacía tampoco", () => {
    expect(() => meta({ clave: "   ", modelo: "m" })).toThrow(/falta la llave/);
  });

  it("una llave del Model API sí", () => {
    expect(pareceTokenDeGraph("msk_live_abc")).toBe(false);
    expect(() => meta({ clave: "msk_live_abc", modelo: "m" })).not.toThrow();
  });
});

describe("cómo se arma la llamada", () => {
  async function llamarYMirar(p: Partial<Peticion> = {}): Promise<Record<string, unknown>> {
    let cuerpo: Record<string, unknown> = {};
    const falso = vi.fn(async (_u: string, init?: RequestInit) => {
      cuerpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(respuestaCruda), { status: 200 });
    });
    const prov = meta({
      clave: "msk_live_abc",
      modelo: "muse-spark-1.2-contributor",
      fetch: falso as unknown as typeof fetch,
    });
    await prov.responder({ ...peticion, ...p });
    return cuerpo;
  }

  it("nunca manda max_tokens por debajo de 16: Meta lo rechaza", async () => {
    expect((await llamarYMirar({ maxTokens: 1 }))["max_tokens"]).toBe(MAX_TOKENS_MINIMO);
  });

  it("no manda eager_input_streaming ni cache_control", async () => {
    // Lo primero hace fallar cada mensaje; lo segundo no se sabe que Meta lo
    // acepte, y por eso el costo se calcula sin caché.
    const texto = JSON.stringify(await llamarYMirar());
    expect(texto).not.toContain("eager_input_streaming");
    expect(texto).not.toContain("cache_control");
  });

  it("deja elegir al modelo si usa una herramienta", async () => {
    expect((await llamarYMirar())["tool_choice"]).toEqual({ type: "auto" });
  });

  it("manda las herramientas tal como las dio el registro", async () => {
    const t = (await llamarYMirar())["tools"] as { name: string }[];
    expect(t.map((x) => x.name)).toEqual(["ver_stock"]);
  });
});

describe("leer lo que contesta", () => {
  it("separa el texto de las llamadas a herramientas", () => {
    const r = leerRespuesta(respuestaCruda, "m");
    expect(r.texto).toBe("Quedan 12.");
    expect(r.llamadas).toEqual([
      { id: "t1", nombre: "ver_stock", argumentos: { codigo: "BC-001-03" } },
    ]);
    expect(r.uso.entrada).toBe(8000);
  });

  it("una respuesta con otra forma no tumba al asistente", () => {
    // La ruta y el formato exactos del Model API de Meta no están
    // verificados (ver la nota de proveedor.ts). Si el día de mañana la forma
    // es otra, la dueña tiene que ver una respuesta vacía, no una pantalla
    // rota.
    const r = leerRespuesta({ choices: [{ message: { content: "hola" } }] }, "m");
    expect(r.texto).toBe("");
    expect(r.llamadas).toEqual([]);
    expect(r.modelo).toBe("m");
  });

  it("y tampoco una respuesta vacía o nula", () => {
    expect(leerRespuesta(null, "m").texto).toBe("");
    expect(leerRespuesta({ content: "no es una lista" }, "m").llamadas).toEqual([]);
  });

  it("un uso negativo o absurdo se cuenta como cero, no como crédito", () => {
    const r = leerRespuesta({ usage: { input_tokens: -5, output_tokens: "muchos" } }, "m");
    expect(r.uso.entrada).toBe(0);
    expect(r.uso.salida).toBe(0);
  });
});

describe("el respaldo", () => {
  const cae = (): Proveedor => ({
    nombre: "cae",
    modelo: "principal",
    responder: async () => {
      throw new Error("502");
    },
  });

  it("un fallo suelto NO cambia de modelo", async () => {
    // El respaldo cuesta diez veces más: un corte de un segundo no debería
    // cambiarlo (06-asistente §6).
    const r = conRespaldo(cae(), guionFijo([{ texto: "respaldo" }], "respaldo"));
    await expect(r.responder(peticion)).rejects.toThrow("502");
  });

  it("dos seguidos sí", async () => {
    const avisos: string[] = [];
    const r = conRespaldo(cae(), guionFijo([{ texto: "respaldo" }], "respaldo"), (a) => avisos.push(a));
    await expect(r.responder(peticion)).rejects.toThrow();
    expect((await r.responder(peticion)).texto).toBe("respaldo");
    expect(avisos[0]).toContain("respaldo");
  });

  it("un acierto reinicia la cuenta", async () => {
    // Lo que importa es que esté caído, no que alguna vez fallara.
    let falla = true;
    const intermitente: Proveedor = {
      nombre: "intermitente",
      modelo: "principal",
      responder: async () => {
        if (falla) throw new Error("502");
        return { texto: "ok", llamadas: [], uso: { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 }, modelo: "principal" };
      },
    };
    const r = conRespaldo(intermitente, guionFijo([{ texto: "respaldo" }], "respaldo"));

    await expect(r.responder(peticion)).rejects.toThrow();
    falla = false;
    expect((await r.responder(peticion)).texto).toBe("ok");
    falla = true;
    // Vuelve a fallar: como la cuenta se reinició, este es el PRIMERO otra vez.
    await expect(r.responder(peticion)).rejects.toThrow();
  });

  it("sin respaldo, el fallo se cuenta tal cual", async () => {
    // El asistente dice que no puede contestar ahora; no se inventa nada.
    const r = conRespaldo(cae(), null);
    await expect(r.responder(peticion)).rejects.toThrow("502");
    await expect(r.responder(peticion)).rejects.toThrow("502");
  });
});
