import { describe, expect, it } from "vitest";
import {
  ETIQUETAS_POLITICA,
  POLITICAS,
  REGLA_POR_DEFECTO,
  type Regla,
  decidirDespacho,
  esPolitica,
  estadoDePagoSegunSaldo,
  puedeAgendar,
  saldoPorCobrar,
} from "./abonos";

const ESTRICTA: Regla = { politica: "estricta", umbral_bp: 5000 };
const MITAD: Regla = { politica: "umbral", umbral_bp: 5000 };
const CONTRA_ENTREGA: Regla = { politica: "contra_entrega", umbral_bp: 0 };

describe("la regla por defecto", () => {
  // Es la única de las tres que no puede acabar en pérdida. Las otras dos son
  // decisiones que alguien tiene que tomar a sabiendas.
  it("es la estricta, para que nadie despache con saldo sin quererlo", () => {
    expect(REGLA_POR_DEFECTO.politica).toBe("estricta");
  });
});

describe("decidirDespacho · política estricta", () => {
  it("no deja salir un pedido con saldo", () => {
    const d = decidirDespacho({ total_cents: 30_000, pagado_cents: 20_000, regla: ESTRICTA });
    expect(d.puede).toBe(false);
    expect(d.falta_cents).toBe(10_000);
  });

  it("deja salir cuando el saldo llega a cero", () => {
    expect(
      decidirDespacho({ total_cents: 30_000, pagado_cents: 30_000, regla: ESTRICTA }).puede,
    ).toBe(true);
  });

  it("deja salir si pagaron de más", () => {
    const d = decidirDespacho({ total_cents: 30_000, pagado_cents: 32_000, regla: ESTRICTA });
    expect(d.puede).toBe(true);
    expect(d.falta_cents).toBe(0);
  });
});

describe("decidirDespacho · política de umbral", () => {
  it("deja salir justo al alcanzar el porcentaje", () => {
    expect(decidirDespacho({ total_cents: 30_000, pagado_cents: 15_000, regla: MITAD }).puede).toBe(
      true,
    );
  });

  it("no deja salir un centavo por debajo", () => {
    const d = decidirDespacho({ total_cents: 30_000, pagado_cents: 14_999, regla: MITAD });
    expect(d.puede).toBe(false);
    expect(d.falta_cents).toBe(1);
  });

  it("cuando deja salir, informa del saldo REAL que queda", () => {
    // No lo que faltaba para el umbral: quien despacha necesita saber cuánto se
    // le debe todavía.
    const d = decidirDespacho({ total_cents: 30_000, pagado_cents: 15_000, regla: MITAD });
    expect(d.falta_cents).toBe(15_000);
  });

  it("un umbral fuera de rango se acota en vez de romper la cuenta", () => {
    const absurdo: Regla = { politica: "umbral", umbral_bp: 50_000 };
    expect(decidirDespacho({ total_cents: 10_000, pagado_cents: 9_900, regla: absurdo }).puede).toBe(
      false,
    );

    const negativo: Regla = { politica: "umbral", umbral_bp: -2000 };
    expect(decidirDespacho({ total_cents: 10_000, pagado_cents: 1, regla: negativo }).puede).toBe(
      true,
    );
  });
});

describe("decidirDespacho · contra entrega", () => {
  it("deja salir con saldo y dice cuánto hay que cobrar en la puerta", () => {
    const d = decidirDespacho({
      total_cents: 30_000,
      pagado_cents: 10_000,
      regla: CONTRA_ENTREGA,
    });
    expect(d.puede).toBe(true);
    expect(d.falta_cents).toBe(20_000);
    expect(d.motivo).toContain("$200.00");
  });
});

describe("aritmética del dinero", () => {
  it("en centavos enteros no hay nada que redondear", () => {
    // En Nébula este caso obligaba a redondear: 1.10 + 2.20 da
    // 3.3000000000000003 en coma flotante, y el pedido se quedaba sin salir por
    // una diezmilbillonésima que no existe en ninguna caja. En centavos la suma
    // es exacta por construcción.
    expect(110 + 220).toBe(330);
    expect(decidirDespacho({ total_cents: 330, pagado_cents: 110 + 220, regla: ESTRICTA }).puede).toBe(
      true,
    );
  });

  it("tres abonos que suman el total dejan salir el pedido", () => {
    expect(3334 + 3333 + 3333).toBe(10_000);
    expect(
      decidirDespacho({ total_cents: 10_000, pagado_cents: 10_000, regla: ESTRICTA }).puede,
    ).toBe(true);
  });

  it("un pedido sin importe no bloquea a nadie", () => {
    expect(decidirDespacho({ total_cents: 0, pagado_cents: 0, regla: ESTRICTA }).puede).toBe(true);
  });

  it("un pagado negativo se trata como cero, no como crédito", () => {
    const d = decidirDespacho({ total_cents: 10_000, pagado_cents: -5_000, regla: ESTRICTA });
    expect(d.puede).toBe(false);
    expect(d.falta_cents).toBe(10_000);
  });

  it("un monto imposible BLOQUEA en vez de dejar pasar", () => {
    // Aquí Baby Caleb no hace lo que Nébula: allí un total NaN acababa en
    // `puede: true`. Con mercancía de por medio, el error seguro es el otro.
    for (const malo of [
      { total_cents: Number.NaN, pagado_cents: 0 },
      { total_cents: 100, pagado_cents: Number.POSITIVE_INFINITY },
      { total_cents: 10.5, pagado_cents: 0 },
    ]) {
      const d = decidirDespacho({ ...malo, regla: ESTRICTA });
      expect(d.puede, JSON.stringify(malo)).toBe(false);
      expect(d.motivo).toContain("no son válidos");
    }
  });
});

describe("puedeAgendar · la regla propia de Baby Caleb", () => {
  const base = { total_cents: 10_000, abono_minimo_cents: 500, requiere_pago_total: false };

  it("agenda con el abono mínimo de $5 y deja el saldo pendiente", () => {
    const d = puedeAgendar({ ...base, pagado_cents: 500 });
    expect(d.puede).toBe(true);
    expect(d.falta_cents).toBe(9_500);
  });

  it("no agenda por debajo del abono mínimo", () => {
    const d = puedeAgendar({ ...base, pagado_cents: 499 });
    expect(d.puede).toBe(false);
    expect(d.falta_cents).toBe(1);
    expect(d.motivo).toContain("$5.00");
  });

  it("sin nada pagado no se agenda", () => {
    expect(puedeAgendar({ ...base, pagado_cents: 0 }).puede).toBe(false);
  });

  it("con requiere_pago_total exige el total completo", () => {
    // Ferguson, tarjeta y PayPal no admiten abono.
    const conTotal = { ...base, requiere_pago_total: true };
    expect(puedeAgendar({ ...conTotal, pagado_cents: 500 }).puede).toBe(false);
    expect(puedeAgendar({ ...conTotal, pagado_cents: 9_999 }).puede).toBe(false);
    expect(puedeAgendar({ ...conTotal, pagado_cents: 10_000 }).puede).toBe(true);
  });

  it("un pedido más barato que el abono mínimo se agenda pagándolo entero", () => {
    // Un pedido de $3 con abono mínimo de $5 no puede volverse imposible.
    const d = puedeAgendar({ total_cents: 300, pagado_cents: 300, abono_minimo_cents: 500, requiere_pago_total: false });
    expect(d.puede).toBe(true);
    expect(d.falta_cents).toBe(0);
  });

  it("también bloquea con montos imposibles", () => {
    expect(puedeAgendar({ ...base, pagado_cents: Number.NaN }).puede).toBe(false);
  });
});

describe("estadoDePagoSegunSaldo", () => {
  it("recorre los tres estados según entra el dinero", () => {
    expect(estadoDePagoSegunSaldo(30_000, 0)).toBe("sin_pago");
    expect(estadoDePagoSegunSaldo(30_000, 10_000)).toBe("abonado");
    expect(estadoDePagoSegunSaldo(30_000, 30_000)).toBe("pagado");
  });

  it("pagar de más sigue siendo pagado", () => {
    expect(estadoDePagoSegunSaldo(30_000, 40_000)).toBe("pagado");
  });

  it("un pedido de $300 en tres abonos de $100 termina pagado", () => {
    expect(estadoDePagoSegunSaldo(30_000, 10_000)).toBe("abonado");
    expect(estadoDePagoSegunSaldo(30_000, 20_000)).toBe("abonado");
    expect(estadoDePagoSegunSaldo(30_000, 30_000)).toBe("pagado");
  });

  it("un pagado negativo es sin_pago, no crédito", () => {
    expect(estadoDePagoSegunSaldo(30_000, -100)).toBe("sin_pago");
  });
});

describe("saldoPorCobrar", () => {
  it("es lo que el motorizado cobra al entregar", () => {
    expect(saldoPorCobrar(30_000, 10_000)).toBe(20_000);
    expect(saldoPorCobrar(30_000, 30_000)).toBe(0);
    expect(saldoPorCobrar(30_000, 40_000)).toBe(0);
    expect(saldoPorCobrar(30_000, -5)).toBe(30_000);
  });
});

describe("coherencia", () => {
  it("toda política tiene etiqueta", () => {
    expect(Object.keys(ETIQUETAS_POLITICA).sort()).toEqual([...POLITICAS].sort());
  });

  it("esPolitica reconoce las tres y rechaza el resto", () => {
    for (const p of POLITICAS) expect(esPolitica(p)).toBe(true);
    expect(esPolitica("contra entrega")).toBe(false);
    expect(esPolitica("")).toBe(false);
  });

  it("ninguna política retiene un pedido pagado del todo", () => {
    // Sería dinero cobrado y mercancía retenida.
    for (const politica of POLITICAS) {
      const d = decidirDespacho({
        total_cents: 30_000,
        pagado_cents: 30_000,
        regla: { politica, umbral_bp: 10_000 },
      });
      expect(d.puede, `la política ${politica} retuvo un pedido pagado`).toBe(true);
    }
  });
});
