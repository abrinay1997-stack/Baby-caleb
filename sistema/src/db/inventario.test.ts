import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { aplicar, registrar } from "./inventario";

const T = 1_800_000_000_000;
const ctx = { db: real.DB, actor: "usr-duena", ahora: T };

/** Lo que hay ahora mismo en el estante. */
async function fisico(codigo = "INV-M", bodega = "bod-inv-a"): Promise<number | null> {
  const f = await real.DB.prepare(
    "SELECT fisico FROM existencias WHERE codigo = ? AND bodega_id = ?",
  )
    .bind(codigo, bodega)
    .first<{ fisico: number }>();
  return f?.fisico ?? null;
}

const cuantosMovimientos = async (): Promise<number> =>
  (
    await real.DB.prepare("SELECT COUNT(*) AS n FROM movimientos_inventario").first<{ n: number }>()
  )?.n ?? 0;

/**
 * Cuántos movimientos se escribieron DESDE que empezó esta prueba.
 *
 * No se cuentan en absoluto porque la tabla no se puede vaciar: un trigger del
 * esquema prohíbe borrar un movimiento, igual que prohíbe editarlo. Es la regla
 * de que los libros no se editan ni se borran, y vale también aquí — una prueba
 * que necesitara saltársela estaría probando otro sistema.
 *
 * Por lo mismo tampoco se borran `existencias`, `variantes` ni `bodegas`: los
 * movimientos de una prueba anterior apuntan a ellas con una llave foránea. La
 * siembra deja los valores en su sitio con UPDATE en vez de borrar y volver a
 * crear.
 */
let base = 0;
const nuevos = async (): Promise<number> => (await cuantosMovimientos()) - base;

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p-inv','panal','Producto de prueba (inventario)','prueba-de-inventario',?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en) VALUES ('INV-M','p-inv','Producto de prueba M','M',144,5000,NULL,1,?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO bodegas (id,nombre) VALUES ('bod-inv-a','Bodega de prueba A')",
    ),
    real.DB.prepare(
      "INSERT OR IGNORE INTO bodegas (id,nombre) VALUES ('bod-inv-b','Bodega de prueba B')",
    ),
    real.DB.prepare(
      "INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES ('INV-M','bod-inv-a',10,2,5)",
    ),
    real.DB.prepare(
      "INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES ('INV-M','bod-inv-b',0,0,NULL)",
    ),
    // 10 en el estante, 2 comprometidos en pedidos sin entregar.
    real.DB.prepare(
      "UPDATE existencias SET fisico = 10, reservado = 2, minimo = 5 WHERE codigo = 'INV-M' AND bodega_id = 'bod-inv-a'",
    ),
    real.DB.prepare(
      "UPDATE existencias SET fisico = 0, reservado = 0 WHERE codigo = 'INV-M' AND bodega_id = 'bod-inv-b'",
    ),
  ]);
  base = await cuantosMovimientos();
});

describe("registrar: cargar y corregir el inventario desde el panel", () => {
  it("una apertura sube el físico y deja su movimiento", async () => {
    const r = await registrar(ctx, {
      tipo: "apertura",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 40 }],
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.movimientos).toBe(1);
    expect(await fisico("INV-M", "bod-inv-b")).toBe(40);
    expect(await nuevos()).toBe(1);
  });

  it("un conteo que cuadra NO escribe nada, y eso no es un error", async () => {
    // Contar y que todo esté bien es el caso BUENO. Un movimiento de cero
    // unidades lo prohíbe el esquema y además ensuciaría el libro con ruido.
    const r = await registrar(ctx, {
      tipo: "conteo",
      motivo: "conteo físico del mes",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", contado: 10 }],
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.movimientos).toBe(0);
    expect(r.datos.deshacerId).toBeNull();
    expect(await nuevos()).toBe(0);
    expect(await fisico()).toBe(10);
  });

  it("un conteo que no cuadra escribe la DIFERENCIA, no el absoluto", async () => {
    const r = await registrar(ctx, {
      tipo: "conteo",
      motivo: "faltaban tres cajas",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", contado: 7 }],
    });

    expect(r.ok).toBe(true);
    expect(await fisico()).toBe(7);

    // Acotado por motivo: la tabla NO se vacía entre pruebas —no se puede— así
    // que un SELECT suelto devolvería el movimiento de otra prueba.
    const m = await real.DB.prepare(
      "SELECT delta, tipo, motivo FROM movimientos_inventario WHERE motivo = ?",
    )
      .bind("faltaban tres cajas")
      .first<{ delta: number; tipo: string; motivo: string }>();
    expect(m?.delta).toBe(-3); // La diferencia, no el 7.
    expect(m?.tipo).toBe("conteo");
    expect(m?.motivo).toBe("faltaban tres cajas");
  });

  it("un conteo NO puede dejar el físico por debajo de lo comprometido", async () => {
    // Hay 2 reservados para pedidos sin entregar. Contar 1 dejaría vendida
    // mercancía que no existe.
    const r = await registrar(ctx, {
      tipo: "conteo",
      motivo: "conteo",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", contado: 1 }],
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("sin_stock");
    expect(await fisico()).toBe(10); // Intacto.
    expect(await nuevos()).toBe(0);
  });

  it("varios renglones son todo o nada", async () => {
    const r = await registrar(ctx, {
      tipo: "merma",
      motivo: "caja mojada",
      lineas: [
        { codigo: "INV-M", bodegaId: "bod-inv-a", delta: -1 },
        // Esta no alcanza: en el oeste hay 0.
        { codigo: "INV-M", bodegaId: "bod-inv-b", delta: -5 },
      ],
    });

    expect(r.ok).toBe(false);
    expect(await fisico("INV-M", "bod-inv-a")).toBe(10); // La buena tampoco pasó.
    expect(await nuevos()).toBe(0);
  });

  it("rechaza un tipo que no existe antes de tocar la base", async () => {
    const r = await registrar(ctx, {
      tipo: "regularizacion",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: 1 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(r.mensaje).toContain("apertura");
  });

  it("exige decir una cosa u otra, no las dos", async () => {
    const dos = await registrar(ctx, {
      tipo: "ajuste",
      motivo: "x",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: 1, contado: 5 }],
    });
    expect(dos.ok).toBe(false);

    const ninguna = await registrar(ctx, {
      tipo: "ajuste",
      motivo: "x",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a" }],
    });
    expect(ninguna.ok).toBe(false);
  });

  it("un código que no está en esa bodega no se trata como cero", async () => {
    // Si se tratara como cero, un código mal tecleado se convertiría en una
    // entrada de mercancía que nadie pidió.
    const r = await registrar(ctx, {
      tipo: "conteo",
      motivo: "conteo",
      lineas: [{ codigo: "NO-EXISTE", bodegaId: "bod-inv-a", contado: 20 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });

  it("un ajuste sin motivo no pasa", async () => {
    const r = await registrar(ctx, {
      tipo: "ajuste",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -1 }],
    });
    expect(r.ok).toBe(false);
    expect(await nuevos()).toBe(0);
  });

  it("renglones que no son objetos dan un mensaje, no un 500", async () => {
    const r = await registrar(ctx, {
      tipo: "apertura",
      lineas: [null as never, undefined as never],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
  });
});

describe("quedaEn: el conteo no pisa una venta que entró en medio", () => {
  it("la fila de control exige el resultado EXACTO", async () => {
    // Pedir que 10 − 3 acabe en 9 es imposible. Si la fila de control no
    // mirara el resultado, esto pasaría y dejaría el inventario mintiendo.
    const r = await aplicar(
      ctx,
      [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3, tipo: "conteo", motivo: "x", quedaEn: 9 }],
      { tipo: "conteo", id: "ref-1" },
    );

    expect(r.ok).toBe(false);
    expect(await fisico()).toBe(10);
    expect(await nuevos()).toBe(0);
  });

  it("con el resultado correcto sí pasa", async () => {
    const r = await aplicar(
      ctx,
      [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3, tipo: "conteo", motivo: "x", quedaEn: 7 }],
      { tipo: "conteo", id: "ref-2" },
    );

    expect(r.ok).toBe(true);
    expect(await fisico()).toBe(7);
  });

  it("una venta entre la lectura y la escritura tumba el conteo entero", async () => {
    // La carrera de verdad, por el camino público. `registrar` lee el físico
    // para calcular la diferencia; esta base vende 2 unidades justo entre esa
    // lectura y el batch, que es exactamente lo que pasa cuando la dueña
    // cuenta mientras el bot despacha.
    const conVentaEnMedio = {
      prepare: (q: string) => real.DB.prepare(q),
      batch: async (enunciados: D1PreparedStatement[]) => {
        await real.DB.prepare(
          "UPDATE existencias SET fisico = fisico - 2 WHERE codigo = 'INV-M' AND bodega_id = 'bod-inv-a'",
        ).run();
        return real.DB.batch(enunciados);
      },
    } as unknown as D1Database;

    const r = await registrar(
      { db: conVentaEnMedio, actor: "usr-duena", ahora: T },
      {
        tipo: "conteo",
        motivo: "conteo físico",
        lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", contado: 7 }],
      },
    );

    // Leyó 10, calculó −3, pero para cuando escribió había 8: −3 habría dejado
    // 5, no los 7 que se contaron. No se escribe nada y la dueña vuelve a
    // contar, que es lo correcto.
    expect(r.ok).toBe(false);
    expect(await fisico()).toBe(8); // Solo la venta.
    expect(await nuevos()).toBe(0);
  });
});
