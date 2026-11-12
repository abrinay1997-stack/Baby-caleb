import { useEffect, useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";

/**
 * Lo que se puede hacer con un pedido, según dónde esté.
 *
 * Las acciones son reales y pesan distinto, y la hoja lo dice en vez de poner
 * botones iguales:
 *
 *  - **Confirmar** (solo en una cotización) la convierte en pedido, y es ahí
 *    donde se aparta el inventario por primera vez. Si ya no hay existencias,
 *    el servidor lo dice nombrando el artículo y la cotización se queda como
 *    estaba: no se agenda a medias ni se cancela sola.
 *
 *  - **Agendar** lo mete en la lista de entregas. El servidor comprueba el
 *    abono con la regla COPIADA en el pedido el día que se creó, no con el
 *    ajuste de hoy. Por eso aquí no se pregunta nada: si no alcanza, el
 *    servidor lo dice con su motivo.
 *
 *  - **Cancelar** devuelve al inventario lo que estaba apartado y, si hubo
 *    abono, deja dinero de una clienta esperando una decisión. Pide motivo, y
 *    el motivo no se borra después. Sobre una cotización no devuelve nada,
 *    porque no se quitó nada, y el texto de la hoja lo dice así en vez de
 *    prometer una devolución que no ocurre.
 *
 * Un pedido que ya salió a la calle no se cancela: lo que corresponde es una
 * entrega fallida o una devolución, y eso vive en Entregas. Aquí ni se ofrece.
 */

export interface PedidoParaActuar {
  id: string;
  numero: string;
  estado: string;
  cliente: string | null;
}

export function AccionesPedido({
  pedido,
  alCerrar,
  alCambiar,
}: {
  pedido: PedidoParaActuar | null;
  alCerrar: () => void;
  alCambiar: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [cancelando, setCancelando] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pedido === null) return;
    setMotivo("");
    setCancelando(false);
    setError(null);
  }, [pedido]);

  if (pedido === null) return null;

  const esCotizacion = pedido.estado === "cotizacion";
  const sePuedeAgendar = pedido.estado === "por_abonar";
  const sePuedeCancelar =
    esCotizacion || pedido.estado === "por_abonar" || pedido.estado === "agendado";

  async function hacer(ruta: string, cuerpo?: Record<string, unknown>) {
    setError(null);
    setTrabajando(true);
    try {
      await pedir(ruta, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo ?? {}),
      });
      alCambiar();
      alCerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <Hoja abierta={pedido !== null} titulo={pedido.numero} alCerrar={alCerrar}>
      <div className="grid gap-4">
        <p className="m-0 text-[13px] text-muted">{pedido.cliente ?? "Sin nombre"}</p>

        {!esCotizacion && !sePuedeAgendar && !sePuedeCancelar ? (
          <p className="m-0 rounded-[10px] bg-surface p-3 text-[14px]">
            Este pedido ya salió de aquí. Lo que se puede hacer con él está en Entregas.
          </p>
        ) : null}

        {esCotizacion ? (
          <>
            <p className="m-0 rounded-[10px] bg-surface p-3 text-[14px]">
              Esta es una <strong>cotización</strong>: dice el precio y no aparta mercancía. Al
              confirmarla se convierte en el pedido {pedido.numero}, con el mismo total, y ahí se
              aparta el inventario. Si ya no hay existencias se lo decimos y la cotización se queda
              como está.
            </p>
            <button
              type="button"
              onClick={() => hacer(`/api/cotizaciones/${pedido.id}/confirmar`)}
              disabled={trabajando}
              className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2"
            >
              {trabajando ? "Confirmando…" : "Confirmar: pasar a pedido"}
            </button>
          </>
        ) : null}

        {sePuedeAgendar ? (
          <button
            type="button"
            onClick={() => hacer(`/api/pedidos/${pedido.id}/agendar`)}
            disabled={trabajando}
            className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2"
          >
            Agendar para entrega
          </button>
        ) : null}

        {sePuedeCancelar && !cancelando ? (
          <button
            type="button"
            onClick={() => setCancelando(true)}
            className="tactil w-full rounded-[14px] border border-line px-4 py-3 font-bold text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          >
            {esCotizacion ? "Descartar la cotización" : "Cancelar el pedido"}
          </button>
        ) : null}

        {cancelando ? (
          <div className="grid gap-2 rounded-[12px] border border-line p-3">
            <p className="m-0 text-[14px]">
              {esCotizacion
                ? "No hay nada que devolver: una cotización no apartó mercancía ni cobró nada. Queda el motivo escrito y se cierra."
                : "Se devuelve al inventario lo que estaba apartado. Si la clienta ya abonó, ese dinero queda esperando una decisión: no desaparece."}
            </p>
            <label className="block">
              <span className="mb-1 block text-[13px] font-bold">
                {esCotizacion ? "¿Por qué se descarta?" : "¿Por qué se cancela?"}
              </span>
              <input
                type="text"
                value={motivo}
                onChange={(e) => {
                  setMotivo(e.target.value);
                  setError(null);
                }}
                placeholder="La clienta se arrepintió"
                className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
              />
              <span className="mt-1 block text-[13px] text-muted">
                Queda en la bitácora y no se borra después.
              </span>
            </label>
            <button
              type="button"
              onClick={() => {
                if (motivo.trim() === "") {
                  setError(esCotizacion ? "Escriba por qué se descarta." : "Escriba por qué se cancela.");
                  return;
                }
                // La MISMA ruta para los dos: cancelar es cancelar, y el
                // servidor ya sabe que una cotización no tiene nada que
                // liberar. Una ruta propia para descartar cotizaciones serían
                // dos caminos hacia el mismo cambio de estado.
                void hacer(`/api/pedidos/${pedido.id}/cancelar`, { motivo: motivo.trim() });
              }}
              disabled={trabajando}
              className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2"
            >
              {trabajando
                ? esCotizacion
                  ? "Descartando…"
                  : "Cancelando…"
                : esCotizacion
                  ? "Sí, descartar"
                  : "Sí, cancelar"}
            </button>
          </div>
        ) : null}

        {error === null ? null : (
          <p role="alert" className="m-0 rounded-[10px] bg-surface p-3 text-[14px] text-fg">
            {error}
          </p>
        )}
      </div>
    </Hoja>
  );
}
