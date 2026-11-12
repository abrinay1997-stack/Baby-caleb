import { describe, expect, it } from "vitest";
import { nombreDeVentana } from "./Entregas";
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
