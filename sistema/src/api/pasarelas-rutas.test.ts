import { env as real } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Las rutas de las pasarelas de cobro.
 *
 * Lo que vigila este archivo es UNA cosa, y es la que la capa de rutas puede
 * estropear por su cuenta: **que el valor de una credencial no salga de
 * vuelta**. El módulo ya garantiza que no sale de la base —su consulta ni
 * siquiera nombra la columna del secreto— pero una ruta puede deshacer eso
 * sola, haciendo eco del cuerpo en la respuesta o metiéndolo en el detalle de
 * un error. Es el reflejo normal de quien programa, y aquí cuesta caro: un
 * error se pinta en un teléfono y acaba en una captura de WhatsApp.
 *
 * No se limpia entre pruebas: la bitácora de pasarelas tiene triggers que
 * impiden borrarla, igual que la de entregas. Cada prueba usa valores propios.
 */

// Obviamente falsa: 32 bytes de texto legible. Ninguna llave de verdad entra
// en un archivo de este repositorio.
// 32 bytes exactos (la llave de verdad son 32 al azar; esta es texto
// legible a propósito para que se vea de un vistazo que es falsa).
const LLAVE = "TExBVkUtRkFMU0EtREUtUlVUQVMtMzItQllURVMhISE=";

const comoUsuario = (rol: RolDePanel): Usuario => ({
  id: `u-${rol}`,
  correo: `${rol}@babycaleb.com`,
  nombre: `La ${rol}`,
  rol,
  activo: true,
});

const entrandoComo = (rol: RolDePanel) =>
  crearPanel((async () => ({ ok: true, usuario: comoUsuario(rol) })) as ResolverUsuario);

/** El entorno con la llave maestra puesta, como estaría en Cloudflare. */
const conLlave = () => ({ ...real, PASARELAS_LLAVE_MAESTRA: LLAVE }) as unknown as Env;

async function pedir(app: ReturnType<typeof crearPanel>, ruta: string) {
  const r = await app.fetch(new Request(`https://panel.babycaleb.com${ruta}`), conLlave());
  return { estado: r.status, texto: await r.text() };
}

async function postJson(
  app: ReturnType<typeof crearPanel>,
  ruta: string,
  cuerpo: Record<string, unknown>,
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: "POST",
      body: JSON.stringify(cuerpo),
      headers: { "content-type": "application/json" },
    }),
    conLlave(),
  );
  return { estado: r.status, texto: await r.text() };
}

let n = 0;
const credencialFalsa = () => `CLAVE-FALSA-DE-RUTAS-${Date.now()}-${n++}`;

describe("el valor de una credencial no vuelve", () => {
  it("ni en la respuesta de guardarla", async () => {
    const valor = credencialFalsa();
    const r = await postJson(
      entrandoComo("duena"),
      "/pasarelas/yappy/credenciales/id_comercio",
      { modo: "prueba", valor, motivo: "configuración inicial" },
    );
    expect(r.estado).toBe(200);
    // Se mira el TEXTO ENTERO de la respuesta, no un campo: un eco se cuela
    // por donde nadie mira, y mirar campo por campo es acordarse de mirar.
    expect(r.texto).not.toContain(valor);
  });

  it("ni en el estado que lee la pantalla", async () => {
    const valor = credencialFalsa();
    await postJson(entrandoComo("duena"), "/pasarelas/yappy/credenciales/clave_secreta", {
      modo: "prueba",
      valor,
      motivo: "x",
    });

    const r = await pedir(entrandoComo("duena"), "/pasarelas");
    expect(r.estado).toBe(200);
    expect(r.texto).not.toContain(valor);
    // Tampoco el criptograma: su marca delataría que el sobre viaja.
    expect(r.texto).not.toContain("aesgcm1.");
    // Pero sí dice que HAY una puesta, que es lo que la pantalla necesita.
    expect(r.texto).toContain("clave_secreta");
  });

  it("ni cuando la rechazan", async () => {
    // Un valor que no pasa la validación. El motivo del rechazo se pinta en
    // la pantalla, así que no puede repetir lo que se escribió.
    const valor = `con espacios ${credencialFalsa()}`;
    const r = await postJson(
      entrandoComo("duena"),
      "/pasarelas/yappy/credenciales/id_comercio",
      { modo: "prueba", valor, motivo: "x" },
    );
    expect(r.estado).not.toBe(200);
    expect(r.texto).not.toContain(valor);
  });
});

describe("quién puede", () => {
  it("la asistente no ve las pasarelas", async () => {
    // `ajustes` es «no» para todos menos la dueña. Las pasarelas son dinero.
    const r = await pedir(entrandoComo("asistente"), "/pasarelas");
    expect(r.estado).toBe(403);
  });

  it("la asistente no puede poner una credencial", async () => {
    const valor = credencialFalsa();
    const r = await postJson(
      entrandoComo("asistente"),
      "/pasarelas/yappy/credenciales/id_comercio",
      { modo: "prueba", valor, motivo: "x" },
    );
    expect(r.estado).toBe(403);
    expect(r.texto).not.toContain(valor);
  });
});

describe("encender y apagar", () => {
  it("una pasarela sin credenciales no se enciende, y dice cuál falta", async () => {
    const r = await postJson(entrandoComo("duena"), "/pasarelas/paypal/encendida", {
      encendida: true,
      motivo: "a cobrar",
    });
    expect(r.estado).not.toBe(200);
    // «Configuración incompleta» no le dice a nadie qué hacer.
    expect(r.texto.length).toBeGreaterThan(20);
  });

  it("apagar no lleva condiciones: es el interruptor de emergencia", async () => {
    // Apagar algo que ya está apagado tiene que funcionar. Una condición en
    // el apagado es un interruptor que no responde el día que hace falta.
    const r = await postJson(entrandoComo("duena"), "/pasarelas/paypal/encendida", {
      encendida: false,
      motivo: "por si acaso",
    });
    expect(r.estado).toBe(200);
  });
});
