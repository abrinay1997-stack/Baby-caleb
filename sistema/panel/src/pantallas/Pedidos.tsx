import { useState } from "react";
import { dinero, fecha, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";

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
  { clave: "por_abonar", nombre: "Por abonar" },
  { clave: "agendado", nombre: "Agendados" },
  { clave: "en_ruta", nombre: "En ruta" },
  { clave: "entregado", nombre: "Entregados" },
  { clave: "cancelado", nombre: "Cancelados" },
  { clave: "devuelto", nombre: "Devueltos" },
];

const NOMBRE_ESTADO: Record<string, string> = {
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

export function Pedidos() {
  const [estado, setEstado] = useState("");
  const [busca, setBusca] = useState("");

  const consulta = new URLSearchParams();
  if (estado !== "") consulta.set("estado", estado);
  if (busca.trim() !== "") consulta.set("busca", busca.trim());
  const cola = consulta.toString();

  const datos = useCarga<{ pedidos: Pedido[]; hayMas: boolean }>(
    `/api/pedidos${cola === "" ? "" : `?${cola}`}`,
  );

  return (
    <div className="grid gap-4">
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
              onClick={() => setEstado(e.clave)}
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
                estado === "" && busca === ""
                  ? "Todavía no hay pedidos"
                  : "Ningún pedido con ese filtro"
              }
              detalle={
                estado === "" && busca === ""
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
                        {p.numero}
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
                            el dinero», cero es «no debe nada». */}
                        {p.saldo_cents === null ? (
                          <span className="text-muted">—</span>
                        ) : p.saldo_cents === 0 ? (
                          <span className="text-muted">Al día</span>
                        ) : (
                          dinero(p.saldo_cents)
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
    </div>
  );
}
