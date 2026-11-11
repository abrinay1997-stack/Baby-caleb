import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { Aviso, BOTON, Campo, ENTRADA, Grupo, Opcion } from "../formulario";

/**
 * Abrir una bodega o cambiarle algo.
 *
 * Lo que define esta hoja es lo que NO tiene: un botón de borrar. Una bodega
 * aparece en cada movimiento de inventario que pasó por ella, y los
 * movimientos no se editan ni se borran —la base lo impide con un trigger—,
 * así que borrarla dejaría el libro que explica de dónde salió cada caja
 * apuntando a un sitio que no existe.
 *
 * Lo que sí se puede es DEJAR DE USARLA, y eso tampoco es lo que la gente
 * espera: no esconde la mercancía que quedó dentro. Esta hoja lo dice con el
 * número delante, ANTES de que alguien toque Guardar, porque enterarse después
 * de que la web sigue ofreciendo cien cajas que ya nadie va a surtir es
 * enterarse tarde.
 */

export interface BodegaEditable {
  id: string;
  nombre: string;
  activa: number;
  variantes: number;
  unidades: number;
}

/** Abierta en «nueva» o sobre una bodega concreta. `null` es cerrada. */
export type EdicionDeBodega = { modo: "nueva" } | { modo: "editar"; bodega: BodegaEditable };

export function EditarBodega({
  edicion,
  alCerrar,
  alGuardar,
}: {
  edicion: EdicionDeBodega | null;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [enUso, setEnUso] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cargado, setCargado] = useState<string | null>(null);

  // Los campos se llenan cuando cambia la bodega, no en cada render: si no,
  // cada tecla se perdería al volver a pintar.
  const llave = edicion === null ? null : edicion.modo === "nueva" ? "nueva" : edicion.bodega.id;
  if (edicion !== null && cargado !== llave) {
    setCargado(llave);
    setNombre(edicion.modo === "editar" ? edicion.bodega.nombre : "");
    setEnUso(edicion.modo === "editar" ? edicion.bodega.activa === 1 : true);
    setError(null);
  }

  if (edicion === null) return null;

  const cerrar = () => {
    setCargado(null);
    setError(null);
    alCerrar();
  };

  const bodega = edicion.modo === "editar" ? edicion.bodega : null;
  const seVaAApagar = bodega !== null && bodega.activa === 1 && !enUso;

  async function guardar() {
    const limpio = nombre.trim();
    if (limpio === "") {
      setError("La bodega necesita un nombre. Es como la va a reconocer usted en las listas.");
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      if (bodega === null) {
        await pedir("/api/bodegas", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nombre: limpio }),
        });
      } else {
        // Solo lo que cambió. Mandar el nombre de siempre en cada guardado
        // haría chocar con el nombre de otra bodega a quien solo quería
        // apagarla, y el error hablaría de algo que esa persona no tocó.
        const cambios: Record<string, unknown> = {};
        if (limpio !== bodega.nombre) cambios["nombre"] = limpio;
        if (enUso !== (bodega.activa === 1)) cambios["activa"] = enUso;
        if (Object.keys(cambios).length === 0) {
          cerrar();
          return;
        }
        await pedir(`/api/bodegas/${encodeURIComponent(bodega.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cambios),
        });
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
      titulo={bodega === null ? "Bodega nueva" : bodega.nombre}
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
            {guardando ? "Guardando…" : bodega === null ? "Abrir la bodega" : "Guardar"}
          </button>
        </>
      }
    >
      {error === null ? null : <Aviso>{error}</Aviso>}

      <Campo
        etiqueta="Nombre"
        ayuda="Es como la va a ver usted en las listas y en los traslados."
      >
        <input
          className={ENTRADA}
          value={nombre}
          onChange={(e) => {
            setNombre(e.target.value);
            setError(null);
          }}
          placeholder="Bodega Panamá Oeste"
        />
      </Campo>

      {bodega === null ? (
        <p className="m-0 text-[13px] text-muted">
          Una bodega nace vacía y con un casillero para cada producto, así que desde el primer
          momento se le puede trasladar mercancía o registrarle una carga inicial.
        </p>
      ) : (
        <>
          <Grupo
            pregunta="¿Se sigue usando?"
            ayuda="Una bodega no se borra nunca: sus movimientos tienen que seguir existiendo para explicar de dónde salió cada caja."
          >
            <Opcion
              nombre="uso-de-bodega"
              marcada={enUso}
              alElegir={() => {
                setEnUso(true);
                setError(null);
              }}
              titulo="En uso"
              ayuda="Los pedidos pueden surtirse desde aquí y se le puede mandar mercancía."
            />
            <Opcion
              nombre="uso-de-bodega"
              marcada={!enUso}
              alElegir={() => {
                setEnUso(false);
                setError(null);
              }}
              titulo="Dejar de usarla"
              ayuda="Ningún pedido va a salir de aquí y nadie le puede mandar más mercancía."
            />
          </Grupo>

          {seVaAApagar && bodega.unidades > 0 ? (
            // El aviso que importa, y por eso va con el número delante:
            // apagar la bodega NO esconde lo que hay dentro. La web y el bot
            // siguen contando esas unidades como disponibles, pero ningún
            // pedido se va a surtir de ahí.
            <p className="m-0 rounded-[12px] border border-accent-edge bg-surface p-3">
              <strong>
                Ahí dentro quedan {bodega.unidades}{" "}
                {bodega.unidades === 1 ? "unidad" : "unidades"}.
              </strong>{" "}
              Dejar de usar la bodega no las esconde: la web y el bot las van a seguir contando
              como disponibles, pero ningún pedido va a salir de aquí. Si no piensa volver a
              usarla, traslade antes lo que queda a otra bodega.
            </p>
          ) : null}

          {seVaAApagar && bodega.unidades === 0 ? (
            <p className="m-0 text-[13px] text-muted">
              Está vacía, así que dejar de usarla no deja nada colgando.
            </p>
          ) : null}
        </>
      )}
    </Hoja>
  );
}
