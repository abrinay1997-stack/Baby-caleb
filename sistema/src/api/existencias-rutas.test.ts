import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * `POST /existencias/movimientos` desde el panel, con el COSTO.
 *
 * El costo promedio (`valor_inventario`) llevaba desde la migración 0001
 * leyéndose al entregar y sin que nadie lo llenara: no había un solo INSERT en
 * todo `src/`. El escritor que faltaba vive en `db/inventario.ts`, y esta es su
 * ruta. Tenía cero pruebas, así que nadie podía decir que el costo llegaba
 * desde la pantalla hasta la tabla.
 *
 * Una pieza no está terminada cuando sus pruebas pasan: está terminada cuando
 * algo la llama **por donde la va a llamar la dueña** (`docs/TRAMPAS.md` §12).
 * Estas pruebas entran por ahí.
 *
 * Archivo aparte de `panel.test.ts` y no es capricho: ese archivo vacía
 * `existencias`, `variantes` y `bodegas` en cada prueba, y un movimiento de
 * inventario las referencia con una llave foránea. Como los movimientos NO se
 * borran —hay un trigger que lo prohíbe, y es la regla—, cualquier prueba que
 * escriba un movimiento allí rompe el borrado de la siguiente. Aquí se siembra
 * con `OR IGNORE` y se vuelve al punto de partida con UPDATE, como en
 * `bodegas-rutas.test.ts`.
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

async function post(
  app: ReturnType<typeof crearPanel>,
  ruta: string,
  cuerpo: Record<string, unknown>,
): Promise<{ estado: number; cuerpo: Record<string, unknown> }> {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: "POST",
      body: JSON.stringify(cuerpo),
      headers: { "content-type": "application/json" },
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

const duena = entrandoComo("duena");

/** Identificadores propios: la migración 0003 siembra el catálogo de verdad. */
const COD = "EXI-RUTA-1";
const BOD = "bod-exi-ruta";

const promedio = async (): Promise<{ unidades: number; valor_cents: number } | null> =>
  await real.DB.prepare("SELECT unidades, valor_cents FROM valor_inventario WHERE codigo = ?")
    .bind(COD)
    .first<{ unidades: number; valor_cents: number }>();

const fisico = async (): Promise<number | undefined> =>
  (
    await real.DB.prepare("SELECT fisico FROM existencias WHERE codigo = ? AND bodega_id = ?")
      .bind(COD, BOD)
      .first<{ fisico: number }>()
  )?.fisico;

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p-exi-ruta','panal','Pañal de prueba de existencias','panal-prueba-existencias',?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en) VALUES (?,'p-exi-ruta','Pañal de existencias — M','M',10,5000,0,1,?)",
    ).bind(COD, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO bodegas (id,nombre,activa) VALUES (?,'Bodega de prueba de existencias',1)",
    ).bind(BOD),
    real.DB.prepare(
      "INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,0,0,NULL)",
    ).bind(COD, BOD),
    real.DB.prepare(
      "UPDATE existencias SET fisico = 10, reservado = 0 WHERE codigo = ? AND bodega_id = ?",
    ).bind(COD, BOD),
    // Sin promedio cargado, que es como está hoy la producción.
    real.DB.prepare("DELETE FROM valor_inventario WHERE codigo = ?").bind(COD),
  ]);
});

describe("POST /existencias/movimientos · cargar el costo desde el panel", () => {
  it("una entrada con su costo llena el promedio que llevaba vacío desde 0001", async () => {
    const r = await post(duena, "/existencias/movimientos", {
      tipo: "apertura",
      lineas: [{ codigo: COD, bodegaId: BOD, delta: 20, costoUnitCents: 250 }],
    });

    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    expect(await fisico()).toBe(30);
    expect(await promedio()).toMatchObject({ unidades: 20, valor_cents: 5_000 });
  });

  it("la misma entrada sin costo mueve el estante y NO inventa un cero", async () => {
    // Las unidades existen; lo que costaron no se sabe. Un cero diría que
    // fueron gratis y pondría el margen en 100 % (TRAMPAS §7).
    const r = await post(duena, "/existencias/movimientos", {
      tipo: "apertura",
      lineas: [{ codigo: COD, bodegaId: BOD, delta: 20 }],
    });

    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    expect(await fisico()).toBe(30);
    expect(await promedio()).toBeNull();
  });

  it("una salida baja el promedio que se cargó, por la misma ruta", async () => {
    // Las dos mitades por la puerta de la dueña: si el promedio solo subiera,
    // quedaría valiendo más de lo que hay y el costo de cada venta saldría
    // inflado — corrompido y cuadrando igual.
    expect(
      (
        await post(duena, "/existencias/movimientos", {
          tipo: "apertura",
          lineas: [{ codigo: COD, bodegaId: BOD, delta: 20, costoUnitCents: 250 }],
        })
      ).estado,
    ).toBe(201);

    const r = await post(duena, "/existencias/movimientos", {
      tipo: "merma",
      motivo: "dos cajas mojadas en la bodega",
      lineas: [{ codigo: COD, bodegaId: BOD, delta: -5 }],
    });

    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    // round(5000 × 5 / 20) = 1250.
    expect(await promedio()).toMatchObject({ unidades: 15, valor_cents: 3_750 });
  });

  it("un costo en una SALIDA se rechaza con un mensaje, no en silencio", async () => {
    const r = await post(duena, "/existencias/movimientos", {
      tipo: "merma",
      motivo: "caja mojada",
      lineas: [{ codigo: COD, bodegaId: BOD, delta: -2, costoUnitCents: 250 }],
    });

    expect(r.estado).toBe(400);
    expect(r.cuerpo).toMatchObject({ ok: false, codigo: "entrada_invalida" });
  });

  it("un rol que no edita el stock no carga costos", async () => {
    const r = await post(entrandoComo("asistente"), "/existencias/movimientos", {
      tipo: "apertura",
      lineas: [{ codigo: COD, bodegaId: BOD, delta: 20, costoUnitCents: 250 }],
    });

    expect(r.estado).toBe(403);
    expect(await promedio()).toBeNull();
  });
});
