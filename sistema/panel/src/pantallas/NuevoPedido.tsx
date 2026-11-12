import { useEffect, useState } from "react";
import { buscarProductos } from "./buscar-productos";
import { dinero, fecha, pedir, useCarga } from "../api";
import { Hoja } from "../armazon/Hoja";

/**
 * Tomar un pedido desde el panel — o hacer una cotización.
 *
 * Es para quien atiende por teléfono o por WhatsApp: la clienta dice qué
 * quiere y alguien lo teclea. La web y el bot crearán pedidos por su cuenta;
 * esta pantalla es la puerta de las personas.
 *
 * ## Las dos son la MISMA hoja, y eso no es ahorro de código
 *
 * Es el modelo que pidió el dueño, el de Odoo: una cotización, al confirmarse,
 * se convierte en pedido. Es el mismo documento, así que se llena con el mismo
 * formulario — la clienta, los productos, la zona, las notas. Dos hojas
 * distintas acabarían preguntando cosas distintas, y entonces confirmar una
 * cotización tendría que pedir lo que faltaba, que es justo lo que una
 * conversión no hace.
 *
 * Lo único que cambia `modo` es el título, la ruta a la que se manda, el texto
 * del botón y **lo que se promete al terminar**: un pedido dice «ya está
 * apartado el inventario»; una cotización dice que no aparta nada. Esa frase
 * es la parte importante de la diferencia.
 *
 * Dos cosas que definen su forma:
 *
 * 1. **La clienta se busca por celular, no por nombre.** El nombre lo escribe
 *    cada quien distinto —«Rosa», «Rosa E.», «rosa sanchez»— y así es como un
 *    negocio acaba con la misma señora tres veces y su historial repartido. El
 *    celular es el mismo siempre, y el servidor lo normaliza antes de buscar:
 *    «6000-0001», «+507 6000 0001» y «60000001» llegan a la misma ficha.
 *
 * 2. **Aquí no se escribe ningún precio.** Se eligen códigos y cantidades; el
 *    precio lo pone el servidor desde el catálogo. Lo que esta pantalla enseña
 *    mientras se arma el pedido es un CÁLCULO para poder decírselo a la
 *    clienta por teléfono, y se marca como tal: el total de verdad llega en la
 *    respuesta, con el envío y el ITBMS que decida el servidor.
 */

interface Variante {
  codigo: string;
  nombre: string;
  talla: string | null;
  precio_cents: number;
  publicado: number;
  activo: number;
}

interface Zona {
  id: string;
  nombre: string;
  tarifa_cents: number | null;
  activa: number;
}

interface Clienta {
  id: string;
  nombre: string | null;
  celular_e164: string | null;
  pedidos: number;
}

interface PedidoCreado {
  numero: string;
  totalCents: number;
  envioCents: number;
  abonoMinimoCents: number;
  requierePagoTotal: boolean;
  /** Lo dice el SERVIDOR, no la pantalla: «cotizacion» o «por_abonar». */
  estado: "cotizacion" | "por_abonar";
  /** Si se apartó inventario. En una cotización, `false` siempre. */
  aparto: boolean;
  /** Hasta cuándo vale, si vale hasta alguna fecha. */
  venceEn: number | null;
}

/** Una llave por formulario abierto: dos toques no hacen dos pedidos. */
const nuevaLlave = (): string =>
  `panel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Qué se está haciendo. Lo único que cambia entre los dos usos de la hoja. */
export type ModoDeDocumento = "pedido" | "cotizacion";

const PALABRAS: Record<
  ModoDeDocumento,
  { titulo: string; boton: string; trabajando: string; ruta: string }
> = {
  pedido: {
    titulo: "Tomar un pedido",
    boton: "Tomar el pedido",
    trabajando: "Tomando el pedido…",
    ruta: "/api/pedidos",
  },
  cotizacion: {
    titulo: "Hacer una cotización",
    boton: "Hacer la cotización",
    trabajando: "Haciendo la cotización…",
    ruta: "/api/cotizaciones",
  },
};

/**
 * Qué le falta a la hoja para poder mandarse, dicho para quien la está
 * llenando. `null` cuando no falta nada.
 *
 * Son las MISMAS dos condiciones que apagan el botón, escritas una sola vez:
 * si se escriben dos veces, un día el botón se enciende y el aviso sigue
 * diciendo que falta algo, y entonces la dueña ya no cree ninguno de los dos.
 */
export function loQueFalta(hayClienta: boolean, cuantasLineas: number): string | null {
  if (!hayClienta && cuantasLineas === 0) {
    return "Falta la clienta y falta añadir productos.";
  }
  if (!hayClienta) return "Falta la clienta: búsquela por su celular aquí arriba.";
  if (cuantasLineas === 0) return "Falta añadir al menos un producto.";
  return null;
}

export function NuevoPedido({
  abierta,
  alCerrar,
  alCrear,
  modo = "pedido",
}: {
  abierta: boolean;
  alCerrar: () => void;
  alCrear: () => void;
  modo?: ModoDeDocumento;
}) {
  const palabras = PALABRAS[modo];
  const catalogo = useCarga<{ variantes: Variante[] }>("/api/catalogo");
  const zonas = useCarga<{ zonas: Zona[] }>("/api/zonas");

  // `useCarga` devuelve una unión con `fase`, no un objeto con `datos`
  // siempre. Se desempaqueta UNA vez aquí en vez de comprobar la fase en cada
  // sitio: esta hoja no se bloquea mientras cargan —se puede ir escribiendo el
  // celular— así que lo que necesita es «lo que haya», no «espere».
  const variantes: Variante[] = catalogo.fase === "listo" ? catalogo.datos.variantes : [];
  const zonasListas: Zona[] = zonas.fase === "listo" ? zonas.datos.zonas : [];

  const [celular, setCelular] = useState("");
  const [nombre, setNombre] = useState("");
  const [clienta, setClienta] = useState<Clienta | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [yaLaTenia, setYaLaTenia] = useState(false);

  const [cantidades, setCantidades] = useState<Record<string, number>>({});
  const [busqueda, setBusqueda] = useState("");
  const [zona, setZona] = useState("");
  const [notas, setNotas] = useState("");

  const [llave, setLlave] = useState(nuevaLlave);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<PedidoCreado | null>(null);

  // Cada vez que se abre, formulario limpio y llave nueva. Sin esto, el pedido
  // anterior se queda a medio escribir y se manda sobre la clienta siguiente.
  useEffect(() => {
    if (!abierta) return;
    setCelular("");
    setNombre("");
    setClienta(null);
    setYaLaTenia(false);
    setCantidades({});
    setZona("");
    setNotas("");
    setLlave(nuevaLlave());
    setError(null);
    setHecho(null);
  }, [abierta]);

  /** Busca por celular; si no está, la da de alta con el nombre escrito. */
  async function resolverClienta() {
    if (celular.trim() === "") {
      setError("Escriba el celular de la clienta.");
      return;
    }
    setError(null);
    setBuscando(true);
    try {
      const encontradas = await pedir<{ clientas: Clienta[] }>(
        `/api/clientes?buscar=${encodeURIComponent(celular.trim())}`,
      );
      if (encontradas.clientas.length > 0) {
        const c = encontradas.clientas[0] as Clienta;
        setClienta(c);
        setYaLaTenia(true);
        if (nombre.trim() === "") setNombre(c.nombre ?? "");
        return;
      }
      if (nombre.trim() === "") {
        setError("No la tenía. Escriba su nombre para darla de alta.");
        return;
      }
      const alta = await pedir<{ clienteId: string; nuevo: boolean; nombre: string | null }>(
        "/api/clientes",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nombre: nombre.trim(), celular: celular.trim() }),
        },
      );
      setClienta({ id: alta.clienteId, nombre: alta.nombre, celular_e164: null, pedidos: 0 });
      setYaLaTenia(!alta.nuevo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuscando(false);
    }
  }

  const lineas = Object.entries(cantidades).filter(([, n]) => n > 0);
  const falta = loQueFalta(clienta !== null, lineas.length);

  /** Lo que se le puede decir a la clienta por teléfono. NO es el total. */
  const calculo = lineas.reduce((suma, [codigo, n]) => {
    const v = variantes.find((x) => x.codigo === codigo);
    return suma + (v === undefined ? 0 : v.precio_cents * n);
  }, 0);

  async function crear() {
    if (clienta === null) {
      setError("Primero busque o dé de alta a la clienta.");
      return;
    }
    if (lineas.length === 0) {
      setError(
        modo === "cotizacion"
          ? "Una cotización sin productos no cotiza nada."
          : "Un pedido sin productos no es un pedido.",
      );
      return;
    }
    setError(null);
    setGuardando(true);
    try {
      const r = await pedir<PedidoCreado>(palabras.ruta, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencia: llave,
          clienteId: clienta.id,
          lineas: lineas.map(([codigo, cantidad]) => ({ codigo, cantidad })),
          ...(zona === "" ? {} : { zona }),
          ...(notas.trim() === "" ? {} : { notasCliente: notas.trim() }),
        }),
      });
      setHecho(r);
      alCrear();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  const disponibles = variantes.filter((v) => v.activo === 1);

  const elegidas = disponibles.filter((v) => (cantidades[v.codigo] ?? 0) > 0);
  const { resultados, hayMas } = buscarProductos(disponibles, busqueda);

  return (
    <Hoja
      abierta={abierta}
      titulo={
        hecho === null
          ? palabras.titulo
          : `${hecho.estado === "cotizacion" ? "Cotización" : "Pedido"} ${hecho.numero}`
      }
      alCerrar={alCerrar}
      pie={
        hecho !== null ? (
          <button
            type="button"
            onClick={alCerrar}
            className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          >
            Cerrar
          </button>
        ) : (
          // El botón sale apagado desde que se abre la hoja —no hay clienta ni
          // productos todavía— y antes no decía por qué. Un botón apagado y
          // mudo se lee como «esto no sirve»: ahora encima de él está lo que
          // falta, y va cambiando conforme se llena.
          <div className="grid w-full gap-1">
            {falta === null ? null : (
              <p className="m-0 text-[13px] text-muted">{falta}</p>
            )}
            <button
              type="button"
              onClick={crear}
              disabled={guardando || falta !== null}
              className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2"
            >
              {guardando ? palabras.trabajando : palabras.boton}
            </button>
          </div>
        )
      }
    >
      {hecho !== null ? (
        <div className="grid gap-3">
          <p className="m-0 text-[15px]">
            Listo.{" "}
            {hecho.estado === "cotizacion" ? (
              <>
                La cotización <strong>{hecho.numero}</strong> quedó hecha a nombre de{" "}
                <strong>{clienta?.nombre ?? "la clienta"}</strong>.
              </>
            ) : (
              <>
                El pedido <strong>{hecho.numero}</strong> quedó apartado a nombre de{" "}
                <strong>{clienta?.nombre ?? "la clienta"}</strong>.
              </>
            )}
          </p>
          <dl className="m-0 grid gap-2">
            <div className="flex justify-between border-b border-line pb-2">
              <dt className="text-muted">Total</dt>
              <dd className="m-0 font-bold">{dinero(hecho.totalCents)}</dd>
            </div>
            <div className="flex justify-between border-b border-line pb-2">
              <dt className="text-muted">Envío</dt>
              <dd className="m-0">{dinero(hecho.envioCents)}</dd>
            </div>
            <div className="flex justify-between">
              {/* En una cotización todavía no hay nada que abonar: el abono
                  es lo que hará falta CUANDO se confirme. Decir «abono
                  mínimo» a secas sobre un documento que no se cobra deja a
                  quien atiende pidiéndole dinero a la clienta por algo que
                  aún no es un pedido. */}
              <dt className="text-muted">
                {hecho.requierePagoTotal
                  ? hecho.aparto
                    ? "Hay que pagar el total"
                    : "Al confirmarla hay que pagar el total"
                  : hecho.aparto
                    ? "Abono mínimo"
                    : "Abono mínimo al confirmarla"}
              </dt>
              <dd className="m-0 font-bold">
                {dinero(hecho.requierePagoTotal ? hecho.totalCents : hecho.abonoMinimoCents)}
              </dd>
            </div>
          </dl>
          {/* La frase que de verdad distingue los dos documentos. Se escribe
              según lo que contestó el SERVIDOR (`aparto`), no según el modo
              con el que se abrió la hoja: creerse a sí misma es como una
              pantalla acaba prometiendo algo que no pasó. */}
          {hecho.aparto ? (
            <p className="m-0 text-[13px] text-muted">
              Ya está apartado el inventario. Se agenda cuando entre el abono.
            </p>
          ) : (
            <p className="m-0 rounded-[10px] bg-surface p-3 text-[14px]">
              <strong>Esto no aparta mercancía.</strong> La cotización solo dice el precio: las
              cajas siguen a la venta para quien las pida primero. Se apartan cuando usted la
              confirme, y entonces pasa a ser un pedido.
              {hecho.venceEn === null
                ? " No caduca: todavía no está decidido cuántos días vale una cotización."
                : ` Vale hasta el ${fecha(hecho.venceEn)}.`}
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-5">
          <section className="grid gap-2">
            <h3 className="m-0 text-[15px] font-bold">¿Para quién?</h3>
            <label className="block">
              <span className="mb-1 block text-[13px] font-bold">Celular</span>
              <input
                type="text"
                inputMode="tel"
                value={celular}
                onChange={(e) => {
                  setCelular(e.target.value);
                  setClienta(null);
                  setError(null);
                }}
                placeholder="6000-0001"
                className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
              />
              <span className="mt-1 block text-[13px] text-muted">
                Se busca por aquí y no por el nombre: el celular es el mismo siempre.
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-bold">Nombre</span>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Rosa Sánchez"
                className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
              />
            </label>
            {clienta === null ? (
              <button
                type="button"
                onClick={resolverClienta}
                disabled={buscando}
                className="tactil w-full rounded-[12px] border border-line px-4 py-2 font-bold text-fg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2 md:w-auto md:justify-self-start"
              >
                {buscando ? "Buscando…" : "Buscar o dar de alta"}
              </button>
            ) : (
              <p className="m-0 rounded-[10px] bg-surface p-3 text-[14px]">
                {yaLaTenia ? "Ya la teníamos: " : "Dada de alta: "}
                <strong>{clienta.nombre ?? "sin nombre"}</strong>
                {clienta.pedidos > 0 ? ` · ${clienta.pedidos} pedido(s) antes` : ""}
              </p>
            )}
          </section>

          <section className="grid gap-2">
            <h3 className="m-0 text-[15px] font-bold">¿Qué lleva?</h3>

            {/* Lo elegido va ARRIBA y siempre se ve. Antes esta sección era el
                catálogo entero con una casilla por fila: con doce productos ya
                obligaba a bajar y subir, y con sesenta no se puede atender a
                nadie por teléfono así. Quien toma un pedido ya sabe qué quiere
                la clienta — no está mirando a ver qué hay. */}
            {elegidas.length === 0 ? (
              <p className="m-0 rounded-[10px] bg-surface p-3 text-[14px] text-muted">
                Todavía no ha añadido nada. Búsquelo aquí abajo.
              </p>
            ) : (
              <div className="grid gap-2">
                {elegidas.map((v) => (
                  <div
                    key={v.codigo}
                    className="flex items-center justify-between gap-3 rounded-[12px] border border-line p-3"
                  >
                    <span className="block min-w-0">
                      <span className="block font-bold">{v.nombre}</span>
                      {/* La talla y el código, SIEMPRE. Dos presentaciones del
                          mismo producto comparten nombre —«Pañal Nateen de
                          cierre» son seis tallas— y sin esto se ven filas
                          idénticas: quien atiende no sabe cuál está tocando y
                          el pedido sale con la talla equivocada. */}
                      <span className="block text-[13px] text-muted">
                        {v.talla === null ? v.codigo : `Talla ${v.talla} · ${v.codigo}`}
                      </span>
                      <span className="block text-[13px] text-muted">
                        {dinero(v.precio_cents)}
                        {v.publicado === 1 ? "" : " · solo interno"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`Cantidad de ${v.nombre}`}
                        value={cantidades[v.codigo] ?? ""}
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/[^0-9]/g, ""));
                          setCantidades((c) => ({ ...c, [v.codigo]: Number.isFinite(n) ? n : 0 }));
                          setError(null);
                        }}
                        className="tactil w-[72px] rounded-[10px] border border-line bg-bg px-2 py-2 text-center text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
                      />
                      <button
                        type="button"
                        aria-label={`Quitar ${v.nombre}`}
                        onClick={() => {
                          setCantidades((c) => ({ ...c, [v.codigo]: 0 }));
                          setError(null);
                        }}
                        className="tactil rounded-[10px] border border-line px-3 text-[14px] text-muted"
                      >
                        Quitar
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <label className="grid gap-1">
              <span className="text-[13px] text-muted">Añadir un producto</span>
              <input
                /* `type="text"` y no `"search"` a propósito: en un campo de
                   búsqueda, Escape BORRA el texto en vez de llegar a la hoja,
                   así que el primer Escape no cerraría el cajón y quien lo
                   intenta cree que no responde. Se descubrió en el auditor, que
                   se quedó esperando con la hoja abierta. */
                type="text"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Nombre, talla o código"
                className="tactil rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
              />
            </label>

            {/* La lista solo aparece al escribir. Sin consulta no se enseña
                nada: el catálogo completo es justo lo que sobraba. */}
            {busqueda.trim() === "" ? null : resultados.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">
                No encontré nada con «{busqueda.trim()}».
              </p>
            ) : (
              <div className="grid gap-2">
                {resultados.map((v) => {
                  const puesta = (cantidades[v.codigo] ?? 0) > 0;
                  return (
                    <button
                      key={v.codigo}
                      type="button"
                      disabled={puesta}
                      onClick={() => {
                        setCantidades((c) => ({ ...c, [v.codigo]: 1 }));
                        setError(null);
                      }}
                      className="tactil flex items-center justify-between gap-3 rounded-[12px] border border-line p-3 text-left disabled:opacity-60"
                    >
                      <span className="block min-w-0">
                        <span className="block font-bold">{v.nombre}</span>
                        <span className="block text-[13px] text-muted">
                          {v.talla === null ? v.codigo : `Talla ${v.talla} · ${v.codigo}`}
                        </span>
                        <span className="block text-[13px] text-muted">
                          {dinero(v.precio_cents)}
                          {v.publicado === 1 ? "" : " · solo interno"}
                        </span>
                      </span>
                      <span className="shrink-0 text-[14px] font-bold text-muted">
                        {puesta ? "Ya está" : "Añadir"}
                      </span>
                    </button>
                  );
                })}
                {hayMas ? (
                  <p className="m-0 text-[13px] text-muted">
                    Hay más. Escriba un poco más para afinar.
                  </p>
                ) : null}
              </div>
            )}

            {calculo > 0 ? (
              <p className="m-0 text-[13px] text-muted">
                Los productos suman <strong className="text-fg">{dinero(calculo)}</strong>. Es un
                cálculo para decírselo por teléfono: el total con envío e impuesto lo pone el
                sistema al tomar el pedido.
              </p>
            ) : null}
          </section>

          <section className="grid gap-2">
            <h3 className="m-0 text-[15px] font-bold">¿Dónde se entrega?</h3>
            <label className="block">
              <span className="mb-1 block text-[13px] font-bold">Zona</span>
              <select
                value={zona}
                onChange={(e) => setZona(e.target.value)}
                className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
              >
                <option value="">Sin zona — el envío se cotiza aparte</option>
                {zonasListas
                  .filter((z) => z.activa === 1)
                  .map((z) => (
                    <option key={z.id} value={z.nombre}>
                      {z.nombre}
                      {z.tarifa_cents === null ? " (se cotiza a mano)" : ` · ${dinero(z.tarifa_cents)}`}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-bold">Notas de la clienta</span>
              <input
                type="text"
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                placeholder="Entregar después de las 5"
                className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
              />
            </label>
          </section>

          {error === null ? null : (
            <p role="alert" className="m-0 rounded-[10px] bg-surface p-3 text-[14px] text-fg">
              {error}
            </p>
          )}
        </div>
      )}
    </Hoja>
  );
}
