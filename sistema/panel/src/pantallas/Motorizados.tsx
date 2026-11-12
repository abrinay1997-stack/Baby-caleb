import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { BOTON_SUELTO } from "../formulario";
import {
  EditarMotorizado,
  type EdicionDeMotorizado,
  type MotorizadoEditable,
} from "./EditarMotorizado";

/**
 * Quién reparte.
 *
 * Esta pantalla no añade una capacidad nueva: destapa las que ya estaban.
 * Armar una ruta, despacharla y cobrar en la puerta estaban escritos y
 * probados desde hace semanas, y todos pedían un motorizado que ninguna
 * pantalla ni ninguna ruta del sistema podía crear. El circuito se cortaba
 * exactamente aquí.
 *
 * Va aparte de Entregas a propósito: Entregas es el día de hoy —qué sale, qué
 * se cobró— y esto es el equipo, que cambia cada varios meses. Mezclarlos
 * pondría un botón de «dar de alta» en la pantalla que más se usa con prisa.
 */

const EN_QUE_ANDA: Record<string, string> = {
  moto: "Moto",
  auto: "Auto",
  bicicleta: "Bicicleta",
  a_pie: "A pie",
};

const COMO_ESTA: Record<string, string> = {
  activo: "Activo",
  pausa: "En pausa",
  inactivo: "Ya no trabaja aquí",
};

export function Motorizados() {
  const yo = useOutletContext<Yo>();
  const [recarga, setRecarga] = useState(0);
  const [verTodos, setVerTodos] = useState(false);
  const estado = useCarga<{ motorizados: MotorizadoEditable[] }>(
    `/api/motorizados${verTodos ? "?todos=1" : ""}`,
    [recarga, verTodos],
  );
  const [edicion, setEdicion] = useState<EdicionDeMotorizado | null>(null);

  // Ver a quién asignarle una ruta es parte de atender; meter a alguien en la
  // lista de quien entra a la casa de una clienta con la mercancía del negocio
  // es de la dueña. El servidor lo comprueba igual.
  const puedeTocar = yo.permisos["ajustes"] === "editar";

  return (
    <Carga estado={estado} que="quiénes reparten">
      {(d) => (
        <div className="grid gap-4">
          <Tarjeta>
            <p className="m-0 text-muted">
              Sin alguien dado de alta aquí <strong>no se puede armar una ruta</strong>: las
              entregas se quedan preparadas y sin dueño. Nadie se borra nunca —su nombre tiene que
              seguir explicando quién llevó cada pedido—, así que quien se va queda como «ya no
              trabaja aquí».
              {puedeTocar
                ? " Toque un nombre para corregirlo o para ponerlo en pausa."
                : " Su rol puede ver quiénes reparten, pero no cambiarlos."}
            </p>
          </Tarjeta>

          <div className="flex flex-wrap gap-2">
            {puedeTocar ? (
              <button
                type="button"
                onClick={() => setEdicion({ modo: "nuevo" })}
                className={`${BOTON_SUELTO} bg-accent text-accent-fg`}
              >
                Dar de alta
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setVerTodos((v) => !v)}
              className={`${BOTON_SUELTO} border border-line`}
            >
              {verTodos ? "Ver solo a los del equipo" : "Ver también a los que ya no trabajan"}
            </button>
          </div>

          {d.motorizados.length === 0 ? (
            <Vacio
              titulo="Todavía no hay quién reparta"
              detalle="Mientras no haya nadie aquí, las entregas se pueden preparar pero no se les puede armar una ruta ni salir a la calle. Con una persona ya alcanza para empezar."
            />
          ) : (
            <Rejilla columnas={["Quién", "Celular", "En qué anda", "Hoy", "Cómo está"]}>
              {d.motorizados.map((m) => (
                <Fila key={m.id}>
                  <Celda etiqueta="">
                    {puedeTocar ? (
                      // El nombre ES el botón: en un teléfono, un lápiz de
                      // 24 px al lado de cada fila se falla con el pulgar.
                      <button
                        type="button"
                        onClick={() => setEdicion({ modo: "editar", motorizado: m })}
                        className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {m.nombre}
                      </button>
                    ) : (
                      <span className="font-bold">{m.nombre}</span>
                    )}
                  </Celda>
                  {/* En su propia celda y no debajo del nombre: la celda sin
                      etiqueta es el TÍTULO de la fila, y su regla de estilo
                      gana contra `text-muted`, así que el número salía igual
                      de grande y de oscuro que el nombre. */}
                  <Celda etiqueta="Celular">{m.celular_e164}</Celda>
                  <Celda etiqueta="En qué anda">
                    {m.vehiculo === null ? (
                      <span className="text-muted">Sin decir</span>
                    ) : (
                      (EN_QUE_ANDA[m.vehiculo] ?? m.vehiculo)
                    )}
                  </Celda>
                  <Celda etiqueta="Hoy">
                    {m.entregas_hoy === 0 ? (
                      <span className="text-muted">Sin entregas</span>
                    ) : (
                      `${m.entregas_hoy} ${m.entregas_hoy === 1 ? "entrega" : "entregas"}`
                    )}
                  </Celda>
                  <Celda etiqueta="Cómo está">
                    <Pastilla tono={m.estado === "activo" ? "bien" : "aviso"}>
                      {COMO_ESTA[m.estado] ?? m.estado}
                    </Pastilla>
                  </Celda>
                </Fila>
              ))}
            </Rejilla>
          )}

          <EditarMotorizado
            edicion={edicion}
            alCerrar={() => setEdicion(null)}
            alGuardar={() => setRecarga((n) => n + 1)}
          />
        </div>
      )}
    </Carga>
  );
}
