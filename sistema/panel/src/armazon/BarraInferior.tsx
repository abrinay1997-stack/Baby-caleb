import { NavLink } from "react-router-dom";
import { ICONOS, IconoMenu } from "./Iconos";
import type { Destino } from "./navegacion";

/**
 * La barra inferior del teléfono.
 *
 * No es la barra lateral girada ni una hamburguesa suelta (§7d): deja a la
 * vista lo de todos los días y manda el resto al cajón.
 *
 * ## Por qué icono Y palabra
 *
 * Antes era solo palabras, y parecía una fila de pestañas de escritorio
 * encogida. El icono es lo que se encuentra con el ojo sin leer; la palabra es
 * lo que quita la duda de qué significa el dibujo. Las dos cosas: un icono
 * solo obliga a adivinar, y una palabra sola hace que haya que leer cuatro
 * veces para elegir.
 *
 * ## Por qué el activo no es solo color
 *
 * El activo lleva `aria-current="page"`, la pastilla rellena detrás del icono,
 * el icono en color y la palabra en negrita. Cuatro señales, de las cuales
 * tres se ven sin distinguir el naranja del navy. El color solo no es un
 * estado para quien no lo distingue, y aquí la persona que más usa esto lo
 * hace con una mano y con prisa.
 */

export interface BarraInferiorProps {
  destinos: Destino[];
  alAbrirMenu: () => void;
  menuAbierto: boolean;
  idDelCajon: string;
  disparador: React.RefObject<HTMLButtonElement | null>;
}

/** Mismo alto y mismo reparto para los enlaces y para el botón del cajón. */
const CELDA =
  "tactil flex h-full w-full flex-col items-center justify-center gap-1 px-1 py-1.5 " +
  "text-[12px] no-underline focus-visible:outline-accent-edge focus-visible:outline-2 " +
  "focus-visible:-outline-offset-2 rounded-[12px]";

/** La pastilla que va detrás del icono. Rellena solo cuando está activo. */
const PASTILLA = "flex items-center justify-center rounded-full px-3.5 py-1 transition-colors";

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
      // El borde y el fondo opaco importan: debajo pasa el contenido, y con
      // fondo translúcido las cifras de una fila se leerían a través de la
      // barra.
      className="solo-telefono fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="m-0 flex list-none items-stretch justify-around gap-1 p-1">
        {destinos.map((d) => {
          const Icono = ICONOS[d.ruta];
          return (
            <li key={d.ruta} className="flex-1">
              <NavLink
                to={d.ruta}
                end={d.ruta === "/"}
                className={({ isActive }) =>
                  `${CELDA} ${isActive ? "font-bold text-accent-strong" : "text-muted"}`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      aria-hidden="true"
                      className={`${PASTILLA} ${isActive ? "bg-accent text-accent-fg" : "bg-transparent"}`}
                    >
                      {Icono ? <Icono className="h-[22px] w-[22px]" /> : null}
                    </span>
                    <span className="leading-none">{d.nombre}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}

        <li className="flex-1">
          <button
            ref={disparador}
            type="button"
            onClick={alAbrirMenu}
            aria-expanded={menuAbierto}
            aria-controls={idDelCajon}
            className={`${CELDA} ${menuAbierto ? "font-bold text-accent-strong" : "text-muted"}`}
          >
            <span
              aria-hidden="true"
              className={`${PASTILLA} ${menuAbierto ? "bg-accent text-accent-fg" : "bg-transparent"}`}
            >
              <IconoMenu className="h-[22px] w-[22px]" />
            </span>
            <span className="leading-none">Menú</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
