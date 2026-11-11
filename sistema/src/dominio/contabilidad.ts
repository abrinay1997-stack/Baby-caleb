import { type Resultado, fallo, ok } from "../contrato/resultado";
import { type Centavos, sumar } from "./dinero";

/**
 * La contabilidad, sin base de datos.
 *
 * Aquí vive lo único que decide si un libro dice la verdad: qué asiento genera
 * cada hecho, cómo cuadra y cómo se lee un periodo. Sin D1, así que se puede
 * romper a propósito y comprobar que se nota.
 *
 * **El documento manda, no el criterio contable de quien escribe esto.**
 * `docs/plan/05-contabilidad.md` numeró los hechos del uno al dieciocho (con
 * 3b y 4b), y cada constructor de este archivo es uno de esos números, con su
 * fila copiada encima. Si un asiento tiene que cambiar, se cambia primero en el
 * documento.
 *
 * ## Las dos reglas que lo gobiernan
 *
 * **1. Ninguna cifra a ojo** (docs/plan/README.md, regla 2). Nada de lo que hay
 * aquí inventa un monto. Un dato que falta llega como `null` y devuelve un
 * fallo con el nombre de quien lo tiene que dar; nunca se convierte en cero.
 * Es el mismo criterio que `precios.ts` aplica al ITBMS: «un cero inventado es
 * una declaración de impuestos mal hecha».
 *
 * **2. Si no cuadra, no se escribe.** `revisarAsiento` es la puerta por la que
 * pasan los dieciocho, y lo que no cuadra al centavo no sale de aquí. En la
 * base hay además una fila de control que tumba el batch (migración 0011), así
 * que harían falta dos fallos a la vez para que un asiento torcido entre.
 *
 * ## Por qué partida doble y no un libro de caja
 *
 * Porque con un libro de caja no se pueden representar a la vez los anticipos
 * de las clientas, lo que lleva encima el motorizado, lo que retiene una
 * pasarela, el inventario y lo que se le debe al proveedor (05 §1). Con dos
 * columnas sí, y el balance cuadra solo.
 */

// ---------------------------------------------------------------------------
// Fechas contables
// ---------------------------------------------------------------------------

/**
 * Panamá es UTC−5 todo el año, sin horario de verano (02-datos §1).
 *
 * Por eso la fecha contable se calcula restando cinco horas y no con
 * `toLocaleDateString`: una tabla de zonas horarias que cambie dejaría de
 * cuadrar con los meses ya cerrados, y la hora del negocio no cambia nunca.
 */
const MS_DE_PANAMA = 5 * 60 * 60 * 1000;

/** `YYYY-MM-DD` en hora de Panamá. Es lo que va en `asientos.fecha`. */
export function fechaContable(ms: number): string {
  return new Date(ms - MS_DE_PANAMA).toISOString().slice(0, 10);
}

const FORMA_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Una fecha contable de verdad.
 *
 * El `CHECK` de la migración solo mira la FORMA (`GLOB`), así que acepta
 * «2026-02-31». Aquí se comprueba que el día exista: una fecha imposible se
 * cuela en el mes siguiente cuando alguien la lee, y entonces un asiento
 * aparece en un mes donde no pasó nada.
 */
export function esFechaContable(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = FORMA_FECHA.exec(v);
  if (m === null) return false;
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || dia < 1) return false;
  const d = new Date(Date.UTC(a, mes - 1, dia));
  return d.getUTCFullYear() === a && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/** `'2026-11'` de `'2026-11-07'`. Es la llave de `periodos`. */
export const mesDe = (fecha: string): string => fecha.slice(0, 7);

/** Días entre dos fechas contables. Sirve para la antigüedad de lo por cobrar. */
export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** El primer y el último día de un mes `YYYY-MM`. */
export function rangoDelMes(mes: string): { desde: string; hasta: string } {
  const a = Number(mes.slice(0, 4));
  const m = Number(mes.slice(5, 7));
  // Día 0 del mes siguiente es el último del mes pedido, sin tabla de días.
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${String(ultimo).padStart(2, "0")}` };
}

/**
 * Los atajos de fecha de 05 §5. Hora de Panamá.
 *
 * «Esta semana» es de lunes a hoy, como dice el documento, y no los últimos
 * siete días: la dueña compara la semana con la semana, no con una ventana
 * móvil que nunca empieza el mismo día.
 */
export const ATAJOS = ["hoy", "semana", "quincena", "mes", "mes_pasado", "ano"] as const;
export type Atajo = (typeof ATAJOS)[number];

export const ETIQUETAS_ATAJO: Record<Atajo, string> = {
  hoy: "Hoy",
  semana: "Esta semana",
  quincena: "Esta quincena",
  mes: "Este mes",
  mes_pasado: "Mes pasado",
  ano: "Este año",
};

export function rangoDeAtajo(atajo: Atajo, ahoraMs: number): { desde: string; hasta: string } {
  const hoy = fechaContable(ahoraMs);
  const [a, m, d] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)), Number(hoy.slice(8, 10))];
  const mes = hoy.slice(0, 7);

  switch (atajo) {
    case "hoy":
      return { desde: hoy, hasta: hoy };
    case "semana": {
      // getUTCDay: 0 es domingo. El lunes de esta semana está a `(dia+6)%7`
      // días atrás, que para el domingo son seis y no menos uno.
      const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
      const atras = (dia + 6) % 7;
      return { desde: fechaContable(Date.UTC(a, m - 1, d - atras) + MS_DE_PANAMA), hasta: hoy };
    }
    case "quincena":
      return { desde: d <= 15 ? `${mes}-01` : `${mes}-16`, hasta: hoy };
    case "mes":
      return { desde: `${mes}-01`, hasta: hoy };
    case "mes_pasado": {
      const anterior = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
      return rangoDelMes(anterior);
    }
    case "ano":
      return { desde: `${a}-01-01`, hasta: hoy };
  }
}

/**
 * Qué significa el periodo de una tarjeta (05 §5).
 *
 * Un SALDO es «al día X» y solo usa la fecha final: el dinero que hay en una
 * cuenta no es «del 1 al 7», es lo que hay hoy. Un MOVIMIENTO es «del X al Y».
 * Cada tarjeta lo dice, porque mezclarlos es como se acaba comparando el saldo
 * de una cuenta con las ventas de una semana.
 */
export type Alcance = "saldo" | "movimiento";

// ---------------------------------------------------------------------------
// Plan de cuentas (05 §2)
// ---------------------------------------------------------------------------

export const TIPOS_DE_CUENTA = [
  "activo",
  "pasivo",
  "patrimonio",
  "ingreso",
  "costo",
  "gasto",
] as const;
export type TipoDeCuenta = (typeof TIPOS_DE_CUENTA)[number];

/**
 * De qué lado tiene su saldo cada tipo de cuenta.
 *
 * Es la única regla de la partida doble que hay que saberse: los activos, los
 * costos y los gastos crecen por el DEBE; los pasivos, el patrimonio y los
 * ingresos, por el HABER. Todo lo demás de este archivo sale de aquí.
 */
export const LADO: Record<TipoDeCuenta, "debe" | "haber"> = {
  activo: "debe",
  costo: "debe",
  gasto: "debe",
  pasivo: "haber",
  patrimonio: "haber",
  ingreso: "haber",
};

export interface CuentaDelPlan {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: TipoDeCuenta;
  readonly subtipo: string | null;
}

/**
 * Las cuentas de la tabla de 05 §2, en su orden.
 *
 * Son las mismas que siembra la migración 0011 — hay una prueba que falla si
 * las dos listas se separan. Están aquí además de en SQL porque los asientos se
 * arman nombrando códigos y el código tiene que poder comprobarse sin ir a la
 * base: un asiento contra una cuenta que no existe es un asiento que cuadra y
 * no significa nada.
 */
export const PLAN_DE_CUENTAS: readonly CuentaDelPlan[] = [
  { codigo: "1101", nombre: "Yappy Comercial (Banco General)", tipo: "activo", subtipo: "yappy" },
  { codigo: "1102", nombre: "Banco (cuál: PENDIENTE)", tipo: "activo", subtipo: "banco" },
  { codigo: "1103", nombre: "Efectivo en caja", tipo: "activo", subtipo: "efectivo" },
  { codigo: "1105", nombre: "Por liquidar Tilopay", tipo: "activo", subtipo: "por_liquidar" },
  { codigo: "1106", nombre: "Por liquidar PayPal", tipo: "activo", subtipo: "por_liquidar" },
  { codigo: "1201", nombre: "Cuentas por cobrar a clientas", tipo: "activo", subtipo: "por_cobrar" },
  { codigo: "1301", nombre: "Inventario", tipo: "activo", subtipo: "inventario" },
  { codigo: "2101", nombre: "Anticipos de clientas", tipo: "pasivo", subtipo: null },
  { codigo: "2102", nombre: "Cuentas por pagar a proveedores", tipo: "pasivo", subtipo: null },
  { codigo: "2201", nombre: "ITBMS por pagar", tipo: "pasivo", subtipo: null },
  { codigo: "3101", nombre: "Capital", tipo: "patrimonio", subtipo: null },
  { codigo: "3201", nombre: "Resultados acumulados", tipo: "patrimonio", subtipo: null },
  { codigo: "4101", nombre: "Ventas", tipo: "ingreso", subtipo: null },
  { codigo: "4102", nombre: "Ingresos por envío", tipo: "ingreso", subtipo: null },
  { codigo: "4901", nombre: "Devoluciones y descuentos", tipo: "ingreso", subtipo: "contra_ingreso" },
  { codigo: "5101", nombre: "Costo de lo vendido", tipo: "costo", subtipo: null },
  { codigo: "5201", nombre: "Mermas, muestras y regalos", tipo: "costo", subtipo: null },
  { codigo: "6101", nombre: "Publicidad", tipo: "gasto", subtipo: null },
  { codigo: "6102", nombre: "Motorizados y envíos", tipo: "gasto", subtipo: null },
  { codigo: "6103", nombre: "Comisiones de pasarelas", tipo: "gasto", subtipo: null },
  { codigo: "6104", nombre: "Empaques", tipo: "gasto", subtipo: null },
  { codigo: "6105", nombre: "Software e IA", tipo: "gasto", subtipo: null },
  { codigo: "6199", nombre: "Otros gastos", tipo: "gasto", subtipo: null },
];

/**
 * La caja de cada motorizado: 1104-xx, «una subcuenta por persona» (05 §2).
 *
 * El sufijo es el id del motorizado y no un ordinal de dos cifras. Un ordinal
 * habría que contarlo al crear la cuenta, y contar filas dentro de un batch de
 * D1 es justo la carrera que este proyecto evita en todas partes: dos
 * motorizados dados de alta a la vez se llevarían el mismo número, el UNIQUE de
 * `codigo` tumbaría el segundo, y el alta de una persona fallaría por un
 * detalle cosmético. Con el id no puede colisionar nunca.
 */
export const PREFIJO_CAJA = "1104-";

export const codigoDeCaja = (motorizadoId: string): string => PREFIJO_CAJA + motorizadoId;

export const esCodigoDeCaja = (codigo: string): boolean =>
  codigo.startsWith(PREFIJO_CAJA) && codigo.length > PREFIJO_CAJA.length;

const PORCODIGO = new Map(PLAN_DE_CUENTAS.map((c) => [c.codigo, c]));

/** La cuenta de un código, o `null` si ese código no existe en el plan. */
export function cuentaDelPlan(codigo: string): CuentaDelPlan | null {
  const fija = PORCODIGO.get(codigo);
  if (fija !== undefined) return fija;
  if (!esCodigoDeCaja(codigo)) return null;
  return {
    codigo,
    nombre: "Caja de motorizado",
    tipo: "activo",
    subtipo: "caja_motorizado",
  };
}

/** Las cuentas por las que se mueve dinero de verdad: 11xx (05 §5, flujo de caja). */
export const esCuentaDeDinero = (codigo: string): boolean => {
  const c = cuentaDelPlan(codigo);
  if (c === null) return false;
  return (
    c.subtipo === "yappy" ||
    c.subtipo === "banco" ||
    c.subtipo === "efectivo" ||
    c.subtipo === "caja_motorizado" ||
    c.subtipo === "por_liquidar"
  );
};

/**
 * Lo que vale una cuenta por su lado natural.
 *
 * Un activo con saldo positivo tiene dinero; un pasivo con saldo positivo es
 * una deuda de verdad. Sin esto, cada pantalla restaría en el orden que le
 * pareciera y la mitad de los saldos saldrían con el signo al revés.
 */
export function saldoNatural(tipo: TipoDeCuenta, debeCents: Centavos, haberCents: Centavos): Centavos {
  return LADO[tipo] === "debe" ? debeCents - haberCents : haberCents - debeCents;
}

// ---------------------------------------------------------------------------
// El asiento
// ---------------------------------------------------------------------------

export const ORIGENES = [
  "apertura",
  "pago",
  "entrega",
  "cobro",
  "liquidacion",
  "compra",
  "gasto",
  "inventario",
  "devolucion",
  "reembolso",
  "contracargo",
  "credito",
  "ajuste",
] as const;
export type Origen = (typeof ORIGENES)[number];

/** Los dieciocho de 05 §3, más el que escribe una persona a mano. */
export const HECHOS = [
  "1",
  "2",
  "3",
  "3b",
  "4",
  "4b",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "manual",
] as const;
export type Hecho = (typeof HECHOS)[number];

/**
 * Qué es cada hecho, con las palabras del documento.
 *
 * Esto es lo que hace que una cifra de la pantalla pueda decir de dónde sale:
 * un apunte dice «Asiento 3 · Entrega del pedido» y no «movimiento 4101». Una
 * cifra que no puede decir de dónde viene invita a creérsela.
 */
export const ETIQUETAS_HECHO: Record<Hecho, string> = {
  "1": "Abono o pago antes de entregar",
  "2": "Pago aprobado por la pasarela",
  "3": "Entrega del pedido",
  "3b": "Costo de la entrega",
  "4": "El motorizado cobró el saldo en efectivo",
  "4b": "El motorizado cobró el saldo por Yappy",
  "5": "Liquidación del motorizado",
  "6": "Pago al motorizado por sus viajes",
  "7": "Liquidación de la pasarela",
  "8": "Comisión de Yappy",
  "9": "Compra recibida",
  "10": "Pago al proveedor",
  "11": "Gasto",
  "12": "Merma, muestra o regalo",
  "13": "Devolución que vuelve al inventario",
  "14": "Reembolso",
  "15": "Contracargo",
  "16": "Abono aplicado como crédito a otro pedido",
  "17": "Apertura",
  "18": "Ajuste de redondeo del costo promedio",
  manual: "Asiento escrito a mano",
};

export interface LineaDeAsiento {
  readonly cuenta: string;
  readonly debeCents: Centavos;
  readonly haberCents: Centavos;
  /** De qué es la línea cuando el asiento solo no lo dice (asiento 16). */
  readonly detalle: string | null;
}

export interface Referencia {
  readonly tipo: string;
  readonly id: string;
}

export interface Asiento {
  readonly fecha: string;
  readonly descripcion: string;
  readonly origen: Origen;
  readonly hecho: Hecho;
  readonly referencia: Referencia | null;
  readonly lineas: readonly LineaDeAsiento[];
}

const debe = (cuenta: string, montoCents: Centavos, detalle: string | null = null): LineaDeAsiento => ({
  cuenta,
  debeCents: montoCents,
  haberCents: 0,
  detalle,
});

const haber = (cuenta: string, montoCents: Centavos, detalle: string | null = null): LineaDeAsiento => ({
  cuenta,
  debeCents: 0,
  haberCents: montoCents,
  detalle,
});

/** Un monto de cero NO es una línea: se quita antes de cuadrar. */
const sinCeros = (lineas: readonly LineaDeAsiento[]): LineaDeAsiento[] =>
  lineas.filter((l) => l.debeCents !== 0 || l.haberCents !== 0);

const esMonto = (n: unknown): n is Centavos => Number.isSafeInteger(n) && (n as number) > 0;

export interface Cuadre {
  readonly debeCents: Centavos;
  readonly haberCents: Centavos;
  readonly diferenciaCents: Centavos;
  readonly cuadra: boolean;
}

/** Lo que el `control_cuadre` de la base calculará después, para poder decirlo antes. */
export function cuadreDe(lineas: readonly LineaDeAsiento[]): Cuadre {
  const d = sumar(lineas.map((l) => l.debeCents));
  const h = sumar(lineas.map((l) => l.haberCents));
  return { debeCents: d, haberCents: h, diferenciaCents: d - h, cuadra: d === h };
}

/**
 * La puerta por la que pasan los dieciocho.
 *
 * Ningún constructor de este archivo devuelve un asiento sin pasar por aquí, y
 * nada de lo que no cuadra sale del módulo. Lo que comprueba:
 *
 *  1. la fecha es una fecha contable de verdad (el `CHECK` de SQL solo mira la
 *     forma, así que «2026-02-31» lo caza esto y no la base);
 *  2. hay descripción;
 *  3. hay al menos dos líneas: un asiento de una sola línea no es partida
 *     doble, es una nota;
 *  4. cada línea es de un lado, con un entero positivo, contra una cuenta que
 *     existe en el plan;
 *  5. el debe iguala al haber AL CENTAVO.
 */
export function revisarAsiento(a: Asiento): Resultado<Asiento> {
  if (!esFechaContable(a.fecha)) {
    return fallo("entrada_invalida", `«${a.fecha}» no es una fecha contable (YYYY-MM-DD)`);
  }
  if (a.descripcion.trim() === "") {
    return fallo("entrada_invalida", "un asiento sin descripción no le explica nada a nadie");
  }
  // Lo que esto defiende de verdad es el asiento VACÍO, y conviene decirlo:
  // `cuadreDe([])` da debe 0 y haber 0, o sea que un asiento sin ni una línea
  // «cuadra» y pasaría el control de abajo sin problema. Y se llega ahí sin
  // mala intención: `sinCeros` se queda con cero líneas si todos los montos
  // venían en cero.
  //
  // Un asiento de UNA línea, en cambio, ya lo caza el cuadre —una línea es
  // siempre de un lado y positiva, así que nunca puede cuadrar—. Lo comprobé
  // cambiando el 2 por un 1 y no se movió ninguna prueba. El 2 se queda porque
  // dice la intención y porque el mensaje explica el problema en vez de hablar
  // de una diferencia de centavos, no porque sea lo que sostiene la regla.
  if (a.lineas.length < 2) {
    return fallo(
      "entrada_invalida",
      "un asiento lleva al menos dos líneas: una de debe y una de haber",
    );
  }

  for (const l of a.lineas) {
    if (cuentaDelPlan(l.cuenta) === null) {
      return fallo("entrada_invalida", `la cuenta ${l.cuenta} no está en el plan de cuentas`);
    }
    const unLado =
      (esMonto(l.debeCents) && l.haberCents === 0) || (esMonto(l.haberCents) && l.debeCents === 0);
    if (!unLado) {
      return fallo(
        "entrada_invalida",
        `la línea de ${l.cuenta} tiene que ser de debe o de haber, con un monto entero en centavos`,
      );
    }
  }

  const c = cuadreDe(a.lineas);
  if (!c.cuadra) {
    return fallo(
      "entrada_invalida",
      `el asiento no cuadra: debe ${c.debeCents} y haber ${c.haberCents}, diferencia ${c.diferenciaCents}`,
    );
  }

  return ok(a);
}

/**
 * El asiento contrario que corrige a otro (05 §3).
 *
 * Cada línea cambia de lado y nada más: si el original cuadraba, el contrario
 * cuadra. No se «ajusta» ni se recalcula nada, porque un reverso que no es el
 * espejo exacto del original deja una diferencia que nadie va a volver a mirar.
 *
 * La fecha es la de HOY y no la del original a propósito: el error se descubre
 * hoy, y si el mes del original ya está cerrado, un reverso con su fecha
 * rebotaría contra el trigger del periodo sin que haya nada que arreglar.
 */
export function asientoContrario(
  original: Pick<Asiento, "lineas" | "origen" | "referencia" | "descripcion">,
  fechaDeHoy: string,
  motivo: string,
): Resultado<Asiento> {
  if (motivo.trim() === "") {
    return fallo("entrada_invalida", "un reverso sin motivo no le sirve a nadie");
  }
  return revisarAsiento({
    fecha: fechaDeHoy,
    descripcion: `Reverso: ${original.descripcion} — ${motivo.trim()}`,
    origen: original.origen,
    hecho: "manual",
    referencia: original.referencia,
    lineas: original.lineas.map((l) => ({
      cuenta: l.cuenta,
      debeCents: l.haberCents,
      haberCents: l.debeCents,
      detalle: l.detalle,
    })),
  });
}

// ---------------------------------------------------------------------------
// Los dieciocho asientos de 05 §3
// ---------------------------------------------------------------------------

/** Lo que todo hecho trae: cuándo pasó y a qué apunta. */
interface Comun {
  readonly fecha: string;
  readonly referencia: Referencia | null;
}

const exigeDinero = (codigo: string): Resultado<true> =>
  esCuentaDeDinero(codigo)
    ? ok(true)
    : fallo("entrada_invalida", `${codigo} no es una cuenta por la que entre o salga dinero`);

const exigeSubtipo = (codigo: string, subtipos: readonly string[], que: string): Resultado<true> => {
  const c = cuentaDelPlan(codigo);
  if (c === null) return fallo("entrada_invalida", `la cuenta ${codigo} no está en el plan`);
  return c.subtipo !== null && subtipos.includes(c.subtipo)
    ? ok(true)
    : fallo("entrada_invalida", `${codigo} no es ${que}`);
};

/**
 * Asiento 1 · «Abono o pago antes de entregar, por Yappy o manual»
 * Debe 1101 / 1102 / 1103 (monto) · Haber 2101 Anticipos
 *
 * El dinero entra y la deuda con la clienta también: mientras el pedido no
 * salga, lo abonado es un PASIVO y no una venta. Reconocerlo como venta aquí
 * sería contar como ganado algo que todavía hay que entregar.
 */
export function abonoAntesDeEntregar(e: Comun & {
  cuenta: string;
  montoCents: Centavos;
  detalle: string;
}): Resultado<Asiento> {
  const dinero = exigeSubtipo(e.cuenta, ["yappy", "banco", "efectivo"], "una cuenta de Yappy, del banco o de efectivo");
  if (!dinero.ok) return dinero;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el abono tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Abono recibido · ${e.detalle}`,
    origen: "pago",
    hecho: "1",
    referencia: e.referencia,
    lineas: [debe(e.cuenta, e.montoCents), haber("2101", e.montoCents, e.detalle)],
  });
}

/**
 * Asiento 2 · «Pago aprobado por Tilopay o PayPal»
 * Debe 1105 / 1106 (bruto) · Haber 2101 Anticipos
 *
 * Entra el BRUTO contra «por liquidar», no el neto en el banco: la pasarela
 * todavía tiene el dinero. La comisión aparece al liquidar (asiento 7), con la
 * cifra real del depósito y no con una estimada.
 */
export function pagoDePasarela(e: Comun & {
  cuenta: string;
  brutoCents: Centavos;
  detalle: string;
}): Resultado<Asiento> {
  const porLiquidar = exigeSubtipo(e.cuenta, ["por_liquidar"], "una cuenta de «por liquidar»");
  if (!porLiquidar.ok) return porLiquidar;
  if (!esMonto(e.brutoCents)) return fallo("entrada_invalida", "el pago tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Pago aprobado por la pasarela · ${e.detalle}`,
    origen: "pago",
    hecho: "2",
    referencia: e.referencia,
    lineas: [debe(e.cuenta, e.brutoCents), haber("2101", e.brutoCents, e.detalle)],
  });
}

/**
 * Asiento 3 · «Entrega del pedido»
 * Debe 2101 (A) + 1201 (T − A) · Haber 4101 (S − descuento) + 4102 (E) + 2201 (I)
 *
 * Aquí es donde la venta se reconoce: al entregar. El anticipo deja de ser una
 * deuda, lo que falte por cobrar se vuelve una cuenta por cobrar, y el ingreso
 * entra SIN ITBMS — el impuesto va a su propio pasivo (criterio de D'Casa que
 * adopta el 05 §2: «ventas, costo y ganancia sin ITBMS; el dinero que se mueve,
 * con ITBMS»).
 *
 * El ITBMS no se calcula aquí: llega como `itbmsCents` desde la columna del
 * pedido, que es donde `precios.ts` lo dejó. Mientras la tasa sea PENDIENTE esa
 * columna vale 0 y la línea de 2201 simplemente no existe — que no es lo mismo
 * que afirmar que el impuesto es cero: es que no hay nada que anotar todavía.
 */
export function entregaDelPedido(e: Comun & {
  numero: string;
  totalCents: Centavos;
  subtotalCents: Centavos;
  descuentoCents: Centavos;
  envioCents: Centavos;
  itbmsCents: Centavos;
  abonadoCents: Centavos;
}): Resultado<Asiento> {
  const enteros = [
    e.totalCents,
    e.subtotalCents,
    e.descuentoCents,
    e.envioCents,
    e.itbmsCents,
    e.abonadoCents,
  ];
  if (enteros.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    return fallo("entrada_invalida", "los montos del pedido tienen que ser enteros en centavos");
  }
  // La misma igualdad que el CHECK de `pedidos`. Se vuelve a comprobar porque
  // un asiento armado con partes que no suman el total CUADRA igual —las dos
  // columnas salen del mismo número— y la mentira se vería meses después en el
  // margen, no aquí.
  if (e.totalCents !== e.subtotalCents + e.envioCents - e.descuentoCents + e.itbmsCents) {
    return fallo(
      "entrada_invalida",
      "el total del pedido no cuadra con sus partes: subtotal + envío − descuento + ITBMS",
    );
  }
  if (e.abonadoCents > e.totalCents) {
    return fallo("entrada_invalida", "lo abonado no puede pasar del total del pedido");
  }
  if (e.totalCents === 0) {
    return fallo("entrada_invalida", "un pedido de cero no genera asiento de entrega");
  }

  const detalle = `Pedido ${e.numero}`;
  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Entrega del pedido ${e.numero}`,
    origen: "entrega",
    hecho: "3",
    referencia: e.referencia,
    lineas: sinCeros([
      debe("2101", e.abonadoCents, detalle),
      debe("1201", e.totalCents - e.abonadoCents, detalle),
      haber("4101", e.subtotalCents - e.descuentoCents, detalle),
      haber("4102", e.envioCents, detalle),
      haber("2201", e.itbmsCents, detalle),
    ]),
  });
}

/**
 * Asiento 3b · «Costo de la entrega»
 * Debe 5101 (C) · Haber 1301 (C)
 *
 * `costoCents` es `null` cuando no hay costo promedio cargado —lo que
 * `marcarEntregada` llama `costoDesconocido`— y entonces esto FALLA en vez de
 * registrar un cero. Un cero aquí afirma que la mercancía no costó nada, y eso
 * convierte el margen en 100 %: la ganancia más bonita y más falsa que hay.
 *
 * Quien llama no tiene que tratar el fallo como un error: la entrega se
 * registra igual (asiento 3) y el pedido queda en la lista de «entregados sin
 * costo» que la lista de cierre de mes exige vaciar (05 §9).
 */
export function costoDeLaEntrega(e: Comun & {
  numero: string;
  costoCents: Centavos | null;
}): Resultado<Asiento> {
  if (e.costoCents === null) {
    return fallo(
      "entrada_invalida",
      `no se sabe lo que costó la mercancía del pedido ${e.numero}: falta el costo de apertura de esas tallas, que lo pone la contadora con la factura del proveedor`,
    );
  }
  if (!esMonto(e.costoCents)) {
    return fallo("entrada_invalida", "el costo de lo vendido tiene que ser un monto positivo");
  }

  const detalle = `Pedido ${e.numero}`;
  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Costo de lo vendido del pedido ${e.numero}`,
    origen: "entrega",
    hecho: "3b",
    referencia: e.referencia,
    lineas: [debe("5101", e.costoCents, detalle), haber("1301", e.costoCents, detalle)],
  });
}

/**
 * Asientos 4 y 4b · «El motorizado cobra el saldo»
 * 4:  Debe 1104-xx · Haber 1201     (en efectivo: el dinero lo tiene él)
 * 4b: Debe 1101    · Haber 1201     (por Yappy: el dinero ya está en la cuenta)
 *
 * Son el mismo hecho con dos destinos, así que el número sale de la cuenta y no
 * de un parámetro aparte: pasar «4b» con la caja de un motorizado sería un
 * asiento que dice una cosa y hace otra.
 */
export function cobroDelSaldo(e: Comun & {
  cuenta: string;
  montoCents: Centavos;
  numero: string;
}): Resultado<Asiento> {
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el cobro tiene que ser un monto positivo");

  const esCaja = esCodigoDeCaja(e.cuenta);
  if (!esCaja && e.cuenta !== "1101") {
    return fallo(
      "entrada_invalida",
      "el saldo de una entrega se cobra en la caja del motorizado o por Yappy (1101)",
    );
  }

  const detalle = `Pedido ${e.numero}`;
  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Cobro del saldo del pedido ${e.numero}`,
    origen: "cobro",
    hecho: esCaja ? "4" : "4b",
    referencia: e.referencia,
    lineas: [debe(e.cuenta, e.montoCents, detalle), haber("1201", e.montoCents, detalle)],
  });
}

/**
 * Asiento 5 · «Liquidación del motorizado (entrega el efectivo)»
 * Debe 1103 o 1102 · Haber 1104-xx
 *
 * Mientras no se liquide, el dinero está en la calle y la caja del motorizado
 * lo dice. Por eso la lista de cierre de mes exige «cajas de motorizados en 0»:
 * un saldo ahí a fin de mes es efectivo que nadie ha contado.
 */
export function liquidacionDelMotorizado(e: Comun & {
  cuentaCaja: string;
  cuentaDestino: string;
  montoCents: Centavos;
  motorizado: string;
}): Resultado<Asiento> {
  if (!esCodigoDeCaja(e.cuentaCaja)) {
    return fallo("entrada_invalida", `${e.cuentaCaja} no es la caja de un motorizado`);
  }
  const destino = exigeSubtipo(e.cuentaDestino, ["efectivo", "banco"], "la caja de efectivo ni el banco");
  if (!destino.ok) return destino;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "la liquidación tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Liquidación de ${e.motorizado}`,
    origen: "liquidacion",
    hecho: "5",
    referencia: e.referencia,
    lineas: [debe(e.cuentaDestino, e.montoCents), haber(e.cuentaCaja, e.montoCents, e.motorizado)],
  });
}

/**
 * Asiento 6 · «Pago al motorizado por sus viajes»
 * Debe 6102 · Haber 1103 / 1101
 *
 * El MONTO LO PONE UNA PERSONA. `motorizados.pago_regla_json` está PENDIENTE de
 * la dueña (02-datos §5), así que aquí no se calcula nada a partir de las
 * paradas del día: se registra lo que se pagó. El día que la regla exista, el
 * cálculo vive donde viva esa regla, no aquí.
 */
export function pagoAlMotorizado(e: Comun & {
  cuentaPago: string;
  montoCents: Centavos;
  motorizado: string;
}): Resultado<Asiento> {
  const pago = exigeSubtipo(e.cuentaPago, ["efectivo", "yappy", "banco"], "una cuenta de pago");
  if (!pago.ok) return pago;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el pago tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Pago de viajes a ${e.motorizado}`,
    origen: "gasto",
    hecho: "6",
    referencia: e.referencia,
    lineas: [debe("6102", e.montoCents, e.motorizado), haber(e.cuentaPago, e.montoCents)],
  });
}

/**
 * Asiento 7 · «Liquidación de Tilopay o PayPal»
 * Debe 1102 (neto) + 6103 (comisión) · Haber 1105 / 1106 (bruto)
 *
 * Es el único sitio donde la comisión entra con su cifra REAL, la del depósito.
 * La estimada de `ajustes.comisiones` sirve para avisar, nunca para contabilizar
 * (04-pagos §8).
 */
export function liquidacionDePasarela(e: Comun & {
  cuentaPorLiquidar: string;
  cuentaBanco: string;
  brutoCents: Centavos;
  comisionCents: Centavos;
  netoCents: Centavos;
  proveedor: string;
}): Resultado<Asiento> {
  const porLiquidar = exigeSubtipo(e.cuentaPorLiquidar, ["por_liquidar"], "una cuenta de «por liquidar»");
  if (!porLiquidar.ok) return porLiquidar;
  const banco = exigeSubtipo(e.cuentaBanco, ["banco", "yappy"], "una cuenta de banco");
  if (!banco.ok) return banco;

  if (!esMonto(e.brutoCents)) return fallo("entrada_invalida", "el bruto tiene que ser un monto positivo");
  if (!Number.isSafeInteger(e.comisionCents) || e.comisionCents < 0) {
    return fallo("entrada_invalida", "la comisión tiene que ser un entero de centavos");
  }
  // El mismo CHECK que `liquidaciones`. Si no cuadra, la diferencia es dinero
  // que no está en ninguna parte.
  if (e.netoCents !== e.brutoCents - e.comisionCents) {
    return fallo("entrada_invalida", "el neto del depósito no es el bruto menos la comisión");
  }

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Liquidación de ${e.proveedor}`,
    origen: "liquidacion",
    hecho: "7",
    referencia: e.referencia,
    lineas: sinCeros([
      debe(e.cuentaBanco, e.netoCents, e.proveedor),
      debe("6103", e.comisionCents, e.proveedor),
      haber(e.cuentaPorLiquidar, e.brutoCents, e.proveedor),
    ]),
  });
}

/**
 * Asiento 8 · «Comisión de Yappy (del extracto)»
 * Debe 6103 · Haber 1101
 *
 * «Del extracto» es parte del asiento, no un comentario: Yappy acredita neto y
 * su comisión se conoce al leer el movimiento del banco. No se estima.
 */
export function comisionDeYappy(e: Comun & { montoCents: Centavos }): Resultado<Asiento> {
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "la comisión tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: "Comisión de Yappy (del extracto)",
    origen: "liquidacion",
    hecho: "8",
    referencia: e.referencia,
    lineas: [debe("6103", e.montoCents), haber("1101", e.montoCents)],
  });
}

/**
 * Asiento 9 · «Compra recibida»
 * Debe 1301 (costo puesto) · Haber 2102 (o 1102 si se pagó al contado)
 *
 * El inventario entra al COSTO PUESTO EN BODEGA: el de fábrica más su parte del
 * flete, la aduana y el acarreo (05 §4). El prorrateo de esos gastos lo hace la
 * compra, que llega en F5.4; aquí entra ya repartido.
 */
export function compraRecibida(e: Comun & {
  costoPuestoCents: Centavos;
  cuentaHaber: string;
  proveedor: string;
}): Resultado<Asiento> {
  const c = cuentaDelPlan(e.cuentaHaber);
  if (c === null) return fallo("entrada_invalida", `la cuenta ${e.cuentaHaber} no está en el plan`);
  if (e.cuentaHaber !== "2102" && !esCuentaDeDinero(e.cuentaHaber)) {
    return fallo(
      "entrada_invalida",
      "una compra se debe al proveedor (2102) o se paga de una cuenta de dinero",
    );
  }
  if (!esMonto(e.costoPuestoCents)) {
    return fallo("entrada_invalida", "el costo puesto tiene que ser un monto positivo");
  }

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Compra recibida de ${e.proveedor}`,
    origen: "compra",
    hecho: "9",
    referencia: e.referencia,
    lineas: [
      debe("1301", e.costoPuestoCents, e.proveedor),
      haber(e.cuentaHaber, e.costoPuestoCents, e.proveedor),
    ],
  });
}

/**
 * Asiento 10 · «Pago al proveedor»
 * Debe 2102 · Haber 1102
 */
export function pagoAlProveedor(e: Comun & {
  cuentaPago: string;
  montoCents: Centavos;
  proveedor: string;
}): Resultado<Asiento> {
  const pago = exigeDinero(e.cuentaPago);
  if (!pago.ok) return pago;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el pago tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Pago a ${e.proveedor}`,
    origen: "compra",
    hecho: "10",
    referencia: e.referencia,
    lineas: [debe("2102", e.montoCents, e.proveedor), haber(e.cuentaPago, e.montoCents)],
  });
}

/**
 * Asiento 11 · «Gasto»
 * Debe 6xxx · Haber la cuenta de pago
 *
 * La cuenta de gasto tiene que ser de tipo gasto: sin esta comprobación, un
 * gasto cargado por error a 1301 Inventario sube el inventario sin que entre
 * una caja, y eso se descubre en el conteo del mes siguiente.
 */
export function gasto(e: Comun & {
  cuentaGasto: string;
  cuentaPago: string;
  montoCents: Centavos;
  concepto: string;
}): Resultado<Asiento> {
  const g = cuentaDelPlan(e.cuentaGasto);
  if (g === null) return fallo("entrada_invalida", `la cuenta ${e.cuentaGasto} no está en el plan`);
  if (g.tipo !== "gasto") {
    return fallo("entrada_invalida", `${e.cuentaGasto} (${g.nombre}) no es una cuenta de gasto`);
  }
  const pago = exigeDinero(e.cuentaPago);
  if (!pago.ok) return pago;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el gasto tiene que ser un monto positivo");
  if (e.concepto.trim() === "") return fallo("entrada_invalida", "un gasto sin concepto no se puede revisar");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `${g.nombre}: ${e.concepto.trim()}`,
    origen: "gasto",
    hecho: "11",
    referencia: e.referencia,
    lineas: [
      debe(e.cuentaGasto, e.montoCents, e.concepto.trim()),
      haber(e.cuentaPago, e.montoCents),
    ],
  });
}

/**
 * Asiento 12 · «Merma, muestra o regalo»
 * Debe 5201 · Haber 1301
 *
 * Sale del inventario y no es una venta. Va a su propia cuenta y no a 5101 para
 * que el margen no se ensucie: una caja regalada no tuvo precio de venta, y
 * meterla en el costo de lo vendido haría parecer que se vendió mal.
 */
export function mermaOMuestra(e: Comun & {
  costoCents: Centavos | null;
  motivo: string;
}): Resultado<Asiento> {
  if (e.motivo.trim() === "") {
    return fallo("entrada_invalida", "una merma sin motivo no se puede revisar");
  }
  if (e.costoCents === null) {
    return fallo(
      "entrada_invalida",
      "no se sabe lo que costó esa mercancía: falta el costo de apertura, que lo pone la contadora",
    );
  }
  if (!esMonto(e.costoCents)) return fallo("entrada_invalida", "el costo tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Merma, muestra o regalo: ${e.motivo.trim()}`,
    origen: "inventario",
    hecho: "12",
    referencia: e.referencia,
    lineas: [debe("5201", e.costoCents, e.motivo.trim()), haber("1301", e.costoCents)],
  });
}

/**
 * Asiento 13 · «Devolución que vuelve al inventario»
 * Debe 4901 (S) + 1301 (C) · Haber 1201 o 2101 (lo reintegrado) + 5101 (C)
 *
 * Deshace la venta por el lado del ingreso (4901, que resta de las ventas) y
 * por el del costo (la mercancía vuelve al inventario y sale del costo de lo
 * vendido).
 *
 * **Lo que el asiento 13 del plan NO cubre, y aquí no se inventa:** una
 * devolución donde lo reintegrado no es el subtotal. Tal como está escrito, el
 * asiento solo cuadra si `reintegrado = S`; con ITBMS de por medio, o con un
 * reintegro parcial, falta decir a qué cuenta va la diferencia, y eso lo decide
 * la contadora. Mientras no lo diga, esto devuelve un fallo que lo explica en
 * vez de cuadrar el asiento con una línea de relleno.
 *
 * `costoCents` puede ser `null`: la mercancía vuelve y no se sabe qué costó. El
 * asiento se registra sin las dos líneas de costo —sigue cuadrando— y queda a
 * la vista en la lista de entregas sin costo.
 */
export function devolucionAlInventario(e: Comun & {
  subtotalCents: Centavos;
  costoCents: Centavos | null;
  reintegradoCents: Centavos;
  cuentaReintegro: string;
  numero: string;
}): Resultado<Asiento> {
  if (e.cuentaReintegro !== "1201" && e.cuentaReintegro !== "2101") {
    return fallo(
      "entrada_invalida",
      "lo reintegrado sale de lo por cobrar (1201) o del anticipo de la clienta (2101)",
    );
  }
  if (!esMonto(e.subtotalCents)) {
    return fallo("entrada_invalida", "el subtotal devuelto tiene que ser un monto positivo");
  }
  if (e.reintegradoCents !== e.subtotalCents) {
    return fallo(
      "entrada_invalida",
      `el asiento 13 del plan solo cubre la devolución donde lo reintegrado es el subtotal (aquí: ${e.reintegradoCents} contra ${e.subtotalCents}). A qué cuenta va la diferencia lo tiene que decir la contadora`,
    );
  }
  if (e.costoCents !== null && !esMonto(e.costoCents)) {
    return fallo("entrada_invalida", "el costo devuelto tiene que ser un monto positivo o nulo");
  }

  const detalle = `Pedido ${e.numero}`;
  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Devolución del pedido ${e.numero}`,
    origen: "devolucion",
    hecho: "13",
    referencia: e.referencia,
    lineas: sinCeros([
      debe("4901", e.subtotalCents, detalle),
      debe("1301", e.costoCents ?? 0, detalle),
      haber(e.cuentaReintegro, e.reintegradoCents, detalle),
      haber("5101", e.costoCents ?? 0, detalle),
    ]),
  });
}

/**
 * Asiento 14 · «Reembolso»
 * Debe 2101 o 4901 · Haber la cuenta de donde sale
 *
 * 2101 si el pedido no se había entregado (se devuelve el anticipo y la deuda
 * con la clienta desaparece); 4901 si ya era una venta (hay que deshacerla).
 */
export function reembolso(e: Comun & {
  cuentaContra: string;
  cuentaOrigen: string;
  montoCents: Centavos;
  detalle: string;
}): Resultado<Asiento> {
  if (e.cuentaContra !== "2101" && e.cuentaContra !== "4901") {
    return fallo(
      "entrada_invalida",
      "un reembolso se carga al anticipo (2101) si el pedido no salió, o a devoluciones (4901) si ya era una venta",
    );
  }
  const origen = exigeDinero(e.cuentaOrigen);
  if (!origen.ok) return origen;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el reembolso tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Reembolso · ${e.detalle}`,
    origen: "reembolso",
    hecho: "14",
    referencia: e.referencia,
    lineas: [debe(e.cuentaContra, e.montoCents, e.detalle), haber(e.cuentaOrigen, e.montoCents)],
  });
}

/**
 * Asiento 15 · «Contracargo»
 * Debe 4901 · Haber 1105 / 1106 o 1102
 *
 * La pasarela se lleva el dinero de vuelta. Se registra aunque la disputa esté
 * abierta: el dinero ya no está, y esperar al final de la disputa para anotarlo
 * deja el saldo del banco sin cuadrar mientras tanto.
 */
export function contracargo(e: Comun & {
  cuentaOrigen: string;
  montoCents: Centavos;
  detalle: string;
}): Resultado<Asiento> {
  const origen = exigeSubtipo(e.cuentaOrigen, ["por_liquidar", "banco", "yappy"], "una cuenta de pasarela ni del banco");
  if (!origen.ok) return origen;
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el contracargo tiene que ser un monto positivo");

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Contracargo · ${e.detalle}`,
    origen: "contracargo",
    hecho: "15",
    referencia: e.referencia,
    lineas: [debe("4901", e.montoCents, e.detalle), haber(e.cuentaOrigen, e.montoCents)],
  });
}

/**
 * Asiento 16 · «Cancelación con abono aplicado como crédito»
 * Debe 2101 (pedido viejo) · Haber 2101 (pedido nuevo)
 *
 * Las dos líneas van a la MISMA cuenta: el dinero no se mueve, cambia de dueño
 * dentro del pasivo. Por eso cada línea lleva `detalle` con su pedido — sin
 * eso, el mayor de 2101 enseña dos importes iguales y nadie sabe cuál es cuál.
 *
 * Qué se hace con un abono cuando se cancela un pedido (devolverlo o dejarlo
 * como crédito) lo decide `ajustes.cancelacion_con_abono`, que está PENDIENTE
 * de la dueña: este asiento registra el camino del crédito cuando ella lo elige
 * caso por caso, y no propone nada.
 */
export function abonoComoCredito(e: Comun & {
  montoCents: Centavos;
  numeroViejo: string;
  numeroNuevo: string;
}): Resultado<Asiento> {
  if (!esMonto(e.montoCents)) return fallo("entrada_invalida", "el crédito tiene que ser un monto positivo");
  if (e.numeroViejo === e.numeroNuevo) {
    return fallo("entrada_invalida", "el crédito tiene que pasar a OTRO pedido");
  }

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Abono del pedido ${e.numeroViejo} aplicado al pedido ${e.numeroNuevo}`,
    origen: "credito",
    hecho: "16",
    referencia: e.referencia,
    lineas: [
      debe("2101", e.montoCents, `Pedido ${e.numeroViejo}`),
      haber("2101", e.montoCents, `Pedido ${e.numeroNuevo}`),
    ],
  });
}

export interface SaldoDeApertura {
  readonly cuenta: string;
  readonly montoCents: Centavos;
  readonly detalle: string | null;
}

/**
 * Asiento 17 · «Apertura»
 * Debe los activos (inventario, cuentas) · Haber 3101 Capital
 *
 * El único asiento donde una cifra se calcula a partir de las otras, y porque
 * el documento lo manda con esas palabras: «un solo asiento de apertura que
 * CUADRA CONTRA 3101 Capital» (05 §7). El capital es lo que queda después de
 * poner lo que hay y lo que se debe; no es una cifra que alguien invente.
 *
 * Lo que sí tiene que venir de fuera, contado y revisado (05 §7):
 *  - los saldos de cada cuenta de dinero, de los extractos del día anterior;
 *  - el inventario al costo, del conteo físico y de los costos revisados con la
 *    contadora;
 *  - los abonos de pedidos no entregados, pedido por pedido, que van al pasivo.
 *
 * Si el capital sale negativo se registra por el debe, que es lo que significa:
 * se debe más de lo que hay.
 */
export function apertura(e: {
  fecha: string;
  activos: readonly SaldoDeApertura[];
  anticipos: readonly SaldoDeApertura[];
}): Resultado<Asiento> {
  if (e.activos.length === 0) {
    return fallo("entrada_invalida", "una apertura sin un solo saldo no abre nada");
  }
  for (const s of [...e.activos, ...e.anticipos]) {
    if (!esMonto(s.montoCents)) {
      return fallo("entrada_invalida", `el saldo de apertura de ${s.cuenta} no es un monto positivo`);
    }
  }
  for (const s of e.activos) {
    const c = cuentaDelPlan(s.cuenta);
    if (c === null) return fallo("entrada_invalida", `la cuenta ${s.cuenta} no está en el plan`);
    if (c.tipo !== "activo") {
      return fallo("entrada_invalida", `${s.cuenta} (${c.nombre}) no es una cuenta de activo`);
    }
  }
  for (const a of e.anticipos) {
    if (a.cuenta !== "2101") {
      return fallo("entrada_invalida", "los abonos de pedidos sin entregar van a 2101 Anticipos");
    }
  }

  const activos = sumar(e.activos.map((s) => s.montoCents));
  const anticipos = sumar(e.anticipos.map((s) => s.montoCents));
  const capital = activos - anticipos;

  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Apertura al ${e.fecha}`,
    origen: "apertura",
    hecho: "17",
    referencia: null,
    lineas: sinCeros([
      ...e.activos.map((s) => debe(s.cuenta, s.montoCents, s.detalle)),
      ...e.anticipos.map((s) => haber(s.cuenta, s.montoCents, s.detalle)),
      capital >= 0 ? haber("3101", capital) : debe("3101", -capital),
    ]),
  });
}

/**
 * Asiento 18 · «Ajuste de redondeo del costo promedio»
 * Debe 5101 o 1301 · Haber 1301 o 5101
 *
 * El costo promedio sale de `round(valor_cents × q / unidades)` (05 §4), así
 * que cuando las unidades de una variante llegan a cero puede quedar un residuo
 * de centavos en `valor_cents`: inventario que ya no existe. Esto lo pasa al
 * costo de lo vendido, que es de donde se fue la mercancía.
 *
 * `residuoCents` es lo que quedó, con signo. Cero no genera asiento: un asiento
 * de cero centavos no corrige nada y ensucia el libro.
 */
export function ajusteDeRedondeo(e: Comun & {
  residuoCents: Centavos;
  codigo: string;
}): Resultado<Asiento> {
  if (!Number.isSafeInteger(e.residuoCents) || e.residuoCents === 0) {
    return fallo("entrada_invalida", "un ajuste de redondeo de cero no corrige nada");
  }

  const monto = Math.abs(e.residuoCents);
  const detalle = `Variante ${e.codigo}`;
  return revisarAsiento({
    fecha: e.fecha,
    descripcion: `Ajuste de redondeo del costo promedio de ${e.codigo}`,
    origen: "inventario",
    hecho: "18",
    referencia: e.referencia,
    lineas:
      e.residuoCents > 0
        ? [debe("5101", monto, detalle), haber("1301", monto, detalle)]
        : [debe("1301", monto, detalle), haber("5101", monto, detalle)],
  });
}

/**
 * El asiento que escribe una persona.
 *
 * La contadora lleva la contabilidad (`roles.ts`: `contabilidad: "editar"`) y
 * hay correcciones que no son ninguno de los dieciocho. Pasa por la misma
 * puerta que los automáticos: si no cuadra, no entra.
 */
export function asientoManual(e: {
  fecha: string;
  descripcion: string;
  lineas: readonly LineaDeAsiento[];
  referencia: Referencia | null;
}): Resultado<Asiento> {
  return revisarAsiento({
    fecha: e.fecha,
    descripcion: e.descripcion,
    origen: "ajuste",
    hecho: "manual",
    referencia: e.referencia,
    lineas: sinCeros(e.lineas),
  });
}

// ---------------------------------------------------------------------------
// Informes (05 §5)
// ---------------------------------------------------------------------------

export interface SaldoDeCuenta {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: TipoDeCuenta;
  readonly subtipo: string | null;
  readonly debeCents: Centavos;
  readonly haberCents: Centavos;
  /** Por el lado natural de la cuenta. */
  readonly saldoCents: Centavos;
}

export function conSaldoNatural(
  f: Omit<SaldoDeCuenta, "saldoCents">,
): SaldoDeCuenta {
  return { ...f, saldoCents: saldoNatural(f.tipo, f.debeCents, f.haberCents) };
}

export interface EstadoDeResultados {
  readonly ventasCents: Centavos;
  readonly devolucionesCents: Centavos;
  readonly costoDeVentasCents: Centavos;
  readonly mermasCents: Centavos;
  readonly gananciaBrutaCents: Centavos;
  readonly ingresosEnvioCents: Centavos;
  readonly gastosCents: Centavos;
  readonly gananciaNetaCents: Centavos;
  /**
   * El margen bruto en puntos básicos, o `null` cuando no se puede decir.
   *
   * `null` cuando hubo entregas sin costo: entonces el margen sale altísimo
   * porque falta el costo, no porque el negocio vaya bien. «Sin costo de ventas
   * no es ganancia» (05 §5).
   */
  readonly margenBrutoBp: number | null;
  readonly entregasSinCosto: number;
  readonly porCuenta: readonly SaldoDeCuenta[];
}

const total = (filas: readonly SaldoDeCuenta[], tipo: TipoDeCuenta): Centavos =>
  sumar(filas.filter((f) => f.tipo === tipo).map((f) => f.saldoCents));

const deCuenta = (filas: readonly SaldoDeCuenta[], codigo: string): Centavos =>
  filas.find((f) => f.codigo === codigo)?.saldoCents ?? 0;

/**
 * Estado de resultados del periodo (05 §5).
 *
 * «Ventas − devoluciones − costo de lo vendido − mermas = ganancia bruta; −
 * gastos = ganancia neta», tal cual.
 *
 * **Dónde va el ingreso por envío: una decisión que no es nuestra.** El §5 no
 * lo dice. Dejarlo fuera de la ganancia neta haría que el número no coincida
 * con lo que dicen los libros —ese dinero existe—, así que va en la neta y
 * APARTE de la bruta, en su propia línea, y está en la lista de lo que falta
 * por decidir para que la contadora diga dónde lo quiere. Lo que no se hace es
 * meterlo en la bruta en silencio: eso cambiaría el margen de todos los
 * informes por una decisión que nadie tomó.
 */
export function estadoDeResultados(
  filas: readonly SaldoDeCuenta[],
  entregasSinCosto: number,
): EstadoDeResultados {
  const ventasCents = deCuenta(filas, "4101");
  const ingresosEnvioCents = deCuenta(filas, "4102");
  // 4901 es un ingreso CONTRA: sus apuntes van al debe, así que su saldo
  // natural es negativo. Se da la vuelta para poder mostrarlo como resta.
  const devolucionesCents = -deCuenta(filas, "4901");
  const costoDeVentasCents = deCuenta(filas, "5101");
  const mermasCents = deCuenta(filas, "5201");
  const gastosCents = total(filas, "gasto");

  const gananciaBrutaCents =
    ventasCents - devolucionesCents - costoDeVentasCents - mermasCents;
  const gananciaNetaCents = gananciaBrutaCents + ingresosEnvioCents - gastosCents;

  const base = ventasCents - devolucionesCents;
  const margenBrutoBp =
    entregasSinCosto > 0 || base <= 0
      ? null
      : Math.round((gananciaBrutaCents * 10_000) / base);

  return {
    ventasCents,
    devolucionesCents,
    costoDeVentasCents,
    mermasCents,
    gananciaBrutaCents,
    ingresosEnvioCents,
    gastosCents,
    gananciaNetaCents,
    margenBrutoBp,
    entregasSinCosto,
    porCuenta: filas,
  };
}

export interface Balance {
  readonly activoCents: Centavos;
  readonly pasivoCents: Centavos;
  readonly patrimonioCents: Centavos;
  /** Lo ganado o perdido en lo que va del ejercicio, todavía sin cerrar a 3201. */
  readonly resultadoCents: Centavos;
  readonly diferenciaCents: Centavos;
  readonly cuadra: boolean;
}

/**
 * Balance al día (05 §5): activos = pasivos + patrimonio.
 *
 * El resultado del ejercicio va aparte porque todavía no se ha cerrado contra
 * 3201 Resultados acumulados: sin él, el balance de cualquier mes con ventas
 * parecería descuadrado por el importe de la ganancia.
 */
export function balance(filas: readonly SaldoDeCuenta[]): Balance {
  const activoCents = total(filas, "activo");
  const pasivoCents = total(filas, "pasivo");
  const patrimonioCents = total(filas, "patrimonio");
  const resultadoCents =
    total(filas, "ingreso") - total(filas, "costo") - total(filas, "gasto");
  const diferenciaCents =
    activoCents - (pasivoCents + patrimonioCents + resultadoCents);

  return {
    activoCents,
    pasivoCents,
    patrimonioCents,
    resultadoCents,
    diferenciaCents,
    cuadra: diferenciaCents === 0,
  };
}

/** Los tramos de antigüedad de lo por cobrar (05 §5). */
export const TRAMOS = ["0-7", "8-30", "mas-de-30"] as const;
export type Tramo = (typeof TRAMOS)[number];

export const ETIQUETAS_TRAMO: Record<Tramo, string> = {
  "0-7": "Hasta 7 días",
  "8-30": "Entre 8 y 30 días",
  "mas-de-30": "Más de 30 días",
};

export function tramoDeAntiguedad(dias: number): Tramo {
  if (dias <= 7) return "0-7";
  if (dias <= 30) return "8-30";
  return "mas-de-30";
}

// ---------------------------------------------------------------------------
// Lo que falta por decidir
// ---------------------------------------------------------------------------

/**
 * Los huecos de la contabilidad, con nombre y dueño.
 *
 * Existe porque un `PENDIENTE` que solo vive en un documento no lo lee nadie, y
 * una pantalla que esconde lo que falta se ve completa y miente. Cada hueco
 * dice QUÉ falta, QUIÉN lo tiene que dar y QUÉ NO SE PUEDE hacer mientras
 * falte, en palabras que entienda quien no programa.
 *
 * Esto no es una lista de tareas del código: es lo que el sistema no puede
 * inventarse. Cada entrada cita de dónde sale.
 */
export interface Hueco {
  readonly clave: string;
  readonly que: string;
  readonly quien: string;
  readonly sinEsto: string;
  readonly fuente: string;
}

export const HUECOS: readonly Hueco[] = [
  {
    clave: "itbms",
    que: "Si los pañales, los wipes y los fulares llevan ITBMS, y a qué tasa cada uno.",
    quien: "La contadora.",
    sinEsto:
      "Un pedido no puede calcular impuesto. El sistema se niega a poner un cero en vez de adivinar, así que la cuenta «ITBMS por pagar» queda vacía y el día que aplique habrá que revisar lo cobrado antes.",
    fuente: "05-contabilidad §10",
  },
  {
    clave: "banco",
    que: "Cuál es el banco y qué cuentas reales tiene el negocio.",
    quien: "La dueña, con la contadora.",
    sinEsto:
      "La cuenta 1102 se sigue llamando «Banco (cuál: PENDIENTE)» en todos los informes, y las liquidaciones de las pasarelas no saben dónde depositan.",
    fuente: "05-contabilidad §2 y §10",
  },
  {
    clave: "comisiones",
    que: "Lo que cobra cada pasarela por un cobro: porcentaje, cargo fijo y si lleva ITBMS.",
    quien: "Sale de los contratos de Yappy, Tilopay y PayPal. Se pueden llenar de uno en uno.",
    sinEsto:
      "No se puede avisar de cuánto se va a quedar la pasarela antes de que llegue el depósito. La comisión de verdad sí se registra al liquidar, con la cifra del extracto.",
    fuente: "04-pagos §8 · ajustes.comisiones",
  },
  {
    clave: "fecha_arranque",
    que: "El día 1 del mes en que la contabilidad arranca de verdad.",
    quien: "La dueña.",
    sinEsto:
      "No hay asiento de apertura, y los meses anteriores a ese día no se pueden dar por cerrados. Además, esa fecha todavía no tiene dónde guardarse: no está entre las reglas con cifras del panel.",
    fuente: "05-contabilidad §7",
  },
  {
    clave: "costos_apertura",
    que: "Cuánto costó cada talla que hay hoy en bodega.",
    quien: "La contadora, con la última factura del proveedor.",
    sinEsto:
      "Las entregas se registran sin costo de lo vendido, así que la ganancia no se puede calcular y la pantalla no muestra margen en vez de mostrar uno falso.",
    fuente: "05-contabilidad §7 y §5",
  },
  {
    clave: "reconocimiento",
    que: "Si reconocer la venta al entregar le sirve, o prefiere otro criterio.",
    quien: "La contadora.",
    sinEsto:
      "Los asientos de entrega están escritos para el criterio de entrega. Cambiar de criterio cambia cuándo entra cada venta, así que es mejor saberlo antes del primer cierre.",
    fuente: "05-contabilidad §10",
  },
  {
    clave: "factura_fiscal",
    que: "Si Baby Caleb emite factura fiscal o electrónica, y con qué proveedor.",
    quien: "La contadora.",
    sinEsto:
      "El sistema solo entrega un comprobante de pedido con la marca y su QR, y no lo llama factura.",
    fuente: "05-contabilidad §10",
  },
  {
    clave: "pago_motorizado",
    que: "Cómo se le paga al motorizado por sus viajes.",
    quien: "La dueña.",
    sinEsto:
      "El pago se registra con el monto que una persona escriba. El sistema no lo calcula a partir de las paradas del día.",
    fuente: "02-datos §5 · motorizados.pago_regla_json",
  },
  {
    clave: "ingreso_envio",
    que: "Si el dinero que se cobra por el envío entra en la ganancia bruta o va en una línea aparte.",
    quien: "La contadora.",
    sinEsto:
      "Hoy va aparte: el plan no lo dice y meterlo en la ganancia bruta cambiaría el margen de todos los informes por una decisión que nadie tomó.",
    fuente: "05-contabilidad §5",
  },
  {
    clave: "cancelacion_con_abono",
    que: "Si un pedido cancelado con abono se reembolsa o le queda como crédito a la clienta.",
    quien: "La dueña.",
    sinEsto:
      "El sistema no propone nada y espera que usted lo decida caso por caso.",
    fuente: "02-datos §9 · ajustes.cancelacion_con_abono",
  },
  {
    clave: "devolucion_parcial",
    que: "A qué cuenta va la diferencia cuando lo que se le devuelve a la clienta no es el subtotal de lo que trajo (por ejemplo, si hubiera ITBMS).",
    quien: "La contadora.",
    sinEsto:
      "Esa devolución no se puede registrar: el sistema avisa en vez de cuadrar el asiento con una línea de relleno.",
    fuente: "05-contabilidad §3, asiento 13",
  },
];

export const huecoDe = (clave: string): Hueco | undefined =>
  HUECOS.find((h) => h.clave === clave);
