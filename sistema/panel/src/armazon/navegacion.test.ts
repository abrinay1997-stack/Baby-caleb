import { describe, expect, it } from "vitest";
import { ICONOS } from "./Iconos";
import { RUTAS_BARRA, TODOS_LOS_DESTINOS, destinoDe } from "./navegacion";

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
