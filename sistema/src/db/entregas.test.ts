import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { token, ulid } from "../ids";
import { crearPedido } from "./pedidos";
import { agendar } from "./transiciones";
import {
  type ContextoEntrega,
  ajustesDeEntrega,
  armarRuta,
  cancelarRuta,
  cerrarRuta,
  crearEnvio,
  despacharRuta,
  devolverParada,
  entregasDelDia,
  fechaDePanama,
  marcarEntregada,
  marcarFallida,
  sugerirParaEnvio,
} from "./entregas";

/**
 * Las entregas, contra una D1 de verdad (F4.5).
 *
 * Estas pruebas no comprueban que el SQL esté bien escrito: comprueban que la
 * base HACE CUMPLIR lo que el diseño da por sentado, y que las operaciones
 * aguantan lo que pasa de verdad en la calle — mala señal, dos toques del mismo
 * botón, dos personas mirando la misma pantalla.
 *
 * Cada prueba se validó rompiendo el código a propósito y mirando que se
 * pusiera roja. Lo que una prueba vigila está escrito junto a ella cuando no es
 * obvio; si una pasa con el código roto, no vigila nada.
 *
 * Este runner NO aísla el almacenamiento entre pruebas del mismo archivo, y los
 * libros (movimientos, bitácoras) no se pueden borrar para limpiar —el trigger
 * lo prohíbe, que es justo lo que se quiere—. Así que todo lo que se siembra
 * lleva un identificador propio y ninguna prueba depende del estado que dejó
 * otra.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;
const codigoNuevo = () => id("PZ").toUpperCase();

const ctx = (): ContextoEntrega => ({ db: env.DB, ahora: ahora(), actor: "yarielis@babycaleb.com" });

let productoId: string;
let bodegaId: string;
let bodega: string;
let zonaId: string;
let zona: string;

beforeEach(async () => {
  productoId = id("prod");
  bodegaId = id("bod");
  bodega = `Bodega ${bodegaId}`;
  zonaId = id("zon");
  zona = `Zona ${zonaId}`;

  await env.DB.batch([
    env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
      productoId, "panal", "Para entregas", id("slug"), ahora(),
    ),
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(bodegaId, bodega),
    env.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,region,metodo,tarifa_cents,actualizado_en)
       VALUES (?,?,'ciudad','motorizado',500,?)`,
    ).bind(zonaId, zona, ahora()),
  ]);
});

/** Un motorizado nuevo por prueba: una ruta por día y por motorizado. */
async function motorizadoNuevo(estado = "activo"): Promise<{ id: string; nombre: string }> {
  const mid = id("mot");
  await env.DB.prepare(
    "INSERT INTO motorizados (id,nombre,celular_e164,estado,vehiculo,pin_fallos,creado_en) VALUES (?,?,?,?,'moto',0,?)",
  )
    .bind(mid, `Motorizado ${mid}`, `507${String(ahora()).slice(-7)}${n++}`, estado, ahora())
    .run();
  return { id: mid, nombre: `Motorizado ${mid}` };
}

async function variante(fisico: number, precio = 5000): Promise<string> {
  const codigo = codigoNuevo();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en) VALUES (?,?,?,1,?,1,1,1,?)`,
    ).bind(codigo, productoId, `pieza ${codigo}`, precio, ahora()),
    env.DB.prepare("INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)").bind(
      codigo, bodegaId, fisico,
    ),
  ]);
  return codigo;
}

interface Escenario {
  pedidoId: string;
  numero: string;
  codigo: string;
  clienteId: string;
  direccionId: string | null;
  totalCents: number;
  cantidad: number;
}

/**
 * Un pedido agendado, con su mercancía apartada.
 *
 * El abono se escribe directo y después se agenda con la función de verdad: lo
 * que estas pruebas vigilan es la entrega, y pasar por el flujo de pagos
 * entero metería en cada prueba un segundo sistema que ya tiene las suyas.
 */
async function pedidoAgendado(
  opts: { cantidad?: number; fisico?: number; punto?: { lat: number; lng: number } | null; pagar?: "abono" | "todo" } = {},
): Promise<Escenario> {
  const cantidad = opts.cantidad ?? 2;
  const codigo = await variante(opts.fisico ?? 50);
  const clienteId = id("cli");

  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, `Clienta ${clienteId}`, ahora(), ahora())
    .run();

  let direccionId: string | null = null;
  if (opts.punto !== null) {
    direccionId = id("dir");
    const p = opts.punto ?? { lat: 8.9824, lng: -79.5199 };
    await env.DB.prepare(
      `INSERT INTO direcciones (id,cliente_id,zona_id,texto,lat,lng,precision,creado_en)
       VALUES (?,?,?,?,?,?,'pin',?)`,
    )
      .bind(direccionId, clienteId, zonaId, `Casa de ${clienteId}`, p.lat, p.lng, ahora())
      .run();
  }

  const r = await crearPedido(
    { db: env.DB, ahora: ahora(), actor: "prueba", abonoMinimoCents: 500, minutosParaAbonar: null },
    {
      idempotencia: id("idem"),
      clienteId,
      origen: "web",
      lineas: [{ codigo, cantidad, bodega }],
      zona,
      ...(direccionId === null ? {} : { direccionId }),
    },
  );
  if (!r.ok) throw new Error(`no se pudo crear el pedido: ${r.mensaje}`);

  const pagado = opts.pagar === "todo" ? r.datos.totalCents : 500;
  await env.DB.prepare("UPDATE pedidos SET pagado_cents = ?, estado_pago = ? WHERE id = ?")
    .bind(pagado, opts.pagar === "todo" ? "pagado" : "abonado", r.datos.id)
    .run();

  const a = await agendar({ db: env.DB, ahora: ahora(), actor: "prueba" }, r.datos.id);
  if (!a.ok) throw new Error(`no se pudo agendar: ${a.mensaje}`);

  return {
    pedidoId: r.datos.id,
    numero: r.datos.numero,
    codigo,
    clienteId,
    direccionId,
    totalCents: r.datos.totalCents,
    cantidad,
  };
}

/** Un pedido y su entrega lista, sin ruta todavía. */
async function conEnvio(opts: Parameters<typeof pedidoAgendado>[0] = {}) {
  const e = await pedidoAgendado(opts);
  const r = await crearEnvio(ctx(), { pedidoId: e.pedidoId });
  if (!r.ok) throw new Error(`no se pudo crear el envío: ${r.mensaje}`);
  return { ...e, envioId: r.datos.envioId, cobroCents: r.datos.cobroCents };
}

/** El camino entero hasta tener una parada en la calle. */
async function enLaCalle(opts: Parameters<typeof pedidoAgendado>[0] = {}) {
  const e = await conEnvio(opts);
  const m = await motorizadoNuevo();
  const ruta = await armarRuta(ctx(), {
    motorizadoId: m.id,
    bodegaId,
    envioIds: [e.envioId],
    origen: { lat: 8.98, lng: -79.52 },
  });
  if (!ruta.ok) throw new Error(`no se pudo armar la ruta: ${ruta.mensaje}`);
  const salida = await despacharRuta(ctx(), ruta.datos.rutaId);
  if (!salida.ok) throw new Error(`no salió la ruta: ${salida.mensaje}`);
  return { ...e, motorizado: m, rutaId: ruta.datos.rutaId };
}

const leerEnvio = (envioId: string) =>
  env.DB.prepare(
    "SELECT estado, entregado_en, cobro_cents, cobrado_cents, cobro_metodo, foto_r2, ruta_id, orden_ruta, motorizado_id, version FROM envios WHERE id = ?",
  )
    .bind(envioId)
    .first<{
      estado: string;
      entregado_en: number | null;
      cobro_cents: number;
      cobrado_cents: number;
      cobro_metodo: string | null;
      foto_r2: string | null;
      ruta_id: string | null;
      orden_ruta: number | null;
      motorizado_id: string | null;
      version: number;
    }>();

const leerPedido = (pedidoId: string) =>
  env.DB.prepare("SELECT estado, estado_pago, pagado_cents, total_cents FROM pedidos WHERE id = ?")
    .bind(pedidoId)
    .first<{ estado: string; estado_pago: string; pagado_cents: number; total_cents: number }>();

const existencias = (codigo: string) =>
  env.DB.prepare("SELECT fisico, reservado FROM existencias WHERE codigo = ? AND bodega_id = ?")
    .bind(codigo, bodegaId)
    .first<{ fisico: number; reservado: number }>();

const pagosDe = (pedidoId: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(monto_cents),0) AS suma FROM pagos WHERE pedido_id = ?",
  )
    .bind(pedidoId)
    .first<{ n: number; suma: number }>();

/** Un pedido pelado, solo para probar lo que el esquema impide. */
async function pedidoCrudo(): Promise<string> {
  const clienteId = id("cli");
  const pedidoId = ulid(ahora());
  await env.DB.batch([
    env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)").bind(
      clienteId, "Cruda", ahora(), ahora(),
    ),
    env.DB.prepare(
      `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
         subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
         abono_minimo_cents,creado_en,actualizado_en)
       VALUES (?,?,?,?,'panel','agendado','sin_pago',1000,0,0,0,1000,0,500,?,?)`,
    ).bind(pedidoId, id("BC"), token(), clienteId, ahora(), ahora()),
  ]);
  return pedidoId;
}

async function rutaCruda(motorizadoId: string, estado: string, fecha = fechaDePanama(ahora())) {
  const rutaId = ulid(ahora());
  await env.DB.prepare(
    `INSERT INTO rutas (id,fecha,motorizado_id,bodega_id,estado,salio_en,cerrada_en,creada_por,creada_en)
     VALUES (?,?,?,?,?,?,?,'prueba',?)`,
  )
    .bind(
      rutaId, fecha, motorizadoId, bodegaId, estado,
      estado === "en_curso" || estado === "cerrada" ? ahora() : null,
      estado === "cerrada" ? ahora() : null,
      ahora(),
    )
    .run();
  return rutaId;
}

async function envioCrudo(
  pedidoId: string,
  estado: string,
  extra: {
    rutaId?: string;
    orden?: number;
    motorizadoId?: string;
    entregadoEn?: number;
    cobro?: number;
    cobrado?: number;
    metodo?: string;
  } = {},
) {
  const envioId = ulid(ahora());
  await env.DB.prepare(
    `INSERT INTO envios (id,pedido_id,estado,metodo,motorizado_id,bodega_id,guia_token,
       ruta_id,orden_ruta,programado_para,cobro_cents,cobrado_cents,cobro_metodo,entregado_en,creado_en)
     VALUES (?,?,?,'motorizado',?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      envioId, pedidoId, estado, extra.motorizadoId ?? null, bodegaId, token(),
      extra.rutaId ?? null, extra.rutaId === undefined ? null : (extra.orden ?? 1),
      fechaDePanama(ahora()), extra.cobro ?? 0, extra.cobrado ?? 0,
      extra.metodo ?? null, extra.entregadoEn ?? null, ahora(),
    )
    .run();
  return envioId;
}

// ===========================================================================
// Lo que el esquema hace IMPOSIBLE
// ===========================================================================

describe("una entrega cerrada no se reabre", () => {
  it("de «entregado» no se vuelve a «en ruta»", async () => {
    const p = await pedidoCrudo();
    const e = await envioCrudo(p, "entregado", { entregadoEn: ahora() });

    // Sin el trigger, esto pasaría: el stock ya salió y el cobro ya entró, y
    // volver atrás no desanda nada de eso — solo hace que la base deje de
    // coincidir con el mundo.
    await expect(
      env.DB.prepare("UPDATE envios SET estado = 'en_ruta' WHERE id = ?").bind(e).run(),
    ).rejects.toThrow(/no cambia de estado/i);
  });

  it("ni «devuelto» ni «anulado» vuelven", async () => {
    const d = await envioCrudo(await pedidoCrudo(), "devuelto");
    const a = await envioCrudo(await pedidoCrudo(), "anulado");
    await expect(
      env.DB.prepare("UPDATE envios SET estado = 'pendiente' WHERE id = ?").bind(d).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE envios SET estado = 'pendiente' WHERE id = ?").bind(a).run(),
    ).rejects.toThrow();
  });
});

describe("no se marca en la calle lo que no salió de la bodega", () => {
  it("una parada de una ruta en borrador no se puede entregar", async () => {
    const m = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "borrador");
    const e = await envioCrudo(await pedidoCrudo(), "asignado", { rutaId: ruta, motorizadoId: m.id });

    await expect(
      env.DB.prepare("UPDATE envios SET estado = 'recogido' WHERE id = ?").bind(e).run(),
    ).rejects.toThrow(/no ha salido de la bodega/i);
    await expect(
      env.DB.prepare(
        "UPDATE envios SET estado = 'entregado', entregado_en = ? WHERE id = ?",
      ).bind(ahora(), e).run(),
    ).rejects.toThrow(/no ha salido de la bodega/i);
  });

  it("y si la ruta ya salió, sí", async () => {
    const m = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "en_curso");
    const e = await envioCrudo(await pedidoCrudo(), "asignado", { rutaId: ruta, motorizadoId: m.id });

    await env.DB.prepare("UPDATE envios SET estado = 'recogido' WHERE id = ?").bind(e).run();
    expect((await leerEnvio(e))?.estado).toBe("recogido");
  });
});

describe("una parada en la calle no se reescribe", () => {
  it("no se cambia de ruta", async () => {
    const m = await motorizadoNuevo();
    const uno = await rutaCruda(m.id, "en_curso");
    const otro = await motorizadoNuevo();
    const dos = await rutaCruda(otro.id, "en_curso");
    const e = await envioCrudo(await pedidoCrudo(), "en_ruta", { rutaId: uno, motorizadoId: m.id });

    // Moverla reescribiría quién la llevó, y eso es lo que la entrega de ayer
    // tiene que seguir diciendo.
    await expect(
      env.DB.prepare("UPDATE envios SET ruta_id = ?, motorizado_id = ? WHERE id = ?")
        .bind(dos, otro.id, e)
        .run(),
    ).rejects.toThrow(/ya salió/i);
  });

  it("pero una asignada sí se mueve: repartir antes de salir es normal", async () => {
    const m = await motorizadoNuevo();
    const uno = await rutaCruda(m.id, "borrador");
    const otro = await motorizadoNuevo();
    const dos = await rutaCruda(otro.id, "borrador");
    const e = await envioCrudo(await pedidoCrudo(), "asignado", { rutaId: uno, motorizadoId: m.id });

    await env.DB.prepare("UPDATE envios SET ruta_id = ?, motorizado_id = ?, orden_ruta = 1 WHERE id = ?")
      .bind(dos, otro.id, e)
      .run();
    expect((await leerEnvio(e))?.ruta_id).toBe(dos);
  });
});

describe("la parada lleva el motorizado de su ruta", () => {
  it("no se le puede poner otro", async () => {
    const m = await motorizadoNuevo();
    const otro = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "borrador");
    const e = await envioCrudo(await pedidoCrudo(), "pendiente");

    // Sin esto, el panel diría que la lleva uno y la lista del teléfono del
    // otro la mostraría igual.
    await expect(
      env.DB.prepare("UPDATE envios SET ruta_id = ?, orden_ruta = 1, motorizado_id = ? WHERE id = ?")
        .bind(ruta, otro.id, e)
        .run(),
    ).rejects.toThrow(/motorizado de su ruta/i);
  });

  it("tampoco al insertarla", async () => {
    const m = await motorizadoNuevo();
    const otro = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "borrador");
    await expect(
      envioCrudo(await pedidoCrudo(), "asignado", { rutaId: ruta, motorizadoId: otro.id }),
    ).rejects.toThrow(/motorizado de su ruta/i);
  });

  it("y la ruta no cambia de motorizado si ya tiene paradas", async () => {
    const m = await motorizadoNuevo();
    const otro = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "en_curso");
    await envioCrudo(await pedidoCrudo(), "en_ruta", { rutaId: ruta, motorizadoId: m.id });

    await expect(
      env.DB.prepare("UPDATE rutas SET motorizado_id = ? WHERE id = ?").bind(otro.id, ruta).run(),
    ).rejects.toThrow(/quítelas antes/i);
  });
});

describe("una ruta no sale vacía ni se cierra a medias", () => {
  it("no sale sin paradas", async () => {
    const m = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "borrador");
    await expect(
      env.DB.prepare("UPDATE rutas SET estado = 'en_curso', salio_en = ? WHERE id = ?")
        .bind(ahora(), ruta)
        .run(),
    ).rejects.toThrow(/no tiene paradas/i);
  });

  it("no se cierra con una parada sin marcar", async () => {
    const m = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "en_curso");
    await envioCrudo(await pedidoCrudo(), "en_ruta", { rutaId: ruta, motorizadoId: m.id });

    await expect(
      env.DB.prepare("UPDATE rutas SET estado = 'cerrada', cerrada_en = ? WHERE id = ?")
        .bind(ahora(), ruta)
        .run(),
    ).rejects.toThrow(/sin marcar/i);
  });
});

describe("el dinero y la hora no se escriben a medias", () => {
  it("un «entregado» sin hora no entra", async () => {
    await expect(envioCrudo(await pedidoCrudo(), "entregado")).rejects.toThrow();
  });

  it("cobrado sin decir cómo no entra", async () => {
    await expect(
      envioCrudo(await pedidoCrudo(), "entregado", { entregadoEn: ahora(), cobro: 500, cobrado: 500 }),
    ).rejects.toThrow();
  });

  it("no se cobra más de lo que se pidió cobrar", async () => {
    await expect(
      envioCrudo(await pedidoCrudo(), "entregado", {
        entregadoEn: ahora(), cobro: 300, cobrado: 500, metodo: "efectivo",
      }),
    ).rejects.toThrow();
  });

  it("ni se cobra en una parada que no se entregó", async () => {
    await expect(
      envioCrudo(await pedidoCrudo(), "fallido", { cobro: 500, cobrado: 500, metodo: "efectivo" }),
    ).rejects.toThrow();
  });
});

describe("el orden de una ruta no queda a medias", () => {
  it("dos paradas no comparten número de orden", async () => {
    const m = await motorizadoNuevo();
    const ruta = await rutaCruda(m.id, "borrador");
    await envioCrudo(await pedidoCrudo(), "asignado", { rutaId: ruta, orden: 1, motorizadoId: m.id });
    await expect(
      envioCrudo(await pedidoCrudo(), "asignado", { rutaId: ruta, orden: 1, motorizadoId: m.id }),
    ).rejects.toThrow();
  });

  it("un pedido no tiene dos entregas vivas a la vez", async () => {
    const p = await pedidoCrudo();
    await envioCrudo(p, "asignado");
    // Con dos vivas, entregar una descargaría del inventario lo apartado del
    // pedido ENTERO, y la segunda lo volvería a descargar.
    await expect(envioCrudo(p, "pendiente")).rejects.toThrow();
  });

  it("pero sí una nueva después de una devuelta", async () => {
    const p = await pedidoCrudo();
    await envioCrudo(p, "devuelto");
    await expect(envioCrudo(p, "pendiente")).resolves.toBeTruthy();
  });
});

describe("la bitácora de una entrega es un libro", () => {
  it("no se edita ni se borra", async () => {
    const e = await envioCrudo(await pedidoCrudo(), "pendiente");
    const eventoId = ulid(ahora());
    await env.DB.prepare(
      "INSERT INTO envio_eventos (id,envio_id,de,a,actor,creado_en) VALUES (?,?,NULL,'pendiente','prueba',?)",
    )
      .bind(eventoId, e, ahora())
      .run();

    await expect(
      env.DB.prepare("UPDATE envio_eventos SET nota = 'otra cosa' WHERE id = ?").bind(eventoId).run(),
    ).rejects.toThrow(/no se edita/i);
    await expect(
      env.DB.prepare("DELETE FROM envio_eventos WHERE id = ?").bind(eventoId).run(),
    ).rejects.toThrow(/no se borra/i);
  });
});

describe("la prueba de entrega no se puede quedar colgando", () => {
  it("la fila de `archivos` no se borra mientras una entrega la señale", async () => {
    const e = await envioCrudo(await pedidoCrudo(), "pendiente");
    const clave = `entregas/${e}/prueba.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,referencia_tipo,referencia_id,creado_en)
       VALUES (?,'entregas','image/webp',10,1,'prueba','envio',?,?)`,
    )
      .bind(clave, e, ahora())
      .run();
    await env.DB.prepare("UPDATE envios SET foto_r2 = ? WHERE id = ?").bind(clave, e).run();

    // Es lo que impide que el barrido se lleve la prueba de una entrega.
    await expect(
      env.DB.prepare("DELETE FROM archivos WHERE r2_key = ?").bind(clave).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("y una entrega no puede señalar un archivo que no existe", async () => {
    const e = await envioCrudo(await pedidoCrudo(), "pendiente");
    await expect(
      env.DB.prepare("UPDATE envios SET foto_r2 = 'entregas/fantasma.webp' WHERE id = ?").bind(e).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

// ===========================================================================
// Preparar la entrega
// ===========================================================================

describe("crearEnvio", () => {
  it("sale de la bodega donde está APARTADO, con el saldo por cobrar", async () => {
    const p = await pedidoAgendado({ cantidad: 2 });
    const r = await crearEnvio(ctx(), { pedidoId: p.pedidoId });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.datos.bodegaId).toBe(bodegaId);
    expect(r.datos.metodo).toBe("motorizado");
    // 500 de abono sobre el total: lo que queda es lo que cobra el motorizado.
    expect(r.datos.cobroCents).toBe(p.totalCents - 500);
    expect(r.datos.guiaToken.length).toBeGreaterThan(20);
  });

  it("un pedido que todavía no se agendó no se despacha", async () => {
    const codigo = await variante(10);
    const clienteId = id("cli");
    await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
      .bind(clienteId, "Sin abonar", ahora(), ahora())
      .run();
    const pedido = await crearPedido(
      { db: env.DB, ahora: ahora(), actor: "prueba", abonoMinimoCents: 500, minutosParaAbonar: null },
      { idempotencia: id("idem"), clienteId, origen: "web", lineas: [{ codigo, cantidad: 1, bodega }], zona },
    );
    if (!pedido.ok) throw new Error(pedido.mensaje);

    const r = await crearEnvio(ctx(), { pedidoId: pedido.datos.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
  });

  it("no se preparan dos entregas del mismo pedido", async () => {
    const p = await pedidoAgendado();
    expect((await crearEnvio(ctx(), { pedidoId: p.pedidoId })).ok).toBe(true);
    const otra = await crearEnvio(ctx(), { pedidoId: p.pedidoId });
    expect(otra.ok).toBe(false);
    if (!otra.ok) expect(otra.codigo).toBe("repetido");
  });

  it("una ventana de entrega no se acepta mientras la dueña no las decida", async () => {
    const p = await pedidoAgendado();
    const r = await crearEnvio(ctx(), { pedidoId: p.pedidoId, ventana: "manana" });
    expect(r.ok).toBe(false);
    // `ventanas_entrega` vale PENDIENTE en reglas.json: no hay ninguna ventana
    // que ofrecer, y aceptarla sería inventarle un horario al negocio.
    if (!r.ok) expect(r.mensaje).toMatch(/no están decididas/i);
  });

  it("y sí se acepta cuando el ajuste está puesto", async () => {
    await env.DB.prepare(
      `INSERT INTO ajustes (clave,version,valor_json,vigente_desde,cambiado_por)
       VALUES ('ventanas_entrega',1,'["manana","tarde"]',?,'prueba')`,
    )
      .bind(ahora() - 1000)
      .run();

    try {
      const vigentes = await ajustesDeEntrega(env.DB, ahora());
      expect(vigentes.ventanas).toEqual(["manana", "tarde"]);
      // Y lo que la dueña NO decidió sigue diciendo que falta.
      expect(vigentes.comisiones).toBe("PENDIENTE");

      const p = await pedidoAgendado();
      expect((await crearEnvio(ctx(), { pedidoId: p.pedidoId, ventana: "tarde" })).ok).toBe(true);

      const q = await pedidoAgendado();
      const mal = await crearEnvio(ctx(), { pedidoId: q.pedidoId, ventana: "madrugada" });
      expect(mal.ok).toBe(false);
    } finally {
      // Este ajuste es global: si se queda puesto, cambia las pruebas de abajo.
      await env.DB.prepare("DELETE FROM ajustes WHERE clave = 'ventanas_entrega'").run();
    }
  });
});

describe("sugerirParaEnvio", () => {
  it("propone primero a quien ya va a esa zona, y dice por qué", async () => {
    const vaALaZona = await motorizadoNuevo();
    const vacio = await motorizadoNuevo();
    const fuera = await motorizadoNuevo("inactivo");

    // Al primero se le da una parada en la misma zona.
    const otra = await conEnvio();
    const ruta = await armarRuta(ctx(), {
      motorizadoId: vaALaZona.id,
      bodegaId,
      envioIds: [otra.envioId],
    });
    if (!ruta.ok) throw new Error(ruta.mensaje);

    const nueva = await conEnvio();
    const r = await sugerirParaEnvio(env.DB, nueva.envioId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const nombres = r.datos.candidatos.map((c) => c.motorizado_id);
    expect(nombres.indexOf(vaALaZona.id)).toBeLessThan(nombres.indexOf(vacio.id));
    expect(nombres).not.toContain(fuera.id);
    expect(r.datos.candidatos.find((c) => c.motorizado_id === vaALaZona.id)?.motivo).toMatch(
      /Ya va a esta zona/,
    );
  });
});

// ===========================================================================
// Armar y despachar la ruta
// ===========================================================================

describe("armarRuta", () => {
  it("escribe las paradas en el orden propuesto y guarda los kilómetros", async () => {
    const m = await motorizadoNuevo();
    // Tres paradas: una pegada a la bodega, otra lejos, otra en medio. El orden
    // propuesto no es el de la lista.
    const cerca = await conEnvio({ punto: { lat: 8.982, lng: -79.52 } });
    const lejos = await conEnvio({ punto: { lat: 9.08, lng: -79.4 } });
    const medio = await conEnvio({ punto: { lat: 9.02, lng: -79.47 } });

    const r = await armarRuta(ctx(), {
      motorizadoId: m.id,
      bodegaId,
      envioIds: [lejos.envioId, cerca.envioId, medio.envioId],
      origen: { lat: 8.9824, lng: -79.5199 },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.datos.paradas.map((p) => p.envioId)).toEqual([
      cerca.envioId, medio.envioId, lejos.envioId,
    ]);
    expect(r.datos.kmPropuestos).toBeGreaterThan(0);

    const parada = await leerEnvio(cerca.envioId);
    expect(parada?.estado).toBe("asignado");
    expect(parada?.orden_ruta).toBe(1);
    expect(parada?.ruta_id).toBe(r.datos.rutaId);
    expect(parada?.motorizado_id).toBe(m.id);

    const ruta = await env.DB.prepare("SELECT estado, km_propuestos, origen_lat FROM rutas WHERE id = ?")
      .bind(r.datos.rutaId)
      .first<{ estado: string; km_propuestos: number | null; origen_lat: number | null }>();
    expect(ruta?.estado).toBe("borrador");
    expect(ruta?.km_propuestos).toBeCloseTo(r.datos.kmPropuestos!, 6);
    expect(ruta?.origen_lat).toBeCloseTo(8.9824, 6);
  });

  it("las que no tienen punto en el mapa van al final y se avisan", async () => {
    const m = await motorizadoNuevo();
    const sinPunto = await conEnvio({ punto: null });
    const conPunto = await conEnvio({ punto: { lat: 9.05, lng: -79.45 } });

    const r = await armarRuta(ctx(), {
      motorizadoId: m.id,
      bodegaId,
      envioIds: [sinPunto.envioId, conPunto.envioId],
      origen: { lat: 8.9824, lng: -79.5199 },
    });
    if (!r.ok) throw new Error(r.mensaje);

    expect(r.datos.sinUbicar).toEqual([sinPunto.envioId]);
    expect(r.datos.paradas.map((p) => p.envioId)).toEqual([conPunto.envioId, sinPunto.envioId]);
  });

  it("sin punto de salida no se propone orden: se respeta el que llegó", async () => {
    const m = await motorizadoNuevo();
    const a = await conEnvio({ punto: { lat: 9.08, lng: -79.4 } });
    const b = await conEnvio({ punto: { lat: 8.982, lng: -79.52 } });

    const r = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [a.envioId, b.envioId] });
    if (!r.ok) throw new Error(r.mensaje);
    // Medir desde un punto inventado daría un orden que parece pensado.
    expect(r.datos.paradas.map((p) => p.envioId)).toEqual([a.envioId, b.envioId]);
    expect(r.datos.kmPropuestos).toBeNull();
  });

  it("un motorizado en pausa no recibe ruta nueva", async () => {
    const m = await motorizadoNuevo("pausa");
    const e = await conEnvio();
    const r = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [e.envioId] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
  });

  it("una parada apartada en otra bodega no entra", async () => {
    const m = await motorizadoNuevo();
    const e = await conEnvio();
    const otraBodega = id("bod");
    await env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)")
      .bind(otraBodega, `Bodega ${otraBodega}`)
      .run();

    const r = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId: otraBodega, envioIds: [e.envioId] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/otra bodega/i);
  });

  it("una parada que ya está en una ruta no entra en otra", async () => {
    const m = await motorizadoNuevo();
    const otro = await motorizadoNuevo();
    const e = await conEnvio();
    expect((await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [e.envioId] })).ok).toBe(true);

    const r = await armarRuta(ctx(), { motorizadoId: otro.id, bodegaId, envioIds: [e.envioId] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("repetido");
  });

  it("un motorizado tiene una sola ruta por día", async () => {
    const m = await motorizadoNuevo();
    const a = await conEnvio();
    const b = await conEnvio();
    expect((await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [a.envioId] })).ok).toBe(true);

    const r = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [b.envioId] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("repetido");
  });

  it("cancelar una ruta suelta sus paradas, y entonces sí cabe otra", async () => {
    const m = await motorizadoNuevo();
    const e = await conEnvio();
    const primera = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [e.envioId] });
    if (!primera.ok) throw new Error(primera.mensaje);

    const c = await cancelarRuta(ctx(), primera.datos.rutaId, "me equivoqué de motorizado");
    expect(c.ok, JSON.stringify(c)).toBe(true);

    const parada = await leerEnvio(e.envioId);
    expect(parada?.estado).toBe("pendiente");
    expect(parada?.ruta_id).toBeNull();
    expect(parada?.motorizado_id).toBeNull();

    expect((await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [e.envioId] })).ok).toBe(true);
  });
});

describe("despacharRuta", () => {
  it("la mercancía sale, los pedidos van en camino y la bitácora lo cuenta entero", async () => {
    const m = await motorizadoNuevo();
    const e = await conEnvio();
    const ruta = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [e.envioId] });
    if (!ruta.ok) throw new Error(ruta.mensaje);

    const r = await despacharRuta(ctx(), ruta.datos.rutaId);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect((await leerEnvio(e.envioId))?.estado).toBe("en_ruta");
    expect((await leerPedido(e.pedidoId))?.estado).toBe("en_ruta");

    // Los dos hechos quedan escritos: cargar y salir. Saltarse «recogido»
    // sería escribir en la bitácora algo que no pasó.
    const { results } = await env.DB.prepare(
      "SELECT de, a FROM envio_eventos WHERE envio_id = ? ORDER BY creado_en, id",
    )
      .bind(e.envioId)
      .all<{ de: string | null; a: string }>();
    expect(results.map((x) => `${x.de ?? "-"}>${x.a}`)).toEqual([
      "->pendiente", "pendiente>asignado", "asignado>recogido", "recogido>en_ruta",
    ]);
  });

  it("al salir NO se mueve el inventario: sigue apartado", async () => {
    const e = await enLaCalle({ cantidad: 3, fisico: 10 });
    // La mercancía está en la moto, pero la venta no ha pasado todavía: el
    // físico solo baja al entregar.
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 3 });
  });

  it("una ruta ya despachada no se despacha otra vez", async () => {
    const e = await enLaCalle();
    const r = await despacharRuta(ctx(), e.rutaId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
  });

  it("una ruta en curso ya no se cancela", async () => {
    const e = await enLaCalle();
    const r = await cancelarRuta(ctx(), e.rutaId, "ya no");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
  });
});

// ===========================================================================
// Llegó
// ===========================================================================

describe("marcarEntregada", () => {
  it("cierra la parada, descarga el stock y cobra el saldo, todo junto", async () => {
    const e = await enLaCalle({ cantidad: 3, fisico: 10 });
    const antes = await leerPedido(e.pedidoId);
    const saldo = antes!.total_cents - antes!.pagado_cents;

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo",
      punto: { lat: 8.99, lng: -79.51 },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.datos.cobradoCents).toBe(saldo);

    const parada = await leerEnvio(e.envioId);
    expect(parada?.estado).toBe("entregado");
    expect(parada?.entregado_en).not.toBeNull();
    expect(parada?.cobrado_cents).toBe(saldo);
    expect(parada?.cobro_metodo).toBe("efectivo");

    // El físico baja Y lo reservado se suelta. Si solo bajara el físico, esas
    // unidades quedarían apartadas para siempre para un pedido ya entregado.
    expect(await existencias(e.codigo)).toEqual({ fisico: 7, reservado: 0 });

    const pedido = await leerPedido(e.pedidoId);
    expect(pedido?.estado).toBe("entregado");
    expect(pedido?.estado_pago).toBe("pagado");
    expect(pedido?.pagado_cents).toBe(pedido?.total_cents);

    // Y queda el movimiento de inventario que lo explica.
    const mov = await env.DB.prepare(
      "SELECT delta, tipo, referencia_tipo FROM movimientos_inventario WHERE referencia_id = ?",
    )
      .bind(e.envioId)
      .first<{ delta: number; tipo: string; referencia_tipo: string }>();
    expect(mov).toEqual({ delta: -3, tipo: "venta", referencia_tipo: "envio" });

    // Y dónde estaba el teléfono al marcarlo.
    const evento = await env.DB.prepare(
      "SELECT lat, lng FROM envio_eventos WHERE envio_id = ? AND a = 'entregado'",
    )
      .bind(e.envioId)
      .first<{ lat: number | null; lng: number | null }>();
    expect(evento?.lat).toBeCloseTo(8.99, 6);
  });

  it("el mismo toque dos veces cobra una sola vez", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const clave = id("idem");
    const entrada = {
      idempotencia: clave,
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo" as const,
    };

    const uno = await marcarEntregada(ctx(), entrada);
    expect(uno.ok, JSON.stringify(uno)).toBe(true);
    const dos = await marcarEntregada(ctx(), entrada);
    expect(dos.ok, JSON.stringify(dos)).toBe(true);
    if (!uno.ok || !dos.ok) return;

    // Lo que importa: la respuesta es la misma y el dinero entró una vez.
    expect(dos.datos.cobradoCents).toBe(uno.datos.cobradoCents);
    expect(dos.datos.yaEstaba).toBe(true);

    const pagos = await pagosDe(e.pedidoId);
    expect(pagos?.n).toBe(1);
    expect(pagos?.suma).toBe(uno.datos.cobradoCents);

    const pedido = await leerPedido(e.pedidoId);
    expect(pedido?.pagado_cents).toBe(pedido?.total_cents);
    // Y el stock se descargó una vez, no dos.
    expect(await existencias(e.codigo)).toEqual({ fisico: 8, reservado: 0 });
  });

  it("y con DOS claves distintas tampoco cobra dos veces", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const base = { envioId: e.envioId, motorizadoId: e.motorizado.id, metodoCobro: "efectivo" as const };

    const uno = await marcarEntregada(ctx(), { ...base, idempotencia: id("idem") });
    expect(uno.ok).toBe(true);
    // El teléfono generó otra clave al reintentar: la idempotencia no lo caza,
    // y lo que lo caza es el estado de la parada más la llave única de
    // `pagos.intento_ref`, que se deriva del ENVÍO y no de la clave.
    const dos = await marcarEntregada(ctx(), { ...base, idempotencia: id("idem") });
    expect(dos.ok).toBe(false);
    if (!dos.ok) expect(dos.codigo).toBe("transicion_invalida");

    expect((await pagosDe(e.pedidoId))?.n).toBe(1);
    expect(await existencias(e.codigo)).toEqual({ fisico: 8, reservado: 0 });
  });

  it("dos peticiones A LA VEZ con claves distintas: el saldo entra una sola vez", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const base = { envioId: e.envioId, motorizadoId: e.motorizado.id, metodoCobro: "efectivo" as const };
    const T = ahora();

    // Las dos leen la parada «en ruta» antes de que ninguna escriba: es la
    // carrera de verdad, la que el estado leído antes del batch no puede cazar.
    // Lo que la cierra es la llave única de `pagos.intento_ref`, derivada del
    // ENVÍO: con ella, el batch perdedor se cae entero y D1 lo deshace.
    const [uno, dos] = await Promise.all([
      marcarEntregada({ db: env.DB, ahora: T, actor: "a" }, { ...base, idempotencia: id("idem") }),
      marcarEntregada({ db: env.DB, ahora: T, actor: "b" }, { ...base, idempotencia: id("idem") }),
    ]);

    // Las dos contestan bien —la perdedora reconoce que ya estaba hecho, que es
    // lo que necesita un teléfono con mala señal— pero solo UNA escribió.
    expect(uno.ok && dos.ok, `${JSON.stringify(uno)} / ${JSON.stringify(dos)}`).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect([uno.datos.yaEstaba, dos.datos.yaEstaba].filter((x) => x === false)).toHaveLength(1);

    expect((await pagosDe(e.pedidoId))?.n).toBe(1);
    // Y el stock se descargó UNA vez: 10 − 2.
    expect(await existencias(e.codigo)).toEqual({ fisico: 8, reservado: 0 });
    const pedido = await leerPedido(e.pedidoId);
    expect(pedido?.pagado_cents).toBe(pedido?.total_cents);
  });

  it("dos a la vez sin saldo que cobrar: el stock sale una sola vez", async () => {
    // Sin cobro no hay fila de `pagos`, así que la llave de `intento_ref` no
    // defiende nada: lo único que queda entre esto y descargar el inventario
    // dos veces es la fila de control, y solo porque mira la HORA que escribió
    // su propio batch. Con un control que mirara solo la versión, el perdedor
    // pasaría —después del ganador, la versión YA es la que esperaba— y el
    // físico bajaría dos veces.
    const e = await enLaCalle({ cantidad: 2, fisico: 10, pagar: "todo" });
    const T = ahora();

    const [uno, dos] = await Promise.all([
      marcarEntregada({ db: env.DB, ahora: T, actor: "a" }, { idempotencia: id("idem"), envioId: e.envioId }),
      marcarEntregada({ db: env.DB, ahora: T + 1, actor: "b" }, { idempotencia: id("idem"), envioId: e.envioId }),
    ]);

    expect(uno.ok && dos.ok, `${JSON.stringify(uno)} / ${JSON.stringify(dos)}`).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect([uno.datos.yaEstaba, dos.datos.yaEstaba].filter((x) => x === false)).toHaveLength(1);

    expect(await existencias(e.codigo)).toEqual({ fisico: 8, reservado: 0 });
    const movimientos = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM movimientos_inventario WHERE referencia_id = ?",
    )
      .bind(e.envioId)
      .first<{ n: number }>();
    expect(movimientos?.n).toBe(1);
  });

  it("la misma clave con otra entrada es «repetido», no la respuesta de antes", async () => {
    const e = await enLaCalle();
    const clave = id("idem");
    expect(
      (await marcarEntregada(ctx(), {
        idempotencia: clave, envioId: e.envioId, motorizadoId: e.motorizado.id, metodoCobro: "efectivo",
      })).ok,
    ).toBe(true);

    const otra = await enLaCalle();
    const r = await marcarEntregada(ctx(), {
      idempotencia: clave, envioId: otra.envioId, motorizadoId: otra.motorizado.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("repetido");
    // Y la otra parada no se tocó.
    expect((await leerEnvio(otra.envioId))?.estado).toBe("en_ruta");
  });

  it("el monto lo pone el servidor: otro número no escribe nada", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo",
      montoCents: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("monto_no_coincide");

    // Nada: ni la parada, ni el stock, ni el pedido.
    expect((await leerEnvio(e.envioId))?.estado).toBe("en_ruta");
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 2 });
    expect((await leerPedido(e.pedidoId))?.estado).toBe("en_ruta");
  });

  it("cobrar sin decir cómo no se escribe", async () => {
    const e = await enLaCalle();
    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, montoCents: 500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  it("un pedido ya pagado por completo se entrega sin cobro", async () => {
    const e = await enLaCalle({ cantidad: 1, fisico: 10, pagar: "todo" });
    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, motorizadoId: e.motorizado.id,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.datos.cobradoCents).toBe(0);
    expect((await leerEnvio(e.envioId))?.cobro_metodo).toBeNull();
    // Y no se le inventa un pago.
    expect((await pagosDe(e.pedidoId))?.n).toBe(0);
    expect((await leerPedido(e.pedidoId))?.estado).toBe("entregado");
  });

  it("y si no hay saldo, no se acepta un cobro", async () => {
    const e = await enLaCalle({ pagar: "todo" });
    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, metodoCobro: "efectivo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("monto_no_coincide");
  });

  it("un motorizado no cierra la parada de otro", async () => {
    const e = await enLaCalle();
    const otro = await motorizadoNuevo();
    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, motorizadoId: otro.id, metodoCobro: "efectivo",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");
    expect((await leerEnvio(e.envioId))?.estado).toBe("en_ruta");
  });

  it("la prueba de OTRA entrega no se acepta", async () => {
    const e = await enLaCalle();
    const otra = await enLaCalle();
    const clave = `entregas/${otra.envioId}/x.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,referencia_tipo,referencia_id,creado_en)
       VALUES (?,'entregas','image/webp',10,1,'prueba','envio',?,?)`,
    )
      .bind(clave, otra.envioId, ahora())
      .run();

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, pruebaR2: clave,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  it("la prueba propia queda pegada a la parada", async () => {
    const e = await enLaCalle();
    const clave = `entregas/${e.envioId}/x.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,referencia_tipo,referencia_id,creado_en)
       VALUES (?,'entregas','image/webp',10,1,'prueba','envio',?,?)`,
    )
      .bind(clave, e.envioId, ahora())
      .run();

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, pruebaR2: clave, metodoCobro: "yappy",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await leerEnvio(e.envioId))?.foto_r2).toBe(clave);
  });

  it("fija el costo de lo vendido con el promedio de HOY y baja el valor del inventario", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    // 10 unidades que costaron 300 cada una.
    await env.DB.prepare("INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,10,3000)")
      .bind(e.codigo)
      .run();

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, metodoCobro: "efectivo",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.costoDesconocido).toBe(false);

    const linea = await env.DB.prepare(
      "SELECT costo_unit_cents FROM pedido_lineas WHERE pedido_id = ?",
    )
      .bind(e.pedidoId)
      .first<{ costo_unit_cents: number | null }>();
    expect(linea?.costo_unit_cents).toBe(300);

    const valor = await env.DB.prepare("SELECT unidades, valor_cents FROM valor_inventario WHERE codigo = ?")
      .bind(e.codigo)
      .first<{ unidades: number; valor_cents: number }>();
    expect(valor).toEqual({ unidades: 8, valor_cents: 2400 });
  });

  it("sin promedio cargado el costo queda en nulo y se dice, no en cero", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, metodoCobro: "efectivo",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Un cero afirmaría que la mercancía no costó nada.
    expect(r.datos.costoDesconocido).toBe(true);
    const linea = await env.DB.prepare(
      "SELECT costo_unit_cents FROM pedido_lineas WHERE pedido_id = ?",
    )
      .bind(e.pedidoId)
      .first<{ costo_unit_cents: number | null }>();
    expect(linea?.costo_unit_cents).toBeNull();
  });

  it("una parada que no salió no se puede entregar", async () => {
    const m = await motorizadoNuevo();
    const e = await conEnvio();
    const ruta = await armarRuta(ctx(), { motorizadoId: m.id, bodegaId, envioIds: [e.envioId] });
    if (!ruta.ok) throw new Error(ruta.mensaje);

    const r = await marcarEntregada(ctx(), { idempotencia: id("idem"), envioId: e.envioId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
    expect(await existencias(e.codigo)).toEqual({ fisico: 50, reservado: e.cantidad });
  });
});

// ===========================================================================
// No se pudo entregar
// ===========================================================================

describe("marcarFallida", () => {
  it("el pedido vuelve a agendado y la mercancía SIGUE apartada", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const r = await marcarFallida(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      motivo: "nadie en la casa",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect((await leerEnvio(e.envioId))?.estado).toBe("fallido");
    expect((await leerPedido(e.pedidoId))?.estado).toBe("agendado");
    // Liberarla aquí la pondría a la venta y el reintento de mañana se
    // quedaría sin con qué.
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 2 });

    const evento = await env.DB.prepare(
      "SELECT nota FROM envio_eventos WHERE envio_id = ? AND a = 'fallido'",
    )
      .bind(e.envioId)
      .first<{ nota: string | null }>();
    expect(evento?.nota).toBe("nadie en la casa");
  });

  it("sin motivo no se marca: mañana nadie sabría qué hacer", async () => {
    const e = await enLaCalle();
    const r = await marcarFallida(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, motivo: "  ",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
    expect((await leerEnvio(e.envioId))?.estado).toBe("en_ruta");
  });

  it("el mismo toque dos veces no escribe dos veces", async () => {
    const e = await enLaCalle();
    const entrada = { idempotencia: id("idem"), envioId: e.envioId, motivo: "no contesta" };
    expect((await marcarFallida(ctx(), entrada)).ok).toBe(true);
    const dos = await marcarFallida(ctx(), entrada);
    expect(dos.ok).toBe(true);
    if (dos.ok) expect(dos.datos.yaEstaba).toBe(true);

    const { results } = await env.DB.prepare(
      "SELECT id FROM envio_eventos WHERE envio_id = ? AND a = 'fallido'",
    )
      .bind(e.envioId)
      .all();
    expect(results).toHaveLength(1);
  });
});

describe("devolverParada", () => {
  it("libera exactamente lo apartado y cancela el pedido", async () => {
    const e = await enLaCalle({ cantidad: 4, fisico: 10 });
    expect(
      (await marcarFallida(ctx(), { idempotencia: id("idem"), envioId: e.envioId, motivo: "se mudó" })).ok,
    ).toBe(true);

    const r = await devolverParada(ctx(), e.envioId, "la clienta ya no la quiere");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.liberadas).toBe(1);

    expect((await leerEnvio(e.envioId))?.estado).toBe("devuelto");
    expect((await leerPedido(e.pedidoId))?.estado).toBe("cancelado");
    // Lo apartado vuelve a estar a la venta, y el físico no se movió: la caja
    // nunca salió del inventario.
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 0 });
  });

  it("devuelve LO QUE SE APARTÓ aunque la receta del combo haya cambiado", async () => {
    // Es el caso que `pedido_linea_componentes` existe para resolver.
    const pieza = await variante(100);
    const comboCodigo = codigoNuevo();
    await env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en,es_combo) VALUES (?,?,?,1,900,1,1,1,?,1)`,
    )
      .bind(comboCodigo, productoId, `combo ${comboCodigo}`, ahora())
      .run();
    await env.DB.prepare("INSERT INTO combo_componentes (combo_codigo,codigo,cantidad) VALUES (?,?,2)")
      .bind(comboCodigo, pieza)
      .run();

    const clienteId = id("cli");
    await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
      .bind(clienteId, "Combo", ahora(), ahora())
      .run();
    const pedido = await crearPedido(
      { db: env.DB, ahora: ahora(), actor: "prueba", abonoMinimoCents: 500, minutosParaAbonar: null },
      {
        idempotencia: id("idem"), clienteId, origen: "web",
        lineas: [{ codigo: comboCodigo, cantidad: 3, bodega }], zona,
      },
    );
    if (!pedido.ok) throw new Error(pedido.mensaje);
    expect((await existencias(pieza))?.reservado).toBe(6); // 2 × 3

    await env.DB.prepare("UPDATE pedidos SET pagado_cents = 500, estado_pago = 'abonado' WHERE id = ?")
      .bind(pedido.datos.id)
      .run();
    if (!(await agendar({ db: env.DB, ahora: ahora(), actor: "p" }, pedido.datos.id)).ok) {
      throw new Error("no se agendó");
    }

    const envio = await crearEnvio(ctx(), { pedidoId: pedido.datos.id });
    if (!envio.ok) throw new Error(envio.mensaje);
    const m = await motorizadoNuevo();
    const ruta = await armarRuta(ctx(), {
      motorizadoId: m.id, bodegaId, envioIds: [envio.datos.envioId],
    });
    if (!ruta.ok) throw new Error(ruta.mensaje);
    expect((await despacharRuta(ctx(), ruta.datos.rutaId)).ok).toBe(true);
    expect(
      (await marcarFallida(ctx(), {
        idempotencia: id("idem"), envioId: envio.datos.envioId, motivo: "dirección mala",
      })).ok,
    ).toBe(true);

    // La receta cambia DESPUÉS de la venta: ahora cada combo lleva 5.
    await env.DB.prepare(
      "UPDATE combo_componentes SET cantidad = 5 WHERE combo_codigo = ? AND codigo = ?",
    )
      .bind(comboCodigo, pieza)
      .run();

    expect((await devolverParada(ctx(), envio.datos.envioId, "no se pudo")).ok).toBe(true);
    // 6, que es lo que se quitó. Con la receta nueva se habrían liberado 15 y
    // el CHECK habría tumbado el batch; con una receta más corta se habría
    // quedado una diferencia apartada para siempre sin que nada fallara.
    expect((await existencias(pieza))?.reservado).toBe(0);
  });

  it("no se devuelve una parada que no se marcó fallida primero", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const r = await devolverParada(ctx(), e.envioId, "porque sí");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 2 });
  });

  it("ni sin motivo", async () => {
    const e = await enLaCalle();
    await marcarFallida(ctx(), { idempotencia: id("idem"), envioId: e.envioId, motivo: "x" });
    const r = await devolverParada(ctx(), e.envioId, "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });
});

// ===========================================================================
// Cerrar el día
// ===========================================================================

describe("cerrarRuta", () => {
  it("no se cierra con una parada sin marcar, y lo dice con el número", async () => {
    const e = await enLaCalle();
    const r = await cerrarRuta(ctx(), e.rutaId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/1 parada sin marcar/i);
  });

  it("se cierra cuando todo está marcado, con lo cobrado del día", async () => {
    const e = await enLaCalle({ cantidad: 1, fisico: 10 });
    const entrega = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, metodoCobro: "efectivo",
    });
    if (!entrega.ok) throw new Error(entrega.mensaje);

    const r = await cerrarRuta(ctx(), e.rutaId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.entregadas).toBe(1);
    expect(r.datos.cobradoCents).toBe(entrega.datos.cobradoCents);

    const ruta = await env.DB.prepare("SELECT estado, cerrada_en FROM rutas WHERE id = ?")
      .bind(e.rutaId)
      .first<{ estado: string; cerrada_en: number | null }>();
    expect(ruta?.estado).toBe("cerrada");
    expect(ruta?.cerrada_en).not.toBeNull();
  });
});

// ===========================================================================
// Lo que ve la pantalla
// ===========================================================================

describe("entregasDelDia", () => {
  it("trae las rutas con sus paradas, lo que falta y lo cobrado ya sumado", async () => {
    const hoy = fechaDePanama(ahora());
    const e = await enLaCalle({ cantidad: 1, fisico: 10 });
    const pendiente = await conEnvio();

    const antes = await entregasDelDia(env.DB, hoy, ahora());
    expect(antes.ok).toBe(true);
    if (!antes.ok) return;

    const ruta = antes.datos.rutas.find((r) => r.rutaId === e.rutaId);
    expect(ruta?.motorizado).toBe(e.motorizado.nombre);
    expect(ruta?.paradas.map((p) => p.envioId)).toEqual([e.envioId]);
    expect(ruta?.paradas[0]?.cliente).toContain("Clienta");
    expect(antes.datos.sinRuta.map((p) => p.envioId)).toContain(pendiente.envioId);

    const entrega = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, metodoCobro: "efectivo",
    });
    if (!entrega.ok) throw new Error(entrega.mensaje);

    const despues = await entregasDelDia(env.DB, hoy, ahora());
    if (!despues.ok) throw new Error(despues.mensaje);
    expect(despues.datos.resumen.entregadas).toBeGreaterThanOrEqual(1);
    expect(despues.datos.resumen.cobradoCents).toBeGreaterThanOrEqual(entrega.datos.cobradoCents);
    // Lo que falta baja al entregar: es el número que la pantalla enseña arriba.
    expect(despues.datos.resumen.porEntregar).toBe(antes.datos.resumen.porEntregar - 1);
  });

  it("nunca saca la clave de la prueba, solo si la hay", async () => {
    const e = await enLaCalle();
    const clave = `entregas/${e.envioId}/y.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,referencia_tipo,referencia_id,creado_en)
       VALUES (?,'entregas','image/webp',10,1,'prueba','envio',?,?)`,
    )
      .bind(clave, e.envioId, ahora())
      .run();
    await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, pruebaR2: clave, metodoCobro: "efectivo",
    });

    const r = await entregasDelDia(env.DB, fechaDePanama(ahora()), ahora());
    if (!r.ok) throw new Error(r.mensaje);
    const parada = r.datos.rutas
      .flatMap((x) => x.paradas)
      .find((p) => p.envioId === e.envioId);
    expect(parada?.conPrueba).toBe(true);
    // La foto es un dato personal: la clave no viaja a la pantalla.
    expect(JSON.stringify(r.datos)).not.toContain(clave);
  });

  it("una fecha mal escrita no consulta nada", async () => {
    const r = await entregasDelDia(env.DB, "11/11/2026", ahora());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  it("y los ajustes que faltan se dicen, no se rellenan", async () => {
    const r = await entregasDelDia(env.DB, fechaDePanama(ahora()), ahora());
    if (!r.ok) throw new Error(r.mensaje);
    expect(r.datos.ajustes.ventanas).toBe("PENDIENTE");
    expect(r.datos.ajustes.comisiones).toBe("PENDIENTE");
  });
});

describe("fechaDePanama", () => {
  it("es el día de aquí, no el de UTC", async () => {
    // 2026-11-12T02:00:00Z son las nueve de la noche del 11 en Panamá. Con la
    // fecha de UTC, todo lo entregado después de las siete contaría como del
    // día siguiente y la ruta de hoy saldría partida en dos días.
    expect(fechaDePanama(Date.UTC(2026, 10, 12, 2, 0, 0))).toBe("2026-11-11");
    expect(fechaDePanama(Date.UTC(2026, 10, 11, 17, 0, 0))).toBe("2026-11-11");
  });
});
