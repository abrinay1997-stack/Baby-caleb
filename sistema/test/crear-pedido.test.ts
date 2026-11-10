import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { crearPedido, type ContextoPedido } from "../src/db/pedidos";

/**
 * Crear un pedido (F4.2).
 *
 * Lo que de verdad se vigila aquí no es que el pedido se guarde: es que la
 * RESERVA y el pedido entren o no entren juntos. D1 no tiene transacciones
 * interactivas, así que entre «miro si hay stock» y «lo reservo» cabe otro
 * pedido. Si esa carrera se pierde en silencio, se vende dos veces la última
 * caja y alguien se queda esperando algo que no existe.
 */

let clienteId: string;
let n = 0;
const ahora = () => Date.now();

const ctx = (sobre: Partial<ContextoPedido> = {}): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: "pruebas",
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
  ...sobre,
});

beforeEach(async () => {
  clienteId = `cli-${Date.now()}-${n++}`;
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, "Ana", ahora(), ahora())
    .run();

  // Un inventario conocido para cada prueba. `existencias` no se borra —los
  // movimientos la respaldan— así que se FIJA.
  await env.DB.batch([
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 10 WHERE codigo = 'NAT-M' AND bodega_id = (SELECT id FROM bodegas WHERE activa = 1 LIMIT 1)",
    ),
  ]);
});

const pedir = (lineas: { codigo: string; cantidad: number }[], sobre = {}) =>
  crearPedido(ctx(), {
    idempotencia: `idem-${Date.now()}-${n++}`,
    clienteId,
    origen: "web",
    lineas,
    ...sobre,
  });

describe("el camino normal", () => {
  it("crea el pedido, lo numera y reserva", async () => {
    const r = await pedir([{ codigo: "NAT-M", cantidad: 2 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos.numero).toMatch(/^BC-\d{6}$/);
    expect(r.datos.totalCents).toBe(10000); // 2 × $50, sin envío
    expect(r.datos.token.length).toBeGreaterThan(32);

    const e = await env.DB.prepare(
      "SELECT SUM(reservado) AS r FROM existencias WHERE codigo = 'NAT-M'",
    ).first<{ r: number }>();
    expect(e?.r).toBe(2);
  });

  it("el precio sale del CATÁLOGO, no de quien pide", async () => {
    // Si el precio viniera de fuera, cualquiera compraría una caja a un
    // centavo cambiando un número antes de enviar.
    const r = await pedir([
      { codigo: "NAT-M", cantidad: 1, precioUnitCents: 1 } as never,
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.totalCents).toBe(5000);
  });

  it("dos pedidos no se llevan el mismo número", async () => {
    const a = await pedir([{ codigo: "NAT-M", cantidad: 1 }]);
    const b = await pedir([{ codigo: "NAT-M", cantidad: 1 }]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.datos.numero).not.toBe(b.datos.numero);
  });

  it("deja su evento en la bitácora", async () => {
    const r = await pedir([{ codigo: "NAT-M", cantidad: 1 }]);
    if (!r.ok) return;
    const ev = await env.DB.prepare(
      "SELECT tipo, a FROM pedido_eventos WHERE pedido_id = ?",
    )
      .bind(r.datos.id)
      .first<{ tipo: string; a: string }>();
    expect(ev).toMatchObject({ tipo: "creado", a: "por_abonar" });
  });
});

describe("el envío sale de la ZONA", () => {
  it("una zona con tarifa fija la cobra", async () => {
    const r = await pedir([{ codigo: "NAT-M", cantidad: 1 }], { zona: "Tocumen" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.envioCents).toBe(800);
      expect(r.datos.totalCents).toBe(5800);
    }
  });

  it("una zona SIN tarifa no estima un número", async () => {
    // Panamá Oeste y el interior se cotizan con una persona. Poner una cifra
    // a ojo aquí es cobrarle a una clienta algo que nadie decidió.
    const r = await pedir([{ codigo: "NAT-M", cantidad: 1 }], { zona: "Panamá Oeste" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.envioCents).toBe(0);
  });

  it("una zona que no existe se rechaza, no se ignora", async () => {
    const r = await pedir([{ codigo: "NAT-M", cantidad: 1 }], { zona: "Tokio" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});

describe("las reglas se COPIAN al pedido", () => {
  it("el abono mínimo queda escrito en la fila", async () => {
    // Si la dueña lo sube el martes, el pedido del lunes se cierra con la
    // regla del lunes. Una regla que cambia a mitad es una discusión.
    const r = await crearPedido(ctx({ abonoMinimoCents: 1500 }), {
      idempotencia: `idem-${n++}`,
      clienteId,
      origen: "panel",
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const f = await env.DB.prepare("SELECT abono_minimo_cents FROM pedidos WHERE id = ?")
      .bind(r.datos.id)
      .first<{ abono_minimo_cents: number }>();
    expect(f?.abono_minimo_cents).toBe(1500);
  });

  it("sin minutos para abonar, el pedido no vence", async () => {
    const r = await crearPedido(ctx({ minutosParaAbonar: null }), {
      idempotencia: `idem-${n++}`,
      clienteId,
      origen: "panel",
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.venceEn).toBeNull();
  });
});

describe("no se vende lo que no hay", () => {
  it("pedir más de lo que queda se rechaza", async () => {
    const r = await pedir([{ codigo: "NAT-M", cantidad: 11 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("sin_stock");
  });

  it("y cuando se rechaza, NO queda nada a medias", async () => {
    // Es lo que importa: ni pedido huérfano ni reserva fantasma.
    const antes = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos").first<{ n: number }>();
    await pedir([{ codigo: "NAT-M", cantidad: 99 }]);
    const despues = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos").first<{ n: number }>();
    expect(despues?.n).toBe(antes?.n);

    const e = await env.DB.prepare(
      "SELECT SUM(reservado) AS r FROM existencias WHERE codigo = 'NAT-M'",
    ).first<{ r: number }>();
    expect(e?.r).toBe(0);
  });

  it("las reservas se SUMAN: diez cajas no se venden tres veces", async () => {
    expect((await pedir([{ codigo: "NAT-M", cantidad: 6 }])).ok).toBe(true);
    expect((await pedir([{ codigo: "NAT-M", cantidad: 4 }])).ok).toBe(true);
    // Ya no queda nada libre, aunque el físico siga siendo 10.
    const tercero = await pedir([{ codigo: "NAT-M", cantidad: 1 }]);
    expect(tercero.ok).toBe(false);
  });

  it("una variante que no existe se rechaza", async () => {
    const r = await pedir([{ codigo: "NO-EXISTE", cantidad: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  it("un pedido sin líneas no es un pedido", async () => {
    const r = await pedir([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });

  it("una cantidad absurda se rechaza en vez de redondearse", async () => {
    for (const mala of [0, -2, 1.5, Number.NaN]) {
      const r = await pedir([{ codigo: "NAT-M", cantidad: mala }]);
      expect(r.ok, `aceptó ${mala}`).toBe(false);
    }
  });
});

describe("la fila de control: qué protege exactamente", () => {
  it("una bodega SIN fila de existencias no crea un pedido sin reserva", async () => {
    // Este es el caso que la fila de control caza y nada más caza. Un
    // `UPDATE … WHERE codigo=? AND bodega_id=?` que no casa con ninguna fila
    // NO falla: afecta cero filas y sigue. Sin el control, el pedido se
    // crearía con su línea, su número y su evento — y sin reservar nada.
    // Nadie se enteraría hasta que faltara la mercancía.
    const bodega = `Bodega recién abierta ${Date.now()}-${n++}`;
    await env.DB.prepare("INSERT INTO bodegas (id,nombre) VALUES (?,?)")
      .bind(`bod-${n++}`, bodega)
      .run();

    const antes = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos").first<{ n: number }>();
    const r = await crearPedido(ctx(), {
      idempotencia: `idem-${n++}`,
      clienteId,
      origen: "panel",
      lineas: [{ codigo: "NAT-M", cantidad: 1, bodega }],
    });

    expect(r.ok, "no puede crearse un pedido que no reserva nada").toBe(false);
    const despues = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos").first<{ n: number }>();
    expect(despues?.n).toBe(antes?.n);
  });

  it("reservar de más lo caza la TABLA, no el control", async () => {
    // Conviene tenerlo separado para no creer que el control protege algo que
    // protege otra cosa: `existencias` lleva `CHECK (reservado <= fisico)`.
    await env.DB.prepare("UPDATE existencias SET reservado = fisico WHERE codigo = 'NAT-M'").run();
    const fila = await env.DB.prepare(
      "SELECT nombre FROM bodegas WHERE activa = 1 LIMIT 1",
    ).first<{ nombre: string }>();
    expect(fila, "la carga inicial tiene que haber dejado bodegas").not.toBeNull();
    const bodega = fila?.nombre ?? "";

    const r = await crearPedido(ctx(), {
      idempotencia: `idem-${n++}`,
      clienteId,
      origen: "panel",
      lineas: [{ codigo: "NAT-M", cantidad: 1, bodega }],
    });
    expect(r.ok).toBe(false);

    const e = await env.DB.prepare(
      "SELECT MIN(fisico - reservado) AS libres FROM existencias WHERE codigo = 'NAT-M'",
    ).first<{ libres: number }>();
    expect(e?.libres, "las libres nunca pueden quedar en negativo").toBeGreaterThanOrEqual(0);
  });
});
