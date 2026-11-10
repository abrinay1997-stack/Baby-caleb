import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { comoSeBorra, explicar, type ContextoCatalogo } from "../src/db/catalogo-admin";

/**
 * Qué pasa de verdad al borrar un producto (F4.19).
 *
 * El dueño pidió que al borrar «el sistema quede limpio, que no queden
 * archivos corruptos o fantasmas». El fantasma aquí no es un archivo: es una
 * fila de `movimientos_inventario` o de `pedido_lineas` apuntando a un código
 * que ya no existe.
 *
 * Y lo peligroso es que **D1 no lo impide**. `movimientos_inventario.codigo` y
 * `conteo_lineas.codigo` no tienen llave foránea —son registros históricos y
 * tienen que sobrevivir a que el catálogo cambie— así que un `DELETE` de la
 * variante pasaría sin un solo error y dejaría el libro de inventario hablando
 * de algo que no está. Estas pruebas existen sobre todo para eso.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

let ctx: ContextoCatalogo;
let bodegaId: string;

beforeEach(async () => {
  ctx = { db: env.DB, ahora: ahora(), actor: "yarielis" };
  const b = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
  bodegaId = b?.id ?? "";
  expect(bodegaId, "la carga inicial tiene que haber dejado bodegas").not.toBe("");
});

/** Una variante recién creada, sin una sola cosa que le haya pasado. */
async function varianteNueva(sobre: Record<string, unknown> = {}): Promise<string> {
  const productoId = id("prod");
  const codigo = id("COD").toUpperCase();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,activo,orden,creado_en) VALUES (?,?,?,?,1,0,?)",
    ).bind(productoId, "panal", "Pañal de prueba", id("slug"), ahora()),
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en)
       VALUES (?,?,?,?,?,0,?,1,?)`,
    ).bind(
      codigo,
      productoId,
      "Pañal de prueba M",
      100,
      2500,
      (sobre["activo"] as number) ?? 1,
      ahora(),
    ),
  ]);
  return codigo;
}

/** `movimientos_inventario` exige que exista la fila de existencias. */
const conExistencias = (codigo: string, fisico = 0) =>
  env.DB.prepare(
    "INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)",
  )
    .bind(codigo, bodegaId, fisico)
    .run();

/**
 * Un movimiento Y NADA MÁS.
 *
 * Las existencias quedan en CERO a propósito. Antes esta ayuda dejaba 10
 * unidades, así que la prueba del movimiento pasaba por el rastro de
 * existencias y no por el que decía mirar: quitando la comprobación de
 * movimientos del código, seguía en verde.
 */
async function conMovimiento(codigo: string) {
  await conExistencias(codigo, 0);
  await env.DB.prepare(
    `INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en)
     VALUES (?,?,?,?,'compra',?,?)`,
  )
    .bind(id("mov"), codigo, bodegaId, 10, "yarielis", ahora())
    .run();
}

async function conPedido(codigo: string) {
  const clienteId = id("cli");
  const pedidoId = id("ped");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)",
    ).bind(clienteId, "Ana", ahora(), ahora()),
    env.DB.prepare(
      `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
         subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
         abono_minimo_cents,requiere_pago_total,version,creado_en,actualizado_en)
       VALUES (?,?,?,?,'web','por_abonar','sin_pago',2500,0,0,0,2500,0,0,0,1,?,?)`,
    ).bind(pedidoId, id("BC"), id("tok"), clienteId, ahora(), ahora()),
    env.DB.prepare(
      `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,bodega_id)
       VALUES (?,?,?,?,1,2500,?)`,
    ).bind(id("lin"), pedidoId, codigo, "Pañal de prueba M", bodegaId),
  ]);
}

describe("una variante sin historia se borra de verdad", () => {
  it("dice se_borra", async () => {
    const codigo = await varianteNueva();
    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo).toBe("se_borra");
  });

  it("una fila de existencias EN CERO no la salva", async () => {
    const codigo = await varianteNueva();
    await conExistencias(codigo, 0);
    // Existencias en cero es contabilidad de algo que nunca pasó: se va con la
    // variante y no deja nada colgando. Si contara como rastro, ninguna
    // variante sería borrable nunca y el botón no serviría para nada.
    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo).toBe("se_borra");
  });

  it("lista los archivos que se van con ella", async () => {
    const codigo = await varianteNueva();
    const clave = `catalogo/${codigo}/foto.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,
         referencia_tipo,referencia_id,creado_en)
       VALUES (?,'catalogo','image/webp',10,0,?,'variante',?,?)`,
    )
      .bind(clave, "yarielis", codigo, ahora())
      .run();

    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo === "se_borra" && r.datos.archivos).toEqual([clave]);
  });

  it("no cuenta dos veces un archivo que ya estaba marcado para borrar", async () => {
    const codigo = await varianteNueva();
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,
         referencia_tipo,referencia_id,borrar_despues_de,creado_en)
       VALUES (?,'catalogo','image/webp',10,0,?,'variante',?,?,?)`,
    )
      .bind(`catalogo/${codigo}/vieja.webp`, "yarielis", codigo, ahora() + 1000, ahora())
      .run();

    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo === "se_borra" && r.datos.archivos).toEqual([]);
  });
});

describe("una variante con historia se oculta, no se borra", () => {
  it("un movimiento de inventario basta — Y D1 NO LO IMPEDIRÍA", async () => {
    const codigo = await varianteNueva();
    await conMovimiento(codigo);

    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo).toBe("se_oculta");
    // Y por EL movimiento, no por otra cosa: sin esto, bastaba con que la
    // ayuda dejara stock para que la prueba pasara sin mirar nada.
    expect(r.ok && r.datos.modo === "se_oculta" && r.datos.rastros).toEqual([
      { tabla: "movimientos_inventario", cuantos: 1 },
    ]);

    // La razón por la que esta prueba es la importante de todo el archivo:
    // `movimientos_inventario.codigo` NO tiene llave foránea a `variantes`.
    // Se comprueba aquí para que quede demostrado y no de palabra — si alguien
    // le pusiera la llave, esta prueba se cae y habría que revisar si el
    // registro histórico sigue sobreviviendo a un cambio de catálogo.
    const fks = await env.DB.prepare("PRAGMA foreign_key_list(movimientos_inventario)").all<{
      table: string;
    }>();
    expect(
      fks.results.map((f) => f.table),
      "si movimientos_inventario gana una FK a variantes, revisar esta decisión",
    ).not.toContain("variantes");
  });

  it("estar en un pedido basta", async () => {
    const codigo = await varianteNueva();
    await conPedido(codigo);
    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo).toBe("se_oculta");
  });

  it("tener unidades en bodega basta, aunque no haya movimientos", async () => {
    const codigo = await varianteNueva();
    await conExistencias(codigo, 7);
    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo === "se_oculta" && r.datos.rastros).toContainEqual({
      tabla: "existencias",
      cuantos: 7,
    });
  });

  it("lo reservado NO se suma: es una parte de lo físico, no algo aparte", async () => {
    const codigo = await varianteNueva();
    await env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,5,3)",
    )
      .bind(codigo, bodegaId)
      .run();

    // 5, no 8. El CHECK de la tabla dice `reservado <= fisico`, así que las 3
    // apartadas son 3 DE las 5 que hay. Decir 8 sería darle a Yarielis un
    // número que no cuadra con lo que cuenta en el estante.
    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo === "se_oculta" && r.datos.rastros).toContainEqual({
      tabla: "existencias",
      cuantos: 5,
    });
  });

  it("la venta se nombra primero: es lo que una persona necesita saber", async () => {
    const codigo = await varianteNueva();
    await conMovimiento(codigo);
    await conPedido(codigo);

    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo === "se_oculta" && r.datos.rastros[0]?.tabla).toBe("pedido_lineas");
  });

  it("avisa si ya estaba oculta, para no prometer un cambio que no ocurre", async () => {
    const codigo = await varianteNueva({ activo: 0 });
    await conPedido(codigo);
    const r = await comoSeBorra(ctx, codigo);
    expect(r.ok && r.datos.modo === "se_oculta" && r.datos.yaOculta).toBe(true);
  });
});

describe("lo que lee la persona", () => {
  it("cuenta en singular y en plural", () => {
    expect(explicar({ tabla: "pedido_lineas", cuantos: 1 })).toBe("está en 1 pedido");
    expect(explicar({ tabla: "pedido_lineas", cuantos: 3 })).toBe("está en 3 pedidos");
    expect(explicar({ tabla: "existencias", cuantos: 1 })).toBe("tiene 1 unidad en bodega");
  });

  it("no le enseña a nadie el nombre de una tabla", () => {
    const todos = [
      explicar({ tabla: "pedido_lineas", cuantos: 2 }),
      explicar({ tabla: "movimientos_inventario", cuantos: 2 }),
      explicar({ tabla: "conteo_lineas", cuantos: 1 }),
      explicar({ tabla: "traslado_lineas", cuantos: 1 }),
      explicar({ tabla: "existencias", cuantos: 2 }),
    ];
    for (const t of todos) expect(t).not.toMatch(/_|lineas|tabla/);
  });
});

describe("lo que no existe", () => {
  it("no inventa un veredicto para una variante que no está", async () => {
    const r = await comoSeBorra(ctx, "NO-EXISTE-XYZ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});
