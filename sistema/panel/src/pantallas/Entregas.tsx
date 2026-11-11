import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, dinero, fecha as comoFecha, pedir, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { Hoja } from "../armazon/Hoja";
import { ETIQUETAS_ENVIO, type EstadoEnvio } from "../../../src/dominio/estado-envio";

/**
 * La ruta del día.
 *
 * **Esta pantalla se usa casi siempre desde un teléfono** (el dueño lo dijo:
 * 95 % de las veces), muchas veces de pie en la bodega con una caja en la otra
 * mano. De ahí las dos decisiones que mandan sobre todo lo demás:
 *
 * **1. Lo que falta por entregar va arriba y en una sola línea.** Si hay que
 * desplazarse para saber si queda trabajo, la pantalla falló. Por eso el
 * resumen no son tres tarjetas apiladas —serían trescientos píxeles antes de
 * ver una sola parada— sino una, con el número que importa grande y los otros
 * dos al lado.
 *
 * **2. El monto de un cobro no se escribe aquí.** Se enseña lo que el servidor
 * dice que se debe y solo se elige CÓMO se cobró. Es la regla del proyecto —«el
 * navegador no decide un pago»— hecha interfaz: no hay ningún campo donde
 * teclear una cantidad, así que no hay forma de equivocarse.
 *
 * Las medidas son las del §7 del sistema de diseño (contrato): campos a 16 px,
 * lo que se toca a 44 px, nada de texto por debajo de 12 px, ni `min-width` en
 * píxeles ni `100vh`. Las piezas salen de `componentes.tsx` y la hoja de
 * `armazon/Hoja.tsx`; aquí no se inventa ninguna variante.
 */

interface Parada {
  envioId: string;
  estado: EstadoEnvio;
  orden: number | null;
  pedido: string;
  bodegaId: string;
  bodega: string;
  cliente: string | null;
  zona: string | null;
  direccion: string | null;
  referencia: string | null;
  lat: number | null;
  lng: number | null;
  ventana: string | null;
  cobroCents: number;
  cobradoCents: number;
  cobroMetodo: string | null;
  entregadoEn: number | null;
  conPrueba: boolean;
}

interface Ruta {
  rutaId: string;
  motorizado: string;
  motorizadoId: string;
  bodega: string;
  estado: string;
  salioEn: number | null;
  cerradaEn: number | null;
  kmPropuestos: number | null;
  paradas: Parada[];
}

interface PorPreparar {
  pedidoId: string;
  numero: string;
  cliente: string | null;
  zona: string | null;
  saldoCents: number;
}

interface Datos {
  fecha: string;
  rutas: Ruta[];
  sinRuta: Parada[];
  porPreparar: PorPreparar[];
  resumen: { porEntregar: number; entregadas: number; fallidas: number; cobradoCents: number };
  ajustes: { ventanas: string[] | "PENDIENTE"; comisiones: unknown };
  motorizados: { id: string; nombre: string; estado: string }[];
}

const BOTON =
  "tactil rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";
const PRINCIPAL = `${BOTON} bg-accent text-accent-fg`;
const SUAVE = `${BOTON} border border-line`;
const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

const TONOS: Record<EstadoEnvio, "bien" | "aviso" | "mal" | "neutro"> = {
  pendiente: "neutro",
  asignado: "neutro",
  recogido: "aviso",
  en_ruta: "aviso",
  entregado: "bien",
  fallido: "mal",
  devuelto: "mal",
  anulado: "mal",
};

/** Una clave de intento por toque: es lo que hace que dos toques no cobren dos veces. */
const claveDeIntento = () => crypto.randomUUID();

const ETIQUETAS_RUTA: Record<string, string> = {
  borrador: "Sin salir",
  en_curso: "En la calle",
  cerrada: "Día cerrado",
  cancelada: "Cancelada",
};

function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[14px] font-bold">{etiqueta}</span>
      {children}
      {ayuda === undefined ? null : (
        <span className="mt-1 block text-[12px] text-muted">{ayuda}</span>
      )}
    </label>
  );
}

export function Entregas() {
  const yo = useOutletContext<Yo>();
  const [dia, setDia] = useState(() => hoyEnPanama());
  const [recarga, setRecarga] = useState(0);
  const [armando, setArmando] = useState(false);
  const [mirando, setMirando] = useState<Parada | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Deshacer una ruta pide un motivo, y se pide EN LA PÁGINA. `prompt()` no
  // aparece en algunos navegadores de teléfono, y ahí el botón no haría nada
  // sin decir por qué.
  const [deshaciendo, setDeshaciendo] = useState<string | null>(null);
  const [motivoRuta, setMotivoRuta] = useState("");

  const estado = useCarga<Datos>(`/api/entregas?fecha=${dia}`, [dia, recarga]);

  const puedeDespachar = yo.permisos["pedidos"] === "editar";
  const puedeCobrar = yo.permisos["cobros"] === "editar";

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
    <Carga estado={estado} que="las entregas del día">
      {(d) => (
        <div className="grid gap-4">
          {/* Lo primero que se ve, sin desplazarse: cuánto falta y cuánto se
              cobró. Una tarjeta y no tres: tres apiladas son trescientos
              píxeles antes de la primera parada. */}
          <Tarjeta>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="m-0 text-[12px] uppercase tracking-wide text-muted">
                  Faltan por entregar
                </p>
                <p className="m-0 text-[32px] font-bold leading-tight">{d.resumen.porEntregar}</p>
              </div>
              <div className="text-right">
                <p className="m-0 text-[12px] text-muted">
                  Entregadas <strong className="text-[17px] text-fg">{d.resumen.entregadas}</strong>
                </p>
                <p className="m-0 text-[12px] text-muted">
                  Cobrado en la puerta{" "}
                  <strong className="text-[17px] text-fg">{dinero(d.resumen.cobradoCents)}</strong>
                </p>
                {d.resumen.fallidas > 0 ? (
                  <p className="m-0 mt-1">
                    <Pastilla tono="mal">{d.resumen.fallidas} sin poder entregar</Pastilla>
                  </p>
                ) : null}
              </div>
            </div>
          </Tarjeta>

          <label className="block">
            <span className="mb-1 block text-[12px] uppercase tracking-wide text-muted">Día</span>
            <input
              type="date"
              value={dia}
              onChange={(ev) => setDia(ev.target.value)}
              className={`${ENTRADA} md:w-auto`}
            />
          </label>

          {aviso === null ? null : (
            <Tarjeta className="border-accent-edge">
              <p role="alert" className="m-0 font-bold">
                No se pudo hacer
              </p>
              <p className="m-0 mt-1 text-muted">{aviso}</p>
            </Tarjeta>
          )}

          {/* ── Lo que todavía no es una entrega ─────────────────────────── */}
          {d.porPreparar.length > 0 ? (
            <Tarjeta>
              <h2 className="m-0 text-[17px] font-bold">
                Pedidos listos para salir ({d.porPreparar.length})
              </h2>
              <p className="m-0 mt-1 mb-3 text-[12px] text-muted">
                Ya tienen su abono. Prepárelos para que entren en la ruta de un motorizado.
              </p>
              <Rejilla columnas={["Pedido", "Zona", "Saldo", "Acción"]}>
                {d.porPreparar.map((p) => (
                  <Fila key={p.pedidoId}>
                    <Celda etiqueta="">
                      {p.numero}
                      <span className="block text-[12px] font-normal text-muted">
                        {p.cliente ?? "sin nombre"}
                      </span>
                    </Celda>
                    <Celda etiqueta="Zona">{p.zona ?? "—"}</Celda>
                    <Celda etiqueta="Saldo" papel="clave">
                      <strong>{dinero(p.saldoCents)}</strong>
                    </Celda>
                    <Celda etiqueta="Acción" papel="estado">
                      {puedeDespachar ? (
                        <button
                          type="button"
                          className={`${SUAVE} w-full md:w-auto`}
                          onClick={() => accion(`/api/entregas/pedidos/${p.pedidoId}`)}
                        >
                          Preparar entrega
                        </button>
                      ) : null}
                    </Celda>
                  </Fila>
                ))}
              </Rejilla>
            </Tarjeta>
          ) : null}

          {/* ── Por repartir ─────────────────────────────────────────────── */}
          {d.sinRuta.length > 0 ? (
            <Tarjeta>
              <h2 className="m-0 text-[17px] font-bold">
                Por repartir ({d.sinRuta.length})
              </h2>
              <p className="m-0 mt-1 mb-3 text-[12px] text-muted">
                Entregas preparadas que todavía no tienen quien las lleve.
              </p>
              <ListaDeParadas paradas={d.sinRuta} alTocar={setMirando} />
              {puedeDespachar ? (
                <button
                  type="button"
                  onClick={() => setArmando(true)}
                  className={`${PRINCIPAL} mt-3 w-full md:w-auto`}
                >
                  Armar la ruta del día
                </button>
              ) : null}
            </Tarjeta>
          ) : null}

          {/* ── Las rutas ────────────────────────────────────────────────── */}
          {d.rutas.map((r) => {
            const abiertas = r.paradas.filter(
              (p) => p.estado !== "entregado" && p.estado !== "devuelto" && p.estado !== "anulado",
            ).length;
            const cobrado = r.paradas.reduce((s, p) => s + p.cobradoCents, 0);

            return (
              <Tarjeta key={r.rutaId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="m-0 text-[17px] font-bold">{r.motorizado}</h2>
                  <Pastilla tono={r.estado === "en_curso" ? "aviso" : "neutro"}>
                    {ETIQUETAS_RUTA[r.estado] ?? r.estado}
                  </Pastilla>
                </div>
                <p className="m-0 mt-1 mb-3 text-[12px] text-muted">
                  {r.bodega}
                  {" · "}
                  {abiertas === 0 ? "todo marcado" : `${abiertas} sin marcar`}
                  {cobrado > 0 ? ` · cobró ${dinero(cobrado)}` : ""}
                  {r.salioEn === null ? "" : ` · salió ${comoFecha(r.salioEn)}`}
                  {r.kmPropuestos === null
                    ? ""
                    : ` · ${r.kmPropuestos.toFixed(1)} km propuestos en línea recta`}
                </p>

                {r.paradas.length === 0 ? (
                  <p className="m-0 text-muted">Esta ruta no tiene paradas.</p>
                ) : (
                  <ListaDeParadas paradas={r.paradas} alTocar={setMirando} />
                )}

                {puedeDespachar ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.estado === "borrador" ? (
                      <>
                        <button
                          type="button"
                          className={`${PRINCIPAL} flex-1 md:flex-none`}
                          onClick={() => accion(`/api/entregas/rutas/${r.rutaId}/despachar`)}
                        >
                          Salió con la mercancía
                        </button>
                        <button
                          type="button"
                          className={`${SUAVE} flex-1 md:flex-none`}
                          onClick={() => {
                            setMotivoRuta("");
                            setDeshaciendo(deshaciendo === r.rutaId ? null : r.rutaId);
                          }}
                          aria-expanded={deshaciendo === r.rutaId}
                        >
                          Deshacer la ruta
                        </button>
                      </>
                    ) : null}
                    {r.estado === "en_curso" ? (
                      <button
                        type="button"
                        className={`${SUAVE} flex-1 md:flex-none`}
                        disabled={abiertas > 0}
                        onClick={() => accion(`/api/entregas/rutas/${r.rutaId}/cerrar`)}
                      >
                        {abiertas > 0 ? `Quedan ${abiertas} por marcar` : "Cerrar el día"}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {deshaciendo === r.rutaId ? (
                  <div className="mt-3 grid gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[14px] font-bold">
                        ¿Por qué se deshace esta ruta?
                      </span>
                      <input
                        type="text"
                        value={motivoRuta}
                        onChange={(ev) => setMotivoRuta(ev.target.value)}
                        placeholder="Me equivoqué de motorizado…"
                        className={ENTRADA}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={motivoRuta.trim() === ""}
                      className={`${SUAVE} w-full md:w-auto md:justify-self-start`}
                      onClick={() => {
                        const motivo = motivoRuta.trim();
                        setDeshaciendo(null);
                        accion(`/api/entregas/rutas/${r.rutaId}/cancelar`, { motivo });
                      }}
                    >
                      Deshacer y soltar las paradas
                    </button>
                  </div>
                ) : null}
              </Tarjeta>
            );
          })}

          {d.rutas.length === 0 && d.sinRuta.length === 0 && d.porPreparar.length === 0 ? (
            <Vacio
              titulo="No hay entregas este día"
              detalle="Aquí sale la ruta de cada motorizado: qué lleva, en qué orden y qué cobró en la puerta. Se llena cuando un pedido con su abono queda listo para salir."
            />
          ) : null}

          {/* Lo que la dueña todavía no ha decidido. Va al final para no empujar
              el trabajo hacia abajo, pero va: un número inventado sería peor. */}
          {d.ajustes.ventanas === "PENDIENTE" || d.ajustes.comisiones === "PENDIENTE" ? (
            <Tarjeta className="border-accent-edge">
              <p className="m-0 font-bold">Faltan reglas por decidir</p>
              <ul className="m-0 mt-1 list-disc pl-5 text-muted">
                {d.ajustes.ventanas === "PENDIENTE" ? (
                  <li>
                    Las <strong>ventanas de entrega</strong> (mañana, tarde…) no están puestas, así
                    que una entrega no puede prometer una hora. Se deciden en Ajustes.
                  </li>
                ) : null}
                {d.ajustes.comisiones === "PENDIENTE" ? (
                  <li>
                    Lo que se le <strong>paga a un motorizado</strong> por viaje no está puesto: por
                    eso esta pantalla enseña lo que cobró en la puerta, pero no lo que se le debe.
                  </li>
                ) : null}
              </ul>
            </Tarjeta>
          ) : null}

          <ArmarRuta
            abierta={armando}
            alCerrar={() => setArmando(false)}
            disponibles={d.sinRuta}
            motorizados={d.motorizados}
            alArmar={() => {
              setArmando(false);
              refrescar();
            }}
          />

          {mirando === null ? null : (
            <HojaDeParada
              parada={mirando}
              puedeCobrar={puedeCobrar}
              puedeDespachar={puedeDespachar}
              alCerrar={() => setMirando(null)}
              alHecho={() => {
                setMirando(null);
                refrescar();
              }}
            />
          )}
        </div>
      )}
    </Carga>
  );
}

/**
 * Las paradas de una ruta.
 *
 * El nombre de la clienta ES el botón, como en el catálogo: en un teléfono, un
 * icono de 24 px al lado de cada fila se falla con el pulgar.
 */
function ListaDeParadas({
  paradas,
  alTocar,
}: {
  paradas: Parada[];
  alTocar: (p: Parada) => void;
}) {
  return (
    <Rejilla columnas={["Parada", "Zona", "Cobro", "Estado"]}>
      {paradas.map((p) => (
        <Fila key={p.envioId}>
          <Celda etiqueta="">
            <button
              type="button"
              onClick={() => alTocar(p)}
              className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {p.orden === null ? "" : `${p.orden}. `}
              {p.cliente ?? p.pedido}
              <span className="block text-[12px] font-normal text-muted">
                {p.pedido}
                {p.direccion === null ? "" : ` · ${p.direccion}`}
              </span>
              <span className="sr-only"> — tocar para ver y marcar la parada</span>
            </button>
          </Celda>
          <Celda etiqueta="Zona">{p.zona ?? "—"}</Celda>
          <Celda etiqueta="Cobro" papel="clave">
            {p.estado === "entregado" ? (
              <strong>{p.cobradoCents > 0 ? dinero(p.cobradoCents) : "nada"}</strong>
            ) : (
              <strong>{p.cobroCents > 0 ? dinero(p.cobroCents) : "pagado"}</strong>
            )}
          </Celda>
          <Celda etiqueta="Estado" papel="estado">
            <Pastilla tono={TONOS[p.estado]}>{ETIQUETAS_ENVIO[p.estado]}</Pastilla>
          </Celda>
        </Fila>
      ))}
    </Rejilla>
  );
}

/**
 * Armar la ruta del día.
 *
 * El orden lo propone el servidor con la distancia EN LÍNEA RECTA, y hace falta
 * un punto de salida para medir. Como la bodega todavía no tiene punto en el
 * mapa (llega con F4.6), se ofrece usar la ubicación del teléfono de quien
 * despacha —que suele estar en la bodega— y se dice qué es. Sin punto no se
 * propone nada: un orden medido desde un sitio inventado parece pensado y no lo
 * está.
 */
function ArmarRuta({
  abierta,
  alCerrar,
  alArmar,
  disponibles,
  motorizados,
}: {
  abierta: boolean;
  alCerrar: () => void;
  alArmar: () => void;
  disponibles: Parada[];
  motorizados: { id: string; nombre: string; estado: string }[];
}) {
  const [motorizadoId, setMotorizadoId] = useState("");
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [origen, setOrigen] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Una ruta carga de UNA bodega: el motorizado no puede pasar por dos. Las
  // paradas se agrupan por bodega para que no se pueda elegir una mezcla.
  const bodegas = [...new Map(disponibles.map((p) => [p.bodegaId, p.bodega])).entries()];
  const bodegaElegida =
    elegidas.length === 0
      ? null
      : (disponibles.find((p) => p.envioId === elegidas[0])?.bodegaId ?? null);

  const activos = motorizados.filter((m) => m.estado === "activo");

  function alternar(envioId: string) {
    setElegidas((antes) =>
      antes.includes(envioId) ? antes.filter((x) => x !== envioId) : [...antes, envioId],
    );
  }

  function pedirUbicacion() {
    setError(null);
    if (!("geolocation" in navigator)) {
      setError("Este teléfono no puede dar su ubicación. La ruta se armará en el orden de la lista.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setOrigen({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () =>
        setError(
          "No nos dio la ubicación. La ruta se armará en el orden de la lista, que también sirve.",
        ),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function armar() {
    if (motorizadoId === "") return setError("Elija quién la lleva.");
    if (elegidas.length === 0) return setError("Elija al menos una parada.");
    if (bodegaElegida === null) return setError("No se pudo saber de qué bodega sale.");

    setGuardando(true);
    setError(null);
    try {
      await pedir("/api/entregas/rutas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          motorizadoId,
          bodegaId: bodegaElegida,
          envioIds: elegidas,
          ...(origen === null ? {} : { origen }),
        }),
      });
      setElegidas([]);
      setMotorizadoId("");
      setOrigen(null);
      alArmar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Hoja
      abierta={abierta}
      titulo="Armar la ruta del día"
      alCerrar={alCerrar}
      pie={
        <>
          <button type="button" onClick={alCerrar} className={`${SUAVE} flex-1`}>
            Cancelar
          </button>
          <button type="button" onClick={armar} disabled={guardando} className={`${PRINCIPAL} flex-1`}>
            {guardando ? "Armando…" : "Armar la ruta"}
          </button>
        </>
      }
    >
      {error === null ? null : (
        <p role="alert" className="m-0 mb-4 font-bold text-accent-strong">
          {error}
        </p>
      )}

      {activos.length === 0 ? (
        <p className="m-0 mb-4 text-muted">
          No hay ningún motorizado activo. Dé de alta uno, o quítele la pausa, antes de armar una
          ruta.
        </p>
      ) : (
        <Campo etiqueta="Quién la lleva">
          <select
            value={motorizadoId}
            onChange={(ev) => setMotorizadoId(ev.target.value)}
            className={ENTRADA}
          >
            <option value="">Elija un motorizado…</option>
            {activos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nombre}
              </option>
            ))}
          </select>
        </Campo>
      )}

      <Campo
        etiqueta="Qué lleva"
        {...(bodegas.length > 1
          ? {
              ayuda:
                "Una ruta carga de una sola bodega: al elegir la primera parada, las de otras bodegas se apagan.",
            }
          : {})}
      >
        <ul className="m-0 list-none p-0">
          {disponibles.map((p) => {
            const deOtraBodega = bodegaElegida !== null && p.bodegaId !== bodegaElegida;
            return (
              <li key={p.envioId} className="border-b border-line last:border-0">
                <label
                  className={`tactil flex items-center gap-3 py-2 ${deOtraBodega ? "opacity-50" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={elegidas.includes(p.envioId)}
                    disabled={deOtraBodega}
                    onChange={() => alternar(p.envioId)}
                    className="h-6 w-6 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block font-bold">{p.cliente ?? p.pedido}</span>
                    <span className="block text-[12px] text-muted">
                      {p.pedido} · {p.zona ?? "sin zona"} · {p.bodega}
                      {p.lat === null ? " · sin punto en el mapa" : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </Campo>

      <Campo
        etiqueta="Punto de salida"
        ayuda="Con un punto de salida el sistema propone el orden de las paradas. Lo mide en línea recta, no por calles: es mejor que ir viendo, y quien reparte lo cambia si conoce el barrio mejor."
      >
        {origen === null ? (
          <button type="button" onClick={pedirUbicacion} className={`${SUAVE} w-full`}>
            Usar mi ubicación
          </button>
        ) : (
          <p className="m-0 text-muted">
            Listo: se propondrá el orden desde donde está usted.{" "}
            <button
              type="button"
              onClick={() => setOrigen(null)}
              className="tactil underline decoration-line"
            >
              Quitar
            </button>
          </p>
        )}
      </Campo>
    </Hoja>
  );
}

/**
 * Una parada: qué es, y lo que se puede hacer con ella.
 *
 * El cobro no tiene campo de monto. Se enseña lo que el servidor dice que se
 * debe y se elige cómo entró el dinero; si lo que se cobró no es eso, esta
 * pantalla no sirve y la decisión la toma quien lleva los pagos. Es la regla
 * «el navegador no decide un pago» hecha interfaz.
 */
function HojaDeParada({
  parada,
  puedeCobrar,
  puedeDespachar,
  alCerrar,
  alHecho,
}: {
  parada: Parada;
  puedeCobrar: boolean;
  puedeDespachar: boolean;
  alCerrar: () => void;
  alHecho: () => void;
}) {
  const [metodo, setMetodo] = useState<"efectivo" | "yappy" | "otro">("efectivo");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const enLaCalle = parada.estado === "recogido" || parada.estado === "en_ruta";
  const conSaldo = parada.cobroCents > 0;
  // Marcar entregada con saldo mueve dinero: eso es `cobros`, no `pedidos`.
  const puedeEntregar = enLaCalle && (conSaldo ? puedeCobrar : puedeDespachar);

  async function mandar(ruta: string, cuerpo: Record<string, unknown>) {
    setGuardando(true);
    setError(null);
    try {
      await pedir(ruta, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      alHecho();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  const mapa =
    parada.lat === null || parada.lng === null
      ? null
      : `https://www.google.com/maps/dir/?api=1&destination=${parada.lat}%2C${parada.lng}`;

  return (
    <Hoja abierta titulo={parada.cliente ?? parada.pedido} alCerrar={alCerrar}>
      {error === null ? null : (
        <p role="alert" className="m-0 mb-4 font-bold text-accent-strong">
          {error}
        </p>
      )}

      <p className="m-0 mb-1">
        <Pastilla tono={TONOS[parada.estado]}>{ETIQUETAS_ENVIO[parada.estado]}</Pastilla>
      </p>
      <p className="m-0 mb-4 text-muted">
        {parada.pedido}
        {parada.zona === null ? "" : ` · ${parada.zona}`}
        {parada.ventana === null ? "" : ` · ${parada.ventana}`}
        <br />
        {parada.direccion ?? "Sin dirección escrita: hay que llamar."}
        {parada.referencia === null ? "" : ` (${parada.referencia})`}
        {parada.lat === null ? (
          <>
            <br />
            <strong>Sin punto en el mapa.</strong> Quien la lleve va a tener que llamar.
          </>
        ) : null}
      </p>

      {mapa === null ? null : (
        <a href={mapa} target="_blank" rel="noreferrer" className={`${SUAVE} mb-4 block text-center`}>
          Abrir en el mapa
        </a>
      )}

      {parada.estado === "entregado" ? (
        <p className="m-0 text-muted">
          Entregada {parada.entregadoEn === null ? "" : comoFecha(parada.entregadoEn)}.{" "}
          {parada.cobradoCents > 0
            ? `Se cobraron ${dinero(parada.cobradoCents)} en ${parada.cobroMetodo ?? "—"}.`
            : "No se cobró nada en la puerta."}
          {parada.conPrueba ? " Hay foto de la entrega." : " Sin foto de la entrega."}
        </p>
      ) : null}

      {puedeEntregar ? (
        <>
          <Campo
            etiqueta={conSaldo ? `Cómo cobró los ${dinero(parada.cobroCents)}` : "Cobro"}
            ayuda={
              conSaldo
                ? "El monto lo pone el sistema con el saldo del pedido. Aquí solo se dice cómo entró el dinero."
                : "Este pedido ya está pagado: no hay nada que cobrar en la puerta."
            }
          >
            {conSaldo ? (
              <select
                value={metodo}
                onChange={(ev) => setMetodo(ev.target.value as "efectivo" | "yappy" | "otro")}
                className={ENTRADA}
              >
                <option value="efectivo">Efectivo</option>
                <option value="yappy">Yappy</option>
                <option value="otro">Otro</option>
              </select>
            ) : null}
          </Campo>

          <button
            type="button"
            disabled={guardando}
            className={`${PRINCIPAL} mb-2 w-full`}
            onClick={() =>
              mandar(`/api/entregas/${parada.envioId}/entregada`, {
                idempotencia: claveDeIntento(),
                ...(conSaldo ? { metodoCobro: metodo } : {}),
              })
            }
          >
            Entregada
          </button>
        </>
      ) : null}

      {enLaCalle && puedeDespachar ? (
        <>
          <Campo etiqueta="Si no se pudo entregar, por qué">
            <input
              type="text"
              value={motivo}
              onChange={(ev) => setMotivo(ev.target.value)}
              placeholder="Nadie en la casa, dirección equivocada…"
              className={ENTRADA}
            />
          </Campo>
          <button
            type="button"
            disabled={guardando || motivo.trim() === ""}
            className={`${SUAVE} w-full`}
            onClick={() =>
              mandar(`/api/entregas/${parada.envioId}/fallida`, {
                idempotencia: claveDeIntento(),
                motivo: motivo.trim(),
              })
            }
          >
            No se pudo entregar
          </button>
        </>
      ) : null}

      {parada.estado === "fallido" && puedeDespachar ? (
        <>
          <p className="m-0 mb-3 text-muted">
            Esta parada no se pudo entregar. Se puede volver a intentar armándola en otra ruta, o
            devolverla: al devolverla se cancela el pedido y su mercancía vuelve a estar a la venta.
          </p>
          <Campo etiqueta="Por qué se devuelve">
            <input
              type="text"
              value={motivo}
              onChange={(ev) => setMotivo(ev.target.value)}
              placeholder="La clienta ya no la quiere…"
              className={ENTRADA}
            />
          </Campo>
          <button
            type="button"
            disabled={guardando || motivo.trim() === ""}
            className={`${SUAVE} w-full`}
            onClick={() =>
              mandar(`/api/entregas/${parada.envioId}/devolucion`, { motivo: motivo.trim() })
            }
          >
            Devolver y cancelar el pedido
          </button>
        </>
      ) : null}

      {!enLaCalle && parada.estado !== "entregado" && parada.estado !== "fallido" ? (
        <p className="m-0 text-muted">
          Esta parada todavía no ha salido de la bodega. Se marca cuando la ruta salga.
        </p>
      ) : null}
    </Hoja>
  );
}

/**
 * El día de hoy en Panamá, para el campo de fecha.
 *
 * Con la fecha del navegador en UTC, a partir de las siete de la noche la
 * pantalla abriría en el día siguiente y parecería que no hay entregas.
 */
function hoyEnPanama(): string {
  return new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
