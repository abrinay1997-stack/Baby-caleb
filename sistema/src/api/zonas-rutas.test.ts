import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Las zonas de envío desde el panel.
 *
 * El tarifario estaba cargado por migración y la pantalla solo sabía leerlo:
 * para cambiar una tarifa, añadir un barrio o pausar una zona había que entrar
 * por SQL, que es justo lo que la dueña no hace.
 *
 * Lo que más se vigila aquí es la diferencia entre **cero** y **se cotiza a
 * mano**. `tarifa_cents` admite nulo y significa «todavía no se sabe»; cero
 * significa «el envío no se cobra». Confundirlas regala el envío del interior
 * en un sentido, y en el otro le dice «le cotizamos» a quien tenía envío
 * gratis.
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

/** Bodega propia: la migración 0003 siembra las de verdad y las zonas reales. */
const BOD = "bod-zona-ruta";

/** Nombres propios: `zonas_envio.nombre` es UNIQUE y la 0003 carga 47 zonas. */
let n = 0;
const nombreNuevo = () => `Zona de prueba ${Date.now()}-${n++}`;

const zonaEn = async (id: string) =>
  await real.DB.prepare(
    "SELECT nombre, alias_json, region, metodo, tarifa_cents, requiere_pago_total, bodega_preferida_id, activa FROM zonas_envio WHERE id = ?",
  )
    .bind(id)
    .first<{
      nombre: string;
      alias_json: string;
      region: string;
      metodo: string;
      tarifa_cents: number | null;
      requiere_pago_total: number;
      bodega_preferida_id: string | null;
      activa: number;
    }>();

/** Crea una zona de prueba y devuelve su id. */
async function unaZona(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await post(duena, "/zonas", {
    nombre: nombreNuevo(),
    alias: [],
    region: "ciudad",
    metodo: "motorizado",
    tarifaCents: 400,
    requierePagoTotal: false,
    bodegaPreferidaId: null,
    ...extra,
  });
  if (r.estado !== 201) throw new Error(`no se creó la zona: ${JSON.stringify(r.cuerpo)}`);
  return (r.cuerpo["datos"] as { id: string }).id;
}

beforeEach(async () => {
  await real.DB.prepare(
    "INSERT OR IGNORE INTO bodegas (id,nombre,activa) VALUES (?,'Bodega de prueba de zonas',1)",
  )
    .bind(BOD)
    .run();
});

describe("POST /zonas", () => {
  it("crea la zona con su tarifa y sus alias", async () => {
    const nombre = nombreNuevo();
    const r = await post(duena, "/zonas", {
      nombre,
      alias: ["doce de octubre", "  12 de octubre  "],
      region: "ciudad",
      metodo: "motorizado",
      tarifaCents: 350,
      requierePagoTotal: false,
      bodegaPreferidaId: BOD,
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);

    const z = await zonaEn((r.cuerpo["datos"] as { id: string }).id);
    expect(z?.nombre).toBe(nombre);
    expect(z?.tarifa_cents).toBe(350);
    expect(z?.bodega_preferida_id).toBe(BOD);
    expect(z?.activa).toBe(1);
    // Los espacios se limpian pero las mayúsculas y las tildes NO: lo que se
    // guarda es como lo escribe la clienta, y quien compara ya quita tildes.
    expect(JSON.parse(z?.alias_json ?? "[]")).toEqual(["doce de octubre", "12 de octubre"]);
  });

  /** Las dos caras de la misma moneda, en la misma prueba para que se vean juntas. */
  it("cero y «se cotiza a mano» son cosas distintas y se guardan distintas", async () => {
    const gratis = await zonaEn(await unaZona({ tarifaCents: 0 }));
    const aMano = await zonaEn(await unaZona({ tarifaCents: null, region: "interior" }));

    expect(gratis?.tarifa_cents).toBe(0);
    expect(aMano?.tarifa_cents).toBeNull();
  });

  /**
   * La hoja de «zona nueva» deja elegir si se está entregando ahí. Si el
   * servidor ignorara esa elección, la dueña vería «Pausada» en la pantalla
   * con el checkout ofreciéndola igual — una pantalla que pregunta algo y
   * guarda lo contrario es peor que una que no pregunta.
   */
  it("respeta que una zona nueva nazca pausada, y sin decir nada nace entregando", async () => {
    expect((await zonaEn(await unaZona({ activa: false })))?.activa).toBe(0);
    expect((await zonaEn(await unaZona()))?.activa).toBe(1);
  });

  it("una tarifa negativa no es una tarifa", async () => {
    const r = await post(duena, "/zonas", {
      nombre: nombreNuevo(),
      region: "ciudad",
      metodo: "motorizado",
      tarifaCents: -100,
    });
    expect(r.estado).toBe(400);
  });

  it("la región y el método salen de una lista, no de lo que se teclee", async () => {
    const malaRegion = await post(duena, "/zonas", {
      nombre: nombreNuevo(),
      region: "Panamá",
      metodo: "motorizado",
      tarifaCents: 400,
    });
    expect(malaRegion.estado).toBe(400);

    const malMetodo = await post(duena, "/zonas", {
      nombre: nombreNuevo(),
      region: "ciudad",
      metodo: "encomienda",
      tarifaCents: 400,
    });
    expect(malMetodo.estado).toBe(400);
  });

  it("no deja dos zonas con el mismo nombre", async () => {
    const nombre = nombreNuevo();
    expect(
      (await post(duena, "/zonas", { nombre, region: "ciudad", metodo: "motorizado", tarifaCents: 400 }))
        .estado,
    ).toBe(201);

    const otra = await post(duena, "/zonas", {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifaCents: 400,
    });
    expect(otra.estado).toBe(409);
    expect(otra.cuerpo["codigo"]).toBe("repetido");
  });

  it("una bodega preferida que no existe se dice, no se guarda en nulo", async () => {
    const r = await post(duena, "/zonas", {
      nombre: nombreNuevo(),
      region: "ciudad",
      metodo: "motorizado",
      tarifaCents: 400,
      bodegaPreferidaId: "bod-que-no-existe",
    });
    expect(r.estado).toBe(404);
  });

  it("la asistente ve las zonas pero no cambia una tarifa", async () => {
    const asistente = entrandoComo("asistente");
    expect((await llamar(asistente, "GET", "/zonas")).estado).toBe(200);

    const r = await post(asistente, "/zonas", {
      nombre: nombreNuevo(),
      region: "ciudad",
      metodo: "motorizado",
      tarifaCents: 400,
    });
    expect(r.estado).toBe(403);
  });
});

describe("PATCH /zonas/:id", () => {
  it("cambia la tarifa y deja lo demás como estaba", async () => {
    const id = await unaZona({ alias: ["un alias"], bodegaPreferidaId: BOD });
    const antes = await zonaEn(id);

    const r = await patch(duena, `/zonas/${id}`, { tarifaCents: 525 });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const despues = await zonaEn(id);
    expect(despues?.tarifa_cents).toBe(525);
    expect(despues?.nombre).toBe(antes?.nombre);
    expect(despues?.alias_json).toBe(antes?.alias_json);
    expect(despues?.bodega_preferida_id).toBe(BOD);
  });

  /**
   * La prueba que vigila el `IS` del control.
   *
   * Pasar una zona a «se cotiza a mano» escribe un NULL. Con `=` en vez de
   * `IS`, el control compararía `tarifa_cents = NULL`, que en SQL no es falso
   * sino DESCONOCIDO: la cuenta sale 0, el CHECK tumba el batch y un guardado
   * perfectamente bueno falla. Esto es lo que rompió el catálogo entero.
   */
  it("deja pasar una zona a «se cotiza a mano», que es escribir un nulo", async () => {
    const id = await unaZona({ tarifaCents: 400 });

    const r = await patch(duena, `/zonas/${id}`, { tarifaCents: null, region: "interior" });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const z = await zonaEn(id);
    expect(z?.tarifa_cents).toBeNull();
    expect(z?.region).toBe("interior");
  });

  /** Lo mismo con la otra columna que admite nulo. */
  it("deja quitarle la bodega preferida a una zona", async () => {
    const id = await unaZona({ bodegaPreferidaId: BOD });

    const r = await patch(duena, `/zonas/${id}`, { bodegaPreferidaId: null });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);
    expect((await zonaEn(id))?.bodega_preferida_id).toBeNull();
  });

  /**
   * Esta es la que vigila la fila de control.
   *
   * Un `UPDATE` que no casa con ninguna fila no falla en D1: afecta cero filas
   * y el batch sigue. Sin el control, esto contestaría 200 sobre una zona que
   * no existe y la dueña creería haber cambiado una tarifa que no cambió.
   */
  it("editar una zona que no existe no dice que sí", async () => {
    const r = await patch(duena, "/zonas/zon-que-no-existe", { tarifaCents: 900 });
    expect(r.estado).toBe(404);
    expect(r.cuerpo["codigo"]).toBe("no_encontrado");
  });

  it("pausa una zona y la vuelve a abrir", async () => {
    const id = await unaZona();

    expect((await patch(duena, `/zonas/${id}`, { activa: false })).estado).toBe(200);
    expect((await zonaEn(id))?.activa).toBe(0);

    expect((await patch(duena, `/zonas/${id}`, { activa: true })).estado).toBe(200);
    expect((await zonaEn(id))?.activa).toBe(1);
  });

  it("no deja ponerle a una zona el nombre de otra", async () => {
    const primera = await unaZona();
    const segunda = await unaZona();
    const nombreDeLaPrimera = (await zonaEn(primera))?.nombre ?? "";

    const r = await patch(duena, `/zonas/${segunda}`, { nombre: nombreDeLaPrimera });
    expect(r.estado).toBe(409);
    expect(r.cuerpo["codigo"]).toBe("repetido");
  });

  it("un cuerpo sin nada que cambiar se rechaza", async () => {
    const id = await unaZona();
    const r = await patch(duena, `/zonas/${id}`, {});
    expect(r.estado).toBe(400);
  });

  it("GET /zonas devuelve el id de la bodega, no solo su nombre", async () => {
    const id = await unaZona({ bodegaPreferidaId: BOD });
    const r = await llamar(duena, "GET", "/zonas");

    const zonas = (r.cuerpo["datos"] as { zonas: Record<string, unknown>[] }).zonas;
    const mia = zonas.find((z) => z["id"] === id);
    // Sin el id, la hoja de editar no puede dejar marcada la bodega que ya
    // estaba, y guardar cualquier otro campo se la borraría.
    expect(mia?.["bodega_preferida_id"]).toBe(BOD);
  });
});
