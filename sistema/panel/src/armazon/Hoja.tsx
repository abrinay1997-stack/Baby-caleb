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
  /**
   * Quién tenía el foco antes de abrir, para devolvérselo al cerrar.
   *
   * Un `<dialog>` nativo ya hace esto solo… mientras siga en el documento. Y
   * aquí no sigue: las pantallas montan la hoja con `{editando && <Hoja…>}`, o
   * sea que cerrar DESMONTA el diálogo, y el navegador se queda sin el
   * elemento al que devolver el foco. Medido en las siete hojas: seis dejaban
   * el foco en `<body>` —tanto con Escape como con la equis— y solo la de
   * Llaves lo devolvía, justo porque esa se queda montada.
   *
   * Lo que eso significa en la mano: la dueña cambia un precio, cierra, y el
   * tabulador vuelve a empezar desde «Saltar al contenido». Para llegar al
   * siguiente producto hay que recorrer la lista entera otra vez. Con el
   * teclado del teléfono abierto encima de media pantalla, o con un conmutador,
   * eso es perder el sitio en cada edición.
   *
   * El cajón del menú ya resolvía esto mismo guardando su disparador
   * (`Cajon.tsx`). Aquí no hace falta que cada pantalla pase una referencia:
   * el elemento que tenía el foco en el momento de abrir ES el que la abrió,
   * así que se guarda aquí y vale para las trece hojas y para las que vengan.
   */
  const devolverElFoco = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    // `showModal` es lo que enciende la trampa de foco y el fondo inerte.
    // Abrirlo poniendo el atributo `open` a mano NO hace nada de eso.
    if (abierta && !d.open) {
      const antes = document.activeElement;
      // `<body>` no cuenta como sitio al que volver, y un elemento de dentro
      // de la propia hoja tampoco: se va con ella.
      devolverElFoco.current =
        antes instanceof HTMLElement && antes !== document.body && !d.contains(antes)
          ? antes
          : null;
      d.showModal();
    }
    if (!abierta && d.open) d.close();
  }, [abierta]);

  // Al desmontarse —que es como se cierran de verdad estas hojas— el foco
  // vuelve a la fila o al botón que la abrió. Va en su propio efecto, sin
  // dependencias, para que corra UNA vez al salir: hacerlo dentro del efecto de
  // arriba lo dispararía en cada cambio de `abierta` y robaría el foco a media
  // edición.
  //
  // `isConnected` porque la fila puede haber desaparecido mientras la hoja
  // estaba abierta (se borró el producto, cambió el filtro): enfocar un nodo
  // que ya no está en el documento no hace nada y deja el foco en `<body>`
  // igual, así que no se finge que se arregló.
  useEffect(() => {
    return () => {
      const volver = devolverElFoco.current;
      if (volver !== null && volver.isConnected) volver.focus();
    };
  }, []);

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
