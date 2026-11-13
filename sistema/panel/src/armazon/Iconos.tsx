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

/** Pedidos: lo que una clienta encargó. Una nota con sus renglones. */
export function IconoPedidos({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M7.5 3h9a1.5 1.5 0 0 1 1.5 1.5v15.1a.4.4 0 0 1-.62.33L15 18.2l-2.38 1.6a1.1 1.1 0 0 1-1.24 0L9 18.2l-2.38 1.73A.4.4 0 0 1 6 19.6V4.5A1.5 1.5 0 0 1 7.5 3Z" />
      <path d="M9 7.5h6M9 11h6" />
    </svg>
  );
}

/** Entregas del día: lo que sale a la calle. Una caja en movimiento. */
export function IconoEntregas({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 7.6 12 3.5l9 4.1v8.8L12 20.5 3 16.4Z" />
      <path d="M3 7.6 12 11.7l9-4.1M12 11.7v8.8" />
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

/** Caleb: preguntarle algo. Un globo de conversación. */
export function IconoCaleb({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M20.5 11.6c0 3.9-3.8 7.1-8.5 7.1a9.8 9.8 0 0 1-2.4-.3l-4.3 1.8a.35.35 0 0 1-.48-.4l.8-3.3C4.3 15.2 3.5 13.5 3.5 11.6c0-3.9 3.8-7.1 8.5-7.1s8.5 3.2 8.5 7.1Z" />
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
 * El icono de cada ruta.
 *
 * Una ruta sin icono no rompe la barra —se queda con su palabra— pero sí
 * rompe la fila: la celda sin dibujo no tiene la pastilla de 22 px, así que su
 * palabra se sube a centrarse mientras las demás se quedan abajo, y la barra
 * se lee torcida. Es lo que pasaba, y en el peor sitio: la barra inferior
 * tenía icono para Resumen y para el Menú, y NINGUNO para Pedidos ni para
 * Entregas del día — que son, por `RUTAS_BARRA`, las dos que se abren todos
 * los días. «Entregas del día» además partía en dos renglones contra el borde.
 *
 * `IconoCatalogo` e `IconoExistencias` estaban escritos y no se dibujaban en
 * ningún sitio: sus rutas no están en la barra. Se quedan porque el cajón o
 * una barra futura pueden usarlos, pero el hueco real estaba en las dos de
 * arriba.
 *
 * La regla, para quien añada un destino a `RUTAS_BARRA`: si va en la barra,
 * lleva icono aquí.
 */
export const ICONOS: Record<string, (p: PropsIcono) => React.JSX.Element> = {
  "/": IconoResumen,
  "/pedidos": IconoPedidos,
  "/entregas": IconoEntregas,
  "/catalogo": IconoCatalogo,
  "/existencias": IconoExistencias,
};
