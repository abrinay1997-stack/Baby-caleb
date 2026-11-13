import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { precargar } from "./api";
import "./estilos.css";

/**
 * Las peticiones salen ANTES de montar React.
 *
 * El panel hacía dos viajes en fila: no pintaba nada hasta que volvía
 * `/api/yo`, y solo entonces la pantalla pedía sus datos. La espera era la
 * suma de las dos. Medido en el panel de verdad: 8.8 segundos la primera y
 * 22.6 la segunda. Treinta segundos mirando «Cargando el panel…».
 *
 * No se necesitan entre sí: quién entra lo comprueba el servidor en las dos,
 * no el navegador. Así que salen juntas y la espera pasa a ser la mayor de
 * las dos en vez de la suma.
 *
 * Solo la pantalla que se está abriendo. Precargar todas sería mandar diez
 * consultas para enseñar una, y castigar a la base para que una sola pantalla
 * fuera más rápida.
 */
const DATOS_DE_LA_PANTALLA: Record<string, string> = {
  // El Resumen es el que se abre cada mañana, y el que se midió en 22.6 s.
  // `hoy` es el periodo con el que arranca; si se cambia allá, aquí deja de
  // acertar y lo único que pasa es que la precarga no sirve: no se rompe.
  "/": "/api/resumen?periodo=hoy",
  "/pedidos": "/api/pedidos",
  "/cobros": "/api/cobros",
  "/catalogo": "/api/catalogo",
  "/existencias": "/api/existencias",
};

precargar("/api/yo");
// Solo si se entra limpio. Con un filtro en la barra de direcciones
// —`/pedidos?estado=por_abonar`— la pantalla va a pedir otra cosa, y
// precargar la lista entera sería una consulta de más que nadie usa.
if (window.location.search === "") {
  const datos = DATOS_DE_LA_PANTALLA[window.location.pathname];
  if (datos !== undefined) precargar(datos);
}

const raiz = document.getElementById("raiz");
if (!raiz) throw new Error("falta #raiz en index.html");

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
