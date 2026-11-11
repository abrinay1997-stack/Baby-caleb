import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  borrarVariante,
  comoSeBorra,
  crearProducto,
  crearVariante,
  editarVariante,
  enunciadosDeBorradoReal,
  explicar,
  slugDe,
  type ContextoCatalogo,
} from "../src/db/catalogo-admin";

/**
 * Qué pasa de verdad al borrar un producto (F4.19).
 *
 * El dueño pidió que al borrar «el sistema quede limpio, que no queden
 * archivos corruptos o fantasmas». El fantasma aquí no es un archivo: es una
 * fila de `movimientos_inventario` o de `pedido_lineas` apuntando a un código
 * que ya no existe.
 *
 * Qué protege D1 y qué no, MEDIDO con `PRAGMA foreign_key_list`:
 *
 *   movimientos_inventario.codigo → existencias   (NO a variantes)
 *   conteo_lineas.codigo          → NINGUNA
 *   traslado_lineas.codigo        → variantes
 *
 * Un movimiento no apunta a la variante, pero sí a su fila de existencias, y
 * borrarla obliga a borrar esa fila: la cadena protege. **La que no tiene nada
 * es `conteo_lineas`** — ni llave ni cadena. Ahí D1 dejaría borrar la variante
 * y la línea del conteo quedaría hablando de un código que ya no existe, sin
 * un solo error. Es el caso que el control del batch existe para cubrir.
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

/** Una línea de conteo: la única referencia que D1 no vigila. */
async function conConteo(codigo: string) {
  const conteoId = id("cnt");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO conteos (id,bodega_id,estado,creado_por,creado_en) VALUES (?,?,'abierto',?,?)",
    ).bind(conteoId, bodegaId, "yarielis", ahora()),
    env.DB.prepare(
      "INSERT INTO conteo_lineas (conteo_id,codigo,contado,sistema) VALUES (?,?,5,5)",
    ).bind(conteoId, codigo),
  ]);
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

    // `movimientos_inventario.codigo` NO apunta a `variantes` sino a
    // `existencias`. Se fija aquí para que quede demostrado y no de palabra: si
    // alguien le pusiera la llave directa, esta prueba se cae y habría que
    // revisar si el registro histórico sigue sobreviviendo a que el catálogo
    // cambie, que es para lo que se dejó así.
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

// ---------------------------------------------------------------------------
// Crear, editar y borrar de verdad
// ---------------------------------------------------------------------------

describe("crear", () => {
  it("una variante nace SIN PUBLICAR, siempre", async () => {
    const p = await crearProducto(ctx, { familia: "panal", nombre: "Pañal X", slug: "" });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    const codigo = id("NUE").toUpperCase();
    const r = await crearVariante(ctx, {
      codigo,
      productoId: p.datos.id,
      nombre: "Pañal X M",
      unidadesPorCaja: 50,
      precioCents: 1999,
    });
    expect(r.ok).toBe(true);

    const v = await env.DB.prepare("SELECT publicado, activo FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ publicado: number; activo: number }>();
    // Publicada de nacimiento, el precio recién tecleado sale a la web y al bot
    // en el siguiente minuto. Equivocarse de tecla en el precio y que lo vea
    // una clienta no se deshace con un botón.
    expect(v?.publicado, "nace sin publicar").toBe(0);
    expect(v?.activo).toBe(1);
  });

  it("el precio de partida entra en el historial", async () => {
    const p = await crearProducto(ctx, { familia: "panal", nombre: "Pañal H", slug: "" });
    if (!p.ok) return;
    const codigo = id("HIS").toUpperCase();
    await crearVariante(ctx, {
      codigo,
      productoId: p.datos.id,
      nombre: "Pañal H M",
      unidadesPorCaja: 10,
      precioCents: 500,
    });

    const h = await env.DB.prepare(
      "SELECT precio_cents, cambiado_por, motivo FROM precios_historial WHERE codigo = ?",
    )
      .bind(codigo)
      .all<{ precio_cents: number; cambiado_por: string; motivo: string }>();
    // Sin esto, la primera cifra —la que más se consulta cuando algo no
    // cuadra— sería la única sin fecha ni autor.
    expect(h.results).toHaveLength(1);
    expect(h.results[0]?.precio_cents).toBe(500);
    expect(h.results[0]?.cambiado_por).toBe("yarielis");
  });

  it("no acepta un código mal escrito, y no lo arregla en silencio", async () => {
    const p = await crearProducto(ctx, { familia: "panal", nombre: "Pañal M", slug: "" });
    if (!p.ok) return;
    for (const malo of ["nat-m", "N", "NAT M", "NAT_M", "ÑAT-M", ""]) {
      const r = await crearVariante(ctx, {
        codigo: malo,
        productoId: p.datos.id,
        nombre: "x",
        unidadesPorCaja: 1,
        precioCents: 100,
      });
      expect(r.ok, `«${malo}» no debería pasar`).toBe(false);
    }
  });

  it("rechaza precio y caja en cero o negativos", async () => {
    const p = await crearProducto(ctx, { familia: "panal", nombre: "Pañal C", slug: "" });
    if (!p.ok) return;
    const base = { productoId: p.datos.id, nombre: "x", unidadesPorCaja: 10, precioCents: 100 };
    expect((await crearVariante(ctx, { ...base, codigo: id("A").toUpperCase(), precioCents: 0 })).ok).toBe(false);
    expect((await crearVariante(ctx, { ...base, codigo: id("B").toUpperCase(), precioCents: -1 })).ok).toBe(false);
    expect((await crearVariante(ctx, { ...base, codigo: id("C").toUpperCase(), unidadesPorCaja: 0 })).ok).toBe(false);
  });

  it("dos productos no pueden compartir dirección web", async () => {
    await crearProducto(ctx, { familia: "panal", nombre: "Pañal Igual", slug: "pañal-igual" });
    const r = await crearProducto(ctx, { familia: "panal", nombre: "Pañal Igual", slug: "pañal-igual" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("repetido");
  });

  it("el slug quita los acentos y la eñe", () => {
    expect(slugDe("Pañal Nateen M")).toBe("panal-nateen-m");
    expect(slugDe("  Wipes  ¡Agua!  ")).toBe("wipes-agua");
  });
});

describe("editar", () => {
  async function unaVariante(precio = 1000): Promise<string> {
    const p = await crearProducto(ctx, { familia: "panal", nombre: `P${n}`, slug: "" });
    if (!p.ok) throw new Error("no se creó el producto");
    const codigo = id("ED").toUpperCase();
    await crearVariante(ctx, {
      codigo,
      productoId: p.datos.id,
      nombre: "Variante",
      unidadesPorCaja: 10,
      precioCents: precio,
    });
    return codigo;
  }

  it("cambia el precio y lo deja en el historial", async () => {
    const codigo = await unaVariante(1000);
    const r = await editarVariante(ctx, codigo, { precioCents: 1250, motivo: "subió el proveedor" }, 1);
    expect(r.ok).toBe(true);

    const v = await env.DB.prepare("SELECT precio_cents, version FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ precio_cents: number; version: number }>();
    expect(v?.precio_cents).toBe(1250);
    expect(v?.version).toBe(2);

    const h = await env.DB.prepare(
      "SELECT precio_cents, motivo FROM precios_historial WHERE codigo = ? ORDER BY vigente_desde",
    )
      .bind(codigo)
      .all<{ precio_cents: number; motivo: string | null }>();
    expect(h.results.map((x) => x.precio_cents)).toEqual([1000, 1250]);
    expect(h.results[1]?.motivo).toBe("subió el proveedor");
  });

  it("un precio que NO cambia no ensucia el historial", async () => {
    const codigo = await unaVariante(1000);
    await editarVariante(ctx, codigo, { precioCents: 1000, nombre: "Otro nombre" }, 1);
    const h = await env.DB.prepare("SELECT COUNT(*) AS n FROM precios_historial WHERE codigo = ?")
      .bind(codigo)
      .first<{ n: number }>();
    // Si cada guardado dejara una fila, el historial de precios sería un
    // registro de guardados y dejaría de servir para ver cuándo cambió el
    // precio de verdad.
    expect(h?.n).toBe(1);
  });

  it("con la versión vieja NO escribe nada", async () => {
    const codigo = await unaVariante(1000);
    await editarVariante(ctx, codigo, { precioCents: 2000 }, 1); // alguien se adelantó

    const r = await editarVariante(ctx, codigo, { precioCents: 1500 }, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("conflicto_version");

    // Lo importante no es el código de error: es que el precio del otro SIGUE.
    const v = await env.DB.prepare("SELECT precio_cents FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ precio_cents: number }>();
    expect(v?.precio_cents, "no se pisa el precio de quien llegó antes").toBe(2000);
  });

  it("publicar y despublicar", async () => {
    const codigo = await unaVariante();
    await editarVariante(ctx, codigo, { publicado: true }, 1);
    let v = await env.DB.prepare("SELECT publicado FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ publicado: number }>();
    expect(v?.publicado).toBe(1);

    await editarVariante(ctx, codigo, { publicado: false }, 2);
    v = await env.DB.prepare("SELECT publicado FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ publicado: number }>();
    expect(v?.publicado).toBe(0);
  });

  it("un guardado sin cambios no sube la versión", async () => {
    const codigo = await unaVariante();
    const r = await editarVariante(ctx, codigo, {}, 1);
    expect(r.ok && r.datos.version).toBe(1);
  });
});

describe("borrar de verdad", () => {
  async function sinHistoria(): Promise<string> {
    const p = await crearProducto(ctx, { familia: "panal", nombre: `Q${n}`, slug: "" });
    if (!p.ok) throw new Error("no se creó");
    const codigo = id("BO").toUpperCase();
    await crearVariante(ctx, {
      codigo,
      productoId: p.datos.id,
      nombre: "Para borrar",
      unidadesPorCaja: 10,
      precioCents: 900,
    });
    return codigo;
  }

  it("una sin historia desaparece, y su historial de precios con ella", async () => {
    const codigo = await sinHistoria();
    const r = await borrarVariante(ctx, codigo);
    expect(r.ok && r.datos.modo).toBe("se_borra");

    expect(
      await env.DB.prepare("SELECT codigo FROM variantes WHERE codigo = ?").bind(codigo).first(),
    ).toBeNull();
    const h = await env.DB.prepare("SELECT COUNT(*) AS n FROM precios_historial WHERE codigo = ?")
      .bind(codigo)
      .first<{ n: number }>();
    expect(h?.n, "no queda historial colgando").toBe(0);
  });

  it("marca su foto para que el barrido la quite de R2", async () => {
    const codigo = await sinHistoria();
    const clave = `catalogo/${codigo}/f.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,
         referencia_tipo,referencia_id,creado_en)
       VALUES (?,'catalogo','image/webp',10,0,?,'variante',?,?)`,
    )
      .bind(clave, "yarielis", codigo, ahora())
      .run();

    const r = await borrarVariante(ctx, codigo);
    expect(r.ok && r.datos.archivos).toEqual([clave]);

    const a = await env.DB.prepare("SELECT borrar_despues_de FROM archivos WHERE r2_key = ?")
      .bind(clave)
      .first<{ borrar_despues_de: number | null }>();
    // Marcada, no borrada: el barrido la quita de R2 después, con margen para
    // recuperarla (F4.18).
    expect(a?.borrar_despues_de).not.toBeNull();
  });

  it("limpia el puntero de «talla siguiente» que la apuntaba", async () => {
    const codigo = await sinHistoria();
    const otra = await sinHistoria();
    await env.DB.prepare("UPDATE variantes SET siguiente_codigo = ? WHERE codigo = ?")
      .bind(codigo, otra)
      .run();

    expect((await borrarVariante(ctx, codigo)).ok).toBe(true);
    const v = await env.DB.prepare("SELECT siguiente_codigo FROM variantes WHERE codigo = ?")
      .bind(otra)
      .first<{ siguiente_codigo: string | null }>();
    // Sin limpiarlo, la llave foránea tumba el borrado con un error que no le
    // dice nada a nadie.
    expect(v?.siguiente_codigo).toBeNull();
  });

  it("una con historia se OCULTA y sigue existiendo", async () => {
    const codigo = await sinHistoria();
    await conPedido(codigo);

    const r = await borrarVariante(ctx, codigo);
    expect(r.ok && r.datos.modo).toBe("se_oculta");

    const v = await env.DB.prepare("SELECT activo, publicado FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ activo: number; publicado: number }>();
    expect(v, "la fila SIGUE: el pedido de una clienta la nombra").not.toBeNull();
    expect(v?.activo).toBe(0);
    expect(v?.publicado).toBe(0);
  });

  it("al ocultar NO se tocan las fotos", async () => {
    const codigo = await sinHistoria();
    const clave = `catalogo/${codigo}/g.webp`;
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,
         referencia_tipo,referencia_id,creado_en)
       VALUES (?,'catalogo','image/webp',10,0,?,'variante',?,?)`,
    )
      .bind(clave, "yarielis", codigo, ahora())
      .run();
    await conPedido(codigo);

    await borrarVariante(ctx, codigo);
    const a = await env.DB.prepare("SELECT borrar_despues_de FROM archivos WHERE r2_key = ?")
      .bind(clave)
      .first<{ borrar_despues_de: number | null }>();
    // La variante sigue viva y su ficha puede hacer falta para explicar un
    // pedido viejo.
    expect(a?.borrar_despues_de).toBeNull();
  });

  it("si aparece un movimiento entre el aviso y el clic, NO borra", async () => {
    const codigo = await sinHistoria();
    const veredicto = await comoSeBorra(ctx, codigo);
    expect(veredicto.ok && veredicto.datos.modo).toBe("se_borra"); // la pantalla avisó «se borra»

    // …y mientras alguien confirmaba, entró mercancía.
    await conMovimiento(codigo);

    const r = await borrarVariante(ctx, codigo);
    // Vuelve a calcular el veredicto, así que ahora oculta en vez de borrar.
    expect(r.ok && r.datos.modo).toBe("se_oculta");
    expect(
      await env.DB.prepare("SELECT codigo FROM variantes WHERE codigo = ?").bind(codigo).first(),
      "la variante sigue: su movimiento de inventario la nombra",
    ).not.toBeNull();
  });

  it("no borra lo que no existe", async () => {
    const r = await borrarVariante(ctx, "NO-EXISTE-ZZZ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});

describe("el último filo contra el registro fantasma", () => {
  /**
   * `borrarVariante` vuelve a calcular el veredicto antes de escribir, así que
   * el camino normal nunca llega aquí. Pero entre ese cálculo y el batch hay
   * una rendija, y lo que pasa por ella es justo lo que no puede pasar: una
   * venta que entra mientras se borra.
   *
   * Esto ejercita el control directamente, con la rendija abierta a propósito
   * y usando `conteo_lineas`, que es la única referencia sin llave foránea ni
   * cadena hasta `variantes`. Sin el control, D1 dejaría borrar la variante y
   * la línea del conteo quedaría hablando de un código que ya no existe, sin
   * un solo error.
   *
   * La primera versión de esta prueba usaba un movimiento de inventario, y
   * pasaba con el control quitado: un movimiento apunta a `existencias`, que
   * el propio batch borra, así que D1 lo detenía igual. Probaba la llave
   * foránea creyendo que probaba el control.
   */
  it("un conteo que aparece en la rendija tumba el borrado entero", async () => {
    const p = await crearProducto(ctx, { familia: "panal", nombre: `R${n}`, slug: "" });
    if (!p.ok) return;
    const codigo = id("FAN").toUpperCase();
    await crearVariante(ctx, {
      codigo,
      productoId: p.datos.id,
      nombre: "Fantasma",
      unidadesPorCaja: 10,
      precioCents: 100,
    });

    // Los enunciados se arman cuando todavía no había nada…
    const enunciados = enunciadosDeBorradoReal(ctx, codigo, []);
    // …y el conteo entra justo después.
    //
    // Se usa un CONTEO y no un movimiento a propósito: un movimiento apunta a
    // `existencias`, que el propio batch borra, así que D1 lo detendría igual
    // y la prueba pasaría sin demostrar nada del control. `conteo_lineas` no
    // tiene llave ninguna — ahí el control es lo único que hay.
    await conConteo(codigo);

    await expect(env.DB.batch(enunciados)).rejects.toThrow();

    expect(
      await env.DB.prepare("SELECT codigo FROM variantes WHERE codigo = ?").bind(codigo).first(),
      "la variante sigue ahí: su movimiento la nombra",
    ).not.toBeNull();
  });

  it("sin la rendija, los mismos enunciados sí borran", async () => {
    // El contraste importa: si el batch fallara siempre, la prueba de arriba
    // pasaría sin demostrar nada.
    const p = await crearProducto(ctx, { familia: "panal", nombre: `S${n}`, slug: "" });
    if (!p.ok) return;
    const codigo = id("LIM").toUpperCase();
    await crearVariante(ctx, {
      codigo,
      productoId: p.datos.id,
      nombre: "Limpia",
      unidadesPorCaja: 10,
      precioCents: 100,
    });

    await env.DB.batch(enunciadosDeBorradoReal(ctx, codigo, []));
    expect(
      await env.DB.prepare("SELECT codigo FROM variantes WHERE codigo = ?").bind(codigo).first(),
    ).toBeNull();
  });
});
