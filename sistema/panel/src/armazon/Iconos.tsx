/**
 * Los iconos de la navegación, dibujados aquí.
 *
 * Sin librería: son quince dibujos de cuatro trazos y la más pequeña del
 * mercado pesa más que todo el panel junto. Van en `currentColor`, así que
 * heredan el color del estado (activo o no) sin que haya que pasárselo.
 *
 * `aria-hidden` en todos: al lado de cada uno va su palabra, y un lector que
 * los nombrara diría las cosas dos veces. El icono es para encontrar rápido
 * con el ojo, no para sustituir al texto — por eso ninguna pantalla se queda
 * solo con el dibujo.
 *
 * ## Cómo se dibuja uno nuevo
 *
 * Todos comparten `comun`: el mismo lienzo de 24, el mismo grosor de trazo,
 * las mismas puntas redondas y `fill="none"`. Eso no es coquetería: un dibujo
 * con otro grosor al lado de los demás se lee como un error de carga.
 *
 * Y la prueba de verdad es el TAMAÑO AL QUE SE USA, no el que se dibuja. En
 * el cajón miden 24 px en la mano de alguien que va con prisa: una silueta que
 * necesita que la miren de cerca no sirve por bonita que sea. De ahí que no
 * haya ningún engranaje (sus dientes se vuelven una mancha), ningún dibujo con
 * más de cuatro trazos, y ninguna pareja de siluetas parecidas dentro de la
 * misma sección del cajón — que es donde se comparan de verdad.
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

/**
 * Cobros: los comprobantes que hay que mirar. Monedas apiladas.
 *
 * Monedas y no un billete: el billete es un rectángulo, y la tarjeta de
 * `IconoPasarelas` también. Dos rectángulos en el mismo cajón se confunden de
 * reojo, que es como se mira un menú. Un cilindro de discos no se parece a
 * nada más de aquí.
 */
export function IconoCobros({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <ellipse cx="12" cy="7" rx="7.5" ry="3.2" />
      <path d="M4.5 7v9.4c0 1.77 3.36 3.2 7.5 3.2s7.5-1.43 7.5-3.2V7" />
      <path d="M19.5 11.7c0 1.77-3.36 3.2-7.5 3.2s-7.5-1.43-7.5-3.2" />
    </svg>
  );
}

/**
 * Clientas: las personas que compran. Dos siluetas.
 *
 * DOS y no una: la otra silueta del panel es `IconoUsuarios`, que es una sola
 * persona dentro de su círculo. Un grupo y un retrato se distinguen por la
 * forma de la mancha, sin leer, que es lo único que se puede pedir a 24 px.
 */
export function IconoClientas({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <circle cx="9.2" cy="8" r="3.6" />
      <path d="M2.8 20v-1.4a5.4 5.4 0 0 1 5.4-5.4h2a5.4 5.4 0 0 1 5.4 5.4V20" />
      <path d="M16.4 4.6a3.6 3.6 0 0 1 0 6.8" />
      <path d="M18.4 13.5a5.4 5.4 0 0 1 2.8 4.7V20" />
    </svg>
  );
}

/**
 * Bodegas: dónde se guarda la mercancía. Una nave con su portón.
 *
 * Un edificio, no cajas: las cajas ya son `IconoExistencias`, y las dos
 * pantallas van seguidas en el cajón. «Cuánto hay» y «dónde está» son dos
 * preguntas distintas y tienen que verse distintas.
 */
export function IconoBodegas({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 20V9.6L12 4.5l9 5.1V20" />
      <path d="M2.2 20h19.6" />
      <path d="M8.6 20v-6.2h6.8V20" />
      <path d="M8.6 16.8h6.8" />
    </svg>
  );
}

/** Quién reparte: el equipo de la calle. Una moto. */
export function IconoMotorizados({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <circle cx="5.6" cy="16.6" r="3.4" />
      <circle cx="18.4" cy="16.6" r="3.4" />
      <path d="M5.6 16.6h4.6l2.2-3.5h4.2" />
      <path d="m16.6 13.1 1.8 3.5" />
      <path d="M15.2 9.4h2.8M16.6 9.4v3.7" />
    </svg>
  );
}

/** Zonas de envío: a dónde se entrega. Un alfiler en el mapa. */
export function IconoZonas({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M12 21.2c4.4-4.6 6.6-8.1 6.6-10.6a6.6 6.6 0 1 0-13.2 0c0 2.5 2.2 6 6.6 10.6Z" />
      <circle cx="12" cy="10.4" r="2.5" />
    </svg>
  );
}

/**
 * Contabilidad: los libros. Uno abierto.
 *
 * El libro y no una calculadora: una calculadora a 24 px es un rectángulo con
 * puntos, y los puntos se pierden. Además la pantalla se llama así por dentro
 * —el libro diario, el mayor—, así que el dibujo dice la misma palabra.
 */
export function IconoContabilidad({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M12 7.2v12.3" />
      <path d="M12 7.2a4.2 4.2 0 0 0-3-1.3H3.4v12.3H9c1.1 0 2.2.5 3 1.3" />
      <path d="M12 7.2a4.2 4.2 0 0 1 3-1.3h5.6v12.3H15c-1.1 0-2.2.5-3 1.3" />
    </svg>
  );
}

/**
 * Ajustes: las reglas con cifras del negocio. Dos deslizadores.
 *
 * Los rieles se cortan donde va el botón en vez de pasar por debajo: a 24 px
 * una línea cruzando un círculo de 4,8 px lo convierte en un borrón.
 */
export function IconoAjustes({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 8.6h3.6M11.4 8.6H21" />
      <circle cx="9" cy="8.6" r="2.4" />
      <path d="M3 15.4h10.6M18.4 15.4H21" />
      <circle cx="16" cy="15.4" r="2.4" />
    </svg>
  );
}

/** Pasarelas de cobro: con qué se cobra en la web. Una tarjeta. */
export function IconoPasarelas({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.4" />
      <path d="M2.6 10.2h18.8" />
      <path d="M6.4 14.8h3.8" />
    </svg>
  );
}

/**
 * Llaves de conexión: para que un programa de fuera entre. Una llave.
 *
 * Acostada y no en diagonal. En diagonal —anilla arriba a la izquierda, caña
 * bajando a la derecha— la silueta es la de una LUPA, y una lupa significa
 * «buscar» en todas partes. Se vio en la captura del cajón. Acostada, con sus
 * dos dientes colgando de la caña, no se parece a ninguna lupa.
 */
export function IconoLlaves({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <circle cx="7.6" cy="12" r="4.3" />
      <path d="M11.9 12H21" />
      <path d="M16.6 12v3.6" />
      <path d="M19.8 12v2.6" />
    </svg>
  );
}

/** Usuarios: quién entra al panel. Una persona en su círculo. */
export function IconoUsuarios({ className }: PropsIcono) {
  return (
    <svg {...comun} className={className}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="9.6" r="3" />
      <path d="M5.9 18.6a6.6 6.6 0 0 1 12.2 0" />
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
 * ## Y después el cajón
 *
 * La barra de abajo quedó bien y el cajón siguió siendo quince renglones de
 * texto pelado: cinco rutas tenían dibujo y diez no. Un menú de solo texto se
 * LEE, y leer quince renglones para elegir uno es justo lo que no se puede
 * hacer con una mano, de pie y con prisa. Ahora el cajón pinta el icono de
 * cada destino, así que esta tabla ya no es «las de la barra»: es TODAS.
 *
 * La regla, para quien añada un destino al mapa: lleva icono aquí, esté o no
 * en la barra. Lo vigila `navegacion.test.ts`, que recorre
 * `TODOS_LOS_DESTINOS` y pide el suyo a cada uno.
 */
export const ICONOS: Record<string, (p: PropsIcono) => React.JSX.Element> = {
  "/": IconoResumen,
  "/pedidos": IconoPedidos,
  "/cobros": IconoCobros,
  "/clientas": IconoClientas,
  "/catalogo": IconoCatalogo,
  "/existencias": IconoExistencias,
  "/bodegas": IconoBodegas,
  "/entregas": IconoEntregas,
  "/motorizados": IconoMotorizados,
  "/zonas": IconoZonas,
  "/contabilidad": IconoContabilidad,
  "/ajustes": IconoAjustes,
  "/pasarelas": IconoPasarelas,
  "/llaves": IconoLlaves,
  "/usuarios": IconoUsuarios,
};
