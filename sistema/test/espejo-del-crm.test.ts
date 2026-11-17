import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { libresSQL } from "../src/db/inventario";

/**
 * El espejo del CRM (migración 0020), contra una D1 de verdad.
 *
 * ## Por qué existe
 *
 * El 2026-11-17 babycaleb.com decía «agotado» en once de sus doce artículos
 * mientras el negocio tenía mercancía, cobraba $25.00 por unos wipes que el
 * CRM vende a $20.00, y no ofrecía tres pañales Velvee que sí estaban en
 * bodega. La 0020 puso el catálogo del sistema al día con el catálogo VIVO del
 * CRM, que es la verdad del precio mientras dure el traspaso.
 *
 * ## Qué vigilan estas pruebas
 *
 * No los números del CRM —ésos envejecen y para eso está `pnpm ensayo`, que
 * compara las dos bases en vivo—, sino las DECISIONES de la migración, que son
 * las que alguien puede aflojar sin darse cuenta: que la promoción siga siendo
 * un combo y no vuelva a tener existencias propias, que la cadena de tallas no
 * mande a nadie a algo que no se vende, y que no se vuelva a escribir un
 * precio dentro de un nombre.
 */

describe("el precio y el empaque de los wipes Dany Baby", () => {
  it("cuestan lo que el CRM cobra, no lo que la web cobraba", async () => {
    const v = await env.DB.prepare(
      "SELECT precio_cents, nombre FROM variantes WHERE codigo = 'DANY-AW600'",
    ).first<{ precio_cents: number; nombre: string }>();
    expect(v?.precio_cents).toBe(2000);
    // El empaque también estaba mal, y es lo que la clienta reclama al abrir
    // la caja: el CRM dice 6 paquetes de 100 y el sistema decía 12 de 50.
    expect(v?.nombre).toContain("6 paquetes de 100");
    expect(v?.nombre).not.toContain("12 paquetes de 50");
  });

  it("el cambio de precio quedó en el libro de los precios", async () => {
    // Sin la fila, mañana nadie sabe que la tienda cobró $25.00 por algo que
    // valía $20.00, ni desde cuándo dejó de hacerlo.
    const h = await env.DB.prepare(
      "SELECT precio_cents, motivo FROM precios_historial WHERE codigo = 'DANY-AW600'",
    ).first<{ precio_cents: number; motivo: string | null }>();
    expect(h?.precio_cents).toBe(2000);
    expect(h?.motivo ?? "").toMatch(/CRM/);
  });
});

describe("la promoción de 2 cajas", () => {
  it("es un combo de dos cajas, no un artículo con bodega propia", async () => {
    const v = await env.DB.prepare(
      "SELECT es_combo, precio_cents FROM variantes WHERE codigo = 'DANY-AW1200'",
    ).first<{ es_combo: number; precio_cents: number }>();
    expect(v?.es_combo).toBe(1);
    expect(v?.precio_cents).toBe(3500);

    const r = await env.DB.prepare(
      "SELECT codigo, cantidad FROM combo_componentes WHERE combo_codigo = 'DANY-AW1200'",
    ).all<{ codigo: string; cantidad: number }>();
    expect(r.results).toEqual([{ codigo: "DANY-AW600", cantidad: 2 }]);
  });

  it("su disponibilidad sale de las cajas que la componen", async () => {
    // Esto es lo que la tenía agotada: como variante suelta, sus existencias
    // propias eran cero aunque hubiera cajas de sobra de las que la forman.
    // Se prueba con el MISMO SQL que usa el sistema en producción, no con una
    // copia que podría dejar de parecerse.
    await env.DB.prepare(
      "UPDATE existencias SET fisico = 7 WHERE codigo = 'DANY-AW600' AND bodega_id = 'bod-1'",
    ).run();
    try {
      const r = await env.DB.prepare(
        `SELECT (${libresSQL("v")}) AS libres FROM variantes v WHERE v.codigo = 'DANY-AW1200'`,
      ).first<{ libres: number }>();
      // Siete cajas dan tres promociones y sobra una. Nunca tres y media.
      expect(r?.libres).toBe(3);
    } finally {
      await env.DB.prepare(
        "UPDATE existencias SET fisico = 0 WHERE codigo = 'DANY-AW600' AND bodega_id = 'bod-1'",
      ).run();
    }
  });
});

describe("los productos que el CRM vendía y el sistema no conocía", () => {
  it("Velvee entra con las tallas del resto del catálogo, para poder comparar", async () => {
    // El CRM las llama P, M y G. La tienda tiene que poder poner la M de
    // Velvee al lado de la M de Nateen, y para eso la talla que se guarda es
    // la del catálogo —S, M, L—; la letra del CRM se conserva en el nombre.
    const { results } = await env.DB.prepare(
      `SELECT v.codigo, v.talla, p.marca FROM variantes v JOIN productos p ON p.id = v.producto_id
        WHERE p.marca = 'Velvee' ORDER BY v.codigo`,
    ).all<{ codigo: string; talla: string; marca: string }>();
    expect(results).toEqual([
      { codigo: "VELVEE-L", talla: "L", marca: "Velvee" },
      { codigo: "VELVEE-M", talla: "M", marca: "Velvee" },
      { codigo: "VELVEE-P", talla: "S", marca: "Velvee" },
    ]);
  });

  it("hay al menos una talla con dos marcas que comparar", async () => {
    // El contrapeso de la prueba de arriba: las tallas podrían estar bien
    // escritas y no coincidir con ninguna de Nateen, y entonces el filtro de
    // la tienda no tendría nada que cruzar. Esto mide lo que la clienta ve.
    const r = await env.DB.prepare(
      `SELECT COUNT(*) n FROM (
         SELECT v.talla FROM variantes v JOIN productos p ON p.id = v.producto_id
          WHERE p.familia = 'panal' AND v.activo = 1 AND v.talla IS NOT NULL
          GROUP BY v.talla HAVING COUNT(DISTINCT p.marca) > 1
       )`,
    ).first<{ n: number }>();
    expect(r?.n).toBeGreaterThan(0);
  });

  it("el ITBMS de los nuevos es una respuesta, y la misma que ya usa el negocio", async () => {
    // Aquí NO vale el NULL de la carga inicial. Con NULL, `precios.ts` se
    // niega a calcular —a propósito— y el carrito se quedaría roto justo en
    // los artículos nuevos: la clienta los vería y no los podría pagar.
    //
    // El 0 no se inventó: es la tasa con la que el negocio ya vende las doce
    // variantes que tenía en producción. Si algún día la dueña dice otra, se
    // cambia aquí y esta prueba es la que avisa de que hay que cambiarla.
    const { results } = await env.DB.prepare(
      "SELECT codigo, tasa_itbms_bp FROM variantes WHERE codigo LIKE 'VELVEE-%' OR codigo = 'WIPESNAT'",
    ).all<{ codigo: string; tasa_itbms_bp: number | null }>();
    expect(results).toHaveLength(4);
    for (const v of results) expect(v.tasa_itbms_bp).toBe(0);
  });

  it("entran SIN PUBLICAR, porque todavía no tienen nada que ofrecer", async () => {
    // La regla es de `0003_carga_inicial.sql` y aquí es literal: la 0020 no
    // carga existencias, así que publicarlas ya las pondría en la tienda
    // diciendo «agotado» — el problema que vino a arreglar. Se publican tras
    // el conteo. Si alguien les pone `publicado = 1` en la migración, esto
    // avisa.
    const { results } = await env.DB.prepare(
      "SELECT codigo, publicado FROM variantes WHERE codigo LIKE 'VELVEE-%' OR codigo = 'WIPESNAT'",
    ).all<{ codigo: string; publicado: number }>();
    expect(results).toHaveLength(4);
    for (const v of results) expect(v.publicado).toBe(0);
  });

  it("su texto de venta queda en blanco: lo escribe la dueña, no yo", async () => {
    // El panel ya avisa fila por fila cuál le falta. Rellenarlo sería ponerle
    // palabras en la boca a su negocio.
    const { results } = await env.DB.prepare(
      "SELECT id, descripcion FROM productos WHERE id IN ('prod-vel', 'prod-wnt')",
    ).all<{ id: string; descripcion: string | null }>();
    expect(results).toHaveLength(2);
    for (const p of results) expect(p.descripcion).toBeNull();
  });
});

describe("lo que el CRM dejó de vender", () => {
  it("NAT-L no se ofrece, pero su fila sigue ahí", async () => {
    const v = await env.DB.prepare(
      "SELECT publicado, activo FROM variantes WHERE codigo = 'NAT-L'",
    ).first<{ publicado: number; activo: number }>();
    expect(v?.publicado).toBe(0);
    // Activo, no borrado: el día que repongan se vuelve a publicar con un
    // toque, y su historial sobrevive. Borrarla sería hacer lo mismo que el
    // CRM, que borra sus filas y no deja rastro de qué dejó de vender.
    expect(v?.activo).toBe(1);
  });

  it("la talla siguiente de NAT-M se salta la retirada", async () => {
    // NAT-M apuntaba a NAT-L. Sin corregirlo, la recompra ofrece la talla
    // siguiente y la clienta llega a un artículo que ya no se vende.
    const v = await env.DB.prepare(
      "SELECT siguiente_codigo FROM variantes WHERE codigo = 'NAT-M'",
    ).first<{ siguiente_codigo: string | null }>();
    expect(v?.siguiente_codigo).toBe("NAT-XL");
  });

  it("ninguna cadena de tallas apunta a una variante retirada", async () => {
    // La regla general, no solo el caso de NAT-M.
    //
    // Mide `activo`, no `publicado`, y no por comodidad: en esta base de
    // pruebas la 0003 deja TODO sin publicar, así que medir `publicado` daría
    // rojo en las nueve cadenas de Nateen y no diría nada de nadie. `activo` es
    // la pregunta que sí significa lo mismo aquí y en producción: una variante
    // retirada del catálogo no puede ser el destino de la recompra.
    const { results } = await env.DB.prepare(
      `SELECT v.codigo, v.siguiente_codigo FROM variantes v
         JOIN variantes s ON s.codigo = v.siguiente_codigo
        WHERE v.activo = 1 AND s.activo = 0`,
    ).all<{ codigo: string; siguiente_codigo: string }>();
    expect(results).toEqual([]);
  });

  it("los productos de prueba salieron del catálogo", async () => {
    const n = await env.DB.prepare(
      "SELECT COUNT(*) n FROM productos WHERE activo = 1 AND upper(nombre) LIKE '%PRUEBA%'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("un precio tiene un solo dueño", () => {
  it("ningún nombre ni descripción lleva una cifra de dinero dentro", async () => {
    // El CRM guarda «Promoción: 2 cajas … por $35.00» DENTRO del nombre de un
    // producto. Eso es un precio con dos dueños: el día que cambie, cambia en
    // `precio_cents` y el nombre sigue diciendo el viejo — y el nombre es lo
    // que la clienta lee. En el sistema el precio vive en su columna y nada
    // más, y esto es lo que lo mantiene así.
    const { results } = await env.DB.prepare(
      `SELECT codigo AS donde, nombre AS texto FROM variantes
        UNION ALL SELECT id, nombre FROM productos
        UNION ALL SELECT id, COALESCE(nombre_tienda, '') FROM productos
        UNION ALL SELECT id, COALESCE(descripcion, '') FROM productos`,
    ).all<{ donde: string; texto: string }>();

    const conPrecio = results.filter((r) => /[$]\s*\d|\d+[.,]\d{2}\s*(?:B\/|USD|\$)/.test(r.texto));
    expect(conPrecio.map((r) => `${r.donde}: ${r.texto}`)).toEqual([]);
  });
});
