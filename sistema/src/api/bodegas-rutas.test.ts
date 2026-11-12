import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Las bodegas desde el panel: crear, renombrar, dejar de usar y TRASLADAR.
 *
 * Hasta hoy la pantalla solo sabía leer: la dueña veía sus bodegas y no podía
 * abrir una nueva, ni corregir un nombre, ni mover una caja de una a otra. El
 * motor del traslado llevaba semanas escrito y probado, y lo llamaba
 * únicamente el asistente — o sea, para usarlo había que escribirle al bot.
 * Estas pruebas entran POR DONDE ENTRA LA DUEÑA, que es lo único que
 * demuestra que la pieza está enchufada (trampa nº 12).
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

/**
 * Identificadores propios. La migración 0003 siembra el catálogo y las
 * bodegas de verdad: un nombre repetido haría fallar la siembra —o esta
 * prueba— de una forma que no se entiende al leerla.
 */
const COD = "BOD-RUTA-1";
const ORIGEN = "bod-ruta-origen";
const DESTINO = "bod-ruta-destino";

const fisicoEn = async (bodegaId: string): Promise<number> => {
  const f = await real.DB.prepare(
    "SELECT fisico FROM existencias WHERE codigo = ? AND bodega_id = ?",
  )
    .bind(COD, bodegaId)
    .first<{ fisico: number }>();
  if (f === null) throw new Error(`la siembra no dejó existencias en ${bodegaId}`);
  return f.fisico;
};

/** Cuántos movimientos hay AHORA. No se pueden borrar: se cuenta la diferencia. */
const cuantosMovimientos = async (): Promise<number> => {
  const f = await real.DB.prepare(
    "SELECT COUNT(*) AS cuantos FROM movimientos_inventario WHERE codigo = ?",
  )
    .bind(COD)
    .first<{ cuantos: number }>();
  return f?.cuantos ?? 0;
};

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p-bod-ruta','panal','Pañal de prueba de bodegas','panal-prueba-bodegas',?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en) VALUES (?,'p-bod-ruta','Pañal de bodegas — M','M',10,5000,NULL,1,?)",
    ).bind(COD, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO bodegas (id,nombre,activa) VALUES (?,'Bodega de prueba origen',1)",
    ).bind(ORIGEN),
    real.DB.prepare(
      "INSERT OR IGNORE INTO bodegas (id,nombre,activa) VALUES (?,'Bodega de prueba destino',1)",
    ).bind(DESTINO),
    real.DB.prepare(
      "INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,30,0,NULL)",
    ).bind(COD, ORIGEN),
    real.DB.prepare(
      "INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,0,0,NULL)",
    ).bind(COD, DESTINO),
    // Al punto de partida, pase lo que pase en la prueba anterior.
    real.DB.prepare(
      "UPDATE existencias SET fisico = 30, reservado = 0 WHERE codigo = ? AND bodega_id = ?",
    ).bind(COD, ORIGEN),
    real.DB.prepare(
      "UPDATE existencias SET fisico = 0, reservado = 0 WHERE codigo = ? AND bodega_id = ?",
    ).bind(COD, DESTINO),
    real.DB.prepare("UPDATE bodegas SET activa = 1 WHERE id IN (?, ?)").bind(ORIGEN, DESTINO),
  ]);
});

/** Un nombre que no choca con el de otra prueba ni con el de la siembra. */
let n = 0;
const nombreNuevo = () => `Bodega de prueba ${Date.now()}-${n++}`;

describe("POST /bodegas", () => {
  it("crea la bodega y le deja casillero para cada artículo", async () => {
    const nombre = nombreNuevo();
    const r = await post(duena, "/bodegas", { nombre });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);

    const { id } = r.cuerpo["datos"] as { id: string };

    // Lo que de verdad la hace usable: sin fila en `existencias`, mover algo
    // allí no casa con nada y la dueña lee «esa bodega no tiene ese artículo»
    // sobre una bodega que acaba de crear.
    const fila = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = ? AND bodega_id = ?",
    )
      .bind(COD, id)
      .first<{ fisico: number }>();
    expect(fila?.fisico).toBe(0);
  });

  it("no deja dos bodegas con el mismo nombre", async () => {
    const nombre = nombreNuevo();
    expect((await post(duena, "/bodegas", { nombre })).estado).toBe(201);

    const otra = await post(duena, "/bodegas", { nombre });
    expect(otra.estado).toBe(409);
    expect(otra.cuerpo["codigo"]).toBe("repetido");
  });

  it("una bodega sin nombre no es una bodega", async () => {
    const r = await post(duena, "/bodegas", { nombre: "   " });
    expect(r.estado).toBe(400);
  });

  it("la asistente no abre bodegas", async () => {
    const r = await post(entrandoComo("asistente"), "/bodegas", { nombre: nombreNuevo() });
    expect(r.estado).toBe(403);
  });
});

describe("PATCH /bodegas/:id", () => {
  it("cambia el nombre", async () => {
    const nombre = nombreNuevo();
    const r = await patch(duena, `/bodegas/${ORIGEN}`, { nombre });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const fila = await real.DB.prepare("SELECT nombre FROM bodegas WHERE id = ?")
      .bind(ORIGEN)
      .first<{ nombre: string }>();
    expect(fila?.nombre).toBe(nombre);

    // Y se deja como estaba, que las demás pruebas la buscan por su nombre.
    await real.DB.prepare("UPDATE bodegas SET nombre = 'Bodega de prueba origen' WHERE id = ?")
      .bind(ORIGEN)
      .run();
  });

  /**
   * Esta es la que vigila la fila de control del renombrado.
   *
   * En D1 un `UPDATE` que no casa con ninguna fila NO falla: afecta cero filas
   * y el batch sigue. Sin el control, esto contestaría 200 sobre una bodega
   * que no existe. Comprobado dejando el control en `1` fijo: esta prueba se
   * pone roja y ninguna otra.
   */
  it("renombrar una bodega que no existe no dice que sí", async () => {
    const r = await patch(duena, "/bodegas/bod-que-no-existe", { nombre: nombreNuevo() });
    expect(r.estado).toBe(404);
    expect(r.cuerpo["codigo"]).toBe("no_encontrado");
  });

  it("no deja ponerle a una bodega el nombre de otra", async () => {
    const r = await patch(duena, `/bodegas/${ORIGEN}`, { nombre: "Bodega de prueba destino" });
    expect(r.estado).toBe(409);
    expect(r.cuerpo["codigo"]).toBe("repetido");
  });

  it("deja de usar una bodega y la vuelve a poner en uso", async () => {
    expect((await patch(duena, `/bodegas/${DESTINO}`, { activa: false })).estado).toBe(200);
    let fila = await real.DB.prepare("SELECT activa FROM bodegas WHERE id = ?")
      .bind(DESTINO)
      .first<{ activa: number }>();
    expect(fila?.activa).toBe(0);

    expect((await patch(duena, `/bodegas/${DESTINO}`, { activa: true })).estado).toBe(200);
    fila = await real.DB.prepare("SELECT activa FROM bodegas WHERE id = ?")
      .bind(DESTINO)
      .first<{ activa: number }>();
    expect(fila?.activa).toBe(1);
  });

  /** La otra mitad del control: el id que no existe, por el camino de `activa`. */
  it("dejar de usar una bodega que no existe no dice que sí", async () => {
    const r = await patch(duena, "/bodegas/bod-que-no-existe", { activa: false });
    expect(r.estado).toBe(404);
  });

  it("un cuerpo sin nada que cambiar se rechaza en vez de contestar que sí", async () => {
    const r = await patch(duena, `/bodegas/${ORIGEN}`, {});
    expect(r.estado).toBe(400);
  });
});

describe("POST /bodegas/traslados", () => {
  it("saca de una y mete en la otra, con sus dos movimientos", async () => {
    const antesMovimientos = await cuantosMovimientos();
    const antesOrigen = await fisicoEn(ORIGEN);
    const antesDestino = await fisicoEn(DESTINO);

    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: DESTINO,
      cantidad: 12,
      motivo: "reparto de la semana",
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);

    expect(await fisicoEn(ORIGEN)).toBe(antesOrigen - 12);
    expect(await fisicoEn(DESTINO)).toBe(antesDestino + 12);

    // Dos: la salida y la entrada. El libro tiene que explicar las dos puntas.
    expect(await cuantosMovimientos()).toBe(antesMovimientos + 2);

    const { results } = await real.DB.prepare(
      `SELECT tipo, bodega_id, delta FROM movimientos_inventario
        WHERE codigo = ? AND referencia_tipo = 'traslado'
        ORDER BY creado_en DESC, tipo LIMIT 2`,
    )
      .bind(COD)
      .all<{ tipo: string; bodega_id: string; delta: number }>();
    expect(results.map((m) => m.tipo).sort()).toEqual(["traslado_entrada", "traslado_salida"]);
  });

  it("si no alcanza, no se mueve NADA", async () => {
    const antesMovimientos = await cuantosMovimientos();
    const antesOrigen = await fisicoEn(ORIGEN);
    const antesDestino = await fisicoEn(DESTINO);

    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: DESTINO,
      cantidad: 999,
    });
    expect(r.estado).toBe(422);
    expect(r.cuerpo["codigo"]).toBe("sin_stock");

    expect(await fisicoEn(ORIGEN)).toBe(antesOrigen);
    expect(await fisicoEn(DESTINO)).toBe(antesDestino);
    expect(await cuantosMovimientos()).toBe(antesMovimientos);
  });

  /**
   * Lo reservado no se puede trasladar: está comprometido en un pedido que
   * todavía no sale. Moverlo dejaría ese pedido sin con qué surtirse en la
   * bodega desde la que se prometió.
   */
  it("no traslada lo que está apartado en un pedido", async () => {
    await real.DB.prepare(
      "UPDATE existencias SET fisico = 10, reservado = 8 WHERE codigo = ? AND bodega_id = ?",
    )
      .bind(COD, ORIGEN)
      .run();

    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: DESTINO,
      cantidad: 5,
    });
    expect(r.estado).toBe(422);
    expect(String(r.cuerpo["mensaje"])).toContain("2");
    expect(await fisicoEn(ORIGEN)).toBe(10);
  });

  it("no manda mercancía a una bodega que ya no se usa", async () => {
    await real.DB.prepare("UPDATE bodegas SET activa = 0 WHERE id = ?").bind(DESTINO).run();

    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: DESTINO,
      cantidad: 1,
    });
    expect(r.estado).toBe(400);
    expect(String(r.cuerpo["mensaje"])).toMatch(/no está en uso/i);
  });

  /** Y al revés SÍ: así se vacía una bodega antes de retirarla. */
  it("sí deja sacar mercancía de una bodega que ya no se usa", async () => {
    await real.DB.prepare("UPDATE bodegas SET activa = 0 WHERE id = ?").bind(ORIGEN).run();

    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: DESTINO,
      cantidad: 3,
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    expect(await fisicoEn(DESTINO)).toBe(3);
  });

  it("origen y destino no pueden ser la misma bodega", async () => {
    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: ORIGEN,
      cantidad: 1,
    });
    expect(r.estado).toBe(400);
  });

  it("una bodega que no existe se dice con esas palabras", async () => {
    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: "bod-que-no-existe",
      cantidad: 1,
    });
    expect(r.estado).toBe(404);
    expect(String(r.cuerpo["mensaje"])).toMatch(/destino/i);
  });

  it("un artículo que no está dado de alta en esa bodega no se confunde con falta de stock", async () => {
    const nombre = nombreNuevo();
    const creada = await post(duena, "/bodegas", { nombre });
    const { id } = creada.cuerpo["datos"] as { id: string };

    // Se le quita el casillero a mano para montar el caso: una bodega a la que
    // le falta ese artículo. El mensaje tiene que decir ESO y no «no alcanza»,
    // que mandaría a contar cajas en el sitio equivocado.
    await real.DB.prepare("DELETE FROM existencias WHERE codigo = ? AND bodega_id = ?")
      .bind(COD, id)
      .run();

    const r = await post(duena, "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: id,
      cantidad: 1,
    });
    expect(r.estado).toBe(404);
    expect(String(r.cuerpo["mensaje"])).toMatch(/no está dado de alta/i);
  });

  it("la asistente no mueve inventario entre bodegas", async () => {
    const r = await post(entrandoComo("asistente"), "/bodegas/traslados", {
      codigo: COD,
      desdeId: ORIGEN,
      haciaId: DESTINO,
      cantidad: 1,
    });
    expect(r.estado).toBe(403);
  });
});
