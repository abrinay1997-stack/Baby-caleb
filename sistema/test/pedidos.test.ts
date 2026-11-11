import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Lo que el esquema de pedidos y pagos IMPIDE (F4.1).
 *
 * No se comprueba que el SQL esté bien escrito —eso lo haría cualquier
 * SQLite— sino que D1 HACE CUMPLIR lo que el diseño da por sentado. Si D1
 * ignorara un CHECK o una llave foránea, el resto del plan se cae: el dinero
 * de un pedido dejaría de cuadrar sin que nada fallara.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let clienteId: string;
let bodegaId: string;
let codigo: string;

beforeEach(async () => {
  clienteId = id("cli");
  await env.DB.prepare(
    "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)",
  )
    .bind(clienteId, "Ana", ahora(), ahora())
    .run();

  const b = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
  const v = await env.DB.prepare("SELECT codigo FROM variantes LIMIT 1").first<{ codigo: string }>();
  bodegaId = b?.id ?? "";
  codigo = v?.codigo ?? "";
  expect(bodegaId, "la carga inicial tiene que haber dejado bodegas").not.toBe("");
  expect(codigo, "la carga inicial tiene que haber dejado variantes").not.toBe("");
});

/** Un pedido válido; `sobre` cambia lo que cada prueba quiera romper. */
async function crearPedido(sobre: Record<string, unknown> = {}) {
  const p = {
    id: id("ped"),
    numero: `BC-${String(n).padStart(6, "0")}-${Date.now()}`,
    token: id("tok"),
    cliente_id: clienteId,
    origen: "web",
    estado: "por_abonar",
    estado_pago: "sin_pago",
    subtotal_cents: 5000,
    envio_cents: 800,
    descuento_cents: 0,
    itbms_cents: 0,
    total_cents: 5800,
    pagado_cents: 0,
    abono_minimo_cents: 500,
    ...sobre,
  };

  await env.DB.prepare(
    `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
       subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
       abono_minimo_cents,creado_en,actualizado_en)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      p.id, p.numero, p.token, p.cliente_id, p.origen, p.estado, p.estado_pago,
      p.subtotal_cents, p.envio_cents, p.descuento_cents, p.itbms_cents,
      p.total_cents, p.pagado_cents, p.abono_minimo_cents, ahora(), ahora(),
    )
    .run();
  return p.id;
}

describe("el dinero de un pedido tiene que cuadrar", () => {
  it("un pedido bien sumado entra", async () => {
    await expect(crearPedido()).resolves.toBeTruthy();
  });

  it("un total que no es la suma de sus partes NO entra", async () => {
    // Es el error que nadie ve: el pedido se guarda, la clienta paga otra
    // cosa, y la diferencia aparece semanas después en la contabilidad.
    await expect(crearPedido({ total_cents: 9999 })).rejects.toThrow();
  });

  it("el descuento resta y el ITBMS suma, y la cuenta sigue cuadrando", async () => {
    await expect(
      crearPedido({
        subtotal_cents: 5000, envio_cents: 800, descuento_cents: 500,
        itbms_cents: 350, total_cents: 5650,
      }),
    ).resolves.toBeTruthy();

    await expect(
      crearPedido({
        subtotal_cents: 5000, envio_cents: 800, descuento_cents: 500,
        itbms_cents: 350, total_cents: 5000,
      }),
    ).rejects.toThrow();
  });

  it("nadie puede haber pagado MÁS de lo que vale el pedido", async () => {
    await expect(crearPedido({ pagado_cents: 5900 })).rejects.toThrow();
    await expect(crearPedido({ pagado_cents: 5800 })).resolves.toBeTruthy();
  });

  it("ni un monto negativo en ninguna parte", async () => {
    await expect(crearPedido({ subtotal_cents: -1, total_cents: 799 })).rejects.toThrow();
    await expect(crearPedido({ envio_cents: -800, total_cents: 4200 })).rejects.toThrow();
  });
});

describe("los estados son una lista cerrada", () => {
  it("un estado inventado NO entra", async () => {
    await expect(crearPedido({ estado: "casi_listo" })).rejects.toThrow();
    await expect(crearPedido({ estado_pago: "mas_o_menos" })).rejects.toThrow();
  });

  it("ni un origen inventado", async () => {
    await expect(crearPedido({ origen: "tiktok" })).rejects.toThrow();
  });

  it("los seis estados del plan sí entran", async () => {
    for (const e of ["por_abonar", "agendado", "en_ruta", "entregado", "cancelado", "devuelto"]) {
      await expect(crearPedido({ estado: e }), e).resolves.toBeTruthy();
    }
  });
});

describe("el número y el token son de cada pedido", () => {
  it("dos pedidos no pueden compartir número", async () => {
    const numero = `BC-repetido-${Date.now()}`;
    await crearPedido({ numero });
    await expect(crearPedido({ numero })).rejects.toThrow();
  });

  it("ni token: es lo que abre el enlace de seguimiento", async () => {
    const token = id("tok-repe");
    await crearPedido({ token });
    await expect(crearPedido({ token })).rejects.toThrow();
  });
});

describe("una línea de pedido", () => {
  it("se guarda con el nombre COPIADO, no con una referencia", async () => {
    // Si mañana se renombra la variante, el pedido de hoy tiene que seguir
    // diciendo lo que la clienta compró.
    const pedidoId = await crearPedido();
    await env.DB.prepare(
      `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,bodega_id)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(id("lin"), pedidoId, codigo, "Pañal Nateen Talla M (como se llamaba hoy)", 2, 5000, bodegaId)
      .run();

    const fila = await env.DB.prepare(
      "SELECT nombre, costo_unit_cents FROM pedido_lineas WHERE pedido_id = ?",
    )
      .bind(pedidoId)
      .first<{ nombre: string; costo_unit_cents: number | null }>();
    expect(fila?.nombre).toContain("como se llamaba hoy");
    // El costo se fija AL ENTREGAR. Nulo antes: no se sabe, y un cero sería
    // afirmar que no costó nada.
    expect(fila?.costo_unit_cents).toBeNull();
  });

  it("no puede pedir cero unidades", async () => {
    const pedidoId = await crearPedido();
    await expect(
      env.DB.prepare(
        `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,bodega_id)
         VALUES (?,?,?,?,0,?,?)`,
      )
        .bind(id("lin"), pedidoId, codigo, "x", 5000, bodegaId)
        .run(),
    ).rejects.toThrow();
  });

  it("ni apuntar a una variante que no existe", async () => {
    const pedidoId = await crearPedido();
    await expect(
      env.DB.prepare(
        `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,bodega_id)
         VALUES (?,?,'NO-EXISTE','x',1,5000,?)`,
      )
        .bind(id("lin"), pedidoId, bodegaId)
        .run(),
    ).rejects.toThrow();
  });
});

describe("la bitácora del pedido no se toca", () => {
  it("no se borra ni se edita", async () => {
    // Es lo que explica por qué un pedido está donde está. Misma regla que los
    // movimientos de inventario.
    const pedidoId = await crearPedido();
    const eventoId = id("ev");
    await env.DB.prepare(
      "INSERT INTO pedido_eventos (id,pedido_id,tipo,a,actor,creado_en) VALUES (?,?,?,?,?,?)",
    )
      .bind(eventoId, pedidoId, "creado", "por_abonar", "panel", ahora())
      .run();

    await expect(
      env.DB.prepare("DELETE FROM pedido_eventos WHERE id = ?").bind(eventoId).run(),
    ).rejects.toThrow(/no se borra/);

    await expect(
      env.DB.prepare("UPDATE pedido_eventos SET a = 'entregado' WHERE id = ?").bind(eventoId).run(),
    ).rejects.toThrow(/no se edita/);
  });
});

describe("los pagos", () => {
  const crearPago = async (pedidoId: string, sobre: Record<string, unknown> = {}) => {
    const p = {
      id: id("pag"), pedido_id: pedidoId, proveedor: "manual", metodo: "transferencia",
      tipo: "abono", estado: "creado", monto_cents: 500, intento_ref: id("ref"), ...sobre,
    };
    await env.DB.prepare(
      `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,intento_ref,creado_en,actualizado_en)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(p.id, p.pedido_id, p.proveedor, p.metodo, p.tipo, p.estado, p.monto_cents, p.intento_ref, ahora(), ahora())
      .run();
    return p.id;
  };

  it("un pago normal entra", async () => {
    await expect(crearPago(await crearPedido())).resolves.toBeTruthy();
  });

  it("un monto de cero no es un pago", async () => {
    await expect(crearPago(await crearPedido(), { monto_cents: 0 })).rejects.toThrow();
  });

  it("un proveedor que no existe no entra", async () => {
    await expect(crearPago(await crearPedido(), { proveedor: "bitcoin" })).rejects.toThrow();
  });

  it("el mismo intento NO se puede cobrar dos veces", async () => {
    // `intento_ref` es nuestro id hacia la pasarela. Si se repitiera, un
    // reintento se cobraría por segunda vez.
    const pedidoId = await crearPedido();
    const ref = id("mismo-intento");
    await crearPago(pedidoId, { intento_ref: ref });
    await expect(crearPago(pedidoId, { intento_ref: ref })).rejects.toThrow();
  });

  it("la cuenta contable se deja vacía hasta F5, y eso NO rompe nada", async () => {
    // `cuentas` todavía no existe. La columna está sin llave foránea a
    // propósito: SQLite no deja añadir una con ALTER, así que la 0006 no puede
    // apuntar a una tabla del futuro.
    const pagoId = await crearPago(await crearPedido());
    const f = await env.DB.prepare("SELECT cuenta_id FROM pagos WHERE id = ?")
      .bind(pagoId)
      .first<{ cuenta_id: string | null }>();
    expect(f?.cuenta_id).toBeNull();
  });
});

describe("los avisos de una pasarela no se aplican dos veces", () => {
  it("el mismo evento del mismo proveedor se rechaza", async () => {
    // Las pasarelas reintentan cuando no reciben un 200 a tiempo. Sin esto, un
    // reintento confirmaría un pago por segunda vez.
    const evento = id("evt");
    const meter = () =>
      env.DB.prepare(
        "INSERT INTO eventos_pasarela (id,proveedor,evento_id,firma_valida,cuerpo_sha256,recibido_en) VALUES (?,?,?,1,?,?)",
      )
        .bind(id("ep"), "yappy", evento, "sha", ahora())
        .run();

    await expect(meter()).resolves.toBeTruthy();
    await expect(meter()).rejects.toThrow();
  });

  it("pero el mismo id desde OTRO proveedor sí entra", async () => {
    const evento = id("evt-compartido");
    for (const proveedor of ["yappy", "tilopay", "paypal"]) {
      await expect(
        env.DB.prepare(
          "INSERT INTO eventos_pasarela (id,proveedor,evento_id,firma_valida,cuerpo_sha256,recibido_en) VALUES (?,?,?,0,?,?)",
        )
          .bind(id("ep"), proveedor, evento, "sha", ahora())
          .run(),
        proveedor,
      ).resolves.toBeTruthy();
    }
  });
});

describe("una liquidación tiene que cuadrar", () => {
  const liquidar = (bruto: number, comision: number, neto: number) =>
    env.DB.prepare(
      "INSERT INTO liquidaciones (id,proveedor,fecha,bruto_cents,comision_cents,neto_cents,creado_en) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id("liq"), "tilopay", "2026-11-10", bruto, comision, neto, ahora())
      .run();

  it("neto = bruto - comisión, o no entra", async () => {
    await expect(liquidar(10000, 350, 9650)).resolves.toBeTruthy();
    await expect(liquidar(10000, 350, 10000)).rejects.toThrow();
  });
});
