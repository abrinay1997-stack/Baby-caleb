import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, fecha, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { BOTON_SUELTO } from "../formulario";
import { ETIQUETAS_ROL, PERMISOS, type Rol, nivelDe } from "../permisos";
import { EditarUsuario, type EdicionDeUsuario, type UsuarioEditable } from "./EditarUsuario";

const TEXTO_NIVEL = { no: "—", ver: "Ver", editar: "Cambiar" } as const;

export function Usuarios() {
  const yo = useOutletContext<Yo>();
  const [recarga, setRecarga] = useState(0);
  const estado = useCarga<{ usuarios: UsuarioEditable[] }>("/api/usuarios", [recarga]);
  const [edicion, setEdicion] = useState<EdicionDeUsuario | null>(null);

  // Quién entra al panel es un ajuste, y la matriz se lo da solo a la dueña.
  // El servidor lo comprueba en cada llamada; esto es para no ofrecer un botón
  // que va a responder 403.
  const puedeTocar = yo.permisos["ajustes"] === "editar";

  return (
    <Carga estado={estado} que="los usuarios">
      {(d) => {
        // Para avisar ANTES de que alguien intente quitarle el acceso a la
        // última dueña. Quien lo impide de verdad es el servidor, mirando
        // cuántas quedaron después del cambio; esto solo evita ofrecer un
        // botón que va a dar error.
        const duenasActivas = d.usuarios.filter(
          (u) => u.rol === "duena" && u.activo === 1,
        ).length;

        return (
          <div className="grid gap-4">
            <Tarjeta>
              <p className="m-0 text-muted">
                Entrar al panel son dos cosas distintas: Cloudflare Access comprueba que la persona
                es quien dice ser, y esta lista dice si además trabaja aquí. Por eso quitarle el
                acceso a alguien es desactivarlo aquí — tiene efecto de inmediato, sin esperar a que
                se le caduque la sesión y sin tocar nada en Cloudflare. Dar de alta, en cambio, son
                las dos cosas: el correo tiene que estar también en Access.
                {puedeTocar ? " Toque a una persona para quitarle o devolverle el acceso." : ""}
              </p>
            </Tarjeta>

            {puedeTocar ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setEdicion({ modo: "nueva" })}
                  className={`${BOTON_SUELTO} bg-accent text-accent-fg`}
                >
                  Dar de alta
                </button>
              </div>
            ) : null}

            {d.usuarios.length === 0 ? (
              <Vacio
                titulo="Todavía no hay nadie"
                detalle="Mientras esta lista esté vacía, nadie entra al panel aunque pase Access."
              />
            ) : (
              <Rejilla columnas={["Nombre", "Correo", "Rol", "Telegram", "Desde", "Estado"]}>
                {d.usuarios.map((u) => (
                  <Fila key={u.id}>
                    <Celda etiqueta="">
                      {puedeTocar ? (
                        // El nombre ES el botón: en un teléfono, un icono de
                        // 24 px al lado de cada fila se falla con el pulgar.
                        <button
                          type="button"
                          onClick={() => setEdicion({ modo: "editar", usuario: u })}
                          className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {u.nombre}
                          <span className="sr-only"> — tocar para cambiar su acceso</span>
                        </button>
                      ) : (
                        u.nombre
                      )}
                    </Celda>
                    <Celda etiqueta="Correo" className="break-all text-muted">
                      {u.correo}
                    </Celda>
                    <Celda etiqueta="Rol" papel="clave">
                      {ETIQUETAS_ROL[u.rol]}
                    </Celda>
                    <Celda etiqueta="Telegram" className="text-muted">
                      {u.telegram_chat_id ? "Vinculado" : "—"}
                    </Celda>
                    <Celda etiqueta="Desde" className="text-muted">
                      {fecha(u.creado_en)}
                    </Celda>
                    <Celda etiqueta="Estado" papel="estado">
                      {u.activo === 1 ? (
                        <Pastilla tono="bien">Activo</Pastilla>
                      ) : (
                        <Pastilla tono="mal">Sin acceso</Pastilla>
                      )}
                    </Celda>
                  </Fila>
                ))}
              </Rejilla>
            )}

            <section>
              <h2 className="mb-2 mt-2 text-[17px] font-bold">Qué puede cada rol</h2>
              <p className="mb-3 mt-0 text-muted">
                Esta tabla no es una descripción: es la que el servidor aplica en cada llamada.
              </p>
              <Rejilla columnas={["Permiso", "Dueña", "Asistente", "Contadora"]}>
                {PERMISOS.map((permiso) => (
                  <Fila key={permiso}>
                    <Celda etiqueta="">{permiso.replace(/_/g, " ")}</Celda>
                    {(["duena", "asistente", "contadora"] as Rol[]).map((rol) => (
                      <Celda key={rol} etiqueta={ETIQUETAS_ROL[rol]}>
                        {TEXTO_NIVEL[nivelDe(rol, permiso)]}
                      </Celda>
                    ))}
                  </Fila>
                ))}
              </Rejilla>
            </section>

            <EditarUsuario
              edicion={edicion}
              yoId={yo.usuario.id}
              duenasActivas={duenasActivas}
              alCerrar={() => setEdicion(null)}
              alGuardar={() => setRecarga((n) => n + 1)}
            />
          </div>
        );
      }}
    </Carga>
  );
}
