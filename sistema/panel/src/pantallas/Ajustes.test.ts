import { describe, expect, it } from "vitest";
import {
  borradorDe,
  comoSeLee,
  valorDelBorrador,
  type AjusteVigente,
  type Borrador,
} from "./Ajustes";
import { CLAVES, PENDIENTE, type Clave } from "../../../src/dominio/ajustes";
import { validar } from "../../../src/dominio/ajustes";

/**
 * Lo que la hoja de ajustes convierte: valor guardado → campos → valor nuevo.
 *
 * Es la única parte de la pantalla con aritmética, y es donde dolería un fallo:
 * el dinero se LEE en dólares y se GUARDA en centavos, y el porcentaje se lee
 * en por ciento y se guarda en puntos básicos. Un `Number()` donde va
 * `aCentavos` convierte $5.00 en cinco centavos sin que nada falle.
 *
 * La prueba que importa es la de ida y vuelta: abrir un ajuste y guardarlo sin
 * tocar nada tiene que dar EXACTAMENTE lo mismo. Si no, el solo hecho de abrir
 * la hoja y pulsar Guardar cambiaría la cifra del negocio.
 */

const vigente = (clave: Clave, valor: unknown): AjusteVigente => ({
  clave,
  valor,
  pendiente: valor === PENDIENTE,
  origen: "fabrica",
  version: null,
  vigente_desde: null,
  cambiado_por: null,
  motivo: null,
  aviso: null,
});

const ventanas = [
  { id: "manana", etiqueta: "Mañana", desde: "08:00", hasta: "12:00" },
  { id: "tarde", etiqueta: "Tarde", desde: "13:00", hasta: "18:00" },
];

const comisiones = {
  yappy: { porcentaje_bp: 350, fijo_cents: 35, lleva_itbms: true },
  tilopay: PENDIENTE,
  paypal: PENDIENTE,
};

/** Un valor plausible por clave, para barrer las quince. */
const UN_VALOR: Record<Clave, unknown> = {
  abono_minimo_cents: 500,
  stock_bajo: 5,
  ferguson_pago_total: true,
  checkout_activo: false,
  pasarelas_activas: ["yappy"],
  metodos_para_abono: ["yappy", "manual"],
  reserva_minutos_pago_en_linea: 30,
  reserva_horas_comprobante: 2,
  ventanas_entrega: ventanas,
  comisiones,
  cancelacion_con_abono: "credito",
  modelo_asistente: "muse-spark-1.2-contributor",
  modelo_respaldo: "muse-spark-1.3",
  ia_entrena_con_datos: true,
  tope_ia_mensual_usd: 10,
};

const ida = (clave: Clave, valor: unknown): unknown => {
  const salida = valorDelBorrador(clave, borradorDe(vigente(clave, valor)));
  if ("error" in salida) throw new Error(`${clave}: ${salida.error}`);
  return salida.valor;
};

describe("abrir la hoja y guardar sin tocar nada", () => {
  /**
   * Las quince claves, de ida y vuelta.
   *
   * Mutación: cambiando `deCentavos(v)` por `String(v)` al cargar el borrador,
   * `abono_minimo_cents` sale 50000 en vez de 500 y esto se cae — y en
   * producción el abono mínimo pasaría de $5 a $500 con solo abrir la hoja.
   */
  it("no cambia ni una cifra", () => {
    for (const clave of CLAVES) {
      expect(ida(clave, UN_VALOR[clave]), clave).toEqual(UN_VALOR[clave]);
    }
  });

  /**
   * Y lo que sale pasa la validación del servidor.
   *
   * Es el mismo módulo que usa la API, así que esto comprueba que la pantalla
   * no puede construir un valor que el servidor va a rechazar por su forma.
   */
  it("y lo que manda es algo que el servidor acepta", () => {
    for (const clave of CLAVES) {
      const r = validar(clave, ida(clave, UN_VALOR[clave]));
      expect(r.ok, `${clave}: ${r.ok ? "" : r.mensaje}`).toBe(true);
    }
  });

  it("también cuando lo que hay es un PENDIENTE", () => {
    for (const clave of CLAVES) {
      expect(ida(clave, PENDIENTE), clave).toBe(PENDIENTE);
    }
  });
});

describe("el dinero y el porcentaje", () => {
  /**
   * Mutación: usando `Number(b.texto)` en vez de `aCentavos`, «1.15» da 1.15 en
   * vez de 115 y esto se cae. Es el fallo de `1.15 * 100 = 114.99…` con otra
   * cara, y el que hace que `panel/src/dinero.ts` exista.
   */
  it("se escribe en dólares y se guarda en centavos", () => {
    const b = { ...borradorDe(vigente("abono_minimo_cents", 500)), texto: "1.15" };
    expect(valorDelBorrador("abono_minimo_cents", b)).toEqual({ valor: 115 });
  });

  it("acepta la coma decimal, que es lo normal en Panamá", () => {
    const b = { ...borradorDe(vigente("abono_minimo_cents", 500)), texto: "7,50" };
    expect(valorDelBorrador("abono_minimo_cents", b)).toEqual({ valor: 750 });
  });

  it("un monto que no se entiende se dice, no se adivina", () => {
    const b = { ...borradorDe(vigente("abono_minimo_cents", 500)), texto: "cinco" };
    const r = valorDelBorrador("abono_minimo_cents", b);
    expect("error" in r && r.error).toContain("12.50");
  });

  it("el porcentaje de una comisión se escribe en por ciento y se guarda en puntos básicos", () => {
    const b = borradorDe(vigente("comisiones", comisiones));
    expect(b.comisiones["yappy"]).toEqual({
      sinDecidir: false,
      porcentaje: "3.5",
      fijo: "0.35",
      itbms: true,
    });
    expect(valorDelBorrador("comisiones", b)).toEqual({ valor: comisiones });
  });

  it("y una comisión mal escrita se dice con la pasarela por su nombre", () => {
    const b = borradorDe(vigente("comisiones", comisiones));
    b.comisiones["tilopay"] = { sinDecidir: false, porcentaje: "x", fijo: "0", itbms: false };
    const r = valorDelBorrador("comisiones", b);
    expect("error" in r && r.error).toContain("Tilopay");
  });
});

describe("los enteros", () => {
  /**
   * Mutación: aceptando `Number(limpio)` sin comprobar la forma, «30.5» pasa
   * como 30.5 y esto se cae; el servidor lo rechazaría igual, pero el motivo
   * llegaría después de un viaje de red y con la hoja ya cerrándose.
   */
  it("no se cuelan decimales ni texto", () => {
    const b = borradorDe(vigente("reserva_minutos_pago_en_linea", 30));
    for (const texto of ["30.5", "treinta", "", "-5", "3 0"]) {
      const r = valorDelBorrador("reserva_minutos_pago_en_linea", { ...b, texto });
      expect("error" in r, texto).toBe(true);
      if ("error" in r) expect(r.error).toContain("minutos");
    }
  });
});

describe("una lista vacía", () => {
  /**
   * Vacía es una decisión; PENDIENTE es no haberla tomado. Mutación:
   * devolviendo PENDIENTE cuando la lista está vacía, se cae — y apagar todas
   * las pasarelas pasaría a leerse como «falta decidirlo», que es lo contrario
   * de lo que ella hizo.
   */
  it("se guarda como lista vacía y no como un PENDIENTE", () => {
    const b: Borrador = { ...borradorDe(vigente("pasarelas_activas", ["yappy"])), lista: [] };
    expect(valorDelBorrador("pasarelas_activas", b)).toEqual({ valor: [] });
  });
});

describe("cómo se lee cada valor en la lista", () => {
  it("lo que falta decidir lo dice con palabras", () => {
    expect(comoSeLee("comisiones", PENDIENTE)).toBe("Falta decidirlo");
  });

  /**
   * Cero y «falta decidirlo» NO se leen igual.
   *
   * Es el pedido explícito del encargo. Mutación: devolviendo «Falta
   * decidirlo» para un valor falso o cero, se cae — y la dueña vería «falta
   * decidirlo» en una regla que ella misma puso en cero.
   */
  it("un cero y un apagado se leen como lo que son", () => {
    expect(comoSeLee("abono_minimo_cents", 0)).toBe("$0.00");
    expect(comoSeLee("stock_bajo", 0)).toBe("0 cajas");
    expect(comoSeLee("checkout_activo", false)).toBe("Apagado");
    expect(comoSeLee("pasarelas_activas", [])).toBe("Ninguno");
  });

  it("el dinero con sus dos decimales", () => {
    expect(comoSeLee("abono_minimo_cents", 500)).toBe("$5.00");
    expect(comoSeLee("abono_minimo_cents", 1005)).toBe("$10.05");
    expect(comoSeLee("tope_ia_mensual_usd", 10)).toBe("$10 al mes");
  });

  it("las opciones por su nombre, no por el técnico", () => {
    expect(comoSeLee("cancelacion_con_abono", "credito")).toContain("crédito");
    expect(comoSeLee("metodos_para_abono", ["yappy", "manual"])).toContain("Yappy");
  });

  it("las ventanas con su horario", () => {
    expect(comoSeLee("ventanas_entrega", ventanas)).toBe("Mañana 08:00–12:00 · Tarde 13:00–18:00");
  });

  it("y las comisiones diciendo cuál falta", () => {
    const leido = comoSeLee("comisiones", comisiones);
    expect(leido).toContain("Yappy 3.5 % + $0.35");
    expect(leido).toContain("PayPal: falta");
  });
});
