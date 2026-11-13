import { describe, expect, it } from "vitest";
import { ICONOS } from "./Iconos";
import {
  RUTAS_ATAJOS,
  RUTAS_BARRA,
  SECCIONES,
  TODOS_LOS_DESTINOS,
  atajosDelResumen,
  destinoDe,
} from "./navegacion";

/**
 * La barra inferior del teléfono, que es lo que más se toca del panel.
 *
 * Tenía icono para Resumen y para el Menú, y NINGUNO para Pedidos ni para
 * Entregas del día — justo las dos que `RUTAS_BARRA` declara como «lo de todos
 * los días». No era un olvido visible: `ICONOS` llevaba dibujos para
 * `/catalogo` y `/existencias`, que no están en la barra, así que el mapa
 * parecía lleno mientras la barra salía coja.
 *
 * Y no es solo estética. La celda sin dibujo no tiene la pastilla de 22 px, así
 * que su palabra se sube a centrarse mientras las vecinas se quedan abajo: la
 * fila entera se lee torcida. Se ve en la captura, no en el código.
 */
describe("la barra inferior", () => {
  it("cada destino de la barra tiene su icono", () => {
    for (const ruta of RUTAS_BARRA) {
      expect(ICONOS[ruta], `/${ruta} está en la barra y no tiene icono`).toBeDefined();
    }
  });

  it("y la lista no se quedó vacía por un cambio de nombre", () => {
    // Trampa nº 1 del repositorio: un control que comprueba algo que ya era
    // cierto. Con `RUTAS_BARRA` vacía, el bucle de arriba pasa sin mirar nada.
    expect(RUTAS_BARRA.length).toBeGreaterThanOrEqual(3);
  });

  it("todas las rutas de la barra existen en el mapa", () => {
    for (const ruta of RUTAS_BARRA) {
      expect(destinoDe(ruta), `/${ruta} no está en SECCIONES`).toBeDefined();
    }
  });
});

/**
 * El nombre corto es SOLO para la barra.
 *
 * «Entregas del día» partía en dos renglones contra el borde de su celda. El
 * nombre entero sigue siendo el del título de la pantalla y el del cajón:
 * acortar en la barra es ahorrar espacio, no renombrar la sección.
 */
describe("los nombres de la barra", () => {
  it("el corto, cuando existe, es más corto que el entero", () => {
    for (const d of TODOS_LOS_DESTINOS) {
      if (d.corto === undefined) continue;
      expect(d.corto.length, `«${d.corto}» no acorta «${d.nombre}»`).toBeLessThan(
        d.nombre.length,
      );
    }
  });

  it("ninguna palabra de la barra pasa de diez letras", () => {
    // Cinco celdas en 390 px dan unos 78 px por celda. A 12 px, diez letras es
    // lo que cabe en un renglón; más que eso vuelve a partir.
    for (const ruta of RUTAS_BARRA) {
      const d = destinoDe(ruta);
      if (d === undefined) continue;
      const enLaBarra = d.corto ?? d.nombre;
      expect(enLaBarra.length, `«${enLaBarra}» no cabe en una celda`).toBeLessThanOrEqual(10);
    }
  });

  it("y el nombre entero se conserva para el título y el cajón", () => {
    const entregas = destinoDe("/entregas");
    expect(entregas?.nombre).toBe("Entregas del día");
    expect(entregas?.corto).toBe("Entregas");
  });
});

/**
 * El cajón, que es donde está TODO lo que la barra no lleva.
 *
 * La barra de abajo salió bien y el cajón se quedó en quince renglones de
 * texto pelado: cinco rutas tenían dibujo y diez no, así que el icono no era
 * una ayuda sino un adorno intermitente. Ahora el cajón pinta el de cada
 * destino, y por eso el contrato cambia: el icono ya no se le pide a las
 * rutas de la barra, se le pide a TODAS.
 *
 * Sin esta prueba, añadir una pantalla y olvidar su dibujo no da ningún error:
 * da un renglón sin icono en medio de los que sí lo tienen, que es la clase de
 * fallo que solo se ve mirando la captura.
 */
describe("el cajón", () => {
  it("cada destino del mapa tiene su icono", () => {
    for (const d of TODOS_LOS_DESTINOS) {
      expect(ICONOS[d.ruta], `«${d.nombre}» (${d.ruta}) no tiene icono`).toBeDefined();
    }
  });

  it("y el mapa no se quedó vacío por un cambio de forma", () => {
    // Trampa nº 1: un control que comprueba algo que ya era cierto. Con
    // `SECCIONES` vacía, el bucle de arriba pasa sin mirar nada.
    expect(TODOS_LOS_DESTINOS.length).toBeGreaterThanOrEqual(15);
    expect(SECCIONES.length).toBeGreaterThanOrEqual(5);
  });

  it("ningún icono se dibuja para una ruta que ya no existe", () => {
    // Un dibujo huérfano no rompe nada y por eso dura años. Pero es trabajo
    // muerto, y peor: hace creer que el mapa está más lleno de lo que está
    // —fue justo lo que escondió que la barra iba coja—.
    const rutas = new Set(TODOS_LOS_DESTINOS.map((d) => d.ruta));
    for (const ruta of Object.keys(ICONOS)) {
      expect(rutas.has(ruta), `ICONOS dibuja ${ruta}, que no está en SECCIONES`).toBe(true);
    }
  });
});

/**
 * Los atajos del Resumen.
 *
 * El criterio está escrito en `navegacion.ts`: lo de todos los días que la
 * barra de abajo NO lleva ya. La segunda mitad es la que se puede comprobar a
 * máquina, y es la que se rompe sola — basta con que alguien meta un destino
 * en la barra sin mirar esta lista, y entonces media fila de atajos lleva a
 * sitios que están a un toque mientras los de tres toques se quedan fuera.
 */
describe("los atajos del Resumen", () => {
  it("ninguno repite lo que la barra de abajo ya lleva", () => {
    const enLaBarra = new Set<string>(RUTAS_BARRA);
    for (const ruta of RUTAS_ATAJOS) {
      expect(enLaBarra.has(ruta), `${ruta} ya está en la barra: el atajo sobra`).toBe(false);
    }
  });

  it("todos existen en el mapa y tienen icono", () => {
    for (const ruta of RUTAS_ATAJOS) {
      expect(destinoDe(ruta), `${ruta} no está en SECCIONES`).toBeDefined();
      expect(ICONOS[ruta], `${ruta} es un atajo y no tiene icono`).toBeDefined();
    }
  });

  it("y la lista no se quedó vacía", () => {
    expect(RUTAS_ATAJOS.length).toBeGreaterThanOrEqual(3);
  });

  it("cabe una palabra por celda", () => {
    // Cuatro celdas en un teléfono de 390 px, con los 14 px de relleno de
    // `.contenido` y 8 px de hueco, dan 84 px por celda. A 12 px en negrita,
    // once letras es lo que entra en un renglón; más que eso parte a media
    // palabra, que es como se lee «Existenci-as».
    for (const ruta of RUTAS_ATAJOS) {
      const d = destinoDe(ruta);
      if (d === undefined) continue;
      expect(d.nombre.length, `«${d.nombre}» no cabe en una celda`).toBeLessThanOrEqual(11);
    }
  });

  it("el rol que no ve una pantalla tampoco ve su atajo", () => {
    // No es seguridad —el servidor rechaza igual—: es no ofrecer un botón que
    // va a contestar 403.
    const sinCobros = atajosDelResumen((p) => p !== "cobros");
    expect(sinCobros.map((d) => d.ruta)).not.toContain("/cobros");
    expect(sinCobros.length).toBe(RUTAS_ATAJOS.length - 1);

    const conTodo = atajosDelResumen(() => true);
    expect(conTodo.map((d) => d.ruta)).toEqual([...RUTAS_ATAJOS]);
  });
});
