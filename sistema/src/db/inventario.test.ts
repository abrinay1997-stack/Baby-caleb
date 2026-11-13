import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { aplicar, deshacer, registrar, trasladar } from "./inventario";

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
    // El promedio SÍ se puede borrar: no es un libro, es un saldo calculado
    // (los movimientos que lo explican son los que no se borran, y esos se
    // quedan). Cada prueba del promedio empieza sin fila, que es como está
    // hoy la producción: la tabla llevaba desde 0001 sin que nadie la llenara.
    real.DB.prepare("DELETE FROM valor_inventario WHERE codigo = 'INV-M'"),
  ]);
  base = await cuantosMovimientos();
});

/** El promedio ponderado de la variante de prueba, o `null` si no hay fila. */
async function promedio(
  codigo = "INV-M",
): Promise<{ unidades: number; valor_cents: number } | null> {
  return await real.DB.prepare(
    "SELECT unidades, valor_cents FROM valor_inventario WHERE codigo = ?",
  )
    .bind(codigo)
    .first<{ unidades: number; valor_cents: number }>();
}

/** Siembra un promedio ya cargado, como lo deja una entrada con costo. */
const conPromedio = async (unidades: number, valorCents: number): Promise<void> => {
  await real.DB.prepare(
    "INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES ('INV-M',?,?)",
  )
    .bind(unidades, valorCents)
    .run();
};

/** El costo que quedó anotado en el movimiento de ese motivo. */
async function costoDelMovimiento(motivo: string): Promise<number | null | undefined> {
  const m = await real.DB.prepare(
    "SELECT costo_unit_cents FROM movimientos_inventario WHERE motivo = ?",
  )
    .bind(motivo)
    .first<{ costo_unit_cents: number | null }>();
  return m === null ? undefined : m.costo_unit_cents;
}

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

/**
 * El costo promedio del inventario: el dato que nadie escribía nunca.
 *
 * `valor_inventario` nació con la migración 0001 y hasta hoy se leía al
 * entregar, se bajaba al entregar y se subía al devolver — y no había UN SOLO
 * sitio que la llenara. Así que toda entrega salía con `costoDesconocido`, sin
 * asiento 3b, y la ganancia bruta no se podía calcular. Estas pruebas vigilan
 * las dos mitades del arreglo: que las entradas con costo la llenen, y que las
 * salidas la bajen — porque una tabla que sube y no baja es un promedio
 * corrompido que cuadra igual, que es lo peor que puede pasar.
 */
describe("el costo promedio: quién lo llena y quién lo baja", () => {
  it("una entrada con costo CREA la fila y sube el promedio", async () => {
    // Es la puerta que faltaba. Sin el `ON CONFLICT` del upsert, una variante
    // sin fila no tiene qué actualizar: el UPDATE no casa, no falla, y el
    // costo se pierde en silencio.
    const r = await registrar(ctx, {
      tipo: "apertura",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 40, costoUnitCents: 300 }],
    });

    expect(r.ok).toBe(true);
    expect(await promedio()).toMatchObject({ unidades: 40, valor_cents: 12_000 });
    expect(await fisico("INV-M", "bod-inv-b")).toBe(40);
  });

  it("una entrada SIN costo no toca el promedio, y no pone un cero", async () => {
    // Las unidades existen físicamente; lo que costaron no se sabe. Un cero
    // diría que fueron gratis y pondría el margen en 100 % (TRAMPAS §7).
    const r = await registrar(ctx, {
      tipo: "apertura",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 40 }],
    });

    expect(r.ok).toBe(true);
    expect(await fisico("INV-M", "bod-inv-b")).toBe(40);
    expect(await promedio()).toBeNull();
  });

  it("una segunda entrada con otro costo PONDERA, no reemplaza", async () => {
    await registrar(ctx, {
      tipo: "apertura",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 10, costoUnitCents: 300 }],
    });
    await registrar(ctx, {
      tipo: "compra",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 10, costoUnitCents: 500 }],
    });

    // 10 × $3 + 10 × $5 = $80 en 20 unidades: $4 cada una.
    expect(await promedio()).toMatchObject({ unidades: 20, valor_cents: 8_000 });
  });

  it("una salida baja su parte proporcional y anota lo que de verdad costó", async () => {
    await conPromedio(10, 3_000);

    const r = await registrar(ctx, {
      tipo: "merma",
      motivo: "promedio: caja mojada",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3 }],
    });

    expect(r.ok).toBe(true);
    // round(3000 × 3 / 10) = 900.
    expect(await promedio()).toMatchObject({ unidades: 7, valor_cents: 2_100 });
    // Y queda copiado en el movimiento: un cambio del promedio mañana no
    // reescribe lo que salió hoy (05-contabilidad §4).
    expect(await costoDelMovimiento("promedio: caja mojada")).toBe(300);
  });

  it("una salida sin promedio cargado no lo toca y deja el costo en blanco", async () => {
    const r = await registrar(ctx, {
      tipo: "merma",
      motivo: "promedio: sin costo cargado",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3 }],
    });

    expect(r.ok).toBe(true);
    expect(await promedio()).toBeNull();
    expect(await costoDelMovimiento("promedio: sin costo cargado")).toBeNull();
  });

  it("una salida de más unidades que las valoradas no toca el promedio", async () => {
    // Misma condición y misma decisión que `marcarEntregada`: una parte del
    // costo no es el costo de esta salida, y repartir lo que hay sería
    // inventar.
    await conPromedio(2, 600);

    const r = await registrar(ctx, {
      tipo: "merma",
      motivo: "promedio: mas de lo valorado",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3 }],
    });

    expect(r.ok).toBe(true);
    expect(await promedio()).toMatchObject({ unidades: 2, valor_cents: 600 });
    expect(await costoDelMovimiento("promedio: mas de lo valorado")).toBeNull();
  });

  it("un TRASLADO no toca el promedio, ni por la salida ni por la entrada", async () => {
    // El promedio es por VARIANTE, no por bodega: la mercancía no cambió de
    // dueño ni de costo, solo de estante. Si la salida bajara el promedio y la
    // entrada no lo subiera —no lleva costo—, cada traslado destruiría valor.
    await conPromedio(10, 3_000);

    const r = await trasladar(ctx, {
      codigo: "INV-M",
      desdeId: "bod-inv-a",
      haciaId: "bod-inv-b",
      cantidad: 4,
      motivo: "promedio: traslado",
    });

    expect(r.ok).toBe(true);
    expect(await fisico("INV-M", "bod-inv-a")).toBe(6);
    expect(await fisico("INV-M", "bod-inv-b")).toBe(4);
    expect(await promedio()).toMatchObject({ unidades: 10, valor_cents: 3_000 });
    expect(await costoDelMovimiento("promedio: traslado")).toBeNull();
  });

  it("dos movimientos de la misma variante en un lote: el segundo cuenta con lo que dejó el primero", async () => {
    await conPromedio(10, 3_000);

    const r = await aplicar(
      ctx,
      [
        { codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3, tipo: "merma", motivo: "p: uno" },
        { codigo: "INV-M", bodegaId: "bod-inv-a", delta: -2, tipo: "merma", motivo: "p: dos" },
      ],
      { tipo: "merma", id: "ref-promedio-lote" },
    );

    expect(r.ok).toBe(true);
    // 10/3000 → −900 → 7/2100 → round(2100×2/7) = 600 → 5/1500.
    expect(await promedio()).toMatchObject({ unidades: 5, valor_cents: 1_500 });
    expect(await costoDelMovimiento("p: uno")).toBe(300);
    expect(await costoDelMovimiento("p: dos")).toBe(300);
  });

  it("un costo de CERO es una afirmación («fue gratis»), no un «no sé»", async () => {
    // La diferencia entre el campo ausente y el campo en cero es justo la del
    // §7 de TRAMPAS, y es la que deja contar bien la mercancía regalada por un
    // proveedor sin tener que inventarle un precio.
    const r = await registrar(ctx, {
      tipo: "compra",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 5, costoUnitCents: 0 }],
    });

    expect(r.ok).toBe(true);
    expect(await promedio()).toMatchObject({ unidades: 5, valor_cents: 0 });
  });

  it("rechaza un costo en una SALIDA en vez de ignorarlo", async () => {
    // En una salida el costo lo decide el promedio (05-contabilidad §4).
    // Aceptarlo y no usarlo dejaría a quien lo mandó creyendo que se guardó.
    const r = await registrar(ctx, {
      tipo: "merma",
      motivo: "x",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -2, costoUnitCents: 300 }],
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(r.mensaje).toContain("ENTRA");
    expect(await nuevos()).toBe(0);
  });

  it("rechaza un costo en una salida que vino por CONTEO, donde el signo aún no se sabía", async () => {
    // El renglón de un conteo no dice si entra o sale hasta que se resta lo
    // contado: hay 10 y contó 7, así que es una salida.
    const r = await registrar(ctx, {
      tipo: "conteo",
      motivo: "x",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", contado: 7, costoUnitCents: 300 }],
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(await nuevos()).toBe(0);
  });

  it("un conteo que encuentra MÁS, con su costo, sube el promedio", async () => {
    await conPromedio(10, 3_000);

    const r = await registrar(ctx, {
      tipo: "conteo",
      motivo: "promedio: aparecieron dos cajas",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", contado: 12, costoUnitCents: 300 }],
    });

    expect(r.ok).toBe(true);
    expect(await promedio()).toMatchObject({ unidades: 12, valor_cents: 3_600 });
  });

  it("un costo negativo se dice con palabras, no con un CHECK de la base", async () => {
    const r = await aplicar(
      ctx,
      [
        {
          codigo: "INV-M",
          bodegaId: "bod-inv-b",
          delta: 5,
          tipo: "compra",
          costoUnitCents: -100,
        },
      ],
      { tipo: "compra", id: "ref-costo-negativo" },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(await nuevos()).toBe(0);
  });
});

/**
 * La fila de control del promedio.
 *
 * Es la que impide que dos lotes a la vez se pisen sin que nadie lo note. Mira
 * las unidades y el valor EXACTOS que este lote esperaba dejar —en absoluto, no
 * en delta— porque un control sobre el delta comprobaría la resta que la base
 * acaba de hacer, o sea algo que ya era cierto, y pasaría siempre (TRAMPAS §1).
 */
describe("la fila de control del promedio: dos lotes a la vez no se pisan", () => {
  /** Una base donde otro lote carga una compra justo antes de escribir. */
  const conCompraEnMedio = {
    prepare: (q: string) => real.DB.prepare(q),
    batch: async (enunciados: D1PreparedStatement[]) => {
      await real.DB.prepare(
        "UPDATE valor_inventario SET unidades = unidades + 5, valor_cents = valor_cents + 2500 WHERE codigo = 'INV-M'",
      ).run();
      return real.DB.batch(enunciados);
    },
  } as unknown as D1Database;

  it("si otro lote mueve el promedio en medio, no se escribe NADA", async () => {
    await conPromedio(10, 3_000);

    const r = await registrar(
      { db: conCompraEnMedio, actor: "usr-duena", ahora: T },
      {
        tipo: "merma",
        motivo: "promedio: carrera",
        lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3 }],
      },
    );

    expect(r.ok).toBe(false);
    // Leyó 10/3000 y calculó un costo de 900; para cuando escribió había
    // 15/5500 y ese 900 ya no era la parte proporcional de nada. Se cae el
    // lote entero: ni movimiento, ni físico, ni promedio.
    expect(await nuevos()).toBe(0);
    expect(await fisico("INV-M", "bod-inv-a")).toBe(10);
    expect(await promedio()).toMatchObject({ unidades: 15, valor_cents: 5_500 });
  });

  it("y lo dice como lo que es, no como «no alcanza el inventario»", async () => {
    // TRAMPAS §10: un error mal etiquetado manda a buscar al sitio
    // equivocado. Aquí no hay nada que contar en la bodega.
    await conPromedio(10, 3_000);

    const r = await aplicar(
      { db: conCompraEnMedio, actor: "usr-duena", ahora: T },
      [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3, tipo: "merma", motivo: "p: carrera 2" }],
      { tipo: "merma", id: "ref-carrera-2" },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("conflicto_version");
    expect(r.mensaje).toContain("costo promedio");
  });
});

/**
 * Deshacer y el promedio.
 *
 * Deshacer es escribir lo contrario, nunca borrar. Con el costo eso tiene una
 * trampa: el contrario de una entrada que NO subió el promedio no puede
 * bajarlo, o cada «me equivoqué» destruiría valor en silencio.
 */
describe("deshacer y el promedio", () => {
  it("deshacer una salida devuelve exactamente el valor que se llevó", async () => {
    await conPromedio(10, 3_000);

    const salida = await registrar(ctx, {
      tipo: "merma",
      motivo: "promedio: deshacer salida",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -3 }],
    });
    expect(salida.ok).toBe(true);
    if (!salida.ok || salida.datos.deshacerId === null) return;
    expect(await promedio()).toMatchObject({ unidades: 7, valor_cents: 2_100 });

    const r = await deshacer(ctx, salida.datos.deshacerId);
    expect(r.ok).toBe(true);
    // Vuelve con el costo con que salió: 3 × $3 = $9.
    expect(await promedio()).toMatchObject({ unidades: 10, valor_cents: 3_000 });
    expect(await fisico("INV-M", "bod-inv-a")).toBe(10);
  });

  it("deshacer una entrada que entró SIN costo no baja el promedio", async () => {
    // Esas unidades subieron el físico y no subieron el promedio. Cobrarles
    // ahora la parte proporcional sacaría de 1301 un valor que nunca entró
    // ahí, y dejaría más caras las unidades que sí tienen costo.
    await conPromedio(10, 3_000);

    const entrada = await registrar(ctx, {
      tipo: "apertura",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-b", delta: 5 }],
    });
    expect(entrada.ok).toBe(true);
    if (!entrada.ok || entrada.datos.deshacerId === null) return;
    expect(await promedio()).toMatchObject({ unidades: 10, valor_cents: 3_000 });

    const r = await deshacer(ctx, entrada.datos.deshacerId);
    expect(r.ok).toBe(true);
    expect(await fisico("INV-M", "bod-inv-b")).toBe(0);
    expect(await promedio()).toMatchObject({ unidades: 10, valor_cents: 3_000 });
  });

  it("deshacer un TRASLADO no inventa ni destruye valor", async () => {
    await conPromedio(10, 3_000);

    const t = await trasladar(ctx, {
      codigo: "INV-M",
      desdeId: "bod-inv-a",
      haciaId: "bod-inv-b",
      cantidad: 4,
      motivo: "promedio: traslado a deshacer",
    });
    expect(t.ok).toBe(true);
    if (!t.ok) return;

    const r = await deshacer(ctx, t.datos.deshacerId);
    expect(r.ok).toBe(true);
    expect(await fisico("INV-M", "bod-inv-a")).toBe(10);
    expect(await fisico("INV-M", "bod-inv-b")).toBe(0);
    expect(await promedio()).toMatchObject({ unidades: 10, valor_cents: 3_000 });
  });
});

describe("un movimiento no se deshace dos veces", () => {
  /**
   * El candado es de la BASE, no del código.
   *
   * `deshacer()` comprueba con un `NOT EXISTS` dentro del SELECT que arma el
   * lote, y eso es leer y después escribir: dos llamadas a la vez leen las dos
   * que nadie lo ha deshecho, y escriben las dos. El control de `aplicar()` no
   * las caza, y no es un descuido suyo: lo que ese control vigila es que no se
   * saque más de lo que hay, y los dos reversos de una venta son ENTRADAS.
   * Ninguna viola `fisico >= reservado`, así que el inventario queda por
   * encima de la realidad y nada protesta.
   *
   * Por eso la prueba no llama dos veces a `deshacer()` —eso probaría el
   * `NOT EXISTS`, que ya funciona cuando no hay carrera— sino que intenta
   * escribir el segundo reverso directamente, que es lo que una carrera
   * consigue. La defensa tiene que estar en el esquema o no está.
   *
   * El libro de al lado ya lo tenía: `asientos.revierte_id` es UNIQUE desde la
   * 0011, con el porqué escrito ahí («dos reversos del mismo error descuentan
   * el doble y el balance cuadra igual»). Este es el mismo fallo en la otra
   * tabla, y el libro de inventario se había quedado sin el candado.
   */
  const reverso = (nuevoId: string, original: string) =>
    real.DB.prepare(
      `INSERT INTO movimientos_inventario
         (id,codigo,bodega_id,delta,tipo,referencia_tipo,referencia_id,motivo,actor,revierte_id,creado_en)
       VALUES (?,'INV-M','bod-inv-a',-1,'ajuste','reverso','r-1','se deshace','prueba',?,?)`,
    )
      .bind(nuevoId, original, T)
      .run();

  it("la base rechaza un segundo reverso del mismo movimiento", async () => {
    const original = `mv-orig-${T}`;
    await real.DB.prepare(
      `INSERT INTO movimientos_inventario
         (id,codigo,bodega_id,delta,tipo,referencia_tipo,referencia_id,motivo,actor,creado_en)
       VALUES (?,'INV-M','bod-inv-a',1,'compra','compra','c-1',NULL,'prueba',?)`,
    )
      .bind(original, T)
      .run();

    // Deshacer una vez es legítimo.
    await reverso(`mv-rev-1-${T}`, original);

    // Dos, no. Antes de la 0018 esto entraba y el estante quedaba con una caja
    // menos de las que decía el sistema, sin una sola señal.
    await expect(reverso(`mv-rev-2-${T}`, original)).rejects.toThrow();
  });

  it("y los movimientos corrientes, que no deshacen nada, conviven sin chocar", async () => {
    // El índice es PARCIAL justo para esto. Sin el `WHERE revierte_id IS NOT
    // NULL`, el segundo movimiento normal del sistema chocaría con el primero
    // y no se podría mover una caja nunca más: el fallo contrario, y peor.
    const antes = await nuevos();
    for (let i = 0; i < 3; i++) {
      await real.DB.prepare(
        `INSERT INTO movimientos_inventario
           (id,codigo,bodega_id,delta,tipo,referencia_tipo,referencia_id,motivo,actor,creado_en)
         VALUES (?,'INV-M','bod-inv-a',1,'compra','compra',?,NULL,'prueba',?)`,
      )
        .bind(`mv-normal-${i}-${T}`, `c-${i}`, T)
        .run();
    }
    expect(await nuevos()).toBe(antes + 3);
  });
});

describe("una merma deja su huella en los libros", () => {
  /**
   * El asiento 12 —Debe 5201 «Mermas, muestras y regalos» · Haber 1301— estaba
   * escrito, probado y documentado en `dominio/contabilidad.ts`, y la cuenta
   * existía en el plan desde la migración 0011. **No lo llamaba nadie.**
   *
   * Lo que costaba: la caja desaparecía del inventario y su costo se quedaba
   * dentro del valor del inventario. El balance cuadraba igual —el promedio
   * bajaba— pero el gasto no existía en ninguna parte, así que la ganancia
   * salía más alta de lo que fue.
   */
  const asientosDe = async (hecho: string) =>
    (
      await real.DB.prepare("SELECT COUNT(*) AS n FROM asientos WHERE hecho = ?")
        .bind(hecho)
        .first<{ n: number }>()
    )?.n ?? 0;

  it("escribe el asiento 12, con el costo que de verdad salió", async () => {
    // Entra con costo conocido: 10 unidades a $2.00.
    const entrada = await registrar(ctx, {
      tipo: "compra",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: 10, costoUnitCents: 200 }],
    });
    expect(entrada.ok).toBe(true);

    const antes = await asientosDe("12");
    const r = await registrar(ctx, {
      tipo: "merma",
      motivo: "se mojaron dos cajas en la bodega",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -2 }],
    });
    expect(r.ok).toBe(true);
    expect(await asientosDe("12")).toBe(antes + 1);

    // Y por el monto correcto: 2 × $2.00, el costo del promedio, no el precio
    // de venta ni un número inventado.
    //
    // Se busca por el MOVIMIENTO, no por «el último asiento 12»: `creado_en`
    // es una constante en este archivo, así que ordenar por fecha devolvía el
    // asiento de otra prueba y la comprobación pasaba o fallaba por un motivo
    // que no era el suyo.
    const mov = await real.DB.prepare(
      "SELECT id FROM movimientos_inventario WHERE referencia_id = ? AND tipo = 'merma'",
    )
      .bind(r.ok ? r.datos.deshacerId : "")
      .first<{ id: string }>();
    expect(mov?.id).toBeDefined();

    const linea = await real.DB.prepare(
      `SELECT l.debe_cents FROM asiento_lineas l
         JOIN asientos a ON a.id = l.asiento_id
         JOIN cuentas c ON c.id = l.cuenta_id
        WHERE a.hecho = '12' AND a.referencia_id = ? AND c.codigo = '5201'`,
    )
      .bind(mov?.id ?? "")
      .first<{ debe_cents: number }>();
    expect(linea?.debe_cents).toBe(400);
  });

  it("sin costo conocido no se inventa un asiento, y se dice", async () => {
    // Nadie dijo lo que costó: el promedio no alcanza. Un cero diría que no
    // costó nada y pondría el margen en 100 % (TRAMPAS §7).
    const antes = await asientosDe("12");
    const r = await aplicar(
      ctx,
      [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -1, tipo: "merma", motivo: "se rompió" }],
      { tipo: "prueba", id: `mrm-${T}-sincosto` },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.sinAsiento).toContain("INV-M");
    expect(await asientosDe("12")).toBe(antes);
  });

  it("un ajuste o un conteo NO van a la cuenta de mermas", async () => {
    // Un conteo que encuentra menos no es una pérdida del negocio: es que lo
    // anotado estaba mal, y eso tiene su propio asiento. Mezclarlos haría que
    // los libros no distinguieran «se me rompió» de «la cuenta estaba mal».
    await registrar(ctx, {
      tipo: "compra",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: 10, costoUnitCents: 200 }],
    });
    const antes = await asientosDe("12");
    const r = await registrar(ctx, {
      tipo: "ajuste",
      motivo: "se contó mal el lunes",
      lineas: [{ codigo: "INV-M", bodegaId: "bod-inv-a", delta: -1 }],
    });
    expect(r.ok).toBe(true);
    expect(await asientosDe("12")).toBe(antes);
  });
});
