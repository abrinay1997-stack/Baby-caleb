import { useId, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { Yo } from "../api";
import { Frontera } from "../Frontera";
import { ETIQUETAS_ROL, type Permiso } from "../permisos";
import { BarraInferior } from "./BarraInferior";
import { Cajon } from "./Cajon";
import { destinoDe, destinosDeLaBarra, seccionesVisibles } from "./navegacion";
import { BotonCaleb, Caleb } from "../pantallas/Caleb";

/**
 * El armazón del panel: lo que se ve en todas las pantallas.
 *
 * En escritorio, una barra lateral. En el teléfono, una barra inferior con
 * cuatro destinos y un cajón para el resto. No es la misma navegación en dos
 * tamaños: son dos navegaciones, porque el §7d dice que la del teléfono no es
 * la del escritorio girada.
 */

export function Armazon({ yo }: { yo: Yo }) {
  const [menuAbierto, setMenuAbierto] = useState(false);
  const disparador = useRef<HTMLButtonElement>(null);
  const idDelCajon = useId();
  // Para colgar los rótulos de grupo de la barra lateral de sus listas sin
  // inventar encabezados (§7k). `useId` y no el título a secas: dos paneles en
  // la misma página —o un título con espacios— no pueden chocar de id.
  const idDeSeccion = useId();
  const [calebAbierto, setCalebAbierto] = useState(false);
  const { pathname } = useLocation();

  const puede = (p: Permiso) => yo.permisos[p] !== "no";
  const secciones = seccionesVisibles(puede);
  const deLaBarra = destinosDeLaBarra(puede);
  const actual = destinoDe(pathname);

  return (
    <div className="min-h-[100dvh] bg-bg text-fg">
      {/* El primer foco de la página, siempre (§7i). */}
      <a href="#contenido" className="saltar">
        Saltar al contenido
      </a>

      <div className="md:flex">
        {/* Escritorio: barra lateral. */}
        <aside className="solo-escritorio sticky top-0 h-[100dvh] w-60 shrink-0 overflow-y-auto border-r border-line bg-surface">
          <div className="px-5 py-5">
            <p className="m-0 text-[17px] font-bold">Baby Caleb</p>
            <p className="m-0 text-[12px] text-muted">Panel del negocio</p>
          </div>
          {/* Los rótulos de los grupos NO son encabezados del documento (§7k).
              Estaban como `<h2>`, y como la barra lateral va antes que la
              cabecera en el orden del DOM, el esquema de las veintidós
              pantallas de escritorio empezaba en h2: quien salta de encabezado
              en encabezado oía que faltaba una sección antes de llegar al
              título de la pantalla.

              Lo que son de verdad es la etiqueta de un grupo de enlaces, y eso
              se dice con `aria-labelledby` en su `<ul>`: el lector anuncia
              «Lo que se vende, lista de 6 elementos» al entrar, que es la
              información que el `<h2>` pretendía dar, sin inventar un nivel en
              el esquema. Renumerarlos a `<h3>` no servía: el problema no es el
              número, es que el menú no es contenido de la página. */}
          <nav aria-label="Navegación principal">
            {secciones.map((s) => (
              <div key={s.titulo} className="pb-2">
                <p
                  id={`${idDeSeccion}-${s.titulo}`}
                  className="m-0 px-5 pb-1 pt-3 text-[12px] font-bold uppercase tracking-wide text-muted"
                >
                  {s.titulo}
                </p>
                <ul
                  aria-labelledby={`${idDeSeccion}-${s.titulo}`}
                  className="m-0 list-none p-0"
                >
                  {s.destinos.map((d) => (
                    <li key={d.ruta}>
                      <NavLink
                        to={d.ruta}
                        end={d.ruta === "/"}
                        className={({ isActive }) =>
                          /* Sin `bg-accent/10` detrás del texto (§7h).
                             `--accent-strong` está elegido para leerse sobre el
                             crema y sobre la superficie (4.90 y 4.60); con un
                             10 % de naranja encima, el fondo real pasa a
                             #f2e6d6 y el mismo texto cae a 4.32:1. Era el único
                             elemento del panel que dice DÓNDE ESTÁ USTED, y era
                             el peor leído — en las veintidós pantallas.
                             La barra de 3 px, la negrita y `aria-current`
                             siguen marcando el activo sin pedirle nada al
                             color. */
                          `tactil flex items-center px-5 no-underline ${
                            isActive
                              ? "border-l-[3px] border-accent-edge pl-[17px] font-bold text-accent-strong"
                              : "text-fg"
                          }`
                        }
                      >
                        {d.nombre}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          {/* Caleb, al pie de la barra lateral. Aquí sobra sitio —la lista de
              secciones no llega abajo— y, sobre todo, está FUERA de la columna
              de contenido: flotando encima de ella tapaba «Confirmar que
              entraron $31.50». */}
          <div className="px-5 pb-5 pt-2">
            <BotonCaleb alAbrir={() => setCalebAbierto(true)} variante="pastilla" />
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
            <div className="min-w-0">
              <h1 className="m-0 truncate text-[17px] font-bold">
                {actual?.nombre ?? "Panel"}
              </h1>
              {/* La descripción se PARTE, no se corta.

                  Con `truncate` (una línea y puntos suspensivos), seis de las
                  quince pantallas perdían el final de su propia explicación en
                  un teléfono de 390 px, y el trozo que se iba era el que
                  decidía: Pasarelas decía «…y si está en prueba o …» —se comía
                  «en real», que es la diferencia entre cobrar de mentira y
                  cobrar de verdad—, Clientas perdía 75 px y Llaves 104 px.

                  Esta línea es lo único que contesta «¿para qué sirve esta
                  pantalla?», que es la primera pregunta de la auditoría. Que
                  ocupe dos renglones cuesta 16 px en una cabecera que además se
                  va con el scroll; que se corte cuesta la frase.

                  El `<h1>` sí se queda con `truncate`: son nombres de una o dos
                  palabras y ninguno llega a cortarse. */}
              {actual ? (
                <p className="m-0 text-[12px] text-muted">{actual.descripcion}</p>
              ) : null}
            </div>
            <p className="m-0 shrink-0 text-right text-[12px] text-muted">
              <span className="block font-bold text-fg">{yo.usuario.nombre}</span>
              {ETIQUETAS_ROL[yo.usuario.rol]}
            </p>
          </header>

          {/* `contenido` baja a 14 px de relleno en el teléfono (§7h). */}
          <main id="contenido" className="contenido p-6">
            {/* La frontera va AQUÍ y no envolviendo al armazón: si una pantalla
                se rompe, la navegación tiene que seguir viva para poder salir
                de ella. Y la `key` con la ruta la remonta al navegar, que es lo
                que hace que irse a otra pestaña arregle la pantalla rota. */}
            <Frontera key={pathname} donde={actual?.nombre ?? pathname}>
              {/* `yo` baja por aquí y no por una consulta de cada pantalla: el
                  rol ya se pidió una vez al abrir, y volver a pedirlo en cada
                  pantalla es una llamada de más que además puede contestar algo
                  distinto a media sesión. */}
              <Outlet context={yo} />
            </Frontera>
          </main>
        </div>
      </div>

      {/* Caleb va en el armazón y no en cada pantalla: la pregunta aparece
          mientras se está haciendo otra cosa. «¿Cuánto queda de la M?» se
          pregunta estando en Pedidos, no yendo a una pantalla de asistente.
          Y se le pasa dónde está quien pregunta, porque sin eso «esto» y
          «aquí» no significan nada.

          La hoja se monta UNA vez y el estado de si está abierta vive aquí,
          porque ahora el botón que la abre está en la barra de abajo (teléfono)
          o en la lateral (computadora) — dos sitios distintos para una sola
          conversación. */}
      <Caleb
        abierta={calebAbierto}
        alCerrar={() => setCalebAbierto(false)}
        {...(actual?.nombre === undefined ? {} : { pantalla: actual.nombre })}
      />

      <BarraInferior
        destinos={deLaBarra}
        alAbrirMenu={() => setMenuAbierto(true)}
        menuAbierto={menuAbierto}
        idDelCajon={idDelCajon}
        disparador={disparador}
        alAbrirCaleb={() => setCalebAbierto(true)}
      />
      <Cajon
        id={idDelCajon}
        abierto={menuAbierto}
        alCerrar={() => setMenuAbierto(false)}
        secciones={secciones}
        disparador={disparador}
      />
    </div>
  );
}
