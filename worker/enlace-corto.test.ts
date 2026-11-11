import { describe, expect, it } from "vitest";
import { rutaCortaDeProducto } from "../src/seo/producto";

/**
 * El enlace corto de una ficha.
 *
 * Existe para compartir por chat: `babycaleb.com/p/nat-m` cabe en un mensaje,
 * se dicta por teléfono sin equivocarse y no se parte en dos líneas. La ruta
 * larga, pegada en WhatsApp junto a un texto, se corta y deja de ser enlace.
 */
describe("rutaCortaDeProducto", () => {
  it("lleva /p/<slug> a la ficha larga", () => {
    expect(rutaCortaDeProducto("/p/nat-m")).toBe("/productos/nat-m");
    expect(rutaCortaDeProducto("/p/panales-nateen-cierre-nat-m")).toBe(
      "/productos/panales-nateen-cierre-nat-m",
    );
  });

  it("aguanta la barra final: la gente copia enlaces con y sin ella", () => {
    expect(rutaCortaDeProducto("/p/nat-m/")).toBe("/productos/nat-m");
  });

  it("no toca ninguna otra ruta", () => {
    for (const camino of [
      "/",
      "/productos",
      "/productos/nat-m",
      "/p",
      "/p/",
      "/p/nat-m/extra",
      "/privacidad",
      "/api/catalogo",
      // `/p` como prefijo de otra palabra NO es un enlace corto: si lo fuera,
      // cualquier página futura que empiece por «p» se volvería un desvío.
      "/perfil",
      "/pedidos",
    ]) {
      expect(rutaCortaDeProducto(camino), camino).toBeNull();
    }
  });
});
