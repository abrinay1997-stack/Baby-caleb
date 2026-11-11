import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Las tres puertas de un pedido, desde el panel.
 *
 * `crearPedido`, `agendar` y `cancelar` llevaban semanas escritas y probadas,
 * y no las llamaba NADIE: ni el panel ni la web. El sistema sabía crear
 * pedidos y no tenía por dónde entrara uno. Estas pruebas existen para que no
 * vuelva a pasar: si alguien quita una ruta, se caen.
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
) {
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

/** Códigos propios: el catálogo real de la migración 0003 también vive aquí. */
const COD = "PED-RUTA-1";
const BOD = "bod-ped-ruta";
const CLI = "cli-ped-ruta";

const libres = async (): Promise<{ fisico: number; reservado: number }> => {
  const f = await real.DB.prepare(
    "SELECT fisico, reservado FROM existencias WHERE codigo = ? AND bodega_id = ?",
  )
    .bind(COD, BOD)
    .first<{ fisico: number; reservado: number }>();
  if (f === null) throw new Error("la siembra no dejó existencias");
  return f;
};

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,'Clienta de prueba','50760000001',?,?)",
    ).bind(CLI, T, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p-ped-ruta','panal','Pañal de prueba de rutas','panal-prueba-rutas',?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en) VALUES (?,'p-ped-ruta','Pañal de prueba — M','M',10,5000,NULL,1,?)",
    ).bind(COD, T),
    real.DB.prepare("INSERT OR IGNORE INTO bodegas (id,nombre) VALUES (?,'Bodega de prueba de rutas')").bind(BOD),
    real.DB.prepare(
      "INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,20,0,NULL)",
    ).bind(COD, BOD),
    // Al punto de partida, pase lo que pase en la prueba anterior.
    real.DB.prepare("UPDATE existencias SET fisico = 20, reservado = 0 WHERE codigo = ? AND bodega_id = ?").bind(COD, BOD),
  ]);
});

/** Un pedido nuevo, con una llave de idempotencia distinta cada vez. */
let n = 0;
const nuevoPedido = (extra: Record<string, unknown> = {}) => ({
  idempotencia: `prueba-rutas-${Date.now()}-${n++}`,
  clienteId: CLI,
  lineas: [{ codigo: COD, cantidad: 2 }],
  ...extra,
});

describe("POST /pedidos", () => {
  it("crea el pedido y aparta el stock", async () => {
    const antes = await libres();
    const r = await post(duena, "/pedidos", nuevoPedido());

    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    const datos = r.cuerpo["datos"] as { numero: string; totalCents: number };
    expect(datos.numero).toMatch(/^BC-/);
    expect(datos.totalCents).toBe(10_000); // 2 × $50.00

    const despues = await libres();
    expect(despues.reservado).toBe(antes.reservado + 2);
  });

  /**
   * El origen NO se lee del cuerpo.
   *
   * Si quien llama pudiera declararse «web», un pedido tecleado a mano
   * contaría como una venta que la tienda nunca hizo, y las métricas por canal
   * dejarían de significar nada sin que nada fallara.
   */
  it("no deja falsificar el origen: lo que se teclea es «panel»", async () => {
    const r = await post(duena, "/pedidos", nuevoPedido({ origen: "web" }));
    expect(r.estado).toBe(201);

    const id = (r.cuerpo["datos"] as { id: string }).id;
    const p = await real.DB.prepare("SELECT origen FROM pedidos WHERE id = ?")
      .bind(id)
      .first<{ origen: string }>();
    expect(p?.origen).toBe("panel");
  });

  it("exige la llave de idempotencia", async () => {
    const { idempotencia: _, ...sinLlave } = nuevoPedido();
    const r = await post(duena, "/pedidos", sinLlave);
    expect(r.estado).toBe(400);
    expect(String(r.cuerpo["mensaje"])).toContain("idempotencia");
  });

  it("un pedido sin líneas no es un pedido", async () => {
    const r = await post(duena, "/pedidos", nuevoPedido({ lineas: [] }));
    expect(r.estado).toBe(400);
  });

  it("la contadora no toma pedidos", async () => {
    const r = await post(entrandoComo("contadora"), "/pedidos", nuevoPedido());
    expect(r.estado).toBe(403);
  });
});

describe("POST /pedidos/:id/agendar", () => {
  it("no agenda un pedido sin el abono mínimo", async () => {
    const creado = await post(duena, "/pedidos", nuevoPedido());
    const id = (creado.cuerpo["datos"] as { id: string }).id;

    const r = await post(duena, `/pedidos/${id}/agendar`, {});
    // 422 y no 409: un 409 diría «hay un choque», y aquí no hay choque con
    // nadie. El pedido está bien y la petición está bien formada; lo que pasa
    // es que todavía no se cumple la condición para agendar.
    expect(r.estado).toBe(422);
    expect(r.cuerpo["codigo"]).toBe("transicion_invalida");
    expect(String(r.cuerpo["mensaje"])).toMatch(/abon|falta|pag/i);
  });

  it("agenda cuando el abono alcanza", async () => {
    const creado = await post(duena, "/pedidos", nuevoPedido());
    const d = creado.cuerpo["datos"] as { id: string; abonoMinimoCents: number };

    // El abono entra por su propio camino; aquí solo interesa que la ruta
    // consulte la regla COPIADA en el pedido y no el ajuste de hoy.
    await real.DB.prepare("UPDATE pedidos SET pagado_cents = ?, estado_pago = 'abonado' WHERE id = ?")
      .bind(d.abonoMinimoCents, d.id)
      .run();

    const r = await post(duena, `/pedidos/${d.id}/agendar`, {});
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const p = await real.DB.prepare("SELECT estado FROM pedidos WHERE id = ?")
      .bind(d.id)
      .first<{ estado: string }>();
    expect(p?.estado).toBe("agendado");
  });
});

describe("POST /pedidos/:id/cancelar", () => {
  it("exige motivo: cancelar mueve inventario y a veces dinero", async () => {
    const creado = await post(duena, "/pedidos", nuevoPedido());
    const id = (creado.cuerpo["datos"] as { id: string }).id;

    const r = await post(duena, `/pedidos/${id}/cancelar`, {});
    expect(r.estado).toBe(400);

    // Y no canceló: el pedido sigue vivo y el stock sigue apartado.
    const p = await real.DB.prepare("SELECT estado FROM pedidos WHERE id = ?")
      .bind(id)
      .first<{ estado: string }>();
    expect(p?.estado).toBe("por_abonar");
  });

  it("cancela y DEVUELVE lo apartado", async () => {
    const antes = await libres();
    const creado = await post(duena, "/pedidos", nuevoPedido());
    const id = (creado.cuerpo["datos"] as { id: string }).id;
    expect((await libres()).reservado).toBe(antes.reservado + 2);

    const r = await post(duena, `/pedidos/${id}/cancelar`, { motivo: "la clienta se arrepintió" });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    expect((await libres()).reservado).toBe(antes.reservado);
    const p = await real.DB.prepare("SELECT estado FROM pedidos WHERE id = ?")
      .bind(id)
      .first<{ estado: string }>();
    expect(p?.estado).toBe("cancelado");
  });
});
