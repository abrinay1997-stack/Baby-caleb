import { describe, expect, it } from "vitest";
import { textoDePublicado } from "./EditarVariante";

/**
 * La ayuda de «Mostrarlo en la web» no puede contradecir a su casilla.
 *
 * El texto era fijo —«Apagado, nadie lo ve y el bot no lo ofrece»— así que con
 * la casilla MARCADA la pantalla decía que el producto estaba apagado,
 * mientras la lista de al lado le ponía la pastilla verde «En la web». Dos
 * pantallas del mismo panel diciendo lo contrario sobre si un producto se está
 * vendiendo.
 *
 * Lo peligroso no es la confusión: es la salida natural. Quien lee «apagado»
 * al lado de una casilla marcada quita la marca para que concuerden — y eso
 * es exactamente lo que apaga el producto de verdad y lo saca de la tienda.
 */
describe("la ayuda de «Mostrarlo en la web»", () => {
  it("con la casilla marcada dice que SÍ sale", () => {
    const t = textoDePublicado(true);
    expect(t).toMatch(/^Encendido/);
    expect(t).toContain("sale en la tienda");
  });

  it("con la casilla sin marcar dice que NO lo ve nadie", () => {
    const t = textoDePublicado(false);
    expect(t).toMatch(/^Apagado/);
    expect(t).toContain("no lo ve nadie");
  });

  it("y los dos textos son distintos, que es todo el punto", () => {
    // Una comprobación aparte y no una redundancia: es la que se pone roja si
    // alguien vuelve a dejar el texto fijo, sea cual sea el texto que elija.
    expect(textoDePublicado(true)).not.toBe(textoDePublicado(false));
  });

  it("cada uno describe SU estado, no el otro", () => {
    // Una ayuda que describe el estado contrario —«si lo apaga, nadie lo
    // verá»— obliga a leerla dos veces para saber en cuál se está. El texto
    // de encendido no puede empezar hablando de apagado ni al revés.
    expect(textoDePublicado(true)).not.toMatch(/^Apagado/);
    expect(textoDePublicado(false)).not.toMatch(/^Encendido/);
  });
});
