/**
 * Los iconos de la navegación, dibujados aquí.
 *
 * Sin librería: son cuatro dibujos y la más pequeña del mercado pesa más que
 * todo el panel junto. Van en `currentColor`, así que heredan el color del
 * estado (activo o no) sin que haya que pasárselo.
 *
 * `aria-hidden` en todos: al lado de cada uno va su palabra, y un lector que
 * los nombrara diría las cosas dos veces. El icono es para encontrar rápido
 * con el ojo, no para sustituir al texto — por eso ninguna pantalla se queda
 * solo con el dibujo.
 */

interface PropsIcono {
  className?: string;
}

const comun = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

/** Resumen: cómo va el negocio. Barras de un vistazo. */
export function IconoResumen({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 20h18" />
      <rect x="5" y="12" width="3.5" height="6" rx="1" />
      <rect x="10.25" y="7" width="3.5" height="11" rx="1" />
      <rect x="15.5" y="9.5" width="3.5" height="8.5" rx="1" />
    </svg>
  );
}

/** Catálogo: lo que se vende. Una etiqueta de precio. */
export function IconoCatalogo({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M20.6 12.3 12.9 20a1.9 1.9 0 0 1-2.7 0l-6.6-6.6a1.9 1.9 0 0 1-.55-1.35V4.8c0-1 .8-1.8 1.8-1.8h7.25c.5 0 1 .2 1.35.55l7.15 7.15a1.9 1.9 0 0 1 0 2.7Z" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

/** Existencias: cuánto hay. Cajas apiladas. */
export function IconoExistencias({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <rect x="3" y="12.5" width="8" height="7.5" rx="1.2" />
      <rect x="13" y="12.5" width="8" height="7.5" rx="1.2" />
      <rect x="8" y="4" width="8" height="7.5" rx="1.2" />
      <path d="M10.4 4v2.6M18.4 12.5v2.6M5.6 12.5v2.6" />
    </svg>
  );
}

/** El cajón con todo lo demás. */
export function IconoMenu({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/** Para cerrar el cajón. */
export function IconoCerrar({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/**
 * El icono de cada ruta. Una ruta sin icono NO rompe la barra: se queda con su
 * palabra, que es lo que de verdad la nombra.
 */
export const ICONOS: Record<string, (p: PropsIcono) => React.JSX.Element> = {
  "/": IconoResumen,
  "/catalogo": IconoCatalogo,
  "/existencias": IconoExistencias,
};
