import { describe, expect, it } from "vitest";
import { diaEnPalabras, nombreDeVentana } from "./Entregas";
import { sinPuntoFinal } from "../componentes";

/**
 * La hoja de una parada enseñaba el CÓDIGO de la ventana de entrega:
 * «BC-1044 · Ciudad de Panamá — centro · manana», sin ñ, porque nunca fue una
 * palabra sino el identificador que queda escrito en el envío.
 *
 * El nombre vive en el ajuste `ventanas_entrega` y es de la dueña: lo puede
 * cambiar cuando quiera. Por eso se traduce leyendo ESE ajuste y no con una
 * tabla escrita en la pantalla, que sería un segundo dueño del mismo dato.
 *
 * Validada por mutación: devolver el código tal cual pone roja la primera;
 * inventar un nombre cuando no está en la lista pone roja la tercera.
 */
describe("el nombre de una ventana de entrega", () => {
  const ventanas = [
    { id: "manana", etiqueta: "Mañana" },
    { id: "tarde", etiqueta: "Tarde" },
  ];

  it("es el que puso la dueña, no el código", () => {
    expect(nombreDeVentana("manana", ventanas)).toBe("Mañana");
    expect(nombreDeVentana("tarde", ventanas)).toBe("Tarde");
  });

  it("sin ventana, no dice nada", () => {
    expect(nombreDeVentana(null, ventanas)).toBeNull();
  });

  it("un código que ya no está en la lista se enseña tal cual", () => {
    // Pasa de verdad: la ventana se borró del ajuste y los envíos viejos
    // siguen apuntando a ella. Enseñar el código dice la verdad; inventarle
    // un nombre diría que la ventana sigue existiendo.
    expect(nombreDeVentana("madrugada", ventanas)).toBe("madrugada");
    expect(nombreDeVentana("manana", [])).toBe("manana");
  });
});

/**
 * Las frases que terminan en una fecha.
 *
 * `fecha()` escribe la hora a la panameña —«1:24 p. m.»— y esa abreviatura
 * lleva punto, así que la plantilla que añade el suyo saca dos seguidos.
 *
 * Validada por mutación: devolver el texto sin tocar pone roja la primera.
 */
describe("el punto final de una fecha", () => {
  it("se quita para que la frase no acabe con dos", () => {
    expect(sinPuntoFinal("12 nov 2026, 1:24 p. m.")).toBe("12 nov 2026, 1:24 p. m");
    expect(`Entregada ${sinPuntoFinal("12 nov 2026, 10:05 a. m.")}.`).toBe(
      "Entregada 12 nov 2026, 10:05 a. m.",
    );
  });

  it("y no se inventa uno donde no lo había", () => {
    expect(sinPuntoFinal("12 nov 2026")).toBe("12 nov 2026");
  });
});

/**
 * El día que se está mirando, en palabras.
 *
 * El campo de al lado es un `<input type="date">`, que lo dibuja el navegador
 * en el idioma del TELÉFONO: puede salir «11/13/2026». Este repositorio ya
 * pagó esa factura una vez —el panel decía «11/10/2026» para el 10 de
 * noviembre, que una panameña lee como el 11 de octubre— y la regla que quedó
 * es que el mes va con nombre. Dentro de un control del sistema no se puede
 * imponer, así que se dice al lado; esto comprueba que lo que se dice al lado
 * cumple la regla.
 */
describe("el día de las entregas, en palabras", () => {
  it("lleva el mes con NOMBRE, nunca en número", () => {
    const texto = diaEnPalabras("2026-11-13");
    expect(texto).toContain("nov");
    expect(texto).toContain("13");
    expect(texto).toContain("2026");
    // Lo que no puede pasar: que se lea como 11/13 o 13/11.
    expect(texto).not.toMatch(/\d{1,2}\/\d{1,2}/);
  });

  it("no se corre un día por la zona horaria", () => {
    // La trampa: 'YYYY-MM-DD' es medianoche UTC, y pasarlo a la hora de Panamá
    // le resta cinco horas y lo enseña como el día anterior.
    expect(diaEnPalabras("2026-01-01")).toContain("1");
    expect(diaEnPalabras("2026-01-01")).toContain("ene");
    expect(diaEnPalabras("2026-01-01")).toContain("2026");
    expect(diaEnPalabras("2026-03-01")).toContain("mar");
    expect(diaEnPalabras("2026-12-31")).toContain("31");
    expect(diaEnPalabras("2026-12-31")).toContain("dic");
  });

  it("y un campo a medio escribir no saca «Invalid Date»", () => {
    for (const malo of ["", "2026-11", "ayer", "13/11/2026", "2026-13-45"]) {
      expect(diaEnPalabras(malo), `«${malo}»`).toBe("");
    }
  });
});
