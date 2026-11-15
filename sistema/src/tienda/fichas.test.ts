import { describe, expect, it } from "vitest";

import { estadoEnLaTienda } from "./fichas";

/**
 * Qué dice el panel de un artículo, y qué dejó de decir.
 *
 * Esta era la mitad que faltaba del fallo que el dueño persiguió cuatro días:
 * un producto creado en el panel no salía en la tienda porque la lista se
 * armaba con las fichas de `content.json` —un archivo del repositorio de la
 * web que nadie escribe— y el suyo no tenía ninguna.
 *
 * Desde la migración 0019 la lista sale del catálogo del sistema, así que esa
 * razón YA NO EXISTE: publicado y activo quiere decir que se ve. Lo que queda
 * del texto de venta es un aviso, y la diferencia entre un aviso y un motivo
 * es justo lo que estas pruebas fijan — porque confundirlos devolvería a la
 * dueña a no publicar esperando a escribir un párrafo.
 */

const suelta = { codigo: "NAT-M", publicado: 1, activo: 1 };

describe("qué dice el panel de un artículo y la tienda", () => {
  it("publicada y activa SALE, aunque nadie haya escrito su ficha", () => {
    // Esta es la prueba del cambio entero. Antes salía `sale: false` con el
    // motivo «la tienda todavía no tiene su ficha», y era verdad: hoy sería
    // mentira.
    const r = estadoEnLaTienda({ ...suelta, descripcionDelProducto: null });
    expect(r.sale).toBe(true);
    expect(r.motivo).toBeNull();
  });

  it("y si le falta el texto de venta lo dice como AVISO, no como motivo", () => {
    const r = estadoEnLaTienda({ ...suelta, descripcionDelProducto: null });
    expect(r.aviso).toContain("texto de venta");
    // Lo que no puede pasar: que el aviso se lea como la razón de no salir.
    expect(r.sale).toBe(true);
    expect(r.motivo).toBeNull();
  });

  it("con texto de venta no avisa de nada", () => {
    const r = estadoEnLaTienda({ ...suelta, descripcionDelProducto: "Hipoalergénicos y suaves." });
    expect(r.sale).toBe(true);
    expect(r.aviso).toBeNull();
  });

  it("un texto en blanco cuenta como que falta, no como texto", () => {
    // Un `"   "` guardado por una herramienta que se salte la validación haría
    // que la tarjeta pintara un párrafo vacío y que el panel no avisara.
    const r = estadoEnLaTienda({ ...suelta, descripcionDelProducto: "   " });
    expect(r.aviso).toContain("texto de venta");
  });

  it("sin publicar no sale, y esa es la razón que se dice primero", () => {
    const r = estadoEnLaTienda({ codigo: "NAT-M", publicado: 0, activo: 1, descripcionDelProducto: null });
    expect(r.sale).toBe(false);
    expect(r.motivo).toContain("publicada");
    // Y NO se le habla del texto: arreglaría eso y seguiría sin salir.
    expect(r.aviso).toBeNull();
  });

  it("retirada gana a sin publicar", () => {
    const r = estadoEnLaTienda({ codigo: "NAT-M", publicado: 0, activo: 0 });
    expect(r.sale).toBe(false);
    expect(r.motivo).toContain("retirada");
  });

  it("ya no le dice que falta la foto: la foto llega del sistema", () => {
    // La guarda de ayer, que sigue valiendo. El motivo decía «le falta la
    // descripción, la foto y el texto de venta» y lo siguió diciendo después
    // de que la foto del panel empezara a llegar a la tienda: le avisaba de
    // que faltaba justo lo que acababa de subir (trampa §10).
    const textos = [
      estadoEnLaTienda({ ...suelta, descripcionDelProducto: null }).aviso,
      estadoEnLaTienda({ codigo: "NAT-M", publicado: 0, activo: 1 }).motivo,
      estadoEnLaTienda({ codigo: "NAT-M", publicado: 1, activo: 0 }).motivo,
    ];
    for (const t of textos) expect(t ?? "").not.toMatch(/foto/i);
  });

  it("lo que se enseña está escrito para la dueña, no para un programador", () => {
    // Nada de nombres de archivo, de columnas ni de códigos de error: lo que
    // sale aquí se le enseña TAL CUAL en el panel.
    const textos = [
      estadoEnLaTienda({ ...suelta, descripcionDelProducto: null }).aviso,
      estadoEnLaTienda({ codigo: "NAT-M", publicado: 0, activo: 1 }).motivo,
      estadoEnLaTienda({ codigo: "NAT-M", publicado: 1, activo: 0 }).motivo,
    ];
    for (const t of textos) {
      expect(t).not.toBeNull();
      expect(t).not.toMatch(/content\.json|null|undefined|SELECT|productos\.|_id\b/);
      expect((t ?? "").endsWith(".")).toBe(true);
    }
  });
});
