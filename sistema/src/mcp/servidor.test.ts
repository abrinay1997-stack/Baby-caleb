import { env as real } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { crearLlave, revocarLlave } from "./llaves";
import { mcp } from "./servidor";

/**
 * El servidor MCP.
 *
 * Lo que se prueba es la PUERTA y el PROTOCOLO: quién entra, qué forma tienen
 * los mensajes, y —lo más importante— que una acción sensible no se ejecute
 * por aquí sin que una persona la permita. Las herramientas en sí ya tienen
 * sus pruebas.
 */

const DUENA = "u-mcp-duena";
const ASIS = "u-mcp-asis";
const BAJA = "u-mcp-baja";

let llaveDuena = "";
let llaveAsistente = "";
let llaveDeBaja = "";
let llaveRevocada = "";

const pedir = async (cuerpo: unknown, token: string | null, metodo = "POST") => {
  const cabeceras: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) cabeceras["authorization"] = `Bearer ${token}`;
  const r = await mcp(
    new Request("https://ruta.babycaleb.com/mcp", {
      method: metodo,
      headers: cabeceras,
      ...(metodo === "POST" ? { body: JSON.stringify(cuerpo) } : {}),
    }),
    real as Env,
  );
  const texto = await r.text();
  return { estado: r.status, cabeceras: r.headers, cuerpo: texto === "" ? null : JSON.parse(texto) };
};

const rpc = (method: string, params?: unknown, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

beforeAll(async () => {
  const t = Date.now();
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, 'Dueña MCP', 'duena', 1, ?)",
    ).bind(DUENA, "mcp-duena@babycaleb.com", t),
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, 'Asistente MCP', 'asistente', 1, ?)",
    ).bind(ASIS, "mcp-asis@babycaleb.com", t),
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, 'De baja MCP', 'duena', 0, ?)",
    ).bind(BAJA, "mcp-baja@babycaleb.com", t),
  ]);

  const a = await crearLlave(real.DB, DUENA, "pruebas", t);
  const b = await crearLlave(real.DB, ASIS, "pruebas", t);
  const c = await crearLlave(real.DB, BAJA, "pruebas", t);
  const d = await crearLlave(real.DB, DUENA, "para revocar", t);
  if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error("no se pudieron crear las llaves");
  llaveDuena = a.datos.token;
  llaveAsistente = b.datos.token;
  llaveDeBaja = c.datos.token;
  llaveRevocada = d.datos.token;
  await revocarLlave(real.DB, DUENA, d.datos.id, t);
});

describe("la puerta", () => {
  it("sin llave no se entra, y se dice que hace falta una", async () => {
    const r = await pedir(rpc("initialize"), null);
    expect(r.estado).toBe(401);
    // Sin esta cabecera, un cliente de MCP se queda adivinando por qué le
    // cierran la puerta.
    expect(r.cabeceras.get("www-authenticate")).toContain("Bearer");
  });

  it("una llave inventada no entra", async () => {
    const r = await pedir(rpc("initialize"), "bcmcp_estonoesunallave");
    expect(r.estado).toBe(401);
  });

  it("una llave REVOCADA no entra", async () => {
    const r = await pedir(rpc("initialize"), llaveRevocada);
    expect(r.estado).toBe(401);
  });

  it("la llave de alguien dado de baja tampoco", async () => {
    // Dar de baja a una persona tiene que cerrarle TODAS las puertas, no solo
    // el panel. Si esto se comprobara aparte, se olvidaría.
    const r = await pedir(rpc("initialize"), llaveDeBaja);
    expect(r.estado).toBe(401);
  });
});

describe("el protocolo", () => {
  it("initialize devuelve la versión que el cliente sabe hablar", async () => {
    const r = await pedir(rpc("initialize", { protocolVersion: "2025-06-18" }), llaveDuena);
    expect(r.estado).toBe(200);
    expect(r.cuerpo.result.protocolVersion).toBe("2025-06-18");
    expect(r.cuerpo.result.capabilities.tools).toBeDefined();
    expect(r.cuerpo.result.serverInfo.name).toBe("babycaleb-sistema");
  });

  it("si el cliente pide una versión que no sabemos, se ofrece la nuestra", async () => {
    const r = await pedir(rpc("initialize", { protocolVersion: "1999-01-01" }), llaveDuena);
    expect(r.cuerpo.result.protocolVersion).toBe("2025-11-25");
  });

  it("una notificación no se contesta", async () => {
    // Contestar una notificación rompe a los clientes estrictos: no llevan
    // `id` y no esperan respuesta.
    const r = await pedir(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      llaveDuena,
    );
    expect(r.estado).toBe(202);
    expect(r.cuerpo).toBeNull();
  });

  it("un método desconocido da -32601", async () => {
    const r = await pedir(rpc("cosas/raras"), llaveDuena);
    expect(r.cuerpo.error.code).toBe(-32601);
  });

  it("algo que no es JSON-RPC 2.0 da -32600", async () => {
    const r = await pedir({ id: 1, method: "initialize" }, llaveDuena);
    expect(r.cuerpo.error.code).toBe(-32600);
  });

  it("un GET no se atiende: este servidor no transmite por SSE", async () => {
    const r = await pedir(null, llaveDuena, "GET");
    expect(r.estado).toBe(405);
  });
});

describe("las herramientas", () => {
  it("tools/list enseña las del rol, con inputSchema", async () => {
    const r = await pedir(rpc("tools/list"), llaveDuena);
    expect(r.estado).toBe(200);
    const nombres = r.cuerpo.result.tools.map((t: { name: string }) => t.name);
    expect(nombres).toContain("ver_stock");
    // La forma que pide el protocolo: `inputSchema`, no `input_schema`.
    for (const t of r.cuerpo.result.tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("a la asistente NO se le enseña lo que no puede usar", async () => {
    // Una herramienta que no se enseña es una que no se puede pedir por
    // equivocación. La política la pararía igual, pero enseñarla y luego
    // negarla es enseñarle a insistir.
    const r = await pedir(rpc("tools/list"), llaveAsistente);
    const nombres = r.cuerpo.result.tools.map((t: { name: string }) => t.name);
    expect(nombres).toContain("ver_stock");
    expect(nombres).not.toContain("cambiar_precio");
  });

  it("una herramienta de lectura contesta", async () => {
    const r = await pedir(
      rpc("tools/call", { name: "ver_stock", arguments: {} }),
      llaveDuena,
    );
    expect(r.estado).toBe(200);
    expect(r.cuerpo.result.isError).toBe(false);
    expect(r.cuerpo.result.content[0].type).toBe("text");
  });

  it("UNA ACCIÓN SENSIBLE NO SE HACE, y se dice que no se hizo", async () => {
    // Es la garantía entera. Devolverlo como éxito haría que un agente
    // siguiera adelante creyendo que el precio ya cambió.
    const r = await pedir(
      rpc("tools/call", {
        name: "cambiar_precio",
        arguments: { codigo: "NAT-M", precio_cents: 5500, motivo: "prueba del servidor MCP" },
      }),
      llaveDuena,
    );
    expect(r.estado).toBe(200);
    expect(r.cuerpo.result.isError).toBe(true);
    expect(r.cuerpo.result.content[0].text).toContain("No se hizo");
    expect(r.cuerpo.result.content[0].text).toContain("permita");
  });

  it("lo que el rol no puede vuelve como error DE LA HERRAMIENTA, no del protocolo", async () => {
    // Así el modelo del otro lado lo lee y se corrige, en vez de ver un error
    // de transporte que no entiende.
    const r = await pedir(
      rpc("tools/call", {
        name: "cambiar_precio",
        arguments: { codigo: "NAT-M", precio_cents: 5500, motivo: "prueba" },
      }),
      llaveAsistente,
    );
    expect(r.cuerpo.error).toBeUndefined();
    expect(r.cuerpo.result.isError).toBe(true);
  });

  it("pedir una herramienta que no existe sí es error de protocolo", async () => {
    const r = await pedir(rpc("tools/call", { name: "no_existe", arguments: {} }), llaveDuena);
    expect(r.cuerpo.error.code).toBe(-32601);
  });
});
