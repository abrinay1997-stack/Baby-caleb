import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { ICONOS } from "./Iconos";
import type { Seccion } from "./navegacion";

/**
 * El cajón del teléfono.
 *
 * El §7d del sistema de diseño es explícito en por qué no basta con un botón
 * de hamburguesa: «putting everything behind a button that a screen reader
 * cannot open would be prettier and less accessible». Así que la barra inferior
 * deja fuera lo de todos los días y aquí dentro va el resto, con sus títulos de
 * sección como `<h2>` de verdad.
 *
 * Y solo cuenta como terminado si se cumple todo esto, que es lo que hace este
 * componente:
 *
 *  - el disparador lleva `aria-expanded` y `aria-controls`;
 *  - el foco se queda dentro mientras está abierto y vuelve al disparador al
 *    cerrar;
 *  - Escape cierra;
 *  - se abre y se usa solo con el teclado.
 *
 * ## Por qué cada renglón lleva su dibujo
 *
 * La barra de abajo tiene icono y palabra desde el principio. El cajón no: era
 * quince renglones de texto, y quince renglones de texto se LEEN uno por uno.
 * La barra deja fuera todo lo que no es de todos los días, así que el cajón es
 * justo donde hay más donde elegir y menos ayuda había para elegir.
 *
 * El icono va a la IZQUIERDA del nombre y es `aria-hidden` (lo pone `Iconos`):
 * al lado tiene su palabra, y un lector que lo nombrara diría las cosas dos
 * veces. No sustituye al texto — el nombre entero y su explicación siguen ahí,
 * porque un dibujo solo obligaría a adivinar qué es «Pasarelas».
 */

export interface CajonProps {
  abierto: boolean;
  alCerrar: () => void;
  secciones: Seccion[];
  /** A dónde devolver el foco al cerrar. */
  disparador: React.RefObject<HTMLButtonElement | null>;
  id: string;
}

const ENFOCABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Cajon({ abierto, alCerrar, secciones, disparador, id }: CajonProps) {
  const panel = useRef<HTMLDivElement>(null);

  // Escape cierra, y el foco no se escapa del cajón mientras está abierto.
  useEffect(() => {
    if (!abierto) return;

    const enTecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        alCerrar();
        return;
      }
      if (e.key !== "Tab") return;

      const dentro = panel.current?.querySelectorAll<HTMLElement>(ENFOCABLES);
      if (!dentro || dentro.length === 0) return;
      const primero = dentro[0]!;
      const ultimo = dentro[dentro.length - 1]!;

      // Sin esto, tabular desde el último elemento lleva el foco a la página de
      // atrás, que está tapada: se navega a ciegas.
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };

    document.addEventListener("keydown", enTecla);
    // El primer enfocable recibe el foco al abrir.
    panel.current?.querySelector<HTMLElement>(ENFOCABLES)?.focus();

    return () => document.removeEventListener("keydown", enTecla);
  }, [abierto, alCerrar]);

  // Al cerrar, el foco vuelve de donde salió.
  useEffect(() => {
    if (!abierto) disparador.current?.focus();
    // Solo cuando cambia `abierto`: enfocar en cada render robaría el foco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto]);

  return (
    <>
      {/* El fondo oscurecido no es enfocable ni se anuncia: cerrar con él es un
          atajo del ratón, y el teclado ya tiene Escape. */}
      <div
        className={`fixed inset-0 z-40 bg-fg/40 transition-opacity solo-telefono ${
          abierto ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={alCerrar}
        aria-hidden="true"
      />

      <div
        id={id}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Menú del panel"
        // `inert` mientras está cerrado: ni el lector de pantalla ni el
        // tabulador entran en un cajón que no se ve. Sin esto, el foco se va a
        // enlaces invisibles y quien navega con teclado se pierde.
        inert={!abierto}
        className={`solo-telefono fixed inset-y-0 right-0 z-50 w-[min(86vw,22rem)] overflow-y-auto bg-surface shadow-2xl transition-transform duration-200 ${
          abierto ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="m-0 text-[17px] font-bold">Menú</h2>
          <button
            type="button"
            onClick={alCerrar}
            aria-label="Cerrar el menú"
            className="tactil -mr-2 rounded-lg px-3 text-[22px] leading-none"
          >
            ×
          </button>
        </div>

        <nav aria-label="Secciones del panel">
          {secciones.map((seccion) => (
            <section key={seccion.titulo} className="border-b border-line py-2 last:border-0">
              {/* Títulos de sección como h2 de verdad: un lector de pantalla
                  puede saltar por ellos, que es para lo que existen. */}
              <h2 className="px-4 pb-1 pt-2 text-[12px] font-bold uppercase tracking-wide text-muted">
                {seccion.titulo}
              </h2>
              <ul className="m-0 list-none p-0">
                {seccion.destinos.map((d) => {
                  const Icono = ICONOS[d.ruta];
                  return (
                    <li key={d.ruta}>
                      <NavLink
                        to={d.ruta}
                        end={d.ruta === "/"}
                        onClick={alCerrar}
                        className={({ isActive }) =>
                          /* Sin `bg-accent/15` detrás del texto (§7h): un 15 % de
                             naranja sobre la superficie deja el fondo real en
                             #f1e1ce, y `--accent-strong` encima cae a 4.16:1 —el
                             peor contraste del panel, y en el renglón que dice
                             dónde está usted—. La barra de 3 px es la misma que
                             marca el activo en la barra lateral de escritorio:
                             antes el cajón y la barra lateral señalaban el activo
                             de dos maneras distintas. */
                          /* `items-start` y no `items-center`: la explicación
                             de nueve destinos ocupa dos renglones, y centrando
                             el dibujo contra el bloque entero el icono queda a
                             la altura de la EXPLICACIÓN, no del nombre — se ve
                             en la captura: el de «Quién reparte» apuntaba a «El
                             equipo de la calle». El icono es del nombre, así
                             que se alinea con el nombre. */
                          `tactil flex items-start gap-3 px-4 py-2 no-underline ${
                            isActive
                              ? "border-l-[3px] border-accent-edge pl-[13px] font-bold text-accent-strong"
                              : "text-fg"
                          }`
                        }
                        aria-current={undefined}
                      >
                        {/* El hueco del dibujo se reserva SIEMPRE, lleve icono o
                            no. Es la misma lección que la barra de abajo: una
                            celda sin dibujo no deja la fila coja, la deja
                            TORCIDA, porque su texto se corre al sitio del icono
                            y el renglón ya no se alinea con sus vecinos. Hoy
                            todos los destinos tienen el suyo —lo vigila una
                            prueba—, así que esto es solo el seguro. */}
                        <span className="flex w-6 shrink-0 justify-center">
                          {Icono ? <Icono className="h-6 w-6" /> : null}
                        </span>
                        {/* `min-w-0` para que un nombre largo parta dentro de su
                            columna en vez de empujar el cajón de lado (§7g). */}
                        <span className="flex min-w-0 flex-col justify-center">
                          <span>{d.nombre}</span>
                          <span className="text-[12px] font-normal text-muted">
                            {d.descripcion}
                          </span>
                        </span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </div>
    </>
  );
}
