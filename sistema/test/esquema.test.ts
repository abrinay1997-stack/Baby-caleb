import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Estas pruebas corren contra una D1 de verdad dentro de workerd. No comprueban
// que el SQL esté bien escrito (eso lo haría cualquier SQLite): comprueban que
// D1 HACE CUMPLIR lo que el plan da por sentado. Si D1 ignorara STRICT, los
// triggers o las llaves foráneas, el diseño de 02-datos.md no se sostendría.

const ahora = () => Date.now();

/**
 * Siembra un producto, una variante, una bodega y su fila de existencias, y
 * deja las existencias en 10 físicas / 0 reservadas.
 *
 * Es idempotente a propósito: este runner no aísla el almacenamiento entre
 * pruebas del mismo archivo, y los movimientos NO se pueden borrar para
 * limpiar (el trigger lo prohíbe, que es precisamente lo que se quiere). Así
 * que cada prueba parte de una base conocida sin tocar los libros.
 */
async function sembrar() {
  const t = ahora();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p1','panal','Producto de pruebas','producto-de-pruebas',?)",
    ).bind(t),
    env.DB.prepare(
      "INSERT OR IGNORE INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,actualizado_en) VALUES ('PRUEBA-M','p1','Variante de pruebas del esquema','M',144,5000,?)",
    ).bind(t),
    // Nombre propio de la prueba, no el de una bodega de verdad: desde la
    // carga inicial (0003) «Bodega Ciudad de Panamá» ya existe con otro id, y
    // como `nombre` es UNIQUE, el OR IGNORE se saltaba la fila en silencio y
    // la llave foránea de existencias fallaba después, lejos de la causa.
    env.DB.prepare("INSERT OR IGNORE INTO bodegas (id,nombre) VALUES ('bod-pty','Bodega de pruebas del esquema')"),
    env.DB.prepare("INSERT OR IGNORE INTO existencias (codigo,bodega_id,fisico) VALUES ('PRUEBA-M','bod-pty',10)"),
    env.DB.prepare("UPDATE existencias SET fisico = 10, reservado = 0 WHERE codigo='PRUEBA-M' AND bodega_id='bod-pty'"),
  ]);
  return t;
}

describe("migración 0001 desde cero", () => {
  it("crea las tablas del alcance de F2.2 y ninguna que dependa de pedidos", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    const tablas = results.map((r) => r.name);

    for (const esperada of [
      "productos", "variantes", "precios_historial",
      "bodegas", "existencias", "movimientos_inventario", "valor_inventario",
      "traslados", "traslado_lineas", "conteos", "conteo_lineas",
      "zonas_envio", "motorizados",
      "clientes", "identidades", "direcciones", "fusiones_cliente",
      "usuarios", "ajustes", "idempotencia", "eventos_salida", "eventos_recibidos",
      "archivos", "sesiones", "codigos_acceso", "controles", "secuencias",
    ]) {
      expect(tablas, `falta ${esperada}`).toContain(esperada);
    }

    // Lo que lleva llave foránea a pedidos nace en F4a: aquí no debe estar.
    for (const futura of ["pedidos", "pedido_lineas", "reservas", "envios", "pagos", "asientos"]) {
      expect(tablas, `${futura} no es de esta migración`).not.toContain(futura);
    }
  });

  it("deja todas las tablas en STRICT", async () => {
    const { results } = await env.DB.prepare(
      // _cf_METADATA y d1_migrations son de D1, no del esquema del sistema.
      "SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string; strict: number }>();
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((t) => t.strict !== 1).map((t) => t.name)).toEqual([]);
  });

  it("precarga las secuencias de numeración", async () => {
    const { results } = await env.DB.prepare("SELECT nombre, valor FROM secuencias ORDER BY nombre").all();
    expect(results).toEqual([
      { nombre: "compra", valor: 0 },
      { nombre: "pedido", valor: 0 },
    ]);
  });
});

describe("D1 hace cumplir STRICT", () => {
  it("rechaza texto en una columna INTEGER", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES ('px','panal','N','n-x','ayer')",
      ).run(),
    ).rejects.toThrow(/INTEGER|STRICT|cannot store/i);
  });
});

describe("D1 hace cumplir las llaves foráneas", () => {
  it("rechaza una variante cuyo producto no existe", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,actualizado_en) VALUES ('X-1','fantasma','X',1,100,?)",
      ).bind(ahora()).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rechaza un movimiento sin su fila de existencias", async () => {
    await sembrar();
    await expect(
      env.DB.prepare(
        "INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en) VALUES ('mx','PRUEBA-M','bodega-que-no-existe',1,'compra','sistema',?)",
      ).bind(ahora()).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe("los libros no se editan", () => {
  it("aborta UPDATE y DELETE sobre movimientos_inventario", async () => {
    const t = await sembrar();
    await env.DB.prepare(
      "INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en) VALUES ('m1','PRUEBA-M','bod-pty',10,'apertura','sistema',?)",
    ).bind(t).run();

    await expect(
      env.DB.prepare("UPDATE movimientos_inventario SET delta = 99 WHERE id='m1'").run(),
    ).rejects.toThrow(/no se edita/);
    await expect(
      env.DB.prepare("DELETE FROM movimientos_inventario WHERE id='m1'").run(),
    ).rejects.toThrow(/no se borra/);

    // y el movimiento sigue intacto
    const fila = await env.DB.prepare("SELECT delta FROM movimientos_inventario WHERE id='m1'").first<{ delta: number }>();
    expect(fila?.delta).toBe(10);
  });

  it("exige motivo en merma, ajuste, muestra, regalo y conteo", async () => {
    const t = await sembrar();
    await expect(
      env.DB.prepare(
        "INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en) VALUES ('m2','PRUEBA-M','bod-pty',-1,'merma','duena',?)",
      ).bind(t).run(),
    ).rejects.toThrow(/CHECK/i);

    await env.DB.prepare(
      "INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,motivo,actor,creado_en) VALUES ('m3','PRUEBA-M','bod-pty',-1,'merma','caja mojada','duena',?)",
    ).bind(t).run();
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM movimientos_inventario WHERE tipo='merma'").first<{ c: number }>();
    expect(n?.c).toBe(1);
  });
});

describe("restricciones de existencias", () => {
  it("no deja reservar más de lo que hay ni dejar el físico en negativo", async () => {
    await sembrar();
    await expect(
      env.DB.prepare("UPDATE existencias SET reservado = 99 WHERE codigo='PRUEBA-M'").run(),
    ).rejects.toThrow(/reservado <= fisico/);
    await expect(
      env.DB.prepare("UPDATE existencias SET fisico = -1 WHERE codigo='PRUEBA-M'").run(),
    ).rejects.toThrow(/fisico >= 0/);
  });
});

describe("la fila de control tumba el batch entero", () => {
  // El corazón del diseño sin transacciones interactivas (02-datos.md §1): un
  // UPDATE que no encuentra su fila NO falla, así que la condición se comprueba
  // con una fila cuya restricción solo se cumple si el cambio ocurrió.
  it("revierte todo el batch cuando la condición no se cumplió", async () => {
    await sembrar();
    const t = ahora();

    await expect(
      env.DB.batch([
        // Este UPDATE no encuentra nada (la bodega no es esa): cambia 0 filas y NO falla.
        env.DB.prepare("UPDATE existencias SET fisico = 5 WHERE codigo='PRUEBA-M' AND bodega_id='otra'"),
        // El control sí falla, porque el cambio no ocurrió.
        env.DB.prepare(
          "INSERT INTO controles (id,regla,ok,creado_en) VALUES ('c-malo','ajuste_stock',(SELECT COUNT(*) FROM existencias WHERE codigo='PRUEBA-M' AND bodega_id='otra' AND fisico=5),?)",
        ).bind(t),
        // Y esto nunca debe quedar escrito.
        env.DB.prepare(
          "INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en) VALUES ('m-malo','PRUEBA-M','bod-pty',-5,'ajuste','sistema',?)",
        ).bind(t),
      ]),
    ).rejects.toThrow(/CHECK|ok = 1/i);

    // Todo o nada: el movimiento del tercer paso no existe.
    const m = await env.DB.prepare("SELECT COUNT(*) c FROM movimientos_inventario WHERE id='m-malo'").first<{ c: number }>();
    expect(m?.c).toBe(0);
    const c = await env.DB.prepare("SELECT COUNT(*) c FROM controles WHERE id='c-malo'").first<{ c: number }>();
    expect(c?.c).toBe(0);
  });

  it("deja pasar el batch cuando la condición sí se cumplió", async () => {
    await sembrar();
    const t = ahora();

    await env.DB.batch([
      env.DB.prepare("UPDATE existencias SET fisico = 5 WHERE codigo='PRUEBA-M' AND bodega_id='bod-pty'"),
      env.DB.prepare(
        "INSERT INTO controles (id,regla,ok,creado_en) VALUES ('c-bueno','ajuste_stock',(SELECT COUNT(*) FROM existencias WHERE codigo='PRUEBA-M' AND bodega_id='bod-pty' AND fisico=5),?)",
      ).bind(t),
      env.DB.prepare(
        "INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,motivo,actor,creado_en) VALUES ('m-bueno','PRUEBA-M','bod-pty',-5,'ajuste','conteo del lunes','duena',?)",
      ).bind(t),
    ]);

    const e = await env.DB.prepare("SELECT fisico FROM existencias WHERE codigo='PRUEBA-M'").first<{ fisico: number }>();
    expect(e?.fisico).toBe(5);
    const m = await env.DB.prepare("SELECT COUNT(*) c FROM movimientos_inventario WHERE id='m-bueno'").first<{ c: number }>();
    expect(m?.c).toBe(1);
  });
});

describe("el costo no vive en el catálogo", () => {
  it("variantes no tiene ninguna columna de costo", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('variantes')").all<{ name: string }>();
    const columnas = results.map((r) => r.name);
    expect(columnas.filter((c) => /costo|cost/i.test(c))).toEqual([]);
    // el costo vive aparte, en valor_inventario
    const v = await env.DB.prepare("SELECT name FROM pragma_table_info('valor_inventario')").all<{ name: string }>();
    expect(v.results.map((r) => r.name)).toContain("valor_cents");
  });
});
