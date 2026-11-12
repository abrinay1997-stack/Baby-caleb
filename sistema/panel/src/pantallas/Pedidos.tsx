import { useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { type Yo, dinero, fecha, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { AccionesPedido, type PedidoParaActuar } from "./AccionesPedido";
import { type ModoDeDocumento, NuevoPedido } from "./NuevoPedido";

/**
 * Los pedidos.
 *
 * La pantalla que no existía. El sistema sabía crear un pedido y no tenía
 * dónde enseñarlo: el panel iba de Catálogo a Existencias sin pasar nunca por
 * la venta, que es para lo que existe todo lo demás.
 *
 * CÓMO SE ORDENA, Y POR QUÉ ASÍ
 *
 * Arriba va lo que necesita a alguien HOY: los que están por abonar —que se
 * caen solos si nadie los atiende— y los que ya salieron a la calle. Un panel
 * que pone primero el total del mes y abajo «hay tres pedidos sin atender»
 * está ordenado al revés: el número bonito no se hace nada y el pedido sí.
 *
 * LO QUE NO SE VE
 *
 * El dinero y el costo los recorta el servidor según el rol, no esta pantalla.
 * Aquí llegan ya en nulo si no toca verlos, y por eso el código pregunta
 * `=== null` en vez de preguntar por el rol: un sitio decide, el otro pinta.
 */

interface Pedido {
  id: string;
  numero: string;
  estado: string;
  estado_pago: string;
  cliente: string | null;
  origen: string;
  lineas: number;
  creado_en: number;
  vence_en: number | null;
  total_cents: number | null;
  pagado_cents: number | null;
  saldo_cents: number | null;
}

/** Los estados, en el orden del recorrido de una venta. */
const ESTADOS: { clave: string; nombre: string }[] = [
  { clave: "", nombre: "Todos" },
  // Primero del recorrido: una cotización es este mismo documento antes de
  // apartar nada.
  { clave: "cotizacion", nombre: "Cotizaciones" },
  { clave: "por_abonar", nombre: "Por abonar" },
  { clave: "agendado", nombre: "Agendados" },
  { clave: "en_ruta", nombre: "En ruta" },
  { clave: "entregado", nombre: "Entregados" },
  { clave: "cancelado", nombre: "Cancelados" },
  { clave: "devuelto", nombre: "Devueltos" },
];

const NOMBRE_ESTADO: Record<string, string> = {
  cotizacion: "Cotización",
  por_abonar: "Por abonar",
  agendado: "Agendado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  devuelto: "Devuelto",
};

const NOMBRE_PAGO: Record<string, string> = {
  sin_pago: "Sin pago",
  abonado: "Abonado",
  pagado: "Pagado",
  reembolso_parcial: "Reembolso parcial",
  reembolsado: "Reembolsado",
};

const NOMBRE_ORIGEN: Record<string, string> = {
  web: "la web",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  telegram: "Telegram",
  panel: "el panel",
};

/**
 * El tono de la pastilla.
 *
 * `por_abonar` va en ámbar y no en gris: es el único estado que se vence solo,
 * y lo que se vence solo tiene que pedir atención aunque nadie lo mire.
 *
 * `cotizacion` va en NEUTRO a propósito, aunque también pueda caducar: una
 * cotización sin confirmar no bloquea nada ni le debe nada a nadie. Si pidiera
 * atención en ámbar, la lista estaría gritando por documentos que no tienen
 * ningún problema — y entonces el ámbar deja de significar «mire esto».
 */
function tonoDe(estado: string): "neutro" | "bien" | "aviso" | "mal" {
  if (estado === "entregado") return "bien";
  if (estado === "por_abonar" || estado === "en_ruta") return "aviso";
  if (estado === "cancelado" || estado === "devuelto") return "mal";
  return "neutro";
}

/** «vence en 40 min», o nada si no vence. */
function loQueFalta(venceEn: number | null): string | null {
  if (venceEn === null) return null;
  const minutos = Math.round((venceEn - Date.now()) / 60_000);
  if (minutos <= 0) return "vencido";
  if (minutos < 60) return `vence en ${minutos} min`;
  const horas = Math.round(minutos / 60);
  return horas < 24 ? `vence en ${horas} h` : `vence en ${Math.round(horas / 24)} d`;
}

/** Un estado que esta pantalla sepa filtrar, o nada. */
export function estadoDeLaUrl(crudo: string | null): string {
  if (crudo === null) return "";
  return ESTADOS.some((e) => e.clave === crudo && e.clave !== "") ? crudo : "";
}

export function Pedidos() {
  // El filtro vive en la barra de direcciones y no en un `useState` suelto:
  // así el Resumen puede mandar aquí con el filtro ya puesto
  // (`/pedidos?estado=por_abonar`) en vez de dejar a la dueña buscándolo a
  // mano, y el enlace se puede guardar o compartir. Un `estado` que esta
  // pantalla no conoce se ignora: enviárselo al servidor devolvería una lista
  // vacía que parecería que no hay pedidos.
  const [parametros, setParametros] = useSearchParams();
  const estado = estadoDeLaUrl(parametros.get("estado"));
  const cambiarEstado = (clave: string): void => {
    const siguiente = new URLSearchParams(parametros);
    if (clave === "") siguiente.delete("estado");
    else siguiente.set("estado", clave);
    // `replace` y no una entrada nueva: tocar cinco filtros seguidos no tiene
    // por qué dejar cinco pasos de «atrás» antes de salir de la pantalla.
    setParametros(siguiente, { replace: true });
  };
  const [busca, setBusca] = useState("");

  const consulta = new URLSearchParams();
  if (estado !== "") consulta.set("estado", estado);
  if (busca.trim() !== "") consulta.set("busca", busca.trim());
  const cola = consulta.toString();

  const yo = useOutletContext<Yo>();
  // Sube al tomar o cambiar un pedido, y eso hace que `useCarga` vuelva a
  // pedir la lista: sin esto el pedido recién tomado no aparecería hasta
  // recargar la página a mano.
  const [recarga, setRecarga] = useState(0);
  const datos = useCarga<{ pedidos: Pedido[]; hayMas: boolean }>(
    `/api/pedidos${cola === "" ? "" : `?${cola}`}`,
    [recarga],
  );
  // Qué hoja está abierta, o ninguna. Un solo estado para las dos: con dos
  // banderas podrían quedar las dos abiertas a la vez.
  const [haciendo, setHaciendo] = useState<ModoDeDocumento | null>(null);
  const [actuando, setActuando] = useState<PedidoParaActuar | null>(null);

  // Mirar los pedidos es una cosa y moverlos es otra: la contadora los ve y no
  // los toca. El servidor lo comprueba igual; esto solo evita ofrecer un botón
  // que iba a fallar.
  const puedeTocar = yo.permisos["pedidos"] === "editar";

  return (
    <div className="grid gap-4">
      {puedeTocar ? (
        // Los dos verbos del mostrador, uno al lado del otro. En el teléfono
        // se apilan a ancho completo (`grid` sin columnas) y en computadora van
        // en fila: nada de `min-width` en píxeles, que el §7 prohíbe.
        <div className="grid gap-2 md:flex md:justify-start">
          <button
            type="button"
            onClick={() => setHaciendo("pedido")}
            className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg focus-visible:outline-accent-edge focus-visible:outline-2 md:w-auto"
          >
            + Tomar un pedido
          </button>
          {/* Secundario y no otro botón de acento: tomar un pedido es lo que
              se hace todo el día; cotizar es de vez en cuando, y dos botones
              igual de fuertes obligan a leer antes de tocar. */}
          <button
            type="button"
            onClick={() => setHaciendo("cotizacion")}
            className="tactil w-full rounded-[14px] border border-line px-4 py-3 font-bold text-fg focus-visible:outline-accent-edge focus-visible:outline-2 md:w-auto"
          >
            + Hacer una cotización
          </button>
        </div>
      ) : null}

      <Tarjeta>
        <label className="block">
          <span className="mb-1 block text-[13px] font-bold">Buscar</span>
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Número del pedido o nombre de la clienta"
            // 16 px: por debajo de eso el teléfono hace zoom al enfocar y la
            // pantalla se descoloca (§7 del sistema de diseño).
            className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          />
        </label>

        <div
          role="group"
          aria-label="Filtrar por estado"
          // Se desplaza de lado dentro de su caja, que es lo único que el §7
          // permite desbordar — nunca la página.
          className="mt-3 -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
        >
          {ESTADOS.map((e) => (
            <button
              key={e.clave}
              type="button"
              onClick={() => cambiarEstado(e.clave)}
              aria-pressed={estado === e.clave}
              className={`tactil shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-bold transition-colors focus-visible:outline-accent-edge focus-visible:outline-2 ${
                estado === e.clave
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-line text-muted hover:text-fg"
              }`}
            >
              {e.nombre}
            </button>
          ))}
        </div>
      </Tarjeta>

      <Carga estado={datos} que="los pedidos">
        {(d) =>
          d.pedidos.length === 0 ? (
            <Vacio
              titulo={
                estado === "cotizacion" && busca === ""
                  ? "Todavía no hay cotizaciones"
                  : estado === "" && busca === ""
                    ? "Todavía no hay pedidos"
                    : "Ningún pedido con ese filtro"
              }
              detalle={
                // La cotización vacía explica QUÉ es, y no «pruebe otro
                // filtro»: es la pantalla donde la dueña se entera de que
                // existe la posibilidad.
                estado === "cotizacion" && busca === ""
                  ? "Una cotización es un pedido que todavía no aparta mercancía: sirve para pasarle un precio a una clienta sin quitarle las cajas a nadie. Al confirmarla se convierte en pedido y entonces sí se aparta."
                  : estado === "" && busca === ""
                    ? "Aquí van a aparecer en cuanto entre el primero, venga de la web, de WhatsApp o del panel."
                    : "Pruebe con otro estado, o borre lo que escribió en la búsqueda."
              }
            />
          ) : (
            <div className="grid gap-2">
              <Rejilla
                columnas={["Pedido", "Clienta", "Estado", "Pago", "Saldo", "Cuándo"]}
              >
                {d.pedidos.map((p) => {
                  const falta = loQueFalta(p.vence_en);
                  return (
                    <Fila key={p.id}>
                      <Celda etiqueta="" papel="titulo">
                        {puedeTocar ? (
                          // El número ES el botón: en un teléfono, un menú de
                          // tres puntos al lado de cada fila se falla con el
                          // pulgar.
                          <button
                            type="button"
                            onClick={() =>
                              setActuando({
                                id: p.id,
                                numero: p.numero,
                                estado: p.estado,
                                cliente: p.cliente,
                              })
                            }
                            className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                          >
                            {p.numero}
                            <span className="sr-only">
                              {p.estado === "cotizacion"
                                ? " — tocar para confirmar o descartar"
                                : " — tocar para agendar o cancelar"}
                            </span>
                          </button>
                        ) : (
                          p.numero
                        )}
                      </Celda>
                      <Celda etiqueta="Clienta" papel="meta">
                        {p.cliente ?? "Sin nombre"}
                      </Celda>
                      <Celda etiqueta="Estado" papel="estado">
                        <Pastilla tono={tonoDe(p.estado)}>
                          {NOMBRE_ESTADO[p.estado] ?? p.estado}
                        </Pastilla>
                        {falta !== null && p.estado === "por_abonar" ? (
                          <span className="ml-2 text-[12px] text-muted">{falta}</span>
                        ) : null}
                      </Celda>
                      <Celda etiqueta="Pago" papel="meta">
                        {NOMBRE_PAGO[p.estado_pago] ?? p.estado_pago}
                      </Celda>
                      <Celda etiqueta="Saldo" papel="clave">
                        {/* Nulo y cero no son lo mismo: nulo es «usted no ve
                            el dinero», cero es «no debe nada».

                            Y una COTIZACIÓN no debe nada todavía: su total es
                            lo que costaría, no lo que la clienta debe. Puesto
                            bajo una columna llamada «Saldo» y sin decirlo, se
                            lee como una deuda que nadie contrajo — y alguien
                            acabaría cobrándola. */}
                        {p.total_cents === null ? (
                          <span className="text-muted">—</span>
                        ) : p.estado === "cotizacion" ? (
                          <span className="text-muted">{dinero(p.total_cents)} cotizados</span>
                        ) : p.saldo_cents === 0 ? (
                          <span className="text-muted">Al día</span>
                        ) : (
                          dinero(p.saldo_cents ?? 0)
                        )}
                      </Celda>
                      <Celda etiqueta="Cuándo" papel="meta">
                        {fecha(p.creado_en)} · {p.lineas}{" "}
                        {p.lineas === 1 ? "producto" : "productos"} · por{" "}
                        {NOMBRE_ORIGEN[p.origen] ?? p.origen}
                      </Celda>
                    </Fila>
                  );
                })}
              </Rejilla>

              {d.hayMas ? (
                <p className="m-0 text-[13px] text-muted">
                  Hay más pedidos de los que caben aquí. Filtre por estado o busque para
                  encontrar el que necesita.
                </p>
              ) : null}
            </div>
          )
        }
      </Carga>
      <NuevoPedido
        abierta={haciendo !== null}
        // `?? "pedido"` para que el tipo cierre al cerrarse la hoja; con
        // `abierta` en falso no se pinta nada, así que el valor no se ve.
        modo={haciendo ?? "pedido"}
        alCerrar={() => setHaciendo(null)}
        alCrear={() => setRecarga((n) => n + 1)}
      />

      <AccionesPedido
        pedido={actuando}
        alCerrar={() => setActuando(null)}
        alCambiar={() => setRecarga((n) => n + 1)}
      />
    </div>
  );
}
