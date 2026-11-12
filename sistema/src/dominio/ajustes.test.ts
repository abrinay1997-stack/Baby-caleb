import { describe, expect, it } from "vitest";
import {
  CLAVES,
  ESQUEMAS,
  PASARELAS_CON_COMISION,
  PENDIENTE,
  esClave,
  esPendiente,
  validar,
  type Clave,
  type Comisiones,
  type Ventana,
} from "./ajustes";
import { IniciarPagoEntrada, MetodoDePago } from "../contrato/esquemas";
import reglas from "../../reglas.json";

/**
 * El esquema de los ajustes.
 *
 * Lo que de verdad se vigila aquí no son los límites: es que **nadie pueda
 * guardar un ajuste que el sistema no sepa interpretar**. Un `30` guardado sin
 * saber si son minutos u horas, una clave inventada que queda ahí con su
 * versión y su motivo sin que nada la lea, un `PENDIENTE` en la clave que se
 * copia a cada pedido en una columna `NOT NULL`: cada uno de esos es un fallo
 * que no da ningún error el día que se escribe y aparece semanas después.
 *
 * Cada prueba se comprobó rompiendo a propósito lo que dice vigilar. Las
 * mutaciones están anotadas donde no son obvias.
 */

/** Un valor claramente malo por cada tipo, para las pruebas de barrido. */
const UN_VALOR_MALO: Record<Clave, unknown> = {
  abono_minimo_cents: -1,
  stock_bajo: -1,
  ferguson_pago_total: "si",
  checkout_activo: 1,
  whatsapp_pedidos_activo: "si",
  // Un número con letras. No se usa un vacío porque el vacío tiene su propio
  // mensaje («déjelo sin decidir»), y así se barre el del formato.
  whatsapp_numero: "no-es-un-numero",
  pasarelas_activas: ["banco_nacional"],
  metodos_para_abono: ["cheque"],
  reserva_minutos_pago_en_linea: 0,
  reserva_horas_comprobante: 0,
  ventanas_entrega: [],
  comisiones: {},
  cancelacion_con_abono: "nada",
  modelo_asistente: "",
  modelo_respaldo: "modelo con espacios",
  ia_entrena_con_datos: "true",
  tope_ia_mensual_usd: 0,
};

const bien = (clave: string, valor: unknown): unknown => {
  const r = validar(clave, valor);
  if (!r.ok) throw new Error(`esperaba que pasara y falló: ${r.mensaje}`);
  return r.datos;
};

const mal = (clave: string, valor: unknown): string => {
  const r = validar(clave, valor);
  if (r.ok) throw new Error(`esperaba que fallara y pasó con ${JSON.stringify(r.datos)}`);
  return r.mensaje;
};

// ---------------------------------------------------------------------------

describe("el esquema y reglas.json", () => {
  /**
   * Las dos listas tienen que ser la misma.
   *
   * `reglas.json` es el valor de fábrica y este archivo es la interpretación.
   * Una clave en uno y no en el otro es un ajuste que o no se puede guardar
   * —porque `validar` no la conoce— o no tiene de dónde salir cuando nadie la
   * ha tocado. Mutación: quitando `stock_bajo` de ESQUEMAS, se cae.
   */
  it("cubre exactamente las claves de reglas.json", () => {
    const deFabrica = Object.keys(reglas).filter((k) => !k.startsWith("_"));
    expect([...CLAVES].sort()).toEqual(deFabrica.sort());
  });

  /**
   * Y los valores de fábrica tienen que pasar su propia validación.
   *
   * Es la prueba que impide que el esquema y `reglas.json` se separen en
   * silencio: si alguien aprieta un límite por debajo del valor de arranque, el
   * sistema arrancaría con un valor que él mismo rechaza al guardarlo.
   * Mutación: subiendo el `minimo` de `stock_bajo` a 6, se cae.
   */
  it("acepta todos los valores de fábrica", () => {
    for (const clave of CLAVES) {
      const r = validar(clave, (reglas as Record<string, unknown>)[clave]);
      expect(r.ok, `${clave}: ${r.ok ? "" : r.mensaje}`).toBe(true);
    }
  });

  it("las claves con PENDIENTE de fábrica son las que lo admiten", () => {
    const deFabrica = CLAVES.filter(
      (k) => (reglas as Record<string, unknown>)[k] === PENDIENTE,
    ).sort();
    const admiten = CLAVES.filter((k) => ESQUEMAS[k].admitePendiente).sort();
    expect(admiten).toEqual(deFabrica);
  });

  /**
   * Las listas de opciones son del contrato, no de aquí.
   *
   * `src/dominio/ajustes.ts` las escribe a mano para no arrastrar zod al
   * teléfono. Esta prueba es lo que impide que esa copia se separe del
   * original: es el mismo trato que `marca.ts` tiene con `brand.json`.
   */
  it("usa las pasarelas y los métodos del contrato", () => {
    expect([...PASARELAS_CON_COMISION]).toEqual([...IniciarPagoEntrada.shape.proveedor.options]);
    expect([...(ESQUEMAS.pasarelas_activas.opciones ?? [])]).toEqual([
      ...IniciarPagoEntrada.shape.proveedor.options,
    ]);
    expect([...(ESQUEMAS.metodos_para_abono.opciones ?? [])]).toEqual([...MetodoDePago.options]);
  });

  /**
   * Todo mensaje de rechazo lo va a leer la dueña en un teléfono.
   *
   * Barre las quince claves con un valor malo y comprueba que el motivo es una
   * frase en español y no un volcado: nada de `undefined`, nada de
   * `[object Object]`, y que nombre el ajuste del que habla. Mutación: poniendo
   * `e.titulo` como `` `${e.nombre}` `` (que no existe) en un mensaje, el
   * `undefined` lo caza esta prueba.
   */
  it("explica cada rechazo con palabras, no con un volcado", () => {
    const revisar = (clave: Clave, valor: unknown) => {
      const mensaje = mal(clave, valor);
      expect(mensaje, clave).not.toMatch(/undefined|\[object Object\]|NaN/);
      expect(mensaje.length, clave).toBeGreaterThan(20);
      expect(mensaje, clave).toMatch(/[.:]$/);
    };
    for (const clave of CLAVES) {
      revisar(clave, UN_VALOR_MALO[clave]);
      // Y el otro camino de rechazo: un PENDIENTE donde no se admite. Es un
      // mensaje distinto, y sin barrerlo también se queda sin vigilar.
      if (!ESQUEMAS[clave].admitePendiente) revisar(clave, PENDIENTE);
    }
  });
});

describe("una clave que no existe", () => {
  /**
   * Mutación: devolviendo `ok(valor)` para una clave desconocida, se cae. Es el
   * fallo que no da ningún error: la fila entra en `ajustes` con su versión y su
   * motivo y nadie la lee nunca.
   */
  it("se rechaza, y el motivo dice cuáles hay", () => {
    const mensaje = mal("abono_minimo", 500);
    expect(mensaje).toContain("abono_minimo_cents");
    expect(esClave("abono_minimo")).toBe(false);
  });

  it("no se cuela por parecerse a una de Object.prototype", () => {
    // `clave in ESQUEMAS` daría true para «toString» y «constructor». Por eso
    // `esClave` usa `Object.hasOwn`. Mutación: cambiándolo por `in`, se cae.
    expect(esClave("toString")).toBe(false);
    expect(esClave("constructor")).toBe(false);
    expect(validar("toString", 1).ok).toBe(false);
  });
});

describe("PENDIENTE", () => {
  it("vale en las claves que todavía nadie ha confirmado", () => {
    expect(bien("ventanas_entrega", PENDIENTE)).toBe(PENDIENTE);
    expect(bien("comisiones", PENDIENTE)).toBe(PENDIENTE);
    expect(bien("tope_ia_mensual_usd", PENDIENTE)).toBe(PENDIENTE);
  });

  /**
   * Mutación: devolviendo siempre `ok(PENDIENTE)` sin mirar
   * `admitePendiente`, se cae. Importa porque `pedidos.abono_minimo_cents` es
   * `NOT NULL`: un PENDIENTE ahí no se ve hasta que alguien intenta comprar.
   */
  it("no vale en las que el sistema usa todos los días", () => {
    expect(mal("abono_minimo_cents", PENDIENTE)).toContain("sin decidir");
    expect(mal("checkout_activo", PENDIENTE)).toContain("sin decidir");
    expect(mal("ia_entrena_con_datos", PENDIENTE)).toContain("sin decidir");
  });

  it("y no se confunde con cero, con nulo ni con una lista vacía", () => {
    expect(esPendiente(0)).toBe(false);
    expect(esPendiente(null)).toBe(false);
    expect(esPendiente([])).toBe(false);
    expect(esPendiente("pendiente")).toBe(false);
    expect(esPendiente(PENDIENTE)).toBe(true);
  });
});

describe("los números", () => {
  it("la reserva en línea son minutos enteros entre 5 y 1440", () => {
    expect(bien("reserva_minutos_pago_en_linea", 30)).toBe(30);
    expect(bien("reserva_minutos_pago_en_linea", 5)).toBe(5);
    expect(bien("reserva_minutos_pago_en_linea", 1440)).toBe(1440);
    // Mutación: quitando la comprobación del mínimo, el 4 pasa y esto se cae.
    expect(mal("reserva_minutos_pago_en_linea", 4)).toContain("minutos");
    expect(mal("reserva_minutos_pago_en_linea", 1441)).toContain("minutos");
    expect(mal("reserva_minutos_pago_en_linea", 30.5)).toContain("entero");
  });

  it("la del comprobante son horas, no minutos", () => {
    // Las dos claves hablan de lo mismo con unidades distintas: es justo el
    // caso que este archivo existe para que no se confunda. 2 vale como horas
    // y no valdría como minutos.
    expect(bien("reserva_horas_comprobante", 2)).toBe(2);
    expect(ESQUEMAS.reserva_horas_comprobante.unidad).toBe("horas");
    expect(ESQUEMAS.reserva_minutos_pago_en_linea.unidad).toBe("minutos");
    expect(mal("reserva_horas_comprobante", 0)).toContain("horas");
  });

  /**
   * «No puede ser negativo» y no «no puede ser menos de $0.00».
   *
   * Es el ejemplo que pidió el dueño del encargo, y no es cosmético: la frase
   * la lee ella sola en un teléfono. Mutación: quitando el caso `minimo === 0`,
   * el mensaje pasa a «no puede ser menos de $0.00» y esto se cae.
   */
  it("el abono mínimo no puede ser negativo, y lo dice así", () => {
    expect(bien("abono_minimo_cents", 0)).toBe(0);
    expect(bien("abono_minimo_cents", 500)).toBe(500);
    expect(mal("abono_minimo_cents", -1)).toBe("«El abono mínimo» no puede ser negativo.");
  });

  it("el dinero en centavos no admite decimales, y lo explica con un ejemplo", () => {
    const mensaje = mal("abono_minimo_cents", 12.5);
    expect(mensaje).toContain("centavos");
    expect(mensaje).toContain("$12.50");
  });

  /**
   * El tope del asistente está en DÓLARES, no en centavos.
   *
   * La clave se llama `tope_ia_mensual_usd` y la convención del plan es que los
   * centavos se marcan con `*_cents`. Leerla como centavos convertiría la
   * propuesta de «10» del plan en diez centavos sin que nada fallara: el
   * asistente se apagaría al primer mensaje del mes y nadie sabría por qué.
   * Mutación: pasando el tipo a `dinero_cents`, el 10 sigue pasando pero el
   * mensaje del tope deja de decir «$1000» y esto se cae.
   */
  it("el tope del asistente se escribe en dólares enteros", () => {
    expect(ESQUEMAS.tope_ia_mensual_usd.unidad).toBe("dólares");
    expect(bien("tope_ia_mensual_usd", 10)).toBe(10);
    expect(mal("tope_ia_mensual_usd", 1001)).toContain("$1000");
    expect(mal("tope_ia_mensual_usd", 10.5)).toContain("entero");
    expect(mal("tope_ia_mensual_usd", 0)).toContain("dólares");
  });

  it("el aviso de «quedan pocas» acepta cero, que significa no avisar nunca", () => {
    expect(bien("stock_bajo", 0)).toBe(0);
    expect(bien("stock_bajo", 5)).toBe(5);
    expect(mal("stock_bajo", -2)).toContain("negativo");
  });

  it("y nada que no sea un número entra como número", () => {
    expect(mal("stock_bajo", "5")).toContain("entero");
    expect(mal("stock_bajo", null)).toContain("entero");
    expect(mal("stock_bajo", Number.NaN)).toContain("entero");
    expect(mal("stock_bajo", Number.POSITIVE_INFINITY)).toContain("entero");
  });
});

describe("los interruptores", () => {
  it("solo aceptan encendido o apagado de verdad", () => {
    expect(bien("checkout_activo", false)).toBe(false);
    expect(bien("ferguson_pago_total", true)).toBe(true);
    // Mutación: aceptando `1` y `"true"` como verdadero, esto se cae. Un `"0"`
    // de un formulario es verdadero en JavaScript, y un interruptor de pagos
    // que se enciende al leer un `"0"` es el fallo que no se ve venir.
    expect(mal("checkout_activo", 1)).toContain("encendido");
    expect(mal("checkout_activo", "true")).toContain("encendido");
    expect(mal("checkout_activo", "0")).toContain("encendido");
  });
});

describe("las listas de opciones", () => {
  it("la lista vacía vale: es «todavía no encendí ninguna»", () => {
    expect(bien("pasarelas_activas", [])).toEqual([]);
  });

  it("rechaza lo que no es una pasarela y lo nombra", () => {
    const mensaje = mal("pasarelas_activas", ["yappy", "banco_nacional"]);
    expect(mensaje).toContain("banco_nacional");
    expect(mensaje).toContain("tilopay");
  });

  it("rechaza una repetida", () => {
    expect(mal("pasarelas_activas", ["yappy", "yappy"])).toContain("dos veces");
  });

  /**
   * El orden se normaliza al del contrato.
   *
   * Sin esto, arrastrar una fila en la pantalla dejaría una versión nueva en el
   * historial que no cambia nada del negocio, y el historial —que existe para
   * contestar «¿quién bajó la comisión en marzo?»— se llenaría de ruido.
   * Mutación: devolviendo `lista` tal cual, se cae.
   */
  it("guarda siempre en el mismo orden, para no inventar cambios", () => {
    expect(bien("pasarelas_activas", ["paypal", "yappy"])).toEqual(["yappy", "paypal"]);
    expect(bien("metodos_para_abono", ["manual", "yappy"])).toEqual(["yappy", "manual"]);
  });

  it("y no acepta algo que no sea una lista", () => {
    expect(mal("pasarelas_activas", "yappy")).toContain("lista");
    expect(mal("pasarelas_activas", { yappy: true })).toContain("lista");
  });
});

describe("la opción de qué hacer con un abono cancelado", () => {
  it("es reembolso o crédito, y nada más", () => {
    expect(bien("cancelacion_con_abono", "reembolso")).toBe("reembolso");
    expect(bien("cancelacion_con_abono", "credito")).toBe("credito");
    const mensaje = mal("cancelacion_con_abono", "lo que decida la dueña");
    expect(mensaje).toContain("reembolso");
    expect(mensaje).toContain("credito");
  });
});

describe("el nombre del modelo", () => {
  it("se guarda sin espacios al borde", () => {
    expect(bien("modelo_asistente", "  muse-spark-1.2-contributor ")).toBe(
      "muse-spark-1.2-contributor",
    );
  });

  /**
   * Mutación: aceptando cualquier cadena no vacía, esto se cae. Lo que va aquí
   * termina en una llamada al proveedor: un espacio de más vuelve con un error
   * del otro lado que no le dice nada a nadie, y el asistente se cae en
   * silencio hasta su respaldo.
   */
  it("no admite espacios ni comillas en medio", () => {
    expect(mal("modelo_asistente", "muse spark 1.2")).toContain("sin espacios");
    expect(mal("modelo_asistente", 'muse"spark')).toContain("sin espacios");
  });

  it("vacío no es lo mismo que sin decidir, y lo dice", () => {
    expect(mal("modelo_respaldo", "")).toContain("sin decidir");
    expect(mal("modelo_respaldo", "   ")).toContain("sin decidir");
    expect(bien("modelo_respaldo", PENDIENTE)).toBe(PENDIENTE);
  });
});

describe("las ventanas de entrega", () => {
  const manana = { id: "manana", etiqueta: "Mañana", desde: "08:00", hasta: "12:00" };
  const tarde = { id: "tarde", etiqueta: "Tarde", desde: "13:00", hasta: "18:00" };

  it("aceptan las dos franjas que nombra la migración", () => {
    expect(bien("ventanas_entrega", [manana, tarde])).toEqual([manana, tarde]);
  });

  /**
   * Una lista vacía NO es un PENDIENTE.
   *
   * Es el mismo error que confundir cero con «falta decidirlo», y aquí tiene
   * una consecuencia concreta: una lista vacía diría «decidí que no hay
   * ninguna franja en la que entregar», y el que la lea creerá que el dato está
   * resuelto. Mutación: aceptando `[]`, se cae.
   */
  it("una lista vacía se rechaza y se manda a dejarlo sin decidir", () => {
    expect(mal("ventanas_entrega", [])).toContain("sin decidir");
    expect(bien("ventanas_entrega", PENDIENTE)).toBe(PENDIENTE);
  });

  /**
   * El código va a `envios.ventana` y no puede llevar acentos ni mayúsculas.
   *
   * La migración lo dice con el ejemplo: `'manana' | 'tarde'`. Mutación:
   * dejando pasar cualquier texto no vacío como `id`, se cae — y en producción
   * quedaría un envío diciendo «Mañana » con un espacio invisible que no casa
   * con ninguna ventana.
   */
  it("el código es minúsculas sin acentos, y se explica por qué", () => {
    const mensaje = mal("ventanas_entrega", [{ ...manana, id: "Mañana" }]);
    expect(mensaje).toContain("minúsculas");
    expect(mensaje).toContain("envío");
    expect(mal("ventanas_entrega", [{ ...manana, id: "" }])).toContain("minúsculas");
    expect(mal("ventanas_entrega", [{ ...manana, id: "con espacio" }])).toContain("minúsculas");
  });

  it("dos ventanas no pueden llevar el mismo código", () => {
    expect(mal("ventanas_entrega", [manana, { ...tarde, id: "manana" }])).toContain("dos ventanas");
  });

  it("el nombre que lee la clienta no puede faltar", () => {
    expect(mal("ventanas_entrega", [{ ...manana, etiqueta: "  " }])).toContain("clienta");
  });

  /**
   * Mutación: cambiando `inicio >= fin` por `inicio > fin`, una ventana de
   * «12:00 a 12:00» pasa y esto se cae. Una ventana de duración cero no es una
   * franja: es una hora exacta a la que nadie puede comprometerse.
   */
  it("una ventana no puede terminar antes de empezar, ni durar cero", () => {
    expect(mal("ventanas_entrega", [{ ...manana, desde: "12:00", hasta: "08:00" }])).toContain(
      "antes de empezar",
    );
    expect(mal("ventanas_entrega", [{ ...manana, desde: "12:00", hasta: "12:00" }])).toContain(
      "antes de empezar",
    );
  });

  /**
   * Una cifra en la hora se acepta y se guarda con dos.
   *
   * Se acepta porque «9:00» es lo que sale de un teclado de teléfono, y se
   * normaliza porque la pantalla ordena por texto: sin normalizar, «9:00» se
   * ordenaría después de «13:00». Mutación: devolviendo `desde` tal cual, se
   * cae. Los minutos sí llevan dos cifras siempre — «13:5» no es una hora.
   */
  it("las horas se escriben como un reloj y se guardan con dos cifras", () => {
    const puestas = bien("ventanas_entrega", [{ ...manana, desde: "9:00" }]) as Ventana[];
    expect(puestas[0]?.desde).toBe("09:00");
    expect(mal("ventanas_entrega", [{ ...manana, hasta: "13:5" }])).toContain("Panamá");
    expect(mal("ventanas_entrega", [{ ...manana, desde: "25:00" }])).toContain("Panamá");
    expect(mal("ventanas_entrega", [{ ...manana, desde: "8" }])).toContain("Panamá");
    expect(mal("ventanas_entrega", [{ ...manana, desde: "08:60" }])).toContain("Panamá");
  });

  it("se guardan en el orden del día, no en el que llegaron", () => {
    const puestas = bien("ventanas_entrega", [tarde, manana]) as Ventana[];
    expect(puestas.map((v) => v.id)).toEqual(["manana", "tarde"]);
  });

  it("no acepta campos que el sistema no conoce", () => {
    // Un campo de más es casi siempre un dato que alguien cree que el sistema
    // guarda y que en realidad se tira. Mejor decirlo.
    expect(mal("ventanas_entrega", [{ ...manana, motorizado: "Luis" }])).toContain("motorizado");
  });

  it("y tampoco una franja que no sea un objeto", () => {
    expect(mal("ventanas_entrega", ["manana"])).toContain("completa");
    expect(mal("ventanas_entrega", { manana })).toContain("lista");
  });
});

describe("las comisiones", () => {
  const completa = { porcentaje_bp: 350, fijo_cents: 35, lleva_itbms: true };
  const tabla = (sobre: Record<string, unknown> = {}) => ({
    yappy: PENDIENTE,
    tilopay: PENDIENTE,
    paypal: PENDIENTE,
    ...sobre,
  });

  it("la tabla entera puede estar sin decidir", () => {
    expect(bien("comisiones", PENDIENTE)).toBe(PENDIENTE);
  });

  /**
   * Cada pasarela puede faltar sola, y esa es la razón de la forma.
   *
   * La fuente es «los contratos de cada pasarela» (02-datos §9) y llegan de uno
   * en uno. Si la única manera de escribir el de Yappy fuera llenar las tres,
   * alguien inventaría las otras dos — que es exactamente lo que la regla
   * «ninguna cifra a ojo» prohíbe.
   */
  it("se puede llenar una y dejar las otras dos sin decidir", () => {
    const puesta = bien("comisiones", tabla({ yappy: completa })) as Comisiones;
    expect(puesta.yappy).toEqual(completa);
    expect(puesta.tilopay).toBe(PENDIENTE);
    expect(puesta.paypal).toBe(PENDIENTE);
  });

  /**
   * Mutación: dejando pasar un objeto al que le falta una pasarela, se cae. Una
   * fila que desaparece de la pantalla es una que nadie vuelve a buscar, y el
   * contrato que falta se queda sin pedir para siempre.
   */
  it("las tres filas están siempre, aunque dos estén en blanco", () => {
    const mensaje = mal("comisiones", { yappy: completa });
    expect(mensaje).toContain("tilopay");
    // Y el motivo dice qué hacer: dejarla SIN DECIDIR, no quitarla. Sin esta
    // línea la prueba pasaba igual con la comprobación quitada, porque el
    // mensaje genérico de «no está completa» también nombra la pasarela.
    expect(mensaje).toContain("sin decidir");
    expect(mal("comisiones", {})).toContain("yappy");
  });

  it("no acepta una pasarela que no cobre comisión estimable", () => {
    // `manual` no está a propósito: su comisión se toma del extracto del banco
    // (04-pagos §8), o sea que se conoce después y no se estima.
    expect(mal("comisiones", tabla({ manual: completa }))).toContain("manual");
  });

  it("el porcentaje va en puntos básicos y lo dice con un ejemplo", () => {
    const mensaje = mal("comisiones", tabla({ yappy: { ...completa, porcentaje_bp: 10_001 } }));
    expect(mensaje).toContain("3.5 %");
    expect(mal("comisiones", tabla({ yappy: { ...completa, porcentaje_bp: -1 } }))).toContain(
      "puntos básicos",
    );
    expect(mal("comisiones", tabla({ yappy: { ...completa, porcentaje_bp: 3.5 } }))).toContain(
      "puntos básicos",
    );
  });

  /**
   * El fijo en centavos, con techo.
   *
   * Mutación: quitando el techo de 10000, un «35» escrito pensando en dólares
   * —$35 por transacción— pasa sin decir nada y cada cobro queda con una
   * comisión estimada cien veces más grande. El techo no decide nada del
   * negocio: ninguna pasarela cobra un fijo de más de $100.
   */
  it("el cargo fijo va en centavos, con una baranda contra el dedo gordo", () => {
    expect(mal("comisiones", tabla({ paypal: { ...completa, fijo_cents: 10_001 } }))).toContain(
      "$0.35",
    );
    expect(mal("comisiones", tabla({ paypal: { ...completa, fijo_cents: -1 } }))).toContain(
      "centavos",
    );
  });

  it("hay que decir si lleva ITBMS: no se supone", () => {
    const { lleva_itbms: _, ...sinItbms } = completa;
    expect(mal("comisiones", tabla({ tilopay: sinItbms }))).toContain("ITBMS");
    expect(mal("comisiones", tabla({ tilopay: { ...completa, lleva_itbms: "si" } }))).toContain(
      "ITBMS",
    );
  });

  it("no acepta campos que el sistema no conoce", () => {
    expect(mal("comisiones", tabla({ yappy: { ...completa, moneda: "USD" } }))).toContain("moneda");
  });

  it("ni una tabla que no sea un objeto", () => {
    expect(mal("comisiones", [completa])).toContain("pasarela");
    expect(mal("comisiones", 350)).toContain("pasarela");
  });
});

describe("el celular de los pedidos", () => {
  /**
   * El valor acaba en una URL `wa.me/<numero>`, así que se guarda tal como lo
   * quiere WhatsApp: solo cifras, sin el `+`.
   *
   * Se NORMALIZA en vez de rechazar los adornos porque lo que la dueña va a
   * pegar es lo que su propio teléfono le enseña: «+507 6757-5065». Devolverle
   * un error por escribir bien un número sería culparla de acertar.
   */
  it("acepta el número como lo pega del teléfono, y lo guarda limpio", () => {
    for (const escrito of ["50767575065", "+50767575065", "+507 6757-5065", " 507 6757 5065 "]) {
      expect(bien("whatsapp_numero", escrito), escrito).toBe("50767575065");
    }
  });

  it("rechaza lo que no es un número, diciendo qué se esperaba", () => {
    for (const malo of ["", "   ", "6757-5065 (el de la casa)", "llámame", "507675750650000000"]) {
      expect(mal("whatsapp_numero", malo).length, malo).toBeGreaterThan(20);
    }
  });

  it("no exige que sea de Panamá", () => {
    // Rechazar un número de otro país sería inventarle la regla a la dueña: el
    // día que venda fuera, el celular del negocio puede no empezar por 507.
    expect(bien("whatsapp_numero", "+1 305 555 0123")).toBe("13055550123");
  });

  it("y no se puede dejar sin decidir, porque el número ya se sabe", () => {
    // Para dejar de recibir pedidos por WhatsApp está su propio interruptor.
    // Dos formas de decir lo mismo acaban diciendo cosas distintas.
    expect(mal("whatsapp_numero", PENDIENTE)).toContain("sin decidir");
  });
});
