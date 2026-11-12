import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, fecha, useCarga } from "../api";
import { Carga, Celda, Fila, Rejilla, Tarjeta, Vacio } from "../componentes";
import { FichaClienta, celularLegible } from "./FichaClienta";

/**
 * Las clientas.
 *
 * POR QUÉ EXISTE ESTA PANTALLA
 *
 * No para tener una agenda: para que se le pueda COBRAR CON TARJETA y
 * FACTURAR. Las dos cosas piden datos que hoy no están en ningún sitio —el
 * apellido aparte del nombre, la ciudad, la provincia, el código postal, y la
 * cédula o el RUC— y que no van a llegar solos: la pasarela no devuelve una
 * cédula y el chat no la pregunta. O alguien los escribe aquí, o el día que se
 * encienda el cobro con tarjeta no se puede cobrar.
 *
 * Por eso lo que se enseña de cada ficha no es «lo que hay» sino LO QUE FALTA.
 *
 * NO ES UN LISTADO
 *
 * Hasta que no se escribe algo no sale nadie, y es a propósito: una lista
 * completa de personas con su teléfono es justo lo que no debe salir de un
 * panel sin que alguien la haya pedido. El servidor hace lo mismo — esta
 * pantalla no podría enseñarla aunque quisiera.
 */

interface ClientaEnLista {
  id: string;
  nombre: string | null;
  celular_e164: string | null;
  pedidos: number;
  ultimo_pedido: number | null;
}

export function Clientas() {
  const yo = useOutletContext<Yo>();
  const [busca, setBusca] = useState("");
  const [abierta, setAbierta] = useState<string | null>(null);
  // Sube al guardar una ficha, para que la lista vuelva a pedirse: si no, el
  // nombre recién corregido seguiría saliendo como estaba.
  const [recarga, setRecarga] = useState(0);

  const texto = busca.trim();
  const datos = useCarga<{ clientas: ClientaEnLista[] }>(
    texto === "" ? "/api/clientes?buscar=" : `/api/clientes?buscar=${encodeURIComponent(texto)}`,
    [recarga],
  );

  // Mirar una ficha es una cosa y corregirla es otra: la contadora las ve y no
  // las toca. El servidor lo comprueba igual; esto solo evita ofrecer un botón
  // que iba a responder 403.
  const puedeTocar = yo.permisos["pedidos"] === "editar";

  return (
    <div className="grid gap-4">
      <Tarjeta>
        <p className="m-0 text-muted">
          Aquí se completan los datos que hacen falta para cobrarle con tarjeta y para hacerle una
          factura. Lo que esté en blanco significa que todavía no se lo hemos preguntado, no que
          no lo tenga.
        </p>
        <p className="m-0 mt-2 text-[12px] text-muted">
          La pasarela de tarjetas pide doce datos de facturación; aquí se vigilan los diez que
          conocemos. Los otros dos están PENDIENTES de confirmar con ellos antes del primer cobro.
        </p>
      </Tarjeta>

      <Tarjeta>
        <label className="block">
          <span className="mb-1 block text-[13px] font-bold">Buscar</span>
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Celular o nombre"
            // 16 px: por debajo de eso el teléfono hace zoom al enfocar y la
            // pantalla se descoloca (§7 del sistema de diseño).
            className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          />
        </label>
      </Tarjeta>

      {texto === "" ? (
        <Vacio
          titulo="Escriba un celular o un nombre"
          detalle="La lista entera de clientas no se enseña a propósito: son nombres y teléfonos de personas, y solo se sacan cuando alguien busca a una en concreto."
        />
      ) : (
        <Carga estado={datos} que="las clientas">
          {(d) =>
            d.clientas.length === 0 ? (
              <Vacio
                titulo="Ninguna clienta con eso"
                detalle="Pruebe con el celular, que es lo que casi nunca cambia. Si no está, se crea sola la primera vez que se le toma un pedido."
              />
            ) : (
              <Rejilla columnas={["Clienta", "Celular", "Pedidos", "Última compra"]}>
                {d.clientas.map((c) => (
                  <Fila key={c.id}>
                    <Celda etiqueta="" papel="titulo">
                      {/* El nombre ES el botón: en un teléfono, un lápiz al
                          lado de cada fila se falla con el pulgar. */}
                      <button
                        type="button"
                        onClick={() => setAbierta(c.id)}
                        className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-offset-2 focus-visible:outline-2"
                      >
                        {c.nombre ?? "Sin nombre"}
                        <span className="sr-only"> — abrir su ficha</span>
                      </button>
                    </Celda>
                    <Celda etiqueta="Celular" papel="clave">
                      {celularLegible(c.celular_e164)}
                    </Celda>
                    {/* El número a secas: en el teléfono la etiqueta se pinta
                        delante, y «Pedidos 3 pedidos» lo dice dos veces. */}
                    <Celda etiqueta="Pedidos" papel="meta">
                      {c.pedidos}
                    </Celda>
                    <Celda etiqueta="Última compra" papel="meta">
                      {c.ultimo_pedido === null ? "todavía ninguna" : fecha(c.ultimo_pedido)}
                    </Celda>
                  </Fila>
                ))}
              </Rejilla>
            )
          }
        </Carga>
      )}

      {abierta === null ? null : (
        <FichaClienta
          clienteId={abierta}
          puedeTocar={puedeTocar}
          alCerrar={() => setAbierta(null)}
          alGuardar={() => setRecarga((n) => n + 1)}
        />
      )}
    </div>
  );
}
