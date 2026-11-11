/**
 * Las cuentas del resumen: el día de Panamá, los periodos, las comparaciones y
 * las escalas de los gráficos.
 *
 * Aquí no hay D1 ni fetch: son funciones puras con pruebas. Lo que toca la base
 * está en `src/db/metricas.ts`, y lo que se dibuja, en
 * `panel/src/pantallas/Resumen.tsx`. El reparto importa porque una pantalla de
 * métricas es donde más fácil se miente sin querer, y lo que se puede probar
 * sin base de datos es justo lo que se puede probar bien.
 *
 * ## Las tres reglas que este archivo existe para cumplir
 *
 * **1. Un cero no es «todavía no hay datos».** Son dos cosas distintas y
 * confundirlas hace que alguien crea que vendió cero cuando lo que pasa es que
 * nadie ha cargado nada. Por eso existe `Dato<T>`: una cifra o el motivo por el
 * que no hay cifra, nunca un cero de relleno.
 *
 * **2. Un periodo se compara con otro de la MISMA duración.** «Hoy» a las siete
 * de la mañana contra el día de ayer completo es una caída inventada: lo que
 * toca es ayer hasta esta misma hora. Todos los periodos de aquí terminan en
 * `ahora`, y `periodoAnterior` corre la ventana entera hacia atrás sin cambiarle
 * el largo ni un milisegundo.
 *
 * **3. Un porcentaje sobre cero no existe.** Pasar de 0 a 5 no es «+500 %» ni
 * «+∞»: es empezar. `comparar` lo devuelve como un caso aparte para que la
 * pantalla lo diga con palabras en vez de imprimir un número falso.
 */

// ---------------------------------------------------------------------------
// El día de Panamá
// ---------------------------------------------------------------------------

/**
 * UTC−5 y sin horario de verano: Panamá no lo tiene.
 *
 * Es el MISMO desfase que usa `fechaDePanama` en `src/db/entregas.ts`. Está
 * escrito dos veces porque el dominio no puede importar de `src/db/` sin
 * arrastrar los tipos de D1 a un módulo que existe para ser puro, así que lo
 * que impide que las dos copias se separen es una prueba:
 * `metricas.test.ts` compara las dos funciones instante a instante y se pone
 * roja si una cambia sin la otra. Sin horario de verano, un desfase constante
 * es exacto; con él habría que preguntarle a una base de zonas horarias.
 */
export const DESFASE_PANAMA_MS = 5 * 60 * 60 * 1000;

/** Un día exacto. Vale como aritmética porque Panamá no cambia la hora. */
export const DIA_MS = 24 * 60 * 60 * 1000;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function exigeInstante(ms: number, quien: string): void {
  if (!Number.isFinite(ms)) throw new RangeError(`${quien}: «${ms}» no es un instante`);
}

function exigeFecha(fecha: string, quien: string): void {
  if (!FECHA.test(fecha)) throw new RangeError(`${quien}: «${fecha}» no es una fecha YYYY-MM-DD`);
  if (Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) {
    throw new RangeError(`${quien}: «${fecha}» no es un día que exista`);
  }
}

/**
 * La fecha del negocio, 'YYYY-MM-DD'.
 *
 * No es la de UTC: en UTC, todo lo que pasa después de las siete de la noche de
 * Panamá cuenta como del día siguiente, así que «lo de hoy» aparecería partido
 * en dos días y la mitad de la tarde se iría al mañana.
 */
export function fechaPanama(ms: number): string {
  exigeInstante(ms, "fechaPanama");
  return new Date(ms - DESFASE_PANAMA_MS).toISOString().slice(0, 10);
}

/** El instante (ms UTC) en que empieza ese día en Panamá: las 12 de la noche de aquí. */
export function inicioDelDia(fecha: string): number {
  exigeFecha(fecha, "inicioDelDia");
  return Date.parse(`${fecha}T00:00:00Z`) + DESFASE_PANAMA_MS;
}

/**
 * Qué día de la semana es, con el LUNES en 0.
 *
 * Lunes en 0 y no domingo, porque la semana del negocio empieza el lunes
 * (docs/plan/05-contabilidad.md §5: «Esta semana (lunes a hoy)»). Usar el 0 del
 * domingo de JavaScript y restar después es de donde salen los errores de un
 * día que solo se notan los domingos.
 */
export function diaDeLaSemana(fecha: string): number {
  exigeFecha(fecha, "diaDeLaSemana");
  return (new Date(`${fecha}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Suma (o resta) días a una fecha del negocio, sin pasar por la zona horaria. */
export function sumarDias(fecha: string, dias: number): string {
  exigeFecha(fecha, "sumarDias");
  if (!Number.isSafeInteger(dias)) throw new RangeError(`sumarDias: «${dias}» no es un entero`);
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

/** El lunes de la semana de esa fecha. Si ya es lunes, ella misma. */
export function lunesDeLaSemana(fecha: string): string {
  return sumarDias(fecha, -diaDeLaSemana(fecha));
}

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

/**
 * Los dos que se miran por la mañana.
 *
 * No hay «este mes» ni «este año» a propósito: esos son reportes de
 * contabilidad —viven en su pantalla, con el criterio de reconocimiento de
 * ingresos que esta no tiene— y además meten la comparación contra un mes de
 * distinto número de días, que es una trampa que aquí no hace falta.
 */
export const PERIODOS = ["hoy", "semana"] as const;

export type NombrePeriodo = (typeof PERIODOS)[number];

export const esNombrePeriodo = (v: string): v is NombrePeriodo =>
  (PERIODOS as readonly string[]).includes(v);

export interface Periodo {
  readonly nombre: NombrePeriodo;
  /** Primer instante que cuenta (ms UTC). Las 12 de la noche de Panamá de `desdeFecha`. */
  readonly desde: number;
  /** Último instante que cuenta (ms UTC), inclusive. Es `ahora`: no hay datos del futuro. */
  readonly hasta: number;
  readonly desdeFecha: string;
  readonly hastaFecha: string;
  /** Días del calendario que toca la ventana, contando el de hoy a medias. */
  readonly dias: number;
}

/**
 * La ventana de un periodo, SIEMPRE terminada en `ahora`.
 *
 * Que termine en `ahora` y no al final del día es lo que hace honesta la
 * comparación: «hoy» a las siete de la mañana son siete horas, y lo que se le
 * puede poner al lado es ayer a las siete, no el día entero de ayer.
 *
 * El intervalo es CERRADO en los dos extremos (`desde <= t <= hasta`). Con el
 * extremo abierto, un pago sellado justo en este milisegundo se perdería sin
 * que nada lo dijera.
 */
export function periodoDe(nombre: NombrePeriodo, ahora: number): Periodo {
  exigeInstante(ahora, "periodoDe");
  const hastaFecha = fechaPanama(ahora);
  const desdeFecha = nombre === "hoy" ? hastaFecha : lunesDeLaSemana(hastaFecha);
  return {
    nombre,
    desde: inicioDelDia(desdeFecha),
    hasta: ahora,
    desdeFecha,
    hastaFecha,
    dias: Math.round((inicioDelDia(hastaFecha) - inicioDelDia(desdeFecha)) / DIA_MS) + 1,
  };
}

/**
 * La misma ventana, corrida hacia atrás el salto natural del periodo: un día
 * para «hoy», siete para «semana».
 *
 * Dura EXACTAMENTE lo mismo —se corren los dos extremos el mismo número de
 * milisegundos—, así que «va mejor» o «va peor» compara cosas comparables. Y
 * como Panamá no cambia la hora, correr siete días en milisegundos cae en la
 * misma hora del mismo día de la semana; con horario de verano esto no valdría.
 */
export function periodoAnterior(periodo: Periodo): Periodo {
  const salto = (periodo.nombre === "hoy" ? 1 : 7) * DIA_MS;
  const desde = periodo.desde - salto;
  const hasta = periodo.hasta - salto;
  return {
    nombre: periodo.nombre,
    desde,
    hasta,
    desdeFecha: fechaPanama(desde),
    hastaFecha: fechaPanama(hasta),
    dias: periodo.dias,
  };
}

// ---------------------------------------------------------------------------
// Una cifra, o el motivo por el que no hay cifra
// ---------------------------------------------------------------------------

/**
 * Por qué no hay número. Son motivos distintos porque llevan a acciones
 * distintas: uno se arregla esperando y el otro se arregla configurando.
 */
export type PorQueNoHay =
  /** Nunca se ha registrado nada de esto. Un cero aquí sería una afirmación falsa. */
  | "todavia_no_hay_datos"
  /** Falta que la dueña decida algo (un mínimo, una tarifa) para poder calcularlo. */
  | "sin_configurar";

export type Dato<T> = { readonly hay: true; readonly valor: T } | { readonly hay: false; readonly porque: PorQueNoHay };

export const hayDato = <T>(valor: T): Dato<T> => ({ hay: true, valor });
export const sinDato = <T>(porque: PorQueNoHay): Dato<T> => ({ hay: false, porque });

// ---------------------------------------------------------------------------
// Comparar dos periodos
// ---------------------------------------------------------------------------

/** Redondeo simétrico: medio punto se va siempre lejos del cero, como en `dinero.ts`. */
const redondear = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

export type Comparacion =
  /** Los dos periodos en cero: no hay nada que comparar y decir «igual» sugeriría que sí. */
  | { readonly tipo: "sin_base" }
  /** Antes no había nada. No es un porcentaje: es empezar. */
  | { readonly tipo: "desde_cero"; readonly diferencia: number }
  | {
      readonly tipo: "relativo";
      readonly diferencia: number;
      /** Puntos básicos, como `tasa_itbms_bp`: 10 000 = 100 %. Enteros, para no imprimir un 7.000000001 %. */
      readonly variacionBp: number;
    };

/**
 * Cómo va este periodo contra el anterior.
 *
 * Los dos valores tienen que ser cantidades no negativas (centavos, unidades,
 * cuentas de pedidos). Un negativo aquí sería un error de quien llama, y
 * dividir por él daría un porcentaje con el signo al revés: se para en vez de
 * seguir.
 */
export function comparar(ahora: number, antes: number): Comparacion {
  for (const [n, v] of [
    ["ahora", ahora],
    ["antes", antes],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`comparar: ${n} vale «${v}» y tiene que ser una cantidad no negativa`);
    }
  }

  if (antes === 0) {
    return ahora === 0 ? { tipo: "sin_base" } : { tipo: "desde_cero", diferencia: ahora };
  }
  return {
    tipo: "relativo",
    diferencia: ahora - antes,
    variacionBp: redondear(((ahora - antes) * 10_000) / antes),
  };
}

// ---------------------------------------------------------------------------
// Promedios con pocos datos
// ---------------------------------------------------------------------------

/**
 * Por debajo de esto, el promedio se marca como poco fiable.
 *
 * No es que esté mal calculado: el promedio de dos pedidos es exactamente el
 * promedio de dos pedidos. Es que presentarlo como «su ticket promedio» invita
 * a tomarlo por la costumbre del negocio, y con dos pedidos no lo es. La
 * pantalla lo dice con el número de pedidos al lado.
 */
export const MINIMO_PARA_PROMEDIO = 5;

export interface Promedio {
  /** Redondeado, para mostrar. La verdad es el total y el n, que viajan al lado. */
  readonly valor: number;
  readonly n: number;
  readonly pocos: boolean;
}

export function promedio(total: number, n: number, minimo = MINIMO_PARA_PROMEDIO): Dato<Promedio> {
  if (!Number.isFinite(total)) throw new RangeError(`promedio: total «${total}» no es un número`);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`promedio: n vale «${n}» y tiene que ser una cuenta de 0 o más`);
  }
  // Cero pedidos no dan promedio cero: no dan promedio. Devolver 0 diría que el
  // pedido medio fue de cero dólares.
  if (n === 0) return sinDato("todavia_no_hay_datos");
  return hayDato({ valor: redondear(total / n), n, pocos: n < minimo });
}

// ---------------------------------------------------------------------------
// La escala de un gráfico
// ---------------------------------------------------------------------------

/**
 * Días con algo que contar para que un gráfico informe más de lo que adorna.
 *
 * Con dos puntos, una línea siempre sube o baja y siempre parece una tendencia.
 * Tres es el mínimo para que la forma sea de los datos y no del azar — y hoy,
 * con la base casi vacía, esto hace que la pantalla NO dibuje nada, que es lo
 * correcto.
 */
export const MINIMO_DIAS_CON_DATO = 3;

export function mereceGrafico(valores: readonly number[], minimo = MINIMO_DIAS_CON_DATO): boolean {
  return valores.filter((v) => v > 0).length >= minimo;
}

export interface Escala {
  /** El valor del borde de arriba. Cero cuando no hay nada que dibujar. */
  readonly maximo: number;
  /** Los valores de las marcas, de 0 a `maximo`. Vacío cuando no hay nada que dibujar. */
  readonly marcas: readonly number[];
}

/**
 * Un paso «redondo» de al menos `minimo`: 1, 2 o 5 por una potencia de diez.
 *
 * Sin logaritmos a propósito: `Math.log10` tiene valores que caen justo por
 * debajo del entero y ahí el paso saldría diez veces más pequeño de lo que
 * hace falta. Multiplicar enteros no tiene ese problema, y todos los pasos que
 * salen de aquí son enteros exactos — importa porque las marcas se imprimen y
 * una marca de «1.6666» es la cifra a ojo que esto existe para evitar.
 */
function pasoRedondo(minimo: number): number {
  let paso = 1;
  while (paso < minimo) {
    if (paso * 2 >= minimo) return paso * 2;
    if (paso * 5 >= minimo) return paso * 5;
    paso *= 10;
  }
  return paso;
}

/**
 * La escala de un gráfico de barras: una sola, para las barras y para las
 * marcas.
 *
 * Que sea una sola función —y que el dibujo saque de ella tanto el alto de cada
 * barra como la altura de cada línea— es lo que impide el SVG con números a
 * ojo: si la escala se equivoca, se equivoca igual en los dos sitios y se ve.
 *
 * `maximo` siempre cubre el valor más alto y siempre es múltiplo exacto del
 * número de intervalos, así que las marcas son enteros y cada una cae en el
 * sitio que le toca.
 */
export function escalaDeBarras(valores: readonly number[], intervalos = 2): Escala {
  if (!Number.isSafeInteger(intervalos) || intervalos < 1) {
    throw new RangeError(`escalaDeBarras: «${intervalos}» intervalos no se puede dibujar`);
  }
  let maximoDato = 0;
  for (const v of valores) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`escalaDeBarras: «${v}» no es una cantidad no negativa`);
    }
    if (v > maximoDato) maximoDato = v;
  }
  // Todo en cero: no hay escala posible y tampoco gráfico que dibujar. Una
  // escala inventada (de 0 a 10, digamos) pintaría catorce barras vacías bajo
  // un eje que promete decenas que nadie vendió.
  if (maximoDato === 0) return { maximo: 0, marcas: [] };

  const paso = pasoRedondo(maximoDato / intervalos);
  const maximo = paso * intervalos;
  return {
    maximo,
    marcas: Array.from({ length: intervalos + 1 }, (_, i) => i * paso),
  };
}

/**
 * Dónde cae un valor en la escala, de 0 (el suelo) a 1 (el borde de arriba).
 *
 * Revienta si el valor no está en la escala en vez de recortarlo. Recortar
 * dibujaría una barra tocando el techo con un número que lo pasa, y eso es una
 * mentira callada; esto es un fallo que la frontera de errores enseña y que se
 * puede arreglar. No puede pasar desde la pantalla, que construye la escala con
 * el mismo arreglo que dibuja.
 */
export function fraccion(valor: number, escala: Escala): number {
  if (escala.maximo <= 0) {
    throw new RangeError("fraccion: una escala sin máximo no coloca nada");
  }
  if (!Number.isFinite(valor) || valor < 0 || valor > escala.maximo) {
    throw new RangeError(`fraccion: «${valor}» no cabe en una escala de 0 a ${escala.maximo}`);
  }
  return valor / escala.maximo;
}
