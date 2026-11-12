import { fallo, ok, type Resultado } from "../contrato/resultado";

/**
 * Qué es cada ajuste del negocio: su tipo, su unidad, sus límites y qué
 * significa.
 *
 * ## Por qué existe este archivo
 *
 * Las cifras del negocio viven en la tabla `ajustes` como texto JSON. Un texto
 * JSON no dice si `30` son minutos o horas, ni si `500` son centavos o
 * dólares. Hasta ahora cada sitio que usaba un ajuste lo interpretaba por su
 * cuenta, y así es exactamente como un número acaba significando minutos en un
 * archivo y horas en otro: nadie se equivoca, simplemente nadie lo dijo nunca
 * en un solo sitio.
 *
 * Esto es ese sitio. Lo leen **la API** —para no guardar basura— y **la
 * pantalla** —para saber qué campo dibujar y qué unidad escribir al lado—. Dos
 * copias de esta tabla acabarían discrepando, y la que se equivoca es la que
 * nadie revisa.
 *
 * ## Los límites NO son cifras del negocio
 *
 * `minimo` y `maximo` son barandas contra el dedo gordo, no decisiones de la
 * dueña. El valor lo decide ella; esto solo impide que un cero de más entre sin
 * que nadie se dé cuenta. Por eso cada límite lleva escrito al lado por qué es
 * ese y no otro, y por eso ninguno rellena un `PENDIENTE`: una clave sin
 * decidir vale literalmente `"PENDIENTE"` y la pantalla dice que falta.
 *
 * ## `PENDIENTE` no es cero
 *
 * `reglas.json` trae siete claves en `"PENDIENTE"`: son las que nadie ha
 * confirmado todavía. `admitePendiente` dice cuáles pueden quedarse así. Las
 * otras tienen un valor de fábrica con fuente citada (docs/plan/02-datos.md §9)
 * y dejarlas sin decidir rompería algo: `abono_minimo_cents`, por ejemplo, se
 * copia a cada pedido en una columna `NOT NULL`.
 */

// ---------------------------------------------------------------------------
// Lo que vale una clave sin decidir
// ---------------------------------------------------------------------------

export const PENDIENTE = "PENDIENTE";
export type Pendiente = typeof PENDIENTE;

/**
 * `"PENDIENTE"` es un valor, no la ausencia de uno.
 *
 * Se distingue de `null` y de `0` a propósito: «falta decidirlo» y «es cero»
 * son dos cosas distintas, y confundirlas hace que alguien crea que un dato ya
 * está resuelto. El sistema no rellena un PENDIENTE: lo que dependa de él no
 * se enciende.
 */
export const esPendiente = (v: unknown): v is Pendiente => v === PENDIENTE;

// ---------------------------------------------------------------------------
// Las dos estructuras
// ---------------------------------------------------------------------------

/**
 * Una franja del día en la que se entrega.
 *
 * **Por qué esta forma.** `envios.ventana` es una columna de texto cuyo
 * comentario en la migración dice `'manana' | 'tarde' (ajustes de la dueña)`:
 * o sea, lo que se guarda en cada envío es el CÓDIGO de la ventana. De ahí
 * salen los cuatro campos y, sobre todo, que `id` y `etiqueta` sean cosas
 * distintas:
 *
 *  - `id` es lo que queda escrito en los envíos. Es minúsculas sin acentos
 *    (`manana`, no `mañana`) y **no cambia nunca**: el día que la dueña
 *    renombre «Mañana» a «Antes del mediodía», los envíos que ya dicen
 *    `manana` tienen que seguir significando algo.
 *  - `etiqueta` es lo que lee la clienta, y se puede cambiar cuando quiera.
 *
 * **Por qué `HH:MM` y no milisegundos.** Una ventana es una hora del día que se
 * repite todos los días, no un instante. Guardarla como marca de tiempo
 * obligaría a elegir un día cualquiera y a arrastrar ese día para siempre. La
 * hora es la de Panamá, que es la del negocio (UTC−5 sin horario de verano,
 * docs/plan/02-datos.md §1), así que no hace falta zona horaria.
 *
 * **Qué NO se valida y por qué.** Que dos ventanas no se solapen. Decidir si
 * «Tarde» empieza cuando termina «Mañana» o si hay una franja de «todo el día»
 * que las cubre es una decisión de la dueña sobre cómo reparte sus entregas, y
 * rechazarla sería inventarle la regla. Sí se valida que una ventana no termine
 * antes de empezar: eso no es una decisión, es una resta.
 */
export interface Ventana {
  /** Minúsculas, sin acentos. Queda escrito en `envios.ventana`; no cambia. */
  readonly id: string;
  /** Lo que lee la clienta. Se puede cambiar sin romper nada. */
  readonly etiqueta: string;
  /** `HH:MM`, hora de Panamá. */
  readonly desde: string;
  /** `HH:MM`, hora de Panamá. Siempre después de `desde`. */
  readonly hasta: string;
}

/**
 * Las pasarelas que cobran comisión estimable.
 *
 * `manual` no está, y no es un olvido: la comisión de Yappy Comercial «se toma
 * del extracto» (docs/plan/04-pagos.md §8), o sea que se conoce después y no se
 * estima. Estimar una comisión para el efectivo o una transferencia sería
 * inventar un gasto.
 *
 * Son las mismas tres que acepta `IniciarPagoEntrada.proveedor` en
 * `src/contrato/esquemas.ts`. Se escriben aquí a mano en vez de importarlas
 * porque este módulo lo carga también el panel y no debe arrastrar zod al
 * teléfono; hay una prueba en `ajustes.test.ts` que falla si las dos listas se
 * separan.
 */
export const PASARELAS_CON_COMISION = ["yappy", "tilopay", "paypal"] as const;

export type PasarelaConComision = (typeof PASARELAS_CON_COMISION)[number];

/**
 * Lo que cobra una pasarela por un cobro.
 *
 * Los tres campos son los tres que nombra docs/plan/04-pagos.md §8:
 * «porcentaje, fijo y si lleva ITBMS».
 *
 * El porcentaje va en **puntos básicos** (350 = 3.5 %) por lo mismo que
 * `tasa_itbms_bp`: 3.5 % de un monto en centavos tiene que salir exacto, y
 * `0.035` no es un número exacto en coma flotante. El fijo va en centavos, como
 * todo el dinero del sistema.
 */
export interface Comision {
  /** Puntos básicos. 350 = 3.5 %. */
  readonly porcentaje_bp: number;
  /** Centavos. El cargo fijo por transacción. */
  readonly fijo_cents: number;
  /** Si la comisión lleva ITBMS encima. */
  readonly lleva_itbms: boolean;
}

/**
 * La tabla de comisiones: una por pasarela, **y cada una puede faltar sola**.
 *
 * Esto es lo que decide la forma. La fuente de este dato es «los contratos de
 * cada pasarela» (02-datos §9), y esos contratos llegan de uno en uno: el día
 * que llegue el de Yappy se puede escribir el de Yappy sin tener que inventar
 * los otros dos. Un solo `"PENDIENTE"` para las tres obligaría a esperar a
 * tenerlas todas, o a rellenar dos con cifras falsas.
 *
 * Las tres claves están siempre presentes: así la pantalla enseña tres filas y
 * se ve cuál contrato falta, en vez de que la fila desaparezca y nadie la
 * busque. El ajuste entero puede valer `"PENDIENTE"` porque es su valor de
 * fábrica, y significa lo mismo que las tres en PENDIENTE.
 */
export type Comisiones = { readonly [P in PasarelaConComision]: Comision | Pendiente };

// ---------------------------------------------------------------------------
// El esquema
// ---------------------------------------------------------------------------

export type Tipo =
  | "entero"
  | "dinero_cents"
  | "dinero_usd"
  | "booleano"
  | "texto"
  | "opcion"
  | "lista_de_opciones"
  | "ventanas"
  | "comisiones";

export type Valor =
  | number
  | boolean
  | string
  | readonly string[]
  | readonly Ventana[]
  | Comisiones
  | Pendiente;

export interface Esquema {
  readonly tipo: Tipo;
  /** Cómo se llama esto para la dueña. No es la clave con guiones quitados. */
  readonly titulo: string;
  /** Qué significa y qué depende de él. Se lee en la pantalla. */
  readonly explica: string;
  /** Para escribirla al lado del número: «minutos», «cajas», «dólares». */
  readonly unidad?: string;
  /** Si puede quedarse en `"PENDIENTE"`. */
  readonly admitePendiente: boolean;
  readonly minimo?: number;
  readonly maximo?: number;
  readonly opciones?: readonly string[];
}

/**
 * Las quince claves de `reglas.json`, una por una.
 *
 * El orden es el de la pantalla: primero lo del dinero de un pedido, luego lo
 * de la web, luego las entregas y al final el asistente. No es el alfabético
 * —que es el que usaba la pantalla vieja— porque alfabético pone
 * `abono_minimo_cents` al lado de `cancelacion_con_abono` y separa las dos
 * reservas, que son la misma decisión contada dos veces.
 */
export const ESQUEMAS = {
  abono_minimo_cents: {
    tipo: "dinero_cents",
    titulo: "El abono mínimo",
    explica:
      "Lo menos que una clienta tiene que abonar para que su pedido se agende. Se copia al pedido cuando se crea, así que subirlo mañana no cambia las reglas de un pedido de hoy.",
    admitePendiente: false,
    minimo: 0,
    // Cero es válido: significa «se agenda sin abonar». El techo es una
    // baranda contra escribir los centavos como si fueran dólares —$100 de
    // abono mínimo en un negocio de pañales es un dedo gordo, no una decisión.
    maximo: 10_000,
  },

  stock_bajo: {
    tipo: "entero",
    titulo: "Cuándo avisar de que quedan pocas",
    explica:
      "Por debajo de esta cantidad de cajas libres, la web y el bot dicen «quedan pocas» en vez de «disponible». La cantidad exacta nunca sale hacia afuera.",
    unidad: "cajas",
    admitePendiente: false,
    // Cero es válido y significa «no avisar nunca»: la etiqueta solo cambia
    // cuando llega a agotado. El techo es una baranda: un umbral mayor que
    // cualquier existencia posible dejaría todo el catálogo en «quedan pocas».
    minimo: 0,
    maximo: 10_000,
  },

  ferguson_pago_total: {
    tipo: "booleano",
    titulo: "Los envíos al interior se pagan completos",
    explica:
      "Encendido, un pedido que va por Ferguson no se agenda con abono: hace falta el pago completo antes de despacharlo.",
    admitePendiente: false,
  },

  /**
   * **Este interruptor hoy no hace nada, y la pantalla lo dice.**
   *
   * Durante meses su texto prometía que apagarlo quitaba el cobro de la web.
   * No era verdad en ninguna de las dos direcciones: ningún código lo
   * consultaba, así que encendido o apagado el carrito terminaba igual, en un
   * mensaje de WhatsApp. Un ajuste que dice controlar algo que no controla es
   * peor que no tener el ajuste (docs/TRAMPAS.md §13).
   *
   * Lo que de verdad decide si se puede cobrar en la web vive en
   * `src/dominio/checkout.ts`, que cruza este interruptor con las pasarelas que
   * están en condiciones de cobrar. Hoy son cero —tres pasarelas, ninguna
   * credencial— así que la respuesta es «no» con el interruptor encendido, y
   * eso es lo que se lee en Ajustes.
   *
   * El `explica` de abajo dice lo que el interruptor hace HOY. Cuando una
   * pasarela esté lista, lo que cambia no es este texto: cambia la respuesta
   * de `estadoDelCheckout`, que se calcula de los datos.
   */
  checkout_activo: {
    tipo: "booleano",
    titulo: "Pagar desde la web",
    explica:
      "La intención de la dueña: si quiere que la web cobre cuando pueda cobrar. Por sí solo no enciende nada — hace falta además una pasarela con sus credenciales puestas y encendida. La pantalla dice si está haciendo efecto o no, y qué falta.",
    admitePendiente: false,
  },

  /**
   * Cuántos días vale una cotización.
   *
   * Nace en `PENDIENTE` y se queda ahí hasta que la dueña lo diga: nadie ha
   * confirmado cuánto tiempo Baby Caleb mantiene un precio por escrito, y
   * «siete días porque suena razonable» es una cifra a ojo con aspecto de
   * política comercial. Mientras esté sin decidir, una cotización se crea SIN
   * fecha de caducidad —`vence_en` en nulo— y no se cancela sola.
   *
   * Que no caduque es el lado seguro: una cotización vencida no se puede
   * confirmar, así que un número inventado de menos dejaría a la clienta con
   * un papel que el sistema rechaza.
   */
  cotizacion_dias_validez: {
    tipo: "entero",
    titulo: "Cuántos días vale una cotización",
    explica:
      "Pasados esos días, la cotización caduca y hay que hacer una nueva con los precios de ese momento. Una cotización no aparta mercancía, así que caducar no libera nada. Sin decidir, no caduca nunca.",
    unidad: "días",
    admitePendiente: true,
    // Piso 1: menos de un día no es una cotización, es un precio dicho de
    // palabra. Techo 365: más allá de un año el precio con el que se hizo ya
    // no existe, y sostenerlo por escrito es una promesa que nadie quiere.
    minimo: 1,
    maximo: 365,
  },

  pasarelas_activas: {
    tipo: "lista_de_opciones",
    titulo: "Pasarelas encendidas",
    explica:
      "Las que se le ofrecen a la clienta al pagar. Una pasarela entra aquí solo después de un cobro real de prueba y su reembolso; apagarla la quita del checkout al instante.",
    admitePendiente: false,
    opciones: PASARELAS_CON_COMISION,
  },

  metodos_para_abono: {
    tipo: "lista_de_opciones",
    titulo: "Con qué se puede abonar",
    explica:
      "Los métodos que aceptan un pago parcial. Los demás solo aceptan el total. Tarjeta y PayPal cobran un fijo que se come casi todo un abono pequeño.",
    admitePendiente: false,
    // La lista entera de `MetodoDePago` del contrato, incluido `efectivo`.
    opciones: ["yappy", "tilopay", "paypal", "manual", "efectivo"],
  },

  reserva_minutos_pago_en_linea: {
    tipo: "entero",
    titulo: "Cuánto se aparta un pedido mientras la clienta paga en línea",
    explica:
      "Pasado ese rato sin pagar, el pedido se cancela y las cajas vuelven a estar a la venta. Mientras tanto nadie más puede comprarlas.",
    unidad: "minutos",
    admitePendiente: true,
    // Piso 5: el cron que libera reservas corre cada 15 minutos
    // (docs/plan/04-pagos.md §5), así que por debajo de unos pocos minutos el
    // número deja de describir lo que pasa. Techo 1440: un día. Más que eso no
    // es apartar un pedido, es quitarlo del inventario.
    minimo: 5,
    maximo: 1440,
  },

  reserva_horas_comprobante: {
    tipo: "entero",
    titulo: "Cuánto se aparta un pedido que paga con comprobante",
    explica:
      "Lo mismo, pero cuando la clienta eligió pagar por Yappy Comercial o transferencia y tiene que mandar el comprobante. Confirmarlo lo hace siempre una persona.",
    unidad: "horas",
    admitePendiente: true,
    // Piso 1 hora: menos que eso no da tiempo a mandar un comprobante y que
    // alguien lo mire. Techo 168: una semana.
    minimo: 1,
    maximo: 168,
  },

  ventanas_entrega: {
    tipo: "ventanas",
    titulo: "Las ventanas de entrega",
    explica:
      "Las franjas del día que se le ofrecen a la clienta al agendar. El código de cada una queda escrito en los envíos, así que no cambia; el nombre sí se puede cambiar cuando quiera.",
    admitePendiente: true,
  },

  comisiones: {
    tipo: "comisiones",
    titulo: "Las comisiones de cada pasarela",
    explica:
      "Lo que cobra cada pasarela por un cobro. Sirve para estimar la comisión al aprobar un pago; la real se ajusta cuando llega el depósito. Cada una sale de su contrato, y se pueden llenar de una en una.",
    admitePendiente: true,
  },

  cancelacion_con_abono: {
    tipo: "opcion",
    titulo: "Si se cancela un pedido ya abonado",
    explica:
      "Qué pasa con el dinero que la clienta ya puso: se le devuelve, o le queda como crédito para otro pedido. Usted confirma cada caso igual; esto es lo que el sistema propone.",
    admitePendiente: true,
    opciones: ["reembolso", "credito"],
  },

  modelo_asistente: {
    tipo: "texto",
    titulo: "El modelo del asistente",
    explica:
      "Qué modelo de IA contesta en la consola. Cambiarlo aquí no exige volver a desplegar nada.",
    admitePendiente: false,
  },

  modelo_respaldo: {
    tipo: "texto",
    titulo: "El modelo de respaldo",
    explica:
      "Al que se recurre si el principal falla dos veces seguidas. Sin respaldo, el asistente dice que no puede contestar ahora — que es mejor que contestar mal.",
    admitePendiente: true,
  },

  ia_entrena_con_datos: {
    tipo: "booleano",
    titulo: "El proveedor del modelo entrena con nuestros datos",
    explica:
      "Encendido, ningún celular, correo ni nombre de clienta sale hacia el modelo: las herramientas le devuelven una referencia en su lugar. Las cifras del negocio sí van.",
    admitePendiente: false,
  },

  tope_ia_mensual_usd: {
    tipo: "dinero_usd",
    titulo: "Tope de gasto del asistente al mes",
    explica:
      "Cuando el gasto del mes llega aquí, el asistente deja de contestar. Es la red por si una llave se filtra o algo entra en bucle.",
    unidad: "dólares",
    admitePendiente: true,
    // En dólares enteros y NO en centavos, aunque todo el dinero del sistema
    // vaya en centavos: la clave se llama `_usd`, y la convención del plan es
    // que los centavos se marcan con `*_cents` (02-datos §1). Leerla como
    // centavos convertiría la propuesta de «10» del plan en diez centavos sin
    // que nada fallara. Un tope mensual con precisión de centavo no significa
    // nada, así que no se pierde nada.
    //
    // Piso 1: un tope de cero apagaría el asistente, y para eso está apagarlo.
    // Techo 1000: el gasto esperado es ~$1.5–3 al mes (docs/plan/08 §…), así
    // que mil dólares ya es un dedo gordo con toda seguridad.
    minimo: 1,
    maximo: 1000,
  },
} as const satisfies Record<string, Esquema>;

export type Clave = keyof typeof ESQUEMAS;

/** En el orden de la pantalla, que es el de `ESQUEMAS`. */
export const CLAVES = Object.keys(ESQUEMAS) as Clave[];

export const esClave = (v: string): v is Clave => Object.hasOwn(ESQUEMAS, v);

export function esquemaDe(clave: Clave): Esquema {
  return ESQUEMAS[clave];
}

// ---------------------------------------------------------------------------
// Validar
// ---------------------------------------------------------------------------

/** El dinero se escribe en dólares aunque se guarde en centavos. */
const enDolares = (centavos: number): string =>
  `$${Math.trunc(centavos / 100)}.${String(Math.abs(centavos % 100)).padStart(2, "0")}`;

/**
 * `H:MM` o `HH:MM`, de 00:00 a 23:59.
 *
 * Se acepta una sola cifra en la hora («9:00») porque eso es lo que sale de un
 * teclado de teléfono, y se normaliza a dos al guardar: así la comparación de
 * texto y la de reloj dicen lo mismo.
 */
const RELOJ = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const minutosDelDia = (hhmm: string): number => {
  const m = RELOJ.exec(hhmm);
  if (m === null) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
};

const normalizarHora = (hhmm: string): string => {
  const m = RELOJ.exec(hhmm)!;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
};

/**
 * Un identificador de modelo, nada más.
 *
 * Lo que va aquí termina en una llamada al proveedor. Un espacio o una comilla
 * de más vuelve con un error del otro lado que no le dice nada a nadie, así que
 * se para aquí, donde se puede explicar.
 */
const ID_DE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,119}$/;

/** El código de una ventana: minúsculas ASCII. Lo exige `envios.ventana`. */
const ID_DE_VENTANA = /^[a-z][a-z0-9_]{0,23}$/;

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const enteroSeguro = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);

/**
 * Comprueba un valor contra su esquema y lo devuelve normalizado.
 *
 * Normalizado significa: textos sin espacios al borde, horas con dos cifras,
 * listas sin repetidos y objetos con solo las claves que les tocan. Lo que
 * sale de aquí es lo que se guarda, así que dos personas que escriben «9:00» y
 * «09:00» guardan lo mismo y el historial no enseña un cambio que no hubo.
 *
 * El motivo del rechazo va **en español y dirigido a la dueña**: lo va a leer
 * ella, en un teléfono, sin nadie a quien preguntarle. «El abono mínimo no
 * puede ser negativo» sirve; el nombre de un error de biblioteca no.
 */
export function validar(clave: string, valor: unknown): Resultado<Valor> {
  if (!esClave(clave)) {
    // Una clave inventada no es un error inofensivo: `ajustes` la aceptaría y
    // quedaría ahí para siempre, con su versión y su motivo, sin que nada la
    // lea nunca. Basura silenciosa.
    return fallo(
      "entrada_invalida",
      `«${clave}» no es un ajuste de este sistema. Los que hay son: ${CLAVES.join(", ")}.`,
    );
  }

  const e = ESQUEMAS[clave];

  if (esPendiente(valor)) {
    return e.admitePendiente
      ? ok(PENDIENTE)
      : fallo(
          "entrada_invalida",
          `«${e.titulo}» no puede quedar sin decidir: el sistema la usa todos los días y ya tiene un valor de arranque.`,
        );
  }

  switch (e.tipo) {
    case "entero":
      return numero(e, valor, (n) => String(n));
    case "dinero_cents":
      if (!enteroSeguro(valor)) {
        return fallo(
          "entrada_invalida",
          `«${e.titulo}» se guarda en centavos enteros: 1250 son $12.50.`,
        );
      }
      return numero(e, valor, enDolares);
    case "dinero_usd":
      return numero(e, valor, (n) => `$${n}`);
    case "booleano":
      return typeof valor === "boolean"
        ? ok(valor)
        : fallo("entrada_invalida", `«${e.titulo}» solo puede estar encendido o apagado.`);
    case "texto":
      return texto(e, valor);
    case "opcion":
      return opcion(e, valor);
    case "lista_de_opciones":
      return listaDeOpciones(e, valor);
    case "ventanas":
      return ventanas(valor);
    case "comisiones":
      return comisiones(valor);
  }
}

/** Entero dentro de sus límites, con el número escrito como lo lee la dueña. */
function numero(
  e: Esquema,
  valor: unknown,
  comoSeLee: (n: number) => string,
): Resultado<Valor> {
  if (!enteroSeguro(valor)) {
    return fallo(
      "entrada_invalida",
      `«${e.titulo}» tiene que ser un número entero${e.unidad === undefined ? "" : ` de ${e.unidad}`}, sin decimales.`,
    );
  }
  const unidad = e.unidad === undefined ? "" : ` ${e.unidad}`;
  if (e.minimo !== undefined && valor < e.minimo) {
    return fallo(
      "entrada_invalida",
      // «no puede ser negativo» dice mucho más que «no puede ser menos de 0».
      e.minimo === 0
        ? `«${e.titulo}» no puede ser negativo.`
        : `«${e.titulo}» no puede ser menos de ${comoSeLee(e.minimo)}${unidad}.`,
    );
  }
  if (e.maximo !== undefined && valor > e.maximo) {
    return fallo(
      "entrada_invalida",
      `«${e.titulo}» no puede pasar de ${comoSeLee(e.maximo)}${unidad}. Si de verdad tiene que ser más, avísele a Juan: es un límite del sistema, no una regla del negocio.`,
    );
  }
  return ok(valor);
}

function texto(e: Esquema, valor: unknown): Resultado<Valor> {
  if (typeof valor !== "string") {
    return fallo("entrada_invalida", `«${e.titulo}» se escribe como texto.`);
  }
  const limpio = valor.trim();
  if (limpio === "") {
    return fallo(
      "entrada_invalida",
      `«${e.titulo}» no puede quedar vacío. Si todavía no está decidido, déjelo sin decidir en vez de en blanco.`,
    );
  }
  if (!ID_DE_MODELO.test(limpio)) {
    return fallo(
      "entrada_invalida",
      `«${e.titulo}» es el nombre técnico de un modelo, como muse-spark-1.3-contributor: letras, números, puntos y guiones, sin espacios.`,
    );
  }
  return ok(limpio);
}

function opcion(e: Esquema, valor: unknown): Resultado<Valor> {
  const opciones = e.opciones ?? [];
  if (typeof valor !== "string" || !opciones.includes(valor)) {
    return fallo(
      "entrada_invalida",
      `«${e.titulo}» solo puede ser una de estas: ${opciones.join(", ")}.`,
    );
  }
  return ok(valor);
}

function listaDeOpciones(e: Esquema, valor: unknown): Resultado<Valor> {
  const opciones = e.opciones ?? [];
  if (!Array.isArray(valor)) {
    return fallo("entrada_invalida", `«${e.titulo}» es una lista.`);
  }
  const fuera = valor.filter((v): boolean => typeof v !== "string" || !opciones.includes(v));
  if (fuera.length > 0) {
    return fallo(
      "entrada_invalida",
      `«${e.titulo}» no acepta ${fuera.map((f) => `«${String(f)}»`).join(", ")}. Solo: ${opciones.join(", ")}.`,
    );
  }
  const lista = valor as string[];
  const repetida = lista.find((v, i) => lista.indexOf(v) !== i);
  if (repetida !== undefined) {
    return fallo("entrada_invalida", `«${repetida}» está dos veces en «${e.titulo}».`);
  }
  // La lista se guarda en el orden de las opciones y no en el que llegó: así
  // reordenar la pantalla no cuenta como un cambio en el historial.
  return ok(opciones.filter((o) => lista.includes(o)));
}

function ventanas(valor: unknown): Resultado<Valor> {
  if (!Array.isArray(valor)) {
    return fallo("entrada_invalida", "Las ventanas de entrega son una lista de franjas del día.");
  }
  if (valor.length === 0) {
    // Una lista vacía y un PENDIENTE se parecen y no son lo mismo: vacía diría
    // «decidí que no hay ventanas», que es lo mismo que no ofrecer ninguna
    // franja y no tiene sentido. Si todavía no están decididas, PENDIENTE.
    return fallo(
      "entrada_invalida",
      "Si todavía no decidió las ventanas de entrega, déjelas sin decidir. Una lista vacía no es lo mismo: diría que no hay ninguna franja en la que entregar.",
    );
  }

  const limpias: Ventana[] = [];
  for (const [i, cruda] of valor.entries()) {
    const donde = `La ventana ${i + 1}`;
    if (!esObjeto(cruda)) {
      return fallo("entrada_invalida", `${donde} no está completa.`);
    }
    const sobrantes = Object.keys(cruda).filter(
      (k) => !["id", "etiqueta", "desde", "hasta"].includes(k),
    );
    if (sobrantes.length > 0) {
      return fallo(
        "entrada_invalida",
        `${donde} trae datos que el sistema no conoce (${sobrantes.join(", ")}).`,
      );
    }

    const id = typeof cruda["id"] === "string" ? cruda["id"].trim() : "";
    if (!ID_DE_VENTANA.test(id)) {
      return fallo(
        "entrada_invalida",
        `${donde} necesita un código en minúsculas, sin acentos ni espacios — «manana» o «tarde», por ejemplo. Ese código queda escrito en cada envío, así que no se puede cambiar después.`,
      );
    }
    if (limpias.some((v) => v.id === id)) {
      return fallo("entrada_invalida", `El código «${id}» está en dos ventanas.`);
    }

    const etiqueta = typeof cruda["etiqueta"] === "string" ? cruda["etiqueta"].trim() : "";
    if (etiqueta === "") {
      return fallo(
        "entrada_invalida",
        `${donde} necesita un nombre: es lo que lee la clienta al elegir.`,
      );
    }
    if (etiqueta.length > 60) {
      return fallo("entrada_invalida", `El nombre de ${donde.toLowerCase()} es demasiado largo.`);
    }

    const desde = typeof cruda["desde"] === "string" ? cruda["desde"].trim() : "";
    const hasta = typeof cruda["hasta"] === "string" ? cruda["hasta"].trim() : "";
    const inicio = minutosDelDia(desde);
    const fin = minutosDelDia(hasta);
    if (inicio < 0 || fin < 0) {
      return fallo(
        "entrada_invalida",
        `Las horas de ${donde.toLowerCase()} se escriben como 9:00 y 13:30, en hora de Panamá.`,
      );
    }
    if (inicio >= fin) {
      return fallo(
        "entrada_invalida",
        `${donde} («${etiqueta}») termina antes de empezar. Revise la hora.`,
      );
    }

    limpias.push({ id, etiqueta, desde: normalizarHora(desde), hasta: normalizarHora(hasta) });
  }

  // Ordenadas por hora de inicio: es como corre el día y como se van a leer.
  // Guardar el orden en que llegaron haría que mover una fila en la pantalla
  // apareciera como un cambio en el historial.
  return ok([...limpias].sort((a, b) => minutosDelDia(a.desde) - minutosDelDia(b.desde)));
}

function comisiones(valor: unknown): Resultado<Valor> {
  if (!esObjeto(valor)) {
    return fallo(
      "entrada_invalida",
      "Las comisiones son una por pasarela: Yappy, Tilopay y PayPal.",
    );
  }
  const sobrantes = Object.keys(valor).filter(
    (k) => !(PASARELAS_CON_COMISION as readonly string[]).includes(k),
  );
  if (sobrantes.length > 0) {
    return fallo(
      "entrada_invalida",
      `«${sobrantes.join(", ")}» no es una pasarela que cobre comisión estimable. Solo: ${PASARELAS_CON_COMISION.join(", ")}.`,
    );
  }

  const tabla: Record<string, Comision | Pendiente> = {};
  for (const pasarela of PASARELAS_CON_COMISION) {
    const cruda = valor[pasarela];
    if (cruda === undefined) {
      return fallo(
        "entrada_invalida",
        `Falta la comisión de ${pasarela}. Si todavía no tiene su contrato, déjela sin decidir en vez de quitarla: una fila que desaparece es una que nadie vuelve a buscar.`,
      );
    }
    if (esPendiente(cruda)) {
      tabla[pasarela] = PENDIENTE;
      continue;
    }
    if (!esObjeto(cruda)) {
      return fallo("entrada_invalida", `La comisión de ${pasarela} no está completa.`);
    }
    const extras = Object.keys(cruda).filter(
      (k) => !["porcentaje_bp", "fijo_cents", "lleva_itbms"].includes(k),
    );
    if (extras.length > 0) {
      return fallo(
        "entrada_invalida",
        `La comisión de ${pasarela} trae datos que el sistema no conoce (${extras.join(", ")}).`,
      );
    }

    const bp = cruda["porcentaje_bp"];
    if (!enteroSeguro(bp) || bp < 0 || bp > 10_000) {
      return fallo(
        "entrada_invalida",
        `El porcentaje de la comisión de ${pasarela} va en puntos básicos, de 0 a 10000: 350 son 3.5 %.`,
      );
    }
    const fijo = cruda["fijo_cents"];
    // Techo de $100: una baranda contra escribir el fijo en dólares (0.35 →
    // «35», que son 35 centavos y no $35). Ninguna pasarela cobra un fijo así.
    if (!enteroSeguro(fijo) || fijo < 0 || fijo > 10_000) {
      return fallo(
        "entrada_invalida",
        `El cargo fijo de ${pasarela} va en centavos enteros, de 0 a 10000: 35 son $0.35.`,
      );
    }
    const itbms = cruda["lleva_itbms"];
    if (typeof itbms !== "boolean") {
      return fallo(
        "entrada_invalida",
        `Falta decir si la comisión de ${pasarela} lleva ITBMS encima.`,
      );
    }

    tabla[pasarela] = { porcentaje_bp: bp, fijo_cents: fijo, lleva_itbms: itbms };
  }

  return ok(tabla as Comisiones);
}
