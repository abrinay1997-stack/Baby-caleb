import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido, enunciadosDeApartado, type ContextoPedido } from "../src/db/pedidos";
import {
  cancelar,
  confirmarCotizacion,
  type ContextoTransicion,
} from "../src/db/transiciones";

/**
 * Cotizaciones: el mismo documento antes de apartar nada.
 *
 * Lo que estas pruebas vigilan, y es UNA cosa: **`existencias.reservado` no se
 * mueve mientras el documento sea una cotización, y sí se mueve exactamente al
 * confirmarla.** Todo lo demás —el número, los precios, la bitácora— es
 * consecuencia de que sea el mismo documento.
 *
 * El fallo que buscan es el que no se ve: una cotización que apartara stock
 * dejaría mercancía bloqueada por un presupuesto que nadie aceptó, y eso solo
 * se descubre contando cajas. Al revés, una confirmación que NO apartara
 * dejaría dos pedidos vendiendo la misma caja.
 */

let clienteId: string;
let bodegaId: string;
let n = 0;
const ahora = () => Date.now();

const ctxT = (): ContextoTransicion => ({ db: env.DB, ahora: ahora(), actor: "pruebas" });
const ctxP = (sobre: Partial<ContextoPedido> = {}): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: "pruebas",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
  ...sobre,
});

/** Lo apartado de NAT-M en todas las bodegas. */
const reservadas = async (codigo = "NAT-M"): Promise<number> =>
  (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(reservado),0) AS r FROM existencias WHERE codigo = ?",
    )
      .bind(codigo)
      .first<{ r: number }>()
  )?.r ?? -1;

const estadoDe = async (id: string) =>
  await env.DB.prepare("SELECT estado, estado_pago, vence_en, total_cents FROM pedidos WHERE id = ?")
    .bind(id)
    .first<{ estado: string; estado_pago: string; vence_en: number | null; total_cents: number }>();

const componentesDe = async (pedidoId: string): Promise<number> =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id
        WHERE pl.pedido_id = ?`,
    )
      .bind(pedidoId)
      .first<{ n: number }>()
  )?.n ?? -1;

beforeEach(async () => {
  clienteId = `cli-${Date.now()}-${n++}`;
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, "Ana", ahora(), ahora())
    .run();

  const b = await env.DB.prepare("SELECT id FROM bodegas WHERE activa = 1 LIMIT 1").first<{
    id: string;
  }>();
  bodegaId = b!.id;

  await env.DB.batch([
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare("UPDATE existencias SET fisico = 20 WHERE codigo = 'NAT-M' AND bodega_id = ?").bind(
      bodegaId,
    ),
  ]);
});

/** Una cotización de una caja de NAT-M. */
async function unaCotizacion(sobre: Partial<ContextoPedido> = {}) {
  const r = await crearPedido(ctxP(sobre), {
    idempotencia: `idem-${Date.now()}-${n++}`,
    clienteId,
    origen: "panel",
    cotizacion: true,
    lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  });
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

describe("una cotización NO aparta stock", () => {
  it("se crea sin tocar lo reservado", async () => {
    expect(await reservadas()).toBe(0);
    const c = await unaCotizacion();
    expect(c.estado).toBe("cotizacion");
    expect(c.aparto).toBe(false);
    // Lo esencial del encargo, en una línea.
    expect(await reservadas()).toBe(0);
  });

  it("y tampoco escribe en pedido_linea_componentes, que es la tabla de lo apartado", async () => {
    const c = await unaCotizacion();
    expect(await componentesDe(c.id)).toBe(0);
  });

  it("veinte cotizaciones por las veinte cajas no agotan nada", async () => {
    // Es el caso que justifica todo: si cotizar apartara, el vigésimo
    // presupuesto fallaría por falta de existencias que nadie compró.
    for (let i = 0; i < 20; i += 1) await unaCotizacion();
    expect(await reservadas()).toBe(0);
  });

  it("se puede cotizar incluso lo que está agotado", async () => {
    // Cotizar es decir un precio, no apartar mercancía. Negarse aquí es
    // negarse justo cuando la clienta pregunta si lo van a traer.
    await env.DB.prepare("UPDATE existencias SET fisico = 0 WHERE codigo = 'NAT-M'").run();
    const c = await unaCotizacion();
    expect(c.estado).toBe("cotizacion");
    expect(await reservadas()).toBe(0);
  });

  it("un pedido normal SÍ aparta: la diferencia es la bandera, no otra función", async () => {
    // El contrapeso. Sin esto, `reservadas() === 0` podría estar pasando
    // porque la reserva se rompió para todos, no porque la cotización no
    // reserve.
    const r = await crearPedido(ctxP(), {
      idempotencia: `idem-${Date.now()}-${n++}`,
      clienteId,
      origen: "panel",
      lineas: [{ codigo: "NAT-M", cantidad: 3 }],
    });
    if (!r.ok) throw new Error(r.mensaje);
    expect(r.datos.estado).toBe("por_abonar");
    expect(r.datos.aparto).toBe(true);
    expect(await reservadas()).toBe(3);
  });
});

describe("los precios son del servidor, y son los mismos al confirmar", () => {
  it("la cotización lleva el total que calculó el servidor", async () => {
    const c = await unaCotizacion();
    const fila = await estadoDe(c.id);
    expect(fila?.total_cents).toBe(c.totalCents);
    expect(c.totalCents).toBeGreaterThan(0);
  });

  it("confirmarla NO recalcula el total, aunque el catálogo haya subido", async () => {
    // Es lo que distingue una cotización de un presupuesto informal: el precio
    // que se le pasó por escrito es el que se le cobra. Volver a calcularlo al
    // confirmar sería no haber cotizado.
    const c = await unaCotizacion();
    await env.DB.prepare("UPDATE variantes SET precio_cents = precio_cents * 2 WHERE codigo = 'NAT-M'")
      .run();

    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);

    const fila = await estadoDe(c.id);
    expect(fila?.total_cents).toBe(c.totalCents);
  });
});

describe("confirmar es la transición a por_abonar, y AHÍ se aparta", () => {
  it("el documento cambia de estado y el stock se aparta, en el mismo acto", async () => {
    const c = await unaCotizacion();
    expect(await reservadas()).toBe(0);

    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);
    if (r.ok) expect(r.datos.numero).toBe(c.numero);

    expect((await estadoDe(c.id))?.estado).toBe("por_abonar");
    expect(await reservadas()).toBe(1);
    expect(await componentesDe(c.id)).toBe(1);
  });

  it("es el MISMO documento: mismo id y mismo número", async () => {
    const c = await unaCotizacion();
    await confirmarCotizacion(ctxT(), c.id);
    const fila = await env.DB.prepare("SELECT numero FROM pedidos WHERE id = ?")
      .bind(c.id)
      .first<{ numero: string }>();
    expect(fila?.numero).toBe(c.numero);
    // Y no se creó otro documento al confirmar.
    const cuantos = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE numero = ?")
      .bind(c.numero)
      .first<{ n: number }>();
    expect(cuantos?.n).toBe(1);
  });

  it("la bitácora cuenta el recorrido entero", async () => {
    const c = await unaCotizacion();
    await confirmarCotizacion(ctxT(), c.id, "la clienta aceptó por WhatsApp");

    const { results } = await env.DB.prepare(
      "SELECT tipo, de, a, datos_json FROM pedido_eventos WHERE pedido_id = ? ORDER BY creado_en, id",
    )
      .bind(c.id)
      .all<{ tipo: string; de: string | null; a: string; datos_json: string | null }>();

    expect(results.map((r) => `${r.de ?? "-"}->${r.a}`)).toEqual([
      "-->cotizacion",
      "cotizacion->por_abonar",
    ]);
    // El motivo se GUARDA, no se pide para tirarlo.
    expect(results[1]!.datos_json).toContain("la clienta aceptó por WhatsApp");
  });

  it("no se confirma dos veces: la segunda lo dice y no aparta otra vez", async () => {
    const c = await unaCotizacion();
    expect((await confirmarCotizacion(ctxT(), c.id)).ok).toBe(true);
    expect(await reservadas()).toBe(1);

    const otra = await confirmarCotizacion(ctxT(), c.id);
    expect(otra.ok).toBe(false);
    if (!otra.ok) {
      expect(otra.codigo).toBe("transicion_invalida");
      expect(otra.mensaje).toContain("ya se confirmó");
    }
    // Y lo apartado sigue siendo uno, no dos.
    expect(await reservadas()).toBe(1);
  });

  it("un pedido que ya no es cotización no se confirma, y el mensaje lo distingue", async () => {
    const r = await crearPedido(ctxP(), {
      idempotencia: `idem-${Date.now()}-${n++}`,
      clienteId,
      origen: "panel",
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
    });
    if (!r.ok) throw new Error(r.mensaje);
    const otra = await confirmarCotizacion(ctxT(), r.datos.id);
    expect(otra.ok).toBe(false);
    // `por_abonar` cae en «ya se confirmó», que es la verdad: el documento ya
    // está donde lo dejaría una confirmación.
    if (!otra.ok) expect(otra.mensaje).toContain("ya se confirmó");
  });

  it("un documento que no existe se dice, no se revienta", async () => {
    const r = await confirmarCotizacion(ctxT(), "no-existe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});

describe("si al confirmar ya no hay existencias", () => {
  it("se dice claramente, nombrando el artículo, y NO pasa a pedido", async () => {
    const c = await unaCotizacion();
    // Entre cotizar y confirmar se vendió todo.
    await env.DB.prepare("UPDATE existencias SET fisico = 0 WHERE codigo = 'NAT-M'").run();

    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("sin_stock");
      expect(r.mensaje).toContain("NAT-M");
      expect(r.mensaje).toContain("sigue siendo cotización");
    }

    // Lo que de verdad importa: el documento quedó intacto.
    expect((await estadoDe(c.id))?.estado).toBe("cotizacion");
    expect(await reservadas()).toBe(0);
    expect(await componentesDe(c.id)).toBe(0);
  });

  it("y se puede confirmar más tarde, cuando llegue mercancía", async () => {
    const c = await unaCotizacion();
    await env.DB.prepare("UPDATE existencias SET fisico = 0 WHERE codigo = 'NAT-M'").run();
    expect((await confirmarCotizacion(ctxT(), c.id)).ok).toBe(false);

    await env.DB.prepare("UPDATE existencias SET fisico = 5 WHERE codigo = 'NAT-M' AND bodega_id = ?")
      .bind(bodegaId)
      .run();
    expect((await confirmarCotizacion(ctxT(), c.id)).ok).toBe(true);
    expect(await reservadas()).toBe(1);
  });

  it("alcanza para una caja y no para tres: la de tres no se confirma", async () => {
    const r = await crearPedido(ctxP(), {
      idempotencia: `idem-${Date.now()}-${n++}`,
      clienteId,
      origen: "panel",
      cotizacion: true,
      lineas: [{ codigo: "NAT-M", cantidad: 3 }],
    });
    if (!r.ok) throw new Error(r.mensaje);

    await env.DB.prepare("UPDATE existencias SET fisico = 2 WHERE codigo = 'NAT-M'").run();
    const conf = await confirmarCotizacion(ctxT(), r.datos.id);
    expect(conf.ok).toBe(false);
    if (!conf.ok) expect(conf.codigo).toBe("sin_stock");
    expect(await reservadas()).toBe(0);
  });
});

describe("caducar y cancelar: sin tocar los libros", () => {
  it("una cotización caducada no se confirma", async () => {
    // Se crea con un minuto de validez y se mira desde el futuro.
    const c = await unaCotizacion({ minutosDeValidezCotizacion: 1 });
    expect(c.venceEn).not.toBeNull();

    const r = await confirmarCotizacion(
      { db: env.DB, ahora: c.venceEn! + 1, actor: "pruebas" },
      c.id,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain("caducó");
    expect((await estadoDe(c.id))?.estado).toBe("cotizacion");
    expect(await reservadas()).toBe(0);
  });

  it("sin decidir los días de validez, no caduca sola", async () => {
    // `cotizacion_dias_validez` nace PENDIENTE y PENDIENTE no es un número
    // inventado: sin decidirlo, la cotización no se vence.
    const c = await unaCotizacion({ minutosDeValidezCotizacion: null });
    expect(c.venceEn).toBeNull();
    const r = await confirmarCotizacion(
      { db: env.DB, ahora: Date.now() + 365 * 24 * 3600_000, actor: "pruebas" },
      c.id,
    );
    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);
  });

  it("cancelarla no libera nada, porque no había nada apartado", async () => {
    const c = await unaCotizacion();
    const r = await cancelar(ctxT(), c.id, "la clienta no la aceptó");
    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);
    if (r.ok) expect(r.datos.liberadas).toBe(0);
    expect((await estadoDe(c.id))?.estado).toBe("cancelado");
    expect(await reservadas()).toBe(0);
  });

  it("y no deja ni un asiento contable: no hubo hecho económico", async () => {
    const antes = await env.DB.prepare("SELECT COUNT(*) AS n FROM asientos").first<{ n: number }>();

    const c = await unaCotizacion();
    await confirmarCotizacion(ctxT(), c.id);
    const otra = await unaCotizacion();
    await cancelar(ctxT(), otra.id, "se arrepintió");

    const despues = await env.DB.prepare("SELECT COUNT(*) AS n FROM asientos").first<{ n: number }>();
    // Ni crear, ni confirmar, ni cancelar una cotización escriben en los
    // libros. La venta se sigue reconociendo al entregar.
    expect(despues?.n).toBe(antes?.n);
  });

  it("una cotización cancelada ya no se confirma", async () => {
    const c = await unaCotizacion();
    await cancelar(ctxT(), c.id, "x");
    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain("no es una cotización");
  });
});

describe("la bodega se vuelve a elegir al confirmar", () => {
  it("si la de la cotización se quedó vacía, se aparta en la que sí tiene", async () => {
    // La bodega anotada al cotizar es PROVISIONAL: cotizar no exige
    // existencias, así que puede haberse elegido una que no tenía nada. Lo que
    // manda es dónde hay mercancía el día que se confirma.
    const otra = `bod-otra-${Date.now()}-${n++}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(
        otra,
        `Bodega de repuesto ${otra}`,
      ),
      env.DB.prepare("INSERT INTO existencias (codigo,bodega_id,fisico) VALUES ('NAT-M',?,0)").bind(
        otra,
      ),
    ]);

    const c = await unaCotizacion();
    const antes = await env.DB.prepare(
      "SELECT bodega_id FROM pedido_lineas WHERE pedido_id = ?",
    )
      .bind(c.id)
      .first<{ bodega_id: string }>();

    // Se vacía la bodega donde quedó anotada y se llena la otra.
    await env.DB.batch([
      env.DB.prepare("UPDATE existencias SET fisico = 0 WHERE codigo = 'NAT-M' AND bodega_id = ?")
        .bind(antes!.bodega_id),
      env.DB.prepare("UPDATE existencias SET fisico = 9 WHERE codigo = 'NAT-M' AND bodega_id = ?")
        .bind(otra),
    ]);

    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);

    // La línea quedó corregida, y lo apartado está donde de verdad hay.
    const despues = await env.DB.prepare("SELECT bodega_id FROM pedido_lineas WHERE pedido_id = ?")
      .bind(c.id)
      .first<{ bodega_id: string }>();
    expect(despues?.bodega_id).toBe(otra);

    const apartado = await env.DB.prepare(
      `SELECT plc.bodega_id FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id WHERE pl.pedido_id = ?`,
    )
      .bind(c.id)
      .first<{ bodega_id: string }>();
    expect(apartado?.bodega_id).toBe(otra);

    const reservadoAlli = await env.DB.prepare(
      "SELECT reservado FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = ?",
    )
      .bind(otra)
      .first<{ reservado: number }>();
    expect(reservadoAlli?.reservado).toBe(1);
  });
});

describe("una cotización con inventario apartado es un dato roto", () => {
  it("no se confirma, y lo dice con su propia causa en vez de «sin stock»", async () => {
    // Una cotización no puede tener nada en `pedido_linea_componentes`. Si lo
    // tuviera —por un dato metido a mano, o por un fallo futuro— confirmarla
    // apartaría el doble y al cancelar se devolvería de menos. La guarda está
    // ANTES de escribir, y es una guarda y no una fila de control: un control
    // que comprobara esto estaría comprobando algo que ya era cierto antes del
    // batch, o sea pasando siempre (docs/TRAMPAS.md §1).
    const c = await unaCotizacion();
    const linea = await env.DB.prepare("SELECT id, bodega_id FROM pedido_lineas WHERE pedido_id = ?")
      .bind(c.id)
      .first<{ id: string; bodega_id: string }>();

    await env.DB.prepare(
      "INSERT INTO pedido_linea_componentes (linea_id,codigo,bodega_id,cantidad) VALUES (?,?,?,1)",
    )
      .bind(linea!.id, "NAT-M", linea!.bodega_id)
      .run();

    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("interno");
      expect(r.mensaje).toContain("inventario apartado");
    }
    // Y no se apartó nada por el camino.
    expect(await reservadas()).toBe(0);
    expect((await estadoDe(c.id))?.estado).toBe("cotizacion");
  });
});

describe("apartar dos veces lo mismo no se puede", () => {
  it("la llave de pedido_linea_componentes tumba el segundo apartado", async () => {
    /**
     * Esta es la defensa que impide que dos confirmaciones a la vez aparten
     * el doble, y se prueba AQUÍ, en la capa de abajo, a propósito.
     *
     * Desde `confirmarCotizacion` no se llega: la guarda de «ya tiene
     * inventario apartado» corta antes, así que una prueba por arriba pasaría
     * sin tocar nunca esta defensa y diría que está vigilada sin estarlo
     * (docs/TRAMPAS.md §6).
     *
     * Y la fila de control de la transición tampoco sirve para esto:
     * comprueba que el pedido esté en `por_abonar`, lo cual es cierto aunque
     * lo haya puesto el OTRO batch. Lo que de verdad frena es la llave
     * primaria `(linea_id, codigo, bodega_id)`.
     */
    const c = await unaCotizacion();
    const linea = await env.DB.prepare("SELECT id, bodega_id FROM pedido_lineas WHERE pedido_id = ?")
      .bind(c.id)
      .first<{ id: string; bodega_id: string }>();

    const apartado = {
      lineaId: linea!.id,
      codigo: "NAT-M",
      bodegaId: linea!.bodega_id,
      cantidad: 1,
    };
    const ctx = { db: env.DB, ahora: Date.now() };

    await env.DB.batch(enunciadosDeApartado(ctx, apartado));
    expect(await reservadas()).toBe(1);

    // El segundo, idéntico: revienta contra la llave primaria y se lleva su
    // propio `reservado` por delante.
    await expect(env.DB.batch(enunciadosDeApartado(ctx, apartado))).rejects.toThrow();
    expect(await reservadas(), "el segundo apartado no debería haber entrado").toBe(1);
  });
});

describe("la carrera: confirmar mientras otro se lleva el stock", () => {
  it("si el batch se cae, la cotización queda intacta", async () => {
    // Se simula la carrera dejando las existencias sin fila para esa bodega
    // entre la lectura y la escritura: el UPDATE de `reservado` no casa con
    // nada, la fila de control sale 0 y el batch entero se cae.
    const c = await unaCotizacion();
    await env.DB.prepare("DELETE FROM existencias WHERE codigo = 'NAT-M'").run();

    const r = await confirmarCotizacion(ctxT(), c.id);
    expect(r.ok).toBe(false);

    // Ni el estado cambió ni se escribió el apartado: todo o nada.
    expect((await estadoDe(c.id))?.estado).toBe("cotizacion");
    expect(await componentesDe(c.id)).toBe(0);
    const eventos = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pedido_eventos WHERE pedido_id = ? AND tipo = 'transicion'",
    )
      .bind(c.id)
      .first<{ n: number }>();
    expect(eventos?.n).toBe(0);
  });
});
