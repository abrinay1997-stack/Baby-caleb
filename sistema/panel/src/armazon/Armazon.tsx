import { useId, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { Yo } from "../api";
import { Frontera } from "../Frontera";
import { ETIQUETAS_ROL, type Permiso } from "../permisos";
import { BarraInferior } from "./BarraInferior";
import { Cajon } from "./Cajon";
import { destinoDe, destinosDeLaBarra, seccionesVisibles } from "./navegacion";

/**
 * El armazón del panel: lo que se ve en todas las pantallas.
 *
 * En escritorio, una barra lateral. En el teléfono, una barra inferior con
 * cuatro destinos y un cajón para el resto. No es la misma navegación en dos
 * tamaños: son dos navegaciones, porque el §7d dice que la del teléfono no es
 * la del escritorio girada.
 */

export function Armazon({ yo }: { yo: Yo }) {
  const [menuAbierto, setMenuAbierto] = useState(false);
  const disparador = useRef<HTMLButtonElement>(null);
  const idDelCajon = useId();
  const { pathname } = useLocation();

  const puede = (p: Permiso) => yo.permisos[p] !== "no";
  const secciones = seccionesVisibles(puede);
  const deLaBarra = destinosDeLaBarra(puede);
  const actual = destinoDe(pathname);

  return (
    <div className="min-h-[100dvh] bg-bg text-fg">
      {/* El primer foco de la página, siempre (§7i). */}
      <a href="#contenido" className="saltar">
        Saltar al contenido
      </a>

      <div className="md:flex">
        {/* Escritorio: barra lateral. */}
        <aside className="solo-escritorio sticky top-0 h-[100dvh] w-60 shrink-0 overflow-y-auto border-r border-line bg-surface">
          <div className="px-5 py-5">
            <p className="m-0 text-[17px] font-bold">Baby Caleb</p>
            <p className="m-0 text-[12px] text-muted">Panel del negocio</p>
          </div>
          <nav aria-label="Navegación principal">
            {secciones.map((s) => (
              <section key={s.titulo} className="pb-2">
                <h2 className="px-5 pb-1 pt-3 text-[12px] font-bold uppercase tracking-wide text-muted">
                  {s.titulo}
                </h2>
                <ul className="m-0 list-none p-0">
                  {s.destinos.map((d) => (
                    <li key={d.ruta}>
                      <NavLink
                        to={d.ruta}
                        end={d.ruta === "/"}
                        className={({ isActive }) =>
                          `tactil flex items-center px-5 no-underline ${
                            isActive
                              ? "border-l-[3px] border-accent-edge bg-accent/10 pl-[17px] font-bold text-accent-strong"
                              : "text-fg"
                          }`
                        }
                      >
                        {d.nombre}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
            <div className="min-w-0">
              <h1 className="m-0 truncate text-[17px] font-bold">
                {actual?.nombre ?? "Panel"}
              </h1>
              {actual ? (
                <p className="m-0 truncate text-[12px] text-muted">{actual.descripcion}</p>
              ) : null}
            </div>
            <p className="m-0 shrink-0 text-right text-[12px] text-muted">
              <span className="block font-bold text-fg">{yo.usuario.nombre}</span>
              {ETIQUETAS_ROL[yo.usuario.rol]}
            </p>
          </header>

          {/* `contenido` baja a 14 px de relleno en el teléfono (§7h). */}
          <main id="contenido" className="contenido p-6">
            {/* La frontera va AQUÍ y no envolviendo al armazón: si una pantalla
                se rompe, la navegación tiene que seguir viva para poder salir
                de ella. Y la `key` con la ruta la remonta al navegar, que es lo
                que hace que irse a otra pestaña arregle la pantalla rota. */}
            <Frontera key={pathname} donde={actual?.nombre ?? pathname}>
              <Outlet />
            </Frontera>
          </main>
        </div>
      </div>

      <BarraInferior
        destinos={deLaBarra}
        alAbrirMenu={() => setMenuAbierto(true)}
        menuAbierto={menuAbierto}
        idDelCajon={idDelCajon}
        disparador={disparador}
      />
      <Cajon
        id={idDelCajon}
        abierto={menuAbierto}
        alCerrar={() => setMenuAbierto(false)}
        secciones={secciones}
        disparador={disparador}
      />
    </div>
  );
}
