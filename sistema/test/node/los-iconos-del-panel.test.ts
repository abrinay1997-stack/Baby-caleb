import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Los iconos con los que el panel se guarda en la pantalla de inicio.
 *
 * `panel/index.html` dice de ellos: «los cuatro son OPACOS con las esquinas
 * blancas, comprobado leyendo el píxel: iOS pinta de NEGRO lo que sea
 * transparente en el icono». Era verdad, y era una comprobación hecha UNA vez
 * a mano, escrita en un comentario. No hay generador: los cuatro PNG están
 * puestos ahí a mano, así que el día que alguien los vuelva a exportar —con
 * fondo transparente, que es lo que hace cualquier editor por defecto— el
 * comentario seguirá diciendo que son opacos.
 *
 * Y el icono es lo único del panel que la dueña ve ANTES de abrirlo. Un
 * cuadrado negro en su pantalla de inicio no rompe ninguna prueba.
 *
 * Aquí no hace falta decodificar el PNG: el formato ya lo dice. Un PNG de
 * paleta o de color verdadero **no tiene canal alfa**, y sin un trozo `tRNS`
 * tampoco tiene ningún color declarado transparente. Eso es una garantía del
 * archivo, no una muestra de píxeles.
 */

const panel = join(import.meta.dirname, "..", "..", "panel");

interface Png {
  readonly ancho: number;
  readonly alto: number;
  readonly tipo: number;
  readonly tieneTrns: boolean;
}

/** Lee la cabecera de un PNG y busca si declara transparencia. */
function leerPng(ruta: string): Png {
  const d = readFileSync(ruta);
  const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!d.subarray(0, 8).equals(firma)) throw new Error(`${ruta} no es un PNG`);

  // El IHDR va siempre primero: ancho, alto, profundidad, tipo de color.
  const ancho = d.readUInt32BE(16);
  const alto = d.readUInt32BE(20);
  const tipo = d.readUInt8(25);

  let tieneTrns = false;
  let i = 8;
  while (i + 8 <= d.length) {
    const largo = d.readUInt32BE(i);
    const tag = d.subarray(i + 4, i + 8).toString("latin1");
    if (tag === "tRNS") tieneTrns = true;
    if (tag === "IEND") break;
    i += 12 + largo;
  }
  return { ancho, alto, tipo, tieneTrns };
}

/** Los tipos de color del PNG que llevan canal alfa. */
const CON_ALFA = new Set([4, 6]);

const TAMANOS = [64, 180, 256, 512] as const;

describe("los iconos del panel", () => {
  it("cada uno mide lo que dice su nombre", () => {
    for (const n of TAMANOS) {
      const png = leerPng(join(panel, "public", `icono-${n}.png`));
      expect(
        [png.ancho, png.alto],
        `icono-${n}.png mide ${png.ancho}×${png.alto}: el nombre promete ${n}×${n} ` +
          `y el teléfono lo escala a la fuerza`,
      ).toEqual([n, n]);
    }
  });

  it("ninguno tiene transparencia (iOS la pinta de negro)", () => {
    const culpables: string[] = [];
    for (const n of TAMANOS) {
      const png = leerPng(join(panel, "public", `icono-${n}.png`));
      if (CON_ALFA.has(png.tipo) || png.tieneTrns) {
        culpables.push(
          `icono-${n}.png (tipo de color ${png.tipo}${png.tieneTrns ? " + tRNS" : ""})`,
        );
      }
    }
    expect(
      culpables,
      `estos iconos pueden tener píxeles transparentes, y iOS los pinta de ` +
        `NEGRO en la pantalla de inicio: vuelva a exportarlos aplanados sobre ` +
        `el crema de la marca. ${culpables.join(", ")}`,
    ).toEqual([]);
  });

  it("el manifiesto no promete un icono que no está, ni un tamaño que no es", () => {
    const manifiesto = JSON.parse(
      readFileSync(join(panel, "public", "manifiesto.webmanifest"), "utf8"),
    ) as { icons: { src: string; sizes: string }[] };

    expect(manifiesto.icons.length, "el manifiesto no declara iconos").toBeGreaterThan(0);

    const problemas: string[] = [];
    for (const icono of manifiesto.icons) {
      const archivo = join(panel, "public", icono.src.replace(/^\//, ""));
      let png: Png;
      try {
        png = leerPng(archivo);
      } catch {
        problemas.push(`${icono.src} no existe`);
        continue;
      }
      if (icono.sizes !== `${png.ancho}x${png.alto}`) {
        problemas.push(`${icono.src} dice ${icono.sizes} y mide ${png.ancho}x${png.alto}`);
      }
    }
    expect(problemas, problemas.join("; ")).toEqual([]);
  });

  it("y el index.html tampoco", () => {
    const html = readFileSync(join(panel, "index.html"), "utf8");
    const problemas: string[] = [];
    for (const etiqueta of html.match(/<link[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/g) ?? []) {
      const href = /href="([^"]+)"/.exec(etiqueta)?.[1];
      const dice = /sizes="(\d+)x(\d+)"/.exec(etiqueta);
      if (!href) continue;
      let png: Png;
      try {
        png = leerPng(join(panel, "public", href.replace(/^\//, "")));
      } catch {
        problemas.push(`${href} no existe en panel/public/`);
        continue;
      }
      if (dice && (Number(dice[1]) !== png.ancho || Number(dice[2]) !== png.alto)) {
        problemas.push(`${href} dice ${dice[1]}x${dice[2]} y mide ${png.ancho}x${png.alto}`);
      }
    }
    expect(problemas.length === 0, problemas.join("; ")).toBe(true);
  });

  it("el color de la barra es el mismo en el manifiesto y en el html", () => {
    // Dos sitios con el mismo dato. Separados, el panel abre con una franja de
    // un color y se queda con la de otro, que es el tipo de cosa que se ve en
    // la mano y no en ninguna prueba.
    const manifiesto = JSON.parse(
      readFileSync(join(panel, "public", "manifiesto.webmanifest"), "utf8"),
    ) as { theme_color?: string };
    const html = readFileSync(join(panel, "index.html"), "utf8");
    const enElHtml = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1];

    expect(enElHtml, "el index.html ya no declara theme-color").toBeDefined();
    expect(
      manifiesto.theme_color?.toLowerCase(),
      `el manifiesto dice ${manifiesto.theme_color} y el html dice ${enElHtml}`,
    ).toBe(enElHtml?.toLowerCase());
  });
});
