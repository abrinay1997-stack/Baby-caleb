import { describe, expect, it } from "vitest";

import { cuantasFichas, estadoEnLaTienda } from "./fichas";

/**
 * Por qué un artículo publicado no sale en la tienda.
 *
 * Esta es la mitad que faltaba del fallo que el dueño persiguió cuatro días: la
 * tienda ya no puede ofrecer lo que el sistema retiró, pero un producto creado
 * en el panel sigue sin salir, porque su texto de venta vive en `content.json`
 * y nadie lo escribió todavía. (La foto ya no: esa llega del sistema.)
 *
 * Eso no es un error que se pueda arreglar solo: es trabajo que alguien tiene
 * que hacer. Lo que SÍ es un error es que nadie lo diga. Antes la dueña
 * publicaba, abría la tienda, no veía su producto, y no tenía forma de saber
 * si se había equivocado ella, si tardaba, o si estaba roto.
 */

describe("qué dice el panel de un artículo que no sale en la tienda", () => {
  it("lee las fichas de verdad del archivo, no una lista copiada", () => {
    // Si este número fuera 0, todo lo demás diría «le falta la ficha» sobre
    // TODOS los artículos, y sonaría razonable. Es la trampa §1: un control
    // que aprueba —o en este caso acusa— siempre.
    expect(cuantasFichas()).toBeGreaterThan(5);
  });

  it("lo que está publicado y tiene ficha, sale", () => {
    const r = estadoEnLaTienda({ codigo: "NAT-M", publicado: 1, activo: 1 });
    expect(r.sale).toBe(true);
    expect(r.motivo).toBeNull();
  });

  it("lo creado en el panel sin ficha no sale, y lo explica", () => {
    const r = estadoEnLaTienda({ codigo: "ZZ-INVENTADO", publicado: 1, activo: 1 });
    expect(r.sale).toBe(false);
    expect(r.motivo).toContain("ficha");
    // Y dice la parte que de verdad sorprende: sí se puede pedir por enlace.
    expect(r.motivo).toContain("enlace");
  });

  it("lo despublicado dice que está despublicado, no que le falta la ficha", () => {
    // El orden de las razones importa: se dice primero la que la dueña puede
    // arreglar de un toque. Si le contáramos lo de la ficha, arreglaría eso y
    // seguiría sin salir.
    const r = estadoEnLaTienda({ codigo: "NAT-M", publicado: 0, activo: 1 });
    expect(r.sale).toBe(false);
    expect(r.motivo).toContain("publicada");
    expect(r.motivo).not.toContain("ficha");
  });

  it("lo retirado lo dice antes que nada", () => {
    const r = estadoEnLaTienda({ codigo: "NAT-M", publicado: 1, activo: 0 });
    expect(r.sale).toBe(false);
    expect(r.motivo).toContain("retirada");
  });

  it("no le dice que falta la foto, porque la foto ya llega del sistema", () => {
    // Esta guarda existe porque el motivo SÍ decía «le falta la descripción, la
    // foto y el texto de venta», y siguió diciéndolo después de que la foto del
    // panel empezara a llegar a la tienda. Comprobado en producción el 14-nov:
    // la página de ZZ-PRUEBA-01 pinta su foto desde el sistema, a 1080 px,
    // mientras el panel le decía a la dueña que faltaba.
    //
    // Es la trampa §10 —un mensaje que nombra la causa equivocada— y la peor
    // versión: le dice que falta justo lo que acaba de subir.
    const m = estadoEnLaTienda({ codigo: "ZZ-INVENTADO", publicado: 1, activo: 1 }).motivo ?? "";
    // Se mira la FRASE que habla de la foto, no el mensaje entero: un
    // `/falta.*foto/` casa con «le falta el texto de venta. Su foto ya sale
    // del sistema», que es justo lo que queremos que diga.
    const sobreLaFoto = m.split(/(?<=\.)\s+/).filter((f) => /foto/i.test(f));
    expect(sobreLaFoto.length, "el motivo ya no habla de la foto").toBeGreaterThan(0);
    for (const f of sobreLaFoto) expect(f).not.toMatch(/falta|no tiene|sin foto/i);
    // Y sí nombra lo único que de verdad falta, y a quién pedírselo.
    expect(m).toContain("texto de venta");
    expect(m).toContain("Juan");
  });

  it("el motivo está escrito para la dueña, no para un programador", () => {
    // Nada de nombres de archivo, de columnas ni de códigos de error: lo que
    // sale aquí se le enseña TAL CUAL en el panel.
    const motivos = [
      estadoEnLaTienda({ codigo: "ZZ-INVENTADO", publicado: 1, activo: 1 }).motivo,
      estadoEnLaTienda({ codigo: "NAT-M", publicado: 0, activo: 1 }).motivo,
      estadoEnLaTienda({ codigo: "NAT-M", publicado: 1, activo: 0 }).motivo,
    ];
    for (const m of motivos) {
      expect(m).not.toBeNull();
      expect(m).not.toMatch(/content\.json|null|undefined|SELECT|variantes\.|_id\b/);
      expect((m ?? "").endsWith(".")).toBe(true);
    }
  });
});
