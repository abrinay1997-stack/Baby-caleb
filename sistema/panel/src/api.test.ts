import { describe, expect, it } from "vitest";
import { dinero } from "./api";
import { aCentavos, deCentavos } from "./dinero";

/**
 * Cómo se escribe el dinero que se LEE.
 *
 * Sin separador de miles salía `$5555555.55`, y eso rompía dos cosas a la vez:
 *
 *  1. No se lee. Contar siete cifras seguidas para saber si son cincuenta mil
 *     o quinientos mil es justo lo que no se hace de pie y con prisa.
 *  2. Rompía la pantalla. Un número sin dónde partirse, a 32 px en negrita
 *     —el tamaño de `Cifra`—, medía 199 px dentro de una celda de 143, y el
 *     Resumen entero se desplazaba 26 px de lado en el teléfono (§7g).
 *
 * El auditor no lo veía: los datos de muestra son de dos cifras. Se encontró
 * inyectando un total grande, que es lo que va a tener el cierre de un año.
 */
describe("el dinero que se lee", () => {
  it("lo de todos los días", () => {
    expect(dinero(0)).toBe("$0.00");
    expect(dinero(5)).toBe("$0.05");
    expect(dinero(1250)).toBe("$12.50");
    expect(dinero(4650)).toBe("$46.50");
    expect(dinero(99999)).toBe("$999.99");
  });

  it("a partir de mil, con coma", () => {
    expect(dinero(100000)).toBe("$1,000.00");
    expect(dinero(123450)).toBe("$1,234.50");
    expect(dinero(99999999)).toBe("$999,999.99");
    // El que desbordaba el Resumen.
    expect(dinero(555555555)).toBe("$5,555,555.55");
    expect(dinero(123456789012)).toBe("$1,234,567,890.12");
  });

  it("el signo va delante del símbolo, no de la coma", () => {
    expect(dinero(-1250)).toBe("-$12.50");
    expect(dinero(-555555555)).toBe("-$5,555,555.55");
  });

  it("la coma se pone cada tres cifras, no cada tres caracteres", () => {
    // La trampa de la expresión regular: agrupar sobre el texto YA formateado
    // mete comas dentro de los centavos («$1,234.5,0»). Aquí se agrupa solo
    // la parte entera, y por eso se comprueba el final por separado.
    for (const c of [100000, 1000000, 10000000, 100000000]) {
      expect(dinero(c).endsWith(".00"), `${c}`).toBe(true);
      expect(dinero(c).split(".")[1]).toBe("00");
    }
  });

  it("no pierde ni gana un centavo al redondear", () => {
    // `dinero` NO divide por 100 en coma flotante: parte el entero con
    // `Math.trunc` y los centavos con `% 100`. Si alguien lo reescribe con
    // `toLocaleString(centavos / 100)`, estos se van.
    expect(dinero(114999999)).toBe("$1,149,999.99");
    expect(dinero(1)).toBe("$0.01");
    expect(dinero(10)).toBe("$0.10");
    expect(dinero(110)).toBe("$1.10");
  });
});

/**
 * Lo que se LEE y lo que se EDITA son dos cosas, y tienen que seguir siéndolo.
 *
 * `deCentavos` alimenta el campo que se escribe, y ahí un separador de miles
 * rompería `aCentavos` —que acepta un punto decimal y nada más—. O sea: el
 * día que alguien «unifique» las dos funciones para que el campo también
 * enseñe comas, el precio de un producto de más de mil dólares deja de poder
 * guardarse. Esta prueba es la que lo dice en voz alta.
 */
describe("el dinero que se edita no lleva coma", () => {
  it("el campo recibe el número pelado", () => {
    expect(deCentavos(555555555)).toBe("5555555.55");
    expect(deCentavos(123450)).toBe("1234.50");
  });

  it("y lo que el campo devuelve sigue cuadrando", () => {
    for (const c of [1, 99, 1250, 123450, 555555555]) {
      expect(aCentavos(deCentavos(c)), `${c}`).toBe(c);
    }
  });

  it("un monto con coma de miles NO es un monto válido para el campo", () => {
    expect(aCentavos("1,234.50")).toBeNull();
  });
});
