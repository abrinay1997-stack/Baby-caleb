import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Quién entra al panel, desde el panel.
 *
 * La lista estaba y era de solo lectura: dar de alta a alguien o quitarle el
 * acceso había que hacerlo por SQL. En un sistema cuya puerta se cruza con
 * esta tabla en cada petición, eso significa que la dueña no podía ni dejar
 * entrar a su asistente ni sacar a nadie el día que hiciera falta.
 *
 * Lo que más se vigila aquí son dos cosas:
 *
 *  - **El correo no distingue mayúsculas.** Es la llave de entrada, y dos
 *    filas que solo se diferencien en la caja son la misma persona con el
 *    acceso partido en dos.
 *  - **Tiene que quedar una dueña activa.** Sin ella nadie tiene el permiso de
 *    `ajustes`, o sea que nadie puede volver a dar de alta a nadie — ni a sí
 *    mismo. Eso no se arregla desde el panel: se arregla por SQL.
 */

const comoRol = (rol: RolDePanel): Usuario => ({
  id: `u-${rol}`,
  correo: `${rol}@babycaleb.com`,
  nombre: `La ${rol}`,
  rol,
  activo: true,
});
const entrandoComo = (rol: RolDePanel) =>
  crearPanel((async () => ({ ok: true, usuario: comoRol(rol) })) as ResolverUsuario);

type Respuesta = { estado: number; cuerpo: Record<string, unknown> };

async function llamar(
  app: ReturnType<typeof crearPanel>,
  metodo: string,
  ruta: string,
  cuerpo?: Record<string, unknown>,
): Promise<Respuesta> {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: metodo,
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
      headers: { "content-type": "application/json" },
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

const post = (app: ReturnType<typeof crearPanel>, ruta: string, c: Record<string, unknown>) =>
  llamar(app, "POST", ruta, c);
const patch = (app: ReturnType<typeof crearPanel>, ruta: string, c: Record<string, unknown>) =>
  llamar(app, "PATCH", ruta, c);

const duena = entrandoComo("duena");

/** Correos propios: `usuarios.correo` tiene un índice único sin mayúsculas. */
let n = 0;
const correoNuevo = () => `prueba.rutas.${Date.now()}.${n++}@babycaleb.com`;

/**
 * La dueña de arranque de estas pruebas.
 *
 * Existe para que quitarle el acceso a otra dueña NO sea quitarle el acceso a
 * la última: sin ella, cada prueba de baja chocaría con la regla y no se
 * podría comprobar el caso normal.
 */
const DUENA_FIJA = "u-duena-fija-rutas";

const usuarioEn = async (id: string) =>
  await real.DB.prepare("SELECT correo, nombre, rol, activo FROM usuarios WHERE id = ?")
    .bind(id)
    .first<{ correo: string; nombre: string; rol: string; activo: number }>();

const duenasActivas = async (): Promise<number> => {
  const f = await real.DB.prepare(
    "SELECT COUNT(*) AS cuantas FROM usuarios WHERE rol = 'duena' AND activo = 1",
  ).first<{ cuantas: number }>();
  return f?.cuantas ?? 0;
};

async function darDeAlta(datos: Record<string, unknown> = {}): Promise<string> {
  const r = await post(duena, "/usuarios", {
    correo: correoNuevo(),
    nombre: "Persona de prueba",
    rol: "asistente",
    ...datos,
  });
  if (r.estado !== 201) throw new Error(`no se dio de alta: ${JSON.stringify(r.cuerpo)}`);
  return (r.cuerpo["datos"] as { id: string }).id;
}

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,telegram_chat_id,activo,creado_en) VALUES (?,'duena.fija.rutas@babycaleb.com','Dueña fija de pruebas','duena',NULL,1,1800000000000)",
    ).bind(DUENA_FIJA),
    // Activa otra vez, pase lo que pase en la prueba anterior.
    real.DB.prepare("UPDATE usuarios SET activo = 1 WHERE id = ?").bind(DUENA_FIJA),
  ]);
});

describe("POST /usuarios", () => {
  it("da de alta a alguien, con acceso desde el primer momento", async () => {
    const correo = correoNuevo();
    const r = await post(duena, "/usuarios", {
      correo,
      nombre: "  Yarielis   Pérez ",
      rol: "asistente",
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);

    const u = await usuarioEn((r.cuerpo["datos"] as { id: string }).id);
    expect(u?.correo).toBe(correo);
    expect(u?.nombre).toBe("Yarielis Pérez");
    expect(u?.rol).toBe("asistente");
    expect(u?.activo).toBe(1);
  });

  /**
   * El correo se guarda en minúsculas.
   *
   * Access entrega siempre el correo en minúsculas y la puerta lo cruza con
   * esta columna. Un «Yarielis@Gmail.com» tecleado con mayúscula dejaría a esa
   * persona fuera para siempre, con un «no autorizado» que no explica nada.
   */
  it("guarda el correo en minúsculas, aunque se teclee con mayúsculas", async () => {
    const correo = correoNuevo();
    const id = await darDeAlta({ correo: correo.toUpperCase() });
    expect((await usuarioEn(id))?.correo).toBe(correo.toLowerCase());
  });

  it("dos correos que solo cambian de mayúsculas son la misma persona", async () => {
    const correo = correoNuevo();
    await darDeAlta({ correo });

    const otra = await post(duena, "/usuarios", {
      correo: correo.toUpperCase(),
      nombre: "La misma de antes",
      rol: "contadora",
    });
    expect(otra.estado).toBe(409);
    expect(otra.cuerpo["codigo"]).toBe("repetido");
    expect(String(otra.cuerpo["mensaje"])).toMatch(/mayúsculas/i);
  });

  it("un correo que no parece un correo se rechaza al teclearlo", async () => {
    const r = await post(duena, "/usuarios", {
      correo: "yarielis arroba babycaleb",
      nombre: "Yarielis",
      rol: "asistente",
    });
    expect(r.estado).toBe(400);
  });

  /**
   * El motorizado es un rol del sistema pero NO tiene fila en `usuarios`: vive
   * en `motorizados` y entra por su PIN a otra superficie. Dejarlo entrar aquí
   * le daría una fila que la puerta del panel sabría leer.
   */
  it("solo los tres roles del panel pueden tener fila en usuarios", async () => {
    for (const rol of ["motorizado", "administrador", ""]) {
      const r = await post(duena, "/usuarios", {
        correo: correoNuevo(),
        nombre: "Quien sea",
        rol,
      });
      expect(r.estado, `rol «${rol}»`).toBe(400);
    }
  });

  it("la contadora no da de alta a nadie", async () => {
    const r = await post(entrandoComo("contadora"), "/usuarios", {
      correo: correoNuevo(),
      nombre: "Quien sea",
      rol: "asistente",
    });
    expect(r.estado).toBe(403);
  });
});

describe("PATCH /usuarios/:id", () => {
  it("quita el acceso y lo devuelve, sin borrar la fila", async () => {
    const id = await darDeAlta();

    expect((await patch(duena, `/usuarios/${id}`, { activo: false })).estado).toBe(200);
    expect((await usuarioEn(id))?.activo).toBe(0);

    expect((await patch(duena, `/usuarios/${id}`, { activo: true })).estado).toBe(200);
    expect((await usuarioEn(id))?.activo).toBe(1);
  });

  /**
   * LA REGLA QUE IMPORTA, y la que vigila la fila de control.
   *
   * No hay comprobación previa a propósito: la condición se mira en el mismo
   * batch, DESPUÉS del UPDATE. Comprobada neutralizando el control —dejarlo en
   * `1` fijo— y esta prueba es la que se pone roja: sin él, la última dueña se
   * queda fuera y el sistema sin nadie que pueda devolverle el acceso.
   */
  it("no deja quitarle el acceso a la última dueña", async () => {
    // Que no quede ninguna otra dueña activa, para montar el caso de verdad.
    await real.DB.prepare(
      "UPDATE usuarios SET activo = 0 WHERE rol = 'duena' AND id <> ?",
    )
      .bind(DUENA_FIJA)
      .run();
    expect(await duenasActivas()).toBe(1);

    const r = await patch(duena, `/usuarios/${DUENA_FIJA}`, { activo: false });
    expect(r.estado).toBe(422);
    expect(r.cuerpo["codigo"]).toBe("transicion_invalida");
    expect(String(r.cuerpo["mensaje"])).toMatch(/única dueña/i);

    // Y no la quitó: el batch es todo o nada.
    expect((await usuarioEn(DUENA_FIJA))?.activo).toBe(1);
    expect(await duenasActivas()).toBe(1);
  });

  it("sí deja quitarle el acceso a una dueña cuando queda otra", async () => {
    const otra = await darDeAlta({ rol: "duena", nombre: "La segunda dueña" });
    expect(await duenasActivas()).toBeGreaterThanOrEqual(2);

    const r = await patch(duena, `/usuarios/${otra}`, { activo: false });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);
    expect((await usuarioEn(otra))?.activo).toBe(0);
    expect(await duenasActivas()).toBeGreaterThanOrEqual(1);
  });

  /** La otra mitad del control: la fila que no existe. */
  it("quitarle el acceso a alguien que no existe no dice que sí", async () => {
    const r = await patch(duena, "/usuarios/u-que-no-existe", { activo: false });
    expect(r.estado).toBe(404);
    expect(r.cuerpo["codigo"]).toBe("no_encontrado");
  });

  it("un cuerpo que no dice si entra o no entra se rechaza", async () => {
    const id = await darDeAlta();
    const r = await patch(duena, `/usuarios/${id}`, { activo: "si" });
    expect(r.estado).toBe(400);
  });

  it("la asistente no cambia el acceso de nadie", async () => {
    const id = await darDeAlta();
    const r = await patch(entrandoComo("asistente"), `/usuarios/${id}`, { activo: false });
    expect(r.estado).toBe(403);
  });
});

/**
 * El código para vincular un Telegram.
 *
 * `usuarios.telegram_chat_id` existe desde la primera migración y nada la
 * escribía: la única forma de poner un chat ahí era un UPDATE a mano en la
 * consola de D1, y la dueña de este sistema no usa la terminal. Esta ruta es
 * la llave de la puerta de Telegram, así que se prueba POR DONDE la va a
 * pedir ella.
 */
describe("POST /usuarios/:id/telegram", () => {
  /**
   * La dueña que pide el código tiene que EXISTIR en `usuarios`.
   *
   * `telegram_vinculos.creado_por` lleva llave foránea, y por la puerta de
   * verdad eso se cumple siempre: el usuario sale de cruzar el correo de
   * Access con esta tabla. Aquí el resolver es de mentira, así que la fila hay
   * que ponerla a mano — y que haga falta es justamente lo que dice que la
   * llave foránea está viva.
   */
  beforeEach(async () => {
    await real.DB.prepare(
      `INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, telegram_chat_id, activo, creado_en)
       VALUES (?, ?, ?, 'duena', NULL, 1, 1800000000000)`,
    )
      .bind(comoRol("duena").id, comoRol("duena").correo, comoRol("duena").nombre)
      .run();
  });

  it("devuelve un código legible y dice cuánto vale", async () => {
    const id = await darDeAlta();
    const r = await post(duena, `/usuarios/${id}/telegram`, {});

    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    const datos = r.cuerpo["datos"] as { codigo: string; vence_en: number; minutos: number };
    expect(datos.codigo).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(datos.minutos).toBeGreaterThan(0);
    expect(datos.vence_en).toBeGreaterThan(Date.now());
  });

  it("el código no se guarda: en la tabla queda su hash", async () => {
    const id = await darDeAlta();
    const r = await post(duena, `/usuarios/${id}/telegram`, {});
    const { codigo } = r.cuerpo["datos"] as { codigo: string };

    const fila = await real.DB.prepare(
      "SELECT codigo_hash FROM telegram_vinculos WHERE usuario_id = ?",
    )
      .bind(id)
      .first<{ codigo_hash: string }>();

    expect(fila?.codigo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila?.codigo_hash).not.toContain(codigo.replace(/-/g, ""));
  });

  it("solo la dueña lo pide: es una llave, no un dato", async () => {
    // Con ese código, un chat cualquiera queda hablando con Caleb con los
    // permisos de la persona que se vincula.
    const id = await darDeAlta();
    for (const rol of ["asistente", "contadora"] as const) {
      const r = await post(entrandoComo(rol), `/usuarios/${id}/telegram`, {});
      expect(r.estado, `${rol} no debería poder`).toBe(403);
    }
  });

  it("no se le hace a alguien que no existe", async () => {
    const r = await post(duena, "/usuarios/u-que-no-existe/telegram", {});
    expect(r.estado).toBe(404);
  });

  it("ni a alguien sin acceso al panel: la puerta de Telegram exige activo = 1", async () => {
    const id = await darDeAlta();
    await patch(duena, `/usuarios/${id}`, { activo: false });

    const r = await post(duena, `/usuarios/${id}/telegram`, {});
    expect(r.estado).toBe(422);
    expect(String(r.cuerpo["mensaje"])).toContain("acceso");
  });
});
