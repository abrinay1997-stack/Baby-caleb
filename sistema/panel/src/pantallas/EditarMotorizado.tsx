import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { Aviso, BOTON, Campo, ENTRADA, Grupo, Opcion } from "../formulario";

/**
 * Dar de alta a quien reparte, o corregirle algo.
 *
 * Esta hoja es la que cierra el circuito de las entregas. Antes de que
 * existiera, toda la cadena —armar la ruta, despacharla, cobrar en la puerta—
 * pedía un motorizado y no había forma de crear uno sin tocar la base a mano.
 *
 * Tampoco tiene botón de borrar, y por la misma razón que las bodegas: su
 * nombre queda en cada ruta que llevó y en cada asiento de su cuenta. Lo que
 * se hace es ponerlo en pausa (hoy no trabaja) o fuera (ya no trabaja aquí).
 *
 * El PIN no se pide aquí. El PIN es la llave de su propia pantalla —la de la
 * calle, sin Access— y esa pantalla todavía no existe; pedirlo ahora sería
 * guardar una credencial que no abre nada.
 */

export interface MotorizadoEditable {
  id: string;
  nombre: string;
  celular_e164: string;
  estado: "activo" | "pausa" | "inactivo";
  vehiculo: "moto" | "auto" | "bicicleta" | "a_pie" | null;
  tiene_pin: boolean;
  entregas_hoy: number;
}

export type EdicionDeMotorizado =
  | { modo: "nuevo" }
  | { modo: "editar"; motorizado: MotorizadoEditable };

const VEHICULOS = [
  { valor: "moto", titulo: "Moto", ayuda: "Lo normal: cabe en el tráfico y lleva varias cajas." },
  { valor: "auto", titulo: "Auto", ayuda: "Para tandas grandes o días de lluvia." },
  { valor: "bicicleta", titulo: "Bicicleta", ayuda: "Para entregas cerca." },
  { valor: "a_pie", titulo: "A pie", ayuda: "Entregas en el mismo edificio o a una cuadra." },
] as const;

export function EditarMotorizado({
  edicion,
  alCerrar,
  alGuardar,
}: {
  edicion: EdicionDeMotorizado | null;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [celular, setCelular] = useState("");
  const [vehiculo, setVehiculo] = useState<string>("");
  const [estado, setEstado] = useState<"activo" | "pausa" | "inactivo">("activo");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cargado, setCargado] = useState<string | null>(null);

  // Los campos se llenan cuando cambia de quién se habla, no en cada render:
  // si no, cada tecla se perdería al volver a pintar.
  const llave =
    edicion === null ? null : edicion.modo === "nuevo" ? "nuevo" : edicion.motorizado.id;
  if (edicion !== null && cargado !== llave) {
    setCargado(llave);
    const m = edicion.modo === "editar" ? edicion.motorizado : null;
    setNombre(m?.nombre ?? "");
    setCelular(m?.celular_e164 ?? "");
    setVehiculo(m?.vehiculo ?? "");
    setEstado(m?.estado ?? "activo");
    setError(null);
  }

  if (edicion === null) return null;

  const cerrar = () => {
    setCargado(null);
    setError(null);
    alCerrar();
  };

  const m = edicion.modo === "editar" ? edicion.motorizado : null;
  const seVaAParar = m !== null && m.estado === "activo" && estado !== "activo";

  async function guardar() {
    const limpio = nombre.trim();
    if (limpio === "") {
      setError("Hace falta el nombre: es como lo va a reconocer usted en la lista del día.");
      return;
    }
    if (celular.replace(/\D/g, "").length < 7) {
      setError("Hace falta su celular. Es el número al que usted lo llama cuando va en camino.");
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      if (m === null) {
        await pedir("/api/motorizados", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nombre: limpio,
            celular,
            ...(vehiculo === "" ? {} : { vehiculo }),
          }),
        });
      } else {
        // Solo lo que cambió. Mandar el celular de siempre en cada guardado
        // chocaría con el suyo propio a quien solo quería ponerlo en pausa.
        const cambios: Record<string, unknown> = {};
        if (limpio !== m.nombre) cambios["nombre"] = limpio;
        if (celular !== m.celular_e164) cambios["celular"] = celular;
        if (vehiculo !== (m.vehiculo ?? "")) cambios["vehiculo"] = vehiculo;
        if (Object.keys(cambios).length > 0) {
          await pedir(`/api/motorizados/${encodeURIComponent(m.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(cambios),
          });
        }
        // El estado va por su propia puerta, porque no es un dato suyo: es lo
        // que el sistema le deja hacer.
        if (estado !== m.estado) {
          await pedir(`/api/motorizados/${encodeURIComponent(m.id)}/estado`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ estado }),
          });
        }
      }
      alGuardar();
      cerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Hoja
      abierta
      titulo={m === null ? "Quién reparte" : m.nombre}
      alCerrar={cerrar}
      pie={
        <>
          <button type="button" onClick={cerrar} className={`${BOTON} border border-line`}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={guardando}
            className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
          >
            {guardando ? "Guardando…" : m === null ? "Darlo de alta" : "Guardar"}
          </button>
        </>
      }
    >
      {error === null ? null : <Aviso>{error}</Aviso>}

      <Campo etiqueta="Nombre" ayuda="Como lo va a ver usted en la lista del día.">
        <input
          className={ENTRADA}
          value={nombre}
          onChange={(e) => {
            setNombre(e.target.value);
            setError(null);
          }}
          placeholder="Luis Pérez"
        />
      </Campo>

      <Campo
        etiqueta="Celular"
        ayuda="Al que usted lo llama. Se puede escribir con guiones o solo los ocho dígitos."
      >
        <input
          className={ENTRADA}
          type="tel"
          inputMode="tel"
          value={celular}
          onChange={(e) => {
            setCelular(e.target.value);
            setError(null);
          }}
          placeholder="6000-0001"
        />
      </Campo>

      <Grupo pregunta="¿En qué anda?" ayuda="Sirve para repartir las rutas con cabeza.">
        {VEHICULOS.map((v) => (
          <Opcion
            key={v.valor}
            nombre="vehiculo"
            marcada={vehiculo === v.valor}
            alElegir={() => {
              setVehiculo(v.valor);
              setError(null);
            }}
            titulo={v.titulo}
            ayuda={v.ayuda}
          />
        ))}
      </Grupo>

      {m === null ? (
        <p className="m-0 text-[13px] text-muted">
          Nace activo, así que desde que lo guarde ya se le pueden asignar entregas. No se le pide
          clave: la pantalla de la calle, con la que él ve sus entregas desde su propio teléfono,
          todavía no existe.
        </p>
      ) : (
        <>
          <Grupo
            pregunta="¿Está trabajando?"
            ayuda="Solo a un activo se le pueden asignar entregas. Nadie se borra: su nombre queda en cada ruta que llevó."
          >
            <Opcion
              nombre="estado-motorizado"
              marcada={estado === "activo"}
              alElegir={() => setEstado("activo")}
              titulo="Activo"
              ayuda="Se le pueden armar rutas y aparece en la lista del día."
            />
            <Opcion
              nombre="estado-motorizado"
              marcada={estado === "pausa"}
              alElegir={() => setEstado("pausa")}
              titulo="En pausa"
              ayuda="Hoy no reparte, pero sigue siendo del equipo."
            />
            <Opcion
              nombre="estado-motorizado"
              marcada={estado === "inactivo"}
              alElegir={() => setEstado("inactivo")}
              titulo="Ya no trabaja aquí"
              ayuda="Desaparece de la lista. Lo que ya llevó se queda en los libros."
            />
          </Grupo>

          {seVaAParar && m.entregas_hoy > 0 ? (
            // El aviso que importa: pararlo no cancela lo que ya lleva encima.
            // Se dice con el número delante y ANTES de guardar, porque
            // enterarse mañana es enterarse con las cajas en su moto.
            <p className="m-0 rounded-[12px] border border-accent-edge bg-surface p-3">
              <strong>
                Hoy lleva {m.entregas_hoy} {m.entregas_hoy === 1 ? "entrega" : "entregas"}.
              </strong>{" "}
              Pararlo no las cancela ni las pasa a otra persona: siguen a su nombre hasta que
              alguien las devuelva o las cierre. Si no va a terminar el día, devuelva primero esas
              paradas desde Entregas.
            </p>
          ) : null}
        </>
      )}
    </Hoja>
  );
}
