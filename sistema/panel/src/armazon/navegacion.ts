import type { Permiso } from "../permisos";

/**
 * El mapa del panel.
 *
 * Está en un solo sitio porque lo usan tres cosas que tienen que decir lo
 * mismo: la barra lateral de escritorio, la barra inferior del teléfono y el
 * cajón. Si cada una llevara su lista, tarde o temprano una ofrece algo que
 * otra esconde.
 *
 * Cada destino declara QUÉ PERMISO necesita. La pantalla no se oculta por
 * cortesía: el servidor ya rechaza lo que no toca, y esto evita ofrecer un
 * botón que va a responder 403. Las dos capas hacen falta — esconder sin
 * comprobar no es seguridad.
 */

export interface Destino {
  ruta: string;
  nombre: string;
  /** Para el lector de pantalla cuando solo se ve el icono. */
  descripcion: string;
  permiso: Permiso | null;
  /**
   * El nombre CORTO, solo para la barra inferior del teléfono.
   *
   * La barra reparte el ancho entre sus celdas, así que un nombre largo no se
   * corta: se parte. «Entregas del día» caía en dos renglones contra el borde
   * mientras «Resumen» y «Pedidos» ocupaban uno, y la fila se leía torcida.
   *
   * Solo cambia la palabra de la barra. El título de la pantalla, el cajón y
   * el lector de pantalla siguen diciendo el nombre entero: acortar en la
   * barra es ahorrar espacio, no renombrar la sección.
   */
  corto?: string;
}

export interface Seccion {
  /** Va como `<h2>` de verdad en el cajón (§7d). */
  titulo: string;
  destinos: Destino[];
}

export const SECCIONES: Seccion[] = [
  {
    titulo: "Inicio",
    destinos: [
      {
        ruta: "/",
        nombre: "Resumen",
        descripcion: "Cómo va el negocio hoy",
        permiso: null,
      },
    ],
  },
  {
    titulo: "Lo que se vende",
    destinos: [
      {
        ruta: "/pedidos",
        nombre: "Pedidos",
        descripcion: "Las ventas: en qué va cada una y qué falta por cobrar",
        permiso: "pedidos",
      },
      {
        ruta: "/cobros",
        nombre: "Cobros",
        descripcion: "Los comprobantes que hay que mirar",
        permiso: "cobros",
      },
      {
        ruta: "/clientas",
        nombre: "Clientas",
        descripcion: "Sus datos: lo que falta para cobrarle con tarjeta y para facturarle",
        permiso: "pedidos",
      },
      {
        ruta: "/catalogo",
        nombre: "Catálogo",
        descripcion: "Productos, tallas y precios",
        permiso: "pedidos",
      },
      {
        ruta: "/existencias",
        nombre: "Existencias",
        descripcion: "Cuánto hay y en qué bodega",
        permiso: "pedidos",
      },
      {
        ruta: "/bodegas",
        nombre: "Bodegas",
        descripcion: "Dónde se guarda la mercancía",
        permiso: "pedidos",
      },
    ],
  },
  {
    titulo: "Entregas",
    destinos: [
      {
        ruta: "/entregas",
        nombre: "Entregas del día",
        corto: "Entregas",
        descripcion: "Qué sale hoy, quién lo lleva y qué se cobró",
        permiso: "pedidos",
      },
      {
        ruta: "/motorizados",
        nombre: "Quién reparte",
        descripcion: "El equipo de la calle: quién está activo y en qué anda",
        // Verlos va con «pedidos» porque quien reparte las rutas del día
        // necesita saber a quién asignarlas. Darlos de alta pide «ajustes», y
        // eso lo comprueba el servidor, no este mapa.
        permiso: "pedidos",
      },
      {
        ruta: "/zonas",
        nombre: "Zonas de envío",
        descripcion: "A dónde se entrega y cuánto cuesta",
        permiso: "pedidos",
      },
    ],
  },
  {
    titulo: "El dinero",
    destinos: [
      {
        ruta: "/contabilidad",
        nombre: "Contabilidad",
        descripcion: "Los libros, el estado de resultados y el cierre de mes",
        permiso: "contabilidad",
      },
    ],
  },
  {
    titulo: "Configuración",
    destinos: [
      {
        ruta: "/ajustes",
        nombre: "Ajustes",
        descripcion: "Las reglas con cifras del negocio",
        permiso: "ajustes",
      },
      {
        ruta: "/pasarelas",
        nombre: "Pasarelas de cobro",
        descripcion: "Con qué se cobra en la web, y si está en prueba o en real",
        permiso: "ajustes",
      },
      {
        ruta: "/llaves",
        nombre: "Llaves de conexión",
        descripcion: "Para que un programa de fuera consulte el sistema sin abrir el panel",
        // Sin permiso: cada quien maneja las SUYAS, y todos los roles pueden
        // querer conectar una herramienta propia. Lo que esa llave alcance lo
        // sigue decidiendo el rol de quien la creó, no la llave.
        permiso: null,
      },
      {
        ruta: "/usuarios",
        nombre: "Usuarios",
        descripcion: "Quién entra al panel y qué puede",
        permiso: "ajustes",
      },
    ],
  },
];

export const TODOS_LOS_DESTINOS: Destino[] = SECCIONES.flatMap((s) => s.destinos);

/**
 * Los cuatro de la barra inferior del teléfono (§7d).
 *
 * Cuatro y no catorce: la barra deja a la vista lo que se usa a diario y el
 * resto se va al cajón. El cuarto es el propio cajón, no un destino.
 *
 * Son Resumen, Pedidos y Entregas, y no el catálogo: el catálogo se toca
 * cuando cambia un precio, que es de vez en cuando. Lo que se abre todos los
 * días es «qué vendí» y «qué sale hoy». El criterio es el uso diario, no la
 * importancia.
 */
export const RUTAS_BARRA = ["/", "/pedidos", "/entregas"] as const;

export function destinosDeLaBarra(puede: (p: Permiso) => boolean): Destino[] {
  return RUTAS_BARRA.map((r) => TODOS_LOS_DESTINOS.find((d) => d.ruta === r)).filter(
    (d): d is Destino => d !== undefined && (d.permiso === null || puede(d.permiso)),
  );
}

/**
 * Los atajos que el Resumen enseña arriba, con icono grande y palabra corta.
 *
 * ## Por qué existen
 *
 * La barra de abajo lleva tres destinos y no catorce, y lo que no cabe se va
 * al cajón: dos toques y quince renglones que leer. Eso está bien para lo que
 * se abre una vez al mes y mal para lo que se abre cada día — y lo de cada día
 * que no cupo en la barra se quedó sin ningún camino corto.
 *
 * ## El criterio, que no es «lo importante»
 *
 * Entra aquí lo que se abre TODOS LOS DÍAS para contestarle a una clienta o
 * para mover plata, **y que la barra de abajo no lleva ya**. Las dos
 * condiciones, y la segunda es la que hace que esto no sea decorado: repetir
 * aquí «Pedidos» y «Entregas» sería gastar la mitad de la fila en dos sitios
 * que ya están a un toque, y dejar fuera los que están a tres.
 *
 * Por eso quedan estos cuatro:
 *
 *  - **Cobros** — llega el comprobante por WhatsApp y hay que mirarlo. Es
 *    dinero y es de hoy.
 *  - **Catálogo** — «¿cuánto cuesta?». CONSULTAR un precio es diario aunque
 *    CAMBIARLO sea de vez en cuando, que es lo que dice el comentario de
 *    `RUTAS_BARRA`: ahí se decidía quién se queda con uno de los tres sitios
 *    fijos de la barra, y eso es una pelea mucho más cara que un atajo.
 *  - **Existencias** — «¿todavía tienen la 0-3m?». Es la otra mitad de la
 *    misma conversación.
 *  - **Clientas** — «soy la que compró la semana pasada».
 *
 * Y NO entran Bodegas, Zonas, Quién reparte, Contabilidad, Ajustes, Pasarelas,
 * Llaves ni Usuarios: se tocan cuando algo cambia, no cada mañana. Un atajo a
 * todo es un menú, y el menú ya está.
 *
 * ## Lo que no reemplaza
 *
 * Las tarjetas de «Hay que atender» del Resumen también llevan a sitios, pero
 * solo APARECEN cuando hay algo pendiente: el día que todo está atendido no
 * queda un solo enlace en la pantalla. Estos cuatro están siempre, pase lo que
 * pase con los datos — por eso se pintan fuera de `Carga`, y se ven incluso si
 * el resumen no carga.
 */
export const RUTAS_ATAJOS = ["/cobros", "/catalogo", "/existencias", "/clientas"] as const;

export function atajosDelResumen(puede: (p: Permiso) => boolean): Destino[] {
  return RUTAS_ATAJOS.map((r) => TODOS_LOS_DESTINOS.find((d) => d.ruta === r)).filter(
    (d): d is Destino => d !== undefined && (d.permiso === null || puede(d.permiso)),
  );
}

export function seccionesVisibles(puede: (p: Permiso) => boolean): Seccion[] {
  return SECCIONES.map((s) => ({
    ...s,
    destinos: s.destinos.filter((d) => d.permiso === null || puede(d.permiso)),
  })).filter((s) => s.destinos.length > 0);
}

/** El destino que corresponde a una ruta, para el título de la página. */
export function destinoDe(ruta: string): Destino | undefined {
  return TODOS_LOS_DESTINOS.find((d) => d.ruta === ruta);
}
