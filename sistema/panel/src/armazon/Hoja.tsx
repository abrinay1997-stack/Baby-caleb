import { useEffect, useRef, type ReactNode } from "react";
import { IconoCerrar } from "./Iconos";

/**
 * La hoja que sube desde abajo para editar algo.
 *
 * Es un `<dialog>` de verdad y no un `<div>` con `position: fixed`. La
 * diferencia no es de gusto: el elemento nativo trae la trampa de foco, el
 * cierre con Esc, el fondo inerte y el anuncio al lector de pantalla ya
 * resueltos. Escrito a mano, eso son doscientas líneas que casi siempre salen
 * mal — y salen mal justo para quien navega con teclado, que es quien no puede
 * compensarlo con el ratón.
 *
 * En el teléfono sube desde abajo y ocupa el ancho; en escritorio queda
 * centrada. Las dos cosas las decide el CSS (`.hoja`), no JavaScript midiendo
 * la pantalla.
 */
export function Hoja({
  abierta,
  titulo,
  alCerrar,
  children,
  pie,
}: {
  abierta: boolean;
  titulo: string;
  alCerrar: () => void;
  children: ReactNode;
  /** Los botones de acción. Van fijos abajo, al alcance del pulgar. */
  pie?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    // `showModal` es lo que enciende la trampa de foco y el fondo inerte.
    // Abrirlo poniendo el atributo `open` a mano NO hace nada de eso.
    if (abierta && !d.open) d.showModal();
    if (!abierta && d.open) d.close();
  }, [abierta]);

  return (
    <dialog
      ref={ref}
      className="hoja"
      aria-labelledby="hoja-titulo"
      // Esc y el clic en el fondo cierran. `onCancel` es el evento del
      // elemento nativo: sin esto, Esc cerraría el diálogo sin avisar a React
      // y el estado quedaría diciendo que sigue abierto.
      onCancel={(e) => {
        e.preventDefault();
        alCerrar();
      }}
      onClick={(e) => {
        if (e.target === ref.current) alCerrar();
      }}
    >
      <form method="dialog" className="contents">
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id="hoja-titulo" className="m-0 text-[18px] font-bold">
            {titulo}
          </h2>
          <button
            type="button"
            onClick={alCerrar}
            className="tactil -m-2 flex items-center justify-center rounded-[12px] p-2 text-muted focus-visible:outline-accent-edge focus-visible:outline-2"
          >
            <IconoCerrar className="h-6 w-6" />
            <span className="sr-only">Cerrar</span>
          </button>
        </header>

        <div className="hoja-cuerpo px-5 py-4">{children}</div>

        {pie === undefined ? null : (
          <footer
            className="flex gap-2 border-t border-line px-5 py-4"
            style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom, 0px))" }}
          >
            {pie}
          </footer>
        )}
      </form>
    </dialog>
  );
}
