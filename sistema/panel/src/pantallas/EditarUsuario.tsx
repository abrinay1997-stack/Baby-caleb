import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { Aviso, BOTON, Campo, ENTRADA, Grupo, Opcion } from "../formulario";
import { ETIQUETAS_ROL, PERMISOS, ROLES_DE_PANEL, nivelDe, type RolDePanel } from "../permisos";

/**
 * Dar de alta a alguien en el panel, o quitarle el acceso.
 *
 * Entrar son DOS cosas y esta hoja solo hace una: Cloudflare Access comprueba
 * que la persona es quien dice ser, y esta lista dice si además trabaja aquí.
 * Alguien dado de alta aquí y fuera de la aplicación de Access NO entra, y hay
 * que decirlo, porque si no se da por hecho que con esto basta y la persona
 * se queda mirando un «no autorizado» sin saber dónde está el problema.
 *
 * Al revés sí es inmediato: quitarle el acceso a alguien tiene efecto en su
 * siguiente petición, sin esperar a que le caduque la sesión de Access.
 *
 * Lo que NO se puede hacer es dejar al sistema sin dueña activa. Sin ella
 * nadie tiene el permiso de ajustes, o sea que nadie podría volver a dar de
 * alta a nadie — ni a sí mismo. El servidor lo rechaza, pero la hoja lo dice
 * antes: enterarse al tocar el botón es enterarse tarde.
 */

export interface UsuarioEditable {
  id: string;
  correo: string;
  nombre: string;
  rol: RolDePanel;
  telegram_chat_id: string | null;
  activo: number;
  creado_en: number;
}

export type EdicionDeUsuario =
  | { modo: "nueva" }
  | { modo: "editar"; usuario: UsuarioEditable };

const QUE_HACE: Record<RolDePanel, string> = {
  duena: "Lo puede todo, incluido cerrar el mes y cambiar quién entra.",
  asistente: "Toma pedidos y registra gastos. No ve costos ni toca precios.",
  contadora: "Lleva los libros y mira los costos. No cierra el mes ni toca precios.",
};

export function EditarUsuario({
  edicion,
  /** Quién está usando el panel ahora, para avisarle si se va a sacar a sí misma. */
  yoId,
  /** Cuántas dueñas activas hay, contando a esta. Para avisar antes, no para decidir. */
  duenasActivas,
  alCerrar,
  alGuardar,
}: {
  edicion: EdicionDeUsuario | null;
  yoId: string;
  duenasActivas: number;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [correo, setCorreo] = useState("");
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState<RolDePanel>("asistente");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cargado, setCargado] = useState<string | null>(null);

  const llave = edicion === null ? null : edicion.modo === "nueva" ? "nueva" : edicion.usuario.id;
  if (edicion !== null && cargado !== llave) {
    setCargado(llave);
    setCorreo("");
    setNombre("");
    setRol("asistente");
    setError(null);
  }

  if (edicion === null) return null;

  const cerrar = () => {
    setCargado(null);
    setError(null);
    alCerrar();
  };

  async function darDeAlta() {
    const unCorreo = correo.trim().toLowerCase();
    const unNombre = nombre.trim();
    if (unCorreo === "") {
      setError("Falta el correo. Es el mismo con el que esa persona entra a Access.");
      return;
    }
    if (unNombre === "") {
      setError("Falta el nombre. Es como la va a ver usted en la lista.");
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      await pedir("/api/usuarios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ correo: unCorreo, nombre: unNombre, rol }),
      });
      alGuardar();
      cerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarAcceso(activo: boolean) {
    if (edicion === null || edicion.modo !== "editar") return;
    setGuardando(true);
    setError(null);
    try {
      await pedir(`/api/usuarios/${encodeURIComponent(edicion.usuario.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ activo }),
      });
      alGuardar();
      cerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  // ---- Alta -----------------------------------------------------------
  if (edicion.modo === "nueva") {
    return (
      <Hoja
        abierta
        titulo="Dar de alta a alguien"
        alCerrar={cerrar}
        pie={
          <>
            <button type="button" onClick={cerrar} className={`${BOTON} border border-line`}>
              Cancelar
            </button>
            <button
              type="button"
              onClick={darDeAlta}
              disabled={guardando}
              className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
            >
              {guardando ? "Dando de alta…" : "Dar de alta"}
            </button>
          </>
        }
      >
        {error === null ? null : <Aviso>{error}</Aviso>}

        <p className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3 text-[13px]">
          Esto es la mitad del acceso. La otra mitad es Cloudflare Access: si ese correo no está
          también en la aplicación de Access, la persona no va a poder entrar aunque aparezca
          aquí. Pídale a Juan que lo agregue allá.
        </p>

        <Campo
          etiqueta="Correo"
          ayuda="El mismo con el que entra a Access. Las mayúsculas dan igual: se guarda en minúsculas."
        >
          <input
            className={ENTRADA}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={correo}
            onChange={(e) => {
              setCorreo(e.target.value);
              setError(null);
            }}
            placeholder="asistente@babycaleb.com"
          />
        </Campo>

        <Campo etiqueta="Nombre" ayuda="Como la va a ver usted en la lista.">
          <input
            className={ENTRADA}
            value={nombre}
            onChange={(e) => {
              setNombre(e.target.value);
              setError(null);
            }}
          />
        </Campo>

        <Grupo
          pregunta="¿Qué va a poder hacer?"
          ayuda="Esto no es una descripción: es lo que el servidor aplica en cada llamada."
        >
          {ROLES_DE_PANEL.map((r) => (
            <Opcion
              key={r}
              nombre="rol-de-usuario"
              marcada={rol === r}
              alElegir={() => {
                setRol(r);
                setError(null);
              }}
              titulo={ETIQUETAS_ROL[r]}
              ayuda={QUE_HACE[r]}
            />
          ))}
        </Grupo>

        <p className="m-0 text-[13px] text-muted">
          Con el rol de {ETIQUETAS_ROL[rol].toLowerCase()} va a poder cambiar:{" "}
          {PERMISOS.filter((p) => nivelDe(rol, p) === "editar")
            .map((p) => p.replace(/_/g, " "))
            .join(", ") || "nada"}
          .
        </p>
      </Hoja>
    );
  }

  // ---- Quitar o devolver el acceso ------------------------------------
  const u = edicion.usuario;
  const esUsted = u.id === yoId;
  const ultimaDuena = u.rol === "duena" && u.activo === 1 && duenasActivas <= 1;

  return (
    <Hoja
      abierta
      titulo={u.nombre}
      alCerrar={cerrar}
      pie={
        <>
          <button type="button" onClick={cerrar} className={`${BOTON} border border-line`}>
            Cerrar
          </button>
          {u.activo === 1 ? (
            <button
              type="button"
              onClick={() => cambiarAcceso(false)}
              disabled={guardando || ultimaDuena}
              className={`${BOTON} bg-fg text-bg disabled:opacity-50`}
            >
              {guardando ? "Guardando…" : "Quitar el acceso"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => cambiarAcceso(true)}
              disabled={guardando}
              className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
            >
              {guardando ? "Guardando…" : "Devolver el acceso"}
            </button>
          )}
        </>
      }
    >
      {error === null ? null : <Aviso>{error}</Aviso>}

      <dl className="m-0 mb-4 grid gap-2">
        <div>
          <dt className="m-0 text-[12px] uppercase tracking-wide text-muted">Correo</dt>
          <dd className="m-0 break-all">{u.correo}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12px] uppercase tracking-wide text-muted">Rol</dt>
          <dd className="m-0">
            {ETIQUETAS_ROL[u.rol]} — {QUE_HACE[u.rol]}
          </dd>
        </div>
        <div>
          <dt className="m-0 text-[12px] uppercase tracking-wide text-muted">Ahora mismo</dt>
          <dd className="m-0">{u.activo === 1 ? "Entra al panel" : "No puede entrar"}</dd>
        </div>
      </dl>

      {ultimaDuena ? (
        // El servidor lo rechaza igual, y lo rechaza mirando cuántas dueñas
        // quedaron DESPUÉS del cambio. Esto es para no ofrecer un botón que
        // va a dar error: enterarse al tocarlo es enterarse tarde.
        <p className="m-0 rounded-[12px] border border-accent-edge bg-surface p-3">
          <strong>Es la única dueña con acceso.</strong> Si se lo quita, no quedaría nadie que
          pueda administrar el sistema ni devolverle el acceso a nadie — y eso no se arregla desde
          el panel. Dé de alta a otra dueña primero.
        </p>
      ) : esUsted && u.activo === 1 ? (
        <p className="m-0 rounded-[12px] border border-accent-edge bg-surface p-3">
          <strong>Es su propia cuenta.</strong> Si se quita el acceso, deja de entrar en la
          siguiente pantalla y va a necesitar que otra dueña se lo devuelva.
        </p>
      ) : u.activo === 1 ? (
        <p className="m-0 text-[13px] text-muted">
          Quitarle el acceso tiene efecto de inmediato, sin esperar a que se le caduque la sesión.
          La fila no se borra: su nombre sigue en los pedidos que tomó.
        </p>
      ) : (
        <p className="m-0 text-[13px] text-muted">
          No entra al panel. Si vuelve, devuélvale el acceso aquí: no hace falta darla de alta otra
          vez.
        </p>
      )}
    </Hoja>
  );
}
