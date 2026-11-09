import { describe, expect, it } from "vitest";
import {
  ESTADOS_PAGO,
  ESTADOS_PEDIDO,
  ETIQUETAS_PAGO,
  ETIQUETAS_PEDIDO,
  type EstadoPedido,
  cuentaComoVenta,
  esAnticipo,
  esEstadoPago,
  esEstadoPedido,
  esTerminalPedido,
  puedeCambiarPago,
  puedeCambiarPedido,
  validarTransicion,
} from "./estado-pedido";

describe("puedeCambiarPedido", () => {
  it("deja recorrer el camino normal de principio a fin", () => {
    const camino: EstadoPedido[] = ["por_abonar", "agendado", "en_ruta", "entregado"];
    for (let i = 0; i < camino.length - 1; i += 1) {
      expect(puedeCambiarPedido(camino[i]!, camino[i + 1]!)).toBe(true);
    }
  });

  it("no deja retroceder desde entregado salvo a devuelto", () => {
    for (const destino of ESTADOS_PEDIDO) {
      if (destino === "entregado" || destino === "devuelto") continue;
      expect(puedeCambiarPedido("entregado", destino), destino).toBe(false);
    }
    expect(puedeCambiarPedido("entregado", "devuelto")).toBe(true);
  });

  it("no deja saltarse pasos", () => {
    expect(puedeCambiarPedido("por_abonar", "en_ruta")).toBe(false);
    expect(puedeCambiarPedido("por_abonar", "entregado")).toBe(false);
    expect(puedeCambiarPedido("agendado", "entregado")).toBe(false);
  });

  it("una entrega fallida devuelve el pedido a agendado para reprogramar", () => {
    expect(puedeCambiarPedido("en_ruta", "agendado")).toBe(true);
  });

  it("no se cancela un pedido que ya salió a la calle", () => {
    // El paquete ya va en camino: eso termina en entregado o vuelve a agendado.
    expect(puedeCambiarPedido("en_ruta", "cancelado")).toBe(false);
    expect(puedeCambiarPedido("por_abonar", "cancelado")).toBe(true);
    expect(puedeCambiarPedido("agendado", "cancelado")).toBe(true);
  });

  it("no resucita lo cancelado ni lo devuelto", () => {
    for (const destino of ESTADOS_PEDIDO) {
      if (destino !== "cancelado") expect(puedeCambiarPedido("cancelado", destino)).toBe(false);
      if (destino !== "devuelto") expect(puedeCambiarPedido("devuelto", destino)).toBe(false);
    }
  });

  it("acepta quedarse donde está", () => {
    for (const estado of ESTADOS_PEDIDO) expect(puedeCambiarPedido(estado, estado)).toBe(true);
  });
});

describe("esTerminalPedido", () => {
  it("cancelado y devuelto son el final; entregado todavía admite devolución", () => {
    expect(esTerminalPedido("cancelado")).toBe(true);
    expect(esTerminalPedido("devuelto")).toBe(true);
    expect(esTerminalPedido("entregado")).toBe(false);
  });
});

describe("puedeCambiarPago", () => {
  it("recorre sin_pago → abonado → pagado", () => {
    expect(puedeCambiarPago("sin_pago", "abonado")).toBe(true);
    expect(puedeCambiarPago("abonado", "pagado")).toBe(true);
  });

  it("deja pagar de una vez sin pasar por abonado", () => {
    expect(puedeCambiarPago("sin_pago", "pagado")).toBe(true);
  });

  it("deja bajar de nivel, porque un pago se corrige con un movimiento contrario", () => {
    // Los libros no se editan: un pago mal registrado no se borra, se revierte,
    // y entonces el saldo baja y el estado se recalcula.
    expect(puedeCambiarPago("abonado", "sin_pago")).toBe(true);
    expect(puedeCambiarPago("pagado", "abonado")).toBe(true);
  });

  it("no vuelve de reembolsado: si entra dinero otra vez, es un pago nuevo", () => {
    for (const destino of ESTADOS_PAGO) {
      if (destino === "reembolsado") continue;
      expect(puedeCambiarPago("reembolsado", destino), destino).toBe(false);
    }
  });

  it("un reembolso parcial solo puede acabar en reembolso total", () => {
    expect(puedeCambiarPago("reembolso_parcial", "reembolsado")).toBe(true);
    expect(puedeCambiarPago("reembolso_parcial", "pagado")).toBe(false);
    expect(puedeCambiarPago("reembolso_parcial", "abonado")).toBe(false);
  });

  it("no se reembolsa lo que nunca se cobró", () => {
    expect(puedeCambiarPago("sin_pago", "reembolsado")).toBe(false);
    expect(puedeCambiarPago("sin_pago", "reembolso_parcial")).toBe(false);
  });
});

describe("cuándo hay una venta", () => {
  it("la venta se reconoce AL ENTREGAR, no al cobrar", () => {
    // Aquí Baby Caleb no hace lo que Nébula, que miraba el estado del pago.
    // docs/plan/05-contabilidad.md: un abono de un pedido que no salió es un
    // pasivo en «2101 Anticipos de clientas», no un ingreso.
    expect(cuentaComoVenta("entregado")).toBe(true);
    for (const estado of ["por_abonar", "agendado", "en_ruta", "cancelado", "devuelto"] as const) {
      expect(cuentaComoVenta(estado), estado).toBe(false);
    }
  });

  it("un pedido cobrado pero no entregado es un anticipo", () => {
    expect(esAnticipo("agendado", "abonado")).toBe(true);
    expect(esAnticipo("agendado", "pagado")).toBe(true);
    expect(esAnticipo("en_ruta", "pagado")).toBe(true);
  });

  it("sin dinero cobrado no hay anticipo", () => {
    expect(esAnticipo("por_abonar", "sin_pago")).toBe(false);
  });

  it("una vez entregado deja de ser anticipo: ya es venta", () => {
    expect(esAnticipo("entregado", "pagado")).toBe(false);
    expect(esAnticipo("devuelto", "pagado")).toBe(false);
  });
});

describe("validarTransicion", () => {
  it("no se queja de un cambio válido", () => {
    expect(
      validarTransicion({
        estadoActual: "por_abonar",
        estadoNuevo: "agendado",
        pagoActual: "sin_pago",
        pagoNuevo: "abonado",
      }),
    ).toEqual([]);
  });

  it("explica el cambio inválido con los nombres que se leen en pantalla", () => {
    const errores = validarTransicion({
      estadoActual: "entregado",
      estadoNuevo: "por_abonar",
      pagoActual: "pagado",
      pagoNuevo: "pagado",
    });
    expect(errores).toHaveLength(1);
    expect(errores[0]!.campo).toBe("estado");
    expect(errores[0]!.mensaje).toBe(
      "Un pedido «Entregado» no puede pasar a «Esperando su abono».",
    );
  });

  it("reporta los dos campos cuando los dos están mal", () => {
    const errores = validarTransicion({
      estadoActual: "cancelado",
      estadoNuevo: "entregado",
      pagoActual: "reembolsado",
      pagoNuevo: "pagado",
    });
    expect(errores.map((e) => e.campo)).toEqual(["estado", "estado_pago"]);
  });
});

describe("coherencia con el esquema", () => {
  it("son los estados de los CHECK de pedidos", () => {
    expect([...ESTADOS_PEDIDO]).toEqual([
      "por_abonar", "agendado", "en_ruta", "entregado", "cancelado", "devuelto",
    ]);
    expect([...ESTADOS_PAGO]).toEqual([
      "sin_pago", "abonado", "pagado", "reembolso_parcial", "reembolsado",
    ]);
  });

  it("todo estado tiene etiqueta", () => {
    expect(Object.keys(ETIQUETAS_PEDIDO).sort()).toEqual([...ESTADOS_PEDIDO].sort());
    expect(Object.keys(ETIQUETAS_PAGO).sort()).toEqual([...ESTADOS_PAGO].sort());
  });

  it("los reconocedores aceptan los válidos y rechazan el resto", () => {
    for (const e of ESTADOS_PEDIDO) expect(esEstadoPedido(e)).toBe(true);
    for (const e of ESTADOS_PAGO) expect(esEstadoPago(e)).toBe(true);
    expect(esEstadoPedido("por abonar")).toBe(false);
    expect(esEstadoPago("")).toBe(false);
  });

  it("las etiquetas hablan de usted, nunca de tú", () => {
    for (const texto of Object.values(ETIQUETAS_PEDIDO)) {
      expect(texto).not.toMatch(/\b(tu|tus|tuyo|tienes|puedes)\b/i);
    }
  });
});
