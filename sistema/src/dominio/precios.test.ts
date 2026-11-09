import { describe, expect, it } from "vitest";
import { sumar } from "./dinero";
import {
  type EntradaTotales,
  type Totales,
  calcularTotales,
  descuentoPorPorcentaje,
  totalDeLinea,
} from "./precios";

/** Exige que el cálculo salga bien y devuelve los totales. */
function totales(entrada: EntradaTotales): Totales {
  const r = calcularTotales(entrada);
  if (!r.ok) throw new Error(`esperaba totales y vino un fallo: ${r.mensaje}`);
  return r;
}

// Dos pañales de $29.98 y un portabebé de $23.80, sin ITBMS confirmado todavía
// a 0 puntos básicos (declarado, no asumido).
const lineas = [
  { codigo: "NAT-M", precio_unit_cents: 2998, cantidad: 2, itbms_bp: 0 },
  { codigo: "MOON-FUL", precio_unit_cents: 2380, cantidad: 1, itbms_bp: 0 },
];

describe("subtotal", () => {
  it("sale de los precios del catálogo", () => {
    expect(totalDeLinea(lineas[0]!)).toBe(5996);
    expect(totales({ lineas }).subtotal_cents).toBe(8376);
  });

  it("un carrito vacío da cero, no NaN", () => {
    expect(totales({ lineas: [] })).toMatchObject({
      subtotal_cents: 0,
      descuento_cents: 0,
      envio_cents: 0,
      itbms_cents: 0,
      total_cents: 0,
      lineas: [],
    });
  });
});

describe("descuento", () => {
  it("se aplica sobre el subtotal", () => {
    const t = totales({ lineas, descuento: { tipo: "porcentaje", monto_cents: 838 } });
    expect(t.descuento_cents).toBe(838);
    expect(t.total_cents).toBe(7538);
  });

  it("nunca supera el subtotal ni genera saldo a favor", () => {
    const t = totales({
      lineas: [{ codigo: "A", precio_unit_cents: 1000, cantidad: 1, itbms_bp: 0 }],
      descuento: { tipo: "monto_fijo", monto_cents: 99_900 },
    });
    expect(t.descuento_cents).toBe(1000);
    expect(t.total_cents).toBe(0);
  });

  it("un descuento negativo se ignora en vez de sumarse al total", () => {
    const t = totales({
      lineas: [{ codigo: "A", precio_unit_cents: 1000, cantidad: 1, itbms_bp: 0 }],
      descuento: { tipo: "monto_fijo", monto_cents: -5000 },
    });
    expect(t.descuento_cents).toBe(0);
    expect(t.total_cents).toBe(1000);
  });

  it("el total nunca es negativo", () => {
    const t = totales({
      lineas: [{ codigo: "A", precio_unit_cents: 500, cantidad: 1, itbms_bp: 0 }],
      descuento: { tipo: "monto_fijo", monto_cents: 10_000 },
      envio: { tarifa_cents: 0, gratis_desde_cents: null },
    });
    expect(t.total_cents).toBeGreaterThanOrEqual(0);
  });

  it("convierte un porcentaje a centavos", () => {
    expect(descuentoPorPorcentaje(10_000, 1000)).toEqual({
      tipo: "porcentaje",
      monto_cents: 1000,
    });
  });
});

describe("envío", () => {
  const unaLinea = (cents: number) => [
    { codigo: "A", precio_unit_cents: cents, cantidad: 1, itbms_bp: 0 },
  ];

  it("se cobra cuando no se alcanza el umbral", () => {
    const t = totales({
      lineas: unaLinea(2000),
      envio: { tarifa_cents: 500, gratis_desde_cents: 5000 },
    });
    expect(t.envio_cents).toBe(500);
    expect(t.total_cents).toBe(2500);
  });

  it("no se cobra al superar el umbral", () => {
    const t = totales({
      lineas: unaLinea(6000),
      envio: { tarifa_cents: 500, gratis_desde_cents: 5000 },
    });
    expect(t.envio_cents).toBe(0);
    expect(t.total_cents).toBe(6000);
  });

  it("el umbral se mide DESPUÉS del descuento", () => {
    // 60 - 15 = 45, por debajo del umbral de 50: el envío se cobra. Si se
    // midiera antes del descuento, regalaríamos un envío no ganado.
    const t = totales({
      lineas: unaLinea(6000),
      descuento: { tipo: "monto_fijo", monto_cents: 1500 },
      envio: { tarifa_cents: 500, gratis_desde_cents: 5000 },
    });
    expect(t.envio_cents).toBe(500);
    expect(t.total_cents).toBe(5000);
  });

  it("un cupón de envío gratis lo regala aunque no se alcance el umbral", () => {
    const t = totales({
      lineas: unaLinea(2000),
      descuento: { tipo: "envio_gratis", monto_cents: 0 },
      envio: { tarifa_cents: 500, gratis_desde_cents: 5000 },
    });
    expect(t.envio_cents).toBe(0);
    expect(t.total_cents).toBe(2000);
  });

  it("sin umbral el envío nunca es gratis", () => {
    const t = totales({
      lineas: unaLinea(100_000),
      envio: { tarifa_cents: 500, gratis_desde_cents: null },
    });
    expect(t.envio_cents).toBe(500);
  });
});

describe("ITBMS", () => {
  it("se calcula sobre el subtotal ya descontado", () => {
    const t = totales({
      lineas: [{ codigo: "A", precio_unit_cents: 10_000, cantidad: 1, itbms_bp: 700 }],
      descuento: { tipo: "porcentaje", monto_cents: 1000 },
    });
    expect(t.itbms_cents).toBe(630);
    expect(t.total_cents).toBe(9630);
  });

  it("usa la tasa de CADA línea, no una del pedido", () => {
    // Un pañal y un portabebé no tributan igual.
    const t = totales({
      lineas: [
        { codigo: "EXENTO", precio_unit_cents: 10_000, cantidad: 1, itbms_bp: 0 },
        { codigo: "GRAVADO", precio_unit_cents: 10_000, cantidad: 1, itbms_bp: 700 },
      ],
    });
    expect(t.lineas[0]!.itbms_cents).toBe(0);
    expect(t.lineas[1]!.itbms_cents).toBe(700);
    expect(t.itbms_cents).toBe(700);
  });

  it("reparte el descuento entre líneas por valor y cuadra al centavo", () => {
    const t = totales({
      lineas: [
        { codigo: "CARA", precio_unit_cents: 7500, cantidad: 1, itbms_bp: 700 },
        { codigo: "BARATA", precio_unit_cents: 2500, cantidad: 1, itbms_bp: 700 },
      ],
      descuento: { tipo: "monto_fijo", monto_cents: 1000 },
    });
    expect(t.lineas.map((l) => l.descuento_cents)).toEqual([750, 250]);
    expect(sumar(t.lineas.map((l) => l.descuento_cents))).toBe(t.descuento_cents);
    // 6750 y 2250 al 7 %
    expect(t.lineas.map((l) => l.itbms_cents)).toEqual([473, 158]);
  });

  it("un descuento que no divide bien no pierde ni inventa un centavo", () => {
    const t = totales({
      lineas: [
        { codigo: "A", precio_unit_cents: 333, cantidad: 1, itbms_bp: 700 },
        { codigo: "B", precio_unit_cents: 333, cantidad: 1, itbms_bp: 700 },
        { codigo: "C", precio_unit_cents: 334, cantidad: 1, itbms_bp: 700 },
      ],
      descuento: { tipo: "monto_fijo", monto_cents: 100 },
    });
    expect(sumar(t.lineas.map((l) => l.descuento_cents))).toBe(100);
  });
});

describe("ninguna cifra a ojo", () => {
  it("falla si una línea no tiene tasa de ITBMS confirmada", () => {
    // tasa_itbms_bp = NULL significa PENDIENTE de la contadora. Tratarlo como
    // cero sería declarar impuestos con un número inventado.
    const r = calcularTotales({
      lineas: [{ codigo: "NAT-M", precio_unit_cents: 5000, cantidad: 1, itbms_bp: null }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("entrada_invalida");
      expect(r.mensaje).toContain("NAT-M");
      expect(r.mensaje).toContain("ITBMS");
    }
  });

  it("rechaza cantidades y precios imposibles", () => {
    for (const linea of [
      { codigo: "A", precio_unit_cents: 100, cantidad: 0, itbms_bp: 0 },
      { codigo: "A", precio_unit_cents: 100, cantidad: -1, itbms_bp: 0 },
      { codigo: "A", precio_unit_cents: 100, cantidad: 1.5, itbms_bp: 0 },
      { codigo: "A", precio_unit_cents: -100, cantidad: 1, itbms_bp: 0 },
    ]) {
      const r = calcularTotales({ lineas: [linea] });
      expect(r.ok, JSON.stringify(linea)).toBe(false);
    }
  });
});

describe("la fórmula del total es la del CHECK de pedidos", () => {
  // CHECK (total_cents = subtotal_cents + envio_cents - descuento_cents + itbms_cents)
  // Si esto se rompe, la base rechaza el pedido entero.
  const casos: EntradaTotales[] = [
    { lineas },
    { lineas, descuento: { tipo: "monto_fijo", monto_cents: 500 } },
    { lineas, envio: { tarifa_cents: 350, gratis_desde_cents: null } },
    {
      lineas: [
        { codigo: "A", precio_unit_cents: 1234, cantidad: 3, itbms_bp: 700 },
        { codigo: "B", precio_unit_cents: 987, cantidad: 7, itbms_bp: 0 },
      ],
      descuento: { tipo: "porcentaje", monto_cents: 777 },
      envio: { tarifa_cents: 425, gratis_desde_cents: 10_000 },
    },
  ];

  it.each(casos.map((c, i) => [i, c] as const))("caso %i cuadra", (_i, caso) => {
    const t = totales(caso);
    expect(t.total_cents).toBe(
      t.subtotal_cents + t.envio_cents - t.descuento_cents + t.itbms_cents,
    );
    // y todos los componentes son enteros no negativos, como exigen los CHECK
    for (const v of [t.subtotal_cents, t.envio_cents, t.descuento_cents, t.itbms_cents]) {
      expect(Number.isSafeInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
