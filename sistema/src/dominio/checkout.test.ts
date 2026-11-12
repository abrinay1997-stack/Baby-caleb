import { describe, expect, it } from "vitest";
import {
  LA_WEB_TIENE_CHECKOUT,
  type PasarelaParaCobrar,
  estadoDelCheckout,
} from "./checkout";

/**
 * El veredicto del checkout.
 *
 * Lo que se vigila aquí no es el texto de los avisos: es que **`cobra` no
 * pueda salir `true` por accidente**. Falla hacia el lado que no mueve dinero,
 * y cada condición se prueba por separado quitándola — si una se pudiera
 * quitar sin que nada se ponga rojo, no estaría defendiendo nada.
 */

const pasarela = (sobre: Partial<PasarelaParaCobrar> = {}): PasarelaParaCobrar => ({
  pasarela: "yappy",
  titulo: "Yappy · Botón de Pago",
  encendida: true,
  completa: true,
  modo: "real",
  faltan: [],
  ...sobre,
});

/** El día que todo esté listo. Se usa para quitarle una cosa cada vez. */
const todoListo = {
  interruptor: true,
  pasarelas: [pasarela()],
  webTieneCheckout: true,
};

describe("cuándo cobra la web", () => {
  it("con el interruptor encendido, una pasarela real completa y el carrito hecho", () => {
    const r = estadoDelCheckout(todoListo);
    expect(r.cobra).toBe(true);
    expect(r.inerte).toBe(false);
    expect(r.impedimentos).toEqual([]);
    expect(r.resumen).toContain("La web cobra");
  });

  it("sin el interruptor, no cobra", () => {
    const r = estadoDelCheckout({ ...todoListo, interruptor: false });
    expect(r.cobra).toBe(false);
    // Apagado NO es inerte: inerte es «encendido y sin efecto».
    expect(r.inerte).toBe(false);
    expect(r.impedimentos.join(" ")).toContain("apagado");
  });

  it("sin ninguna pasarela encendida, no cobra", () => {
    const r = estadoDelCheckout({
      ...todoListo,
      pasarelas: [pasarela({ encendida: false })],
    });
    expect(r.cobra).toBe(false);
    expect(r.impedimentos.join(" ")).toContain("Ninguna pasarela está encendida");
  });

  it("sin el carrito de la web, no cobra aunque la pasarela esté lista", () => {
    const r = estadoDelCheckout({ ...todoListo, webTieneCheckout: false });
    expect(r.cobra).toBe(false);
    expect(r.inerte).toBe(true);
    expect(r.impedimentos.join(" ")).toContain("todavía no sabe mandar a pagar");
  });

  it("una pasarela EN PRUEBA no cuenta como lista", () => {
    // Es la distinción caro: un cobro con credenciales de prueba deja a la
    // clienta con un pedido agendado que nadie pagó.
    const r = estadoDelCheckout({ ...todoListo, pasarelas: [pasarela({ modo: "prueba" })] });
    expect(r.cobra).toBe(false);
    expect(r.listas).toEqual([]);
    expect(r.enPrueba).toEqual(["Yappy · Botón de Pago"]);
    expect(r.impedimentos.join(" ")).toContain("modo de prueba");
  });

  it("una pasarela encendida a medias dice QUÉ le falta, por su nombre", () => {
    const r = estadoDelCheckout({
      ...todoListo,
      pasarelas: [pasarela({ completa: false, faltan: ["Clave secreta"] })],
    });
    expect(r.cobra).toBe(false);
    expect(r.impedimentos.join(" ")).toContain("«Clave secreta»");
  });
});

describe("el estado que este módulo existe para destapar", () => {
  it("encendido y sin efecto se llama inerte, y lo dice", () => {
    const r = estadoDelCheckout({
      interruptor: true,
      pasarelas: [
        pasarela({ encendida: false, completa: false, faltan: ["ID de comercio", "Clave secreta"] }),
      ],
      webTieneCheckout: false,
    });
    expect(r.interruptor).toBe(true);
    expect(r.cobra).toBe(false);
    expect(r.inerte).toBe(true);
    expect(r.resumen).toContain("sin efecto");
  });

  it("y nombra las pasarelas a las que no se les ha puesto nada", () => {
    const r = estadoDelCheckout({
      interruptor: true,
      pasarelas: [
        pasarela({ pasarela: "yappy", titulo: "Yappy", encendida: false, completa: false }),
        pasarela({ pasarela: "tilopay", titulo: "Tilopay", encendida: false, completa: false }),
        pasarela({ pasarela: "paypal", titulo: "PayPal", encendida: false, completa: false }),
      ],
      webTieneCheckout: false,
    });
    const texto = r.impedimentos.join(" ");
    expect(texto).toContain("3 pasarelas");
    for (const t of ["Yappy", "Tilopay", "PayPal"]) expect(texto).toContain(t);
  });

  it("apagado dice lo que pasa hoy, no un guion vacío", () => {
    const r = estadoDelCheckout({ interruptor: false, pasarelas: [], webTieneCheckout: false });
    expect(r.resumen).toContain("WhatsApp");
  });
});

describe("el estado de HOY, con lo que hay en el repositorio", () => {
  it("el carrito de la web todavía no cobra, y la constante lo dice", () => {
    // Si esto se pone rojo es porque alguien programó el checkout de la web:
    // entonces se cambia la constante, y `test/node/checkout-de-la-web.test.ts`
    // comprueba que el cambio corresponde con el carrito de verdad.
    expect(LA_WEB_TIENE_CHECKOUT).toBe(false);
  });

  it("así que con tres pasarelas sin credenciales, el interruptor encendido es inerte", () => {
    // El caso exacto de producción el 2026-11-12: `checkout_activo = true`,
    // `pasarelas_activas = []`, cero credenciales.
    const r = estadoDelCheckout({
      interruptor: true,
      pasarelas: [
        pasarela({ pasarela: "yappy", titulo: "Yappy · Botón de Pago", encendida: false, completa: false, modo: "prueba", faltan: ["ID de comercio", "Clave secreta"] }),
        pasarela({ pasarela: "tilopay", titulo: "Tilopay · tarjetas y cuotas", encendida: false, completa: false, modo: "prueba", faltan: ["Usuario de API", "Contraseña de API", "Llave de integración"] }),
        pasarela({ pasarela: "paypal", titulo: "PayPal", encendida: false, completa: false, modo: "prueba", faltan: ["Client ID de la app REST", "Secret de la app REST", "ID del webhook"] }),
      ],
    });
    expect(r.cobra).toBe(false);
    expect(r.inerte).toBe(true);
  });
});
