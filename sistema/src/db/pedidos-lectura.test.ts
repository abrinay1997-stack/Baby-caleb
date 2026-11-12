import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ESTADOS_PEDIDO } from "../dominio/estado-pedido";
import { leerPedido, listarPedidos } from "./pedidos-lectura";

/**
 * Leer pedidos.
 *
 * Lo que más se vigila aquí no es que la lista salga ordenada: es que **el
 * dinero y el costo se recorten en la consulta y no en la pantalla**. Un dato
 * escondido con CSS viajó hasta el navegador, y ahí lo ve cualquiera que abra
 * las herramientas del navegador.
 */

const T = 1_800_000_000_000;
let n = 0;
const TODO = { veDinero: true, veCosto: true };
const SOLO_PEDIDOS = { veDinero: false, veCosto: false };

let bodegaId: string;
let clienteId: string;

async function unPedido(sobre: {
  numero?: string;
  estado?: string;
  total?: number;
  pagado?: number;
  cliente?: string;
  creado?: number;
} = {}): Promise<string> {
  const suf = `${Date.now()}-${n++}`;
  const pedidoId = `ped-${suf}`;
  const total = sobre.total ?? 10000;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pedidos
         (id,numero,token,cliente_id,origen,estado,estado_pago,
          subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,
          pagado_cents,abono_minimo_cents,requiere_pago_total,creado_en,actualizado_en)
       VALUES (?,?,?,?,'web',?,'abonado',?,0,0,0,?,?,500,0,?,?)`,
    ).bind(
      pedidoId,
      sobre.numero ?? `BC-${suf}`,
      `tok-${suf}`,
      clienteId,
      sobre.estado ?? "agendado",
      total,
      total,
      sobre.pagado ?? 2500,
      sobre.creado ?? T,
      T,
    ),
    env.DB.prepare(
      `INSERT INTO pedido_lineas
         (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,itbms_bp,costo_unit_cents,bodega_id)
       VALUES (?,?, 'NAT-M','Pañal Nateen M',2,5000,0,3000,?)`,
    ).bind(`lin-${suf}`, pedidoId, bodegaId),
  ]);
  return pedidoId;
}

beforeEach(async () => {
  const suf = `${Date.now()}-${n++}`;
  bodegaId = `bod-${suf}`;
  clienteId = `cli-${suf}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO bodegas (id,nombre) VALUES (?,?)").bind(bodegaId, `Bodega ${suf}`),
    env.DB.prepare(
      "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,'Ana Pérez',?,?)",
    ).bind(clienteId, T, T),
    env.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p-ped','panal','Pañal','panal-ped',?)",
    ).bind(T),
    env.DB.prepare(
      `INSERT OR IGNORE INTO variantes
         (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en)
       VALUES ('NAT-M','p-ped','Pañal Nateen M','M',144,5000,0,1,?)`,
    ).bind(T),
  ]);
});

describe("quién ve qué", () => {
  it("sin permiso de cobros, el dinero NO sale de la base", async () => {
    await unPedido();
    const r = await listarPedidos(env.DB, SOLO_PEDIDOS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.datos.pedidos[0]!;
    // Nulo, no cero: cero afirmaría que el pedido vale cero.
    expect(p.total_cents).toBeNull();
    expect(p.pagado_cents).toBeNull();
    expect(p.saldo_cents).toBeNull();
    // Y lo que sí puede ver sigue estando.
    expect(p.numero).toBeTruthy();
    expect(p.estado).toBe("agendado");
  });

  it("con permiso de cobros, el dinero sale y el saldo cuadra", async () => {
    await unPedido({ total: 10000, pagado: 2500 });
    const r = await listarPedidos(env.DB, TODO);
    if (!r.ok) throw new Error("no listó");
    const p = r.datos.pedidos[0]!;
    expect(p.total_cents).toBe(10000);
    expect(p.pagado_cents).toBe(2500);
    expect(p.saldo_cents).toBe(7500);
  });

  it("el costo es OTRO permiso, más estrecho que el dinero", async () => {
    // La asistente ve lo que se cobró y no lo que costó. Si el costo saliera
    // con el permiso de cobros, el margen quedaría a la vista de quien no debe.
    const id = await unPedido();
    const conDinero = await leerPedido(env.DB, { veDinero: true, veCosto: false }, id);
    if (!conDinero.ok) throw new Error("no leyó");
    expect(conDinero.datos.items[0]!.precio_unit_cents).toBe(5000);
    expect(conDinero.datos.items[0]!.costo_unit_cents).toBeNull();

    const conCosto = await leerPedido(env.DB, TODO, id);
    if (!conCosto.ok) throw new Error("no leyó");
    expect(conCosto.datos.items[0]!.costo_unit_cents).toBe(3000);
  });
});

describe("la lista", () => {
  it("el más nuevo primero", async () => {
    await unPedido({ numero: "BC-VIEJO", creado: T });
    await unPedido({ numero: "BC-NUEVO", creado: T + 100_000 });
    const r = await listarPedidos(env.DB, TODO);
    if (!r.ok) throw new Error("no listó");
    expect(r.datos.pedidos[0]!.numero).toBe("BC-NUEVO");
  });

  it("filtra por estado", async () => {
    await unPedido({ estado: "agendado", numero: "BC-AG" });
    await unPedido({ estado: "entregado", numero: "BC-EN" });
    const r = await listarPedidos(env.DB, TODO, { estado: "entregado" });
    if (!r.ok) throw new Error("no listó");
    expect(r.datos.pedidos.map((p) => p.numero)).toContain("BC-EN");
    expect(r.datos.pedidos.map((p) => p.numero)).not.toContain("BC-AG");
  });

  it("un estado inventado se rechaza en vez de devolver todo", async () => {
    // Devolver la lista entera ante un filtro que no se entiende es peor que
    // fallar: quien lo pidió creería que ESO es lo que hay en ese estado.
    const r = await listarPedidos(env.DB, TODO, { estado: "inventado" });
    expect(r.ok).toBe(false);
  });

  it("busca por número y por nombre de la clienta", async () => {
    await unPedido({ numero: "BC-BUSCAME" });
    const porNumero = await listarPedidos(env.DB, TODO, { busca: "BUSCAME" });
    if (!porNumero.ok) throw new Error("no listó");
    expect(porNumero.datos.pedidos.map((p) => p.numero)).toContain("BC-BUSCAME");

    const porNombre = await listarPedidos(env.DB, TODO, { busca: "Ana" });
    if (!porNombre.ok) throw new Error("no listó");
    expect(porNombre.datos.pedidos.length).toBeGreaterThan(0);
  });

  it("dice si hay más sin contar la tabla entera", async () => {
    await unPedido();
    await unPedido();
    await unPedido();
    const r = await listarPedidos(env.DB, TODO, { limite: 2 });
    if (!r.ok) throw new Error("no listó");
    expect(r.datos.pedidos).toHaveLength(2);
    expect(r.datos.hayMas).toBe(true);
  });

  it("cuenta las líneas de cada pedido", async () => {
    await unPedido({ numero: "BC-CUENTA" });
    const r = await listarPedidos(env.DB, TODO, { busca: "BC-CUENTA" });
    if (!r.ok) throw new Error("no listó");
    expect(r.datos.pedidos[0]!.lineas).toBe(1);
  });

  /**
   * Una cotización se lista y se lee con estas mismas dos consultas.
   *
   * Es la consecuencia práctica de que sea el MISMO documento: no hay una
   * `listarCotizaciones` ni una pantalla paralela. Si el filtro no admitiera
   * `cotizacion`, las cotizaciones existirían en la base y no habría forma de
   * verlas desde el panel — una pieza terminada que nadie llama (TRAMPAS §12).
   */
  it("se puede filtrar por cotizacion, que es el mismo documento en su primer estado", async () => {
    await unPedido({ estado: "cotizacion", numero: "BC-COT" });
    await unPedido({ estado: "agendado", numero: "BC-PED" });

    const r = await listarPedidos(env.DB, TODO, { estado: "cotizacion" });
    if (!r.ok) throw new Error(r.mensaje);
    expect(r.datos.pedidos.map((p) => p.numero)).toContain("BC-COT");
    expect(r.datos.pedidos.map((p) => p.numero)).not.toContain("BC-PED");
  });

  it("y los estados por los que se filtra son los del dominio, ni uno más ni uno menos", async () => {
    // Dos listas de estados que se separan dan un filtro que existe en la
    // pantalla y que el servidor rechaza, o al contrario. Se comprueba por el
    // comportamiento —que cada estado del dominio se acepte— y no leyendo la
    // constante, porque lo que importa es lo que contesta la ruta.
    for (const estado of ESTADOS_PEDIDO) {
      const r = await listarPedidos(env.DB, TODO, { estado });
      expect(r.ok, `rechazó el estado ${estado}`).toBe(true);
    }
  });
});

describe("un pedido", () => {
  it("trae sus líneas y de qué bodega sale cada una", async () => {
    const id = await unPedido();
    const r = await leerPedido(env.DB, TODO, id);
    if (!r.ok) throw new Error("no leyó");
    expect(r.datos.items).toHaveLength(1);
    expect(r.datos.items[0]!.cantidad).toBe(2);
    expect(r.datos.items[0]!.bodega).toBeTruthy();
  });

  it("uno que no existe es no_encontrado, no una lista vacía", async () => {
    const r = await leerPedido(env.DB, TODO, "no-existe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});
