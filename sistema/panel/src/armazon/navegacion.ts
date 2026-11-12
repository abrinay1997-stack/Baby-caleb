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
