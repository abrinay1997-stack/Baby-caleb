import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type ResolverUsuario, crearPanel } from "../src/api/panel";
import type { RolDePanel, Usuario } from "../src/seguridad";

/**
 * Las cotizaciones y el checkout, POR DONDE LOS VA A LLAMAR LA DUEÑA.
 *
 * ## Por qué este archivo existe aparte
 *
 * `cotizaciones.test.ts` prueba el motor: que una cotización no aparte stock y
 * que confirmarla sí. Pasa igual con las rutas sin escribir — y eso ya ha
 * mordido **tres veces** en este repositorio (docs/TRAMPAS.md §12): veinte
 * constructores de asientos que nadie llamaba, el módulo de cobros entero sin
 * una ruta, `crearPedido` sin puerta. Las pruebas pasaban las tres veces y
 * pasaban con razón: comprueban que la pieza funciona, no que esté enchufada.
 *
 * Esto comprueba lo segundo. Si mañana alguien quita `POST /cotizaciones`, el
 * motor sigue en verde y esto se pone rojo.
 *
 * ## Y por qué no dentro de `src/api/panel.test.ts`
 *
 * Ese archivo vacía el catálogo en cada `beforeEach` para poder contar lo que
 * siembra, y una cotización deja `pedido_lineas` apuntando a una variante y a
 * una bodega: el `DELETE FROM variantes` revienta contra la llave foránea. No
 * es un defecto de ninguno de los dos — son dos formas legítimas de preparar
 * la base que no se pueden mezclar, porque los libros no se borran.
 */

const T = 1_800_000_000_000;
let k = 0;

const comoUsuario = (rol: RolDePanel): Usuario => ({
  id: `u-${rol}`,
  correo: `${rol}@babycaleb.com`,
  nombre: `La ${rol}`,
  rol,
  activo: true,
});

const entrandoComo = (rol: RolDePanel) =>
  crearPanel((async () => ({ ok: true, usuario: comoUsuario(rol) })) as ResolverUsuario);

async function pedir(app: ReturnType<typeof crearPanel>, ruta: string) {
  const r = await app.fetch(new Request(`https://panel.babycaleb.com${ruta}`), real as Env);
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
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
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

let clienteId: string;
let bodegaId: string;

/**
 * La base de la carga inicial (migración 0003) con existencias conocidas.
 *
 * No se vacía nada: solo se pone `NAT-M` en 30 libres en la bodega activa, que
 * es lo que hace falta para que confirmar alcance sin depender de lo que dejó
 * otra prueba del mismo archivo.
 */
beforeEach(async () => {
  const suf = `${Date.now()}-r${k++}`;
  clienteId = `cr-${suf}`;

  const b = await real.DB.prepare("SELECT id FROM bodegas WHERE activa = 1 LIMIT 1").first<{
    id: string;
  }>();
  bodegaId = b!.id;

  await real.DB.batch([
    real.DB.prepare(
      "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,'Rosa',?,?)",
    ).bind(clienteId, T, T),
    real.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    real.DB.prepare(
      "UPDATE existencias SET fisico = 30 WHERE codigo = 'NAT-M' AND bodega_id = ?",
    ).bind(bodegaId),
  ]);
});

const hacerla = async (rol: RolDePanel, cantidad = 1) =>
  await postJson(entrandoComo(rol), "/cotizaciones", {
    idempotencia: `pr-cot-${Date.now()}-${k++}`,
    clienteId,
    lineas: [{ codigo: "NAT-M", cantidad }],
  });

const libres = async (): Promise<number> =>
  (
    await real.DB.prepare(
      "SELECT COALESCE(SUM(fisico - reservado),0) AS n FROM existencias WHERE codigo = 'NAT-M'",
    ).first<{ n: number }>()
  )?.n ?? -1;

describe("POST /cotizaciones", () => {
  it("existe, y lo que crea no aparta nada", async () => {
    expect(await libres()).toBe(30);
    const r = await hacerla("duena");
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    const d = r.cuerpo.datos as { estado: string; aparto: boolean };
    expect(d.estado).toBe("cotizacion");
    expect(d.aparto).toBe(false);
    expect(await libres()).toBe(30);
  });

  it("se ve en el MISMO listado de pedidos, filtrando por su estado", async () => {
    // Es la consecuencia de que sea el mismo documento: no hay ruta de lectura
    // propia, y no hace falta.
    const hecha = await hacerla("duena");
    const numero = (hecha.cuerpo.datos as { numero: string }).numero;

    const lista = await pedir(entrandoComo("duena"), "/pedidos?estado=cotizacion");
    expect(lista.estado).toBe(200);
    const d = lista.cuerpo.datos as { pedidos: { numero: string }[] };
    expect(d.pedidos.map((p) => p.numero)).toContain(numero);
  });

  it("la asistente también cotiza: es atender, no mover dinero", async () => {
    expect((await hacerla("asistente")).estado).toBe(201);
  });

  it("la contadora NO: mira los pedidos y no los toca", async () => {
    expect((await hacerla("contadora")).estado).toBe(403);
  });

  it("sin llave de idempotencia se rechaza: un doble toque no hace dos documentos", async () => {
    const r = await postJson(entrandoComo("duena"), "/cotizaciones", {
      clienteId,
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
    });
    expect(r.estado).toBe(400);
  });

  it("sin líneas se rechaza, y lo dice en los términos de una cotización", async () => {
    const r = await postJson(entrandoComo("duena"), "/cotizaciones", {
      idempotencia: `pr-vacia-${Date.now()}`,
      clienteId,
      lineas: [],
    });
    expect(r.estado).toBe(400);
    expect(String(r.cuerpo.mensaje)).toContain("cotización");
  });

  it("ningún precio entra por el cuerpo: lo que se mande se ignora", async () => {
    // Un dato, un solo dueño. Si el precio del cuerpo llegara al documento,
    // cualquiera cotizaría una caja a un centavo.
    const r = await postJson(entrandoComo("duena"), "/cotizaciones", {
      idempotencia: `pr-precio-${Date.now()}`,
      clienteId,
      lineas: [{ codigo: "NAT-M", cantidad: 1, precio_cents: 1, precioUnitCents: 1 }],
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(201);
    expect((r.cuerpo.datos as { totalCents: number }).totalCents).toBeGreaterThan(1);
  });

  it("y el origen se fija en «panel», aunque el cuerpo diga «web»", async () => {
    // Si quien llama pudiera declararse «web», un pedido tecleado a mano
    // contaría como una venta que la tienda nunca hizo.
    const r = await postJson(entrandoComo("duena"), "/cotizaciones", {
      idempotencia: `pr-origen-${Date.now()}`,
      clienteId,
      origen: "web",
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
    });
    expect(r.estado).toBe(201);
    const id = (r.cuerpo.datos as { id: string }).id;
    const fila = await real.DB.prepare("SELECT origen FROM pedidos WHERE id = ?")
      .bind(id)
      .first<{ origen: string }>();
    expect(fila?.origen).toBe("panel");
  });
});

describe("POST /cotizaciones/:id/confirmar", () => {
  it("existe, convierte el documento y AHÍ aparta", async () => {
    const hecha = await hacerla("duena", 2);
    const { id, numero } = hecha.cuerpo.datos as { id: string; numero: string };
    expect(await libres()).toBe(30);

    const conf = await postJson(entrandoComo("duena"), `/cotizaciones/${id}/confirmar`, {});
    expect(conf.estado, JSON.stringify(conf.cuerpo)).toBe(200);
    expect(await libres()).toBe(28);

    const leida = await pedir(entrandoComo("duena"), `/pedidos/${id}`);
    const d = leida.cuerpo.datos as { estado: string; numero: string };
    expect(d.estado).toBe("por_abonar");
    // Mismo número: se convirtió, no se copió.
    expect(d.numero).toBe(numero);
  });

  it("si ya no hay existencias, responde 409 sin stock y la deja como estaba", async () => {
    const hecha = await hacerla("duena", 5);
    const { id } = hecha.cuerpo.datos as { id: string };
    await real.DB.prepare("UPDATE existencias SET fisico = 1 WHERE codigo = 'NAT-M'").run();

    const conf = await postJson(entrandoComo("duena"), `/cotizaciones/${id}/confirmar`, {});
    expect(conf.cuerpo.codigo).toBe("sin_stock");
    expect(String(conf.cuerpo.mensaje)).toContain("NAT-M");

    const leida = await pedir(entrandoComo("duena"), `/pedidos/${id}`);
    expect((leida.cuerpo.datos as { estado: string }).estado).toBe("cotizacion");
  });

  it("la contadora no la confirma", async () => {
    const hecha = await hacerla("duena");
    const { id } = hecha.cuerpo.datos as { id: string };
    const conf = await postJson(entrandoComo("contadora"), `/cotizaciones/${id}/confirmar`, {});
    expect(conf.estado).toBe(403);
  });

  it("confirmar algo que no existe es 404", async () => {
    const r = await postJson(entrandoComo("duena"), "/cotizaciones/no-existe/confirmar", {});
    expect(r.estado).toBe(404);
  });
});

describe("POST /pedidos/:id/cancelar, sobre una cotización", () => {
  it("se cancela por la ruta que ya existía, y no libera nada", async () => {
    const hecha = await hacerla("duena");
    const { id } = hecha.cuerpo.datos as { id: string };

    const r = await postJson(entrandoComo("duena"), `/pedidos/${id}/cancelar`, {
      motivo: "la clienta no la aceptó",
    });
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);
    expect((r.cuerpo.datos as { liberadas: number }).liberadas).toBe(0);
    expect(await libres()).toBe(30);

    const leida = await pedir(entrandoComo("duena"), `/pedidos/${id}`);
    expect((leida.cuerpo.datos as { estado: string }).estado).toBe("cancelado");
  });

  it("y sigue pidiendo motivo, igual que un pedido", async () => {
    const hecha = await hacerla("duena");
    const { id } = hecha.cuerpo.datos as { id: string };
    const r = await postJson(entrandoComo("duena"), `/pedidos/${id}/cancelar`, {});
    expect(r.estado).toBe(400);
  });
});

/**
 * `GET /checkout`: el interruptor que no se consultaba.
 *
 * `ajustes.checkout_activo` valía `true` en producción y ningún código lo
 * leía (docs/TRAMPAS.md §13). Esta ruta es quien lo lee, así que una prueba
 * que la llame es lo que impide volver al estado anterior.
 */
describe("GET /checkout", () => {
  it("contesta si la web cobra y, cuando no, por qué", async () => {
    const r = await pedir(entrandoComo("duena"), "/checkout");
    expect(r.estado).toBe(200);
    const d = r.cuerpo.datos as { cobra: boolean; impedimentos: string[]; resumen: string };
    expect(d.cobra).toBe(false);
    expect(d.impedimentos.length).toBeGreaterThan(0);
    expect(typeof d.resumen).toBe("string");
  });

  it("encender el interruptor NO hace que diga que cobra: lo marca inerte", async () => {
    // El caso exacto de producción, y el motivo de todo este cambio.
    const puesta = await postJson(entrandoComo("duena"), "/ajustes/checkout_activo", {
      valor: true,
      motivo: "la dueña quiere cobrar en la web",
    });
    expect(puesta.estado, JSON.stringify(puesta.cuerpo)).toBe(200);

    const r = await pedir(entrandoComo("duena"), "/checkout");
    const d = r.cuerpo.datos as {
      interruptor: boolean;
      cobra: boolean;
      inerte: boolean;
      resumen: string;
    };
    expect(d.interruptor).toBe(true);
    expect(d.cobra).toBe(false);
    expect(d.inerte).toBe(true);
    expect(d.resumen).toContain("sin efecto");
  });

  it("no la abre quien no tiene ajustes", async () => {
    expect((await pedir(entrandoComo("asistente"), "/checkout")).estado).toBe(403);
    expect((await pedir(entrandoComo("contadora"), "/checkout")).estado).toBe(403);
  });

  it("nunca devuelve una credencial, ni su nombre técnico", async () => {
    const r = await pedir(entrandoComo("duena"), "/checkout");
    const texto = JSON.stringify(r.cuerpo);
    for (const palabra of ["secreto", "clave_secreta", "client_secret", "password", "apiuser"]) {
      expect(texto, `el checkout menciona ${palabra}`).not.toContain(palabra);
    }
  });
});
