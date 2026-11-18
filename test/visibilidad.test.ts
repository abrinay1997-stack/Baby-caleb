import { describe, expect, it } from "vitest";
import { quiereIndexarse, redireccionCanonica, seIndexa } from "../worker/visibilidad";

/**
 * Quién ve el sitio en Google, y por qué dirección.
 *
 * `babycaleb.com` se conectó ANTES de estar listo para buscadores. El sitio
 * nace oculto y se enciende a propósito, así que lo que estas pruebas vigilan
 * es que equivocarse salga siempre hacia el lado que se nota.
 */

const SITIO = "https://babycaleb.com";
const url = (u: string) => new URL(u);

describe("el interruptor nace apagado", () => {
  it("vacío, ausente o basura = oculto", () => {
    for (const v of [undefined, "", "   ", "no", "false", "0", "quizá", "SI_PERO_NO"]) {
      expect(quiereIndexarse(v), `"${v}" no debería encender nada`).toBe(false);
    }
  });

  it("solo un sí explícito lo enciende", () => {
    for (const v of ["si", "sí", "SI", " True ", "1", "on"]) {
      expect(quiereIndexarse(v), `"${v}" debería encenderlo`).toBe(true);
    }
  });
});

describe("una sola dirección sale en Google", () => {
  it("con el interruptor encendido, el dominio oficial se indexa", () => {
    expect(seIndexa(SITIO, "babycaleb.com", "si")).toBe(true);
  });

  it("la copia de workers.dev NO se indexa, ni con el interruptor encendido", () => {
    // Si se indexara, Google tendría dos sitios idénticos compitiendo y
    // repartiría entre ellos lo que debería ir a uno solo.
    expect(seIndexa(SITIO, "babycaleb-web.juanarrietabusiness.workers.dev", "si")).toBe(false);
  });

  it("sin dominio configurado no se indexa nada", () => {
    expect(seIndexa("", "babycaleb.com", "si")).toBe(false);
    expect(seIndexa("   ", "babycaleb.com", "si")).toBe(false);
  });

  it("apagado, ni el dominio oficial", () => {
    expect(seIndexa(SITIO, "babycaleb.com", "")).toBe(false);
  });

  it("no le importan las mayúsculas del Host", () => {
    expect(seIndexa(SITIO, "BabyCaleb.COM", "si")).toBe(true);
  });
});

describe("www manda a la raíz", () => {
  it("301 conservando la ruta y lo que lleve detrás", () => {
    expect(redireccionCanonica(SITIO, url("https://www.babycaleb.com/faq?a=1"))).toBe(
      "https://babycaleb.com/faq?a=1",
    );
  });

  it("la raíz no se redirige a sí misma", () => {
    expect(redireccionCanonica(SITIO, url("https://babycaleb.com/faq"))).toBeNull();
  });

  it("workers.dev NO se redirige: es contra lo que se compara antes del corte", () => {
    // Mandarla al dominio real la volvería inútil justo cuando hace falta.
    expect(
      redireccionCanonica(SITIO, url("https://babycaleb-web.juanarrietabusiness.workers.dev/faq")),
    ).toBeNull();
  });

  /**
   * El aviso de pago de Yappy NO se redirige, aunque entre por `www`.
   *
   * La dueña declaró el botón con `www.babycaleb.com`, así que esa dirección
   * tiene que CONTESTAR, no mandar a otra. Un 301 solo sirve si quien llama lo
   * sigue, y un servidor que avisa de un pago no tiene por qué hacerlo: si no
   * lo sigue, la clienta paga, el dinero entra en la cuenta de Yappy y el
   * pedido se queda sin confirmar sin que falle nada en ninguna pantalla.
   *
   * Es la SEGUNDA red, no la primera: la dirección que se le da a Yappy en
   * cada cobro (`ipnUrl`) es la del ápice, que ya contestaba. Esta exención
   * cubre el caso de que Yappy use el dominio declarado por su cuenta.
   */
  it("el aviso de pago de Yappy contesta en www, no se redirige", () => {
    expect(
      redireccionCanonica(SITIO, url("https://www.babycaleb.com/api/pago/yappy?orderId=BC1&status=E")),
    ).toBeNull();
    // Con la barra final es la misma ruta, y tiene que portarse igual.
    expect(
      redireccionCanonica(SITIO, url("https://www.babycaleb.com/api/pago/yappy/")),
    ).toBeNull();
  });

  it("pero la exención es de ESA ruta, no de /api/ entero", () => {
    // Las demás las llama nuestra propia página, que ya está en el dominio
    // bueno. Eximir `/api/` entero diría algo que no hace falta decir.
    for (const otra of ["/api/catalogo", "/api/zonas", "/api/pago/yappy/iniciar", "/api/salud"]) {
      expect(
        redireccionCanonica(SITIO, url(`https://www.babycaleb.com${otra}`)),
        otra,
      ).toBe(`https://babycaleb.com${otra}`);
    }
  });

  it("sin dominio configurado no redirige a ningún lado", () => {
    expect(redireccionCanonica("", url("https://www.babycaleb.com/faq"))).toBeNull();
  });

  it("un dominio mal escrito no tumba la petición", () => {
    // Antes que redirigir a un sitio inventado, no redirigir.
    expect(redireccionCanonica("no-es-una-url", url("https://www.babycaleb.com/"))).toBeNull();
  });
});
