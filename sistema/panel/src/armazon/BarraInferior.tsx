import { NavLink } from "react-router-dom";
import type { Destino } from "./navegacion";

/**
 * La barra inferior del teléfono.
 *
 * No es la barra lateral girada ni una hamburguesa suelta (§7d): deja a la
 * vista lo de todos los días y manda el resto al cajón. El activo lleva
 * `aria-current="page"` ADEMÁS del color, porque el color solo no es un estado
 * — quien no distingue bien el naranja del navy no vería dónde está.
 */

export interface BarraInferiorProps {
  destinos: Destino[];
  alAbrirMenu: () => void;
  menuAbierto: boolean;
  idDelCajon: string;
  disparador: React.RefObject<HTMLButtonElement | null>;
}

export function BarraInferior({
  destinos,
  alAbrirMenu,
  menuAbierto,
  idDelCajon,
  disparador,
}: BarraInferiorProps) {
  return (
    <nav
      aria-label="Navegación principal"
      className="solo-telefono fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="m-0 flex list-none items-stretch justify-around p-0">
        {destinos.map((d) => (
          <li key={d.ruta} className="flex-1">
            <NavLink
              to={d.ruta}
              end={d.ruta === "/"}
              className={({ isActive }) =>
                `tactil flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-center text-[12px] no-underline ${
                  isActive ? "font-bold text-accent-strong" : "text-muted"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    aria-hidden="true"
                    className={`block h-1 w-6 rounded-full ${isActive ? "bg-accent" : "bg-transparent"}`}
                  />
                  <span>{d.nombre}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}

        <li className="flex-1">
          <button
            ref={disparador}
            type="button"
            onClick={alAbrirMenu}
            aria-expanded={menuAbierto}
            aria-controls={idDelCajon}
            className="tactil flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-[12px] text-muted"
          >
            <span aria-hidden="true" className="block h-1 w-6 rounded-full bg-transparent" />
            <span>Menú</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
