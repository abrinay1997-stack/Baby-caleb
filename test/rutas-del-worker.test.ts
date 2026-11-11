import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Qué rutas atiende el Worker antes que los archivos estáticos.
 *
 * Esta prueba existe por un fallo que llegó a producción: al añadir las fotos
 * del catálogo le puse al Worker la ruta `/img/*`, sin mirar que `/img/` YA
 * era de las imágenes del sitio —el logo, el hero, las 26 de `public/img/`—.
 * El Worker se puso delante, las buscó en R2, no las encontró, y el sitio
 * entero se quedó sin imágenes. Con un despliegue en verde y todas las pruebas
 * pasando: el fallo no estaba en el código sino en la LISTA.
 *
 * Por eso se mira la lista, y desde aquí: dentro del Worker no existe el
 * disco del repositorio.
 */

const config = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
const lista = config.slice(
  config.indexOf('"run_worker_first"'),
  config.indexOf("]", config.indexOf('"run_worker_first"')),
);

/** Lo que de verdad sirve el servidor de archivos estáticos. */
const CARPETAS_ESTATICAS = ["/img/", "/assets/", "/fonts/"];

describe("el Worker no se pone delante de los archivos del sitio", () => {
  it("no atiende ninguna carpeta de archivos estáticos", () => {
    for (const carpeta of CARPETAS_ESTATICAS) {
      expect(lista, `${carpeta} lo sirve el sitio, no el Worker`).not.toContain(`"${carpeta}*"`);
    }
  });

  it("las fotos del catálogo tienen su propio prefijo", () => {
    expect(lista).toContain('"/foto/*"');
  });

  it("y ese prefijo no es ninguna carpeta del sitio", () => {
    const enDisco = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
    expect(enDisco).toContain('"/foto/*"');
    for (const carpeta of CARPETAS_ESTATICAS) {
      expect(`/foto/`).not.toBe(carpeta);
    }
  });
});
