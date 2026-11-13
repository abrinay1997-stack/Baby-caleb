import { useState } from "react";
import { Link } from "react-router-dom";
import { dinero, fecha as comoFecha, useCarga } from "../api";
import {
  Carga,
  Cifra,
  Celda,
  Fila,
  Pastilla,
  Rejilla,
  Tarjeta,
  Vacio,
  sinPuntoFinal,
} from "../componentes";
import {
  type Comparacion,
  type Escala,
  type NombrePeriodo,
  comparar,
  escalaDeBarras,
  fraccion,
  mereceGrafico,
  promedio,
} from "../../../src/dominio/metricas";

/**
 * La pantalla que la dueña abre cada mañana.
 *
 * **Se usa desde el teléfono** (el dueño lo dijo: 95 % de las veces), de pie y
 * con prisa. De ahí el orden, que es la decisión que manda sobre todo lo demás:
 *
 * **1. Arriba lo que necesita que alguien haga algo hoy.** No las cifras
 * bonitas. Si hay tres pedidos sin atender y hay que desplazarse para verlos,
 * la pantalla falló. Después el inventario, porque lo agotado es lo que está
 * costando ventas ahora mismo. El dinero va tercero: es lo que se mira, no lo
 * que se hace.
 *
 * **2. Ninguna cifra sin decir de dónde sale.** Cada número lleva debajo qué
 * cuenta y de qué ventana. Un «12 pedidos esta semana» sin decir qué es un
 * pedido ni cuándo empieza la semana invita a creérselo.
 *
 * **3. Un cero y un «todavía no hay datos» NO se ven igual.** Donde no hay
 * dato, el hueco dice por qué está vacío. Hoy la base está casi vacía —cero
 * clientas, cero pedidos, el inventario sin cargar— y esta pantalla tiene que
 * verse bien así, porque es lo primero que la dueña va a ver. No es un caso
 * raro: es el estado de hoy.
 *
 * Las medidas son las del §7 del sistema de diseño (contrato): lo que se toca a
 * 44 px, nada de texto por debajo de 12 px, ni `min-width` en píxeles ni
 * `100vh`. Las piezas salen de `componentes.tsx`; aquí no se inventa una
 * variante de tabla.
 *
 * Las cuentas —qué periodo cubre «esta semana» en Panamá, cómo se compara con
 * el anterior, la escala del gráfico— están en `src/dominio/metricas.ts` con sus
 * pruebas. Aquí no se calcula nada que no sea geometría.
 */

// ---------------------------------------------------------------------------
// La forma de lo que manda el servidor (GET /api/resumen)
// ---------------------------------------------------------------------------

interface Periodo {
  nombre: NombrePeriodo;
  desde: number;
  hasta: number;
  desdeFecha: string;
  hastaFecha: string;
  dias: number;
}

interface Atencion {
  pedidosEnTotal: number;
  porAbonar: number;
  porAbonarVencidos: number;
  agendadosSinDespachar: number;
  pagosPorRevisar: number;
  pagosEsperandoClienta: number;
  entregasAtrasadas: number;
  entregasFallidas: number;
  paradasDeHoySinAsignar: number;
  rutasDeHoySinSalir: number;
}

interface Actividad {
  pedidosNuevos: number;
  pedidosNuevosAnterior: number;
  clientasNuevas: number;
  clientasNuevasAnterior: number;
  clientasEnTotal: number;
}

interface FilaDeInventario {
  codigo: string;
  nombre: string;
  bodega: string;
  libres: number;
  minimo: number | null;
}

type Inventario =
  | { cargado: false; filas: number; sinMinimo: number }
  | {
      cargado: true;
      filas: number;
      sinMinimo: number;
      unidades: number;
      reservadas: number;
      agotadas: number;
      porAcabarse: number;
      lista: FilaDeInventario[];
      listaTruncada: boolean;
    };

interface Dinero {
  entro: number;
  entroAnterior: number;
  pagosSinFecha: number;
  entregado: { total: number; pedidos: number };
  entregadoAnterior: { total: number; pedidos: number };
  devueltos: number;
  porCobrar: { total: number; pedidos: number };
  serie: { fecha: string; centavos: number }[];
}

interface Datos {
  ahora: number;
  hoy: string;
  periodo: Periodo;
  anterior: Periodo;
  avisos: { sinPublicar: number; masViejo: number | null };
  atencion: Atencion | null;
  actividad: Actividad | null;
  inventario: Inventario | null;
  dinero: Dinero | null;
}

// ---------------------------------------------------------------------------
// Palabras
// ---------------------------------------------------------------------------

const BOTON =
  "tactil rounded-[14px] px-4 py-2 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

/**
 * Un día suelto, corto: «9 nov».
 *
 * `timeZone: "UTC"` y no «America/Panama», que parece lo correcto y es el
 * error: una fecha 'YYYY-MM-DD' se interpreta como medianoche UTC, y pedirle a
 * Intl que la pase a la hora de Panamá le resta cinco horas y la enseña como el
 * día ANTERIOR. La fecha ya viene en el día de Panamá; aquí solo se formatea.
 */
function diaCorto(fechaISO: string): string {
  return new Intl.DateTimeFormat("es-PA", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${fechaISO}T00:00:00Z`));
}

/** Cómo se llama el periodo y con qué se compara, en palabras de la dueña. */
const PALABRAS: Record<NombrePeriodo, { titulo: string; contra: string }> = {
  hoy: { titulo: "Hoy", contra: "que ayer a esta hora" },
  semana: { titulo: "Esta semana", contra: "que la semana pasada a estas alturas" },
};

/**
 * La comparación, en palabras.
 *
 * Los casos sin porcentaje se dicen con palabras a propósito: pasar de nada a
 * algo no es «+100 %» ni «+∞», y los dos periodos en cero no son «igual». Y por
 * debajo de medio punto porcentual se dice «casi igual» en vez de imprimir un
 * «0 % más», que es lo que saldría al redondear.
 */
export function textoDeComparacion(c: Comparacion, nombre: NombrePeriodo): string {
  const contra = PALABRAS[nombre].contra;
  if (c.tipo === "sin_base") return `Tampoco ${contra.replace(/^que /, "")}`;
  if (c.tipo === "desde_cero") return `No hubo nada ${contra}`;
  if (c.variacionBp === 0) return `Igual ${contra}`;
  if (Math.abs(c.variacionBp) < 50) return `Casi igual ${contra}`;
  const porCiento = Math.round(Math.abs(c.variacionBp) / 100);
  return `${porCiento} % ${c.variacionBp > 0 ? "más" : "menos"} ${contra}`;
}

// ---------------------------------------------------------------------------
// Lo que hay que atender
// ---------------------------------------------------------------------------

export interface Pendiente {
  clave: string;
  cuantos: number;
  que: string;
  haga: string;
  urgente: boolean;
}

/**
 * Las filas de «hay que atender», solo las que tienen algo.
 *
 * El orden es el de urgencia y está escrito a mano, no calculado: lo primero es
 * lo que la clienta ya está notando (un mensaje que no salió, una caja que
 * lleva un día en una moto) y después lo que espera dentro de la casa.
 *
 * `porAbonar` y `porAbonarVencidos` van en UNA fila y no en dos: los vencidos
 * son parte de los por abonar, y dos tarjetas con números que se solapan hacen
 * sumar mal a quien las lee de un vistazo.
 */
export function pendientesDe(a: Atencion, avisosSinPublicar: number): Pendiente[] {
  const filas: Pendiente[] = [
    {
      clave: "avisos",
      cuantos: avisosSinPublicar,
      que: "aviso sin salir|avisos sin salir",
      haga: "El sistema los reintenta cada 5 minutos. Si el número no baja en media hora, avísele a Juan: puede que las clientas no estén recibiendo sus mensajes.",
      urgente: true,
    },
    {
      clave: "atrasadas",
      cuantos: a.entregasAtrasadas,
      que: "entrega que salió y nadie cerró|entregas que salieron y nadie cerró",
      haga: "Salieron en un día anterior y siguen abiertas. Llame al motorizado: o llegó y no la marcó, o la caja sigue en la moto.",
      urgente: true,
    },
    {
      clave: "fallidas",
      cuantos: a.entregasFallidas,
      que: "entrega que falló|entregas que fallaron",
      haga: "Nadie las resolvió todavía. Hay que reprogramarlas o devolver la mercancía a la bodega.",
      urgente: true,
    },
    {
      clave: "cobros",
      cuantos: a.pagosPorRevisar,
      que: "comprobante esperándola|comprobantes esperándola",
      haga: "Alguien de la casa tiene que mirarlos y aprobarlos o rechazarlos. Mientras no, el pedido no se agenda.",
      urgente: true,
    },
    {
      clave: "porAbonar",
      cuantos: a.porAbonar,
      que: "pedido esperando su abono|pedidos esperando su abono",
      haga:
        a.porAbonarVencidos > 0
          ? `${a.porAbonarVencidos} ya pasaron su hora: su reserva está trabando mercancía que nadie puede comprar. Escríbale a la clienta o libere el pedido.`
          : "Todavía tienen tiempo. Si una clienta no contesta, se le puede escribir.",
      urgente: a.porAbonarVencidos > 0,
    },
    {
      clave: "sinDespachar",
      cuantos: a.agendadosSinDespachar,
      que: "pedido agendado sin preparar|pedidos agendados sin preparar",
      haga: "Están pagados o abonados y nadie les ha armado la entrega. Es el paso que falta para que salgan.",
      urgente: false,
    },
    {
      clave: "sinAsignar",
      cuantos: a.paradasDeHoySinAsignar,
      que: "parada de hoy sin motorizado|paradas de hoy sin motorizado",
      haga: "Tienen fecha de hoy y nadie las lleva. Asígnelas antes de que salga la ruta.",
      urgente: false,
    },
    {
      clave: "rutas",
      cuantos: a.rutasDeHoySinSalir,
      que: "ruta de hoy sin salir|rutas de hoy sin salir",
      haga: "La tanda está armada pero no ha salido de la bodega. Mientras no salga, no se puede marcar ninguna entrega.",
      urgente: false,
    },
    {
      clave: "esperandoClienta",
      cuantos: a.pagosEsperandoClienta,
      que: "pago esperando a la clienta|pagos esperando a la clienta",
      haga: "Estos NO dependen de usted: la clienta empezó a pagar y no terminó. Se le puede recordar.",
      urgente: false,
    },
  ];
  return filas.filter((f) => f.cuantos > 0);
}

/**
 * «1 pedido esperando su abono» / «3 pedidos esperando su abono».
 *
 * Las dos formas se escriben ENTERAS en `que`, separadas por una barra, y no
 * como un tronco con una cola pegada. Con la cola, el singular salía mutilado:
 * nueve filas decían «1 entrega» o «1 ruta» a secas, sin el dato que las hace
 * accionables, y solo el plural estaba bien escrito. Se vio en la captura.
 */
export function conteo(cuantos: number, que: string): string {
  const [singular, plural] = que.split("|");
  return `${cuantos} ${cuantos === 1 ? singular : (plural ?? singular)}`;
}

/**
 * A dónde lleva cada fila de «hay que atender», y con qué filtro puesto.
 *
 * La pantalla decía «3 comprobantes esperándola» y ahí se acababa: ochocientas
 * líneas sin un solo enlace. La dueña leía el número, se iba al menú, buscaba
 * la pestaña y volvía a filtrar a mano lo que esta tarjeta ya sabía. El
 * destino es el sitio donde se HACE lo que la fila pide, con la lista ya
 * acotada: `/pedidos` lee `?estado=` de la barra de direcciones.
 *
 * Dos filas no tienen destino, y eso también es una decisión:
 *
 *  - `avisos`: no hay pantalla de avisos. Lo que dice la fila es «espere, y si
 *    no baja, avísele a Juan» — no hay nada que tocar.
 *  - `esperandoClienta`: el pago lo empezó la clienta y no lo terminó. No está
 *    en la bandeja de cobros (ahí solo entra lo que tiene comprobante) y no
 *    hay filtro que los liste.
 *
 * Inventarles un enlace sería peor que no tenerlo: un enlace que lleva a una
 * lista donde no está lo que se buscaba se lee como que el sistema perdió algo.
 */
export const DESTINOS: Record<string, { a: string; verbo: string }> = {
  atrasadas: { a: "/entregas", verbo: "Ver las entregas del día" },
  fallidas: { a: "/entregas", verbo: "Ver las entregas del día" },
  cobros: { a: "/cobros", verbo: "Ver los comprobantes" },
  porAbonar: { a: "/pedidos?estado=por_abonar", verbo: "Ver los pedidos por abonar" },
  sinDespachar: { a: "/entregas", verbo: "Ver qué falta preparar" },
  sinAsignar: { a: "/entregas", verbo: "Ver las paradas de hoy" },
  rutas: { a: "/entregas", verbo: "Ver las rutas de hoy" },
};

/** El destino de una fila, o nada si no lo tiene. */
export function destinoDe(clave: string): { a: string; verbo: string } | undefined {
  return DESTINOS[clave];
}

// ---------------------------------------------------------------------------
// El gráfico
// ---------------------------------------------------------------------------

/** El alto del dibujo en el sistema de coordenadas del SVG. */
const ALTO = 100;

/**
 * Cuántos tramos tiene el eje. Cuatro y no dos.
 *
 * Con dos tramos, los pasos redondos de la escala (1, 2 y 5 por una potencia de
 * diez) quedan tan separados que un día de $45 se dibuja bajo un eje que llega
 * a $100 y la barra más alta se queda a media altura: el gráfico es correcto y
 * cuesta leerlo. Con cuatro, el techo queda más pegado al dato y hay más líneas
 * de referencia. Las marcas siguen siendo enteras: `escalaDeBarras` lo
 * garantiza para cualquier número de tramos.
 */
const TRAMOS = 4;

/** La escala de una serie. En un solo sitio para que el eje y las barras no puedan discrepar. */
export const escalaDeLaSerie = (valores: readonly number[]): Escala =>
  escalaDeBarras(valores, TRAMOS);

export interface Barra {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

/**
 * Las barras, medidas.
 *
 * Toda la altura sale de `fraccion` —la misma función que coloca las marcas del
 * eje—, así que el eje y las barras no se pueden desincronizar: si la escala se
 * equivoca, se equivoca igual en los dos y se ve. Es la diferencia entre un SVG
 * medido y un SVG con números a ojo.
 *
 * El ancho de hueco es una fracción del paso y no un número de píxeles: el SVG
 * se estira al ancho de la tarjeta, y un hueco en píxeles se deformaría.
 */
export function barras(valores: readonly number[], escala: Escala, ancho: number): Barra[] {
  if (valores.length === 0) return [];
  const paso = ancho / valores.length;
  const anchoBarra = paso * 0.68;
  return valores.map((v, i) => {
    const alto = fraccion(v, escala) * ALTO;
    return { x: i * paso + (paso - anchoBarra) / 2, y: ALTO - alto, ancho: anchoBarra, alto };
  });
}

function Grafico({ serie }: { serie: { fecha: string; centavos: number }[] }) {
  const valores = serie.map((d) => d.centavos);
  const escala = escalaDeLaSerie(valores);
  const ancho = serie.length * 10;
  const rectangulos = barras(valores, escala, ancho);
  const masAlto = serie.reduce((m, d) => (d.centavos > m.centavos ? d : m), serie[0]!);

  return (
    <div>
      <div className="flex gap-2">
        {/* Las etiquetas del eje son HTML y no `<text>` del SVG: el SVG se
            estira al ancho de la tarjeta, y un texto dentro se estiraría con
            él, bajando del piso de 12 px del §7 en una pantalla angosta. Se
            colocan en el mismo sitio que sus líneas porque las dos salen de
            `fraccion`. */}
        <div className="relative w-14 shrink-0" style={{ height: 132 }}>
          {escala.marcas.map((m) => (
            <span
              key={m}
              className="absolute right-0 -translate-y-1/2 text-[12px] text-muted"
              style={{ top: `${(1 - fraccion(m, escala)) * 100}%` }}
            >
              {dinero(m)}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${ancho} ${ALTO}`}
          preserveAspectRatio="none"
          className="min-w-0 flex-1"
          style={{ height: 132 }}
          role="img"
          aria-label={`Lo que entró cada día, del ${diaCorto(serie[0]!.fecha)} al ${diaCorto(
            serie.at(-1)!.fecha,
          )}. El día más alto fue el ${diaCorto(masAlto.fecha)} con ${dinero(masAlto.centavos)}.`}
        >
          {escala.marcas.map((m) => (
            <line
              key={m}
              x1={0}
              x2={ancho}
              y1={ALTO - fraccion(m, escala) * ALTO}
              y2={ALTO - fraccion(m, escala) * ALTO}
              stroke="var(--line)"
              strokeWidth={1}
              // Sin esto, estirar el SVG engordaría las líneas horizontales.
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {rectangulos.map((r, i) => (
            <rect
              key={serie[i]!.fecha}
              x={r.x}
              y={r.y}
              width={r.ancho}
              height={r.alto}
              fill="var(--accent)"
            />
          ))}
        </svg>
      </div>
      <div className="mt-1 flex gap-2">
        <div className="w-14 shrink-0" />
        {/* «del… al…» y no dos fechas sueltas. Una fecha pegada al borde
            izquierdo parecería una marca del eje, y no lo es: el centro de la
            primera barra cae unos píxeles más adentro. Decirlo como un rango
            quita la promesa de posición que no se puede cumplir con catorce
            días en 390 px sin bajar del piso de 12 px. */}
        <div className="flex min-w-0 flex-1 justify-between text-[12px] text-muted">
          <span>del {diaCorto(serie[0]!.fecha)}</span>
          <span>al {diaCorto(serie.at(-1)!.fecha)}</span>
        </div>
      </div>
      <p className="m-0 mt-2 text-[12px] text-muted">
        El día más alto fue el {diaCorto(masAlto.fecha)} con {dinero(masAlto.centavos)}. Cada barra
        es un día de Panamá, y cuenta los pagos aprobados ese día.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piezas de la pantalla
// ---------------------------------------------------------------------------

/**
 * Una cifra que puede no existir.
 *
 * Cuando no hay dato NO se escribe un cero: se escribe por qué no hay. Un cero
 * y un «todavía no hay datos» llevan a decisiones distintas, y confundirlos
 * hace que alguien crea que vendió cero.
 */
function Numero({
  etiqueta,
  valor,
  nota,
  comparacion,
}: {
  etiqueta: string;
  valor: string | null;
  nota: string;
  comparacion?: string;
}) {
  return (
    <Tarjeta>
      <p className="m-0 text-[12px] uppercase tracking-wide text-muted">{etiqueta}</p>
      {valor === null ? (
        <p className="m-0 py-1 text-[15px] font-bold">Todavía no hay datos</p>
      ) : (
        /* `break-words` en la cifra: una cifra larga parte de línea en vez
           de empujar la página de lado (§7g). A 32 px en negrita, un total de
           siete cifras mide más que su celda, y como las cuadrículas estiran a
           sus hijos, arrastraba la fila entera. Dos renglones feos son mejores
           que una pantalla que se mueve en horizontal. */
        <p className="m-0 break-words text-[32px] font-bold leading-tight">{valor}</p>
      )}
      {comparacion === undefined ? null : (
        <p className="m-0 text-[12px] font-bold">{comparacion}</p>
      )}
      <p className="m-0 text-[12px] text-muted">{nota}</p>
    </Tarjeta>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 mt-0 text-[17px] font-bold">{titulo}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// La pantalla
// ---------------------------------------------------------------------------

export function Resumen() {
  const [periodo, setPeriodo] = useState<NombrePeriodo>("hoy");
  const estado = useCarga<Datos>(`/api/resumen?periodo=${periodo}`, [periodo]);

  return (
    <div className="grid gap-5">
      {/* El selector va fuera de `Carga` para que al cambiar de periodo no
          desaparezca junto con el contenido: si se va, no hay con qué volver. */}
      <div role="group" aria-label="Qué periodo se mira" className="flex gap-2">
        {(["hoy", "semana"] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={periodo === p}
            onClick={() => setPeriodo(p)}
            className={
              periodo === p ? `${BOTON} bg-accent text-accent-fg` : `${BOTON} border border-line`
            }
          >
            {PALABRAS[p].titulo}
          </button>
        ))}
      </div>

      <Carga estado={estado} que="el resumen">
        {(d) => (
          <div className="grid gap-5">
            {/* De qué se está hablando, antes de cualquier cifra. */}
            <p className="m-0 text-[12px] text-muted">
              {d.periodo.nombre === "hoy"
                ? `Hoy ${diaCorto(d.hoy)}, desde las 12 de la noche`
                : `Del lunes ${diaCorto(d.periodo.desdeFecha)} a hoy ${diaCorto(d.hoy)} (${
                    d.periodo.dias
                  } ${d.periodo.dias === 1 ? "día" : "días"})`}
              {" · hasta las "}
              {new Intl.DateTimeFormat("es-PA", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/Panama",
              }).format(new Date(d.periodo.hasta))}
              {" de Panamá. Lo de antes se compara con la misma ventana corrida hacia atrás."}
            </p>

            {d.atencion === null ? null : (
              <Seccion titulo="Hay que atender">
                <Atender atencion={d.atencion} avisos={d.avisos} />
              </Seccion>
            )}

            {d.inventario === null ? null : (
              <Seccion titulo="Lo que se está acabando">
                <Existencias inventario={d.inventario} />
              </Seccion>
            )}

            {/* Si el rol no ve dinero, esta sección no existe: no se enseña un
                hueco con candado, porque un hueco es una invitación. */}
            {d.dinero === null ? null : (
              <Seccion titulo="El dinero">
                <Plata dinero={d.dinero} periodo={d.periodo.nombre} />
              </Seccion>
            )}

            {d.actividad === null ? null : (
              <Seccion titulo="Lo que se movió">
                <Movimiento actividad={d.actividad} periodo={d.periodo.nombre} />
              </Seccion>
            )}
          </div>
        )}
      </Carga>
    </div>
  );
}

function Atender({
  atencion,
  avisos,
}: {
  atencion: Atencion;
  avisos: { sinPublicar: number; masViejo: number | null };
}) {
  const filas = pendientesDe(atencion, avisos.sinPublicar);

  if (filas.length === 0) {
    // Dos mensajes distintos para dos situaciones distintas. «Todo atendido» en
    // un negocio que todavía no ha recibido su primer pedido es una felicitación
    // por nada, y encima esconde que la pantalla aún no tiene de qué hablar.
    return atencion.pedidosEnTotal === 0 ? (
      <Vacio
        titulo="Todavía no hay pedidos en el sistema"
        detalle="No es que esté todo atendido: es que aún no ha entrado el primer pedido. Cuando entren, esta sección dirá qué espera por usted y qué espera por la clienta."
      />
    ) : (
      <Tarjeta>
        <p className="m-0 font-bold">Nada pendiente</p>
        <p className="m-0 mt-1 text-muted">
          Ningún pedido esperando abono, ningún comprobante sin revisar y ninguna entrega abierta de
          días anteriores. Hay {atencion.pedidosEnTotal}{" "}
          {atencion.pedidosEnTotal === 1 ? "pedido" : "pedidos"} en el sistema.
        </p>
      </Tarjeta>
    );
  }

  return (
    <div className="grid gap-2">
      {filas.map((f) => {
        const destino = destinoDe(f.clave);
        const cuerpo = (
          <>
            <div className="flex items-baseline gap-2">
              <p className="m-0 text-[17px] font-bold">{conteo(f.cuantos, f.que)}</p>
              {/* La pastilla naranja SOLO donde la tarjeta lleva a algún
                  sitio. Con el mismo naranja de todos los botones del panel y
                  sin nada detrás, «Atender hoy» era un botón que no era un
                  botón: se toca, no pasa nada, y la siguiente vez ya no se
                  toca nada. Sin destino se dice con letra, no con pastilla. */}
              {f.urgente ? (
                destino === undefined ? (
                  <span className="text-[12px] font-bold uppercase tracking-wide text-accent-strong">
                    Atender hoy
                  </span>
                ) : (
                  <Pastilla tono="aviso">Atender hoy</Pastilla>
                )
              ) : null}
            </div>
            <p className="m-0 mt-1 text-muted">{f.haga}</p>
            {f.clave === "avisos" && avisos.masViejo !== null ? (
              <p className="m-0 mt-1 text-[12px] text-muted">
                El más viejo lleva esperando desde {sinPuntoFinal(comoFecha(avisos.masViejo))}.
              </p>
            ) : null}
            {destino === undefined ? null : (
              <p className="m-0 mt-2 text-[15px] font-bold text-accent-strong">
                {destino.verbo} →
              </p>
            )}
          </>
        );

        if (destino === undefined) {
          return (
            <Tarjeta key={f.clave} className={f.urgente ? "border-accent-edge" : ""}>
              {cuerpo}
            </Tarjeta>
          );
        }

        // La tarjeta ENTERA es el enlace, no una palabra subrayada al final:
        // se toca con el pulgar, de pie, y un blanco de 44 px en la esquina de
        // una tarjeta de cien es un blanco que se falla.
        return (
          <Link
            key={f.clave}
            to={destino.a}
            className="block rounded-[14px] no-underline focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Tarjeta className={f.urgente ? "border-accent-edge" : ""}>{cuerpo}</Tarjeta>
          </Link>
        );
      })}
    </div>
  );
}

function Existencias({ inventario }: { inventario: Inventario }) {
  if (!inventario.cargado) {
    // El caso de hoy, y el que más fácil se cuenta mal: las filas están en cero
    // porque la migración las creó, no porque se haya vendido todo.
    return (
      <Vacio
        titulo="El inventario todavía no se ha cargado"
        detalle={`Hay ${inventario.filas} combinaciones de talla y bodega listas para recibir mercancía, todas en cero, y ningún movimiento registrado. Por eso aquí no dice «agotado»: nada se ha agotado, nada ha entrado. Se carga con un conteo de verdad, y a partir de ahí cada entrada y cada salida deja su movimiento.`}
      />
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Numero
          etiqueta="Agotadas"
          valor={String(inventario.agotadas)}
          nota={`de ${inventario.filas} combinaciones de talla y bodega activas. Agotada = no queda ni una caja libre.`}
        />
        <Numero
          etiqueta="Por acabarse"
          valor={String(inventario.porAcabarse)}
          nota="llegaron al mínimo que usted puso para esa talla en esa bodega, y todavía queda algo."
        />
        <Numero
          etiqueta="Cajas en bodega"
          valor={String(inventario.unidades)}
          nota={`${inventario.reservadas} están apartadas en pedidos sin entregar y no se pueden vender otra vez.`}
        />
        <Numero
          etiqueta="Sin mínimo puesto"
          valor={String(inventario.sinMinimo)}
          nota="estas filas no avisan nunca de que se están acabando, por mucho que bajen."
        />
      </div>

      {inventario.sinMinimo === inventario.filas ? (
        <Tarjeta className="border-accent-edge">
          <p className="m-0 font-bold">Ninguna fila tiene mínimo puesto</p>
          <p className="m-0 mt-1 text-muted">
            Así que «por acabarse» no puede avisar de nada: solo se enterará cuando algo llegue a
            cero. Poner el mínimo de lo que más se vende es lo que convierte esta pantalla en un
            aviso a tiempo.
          </p>
        </Tarjeta>
      ) : null}

      {inventario.lista.length === 0 ? (
        <Vacio
          titulo="Nada agotado ni por acabarse"
          detalle="Aquí sale lo que no tiene ni una caja libre y lo que llegó al mínimo que usted puso. Lo que no tiene mínimo puesto no avisa nunca."
        />
      ) : (
        <>
          <Rejilla columnas={["Producto", "Bodega", "Quedan", "Mínimo"]}>
            {inventario.lista.map((b) => (
              <Fila key={`${b.codigo}-${b.bodega}`}>
                <Celda etiqueta="">
                  {b.nombre}
                  <span className="block text-[12px] font-normal text-muted">{b.codigo}</span>
                </Celda>
                <Celda etiqueta="Bodega">{b.bodega}</Celda>
                <Celda etiqueta="Quedan" papel="clave">
                  <strong>{b.libres}</strong>
                </Celda>
                <Celda etiqueta="Mínimo" className="text-muted">
                  {b.minimo === null ? "sin poner" : b.minimo}
                </Celda>
              </Fila>
            ))}
          </Rejilla>
          {inventario.listaTruncada ? (
            <p className="m-0 text-[12px] text-muted">
              Son las {inventario.lista.length} con menos existencias, y hay más. La lista completa
              está en Existencias.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Plata({ dinero: d, periodo }: { dinero: Dinero; periodo: NombrePeriodo }) {
  const ticket = promedio(d.entregado.total, d.entregado.pedidos);

  // La serie viene vacía solo cuando NUNCA ha habido un pedido, y sin pedidos
  // no puede haber pagos. Cuatro tarjetas en $0.00 serían ciertas y se leerían
  // como «hoy no vendió nada», que es otra cosa: lo que pasa es que el sistema
  // todavía no tiene de qué hablar.
  if (d.serie.length === 0) {
    return (
      <Vacio
        titulo="Todavía no ha entrado dinero por el sistema"
        detalle="No es que hoy no haya entrado nada: es que aún no hay ningún pedido registrado, así que no hay pagos que sumar ni entregas que contar. Cuando entre el primero, aquí sale lo que entró, lo que se entregó, lo que falta por cobrar y el pedido promedio."
      />
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Numero
          etiqueta="Entró"
          valor={dinero(d.entro)}
          comparacion={textoDeComparacion(comparar(d.entro, d.entroAnterior), periodo)}
          nota="pagos aprobados en esta ventana. Es caja que entró, no ventas: un abono de un pedido que no ha salido todavía es un anticipo."
        />
        <Numero
          etiqueta="Entregado"
          valor={dinero(d.entregado.total)}
          comparacion={textoDeComparacion(
            comparar(d.entregado.total, d.entregadoAnterior.total),
            periodo,
          )}
          nota={`${d.entregado.pedidos} ${
            d.entregado.pedidos === 1 ? "pedido entregado" : "pedidos entregados"
          } en esta ventana, por el total del pedido. Sale de la bitácora, así que una devolución de mañana no cambia esta cifra.${
            d.devueltos > 0
              ? ` ${d.devueltos} ${d.devueltos === 1 ? "devolución" : "devoluciones"} en la ventana.`
              : ""
          }`}
        />
        <Numero
          etiqueta="Por cobrar"
          valor={dinero(d.porCobrar.total)}
          nota={`saldo de ${d.porCobrar.pedidos} ${
            d.porCobrar.pedidos === 1 ? "pedido ya entregado" : "pedidos ya entregados"
          }, al día de hoy y no de la ventana. Lo abonado de un pedido sin entregar no cuenta aquí.`}
        />
        <Numero
          etiqueta="Pedido promedio"
          valor={ticket.hay ? dinero(ticket.valor.valor) : null}
          nota={
            ticket.hay
              ? ticket.valor.pocos
                ? `son solo ${ticket.valor.n} ${
                    ticket.valor.n === 1 ? "pedido" : "pedidos"
                  }: sirve para mirarlo, no para sacar una costumbre del negocio.`
                : `de ${ticket.valor.n} pedidos entregados en la ventana.`
              : "no se entregó ningún pedido en esta ventana, así que no hay promedio que sacar. No es cero."
          }
        />
      </div>

      {d.pagosSinFecha > 0 ? (
        <Tarjeta className="border-accent-edge">
          <p className="m-0 font-bold">
            {d.pagosSinFecha} {d.pagosSinFecha === 1 ? "pago aprobado" : "pagos aprobados"} sin hora
            de confirmación
          </p>
          <p className="m-0 mt-1 text-muted">
            No se pueden ubicar en ningún día, así que no están sumados arriba ni en el gráfico.
            Ponerlos en un día cualquiera sería inventarse la fecha. Avísele a Juan.
          </p>
        </Tarjeta>
      ) : null}

      <Tarjeta>
        <p className="m-0 mb-2 text-[12px] uppercase tracking-wide text-muted">
          Lo que entró cada día
        </p>
        {/* Con pocos días, un gráfico de dos puntos siempre parece una
            tendencia: no se dibuja, y se dice por qué. Es el caso de hoy. */}
        {mereceGrafico(d.serie.map((x) => x.centavos)) ? (
          <Grafico serie={d.serie} />
        ) : (
          <p className="m-0 text-muted">
            {d.serie.length === 0
              ? "Todavía no hay pedidos, así que no hay días que dibujar. En cuanto empiecen a entrar pagos, aquí sale un día por barra."
              : `Hay ${d.serie.length} ${
                  d.serie.length === 1 ? "día" : "días"
                } de historia y muy pocos con movimiento. Un gráfico de dos puntos siempre parece una tendencia, así que todavía no se dibuja.`}
          </p>
        )}
      </Tarjeta>
    </div>
  );
}

function Movimiento({
  actividad,
  periodo,
}: {
  actividad: Actividad;
  periodo: NombrePeriodo;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <Numero
        etiqueta="Pedidos nuevos"
        valor={String(actividad.pedidosNuevos)}
        comparacion={textoDeComparacion(
          comparar(actividad.pedidosNuevos, actividad.pedidosNuevosAnterior),
          periodo,
        )}
        nota="pedidos creados en esta ventana, de cualquier canal y en cualquier estado. Uno cancelado también se creó."
      />
      <Numero
        etiqueta="Clientas nuevas"
        valor={String(actividad.clientasNuevas)}
        comparacion={textoDeComparacion(
          comparar(actividad.clientasNuevas, actividad.clientasNuevasAnterior),
          periodo,
        )}
        nota="registradas en esta ventana. Una clienta fusionada con otra no se cuenta dos veces."
      />
      {/* Esta no lleva comparación: es un total que solo crece, y ponerle un
          «más que la semana pasada» sería decir una obviedad con cara de dato. */}
      <Cifra
        etiqueta="Clientas en total"
        valor={String(actividad.clientasEnTotal)}
        nota="registradas, sin contar las anonimizadas ni las fusionadas"
      />
    </div>
  );
}
