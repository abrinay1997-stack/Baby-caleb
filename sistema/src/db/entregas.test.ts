import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { token, ulid } from "../ids";
import { crearPedido } from "./pedidos";
import { agendar } from "./transiciones";
import { guardar as guardarAjuste } from "./ajustes";
import { revisionDeCierre } from "./contabilidad";
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
  guardarPrueba,
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
  // Los ajustes se limpian entre pruebas. El pool de vitest rehace el esquema
  // una vez por ARCHIVO, no por prueba, así que una prueba que decide las
  // ventanas de entrega se las deja decididas a las siguientes — y las que
  // comprueban «mientras la dueña no las decida» pasarían a probar lo
  // contrario de lo que dicen.
  //
  // Sin filas, cada prueba arranca en los valores de fábrica de reglas.json,
  // que es el estado real de un sistema recién instalado.
  await env.DB.prepare("DELETE FROM ajustes").run();

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
  opts: {
    cantidad?: number;
    fisico?: number;
    punto?: { lat: number; lng: number } | null;
    pagar?: "abono" | "todo";
    /** Para que dos pedidos compartan variante y bodega. */
    codigo?: string;
  } = {},
): Promise<Escenario> {
  const cantidad = opts.cantidad ?? 2;
  const codigo = opts.codigo ?? (await variante(opts.fisico ?? 50));
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

  it("un pedido apartado en dos bodegas no se despacha: nadie lo armaría de un viaje", async () => {
    const otraBodegaId = id("bod");
    const otraBodega = `Bodega ${otraBodegaId}`;
    await env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)")
      .bind(otraBodegaId, otraBodega)
      .run();

    const aqui = await variante(10);
    const alla = codigoNuevo();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
           publicado,activo,version,actualizado_en) VALUES (?,?,?,1,5000,1,1,1,?)`,
      ).bind(alla, productoId, `pieza ${alla}`, ahora()),
      env.DB.prepare("INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,10,0)").bind(
        alla, otraBodegaId,
      ),
    ]);

    const clienteId = id("cli");
    await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
      .bind(clienteId, "Dos bodegas", ahora(), ahora())
      .run();
    const pedido = await crearPedido(
      { db: env.DB, ahora: ahora(), actor: "prueba", abonoMinimoCents: 500, minutosParaAbonar: null },
      {
        idempotencia: id("idem"), clienteId, origen: "panel",
        lineas: [
          { codigo: aqui, cantidad: 1, bodega },
          { codigo: alla, cantidad: 1, bodega: otraBodega },
        ],
        zona,
      },
    );
    if (!pedido.ok) throw new Error(pedido.mensaje);
    await env.DB.prepare("UPDATE pedidos SET pagado_cents = 500, estado_pago = 'abonado' WHERE id = ?")
      .bind(pedido.datos.id)
      .run();
    if (!(await agendar({ db: env.DB, ahora: ahora(), actor: "p" }, pedido.datos.id)).ok) {
      throw new Error("no se agendó");
    }

    // Mandar al motorizado a una sola bodega por mercancía que está en dos es
    // mandarlo a buscar algo que no está ahí. El sistema no finge que sí.
    const r = await crearEnvio(ctx(), { pedidoId: pedido.datos.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/más de una bodega/i);
  });

  it("lo que guarda el panel es lo que lee la entrega (el choque que hubo)", async () => {
    // Esta prueba existe por un fallo que vivió unas horas: el módulo de
    // ajustes definía `ventanas_entrega` como objetos y el de entregas la
    // leía como textos, cada uno con su propia consulta a la misma tabla. La
    // dueña habría decidido sus ventanas desde el panel y el sistema habría
    // seguido diciendo que faltaban.
    //
    // La diferencia con la prueba de abajo es DE DÓNDE sale el dato: aquí se
    // guarda por el mismo camino que usa el panel, no con un INSERT montado a
    // mano. Un dato de prueba escrito a mano prueba lo que uno cree; este
    // prueba lo que el otro lado escribe de verdad.
    const guardado = await guardarAjuste(
      { db: env.DB, ahora: ahora(), actor: "duena@babycaleb.com" },
      {
        clave: "ventanas_entrega",
        valor: [
          { id: "manana", etiqueta: "Mañana", desde: "08:00", hasta: "12:00" },
          { id: "tarde", etiqueta: "Tarde", desde: "13:00", hasta: "18:00" },
        ],
        motivo: "las que de verdad reparte el motorizado",
      },
    );
    expect(guardado.ok, "el panel no pudo guardar las ventanas").toBe(true);

    const vigentes = await ajustesDeEntrega(env.DB, ahora());
    expect(vigentes.ventanas, "la entrega no ve lo que el panel guardó").toEqual([
      "manana",
      "tarde",
    ]);

    // Y una ventana decidida se acepta de verdad al crear el envío.
    const p = await pedidoAgendado();
    const r = await crearEnvio(ctx(), { pedidoId: p.pedidoId, ventana: "manana" });
    expect(r.ok, "una ventana ya decidida tendría que aceptarse").toBe(true);
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
    // La forma REAL que guarda el panel: objetos con código, nombre y horario.
    //
    // Esta prueba guardaba antes `["manana","tarde"]`, que era la forma que
    // esta función se imaginaba y que el panel nunca escribe. Pasaba en verde
    // mientras el sistema entero habría dicho «las ventanas no están
    // decididas» con la dueña habiéndolas decidido.
    //
    // Ese es el riesgo de montar un dato de prueba a mano: se prueba contra lo
    // que uno cree, no contra lo que el otro lado escribe.
    await env.DB.prepare(
      `INSERT INTO ajustes (clave,version,valor_json,vigente_desde,cambiado_por)
       VALUES ('ventanas_entrega',1,?,?,'prueba')`,
    )
      .bind(
        JSON.stringify([
          { id: "manana", etiqueta: "Mañana", desde: "08:00", hasta: "12:00" },
          { id: "tarde", etiqueta: "Tarde", desde: "13:00", hasta: "18:00" },
        ]),
        ahora() - 1000,
      )
      .run();

    try {
      const vigentes = await ajustesDeEntrega(env.DB, ahora());
      // Lo que vuelve son los CÓDIGOS, que es lo que se escribe en el envío:
      // el nombre se puede cambiar y el código no.
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
    const codigo = await variante(20);
    const e = await enLaCalle({ cantidad: 2, codigo });
    // Otro pedido aparta del MISMO código: sin esto, lo reservado quedaría en
    // cero tras la primera descarga y un segundo descuento chocaría con el
    // `CHECK (reservado >= 0)` de la tabla. Con holgura, la tabla ya no
    // defiende nada y lo que queda a prueba es lo que este archivo escribió.
    await pedidoAgendado({ cantidad: 5, codigo });
    expect(await existencias(codigo)).toEqual({ fisico: 20, reservado: 7 });

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
    // Y el stock se descargó UNA vez: 20 − 2 de físico, y de lo reservado se
    // suelta solo lo de este pedido (7 − 2), no lo del otro.
    expect(await existencias(codigo)).toEqual({ fisico: 18, reservado: 5 });
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
    //
    // Las dos horas son distintas a propósito: es el caso real del reintento
    // un segundo después, y es donde el control tiene que decidir solo.
    const codigo = await variante(20);
    const e = await enLaCalle({ cantidad: 2, codigo, pagar: "todo" });
    // Holgura en lo reservado, para que el `CHECK (reservado >= 0)` de la tabla
    // no sea el que tape el error. Ver la prueba de arriba.
    await pedidoAgendado({ cantidad: 5, codigo });
    const T = ahora();

    const [uno, dos] = await Promise.all([
      marcarEntregada({ db: env.DB, ahora: T, actor: "a" }, { idempotencia: id("idem"), envioId: e.envioId }),
      marcarEntregada({ db: env.DB, ahora: T + 1, actor: "b" }, { idempotencia: id("idem"), envioId: e.envioId }),
    ]);

    expect(uno.ok && dos.ok, `${JSON.stringify(uno)} / ${JSON.stringify(dos)}`).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect([uno.datos.yaEstaba, dos.datos.yaEstaba].filter((x) => x === false)).toHaveLength(1);

    expect(await existencias(codigo)).toEqual({ fisico: 18, reservado: 5 });
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

  it("si la fila de existencias desapareció, no se escribe media venta", async () => {
    const e = await enLaCalle({ cantidad: 1, fisico: 10 });
    // El caso que la fila de control de `db/inventario.ts` existe para cazar.
    // Aquí no hace falta una: la llave foránea (codigo, bodega_id) de
    // `movimientos_inventario` no deja insertar el movimiento sin su fila de
    // existencias, y eso tumba el batch entero. Esta prueba fija ese
    // razonamiento, porque sin ella alguien podría quitar la llave foránea y
    // nada protestaría.
    await env.DB.prepare("DELETE FROM existencias WHERE codigo = ? AND bodega_id = ?")
      .bind(e.codigo, bodegaId)
      .run();

    const r = await marcarEntregada(ctx(), { idempotencia: id("idem"), envioId: e.envioId });
    expect(r.ok).toBe(false);

    // Y no quedó ni la parada marcada ni el movimiento escrito.
    expect((await leerEnvio(e.envioId))?.estado).toBe("en_ruta");
    const mov = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM movimientos_inventario WHERE referencia_id = ?",
    )
      .bind(e.envioId)
      .first<{ n: number }>();
    expect(mov?.n).toBe(0);
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

describe("guardarPrueba", () => {
  /** Los bytes de un WebP de verdad: el tipo sale de mirarlos, no de la cabecera. */
  const webp = () => {
    const b = new Uint8Array(16);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    return b.buffer as ArrayBuffer;
  };

  it("la foto de una entrega entra como SENSIBLE y colgada de su envío", async () => {
    const e = await enLaCalle();
    const r = await guardarPrueba({ ...ctx(), r2: env.PRIVADO }, e.envioId, webp());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const fila = await env.DB.prepare(
      "SELECT tipo, mime, sensible, referencia_tipo, referencia_id, borrar_despues_de FROM archivos WHERE r2_key = ?",
    )
      .bind(r.datos.r2Key)
      .first<{
        tipo: string;
        mime: string;
        sensible: number;
        referencia_tipo: string | null;
        referencia_id: string | null;
        borrar_despues_de: number | null;
      }>();

    // `sensible = 1` es lo único que impide que la puerta de una clienta se
    // sirva por `/foto/` sin sesión. No es un detalle del archivo: es la
    // diferencia entre una foto de un pañal y la casa de alguien.
    expect(fila?.sensible).toBe(1);
    expect(fila?.referencia_tipo).toBe("envio");
    expect(fila?.referencia_id).toBe(e.envioId);
    // Y ya está confirmada: si la subida se hubiera cortado, seguiría marcada.
    expect(fila?.borrar_despues_de).toBeNull();

    // Y sirve para marcar la entrega.
    const marcada = await marcarEntregada(ctx(), {
      idempotencia: id("idem"), envioId: e.envioId, pruebaR2: r.datos.r2Key, metodoCobro: "efectivo",
    });
    expect(marcada.ok, JSON.stringify(marcada)).toBe(true);
    expect((await leerEnvio(e.envioId))?.foto_r2).toBe(r.datos.r2Key);
  });

  it("lo que no son bytes de una imagen no se guarda", async () => {
    const e = await enLaCalle();
    const html = new TextEncoder().encode("<html>no soy una foto</html>").buffer as ArrayBuffer;
    const r = await guardarPrueba({ ...ctx(), r2: env.PRIVADO }, e.envioId, html);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  it("y no se le cuelga una foto a una entrega ya cerrada", async () => {
    const e = await enLaCalle();
    expect(
      (await marcarEntregada(ctx(), {
        idempotencia: id("idem"), envioId: e.envioId, metodoCobro: "efectivo",
      })).ok,
    ).toBe(true);

    const r = await guardarPrueba({ ...ctx(), r2: env.PRIVADO }, e.envioId, webp());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");
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

  it("saca los pedidos agendados que todavía no tienen entrega preparada", async () => {
    const p = await pedidoAgendado();
    const r = await entregasDelDia(env.DB, fechaDePanama(ahora()), ahora());
    if (!r.ok) throw new Error(r.mensaje);
    // Sin esta lista, la dueña abriría la pantalla vacía con trabajo esperando:
    // un pedido agendado sin envío no sale en ninguna de las otras dos listas.
    expect(r.datos.porPreparar.map((x) => x.numero)).toContain(p.numero);
    expect(r.datos.porPreparar.find((x) => x.numero === p.numero)?.saldoCents).toBe(
      p.totalCents - 500,
    );

    // Y en cuanto se le prepara la entrega, deja de estar «por preparar».
    expect((await crearEnvio(ctx(), { pedidoId: p.pedidoId })).ok).toBe(true);
    const despues = await entregasDelDia(env.DB, fechaDePanama(ahora()), ahora());
    if (!despues.ok) throw new Error(despues.mensaje);
    expect(despues.datos.porPreparar.map((x) => x.numero)).not.toContain(p.numero);
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

/**
 * Los asientos de la entrega (F5.1 enganchada).
 *
 * Son lo último que faltaba y lo más fácil de dar por hecho: los veinte
 * constructores de `dominio/contabilidad.ts` ya existían, cuadraban y tenían
 * sus propias pruebas… y nadie los llamaba. Las 76 pruebas de este archivo
 * pasaban en verde con los libros vacíos, que es exactamente por qué estas
 * pruebas miran la TABLA `asientos` y no el valor que devuelve la función.
 *
 * Cada una se validó quitando del batch el asiento que vigila.
 */
describe("los asientos que deja una entrega", () => {
  const asientosDe = async (pedidoId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.hecho, a.fecha, a.origen, a.descripcion, cc.diferencia
         FROM asientos a LEFT JOIN control_cuadre cc ON cc.asiento_id = a.id
        WHERE a.referencia_tipo = 'pedido' AND a.referencia_id = ?
        ORDER BY a.hecho`,
    )
      .bind(pedidoId)
      .all<{
        id: string;
        hecho: string;
        fecha: string;
        origen: string;
        descripcion: string;
        diferencia: number | null;
      }>();
    return results;
  };

  const lineasDe = async (asientoId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT c.codigo, l.debe_cents AS debe, l.haber_cents AS haber
         FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
        WHERE l.asiento_id = ? ORDER BY c.codigo`,
    )
      .bind(asientoId)
      .all<{ codigo: string; debe: number; haber: number }>();
    return results;
  };

  /** El costo promedio cargado, que es lo que hace posible el asiento 3b. */
  const conCosto = (codigo: string, unidades: number, valorCents: number) =>
    env.DB.prepare("INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,?,?)")
      .bind(codigo, unidades, valorCents)
      .run();

  it("reconoce la venta al entregar: anticipo fuera, por cobrar dentro, ingreso sin ITBMS", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const antes = await env.DB.prepare(
      `SELECT total_cents, pagado_cents, subtotal_cents, envio_cents, descuento_cents, itbms_cents
         FROM pedidos WHERE id = ?`,
    )
      .bind(e.pedidoId)
      .first<{
        total_cents: number;
        pagado_cents: number;
        subtotal_cents: number;
        envio_cents: number;
        descuento_cents: number;
        itbms_cents: number;
      }>();
    const total = antes!.total_cents;
    const abonado = antes!.pagado_cents;

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const asientos = await asientosDe(e.pedidoId);
    const venta = asientos.find((a) => a.hecho === "3");
    expect(venta, `asientos: ${JSON.stringify(asientos)}`).toBeDefined();
    expect(venta?.origen).toBe("entrega");
    expect(venta?.descripcion).toContain(e.numero);

    const lineas = await lineasDe(venta!.id);
    // El anticipo que había deja de ser deuda y lo que falta se vuelve cuenta
    // por cobrar. Del otro lado, el ingreso NO entra de una pieza:
    //
    //  · 4101 lleva la mercancía (subtotal menos descuento),
    //  · 4102 lleva el envío, aparte, porque la dueña necesita poder ver si
    //    el envío le cuesta más de lo que cobra por él —es una de las once
    //    cosas que todavía están PENDIENTES en su documento—, y metido en
    //    ventas esa pregunta ya no se puede contestar;
    //  · 2201 no tiene línea porque hoy el ITBMS es 0, y eso no es «el
    //    impuesto es cero»: es que la tasa sigue PENDIENTE y por eso la
    //    columna vale 0. Cuando ella la decida, esta línea aparece sola.
    //
    // Esta prueba empezó esperando `4101 = total` y se puso roja. El código
    // tenía razón y la expectativa no; se queda así de explícita para que la
    // separación del envío sea algo que una prueba defiende, no un detalle.
    expect(antes!.envio_cents, "el escenario tiene que traer envío").toBeGreaterThan(0);
    expect(lineas).toEqual([
      { codigo: "1201", debe: total - abonado, haber: 0 },
      { codigo: "2101", debe: abonado, haber: 0 },
      { codigo: "4101", debe: 0, haber: antes!.subtotal_cents - antes!.descuento_cents },
      { codigo: "4102", debe: 0, haber: antes!.envio_cents },
    ]);
    // Y el asiento entero suma lo mismo por los dos lados.
    expect(lineas.reduce((t, l) => t + l.debe, 0)).toBe(total);
    expect(lineas.reduce((t, l) => t + l.haber, 0)).toBe(total);
  });

  it("el cobro en efectivo va a la caja del motorizado, y la caja nace en el mismo batch", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const antes = await leerPedido(e.pedidoId);
    const saldo = antes!.total_cents - antes!.pagado_cents;

    // La caja no existe ANTES: la crea el primer cobro que la usa.
    const codigoCaja = `1104-${e.motorizado.id}`;
    const sinCaja = await env.DB.prepare("SELECT codigo FROM cuentas WHERE codigo = ?")
      .bind(codigoCaja)
      .first();
    expect(sinCaja).toBeNull();

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const caja = await env.DB.prepare(
      "SELECT nombre, tipo, subtipo, motorizado_id FROM cuentas WHERE codigo = ?",
    )
      .bind(codigoCaja)
      .first<{ nombre: string; tipo: string; subtipo: string; motorizado_id: string }>();
    expect(caja).toEqual({
      nombre: `Caja de ${e.motorizado.nombre}`,
      tipo: "activo",
      subtipo: "caja_motorizado",
      motorizado_id: e.motorizado.id,
    });

    const cobro = (await asientosDe(e.pedidoId)).find((a) => a.hecho === "4");
    expect(cobro, "falta el asiento 4").toBeDefined();
    expect(await lineasDe(cobro!.id)).toEqual([
      { codigo: codigoCaja, debe: saldo, haber: 0 },
      { codigo: "1201", debe: 0, haber: saldo },
    ]);
  });

  it("por Yappy es el 4b y el dinero está ya en la cuenta, no en la calle", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const antes = await leerPedido(e.pedidoId);
    const saldo = antes!.total_cents - antes!.pagado_cents;

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "yappy",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const asientos = await asientosDe(e.pedidoId);
    expect(asientos.map((a) => a.hecho)).toContain("4b");
    expect(asientos.map((a) => a.hecho)).not.toContain("4");

    const cobro = asientos.find((a) => a.hecho === "4b")!;
    expect(await lineasDe(cobro.id)).toEqual([
      { codigo: "1101", debe: saldo, haber: 0 },
      { codigo: "1201", debe: 0, haber: saldo },
    ]);
    // Y no se creó ninguna caja: por Yappy el motorizado no toca el dinero.
    const caja = await env.DB.prepare("SELECT codigo FROM cuentas WHERE codigo = ?")
      .bind(`1104-${e.motorizado.id}`)
      .first();
    expect(caja).toBeNull();
  });

  it("cobrar con «otro» no inventa una cuenta: deja el saldo en 1201 y el pedido pagado", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const antes = await leerPedido(e.pedidoId);
    const saldo = antes!.total_cents - antes!.pagado_cents;

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "otro",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    // El dinero entró de verdad: esto no es un cobro a medias.
    expect(r.datos.cobradoCents).toBe(saldo);
    expect((await leerPedido(e.pedidoId))?.estado_pago).toBe("pagado");

    // Pero NO hay asiento de cobro, porque no se sabe a qué cuenta entró y los
    // dieciocho asientos del documento no tienen uno para «no sé dónde está».
    // Meterlo en 1103 «porque suena razonable» sería una cifra a ojo.
    const asientos = await asientosDe(e.pedidoId);
    expect(asientos.map((a) => a.hecho)).toContain("3");
    expect(asientos.map((a) => a.hecho)).not.toContain("4");
    expect(asientos.map((a) => a.hecho)).not.toContain("4b");

    // El hueco queda a la vista, que es el punto: 1201 se queda con el saldo
    // mientras el pedido dice que está pagado. Lo canta la casilla «lo por
    // cobrar cuadra con 1201» del cierre de mes.
    const venta = asientos.find((a) => a.hecho === "3")!;
    const porCobrar = (await lineasDe(venta.id)).find((l) => l.codigo === "1201");
    expect(porCobrar?.debe).toBe(saldo);
  });

  it("sin costo promedio no escribe un cero: el 3b no existe y el pedido queda sin costo", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.costoDesconocido).toBe(true);

    // Un 3b en cero afirmaría que la mercancía no costó nada, y eso pone el
    // margen en 100 %: la ganancia más bonita y más falsa que hay.
    expect((await asientosDe(e.pedidoId)).map((a) => a.hecho)).not.toContain("3b");
  });

  it("con costo promedio cargado sí escribe el 3b, y es el costo del momento", async () => {
    const codigo = await variante(10);
    // 10 unidades valen $20.00 → $2.00 cada una. Se llevan 3 → $6.00.
    await conCosto(codigo, 10, 2000);
    const e = await enLaCalle({ cantidad: 3, codigo });

    const r = await marcarEntregada(ctx(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.costoDesconocido).toBe(false);

    const costo = (await asientosDe(e.pedidoId)).find((a) => a.hecho === "3b");
    expect(costo, "falta el asiento 3b").toBeDefined();
    expect(await lineasDe(costo!.id)).toEqual([
      { codigo: "1301", debe: 0, haber: 600 },
      { codigo: "5101", debe: 600, haber: 0 },
    ]);
  });

  it("todos los asientos de la entrega cuadran y llevan la fecha de Panamá", async () => {
    const codigo = await variante(10);
    await conCosto(codigo, 10, 2000);
    const T = Date.UTC(2026, 10, 12, 2, 0, 0); // 11 de noviembre, 21:00 en Panamá
    const e = await enLaCalle({ cantidad: 2, codigo });

    const r = await marcarEntregada(
      { db: env.DB, ahora: T, actor: "yarielis@babycaleb.com" },
      {
        idempotencia: id("idem"),
        envioId: e.envioId,
        motorizadoId: e.motorizado.id,
        metodoCobro: "efectivo",
      },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const asientos = await asientosDe(e.pedidoId);
    expect(asientos.map((a) => a.hecho).sort()).toEqual(["3", "3b", "4"]);
    for (const a of asientos) {
      // Su fila de cuadre existe y la diferencia es cero. Sin la fila, el
      // asiento estaría a medias y el cierre lo cantaría.
      expect(a.diferencia, `asiento ${a.hecho} sin cuadrar`).toBe(0);
      // El día del negocio, no el de UTC: a las 21:00 de Panamá UTC ya es el 12.
      expect(a.fecha, `asiento ${a.hecho}`).toBe("2026-11-11");
    }
  });

  it("el mismo toque dos veces no duplica los asientos", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const entrada = {
      idempotencia: id("idem"),
      envioId: e.envioId,
      motorizadoId: e.motorizado.id,
      metodoCobro: "efectivo" as const,
    };

    expect((await marcarEntregada(ctx(), entrada)).ok).toBe(true);
    const unaVez = await asientosDe(e.pedidoId);
    expect((await marcarEntregada(ctx(), entrada)).ok).toBe(true);

    // Dos asientos iguales descuadran nada —cada uno cuadra por su lado— así
    // que nada los delataría salvo el saldo, que estaría al doble.
    expect((await asientosDe(e.pedidoId)).map((a) => a.hecho)).toEqual(
      unaVez.map((a) => a.hecho),
    );
  });

  /**
   * Las dos casillas del cierre que vigilan justo esto.
   *
   * Cada prueba entrega en un MES PROPIO del pasado —`marcarEntregada` no
   * valida la fecha y `entregado_en` sale de `ctx.ahora`— porque la revisión se
   * pide por mes y este archivo no aísla el almacenamiento entre pruebas: si
   * las dos miraran el mes de hoy, la que espera «ok» dependería de correr
   * antes que la que entrega con «otro».
   */
  const casilla = async (mes: string, clave: string) => {
    const r = await revisionDeCierre({ db: env.DB, ahora: Date.now() }, mes);
    if (!r.ok) throw new Error(`no se pudo revisar ${mes}: ${r.mensaje}`);
    const c = r.datos.casillas.find((x) => x.clave === clave);
    if (c === undefined) throw new Error(`no existe la casilla ${clave}`);
    return c;
  };

  it("un mes cobrado como se debe deja las dos casillas del cierre en «ok»", async () => {
    const codigo = await variante(10);
    await conCosto(codigo, 10, 2000);
    const e = await enLaCalle({ cantidad: 2, codigo });
    const T = Date.UTC(2025, 2, 18, 15, 0, 0); // marzo de 2025, mes propio

    expect(
      (
        await marcarEntregada(
          { db: env.DB, ahora: T, actor: "yarielis@babycaleb.com" },
          {
            idempotencia: id("idem"),
            envioId: e.envioId,
            motorizadoId: e.motorizado.id,
            metodoCobro: "efectivo",
          },
        )
      ).ok,
    ).toBe(true);

    expect((await casilla("2025-03", "venta_sin_asiento")).estado).toBe("ok");
    expect((await casilla("2025-03", "cobro_sin_asiento")).estado).toBe("ok");
  });

  it("una entrega sin asiento de venta bloquea el cierre: es la historia de antes", async () => {
    // Lo que esta casilla defiende de verdad NO se puede provocar con
    // `marcarEntregada`, porque desde hoy toda entrega escribe su asiento 3.
    // Defiende lo de ANTES: las entregas que Baby Caleb ya hizo mientras el
    // sistema no llevaba libros, y que van a aparecer en cuanto se importe
    // historia o se mueva un pedido a mano. Así que el escenario se arma con
    // UPDATE, que es exactamente la forma en que ese estado puede existir.
    //
    // Sin esta prueba la casilla sobrevivía a la mutación «estado: siempre
    // ok»: las otras dos pruebas solo la veían decir «ok», que es lo que una
    // casilla rota también dice.
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const T = Date.UTC(2025, 4, 18, 15, 0, 0); // mayo de 2025, mes propio

    expect((await casilla("2025-05", "venta_sin_asiento")).estado).toBe("ok");

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE envios SET estado = 'entregado', entregado_en = ?, cobrado_cents = 0 WHERE id = ?",
      ).bind(T, e.envioId),
      env.DB.prepare("UPDATE pedidos SET estado = 'entregado' WHERE id = ?").bind(e.pedidoId),
    ]);

    const c = await casilla("2025-05", "venta_sin_asiento");
    expect(c.estado).toBe("falta");
    expect(c.detalle).toContain("1 pedidos");

    const r = await revisionDeCierre({ db: env.DB, ahora: Date.now() }, "2025-05");
    expect(r.ok && r.datos.sePuedeCerrar).toBe(false);
  });

  it("cobrar con «otro» bloquea el cierre del mes y dice qué hacer", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10 });
    const T = Date.UTC(2025, 3, 18, 15, 0, 0); // abril de 2025, mes propio

    expect((await casilla("2025-04", "cobro_sin_asiento")).estado).toBe("ok");

    expect(
      (
        await marcarEntregada(
          { db: env.DB, ahora: T, actor: "yarielis@babycaleb.com" },
          {
            idempotencia: id("idem"),
            envioId: e.envioId,
            motorizadoId: e.motorizado.id,
            metodoCobro: "otro",
          },
        )
      ).ok,
    ).toBe(true);

    // La venta SÍ quedó escrita: lo que falta es solo saber dónde entró el
    // dinero. Las dos casillas dicen cosas distintas a propósito.
    expect((await casilla("2025-04", "venta_sin_asiento")).estado).toBe("ok");

    const c = await casilla("2025-04", "cobro_sin_asiento");
    expect(c.estado).toBe("falta");
    expect(c.detalle).toContain("1 entregas");
    // Y no se queda en el diagnóstico: dice dónde se arregla.
    expect(c.detalle).toMatch(/asiento nuevo/);

    // «falta» bloquea el cierre. Es el punto de la casilla: no saber dónde
    // está el dinero no se cierra, se resuelve.
    const r = await revisionDeCierre({ db: env.DB, ahora: Date.now() }, "2025-04");
    expect(r.ok && r.datos.sePuedeCerrar).toBe(false);
  });
});
