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

// ---------------------------------------------------------------------------
// El Worker tiene que CORRER en esa ruta
// ---------------------------------------------------------------------------
//
// Esta prueba existe porque el enlace corto estuvo roto en producción con todo
// el código correcto. `rutaCortaDeProducto` funcionaba, el Worker la llamaba, y
// la redirección nunca ocurría: `/p/*` no estaba en `run_worker_first`, así que
// la petición la atendía el servidor de archivos estáticos, no encontraba nada,
// caía en `single-page-application` y devolvía el index.html de la web. Quien
// recibía un enlace compartido veía una página vacía —con un 200, que es lo que
// lo hacía invisible—.
//
// Saberlo no basta: el aviso ya estaba escrito en `wrangler.jsonc`, al lado, en
// el comentario de `/foto/*`. Por eso ahora lo vigila una prueba.

// `?raw` mete el contenido del archivo en el bundle. Se lee así y no con
// `node:fs` porque estas pruebas corren dentro de workerd, que no ve el disco
// — pero lo que importa es que se lee el `wrangler.jsonc` DE VERDAD, no una
// copia: una copia se queda vieja y la prueba pasaría sobre nada.
import wrangler from "../wrangler.jsonc?raw";

/** Las rutas de `run_worker_first`, leídas del `wrangler.jsonc` de verdad. */
function rutasQueCorrenElWorker(): string[] {
  const bloque = /"run_worker_first"\s*:\s*\[([\s\S]*?)\]/.exec(wrangler);
  if (bloque === null) throw new Error("no encontré run_worker_first en wrangler.jsonc");
  // Se leen las cadenas entre comillas; los comentarios de en medio no tienen.
  return [...bloque[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("el Worker corre donde tiene que correr", () => {
  it("/p/* está en run_worker_first", () => {
    expect(rutasQueCorrenElWorker()).toContain("/p/*");
  });

  it("toda ruta que el Worker atiende está en la lista", () => {
    // Si mañana se añade otro desvío o otra API y se olvida la lista, esto se
    // pone rojo antes de que alguien comparta un enlace muerto.
    const lista = rutasQueCorrenElWorker();
    const cubre = (ruta: string): boolean =>
      lista.some((patron) =>
        patron.endsWith("/*") ? ruta.startsWith(patron.slice(0, -1)) : patron === ruta,
      );

    for (const ruta of ["/p/nat-m", "/api/chat", "/api/catalogo", "/api/salud", "/foto/abc.jpg"]) {
      expect(cubre(ruta), `«${ruta}» la atiende el Worker pero no está en la lista`).toBe(true);
    }
  });
});
