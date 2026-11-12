import { env as real } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { guionFijo } from "../asistente/proveedor";
import type { RolDePanel, Usuario } from "../seguridad";
import type { HacerProveedor } from "./asistente-rutas";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * La puerta de Caleb.
 *
 * El cerebro es de guion fijo: lo que se prueba es la puerta —quién entra, qué
 * se le devuelve, qué pasa sin llave y quién puede confirmar una acción—, no
 * si el modelo acierta. Un proveedor de verdad haría que estas pruebas
 * dependieran de que Meta esté arriba, costaran dinero y dieran un resultado
 * distinto cada vez.
 */

const USUARIO_ID = "u-caleb-ruta";

const comoUsuario = (rol: RolDePanel): Usuario => ({
  id: USUARIO_ID,
  correo: "caleb-ruta@babycaleb.com",
  nombre: "Yarielis",
  rol,
  activo: true,
});

const entrandoComo = (rol: RolDePanel, hacerProveedor?: HacerProveedor) =>
  crearPanel(
    (async () => ({ ok: true, usuario: comoUsuario(rol) })) as ResolverUsuario,
    hacerProveedor,
  );

const hablando = (texto: string): HacerProveedor => () => guionFijo([{ texto }]);
const sinLlave: HacerProveedor = () => null;

const preguntar = async (
  app: ReturnType<typeof crearPanel>,
  cuerpo: unknown,
  ruta = "/asistente",
) => {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  await real.DB.prepare(
    "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, 'Yarielis', 'duena', 1, ?)",
  )
    .bind(USUARIO_ID, "caleb-ruta@babycaleb.com", Date.now())
    .run();
});

describe("POST /asistente", () => {
  it("contesta", async () => {
    const r = await preguntar(entrandoComo("duena", hablando("Quedan 12 cajas.")), {
      mensajes: [{ rol: "user", contenido: "¿cuánto queda?" }],
    });

    expect(r.estado).toBe(200);
    const datos = r.cuerpo["datos"] as Record<string, unknown>;
    expect(datos["clase"]).toBe("dijo");
    expect(datos["texto"]).toBe("Quedan 12 cajas.");
    // El historial vuelve para el siguiente turno, como el chat de la web.
    expect(Array.isArray(datos["historial"])).toBe(true);
  });

  it("sin llave lo dice en español, no con un 500", async () => {
    // Quien abre el panel no sabe lo que es un secreto de Cloudflare, y un
    // error técnico aquí no le dice a nadie qué hacer.
    const r = await preguntar(entrandoComo("duena", sinLlave), {
      mensajes: [{ rol: "user", contenido: "hola" }],
    });

    expect(r.estado).toBe(503);
    expect(String(r.cuerpo["mensaje"])).toContain("META_API_KEY");
  });

  it("rechaza un cuerpo con mala forma", async () => {
    const r = await preguntar(entrandoComo("duena", hablando("x")), { mensajes: [] });
    expect(r.estado).toBe(400);
  });

  it("corta un mensaje enorme antes de llamar al modelo", async () => {
    // El tope está en el esquema a propósito: si se comprobara después, la
    // llamada ya se habría pagado.
    const r = await preguntar(entrandoComo("duena", hablando("x")), {
      mensajes: [{ rol: "user", contenido: "a".repeat(9_000) }],
    });
    expect(r.estado).toBe(400);
  });

  it("anota lo que se gastó", async () => {
    const antes = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM asistente_uso WHERE usuario_id = ?",
    )
      .bind(USUARIO_ID)
      .first<{ n: number }>();

    await preguntar(entrandoComo("duena", hablando("Listo.")), {
      mensajes: [{ rol: "user", contenido: "hola" }],
    });

    const despues = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM asistente_uso WHERE usuario_id = ?",
    )
      .bind(USUARIO_ID)
      .first<{ n: number }>();

    expect((despues?.n ?? 0) - (antes?.n ?? 0)).toBe(1);
  });

  it("la asistente también puede preguntar", async () => {
    // La puerta NO lleva permiso: el rol lo decide cada herramienta. Si la
    // puerta exigiera un permiso, la asistente no podría ni preguntar cuánto
    // queda de una talla, que es justo para lo que sirve.
    const r = await preguntar(entrandoComo("asistente", hablando("Quedan 3.")), {
      mensajes: [{ rol: "user", contenido: "¿cuánto queda?" }],
    });
    expect(r.estado).toBe(200);
  });
});

describe("POST /asistente/acciones/:id", () => {
  it("una acción que no existe da 404", async () => {
    const r = await preguntar(
      entrandoComo("duena", hablando("x")),
      { decision: "permitir" },
      "/asistente/acciones/no-existe",
    );
    expect(r.estado).toBe(404);
  });

  it("hay que decir si se permite o se rechaza", async () => {
    const r = await preguntar(
      entrandoComo("duena", hablando("x")),
      { decision: "quizas" },
      "/asistente/acciones/da-igual",
    );
    expect(r.estado).toBe(400);
  });
});
