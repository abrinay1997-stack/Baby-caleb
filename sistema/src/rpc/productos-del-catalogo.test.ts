import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ponerFichaDeTienda } from "../db/catalogo-admin";
import { catalogoPublico, comoLoTitulaLaTienda, listar, textoDeVenta } from "./catalogo";

/**
 * La lista de la tienda sale del sistema, no de un archivo del repositorio.
 *
 * EL FALLO QUE CIERRA. La dueña creaba un producto en el panel, le ponía
 * precio, le subía la foto y lo publicaba — y no salía en babycaleb.com. No
 * había error en ninguna parte: la lista se armaba con las fichas de
 * `content.json`, que nadie escribe desde ningún sitio, así que el producto
 * tenía su página y su foto y no entraba en la lista hasta que un programador
 * editara ese archivo y desplegara. El dueño preguntó cuatro días seguidos.
 *
 * Es la trampa §12 otra vez: todas las piezas construidas —crear el producto,
 * el precio, la foto, la página— y la última sin enchufar.
 *
 * Se prueba por la puerta por la que lo va a leer la tienda (`catalogoPublico`)
 * y no solo sobre las funciones puras, que es lo que manda la trampa §6.
 */

const AHORA = 1_800_000_000_000;
const ctx = { db: env.DB, ahora: AHORA, actor: "duena@babycaleb.com" };

describe("cómo titula la tienda un producto", () => {
  it("usa el nombre de la tienda cuando lo hay", () => {
    expect(comoLoTitulaLaTienda("Pañales Nateen", "Pañal Nateen de cierre")).toBe("Pañales Nateen");
  });

  it("y cae al nombre de operación cuando no, que es lo que salva a uno recién creado", () => {
    // Sin esta caída, un producto hecho desde el teléfono saldría con la
    // tarjeta sin título hasta que alguien escribiera un segundo nombre.
    expect(comoLoTitulaLaTienda(null, "Pañal Nateen de cierre")).toBe("Pañal Nateen de cierre");
    expect(comoLoTitulaLaTienda(undefined, "Fular Moon")).toBe("Fular Moon");
    // Un blanco no es un título.
    expect(comoLoTitulaLaTienda("   ", "Fular Moon")).toBe("Fular Moon");
  });
});

describe("el texto de venta", () => {
  it("el vacío es «falta», no «no hay nada que decir» (trampa §7)", () => {
    expect(textoDeVenta(null)).toBeNull();
    expect(textoDeVenta("")).toBeNull();
    expect(textoDeVenta("   ")).toBeNull();
    expect(textoDeVenta(" Suaves. ")).toBe("Suaves.");
  });
});

describe("los productos que la tienda puede pintar", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE variantes SET publicado = 0"),
      env.DB.prepare("UPDATE variantes SET publicado = 1 WHERE codigo IN ('NAT-M', 'NAT-L')"),
    ]);
  });

  it("vienen en el catálogo, con su texto de venta de la carga inicial", async () => {
    const c = await catalogoPublico(env.DB, AHORA);
    const pan = c.productos.find((p) => p.slug === "panales-nateen-cierre");
    expect(pan).toBeDefined();
    // La migración 0019 copió lo que la tienda YA decía, para que el día del
    // despliegue se viera igual que la víspera.
    expect(pan?.nombre).toBe("Pañales Nateen");
    expect(pan?.descripcion).toContain("Hipoalergénicos");
  });

  it("solo los que tienen alguna presentación visible: no hay tarjetas vacías", async () => {
    const c = await catalogoPublico(env.DB, AHORA);
    // Solo NAT-M y NAT-L están publicadas, y las dos son del mismo producto.
    expect(c.productos).toHaveLength(1);
    expect(c.productos[0]?.slug).toBe("panales-nateen-cierre");
  });

  it("cada variante dice a qué producto pertenece, para poder agruparlas", async () => {
    const c = await catalogoPublico(env.DB, AHORA);
    for (const v of c.variantes) expect(v.productoSlug).toBe("panales-nateen-cierre");
    // Y no es el slug de la variante, que lleva el código pegado detrás.
    expect(c.variantes[0]?.slug).not.toBe(c.variantes[0]?.productoSlug);
  });

  it("un producto SIN texto de venta sale igual: publicar basta", async () => {
    // Esta es la prueba del cambio entero. Antes, un producto sin ficha no
    // entraba en la lista de la tienda por mucho que estuviera publicado.
    await env.DB.prepare("UPDATE productos SET descripcion = NULL WHERE id = 'prod-pan'").run();
    const c = await catalogoPublico(env.DB, AHORA);
    expect(c.productos.map((p) => p.slug)).toContain("panales-nateen-cierre");
    expect(c.productos[0]?.descripcion).toBeNull();
  });

  it("el producto NO sale hacia el bot: listar y buscar siguen sin saber de esto", async () => {
    // `listar` contesta WhatsApps con texto y no arma tarjetas. Darle el campo
    // obligaría a leerlo en cada turno del asistente para nada.
    const v = await listar(env.DB);
    expect(v[0]).toBeDefined();
    expect(JSON.stringify(v)).not.toContain("descripcion");
    expect(JSON.stringify(v)).not.toContain("productoSlug");
  });
});

describe("escribir la ficha desde el panel o por MCP", () => {
  beforeEach(async () => {
    await env.DB.prepare("UPDATE variantes SET publicado = 1 WHERE codigo = 'NAT-M'").run();
  });

  const elProducto = async () =>
    await env.DB.prepare("SELECT nombre_tienda, descripcion FROM productos WHERE id = 'prod-pan'")
      .first<{ nombre_tienda: string | null; descripcion: string | null }>();

  it("escribe el texto y llega a la tienda", async () => {
    const r = await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "Suaves y de bambú." });
    expect(r.ok).toBe(true);

    const c = await catalogoPublico(env.DB, AHORA);
    expect(c.productos.find((p) => p.slug === "panales-nateen-cierre")?.descripcion).toBe(
      "Suaves y de bambú.",
    );
  });

  it("lo que no se manda NO se toca: corregir el título no borra el texto", async () => {
    // Un panel que mandara siempre las dos columnas borraría el texto de venta
    // cada vez que alguien arregla una tilde del título.
    await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "Suaves y de bambú." });
    await ponerFichaDeTienda(ctx, "prod-pan", { nombreTienda: "Pañales Nateen®" });

    const p = await elProducto();
    expect(p?.nombre_tienda).toBe("Pañales Nateen®");
    expect(p?.descripcion).toBe("Suaves y de bambú.");
  });

  it("el nulo sí borra, y el vacío también: son lo mismo para la dueña", async () => {
    await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "Algo." });
    await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: null });
    expect((await elProducto())?.descripcion).toBeNull();

    // Vaciar el campo en el panel manda "" y la base lo rechazaría con un
    // CHECK: tiene que llegar como NULL, no como «constraint failed».
    await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "Algo." });
    const r = await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "   " });
    expect(r.ok).toBe(true);
    expect((await elProducto())?.descripcion).toBeNull();
  });

  it("sube la versión del catálogo, o la web se queda con la copia vieja", async () => {
    const antes = (await catalogoPublico(env.DB, AHORA)).version;
    await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "Texto nuevo." });
    const despues = (await catalogoPublico(env.DB, AHORA)).version;
    // `productos` no tiene columna `version`: la del catálogo es la más alta de
    // las variantes. Sin subirla, la web habría seguido creyendo vigente una
    // copia con el texto viejo.
    expect(despues).toBeGreaterThan(antes);
  });

  it("no se pide ningún cambio: lo dice en vez de escribir nada", async () => {
    const r = await ponerFichaDeTienda(ctx, "prod-pan", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
  });

  it("un producto que no existe se nombra como tal, no como «algo falló»", async () => {
    const r = await ponerFichaDeTienda(ctx, "no-existe", { descripcion: "Hola." });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });

  it("un texto larguísimo se rechaza con un mensaje que se entiende", async () => {
    const r = await ponerFichaDeTienda(ctx, "prod-pan", { descripcion: "x".repeat(601) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(r.mensaje).toMatch(/600/);
    expect(r.mensaje).not.toMatch(/constraint|CHECK/i);
  });
});
