import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * La ficha de la clienta, desde el panel.
 *
 * Una pieza terminada que nadie llama no está terminada: `editar` y
 * `leerFicha` podrían estar perfectas y, sin estas dos rutas, la dueña no
 * tendría dónde escribir una cédula. Ya pasó tres veces en este repositorio
 * —los asientos, los cobros, `crearPedido`— y siempre con las pruebas en
 * verde, porque las pruebas de un módulo comprueban que funciona, no que esté
 * enchufado. Estas lo llaman POR DONDE lo va a llamar la pantalla.
 */

const T = 1_800_000_000_000;

const comoRol = (rol: RolDePanel): Usuario => ({
  id: `u-${rol}`,
  correo: `${rol}@babycaleb.com`,
  nombre: `La ${rol}`,
  rol,
  activo: true,
});
const entrandoComo = (rol: RolDePanel) =>
  crearPanel((async () => ({ ok: true, usuario: comoRol(rol) })) as ResolverUsuario);

async function pedir(
  app: ReturnType<typeof crearPanel>,
  metodo: "GET" | "PATCH",
  ruta: string,
  cuerpo?: Record<string, unknown>,
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: metodo,
      ...(cuerpo === undefined
        ? {}
        : { body: JSON.stringify(cuerpo), headers: { "content-type": "application/json" } }),
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

const duena = entrandoComo("duena");

/** Identificadores propios: la migración 0003 siembra los del negocio real. */
const CLI = "cli-ruta-ficha";
const DIR = "dir-ruta-ficha";
const ZONA = "zona-ruta-ficha";
const PEDIDO = "ped-ruta-ficha";

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO zonas_envio (id,nombre,region,metodo,actualizado_en) VALUES (?,'Zona de prueba de rutas de ficha','ciudad','motorizado',?)",
    ).bind(ZONA, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,'Clienta De Ruta','50763330001',?,?)",
    ).bind(CLI, T, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO direcciones (id,cliente_id,zona_id,texto,creado_en) VALUES (?,?,?,'Calle de prueba de rutas, casa 3',?)",
    ).bind(DIR, CLI, ZONA, T),
    real.DB.prepare(
      `INSERT OR IGNORE INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
                                      subtotal_cents,total_cents,abono_minimo_cents,creado_en,actualizado_en)
       VALUES (?,'BC-RUTA-FICHA','tok-ruta-ficha',?,'panel','por_abonar','sin_pago',3300,3300,1000,?,?)`,
    ).bind(PEDIDO, CLI, T, T),
    // Al punto de partida, pase lo que pase en la prueba anterior.
    real.DB.prepare(
      `UPDATE clientes SET nombre = 'Clienta De Ruta', apellido = NULL, correo = NULL,
              identificacion = NULL, identificacion_tipo = NULL, notas = NULL,
              celular_e164 = '50763330001'
        WHERE id = ?`,
    ).bind(CLI),
    real.DB.prepare(
      "UPDATE direcciones SET ciudad = NULL, provincia_iso = NULL, codigo_postal = NULL, pais = NULL WHERE id = ?",
    ).bind(DIR),
  ]);
});

describe("GET /clientes/:id", () => {
  it("trae la ficha con sus pedidos y lo que le falta", async () => {
    const r = await pedir(duena, "GET", `/clientes/${CLI}`);
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const d = r.cuerpo["datos"] as {
      clienta: { id: string; apellido: string | null };
      direcciones: { id: string }[];
      pedidos: { numero: string }[];
      falta: { paraTarjeta: string[]; paraFactura: string[] };
    };
    expect(d.clienta.id).toBe(CLI);
    expect(d.direcciones.map((x) => x.id)).toContain(DIR);
    expect(d.pedidos.map((p) => p.numero)).toEqual(["BC-RUTA-FICHA"]);
    // La razón de ser de la pantalla: decir qué falta, no solo qué hay.
    expect(d.falta.paraTarjeta).toContain("el apellido");
    expect(d.falta.paraFactura).toContain("la cédula o el RUC");
  });

  it("una clienta que no existe da 404 y no un 500", async () => {
    const r = await pedir(duena, "GET", "/clientes/cli-ruta-fantasma");
    expect(r.estado).toBe(404);
  });

  /**
   * La contadora VE la ficha —tiene `pedidos` en «ver»— y por eso esto no es
   * un 403. Lo que no ve es el dinero de esos pedidos, y eso lo recorta la
   * consulta, no la pantalla: si lo escondiera la pantalla, el total viajaría
   * igual hasta el navegador.
   */
  it("la contadora ve la ficha pero no los totales", async () => {
    const r = await pedir(entrandoComo("contadora"), "GET", `/clientes/${CLI}`);
    expect(r.estado).toBe(200);
    const d = r.cuerpo["datos"] as { pedidos: { total_cents: number | null }[] };
    expect(d.pedidos[0]?.total_cents).toBeNull();
  });
});

describe("PATCH /clientes/:id", () => {
  it("guarda el apellido, la cédula y los datos de facturación de su dirección", async () => {
    const r = await pedir(duena, "PATCH", `/clientes/${CLI}`, {
      apellido: "De Ruta",
      correo: "clienta.de.ruta@ejemplo.test",
      identificacion: "0-000-0000",
      identificacionTipo: "cedula",
      direccion: {
        id: DIR,
        ciudad: "Ciudad de prueba",
        provinciaIso: "PA-8",
        codigoPostal: "0000",
        pais: "PA",
      },
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    // La respuesta es la ficha ya releída: lo que la pantalla pinta después
    // de guardar es lo que quedó en la base, no lo que se mandó.
    const d = r.cuerpo["datos"] as { falta: { paraTarjeta: string[]; paraFactura: string[] } };
    expect(d.falta.paraTarjeta).toEqual([]);
    expect(d.falta.paraFactura).toEqual([]);

    const fila = await real.DB.prepare(
      "SELECT apellido, identificacion_tipo FROM clientes WHERE id = ?",
    )
      .bind(CLI)
      .first<{ apellido: string; identificacion_tipo: string }>();
    expect(fila?.apellido).toBe("De Ruta");
    expect(fila?.identificacion_tipo).toBe("cedula");
  });

  /**
   * El caso que rompió el catálogo, ahora por la puerta de la ruta: la
   * pantalla manda `""` cuando se vacía un campo y `null` cuando no había
   * nada, y las dos cosas tienen que guardar un blanco sin error.
   */
  it("un campo vaciado desde la pantalla se guarda vacío", async () => {
    await pedir(duena, "PATCH", `/clientes/${CLI}`, {
      apellido: "De Ruta",
      direccion: { id: DIR, ciudad: "Ciudad de prueba" },
    });

    const r = await pedir(duena, "PATCH", `/clientes/${CLI}`, {
      apellido: "",
      correo: null,
      direccion: { id: DIR, ciudad: "" },
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const fila = await real.DB.prepare(
      `SELECT c.apellido, c.correo, d.ciudad
         FROM clientes c JOIN direcciones d ON d.cliente_id = c.id
        WHERE c.id = ? AND d.id = ?`,
    )
      .bind(CLI, DIR)
      .first<{ apellido: string | null; correo: string | null; ciudad: string | null }>();
    expect(fila?.apellido).toBeNull();
    expect(fila?.correo).toBeNull();
    expect(fila?.ciudad).toBeNull();
  });

  it("lo que no se manda NO se toca", async () => {
    await pedir(duena, "PATCH", `/clientes/${CLI}`, { apellido: "De Ruta" });
    await pedir(duena, "PATCH", `/clientes/${CLI}`, { notas: "Prefiere entregas por la tarde" });

    const fila = await real.DB.prepare("SELECT apellido, notas FROM clientes WHERE id = ?")
      .bind(CLI)
      .first<{ apellido: string | null; notas: string | null }>();
    expect(fila?.apellido).toBe("De Ruta");
    expect(fila?.notas).toBe("Prefiere entregas por la tarde");
  });

  it("un número sin decir si es cédula o RUC se rechaza con 400", async () => {
    const r = await pedir(duena, "PATCH", `/clientes/${CLI}`, { identificacion: "0-000-0000" });
    expect(r.estado).toBe(400);
    expect(String(r.cuerpo["mensaje"])).toMatch(/cédula o RUC/i);
  });

  it("una dirección sin id se rechaza en vez de adivinar cuál", async () => {
    const r = await pedir(duena, "PATCH", `/clientes/${CLI}`, {
      direccion: { ciudad: "Ciudad de prueba" },
    });
    expect(r.estado).toBe(400);
  });

  it("la clienta que no existe da 404", async () => {
    const r = await pedir(duena, "PATCH", "/clientes/cli-ruta-fantasma", { apellido: "De Ruta" });
    expect(r.estado).toBe(404);
  });

  /**
   * La contadora ve los pedidos y no los toca. Lo comprueba el servidor, no
   * la pantalla: esconder el botón es una cortesía, no una defensa.
   */
  it("la contadora no corrige fichas", async () => {
    const r = await pedir(entrandoComo("contadora"), "PATCH", `/clientes/${CLI}`, {
      apellido: "De Ruta",
    });
    expect(r.estado).toBe(403);

    const fila = await real.DB.prepare("SELECT apellido FROM clientes WHERE id = ?")
      .bind(CLI)
      .first<{ apellido: string | null }>();
    expect(fila?.apellido).toBeNull();
  });

  it("sin cuerpo no se guarda nada", async () => {
    const r = await pedir(duena, "PATCH", `/clientes/${CLI}`);
    expect(r.estado).toBe(400);
  });
});
