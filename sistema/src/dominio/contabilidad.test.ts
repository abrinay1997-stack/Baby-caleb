import { describe, expect, it } from "vitest";
import {
  type Asiento,
  type Hecho,
  type SaldoDeCuenta,
  HECHOS,
  HUECOS,
  PLAN_DE_CUENTAS,
  abonoAntesDeEntregar,
  abonoComoCredito,
  ajusteDeRedondeo,
  apertura,
  asientoContrario,
  asientoManual,
  balance,
  cobroDelSaldo,
  codigoDeCaja,
  comisionDeYappy,
  compraRecibida,
  conSaldoNatural,
  costoDeLaEntrega,
  contracargo,
  cuadreDe,
  cuentaDelPlan,
  devolucionAlInventario,
  entregaDelPedido,
  esFechaContable,
  estadoDeResultados,
  fechaContable,
  gasto,
  liquidacionDePasarela,
  liquidacionDelMotorizado,
  mermaOMuestra,
  mesDe,
  pagoAlMotorizado,
  pagoAlProveedor,
  pagoDePasarela,
  rangoDeAtajo,
  rangoDelMes,
  reembolso,
  revisarAsiento,
  saldoNatural,
  tramoDeAntiguedad,
} from "./contabilidad";

/**
 * Lo que estas pruebas vigilan, y lo que no.
 *
 * Vigilan que un asiento que no cuadra NO SALGA de este módulo, que un dato que
 * falta devuelva un fallo en vez de un cero, y que cada uno de los dieciocho
 * hechos de 05 §3 mueva las cuentas que dice la tabla del documento.
 *
 * Todas se comprobaron rompiendo el código a propósito: una prueba que pasa
 * igual con el código roto no vigila nada. Donde una mutación SOBREVIVIÓ está
 * escrito al lado, con quién la caza de verdad.
 */

const FECHA = "2026-11-07";
const CAJA = codigoDeCaja("01JKMOTORIZADOXXXXXXXXXXXXX");

/** Lo que se le pide a casi todos los constructores. */
const ref = (tipo: string, id: string) => ({ tipo, id });

/** Saca el asiento de un resultado, o revienta diciendo qué falló. */
function debeDarAsiento(r: ReturnType<typeof revisarAsiento>): Asiento {
  if (!r.ok) throw new Error(`esperaba un asiento y salió un fallo: ${r.mensaje}`);
  return r.datos;
}

/** Las líneas como pares legibles, para comparar contra la tabla del plan. */
const lineas = (a: Asiento) =>
  a.lineas.map((l) => `${l.cuenta} ${l.debeCents > 0 ? "D" : "H"} ${l.debeCents + l.haberCents}`);

// ---------------------------------------------------------------------------

describe("fechas contables", () => {
  it("usa la hora de Panamá y no la UTC", () => {
    // 11 de noviembre, 03:00 UTC = 10 de noviembre, 22:00 en Panamá. Un asiento
    // de esa hora pertenece al día 10: con la fecha UTC se iría al 11, y una
    // venta de la noche del último día del mes caería en el mes siguiente.
    expect(fechaContable(Date.parse("2026-11-11T03:00:00Z"))).toBe("2026-11-10");
    expect(fechaContable(Date.parse("2026-11-11T05:00:00Z"))).toBe("2026-11-11");
  });

  it("rechaza un día que no existe, que es lo que el CHECK de SQL deja pasar", () => {
    expect(esFechaContable("2026-02-31")).toBe(false);
    expect(esFechaContable("2026-13-01")).toBe(false);
    expect(esFechaContable("2026-11-00")).toBe(false);
    expect(esFechaContable("2026-02-28")).toBe(true);
    expect(esFechaContable("2024-02-29")).toBe(true);
    expect(esFechaContable("07/11/2026")).toBe(false);
    expect(esFechaContable(1762000000000)).toBe(false);
  });

  it("saca el mes y cuenta los días entre dos fechas", () => {
    expect(mesDe("2026-11-07")).toBe("2026-11");
    expect(rangoDelMes("2026-02")).toEqual({ desde: "2026-02-01", hasta: "2026-02-28" });
    expect(rangoDelMes("2024-02")).toEqual({ desde: "2024-02-01", hasta: "2024-02-29" });
    expect(rangoDelMes("2026-12")).toEqual({ desde: "2026-12-01", hasta: "2026-12-31" });
  });

  describe("los atajos de 05 §5", () => {
    // Domingo 8 de noviembre de 2026, mediodía de Panamá.
    const domingo = Date.parse("2026-11-08T17:00:00Z");
    // Lunes 16 de noviembre de 2026, mediodía de Panamá.
    const lunes = Date.parse("2026-11-16T17:00:00Z");

    it("«esta semana» empieza el lunes, también cuando hoy es domingo", () => {
      // El domingo es el día 0 de la semana en JavaScript. Sin el ajuste, el
      // lunes saldría «mañana» y la semana quedaría vacía.
      expect(rangoDeAtajo("semana", domingo)).toEqual({
        desde: "2026-11-02",
        hasta: "2026-11-08",
      });
      expect(rangoDeAtajo("semana", lunes)).toEqual({
        desde: "2026-11-16",
        hasta: "2026-11-16",
      });
    });

    it("la quincena cambia el día 16", () => {
      expect(rangoDeAtajo("quincena", domingo).desde).toBe("2026-11-01");
      expect(rangoDeAtajo("quincena", lunes).desde).toBe("2026-11-16");
    });

    it("el mes pasado de enero es diciembre del año anterior", () => {
      const enero = Date.parse("2027-01-10T17:00:00Z");
      expect(rangoDeAtajo("mes_pasado", enero)).toEqual({
        desde: "2026-12-01",
        hasta: "2026-12-31",
      });
    });

    it("hoy, este mes y este año", () => {
      expect(rangoDeAtajo("hoy", domingo)).toEqual({ desde: "2026-11-08", hasta: "2026-11-08" });
      expect(rangoDeAtajo("mes", domingo)).toEqual({ desde: "2026-11-01", hasta: "2026-11-08" });
      expect(rangoDeAtajo("ano", domingo)).toEqual({ desde: "2026-01-01", hasta: "2026-11-08" });
    });
  });
});

describe("el plan de cuentas de 05 §2", () => {
  it("trae las veintitrés cuentas del documento, con su tipo", () => {
    // Copiado de la tabla del plan, no generado de la constante: si se generara
    // de lo mismo que comprueba, la prueba pasaría con la lista equivocada.
    const esperado: [string, string][] = [
      ["1101", "activo"], ["1102", "activo"], ["1103", "activo"],
      ["1105", "activo"], ["1106", "activo"], ["1201", "activo"], ["1301", "activo"],
      ["2101", "pasivo"], ["2102", "pasivo"], ["2201", "pasivo"],
      ["3101", "patrimonio"], ["3201", "patrimonio"],
      ["4101", "ingreso"], ["4102", "ingreso"], ["4901", "ingreso"],
      ["5101", "costo"], ["5201", "costo"],
      ["6101", "gasto"], ["6102", "gasto"], ["6103", "gasto"],
      ["6104", "gasto"], ["6105", "gasto"], ["6199", "gasto"],
    ];
    expect(PLAN_DE_CUENTAS.map((c) => [c.codigo, c.tipo])).toEqual(esperado);
  });

  it("marca 4901 como ingreso contra, que es lo que la hace restar", () => {
    expect(cuentaDelPlan("4901")?.subtipo).toBe("contra_ingreso");
  });

  it("la caja de un motorizado es una cuenta de activo que no está en la lista fija", () => {
    const caja = cuentaDelPlan(CAJA);
    expect(caja?.tipo).toBe("activo");
    expect(caja?.subtipo).toBe("caja_motorizado");
    expect(PLAN_DE_CUENTAS.some((c) => c.codigo === CAJA)).toBe(false);
  });

  it("un código que no existe no es una cuenta", () => {
    expect(cuentaDelPlan("9999")).toBeNull();
    expect(cuentaDelPlan("1104-")).toBeNull();
    expect(cuentaDelPlan("")).toBeNull();
  });

  it("el saldo va por el lado natural de cada tipo", () => {
    // Un activo con más debe que haber tiene dinero; un pasivo con más haber
    // que debe es una deuda. Al revés, la mitad de los saldos saldrían con el
    // signo cambiado y «te deben» saldría en negativo.
    expect(saldoNatural("activo", 1000, 400)).toBe(600);
    expect(saldoNatural("pasivo", 400, 1000)).toBe(600);
    expect(saldoNatural("ingreso", 0, 5000)).toBe(5000);
    expect(saldoNatural("gasto", 5000, 0)).toBe(5000);
    expect(saldoNatural("patrimonio", 0, 250000)).toBe(250000);
    expect(saldoNatural("costo", 3000, 0)).toBe(3000);
  });
});

describe("revisarAsiento es la puerta", () => {
  const bueno: Asiento = {
    fecha: FECHA,
    descripcion: "Prueba",
    origen: "ajuste",
    hecho: "manual",
    referencia: null,
    lineas: [
      { cuenta: "1103", debeCents: 1000, haberCents: 0, detalle: null },
      { cuenta: "2101", debeCents: 0, haberCents: 1000, detalle: null },
    ],
  };

  it("deja pasar uno que cuadra", () => {
    expect(revisarAsiento(bueno).ok).toBe(true);
  });

  it("no deja pasar uno que no cuadra, ni por un centavo", () => {
    const r = revisarAsiento({
      ...bueno,
      lineas: [bueno.lineas[0]!, { ...bueno.lineas[1]!, haberCents: 999 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/no cuadra/);
  });

  it("no deja pasar una fecha que no es una fecha contable", () => {
    expect(revisarAsiento({ ...bueno, fecha: "2026-02-31" }).ok).toBe(false);
    expect(revisarAsiento({ ...bueno, fecha: "hoy" }).ok).toBe(false);
  });

  it("no deja pasar un asiento sin descripción", () => {
    expect(revisarAsiento({ ...bueno, descripcion: "   " }).ok).toBe(false);
  });

  it("no deja pasar una sola línea: eso no es partida doble", () => {
    expect(revisarAsiento({ ...bueno, lineas: [bueno.lineas[0]!] }).ok).toBe(false);
  });

  it("no deja pasar un asiento VACÍO, que es el que el cuadre dejaría entrar", () => {
    // `cuadreDe([])` da cero contra cero, o sea que un asiento sin líneas
    // «cuadra». Si solo lo vigilara el cuadre, entraría un asiento que no dice
    // nada — y se llega ahí sin querer, porque las líneas de cero se quitan
    // antes de cuadrar y a veces no queda ninguna.
    expect(cuadreDe([]).cuadra).toBe(true);
    expect(revisarAsiento({ ...bueno, lineas: [] }).ok).toBe(false);
  });

  it("y tampoco uno que se queda sin líneas porque todas eran de cero", () => {
    expect(
      asientoManual({
        fecha: FECHA,
        descripcion: "Todo en cero",
        referencia: null,
        lineas: [
          { cuenta: "1103", debeCents: 0, haberCents: 0, detalle: null },
          { cuenta: "2101", debeCents: 0, haberCents: 0, detalle: null },
        ],
      }).ok,
    ).toBe(false);
  });

  it("no deja pasar una cuenta que no está en el plan", () => {
    const r = revisarAsiento({
      ...bueno,
      lineas: [{ ...bueno.lineas[0]!, cuenta: "7777" }, bueno.lineas[1]!],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/7777/);
  });

  it("no deja pasar una línea con los dos lados, ni con ninguno, ni con decimales", () => {
    const con = (l: Partial<Asiento["lineas"][number]>) =>
      revisarAsiento({
        ...bueno,
        lineas: [{ ...bueno.lineas[0]!, ...l }, bueno.lineas[1]!],
      }).ok;

    expect(con({ debeCents: 1000, haberCents: 1000 })).toBe(false);
    expect(con({ debeCents: 0, haberCents: 0 })).toBe(false);
    expect(con({ debeCents: 10.5 })).toBe(false);
    expect(con({ debeCents: -1000 })).toBe(false);
  });

  it("cuadreDe dice de qué lado falta, para poder explicarlo", () => {
    expect(cuadreDe(bueno.lineas)).toEqual({
      debeCents: 1000,
      haberCents: 1000,
      diferenciaCents: 0,
      cuadra: true,
    });
    expect(cuadreDe([bueno.lineas[0]!]).diferenciaCents).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Los dieciocho hechos de 05 §3
// ---------------------------------------------------------------------------

describe("asiento 1 · abono antes de entregar", () => {
  it("el dinero entra y queda como deuda con la clienta, no como venta", () => {
    const a = debeDarAsiento(
      abonoAntesDeEntregar({
        fecha: FECHA,
        referencia: ref("pedido", "ped-1"),
        cuenta: "1101",
        montoCents: 1500,
        detalle: "Pedido BC-000123",
      }),
    );
    expect(a.hecho).toBe("1");
    expect(lineas(a)).toEqual(["1101 D 1500", "2101 H 1500"]);
    // Lo que importa de verdad: NO toca 4101. Un abono no es una venta.
    expect(lineas(a).some((l) => l.startsWith("4101"))).toBe(false);
  });

  it("no entra por una cuenta que no recibe dinero", () => {
    const r = abonoAntesDeEntregar({
      fecha: FECHA,
      referencia: null,
      cuenta: "1105",
      montoCents: 1500,
      detalle: "x",
    });
    expect(r.ok).toBe(false);
  });

  it("no acepta un monto de cero ni uno negativo", () => {
    for (const montoCents of [0, -500, 10.5]) {
      expect(
        abonoAntesDeEntregar({ fecha: FECHA, referencia: null, cuenta: "1103", montoCents, detalle: "x" }).ok,
      ).toBe(false);
    }
  });
});

describe("asiento 2 · pago aprobado por la pasarela", () => {
  it("entra el bruto a «por liquidar», no el neto al banco", () => {
    const a = debeDarAsiento(
      pagoDePasarela({
        fecha: FECHA,
        referencia: ref("pago", "pag-1"),
        cuenta: "1105",
        brutoCents: 5000,
        detalle: "Pedido BC-000124",
      }),
    );
    expect(a.hecho).toBe("2");
    expect(lineas(a)).toEqual(["1105 D 5000", "2101 H 5000"]);
    // La comisión no aparece aquí: se conoce al liquidar (asiento 7).
    expect(lineas(a).some((l) => l.startsWith("6103"))).toBe(false);
  });

  it("no entra por el banco: el dinero todavía lo tiene la pasarela", () => {
    expect(
      pagoDePasarela({ fecha: FECHA, referencia: null, cuenta: "1101", brutoCents: 5000, detalle: "x" }).ok,
    ).toBe(false);
  });
});

describe("asiento 3 · entrega del pedido", () => {
  const entrega = {
    fecha: FECHA,
    referencia: ref("pedido", "ped-2"),
    numero: "BC-000125",
    subtotalCents: 5000,
    descuentoCents: 500,
    envioCents: 350,
    itbmsCents: 0,
    totalCents: 4850,
    abonadoCents: 1000,
  };

  it("mueve el anticipo a por cobrar y reconoce la venta sin ITBMS", () => {
    const a = debeDarAsiento(entregaDelPedido(entrega));
    expect(a.hecho).toBe("3");
    expect(lineas(a)).toEqual([
      "2101 D 1000",
      "1201 D 3850",
      "4101 H 4500",
      "4102 H 350",
    ]);
    expect(cuadreDe(a.lineas).cuadra).toBe(true);
  });

  it("el descuento baja la venta, no se anota aparte", () => {
    const a = debeDarAsiento(entregaDelPedido(entrega));
    const venta = a.lineas.find((l) => l.cuenta === "4101")!;
    expect(venta.haberCents).toBe(4500);
  });

  it("el ITBMS va a su pasivo y no a las ventas", () => {
    const a = debeDarAsiento(
      entregaDelPedido({
        ...entrega,
        subtotalCents: 5000,
        descuentoCents: 0,
        envioCents: 0,
        itbmsCents: 350,
        totalCents: 5350,
        abonadoCents: 0,
      }),
    );
    expect(lineas(a)).toEqual(["1201 D 5350", "4101 H 5000", "2201 H 350"]);
  });

  it("sin ITBMS no hay línea de ITBMS, que no es lo mismo que una de cero", () => {
    const a = debeDarAsiento(entregaDelPedido(entrega));
    expect(a.lineas.some((l) => l.cuenta === "2201")).toBe(false);
  });

  it("un pedido pagado completo antes de salir no deja nada por cobrar", () => {
    const a = debeDarAsiento(entregaDelPedido({ ...entrega, abonadoCents: 4850 }));
    expect(lineas(a)).toEqual(["2101 D 4850", "4101 H 4500", "4102 H 350"]);
    expect(a.lineas.some((l) => l.cuenta === "1201")).toBe(false);
  });

  it("un pedido sin abono no toca el anticipo", () => {
    const a = debeDarAsiento(entregaDelPedido({ ...entrega, abonadoCents: 0 }));
    expect(a.lineas.some((l) => l.cuenta === "2101")).toBe(false);
  });

  it("no registra un pedido cuyo total no cuadra con sus partes", () => {
    // El asiento cuadraría igual —las dos columnas salen del mismo total— así
    // que esto no lo caza el cuadre: lo caza la igualdad del pedido.
    const r = entregaDelPedido({ ...entrega, totalCents: 4900 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/no cuadra con sus partes/);
  });

  it("no acepta que lo abonado pase del total", () => {
    expect(entregaDelPedido({ ...entrega, abonadoCents: 9000 }).ok).toBe(false);
  });

  it("no acepta montos negativos ni un total de cero", () => {
    expect(entregaDelPedido({ ...entrega, descuentoCents: -100 }).ok).toBe(false);
    expect(
      entregaDelPedido({
        ...entrega,
        subtotalCents: 0,
        descuentoCents: 0,
        envioCents: 0,
        itbmsCents: 0,
        totalCents: 0,
        abonadoCents: 0,
      }).ok,
    ).toBe(false);
  });
});

describe("asiento 3b · costo de la entrega", () => {
  it("saca del inventario lo que costó y lo pone en el costo de lo vendido", () => {
    const a = debeDarAsiento(
      costoDeLaEntrega({
        fecha: FECHA,
        referencia: ref("pedido", "ped-2"),
        numero: "BC-000125",
        costoCents: 3000,
      }),
    );
    expect(a.hecho).toBe("3b");
    expect(lineas(a)).toEqual(["5101 D 3000", "1301 H 3000"]);
  });

  it("sin costo conocido NO registra un cero: dice de quién es el dato", () => {
    const r = costoDeLaEntrega({
      fecha: FECHA,
      referencia: null,
      numero: "BC-000125",
      costoCents: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.mensaje).toMatch(/no se sabe lo que costó/);
      expect(r.mensaje).toMatch(/contadora/);
    }
  });
});

describe("asientos 4 y 4b · el motorizado cobra el saldo", () => {
  it("en efectivo el dinero queda en la caja del motorizado (asiento 4)", () => {
    const a = debeDarAsiento(
      cobroDelSaldo({ fecha: FECHA, referencia: null, cuenta: CAJA, montoCents: 3850, numero: "BC-000125" }),
    );
    expect(a.hecho).toBe("4");
    expect(lineas(a)).toEqual([`${CAJA} D 3850`, "1201 H 3850"]);
  });

  it("por Yappy entra directo a la cuenta (asiento 4b)", () => {
    const a = debeDarAsiento(
      cobroDelSaldo({ fecha: FECHA, referencia: null, cuenta: "1101", montoCents: 3850, numero: "BC-000125" }),
    );
    // El número del hecho SALE DE LA CUENTA. Si se pudiera pasar aparte, un
    // asiento diría «cobró por Yappy» con el dinero en la caja de alguien.
    expect(a.hecho).toBe("4b");
  });

  it("no se cobra un saldo contra el inventario ni contra una venta", () => {
    for (const cuenta of ["1301", "4101", "1105"]) {
      expect(
        cobroDelSaldo({ fecha: FECHA, referencia: null, cuenta, montoCents: 100, numero: "X" }).ok,
      ).toBe(false);
    }
  });
});

describe("asiento 5 · liquidación del motorizado", () => {
  it("vacía la caja del motorizado contra la caja de la casa", () => {
    const a = debeDarAsiento(
      liquidacionDelMotorizado({
        fecha: FECHA,
        referencia: null,
        cuentaCaja: CAJA,
        cuentaDestino: "1103",
        montoCents: 12000,
        motorizado: "Luis",
      }),
    );
    expect(a.hecho).toBe("5");
    expect(lineas(a)).toEqual(["1103 D 12000", `${CAJA} H 12000`]);
  });

  it("no liquida desde una cuenta que no es la caja de nadie", () => {
    expect(
      liquidacionDelMotorizado({
        fecha: FECHA,
        referencia: null,
        cuentaCaja: "1103",
        cuentaDestino: "1102",
        montoCents: 100,
        motorizado: "Luis",
      }).ok,
    ).toBe(false);
  });
});

describe("asiento 6 · pago al motorizado por sus viajes", () => {
  it("es un gasto y sale de una cuenta de dinero", () => {
    const a = debeDarAsiento(
      pagoAlMotorizado({
        fecha: FECHA,
        referencia: null,
        cuentaPago: "1103",
        montoCents: 2500,
        motorizado: "Luis",
      }),
    );
    expect(a.hecho).toBe("6");
    expect(lineas(a)).toEqual(["6102 D 2500", "1103 H 2500"]);
  });
});

describe("asiento 7 · liquidación de la pasarela", () => {
  it("reparte el bruto entre el neto que llega y la comisión que se queda", () => {
    const a = debeDarAsiento(
      liquidacionDePasarela({
        fecha: FECHA,
        referencia: ref("liquidacion", "liq-1"),
        cuentaPorLiquidar: "1105",
        cuentaBanco: "1102",
        brutoCents: 10000,
        comisionCents: 410,
        netoCents: 9590,
        proveedor: "Tilopay",
      }),
    );
    expect(a.hecho).toBe("7");
    expect(lineas(a)).toEqual(["1102 D 9590", "6103 D 410", "1105 H 10000"]);
  });

  it("no acepta un depósito donde el neto no es el bruto menos la comisión", () => {
    const r = liquidacionDePasarela({
      fecha: FECHA,
      referencia: null,
      cuentaPorLiquidar: "1105",
      cuentaBanco: "1102",
      brutoCents: 10000,
      comisionCents: 410,
      netoCents: 9600,
      proveedor: "Tilopay",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/neto del depósito/);
  });

  it("una liquidación sin comisión no deja una línea de cero en 6103", () => {
    const a = debeDarAsiento(
      liquidacionDePasarela({
        fecha: FECHA,
        referencia: null,
        cuentaPorLiquidar: "1106",
        cuentaBanco: "1102",
        brutoCents: 10000,
        comisionCents: 0,
        netoCents: 10000,
        proveedor: "PayPal",
      }),
    );
    expect(a.lineas).toHaveLength(2);
  });
});

describe("asiento 8 · comisión de Yappy", () => {
  it("sale de la cuenta de Yappy y va al gasto de comisiones", () => {
    const a = debeDarAsiento(comisionDeYappy({ fecha: FECHA, referencia: null, montoCents: 50 }));
    expect(a.hecho).toBe("8");
    expect(lineas(a)).toEqual(["6103 D 50", "1101 H 50"]);
    expect(a.descripcion).toMatch(/extracto/);
  });
});

describe("asientos 9 y 10 · compras y proveedores", () => {
  it("la compra recibida entra al inventario y se le debe al proveedor", () => {
    const a = debeDarAsiento(
      compraRecibida({
        fecha: FECHA,
        referencia: ref("compra", "com-1"),
        costoPuestoCents: 250000,
        cuentaHaber: "2102",
        proveedor: "Nateen",
      }),
    );
    expect(a.hecho).toBe("9");
    expect(lineas(a)).toEqual(["1301 D 250000", "2102 H 250000"]);
  });

  it("la compra pagada al contado sale de la cuenta de dinero", () => {
    const a = debeDarAsiento(
      compraRecibida({
        fecha: FECHA,
        referencia: null,
        costoPuestoCents: 250000,
        cuentaHaber: "1102",
        proveedor: "Nateen",
      }),
    );
    expect(lineas(a)).toEqual(["1301 D 250000", "1102 H 250000"]);
  });

  it("una compra no se carga contra una venta ni contra un gasto", () => {
    for (const cuentaHaber of ["4101", "6101"]) {
      expect(
        compraRecibida({
          fecha: FECHA,
          referencia: null,
          costoPuestoCents: 1000,
          cuentaHaber,
          proveedor: "x",
        }).ok,
      ).toBe(false);
    }
  });

  it("el pago al proveedor baja la deuda", () => {
    const a = debeDarAsiento(
      pagoAlProveedor({
        fecha: FECHA,
        referencia: null,
        cuentaPago: "1102",
        montoCents: 250000,
        proveedor: "Nateen",
      }),
    );
    expect(a.hecho).toBe("10");
    expect(lineas(a)).toEqual(["2102 D 250000", "1102 H 250000"]);
  });
});

describe("asiento 11 · gasto", () => {
  it("carga la cuenta del gasto y descarga la de pago", () => {
    const a = debeDarAsiento(
      gasto({
        fecha: FECHA,
        referencia: ref("gasto", "gas-1"),
        cuentaGasto: "6101",
        cuentaPago: "1102",
        montoCents: 4000,
        concepto: "Meta Ads de noviembre",
      }),
    );
    expect(a.hecho).toBe("11");
    expect(lineas(a)).toEqual(["6101 D 4000", "1102 H 4000"]);
    expect(a.descripcion).toBe("Publicidad: Meta Ads de noviembre");
  });

  it("no deja cargar un gasto al inventario", () => {
    // Sin esto, un gasto cargado por error a 1301 sube el inventario sin que
    // entre una caja, y aparece como diferencia en el conteo del mes siguiente.
    const r = gasto({
      fecha: FECHA,
      referencia: null,
      cuentaGasto: "1301",
      cuentaPago: "1102",
      montoCents: 4000,
      concepto: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/no es una cuenta de gasto/);
  });

  it("no acepta un gasto sin concepto", () => {
    expect(
      gasto({
        fecha: FECHA,
        referencia: null,
        cuentaGasto: "6199",
        cuentaPago: "1103",
        montoCents: 100,
        concepto: "  ",
      }).ok,
    ).toBe(false);
  });
});

describe("asiento 12 · merma, muestra o regalo", () => {
  it("sale del inventario a su propia cuenta, no al costo de lo vendido", () => {
    const a = debeDarAsiento(
      mermaOMuestra({ fecha: FECHA, referencia: null, costoCents: 1200, motivo: "Caja mojada" }),
    );
    expect(a.hecho).toBe("12");
    expect(lineas(a)).toEqual(["5201 D 1200", "1301 H 1200"]);
    // Si fuera a 5101, una caja regalada parecería una venta con margen malo.
    expect(a.lineas.some((l) => l.cuenta === "5101")).toBe(false);
  });

  it("sin motivo y sin costo conocido, no se registra", () => {
    expect(mermaOMuestra({ fecha: FECHA, referencia: null, costoCents: 1200, motivo: "" }).ok).toBe(false);
    expect(mermaOMuestra({ fecha: FECHA, referencia: null, costoCents: null, motivo: "Mojada" }).ok).toBe(false);
  });
});

describe("asiento 13 · devolución que vuelve al inventario", () => {
  it("deshace la venta y devuelve la mercancía al inventario", () => {
    const a = debeDarAsiento(
      devolucionAlInventario({
        fecha: FECHA,
        referencia: ref("pedido", "ped-3"),
        numero: "BC-000126",
        subtotalCents: 5000,
        costoCents: 3000,
        reintegradoCents: 5000,
        cuentaReintegro: "1201",
      }),
    );
    expect(a.hecho).toBe("13");
    expect(lineas(a)).toEqual([
      "4901 D 5000",
      "1301 D 3000",
      "1201 H 5000",
      "5101 H 3000",
    ]);
  });

  it("si no se sabe el costo, vuelve sin las líneas de costo y sigue cuadrando", () => {
    const a = debeDarAsiento(
      devolucionAlInventario({
        fecha: FECHA,
        referencia: null,
        numero: "BC-000126",
        subtotalCents: 5000,
        costoCents: null,
        reintegradoCents: 5000,
        cuentaReintegro: "2101",
      }),
    );
    expect(lineas(a)).toEqual(["4901 D 5000", "2101 H 5000"]);
    expect(cuadreDe(a.lineas).cuadra).toBe(true);
  });

  it("avisa en vez de rellenar cuando lo reintegrado no es el subtotal", () => {
    const r = devolucionAlInventario({
      fecha: FECHA,
      referencia: null,
      numero: "BC-000126",
      subtotalCents: 5000,
      costoCents: 3000,
      reintegradoCents: 5350,
      cuentaReintegro: "1201",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toMatch(/contadora/);
  });

  it("solo reintegra contra lo por cobrar o el anticipo", () => {
    expect(
      devolucionAlInventario({
        fecha: FECHA,
        referencia: null,
        numero: "X",
        subtotalCents: 100,
        costoCents: null,
        reintegradoCents: 100,
        cuentaReintegro: "1103",
      }).ok,
    ).toBe(false);
  });
});

describe("asientos 14 y 15 · reembolso y contracargo", () => {
  it("el reembolso de un pedido sin entregar baja el anticipo", () => {
    const a = debeDarAsiento(
      reembolso({
        fecha: FECHA,
        referencia: ref("pedido", "ped-4"),
        cuentaContra: "2101",
        cuentaOrigen: "1101",
        montoCents: 1500,
        detalle: "Pedido BC-000127 cancelado",
      }),
    );
    expect(a.hecho).toBe("14");
    expect(lineas(a)).toEqual(["2101 D 1500", "1101 H 1500"]);
  });

  it("el reembolso de una venta ya hecha va contra devoluciones", () => {
    const a = debeDarAsiento(
      reembolso({
        fecha: FECHA,
        referencia: null,
        cuentaContra: "4901",
        cuentaOrigen: "1102",
        montoCents: 1500,
        detalle: "x",
      }),
    );
    expect(lineas(a)[0]).toBe("4901 D 1500");
  });

  it("un reembolso no se carga a una cuenta cualquiera", () => {
    expect(
      reembolso({
        fecha: FECHA,
        referencia: null,
        cuentaContra: "6199",
        cuentaOrigen: "1102",
        montoCents: 100,
        detalle: "x",
      }).ok,
    ).toBe(false);
  });

  it("el contracargo se lleva el dinero de donde estaba", () => {
    const a = debeDarAsiento(
      contracargo({
        fecha: FECHA,
        referencia: ref("pago", "pag-9"),
        cuentaOrigen: "1105",
        montoCents: 5000,
        detalle: "Disputa de tarjeta",
      }),
    );
    expect(a.hecho).toBe("15");
    expect(lineas(a)).toEqual(["4901 D 5000", "1105 H 5000"]);
  });
});

describe("asiento 16 · abono aplicado como crédito", () => {
  it("las dos líneas van a 2101 y cada una dice de qué pedido es", () => {
    const a = debeDarAsiento(
      abonoComoCredito({
        fecha: FECHA,
        referencia: ref("pedido", "ped-nuevo"),
        montoCents: 1500,
        numeroViejo: "BC-000120",
        numeroNuevo: "BC-000131",
      }),
    );
    expect(a.hecho).toBe("16");
    expect(a.lineas.map((l) => [l.cuenta, l.detalle])).toEqual([
      ["2101", "Pedido BC-000120"],
      ["2101", "Pedido BC-000131"],
    ]);
    // Sin el detalle, el mayor de 2101 enseña dos importes iguales y nadie
    // puede saber cuál es cuál. Esta es la razón de que la columna exista.
    expect(a.lineas.every((l) => l.detalle !== null)).toBe(true);
  });

  it("un crédito no se pasa al mismo pedido", () => {
    expect(
      abonoComoCredito({
        fecha: FECHA,
        referencia: null,
        montoCents: 1500,
        numeroViejo: "BC-000120",
        numeroNuevo: "BC-000120",
      }).ok,
    ).toBe(false);
  });
});

describe("asiento 17 · apertura", () => {
  it("el capital es lo que queda: no es una cifra que alguien ponga", () => {
    const a = debeDarAsiento(
      apertura({
        fecha: "2026-12-01",
        activos: [
          { cuenta: "1103", montoCents: 10000, detalle: "Efectivo contado" },
          { cuenta: "1301", montoCents: 250000, detalle: "Conteo físico al costo" },
        ],
        anticipos: [{ cuenta: "2101", montoCents: 5000, detalle: "Pedido BC-000100" }],
      }),
    );
    expect(a.hecho).toBe("17");
    expect(lineas(a)).toEqual([
      "1103 D 10000",
      "1301 D 250000",
      "2101 H 5000",
      "3101 H 255000",
    ]);
  });

  it("si se debe más de lo que hay, el capital va por el debe", () => {
    const a = debeDarAsiento(
      apertura({
        fecha: "2026-12-01",
        activos: [{ cuenta: "1103", montoCents: 1000, detalle: null }],
        anticipos: [{ cuenta: "2101", montoCents: 5000, detalle: null }],
      }),
    );
    expect(lineas(a)).toEqual(["1103 D 1000", "2101 H 5000", "3101 D 4000"]);
    expect(cuadreDe(a.lineas).cuadra).toBe(true);
  });

  it("no abre contra una cuenta que no es de activo, ni con anticipos fuera de 2101", () => {
    expect(
      apertura({
        fecha: "2026-12-01",
        activos: [{ cuenta: "4101", montoCents: 1000, detalle: null }],
        anticipos: [],
      }).ok,
    ).toBe(false);
    expect(
      apertura({
        fecha: "2026-12-01",
        activos: [{ cuenta: "1103", montoCents: 1000, detalle: null }],
        anticipos: [{ cuenta: "2102", montoCents: 500, detalle: null }],
      }).ok,
    ).toBe(false);
  });

  it("una apertura sin saldos no abre nada", () => {
    expect(apertura({ fecha: "2026-12-01", activos: [], anticipos: [] }).ok).toBe(false);
  });
});

describe("asiento 18 · ajuste de redondeo del costo promedio", () => {
  it("el residuo que sobra en el inventario se va al costo de lo vendido", () => {
    const a = debeDarAsiento(
      ajusteDeRedondeo({ fecha: FECHA, referencia: null, residuoCents: 3, codigo: "NAT-M" }),
    );
    expect(a.hecho).toBe("18");
    expect(lineas(a)).toEqual(["5101 D 3", "1301 H 3"]);
  });

  it("si el residuo quedó al revés, el asiento también", () => {
    const a = debeDarAsiento(
      ajusteDeRedondeo({ fecha: FECHA, referencia: null, residuoCents: -3, codigo: "NAT-M" }),
    );
    expect(lineas(a)).toEqual(["1301 D 3", "5101 H 3"]);
  });

  it("un ajuste de cero no se registra", () => {
    expect(ajusteDeRedondeo({ fecha: FECHA, referencia: null, residuoCents: 0, codigo: "NAT-M" }).ok).toBe(
      false,
    );
  });
});

describe("el asiento contrario", () => {
  const original = debeDarAsiento(
    gasto({
      fecha: "2026-10-15",
      referencia: ref("gasto", "gas-2"),
      cuentaGasto: "6101",
      cuentaPago: "1102",
      montoCents: 4000,
      concepto: "Cargado por error",
    }),
  );

  it("es el espejo exacto, con la fecha de hoy y no la del original", () => {
    const r = asientoContrario(original, FECHA, "estaba cargado al mes equivocado");
    const a = debeDarAsiento(r);
    // Mismo orden de líneas, cada una del otro lado: el reverso es el espejo
    // y no una versión reordenada que haya que volver a leer.
    expect(lineas(a)).toEqual(["6101 H 4000", "1102 D 4000"]);
    // La fecha de hoy: si el mes del original ya está cerrado, un reverso con
    // su fecha rebotaría contra el trigger del periodo y no habría forma de
    // corregir nada.
    expect(a.fecha).toBe(FECHA);
    expect(a.descripcion).toMatch(/^Reverso: /);
    expect(a.descripcion).toMatch(/mes equivocado/);
  });

  it("no se revierte nada sin decir por qué", () => {
    expect(asientoContrario(original, FECHA, "   ").ok).toBe(false);
  });
});

describe("el asiento que escribe una persona", () => {
  it("pasa por la misma puerta: si no cuadra, no entra", () => {
    const malo = asientoManual({
      fecha: FECHA,
      descripcion: "Corrección",
      referencia: null,
      lineas: [
        { cuenta: "6199", debeCents: 1000, haberCents: 0, detalle: null },
        { cuenta: "1103", debeCents: 0, haberCents: 900, detalle: null },
      ],
    });
    expect(malo.ok).toBe(false);

    const bueno = asientoManual({
      fecha: FECHA,
      descripcion: "Corrección",
      referencia: null,
      lineas: [
        { cuenta: "6199", debeCents: 1000, haberCents: 0, detalle: "Ajuste" },
        { cuenta: "1103", debeCents: 0, haberCents: 1000, detalle: null },
      ],
    });
    expect(bueno.ok).toBe(true);
    if (bueno.ok) expect(bueno.datos.hecho).toBe("manual");
  });
});

describe("los dieciocho hechos están todos", () => {
  it("cada número de la tabla de 05 §3 tiene un constructor que cuadra", () => {
    const hechos = [
      abonoAntesDeEntregar({ fecha: FECHA, referencia: null, cuenta: "1101", montoCents: 100, detalle: "x" }),
      pagoDePasarela({ fecha: FECHA, referencia: null, cuenta: "1105", brutoCents: 100, detalle: "x" }),
      entregaDelPedido({
        fecha: FECHA, referencia: null, numero: "X", subtotalCents: 100, descuentoCents: 0,
        envioCents: 0, itbmsCents: 0, totalCents: 100, abonadoCents: 50,
      }),
      costoDeLaEntrega({ fecha: FECHA, referencia: null, numero: "X", costoCents: 60 }),
      cobroDelSaldo({ fecha: FECHA, referencia: null, cuenta: CAJA, montoCents: 50, numero: "X" }),
      cobroDelSaldo({ fecha: FECHA, referencia: null, cuenta: "1101", montoCents: 50, numero: "X" }),
      liquidacionDelMotorizado({
        fecha: FECHA, referencia: null, cuentaCaja: CAJA, cuentaDestino: "1103",
        montoCents: 50, motorizado: "Luis",
      }),
      pagoAlMotorizado({ fecha: FECHA, referencia: null, cuentaPago: "1103", montoCents: 50, motorizado: "Luis" }),
      liquidacionDePasarela({
        fecha: FECHA, referencia: null, cuentaPorLiquidar: "1105", cuentaBanco: "1102",
        brutoCents: 100, comisionCents: 10, netoCents: 90, proveedor: "Tilopay",
      }),
      comisionDeYappy({ fecha: FECHA, referencia: null, montoCents: 10 }),
      compraRecibida({ fecha: FECHA, referencia: null, costoPuestoCents: 100, cuentaHaber: "2102", proveedor: "N" }),
      pagoAlProveedor({ fecha: FECHA, referencia: null, cuentaPago: "1102", montoCents: 100, proveedor: "N" }),
      gasto({
        fecha: FECHA, referencia: null, cuentaGasto: "6105", cuentaPago: "1102",
        montoCents: 100, concepto: "Cloudflare",
      }),
      mermaOMuestra({ fecha: FECHA, referencia: null, costoCents: 100, motivo: "Mojada" }),
      devolucionAlInventario({
        fecha: FECHA, referencia: null, numero: "X", subtotalCents: 100,
        costoCents: 60, reintegradoCents: 100, cuentaReintegro: "1201",
      }),
      reembolso({
        fecha: FECHA, referencia: null, cuentaContra: "2101", cuentaOrigen: "1101",
        montoCents: 100, detalle: "x",
      }),
      contracargo({ fecha: FECHA, referencia: null, cuentaOrigen: "1105", montoCents: 100, detalle: "x" }),
      abonoComoCredito({ fecha: FECHA, referencia: null, montoCents: 100, numeroViejo: "A", numeroNuevo: "B" }),
      apertura({
        fecha: FECHA,
        activos: [{ cuenta: "1103", montoCents: 100, detalle: null }],
        anticipos: [],
      }),
      ajusteDeRedondeo({ fecha: FECHA, referencia: null, residuoCents: 2, codigo: "NAT-M" }),
    ];

    const numeros: Hecho[] = [];
    for (const r of hechos) {
      const a = debeDarAsiento(r);
      expect(cuadreDe(a.lineas).cuadra, `el asiento ${a.hecho} no cuadra`).toBe(true);
      numeros.push(a.hecho);
    }

    // Los veinte de la tabla (los dieciocho más 3b y 4b), en el orden del
    // documento. Si un día se añade un hecho al plan y no su constructor, esto
    // lo dice.
    expect(numeros).toEqual(HECHOS.filter((h) => h !== "manual"));
  });
});

// ---------------------------------------------------------------------------
// Informes
// ---------------------------------------------------------------------------

/** Arma los saldos de un periodo como los devolvería la base. */
function saldos(
  movimientos: [string, number, number][],
): SaldoDeCuenta[] {
  return movimientos.map(([codigo, debeCents, haberCents]) => {
    const c = cuentaDelPlan(codigo)!;
    return conSaldoNatural({
      codigo,
      nombre: c.nombre,
      tipo: c.tipo,
      subtipo: c.subtipo,
      debeCents,
      haberCents,
    });
  });
}

describe("estado de resultados (05 §5)", () => {
  const filas = saldos([
    ["4101", 0, 100_000],   // ventas
    ["4102", 0, 7_000],     // envíos cobrados
    ["4901", 8_000, 0],     // devoluciones y descuentos (cuenta contra)
    ["5101", 60_000, 0],    // costo de lo vendido
    ["5201", 1_000, 0],     // mermas
    ["6101", 4_000, 0],     // publicidad
    ["6102", 5_000, 0],     // motorizados
  ]);

  it("ventas − devoluciones − costo − mermas = ganancia bruta", () => {
    const r = estadoDeResultados(filas, 0);
    expect(r.ventasCents).toBe(100_000);
    expect(r.devolucionesCents).toBe(8_000);
    expect(r.costoDeVentasCents).toBe(60_000);
    expect(r.mermasCents).toBe(1_000);
    expect(r.gananciaBrutaCents).toBe(31_000);
  });

  it("la ganancia neta quita los gastos y suma lo cobrado por envío", () => {
    const r = estadoDeResultados(filas, 0);
    expect(r.gastosCents).toBe(9_000);
    expect(r.ingresosEnvioCents).toBe(7_000);
    expect(r.gananciaNetaCents).toBe(29_000);
  });

  it("las devoluciones RESTAN: 4901 es una cuenta contra", () => {
    // Si 4901 se sumara como un ingreso más, la ganancia subiría con cada
    // devolución. Es el error que más tarda en verse.
    const sinDevoluciones = estadoDeResultados(
      filas.filter((f) => f.codigo !== "4901"),
      0,
    );
    expect(sinDevoluciones.gananciaBrutaCents).toBe(39_000);
    expect(sinDevoluciones.gananciaBrutaCents).toBeGreaterThan(
      estadoDeResultados(filas, 0).gananciaBrutaCents,
    );
  });

  it("el margen sale en puntos básicos sobre la venta neta", () => {
    // 31 000 / 92 000 = 33.6956…, que redondea a 33.70 %
    expect(estadoDeResultados(filas, 0).margenBrutoBp).toBe(3370);
  });

  it("con entregas sin costo NO hay margen: «sin costo de ventas no es ganancia»", () => {
    const r = estadoDeResultados(filas, 2);
    expect(r.margenBrutoBp).toBeNull();
    expect(r.entregasSinCosto).toBe(2);
    // La ganancia bruta se sigue dando —es lo que dicen los libros— pero sin
    // margen, que es el número que mentiría.
    expect(r.gananciaBrutaCents).toBe(31_000);
  });

  it("sin ventas no hay margen que calcular", () => {
    expect(estadoDeResultados(saldos([["6101", 4_000, 0]]), 0).margenBrutoBp).toBeNull();
  });
});

describe("balance (05 §5)", () => {
  it("activos = pasivos + patrimonio + lo ganado en el periodo", () => {
    const filas = saldos([
      ["1103", 10_000, 0],
      ["1301", 190_000, 0],
      ["2101", 0, 5_000],
      ["3101", 0, 255_000],
      ["4101", 0, 100_000],
      ["5101", 60_000, 0],
      ["6101", 100_000, 0],
    ]);
    const b = balance(filas);
    expect(b.activoCents).toBe(200_000);
    expect(b.pasivoCents).toBe(5_000);
    expect(b.patrimonioCents).toBe(255_000);
    expect(b.resultadoCents).toBe(-60_000);
    expect(b.diferenciaCents).toBe(0);
    expect(b.cuadra).toBe(true);
  });

  it("dice cuánto falta cuando no cuadra, en vez de decir que sí", () => {
    const b = balance(saldos([["1103", 10_000, 0], ["3101", 0, 9_000]]));
    expect(b.cuadra).toBe(false);
    expect(b.diferenciaCents).toBe(1_000);
  });

  it("el resultado del periodo va aparte y no dentro del patrimonio", () => {
    // Si se sumara a 3101, el balance de cualquier mes con ventas parecería
    // descuadrado justo por el importe de la ganancia.
    const b = balance(saldos([["1103", 10_000, 0], ["4101", 0, 10_000]]));
    expect(b.patrimonioCents).toBe(0);
    expect(b.resultadoCents).toBe(10_000);
    expect(b.cuadra).toBe(true);
  });
});

describe("antigüedad de lo por cobrar", () => {
  it("parte en 7 y en 30 días, como el plan", () => {
    expect(tramoDeAntiguedad(0)).toBe("0-7");
    expect(tramoDeAntiguedad(7)).toBe("0-7");
    expect(tramoDeAntiguedad(8)).toBe("8-30");
    expect(tramoDeAntiguedad(30)).toBe("8-30");
    expect(tramoDeAntiguedad(31)).toBe("mas-de-30");
  });
});

describe("lo que falta por decidir", () => {
  it("cada hueco dice qué falta, quién lo da, qué bloquea y de dónde sale", () => {
    expect(HUECOS.length).toBeGreaterThan(0);
    for (const h of HUECOS) {
      expect(h.clave, "la clave no puede estar vacía").not.toBe("");
      expect(h.que.length, `${h.clave}: falta el qué`).toBeGreaterThan(10);
      expect(h.quien.length, `${h.clave}: falta el quién`).toBeGreaterThan(3);
      expect(h.sinEsto.length, `${h.clave}: falta qué bloquea`).toBeGreaterThan(10);
      expect(h.fuente, `${h.clave}: falta la fuente`).toMatch(/\d/);
    }
  });

  it("no hay dos huecos con la misma clave", () => {
    expect(new Set(HUECOS.map((h) => h.clave)).size).toBe(HUECOS.length);
  });

  it("están los cuatro que el 05 §10 deja a la contadora", () => {
    const claves = HUECOS.map((h) => h.clave);
    for (const c of ["itbms", "factura_fiscal", "banco", "reconocimiento"]) {
      expect(claves, `falta el hueco ${c}`).toContain(c);
    }
  });
});
