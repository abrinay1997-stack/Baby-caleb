import { BrowserRouter, Route, Routes } from "react-router-dom";
import { type Yo, useCarga } from "./api";
import { Armazon } from "./armazon/Armazon";
import { Cargando, Tarjeta } from "./componentes";
import { Frontera } from "./Frontera";
import { Ajustes } from "./pantallas/Ajustes";
import { Bodegas } from "./pantallas/Bodegas";
import { Catalogo } from "./pantallas/Catalogo";
import { Existencias } from "./pantallas/Existencias";
import { Resumen } from "./pantallas/Resumen";
import { Usuarios } from "./pantallas/Usuarios";
import { Zonas } from "./pantallas/Zonas";

/**
 * El panel.
 *
 * Lo primero que hace es preguntar quién es quien abrió. Hasta que eso
 * conteste no se pinta ninguna pantalla: sin saber el rol, el panel ofrecería
 * pestañas que el servidor va a rechazar, y una interfaz que ofrece lo que
 * luego niega enseña a la gente a ignorar los errores.
 */
export function App() {
  const yo = useCarga<Yo>("/api/yo");

  if (yo.fase === "cargando") {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-bg p-6 text-fg">
        <Cargando que="el panel" />
      </div>
    );
  }

  if (yo.fase === "error") {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-bg p-6 text-fg">
        <Tarjeta className="max-w-md">
          <h1 className="m-0 text-[17px] font-bold">No pudimos abrir el panel</h1>
          <p className="mt-2 text-muted">{yo.mensaje}</p>
          {/* El motivo técnico va al final y en pequeño: sirve para contárselo
              a Juan, no para que la dueña lo descifre. */}
          {yo.codigo ? (
            <p className="m-0 mt-3 text-[12px] text-muted">Detalle para soporte: {yo.codigo}</p>
          ) : null}
        </Tarjeta>
      </div>
    );
  }

  return (
    // La de dentro del armazón atrapa lo de cada pantalla; esta atrapa lo del
    // armazón mismo. Sin ella, un fallo en la barra o el cajón vuelve a dejar
    // la pantalla en blanco, que es justo lo que no puede pasar.
    <Frontera donde="el armazón del panel">
      <BrowserRouter>
        <Routes>
          <Route element={<Armazon yo={yo.datos} />}>
            <Route index element={<Resumen />} />
            <Route path="catalogo" element={<Catalogo />} />
            <Route path="existencias" element={<Existencias />} />
            <Route path="bodegas" element={<Bodegas />} />
            <Route path="zonas" element={<Zonas />} />
            <Route path="ajustes" element={<Ajustes />} />
            <Route path="usuarios" element={<Usuarios />} />
            {/* Una ruta que no existe lleva al resumen en vez de a una página en
                blanco: en un teléfono no hay barra de direcciones que arreglar. */}
            <Route path="*" element={<Resumen />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </Frontera>
  );
}
