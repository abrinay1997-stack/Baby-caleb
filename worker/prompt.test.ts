import { describe, expect, it } from "vitest";
import { promptDelSistema } from "./prompt";

/**
 * El prompt del chat de la web (F3.5).
 *
 * Este texto llevaba los precios escritos dentro. Dos consecuencias, y ninguna
 * se veía desde fuera:
 *
 *  1. Cambiar un precio en el sistema no cambiaba lo que el chat cotizaba.
 *  2. El texto ofrecía Wipes Nateen, que el documento de la dueña tiene FUERA
 *     DE CIRCULACIÓN desde 2026-09. El chat se las ofrecía a quien preguntara.
 *
 * Lo que estas pruebas vigilan es que un producto que no está en el catálogo
 * NO APAREZCA — ni con precio ni sin él. Una clienta que lee «Wipes Nateen»
 * pregunta por Wipes Nateen, y alguien tiene que decirle que no hay.
 */

const PRECIOS = new Map<string, number>([
  ["NAT-RN", 5000],
  ["NAT-S", 5000],
  ["NAT-M", 5000],
  ["NAT-L", 4500],
  ["NAT-XL", 4500],
  ["NAT-XXL", 4500],
  ["NAT-P-L", 5500],
  ["DANY-AW600", 2500],
  ["MOON-FUL", 4600],
  // NAT-WIP NO está: es el descatalogado.
]);

describe("con catálogo", () => {
  const prompt = promptDelSistema(PRECIOS);

  it("no queda ningún marcador sin rellenar", () => {
    expect(prompt).not.toContain("{{precio:");
  });

  it("los precios son los del catálogo", () => {
    expect(prompt).toContain("144u · $50");
    expect(prompt).toContain("128u · $45");
    expect(prompt).toContain("caja de 160u a $55");
    expect(prompt).toContain("600 toallitas por $25");
    expect(prompt).toContain("~25 lbs. $46");
  });

  it("lo que NO está en el catálogo desaparece del prompt", () => {
    // La línea entera, no solo su precio.
    expect(prompt).not.toMatch(/Wipes Nateen/i);
  });

  it("y lo que sí está sigue ahí", () => {
    expect(prompt).toMatch(/Dany Baby/i);
    expect(prompt).toMatch(/Fulares\/portabebés Moon/i);
    expect(prompt).toMatch(/NATEEN PANTS/);
  });

  it("un precio con centavos se escribe con centavos", () => {
    const p = promptDelSistema(new Map([["MOON-FUL", 4650]]));
    expect(p).toContain("$46.50");
  });

  it("el resto del texto no se toca", () => {
    // El tono, las reglas de escalada y la lista de exclusión son lo que
    // impide que el chat hable de costos o de proveedores. Si una refactor del
    // armado de precios se llevara esas líneas por delante, nadie lo notaría
    // hasta leer una conversación.
    expect(prompt).toContain("NUNCA reveles");
    expect(prompt).toContain("costos de compra");
    expect(prompt).toContain("ESCALA A WHATSAPP");
    expect(prompt).toMatch(/cálido, maternal/);
  });
});

describe("sin catálogo (el sistema no contesta)", () => {
  const prompt = promptDelSistema(new Map());

  it("no se inventa ni un precio", () => {
    expect(prompt).not.toMatch(/\$\s?\d/);
    expect(prompt).not.toContain("{{precio:");
  });

  it("y se le dice al modelo qué hacer en su lugar", () => {
    expect(prompt).toContain("NO des ningún precio");
    expect(prompt).toContain("lo confirmas con el equipo");
  });

  it("las reglas que protegen el negocio siguen puestas", () => {
    // Quedarse sin catálogo no puede ser la vía por la que el chat empiece a
    // hablar de costos.
    expect(prompt).toContain("NUNCA reveles");
    expect(prompt).toContain("ESCALA A WHATSAPP");
  });
});
