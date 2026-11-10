import { fecha, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { ETIQUETAS_ROL, PERMISOS, type Rol, type RolDePanel, nivelDe } from "../permisos";

interface UsuarioFila {
  id: string;
  correo: string;
  nombre: string;
  rol: RolDePanel;
  telegram_chat_id: string | null;
  activo: number;
  creado_en: number;
}

const TEXTO_NIVEL = { no: "—", ver: "Ver", editar: "Cambiar" } as const;

export function Usuarios() {
  const estado = useCarga<{ usuarios: UsuarioFila[] }>("/api/usuarios");

  return (
    <Carga estado={estado} que="los usuarios">
      {(d) => (
        <div className="grid gap-4">
          <Tarjeta>
            <p className="m-0 text-muted">
              Entrar al panel son dos cosas distintas: Cloudflare Access comprueba que la persona
              es quien dice ser, y esta lista dice si además trabaja aquí. Por eso quitarle el
              acceso a alguien es desactivarlo aquí — tiene efecto de inmediato, sin esperar a que
              se le caduque la sesión y sin tocar nada en Cloudflare.
            </p>
          </Tarjeta>

          {d.usuarios.length === 0 ? (
            <Vacio
              titulo="Todavía no hay nadie"
              detalle="Mientras esta lista esté vacía, nadie entra al panel aunque pase Access. Las personas se agregan en F2.11, junto con la aplicación de Access."
            />
          ) : (
            <Rejilla columnas={["Nombre", "Correo", "Rol", "Telegram", "Desde", "Estado"]}>
              {d.usuarios.map((u) => (
                <Fila key={u.id}>
                  <Celda etiqueta="">{u.nombre}</Celda>
                  <Celda etiqueta="Correo" className="break-all text-muted">
                    {u.correo}
                  </Celda>
                  <Celda etiqueta="Rol">{ETIQUETAS_ROL[u.rol]}</Celda>
                  <Celda etiqueta="Telegram" className="text-muted">
                    {u.telegram_chat_id ? "Vinculado" : "—"}
                  </Celda>
                  <Celda etiqueta="Desde" className="text-muted">
                    {fecha(u.creado_en)}
                  </Celda>
                  <Celda etiqueta="Estado">
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
        </div>
      )}
    </Carga>
  );
}
