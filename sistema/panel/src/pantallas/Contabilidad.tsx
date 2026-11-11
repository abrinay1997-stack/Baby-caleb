import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, dinero, pedir, useCarga } from "../api";
import { Carga, Celda, Cifra, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { Hoja } from "../armazon/Hoja";
import { puedeEditar } from "../permisos";
import {
  type Atajo,
  type Hecho,
  ATAJOS,
  ETIQUETAS_ATAJO,
  ETIQUETAS_HECHO,
  ETIQUETAS_TRAMO,
  TRAMOS,
  fechaContable,
  rangoDeAtajo,
} from "../../../src/dominio/contabilidad";

/**
 * La pantalla de la contadora.
 *
 * **Se usa casi siempre desde un teléfono** (el dueño lo dijo: 95 % de las
 * veces). Las medidas son las del §7 del sistema de diseño, que es contrato:
 * campos a 16 px, lo que se toca a 44 px, nada de texto por debajo de 12 px, ni
 * `min-width` en píxeles ni `100vh`. Las piezas salen de `componentes.tsx` y la
 * hoja de `armazon/Hoja.tsx`; aquí no se inventa ninguna variante.
 *
 * ## Las tres decisiones que mandan sobre el resto
 *
 * **1. Cada cifra puede decir de qué asiento viene.** Toda cuenta de la lista
 * de dinero es un botón que abre sus apuntes, y cada apunte lleva el id de su
 * asiento. Una cifra que no puede decir de dónde sale invita a creérsela, y en
 * un libro eso es exactamente lo que no se quiere.
 *
 * **2. Lo que falta por decidir se VE, y se ve distinto de un cero.** Un cero
 * es una cifra: dice «no hubo». `PENDIENTE` dice «nadie lo ha decidido». Van en
 * pastilla, nunca como un 0 más, y con el nombre de quien tiene que darlo.
 *
 * **3. Cada tarjeta dice si es un saldo o un movimiento** (05 §5): un saldo es
 * «al día X» y un movimiento es «del X al Y». Mezclarlos es como se acaba
 * comparando el dinero que hay en el banco con las ventas de una semana.
 *
 * ## Lo que esta pantalla NO hace, y por qué
 *
 * No escribe asientos a mano. La contadora puede (`roles.ts` le da
 * `contabilidad: "editar"`), y el servidor lo acepta, pero un formulario de
 * partida doble en un teléfono —varias líneas, cada una con cuenta, debe y
 * haber— es la forma más fácil de meter un asiento torcido con el pulgar. Lo
 * que sí hace es CORREGIR: un asiento equivocado se revierte con su motivo, que
 * es el 95 % de lo que hace falta y no se puede hacer mal.
 */

const BOTON =
  "tactil rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";
const PRINCIPAL = `${BOTON} bg-accent text-accent-fg`;
const SUAVE = `${BOTON} border border-line`;
const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

// ---------------------------------------------------------------------------
// Lo que contesta el servidor
// ---------------------------------------------------------------------------

interface CuentaConSaldo {
  codigo: string;
  nombre: string;
  saldoCents: number;
}

interface Resultados {
  ventasCents: number;
  devolucionesCents: number;
  costoDeVentasCents: number;
  mermasCents: number;
  gananciaBrutaCents: number;
  ingresosEnvioCents: number;
  gastosCents: number;
  gananciaNetaCents: number;
  margenBrutoBp: number | null;
  entregasSinCosto: number;
  porCuenta: { codigo: string; nombre: string; tipo: string; saldoCents: number }[];
}

interface Balance {
  activoCents: number;
  pasivoCents: number;
  patrimonioCents: number;
  resultadoCents: number;
  diferenciaCents: number;
  cuadra: boolean;
}

interface Hueco {
  clave: string;
  que: string;
  quien: string;
  sinEsto: string;
  fuente: string;
  estado: "abierto" | "resuelto" | "lo_dice_una_persona";
  nota: string | null;
}

interface DatosResumen {
  resumen: {
    desde: string;
    hasta: string;
    dinero: CuentaConSaldo[];
    dineroTotalCents: number;
    teDebenCents: number;
    debesCents: number;
    inventarioCents: number;
    resultados: Resultados;
    balance: Balance;
    asientos: number;
    asientosSinCuadre: number;
    cajasConSaldo: CuentaConSaldo[];
  };
  huecos: Hueco[];
}

interface LineaDelLibro {
  codigo: string;
  cuenta: string;
  debeCents: number;
  haberCents: number;
  detalle: string | null;
}

interface AsientoDelLibro {
  id: string;
  fecha: string;
  descripcion: string;
  origen: string;
  hecho: Hecho;
  referenciaTipo: string | null;
  referenciaId: string | null;
  revierteId: string | null;
  revertido: boolean;
  creadoPor: string;
  totalCents: number;
  lineas: LineaDelLibro[];
}

interface ApunteDeMayor {
  asientoId: string;
  fecha: string;
  descripcion: string;
  hecho: Hecho;
  debeCents: number;
  haberCents: number;
  detalle: string | null;
}

interface Casilla {
  clave: string;
  titulo: string;
  estado: "ok" | "falta" | "aviso" | "no_se_puede_comprobar";
  detalle: string;
}

interface Cierre {
  mes: string;
  estadoDelMes: "abierto" | "cerrado";
  casillas: Casilla[];
  sePuedeCerrar: boolean;
  mesTerminado: boolean;
}

interface Deuda {
  pedidoId: string;
  numero: string;
  cliente: string | null;
  saldoCents: number;
  entregadoEl: string;
  dias: number;
  tramo: (typeof TRAMOS)[number];
}

interface PorCobrar {
  al: string;
  totalCents: number;
  porTramo: Record<string, number>;
  deudas: Deuda[];
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

/** Un día en palabras, en hora de Panamá. */
const comoDia = (f: string): string => {
  const [a, m, d] = f.split("-");
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${Number(d)} ${meses[Number(m) - 1] ?? m} ${a}`;
};

/**
 * Qué periodo cubre una tarjeta, dicho con palabras.
 *
 * No es decoración: es la regla de fechas de 05 §5. Una tarjeta que no dice si
 * es un saldo o un movimiento es una invitación a sumar lo que no se suma.
 */
function Periodo({ alcance, desde, hasta }: { alcance: "saldo" | "movimiento"; desde: string; hasta: string }) {
  return (
    <p className="m-0 text-[12px] text-muted">
      {alcance === "saldo" ? `Al ${comoDia(hasta)}` : `Del ${comoDia(desde)} al ${comoDia(hasta)}`}
    </p>
  );
}

/** Una línea del estado de resultados. Las que restan llevan el signo delante. */
function Renglon({
  que,
  montoCents,
  resta = false,
  fuerte = false,
}: {
  que: string;
  montoCents: number;
  resta?: boolean;
  fuerte?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0 ${
        fuerte ? "font-bold" : ""
      }`}
    >
      <span>{que}</span>
      <span className="whitespace-nowrap">
        {resta ? "− " : ""}
        {dinero(montoCents)}
      </span>
    </div>
  );
}

const TONO_CASILLA = {
  ok: "bien",
  falta: "mal",
  aviso: "aviso",
  no_se_puede_comprobar: "neutro",
} as const;

const PALABRA_CASILLA = {
  ok: "Listo",
  falta: "Falta",
  aviso: "Mírelo",
  no_se_puede_comprobar: "Todavía no",
} as const;

// ---------------------------------------------------------------------------
// La pantalla
// ---------------------------------------------------------------------------

type Seccion = "resumen" | "libro" | "cierre";

export function Contabilidad() {
  const yo = useOutletContext<Yo>();
  const [seccion, setSeccion] = useState<Seccion>("resumen");
  const [atajo, setAtajo] = useState<Atajo>("mes");
  const [recarga, setRecarga] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const [mirando, setMirando] = useState<CuentaConSaldo | null>(null);

  // El rango lo calcula el MISMO código que usa el servidor
  // (`src/dominio/contabilidad.ts`), igual que los permisos. Dos formas de
  // decidir qué es «esta quincena» acaban discrepando, y la que se equivoca es
  // la que nadie revisa.
  const rango = rangoDeAtajo(atajo, Date.now());

  const puedeCorregir = puedeEditar(yo.usuario.rol, "contabilidad");
  const puedeCerrar = puedeEditar(yo.usuario.rol, "cierre_de_mes");

  const refrescar = () => setRecarga((n) => n + 1);

  async function accion(ruta: string, cuerpo?: unknown) {
    setAviso(null);
    try {
      await pedir(ruta, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo ?? {}),
      });
      refrescar();
    } catch (e) {
      setAviso((e as Error).message);
    }
  }

  return (
    <div className="grid gap-4">
      {/* Las tres partes. Botones con `aria-pressed` y no una barra de
          pestañas: una barra de verdad exige navegar con las flechas del
          teclado, y un contrato a medias es peor que no tenerlo. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Qué parte de la contabilidad">
        {(
          [
            ["resumen", "Resumen"],
            ["libro", "Libro"],
            ["cierre", "Cierre de mes"],
          ] as [Seccion, string][]
        ).map(([valor, texto]) => (
          <button
            key={valor}
            type="button"
            aria-pressed={seccion === valor}
            onClick={() => setSeccion(valor)}
            // El estado no se dice solo con color: el activo va en negrita y
            // subrayado, y `aria-pressed` lo dice al lector de pantalla.
            className={`${SUAVE} ${
              seccion === valor ? "bg-surface underline decoration-2 underline-offset-4" : "font-normal"
            }`}
          >
            {texto}
          </button>
        ))}
      </div>

      {aviso === null ? null : (
        <Tarjeta className="border-accent-edge">
          <p role="alert" className="m-0 font-bold">
            No se pudo hacer
          </p>
          <p className="m-0 mt-1 text-muted">{aviso}</p>
        </Tarjeta>
      )}

      {seccion === "cierre" ? (
        <CierreDeMes puedeCerrar={puedeCerrar} recarga={recarga} accion={accion} />
      ) : (
        <>
          {/* El periodo, arriba y al alcance del pulgar: es lo que más se
              cambia en esta pantalla. */}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Periodo">
            {ATAJOS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={atajo === a}
                onClick={() => setAtajo(a)}
                className={`${SUAVE} ${
                  atajo === a ? "bg-surface underline decoration-2 underline-offset-4" : "font-normal"
                }`}
              >
                {ETIQUETAS_ATAJO[a]}
              </button>
            ))}
          </div>

          {seccion === "resumen" ? (
            <SeccionResumen
              rango={rango}
              recarga={recarga}
              alMirarCuenta={(c) => setMirando(c)}
            />
          ) : (
            <SeccionLibro
              rango={rango}
              recarga={recarga}
              puedeCorregir={puedeCorregir}
              accion={accion}
            />
          )}
        </>
      )}

      {mirando === null ? null : (
        <HojaDeMayor cuenta={mirando} rango={rango} alCerrar={() => setMirando(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

function SeccionResumen({
  rango,
  recarga,
  alMirarCuenta,
}: {
  rango: { desde: string; hasta: string };
  recarga: number;
  alMirarCuenta: (c: CuentaConSaldo) => void;
}) {
  const estado = useCarga<DatosResumen>(
    `/api/contabilidad?desde=${rango.desde}&hasta=${rango.hasta}`,
    [rango.desde, rango.hasta, recarga],
  );

  return (
    <Carga estado={estado} que="la contabilidad">
      {({ resumen: r, huecos }) => {
        const faltan = huecos.filter((h) => h.estado !== "resuelto");

        return (
          <div className="grid gap-4">
            {/* Un asiento sin su fila de cuadre se escribió por fuera del
                camino normal. Va primero porque es lo único de esta pantalla
                que no tiene explicación posible. */}
            {r.asientosSinCuadre > 0 ? (
              <Tarjeta className="border-accent-edge">
                <p role="alert" className="m-0 font-bold">
                  {r.asientosSinCuadre} asiento{r.asientosSinCuadre === 1 ? "" : "s"} sin su cuadre
                </p>
                <p className="m-0 mt-1 text-muted">
                  Se escribieron por fuera del camino normal del sistema, así que no hay garantía de
                  que cuadren. Avísele a Juan antes de cerrar el mes.
                </p>
              </Tarjeta>
            ) : null}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Cifra
                etiqueta="Dinero en cuentas"
                valor={dinero(r.dineroTotalCents)}
                nota={`Al ${comoDia(r.hasta)}`}
              />
              <Cifra
                etiqueta="Te deben"
                valor={dinero(r.teDebenCents)}
                nota={`Al ${comoDia(r.hasta)}`}
              />
              <Cifra
                etiqueta="Ganancia neta"
                valor={dinero(r.resultados.gananciaNetaCents)}
                nota={`Del ${comoDia(r.desde)} al ${comoDia(r.hasta)}`}
              />
              <Cifra
                etiqueta="Ventas"
                valor={dinero(r.resultados.ventasCents)}
                nota={`Del ${comoDia(r.desde)} al ${comoDia(r.hasta)}`}
              />
              {/* Estas dos las calculaba el servidor y la pantalla las tiraba:
                  estaban declaradas en el tipo y no se pintaban en ningún
                  sitio. Y son de las que más dicen.

                  «Usted debe» es lo abonado por pedidos que todavía no han
                  salido: dinero que está en la cuenta y NO es suyo. Verlo
                  junto a «dinero en cuentas» es lo que evita gastarlo.

                  El inventario en NEGATIVO es la señal de que falta el asiento
                  de apertura: salió mercancía que nunca entró en los libros.
                  Mientras eso pase, el número es feo a propósito y tiene que
                  verse, porque es lo que hay que arreglar antes de usar esto
                  en serio. */}
              <Cifra
                etiqueta="Usted debe"
                valor={dinero(r.debesCents)}
                nota="Abonos de pedidos que no han salido"
              />
              <Cifra
                etiqueta="Inventario"
                valor={dinero(r.inventarioCents)}
                nota={
                  r.inventarioCents < 0
                    ? "En negativo: falta el asiento de apertura"
                    : `Al ${comoDia(r.hasta)}`
                }
              />
            </div>

            <Tarjeta>
              <h2 className="m-0 text-[17px] font-bold">Dónde está el dinero</h2>
              <Periodo alcance="saldo" desde={r.desde} hasta={r.hasta} />
              <p className="mb-3 mt-2 text-[12px] text-muted">
                Toque una cuenta para ver de qué asientos sale su saldo.
              </p>
              {r.dinero.length === 0 ? (
                <p className="m-0 text-muted">Todavía no hay ninguna cuenta con movimientos.</p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {r.dinero.map((c) => (
                    <li key={c.codigo} className="border-b border-line last:border-0">
                      <button
                        type="button"
                        onClick={() => alMirarCuenta(c)}
                        className="tactil flex w-full cursor-pointer items-baseline justify-between gap-3 border-0 bg-transparent px-0 py-3 text-left text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
                      >
                        <span>
                          <span className="block font-bold underline decoration-line underline-offset-4">
                            {c.nombre}
                          </span>
                          <span className="block text-[12px] text-muted">Cuenta {c.codigo}</span>
                        </span>
                        <span className="whitespace-nowrap font-bold">{dinero(c.saldoCents)}</span>
                        <span className="sr-only">— ver sus apuntes</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {r.cajasConSaldo.length > 0 ? (
                <p className="m-0 mt-3 text-muted">
                  Además hay efectivo en la calle:{" "}
                  {r.cajasConSaldo.map((c) => `${c.nombre} (${dinero(c.saldoCents)})`).join(", ")}.
                  Mientras un motorizado no liquide, ese dinero es suyo pero no está en ninguna
                  cuenta.
                </p>
              ) : null}
            </Tarjeta>

            <Tarjeta>
              <h2 className="m-0 text-[17px] font-bold">Cuánto ganó</h2>
              <Periodo alcance="movimiento" desde={r.desde} hasta={r.hasta} />
              <div className="mt-3">
                <Renglon que="Ventas" montoCents={r.resultados.ventasCents} />
                <Renglon
                  que="Devoluciones y descuentos"
                  montoCents={r.resultados.devolucionesCents}
                  resta
                />
                <Renglon que="Costo de lo vendido" montoCents={r.resultados.costoDeVentasCents} resta />
                <Renglon que="Mermas, muestras y regalos" montoCents={r.resultados.mermasCents} resta />
                <Renglon que="Ganancia bruta" montoCents={r.resultados.gananciaBrutaCents} fuerte />
                <Renglon que="Cobrado por envíos" montoCents={r.resultados.ingresosEnvioCents} />
                <Renglon que="Gastos" montoCents={r.resultados.gastosCents} resta />
                <Renglon que="Ganancia neta" montoCents={r.resultados.gananciaNetaCents} fuerte />
              </div>

              <div className="mt-3 flex items-center gap-2">
                <span className="text-[12px] uppercase tracking-wide text-muted">Margen bruto</span>
                {r.resultados.margenBrutoBp === null ? (
                  // Pastilla y no un número: al lado de un porcentaje tiene que
                  // verse que esto NO es un valor, es un dato que falta.
                  <Pastilla tono="aviso">No se puede saber</Pastilla>
                ) : (
                  <strong>{(r.resultados.margenBrutoBp / 100).toFixed(2)} %</strong>
                )}
              </div>
              {r.resultados.entregasSinCosto > 0 ? (
                <p className="m-0 mt-2 text-muted">
                  {r.resultados.entregasSinCosto} pedido
                  {r.resultados.entregasSinCosto === 1 ? "" : "s"} de este periodo se entregó sin
                  saber lo que costó la mercancía, así que el margen saldría altísimo por lo que
                  falta y no por lo que se ganó. Falta el costo de apertura de esas tallas, y lo pone
                  la contadora con la factura del proveedor.
                </p>
              ) : null}
            </Tarjeta>

            <Tarjeta>
              <h2 className="m-0 text-[17px] font-bold">Balance</h2>
              <Periodo alcance="saldo" desde={r.desde} hasta={r.hasta} />
              <div className="mt-3">
                <Renglon que="Lo que tiene (activos)" montoCents={r.balance.activoCents} />
                <Renglon que="Lo que debe (pasivos)" montoCents={r.balance.pasivoCents} />
                <Renglon que="Capital y resultados de antes" montoCents={r.balance.patrimonioCents} />
                <Renglon que="Lo ganado en el ejercicio" montoCents={r.balance.resultadoCents} />
              </div>
              <p className="m-0 mt-3">
                {r.balance.cuadra ? (
                  <Pastilla tono="bien">Cuadra</Pastilla>
                ) : (
                  <Pastilla tono="mal">
                    No cuadra: faltan {dinero(Math.abs(r.balance.diferenciaCents))}
                  </Pastilla>
                )}
              </p>
              {r.balance.cuadra ? null : (
                <p className="m-0 mt-2 text-muted">
                  Lo que tiene tendría que ser igual a lo que debe más su capital más lo ganado. Si
                  no lo es, falta un asiento. Avísele a Juan: el mes no se puede cerrar así.
                </p>
              )}
            </Tarjeta>

            <PorCobrarTarjeta al={r.hasta} recarga={recarga} />

            <Tarjeta className={faltan.length > 0 ? "border-accent-edge" : ""}>
              <h2 className="m-0 text-[17px] font-bold">Lo que falta por decidir</h2>
              <p className="m-0 mt-1 text-muted">
                El sistema no rellena ninguno de estos datos. Mientras falten, lo que dependa de
                ellos no se enciende — que es mejor que trabajar con un número inventado.
              </p>
              {faltan.length === 0 ? (
                <p className="m-0 mt-3">
                  <Pastilla tono="bien">No falta nada</Pastilla>
                </p>
              ) : (
                <ul className="m-0 mt-3 list-none p-0">
                  {faltan.map((h) => (
                    <li key={h.clave} className="border-b border-line py-3 last:border-0">
                      <p className="m-0 font-bold">{h.que}</p>
                      <p className="m-0 mt-1">
                        <Pastilla tono="aviso">PENDIENTE</Pastilla>{" "}
                        <span className="text-muted">Lo tiene que dar: {h.quien}</span>
                      </p>
                      <p className="m-0 mt-1 text-[12px] text-muted">
                        {h.sinEsto}
                        {h.nota === null ? "" : ` Hoy: ${h.nota}.`} ({h.fuente})
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Tarjeta>
          </div>
        );
      }}
    </Carga>
  );
}

function PorCobrarTarjeta({ al, recarga }: { al: string; recarga: number }) {
  const estado = useCarga<PorCobrar>(`/api/contabilidad/por-cobrar?al=${al}`, [al, recarga]);

  return (
    <Carga estado={estado} que="lo que le deben">
      {(d) => (
        <Tarjeta>
          <h2 className="m-0 text-[17px] font-bold">Quién le debe</h2>
          <Periodo alcance="saldo" desde={d.al} hasta={d.al} />
          {d.deudas.length === 0 ? (
            <p className="m-0 mt-2 text-muted">
              Nadie: todos los pedidos entregados están cobrados.
            </p>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {TRAMOS.map((t) => (
                  <div key={t} className="rounded-[12px] border border-line p-2">
                    <p className="m-0 text-[12px] text-muted">{ETIQUETAS_TRAMO[t]}</p>
                    <p className="m-0 font-bold">{dinero(d.porTramo[t] ?? 0)}</p>
                  </div>
                ))}
              </div>
              <p className="mb-2 mt-3 font-bold">Total: {dinero(d.totalCents)}</p>
              <Rejilla columnas={["Clienta", "Pedido", "Entregado", "Debe"]}>
                {d.deudas.map((x) => (
                  <Fila key={x.pedidoId}>
                    <Celda etiqueta="">{x.cliente ?? "Sin nombre"}</Celda>
                    <Celda etiqueta="Pedido">{x.numero}</Celda>
                    <Celda etiqueta="Entregado">
                      {comoDia(x.entregadoEl)} · hace {x.dias} día{x.dias === 1 ? "" : "s"}
                    </Celda>
                    <Celda etiqueta="Debe" papel="clave">
                      <strong>{dinero(x.saldoCents)}</strong>
                    </Celda>
                  </Fila>
                ))}
              </Rejilla>
            </>
          )}
        </Tarjeta>
      )}
    </Carga>
  );
}

// ---------------------------------------------------------------------------
// Libro
// ---------------------------------------------------------------------------

function SeccionLibro({
  rango,
  recarga,
  puedeCorregir,
  accion,
}: {
  rango: { desde: string; hasta: string };
  recarga: number;
  puedeCorregir: boolean;
  accion: (ruta: string, cuerpo?: unknown) => Promise<void>;
}) {
  const estado = useCarga<{ asientos: AsientoDelLibro[] }>(
    `/api/contabilidad/diario?desde=${rango.desde}&hasta=${rango.hasta}`,
    [rango.desde, rango.hasta, recarga],
  );
  // El motivo se pide EN LA PÁGINA y no con `prompt()`: en algunos navegadores
  // de teléfono `prompt` no aparece, y ahí el botón no haría nada sin decir por
  // qué.
  const [corrigiendo, setCorrigiendo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");

  return (
    <Carga estado={estado} que="el libro">
      {(d) =>
        d.asientos.length === 0 ? (
          <Vacio
            titulo="Ningún apunte en este periodo"
            detalle="Aquí sale cada asiento con sus dos columnas: de dónde salió el dinero y a dónde fue. Se llena solo, con cada pago, cada entrega y cada gasto."
          />
        ) : (
          <div className="grid gap-3">
            {d.asientos.map((a) => (
              <Tarjeta key={a.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="row-grow">
                    <p className="m-0 font-bold">{a.descripcion}</p>
                    <p className="m-0 text-[12px] text-muted">
                      {comoDia(a.fecha)} · Asiento {a.hecho === "manual" ? "a mano" : a.hecho}:{" "}
                      {ETIQUETAS_HECHO[a.hecho]} · lo registró {a.creadoPor}
                    </p>
                  </div>
                  <p className="m-0 whitespace-nowrap font-bold">{dinero(a.totalCents)}</p>
                </div>

                {a.revierteId === null ? null : (
                  <p className="m-0 mt-2">
                    <Pastilla tono="neutro">Corrige a otro asiento</Pastilla>
                  </p>
                )}
                {a.revertido ? (
                  <p className="m-0 mt-2">
                    <Pastilla tono="aviso">Ya corregido</Pastilla>
                  </p>
                ) : null}

                <details className="mt-3 rounded-[12px] border border-line p-3">
                  <summary className="tactil flex cursor-pointer items-center font-bold">
                    Las dos columnas
                  </summary>
                  <ul className="m-0 mt-2 list-none p-0">
                    {a.lineas.map((l, i) => (
                      <li
                        key={`${a.id}-${i}`}
                        className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-0"
                      >
                        <span className="row-grow">
                          <span className="block">{l.cuenta}</span>
                          <span className="block text-[12px] text-muted">
                            Cuenta {l.codigo}
                            {l.detalle === null ? "" : ` · ${l.detalle}`}
                          </span>
                        </span>
                        <span className="whitespace-nowrap">
                          {l.debeCents > 0
                            ? `Debe ${dinero(l.debeCents)}`
                            : `Haber ${dinero(l.haberCents)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="m-0 mt-2 text-[12px] text-muted">
                    Referencia del asiento: {a.id}
                    {a.referenciaId === null
                      ? ""
                      : ` · ${a.referenciaTipo ?? "referencia"} ${a.referenciaId}`}
                  </p>
                </details>

                {puedeCorregir && !a.revertido && a.revierteId === null ? (
                  corrigiendo === a.id ? (
                    <div className="mt-3 grid gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[14px] font-bold">
                          ¿Por qué se corrige este asiento?
                        </span>
                        <input
                          type="text"
                          value={motivo}
                          onChange={(ev) => setMotivo(ev.target.value)}
                          placeholder="Estaba cargado al mes equivocado"
                          className={ENTRADA}
                        />
                      </label>
                      <p className="m-0 text-[12px] text-muted">
                        No se borra nada: se registra el asiento contrario, con la fecha de hoy y su
                        motivo. Los dos quedan en el libro.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={motivo.trim() === ""}
                          className={`${PRINCIPAL} row-grow`}
                          onClick={() => {
                            const m = motivo.trim();
                            setCorrigiendo(null);
                            setMotivo("");
                            void accion(`/api/contabilidad/asientos/${a.id}/reverso`, { motivo: m });
                          }}
                        >
                          Registrar el contrario
                        </button>
                        <button
                          type="button"
                          className={SUAVE}
                          onClick={() => {
                            setCorrigiendo(null);
                            setMotivo("");
                          }}
                        >
                          Dejarlo
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`${SUAVE} mt-3 w-full md:w-auto`}
                      onClick={() => setCorrigiendo(a.id)}
                    >
                      Corregir
                      <span className="sr-only"> el asiento «{a.descripcion}»</span>
                    </button>
                  )
                ) : null}
              </Tarjeta>
            ))}
          </div>
        )
      }
    </Carga>
  );
}

/** Los apuntes de una cuenta: de aquí sale su saldo, asiento por asiento. */
function HojaDeMayor({
  cuenta,
  rango,
  alCerrar,
}: {
  cuenta: CuentaConSaldo;
  rango: { desde: string; hasta: string };
  alCerrar: () => void;
}) {
  const estado = useCarga<{ codigo: string; nombre: string; apuntes: ApunteDeMayor[] }>(
    `/api/contabilidad/cuentas/${cuenta.codigo}?desde=${rango.desde}&hasta=${rango.hasta}`,
    [cuenta.codigo, rango.desde, rango.hasta],
  );

  return (
    <Hoja abierta titulo={`${cuenta.nombre} (${cuenta.codigo})`} alCerrar={alCerrar}>
      <p className="m-0 mb-3 text-muted">
        Los apuntes del {comoDia(rango.desde)} al {comoDia(rango.hasta)}. El saldo que ve en la
        pantalla sale de aquí.
      </p>
      <Carga estado={estado} que="los apuntes">
        {(d) =>
          d.apuntes.length === 0 ? (
            <p className="m-0 text-muted">Ningún apunte en este periodo.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {d.apuntes.map((ap) => (
                <li key={ap.asientoId} className="border-b border-line py-3 last:border-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="row-grow font-bold">{ap.descripcion}</span>
                    <span className="whitespace-nowrap">
                      {ap.debeCents > 0
                        ? `Debe ${dinero(ap.debeCents)}`
                        : `Haber ${dinero(ap.haberCents)}`}
                    </span>
                  </div>
                  <p className="m-0 mt-1 text-[12px] text-muted">
                    {comoDia(ap.fecha)} · Asiento {ap.hecho === "manual" ? "a mano" : ap.hecho}:{" "}
                    {ETIQUETAS_HECHO[ap.hecho]}
                    {ap.detalle === null ? "" : ` · ${ap.detalle}`}
                  </p>
                  {/* La referencia completa: es lo que se dicta por teléfono
                      cuando un número no cuadra. */}
                  <p className="m-0 text-[12px] text-muted">Referencia: {ap.asientoId}</p>
                </li>
              ))}
            </ul>
          )
        }
      </Carga>
    </Hoja>
  );
}

// ---------------------------------------------------------------------------
// Cierre de mes
// ---------------------------------------------------------------------------

function CierreDeMes({
  puedeCerrar,
  recarga,
  accion,
}: {
  puedeCerrar: boolean;
  recarga: number;
  accion: (ruta: string, cuerpo?: unknown) => Promise<void>;
}) {
  // El mes pasado por defecto: el mes que se cierra es el que terminó.
  const [mes, setMes] = useState(() => {
    const hoy = fechaContable(Date.now());
    const a = Number(hoy.slice(0, 4));
    const m = Number(hoy.slice(5, 7));
    return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
  });
  const [motivo, setMotivo] = useState("");
  const [reabriendo, setReabriendo] = useState(false);

  const estado = useCarga<Cierre>(`/api/contabilidad/cierre?mes=${mes}`, [mes, recarga]);

  return (
    <div className="grid gap-4">
      <Tarjeta>
        <label className="block">
          <span className="mb-1 block text-[14px] font-bold">Qué mes</span>
          <input
            type="month"
            value={mes}
            onChange={(ev) => setMes(ev.target.value)}
            className={ENTRADA}
          />
        </label>
      </Tarjeta>

      <Carga estado={estado} que="la lista del cierre">
        {(c) => (
          <div className="grid gap-4">
            <Tarjeta>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="m-0 text-[17px] font-bold">
                  {c.mes}
                  <span className="sr-only"> — estado del mes</span>
                </h2>
                {c.estadoDelMes === "cerrado" ? (
                  <Pastilla tono="bien">Cerrado</Pastilla>
                ) : (
                  <Pastilla tono="neutro">Abierto</Pastilla>
                )}
              </div>
              <p className="m-0 mt-2 text-muted">
                {c.estadoDelMes === "cerrado"
                  ? "Ningún asiento puede llevar fecha de este mes. Para registrar algo que faltaba, hay que reabrirlo, y reabrir pide un motivo que queda escrito."
                  : "Mientras el mes esté abierto se le pueden seguir registrando asientos."}
              </p>
            </Tarjeta>

            <Tarjeta>
              <h2 className="m-0 text-[17px] font-bold">Antes de cerrar</h2>
              <ul className="m-0 mt-3 list-none p-0">
                {c.casillas.map((x) => (
                  <li key={x.clave} className="border-b border-line py-3 last:border-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="row-grow font-bold">{x.titulo}</span>
                      <Pastilla tono={TONO_CASILLA[x.estado]}>{PALABRA_CASILLA[x.estado]}</Pastilla>
                    </div>
                    <p className="m-0 mt-1 text-[12px] text-muted">{x.detalle}</p>
                  </li>
                ))}
              </ul>
            </Tarjeta>

            {puedeCerrar ? (
              <Tarjeta>
                {c.estadoDelMes === "abierto" ? (
                  <>
                    <button
                      type="button"
                      className={`${PRINCIPAL} w-full md:w-auto`}
                      disabled={!c.sePuedeCerrar || !c.mesTerminado}
                      onClick={() => void accion("/api/contabilidad/cierre", { mes: c.mes })}
                    >
                      Cerrar {c.mes}
                    </button>
                    {c.mesTerminado ? null : (
                      <p className="m-0 mt-2 text-muted">
                        Este mes todavía no ha terminado. Cerrarlo ahora dejaría los días que quedan
                        sin poder registrar nada.
                      </p>
                    )}
                    {c.mesTerminado && !c.sePuedeCerrar ? (
                      <p className="m-0 mt-2 text-muted">
                        Hay casillas en rojo arriba. Se cierran primero: cerrar el mes con algo sin
                        resolver deja el problema dentro y bloqueado.
                      </p>
                    ) : null}
                  </>
                ) : reabriendo ? (
                  <div className="grid gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[14px] font-bold">
                        ¿Por qué se reabre {c.mes}?
                      </span>
                      <input
                        type="text"
                        value={motivo}
                        onChange={(ev) => setMotivo(ev.target.value)}
                        placeholder="La contadora mandó una factura que faltaba"
                        className={ENTRADA}
                      />
                    </label>
                    <p className="m-0 text-[12px] text-muted">
                      Queda escrito con su nombre y la fecha.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={motivo.trim() === ""}
                        className={`${PRINCIPAL} row-grow`}
                        onClick={() => {
                          const m = motivo.trim();
                          setReabriendo(false);
                          setMotivo("");
                          void accion("/api/contabilidad/cierre/reabrir", { mes: c.mes, motivo: m });
                        }}
                      >
                        Reabrir {c.mes}
                      </button>
                      <button
                        type="button"
                        className={SUAVE}
                        onClick={() => {
                          setReabriendo(false);
                          setMotivo("");
                        }}
                      >
                        Dejarlo cerrado
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`${SUAVE} w-full md:w-auto`}
                    onClick={() => setReabriendo(true)}
                  >
                    Reabrir {c.mes}
                  </button>
                )}
              </Tarjeta>
            ) : (
              <Tarjeta>
                <p className="m-0 text-muted">
                  Cerrar el mes es de la dueña. Usted puede llevar la contabilidad y revisar esta
                  lista, pero el cierre lo hace ella.
                </p>
              </Tarjeta>
            )}

            <Tarjeta>
              <p className="m-0 text-muted">
                El paquete para la contadora —el Excel del mes y el ZIP con los comprobantes— se
                genera al cerrar y todavía no está hecho. Mientras tanto, lo que ve en el Libro es
                lo mismo que irá en ese Excel.
              </p>
            </Tarjeta>
          </div>
        )}
      </Carga>
    </div>
  );
}
