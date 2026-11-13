import { useEffect, useRef, useState } from "react";
import { Hoja } from "../armazon/Hoja";
import { IconoCaleb } from "../armazon/Iconos";
import { pedir } from "../api";

/**
 * Caleb, el asistente del panel.
 *
 * Un botón flotante en todas las pantallas, porque la pregunta aparece
 * mientras se está haciendo otra cosa: «¿cuánto queda de la M?» se pregunta
 * estando en Pedidos, no yendo a una pantalla de asistente.
 *
 * Sabe en qué pantalla está quien pregunta. Sin eso, «esto» y «aquí» no
 * significan nada y la persona tiene que escribir de más.
 *
 * El historial vive AQUÍ, en el navegador, y va y vuelve en cada turno — igual
 * que el chat de la web. Lo que no se confía a ese historial es nada que
 * decida algo: cada acción se vuelve a pasar por la política en el servidor, y
 * lo que quedó hecho vive en la bitácora, no en lo que diga esta pantalla.
 */

interface Mensaje {
  rol: "user" | "assistant" | "tool";
  contenido: string;
  llamadaId?: string;
  llamadas?: { id: string; nombre: string; argumentos: unknown }[];
}

type Respuesta =
  | { clase: "dijo"; texto: string; historial: Mensaje[]; pasos: number }
  | {
      clase: "pide_permiso";
      texto: string;
      accionId: string;
      resumen: string;
      venceEn: number;
      historial: Mensaje[];
      pasos: number;
    };

/** Lo que se le enseña a la persona: solo lo que se dijo, no los pasos internos. */
interface Burbuja {
  de: "yo" | "caleb";
  texto: string;
}

/**
 * El botón que abre a Caleb. Se ACOPLA, no flota.
 *
 * Flotaba (`position: fixed`, abajo a la derecha) y por eso se sentaba encima
 * de lo que hubiera debajo. El hueco que `.contenido` le reservaba protege el
 * FINAL de la página; a media página no protege nada, porque un elemento fijo
 * se queda quieto mientras el contenido pasa por debajo. Medido con el auditor:
 * tapaba «Confirmar que entraron $31.50» en Cobros, el enlace de «3 pedidos
 * agendados sin preparar» del Resumen, «Quitar» en Pasarelas, «Cambiar» en
 * Ajustes, «Preparar entrega» en Entregas y una fila de Existencias. Dinero,
 * dos de ellas.
 *
 * Más relleno no lo arregla: lo arregla no pasar por encima. Así que el botón
 * vive donde ya hay sitio reservado para él — la barra inferior en el teléfono
 * y el pie de la barra lateral en la computadora— y deja de haber un sitio de
 * la pantalla donde tocar signifique otra cosa.
 *
 * Se renderiza DOS veces, una por cada barra, y `solo-telefono`/
 * `solo-escritorio` dejan visible exactamente una: las dos usan
 * `display: none`, así que la que no toca ni sale en el árbol de
 * accesibilidad ni la encuentra un lector de pantalla.
 */
export function BotonCaleb({
  alAbrir,
  variante,
}: {
  alAbrir: () => void;
  /**
   * `pastilla` en la barra lateral de escritorio, donde es un botón suelto y
   * el naranja lo que lo hace encontrable.
   *
   * `celda` en la barra inferior del teléfono, donde NO lleva relleno naranja
   * a propósito: en esa barra el naranja ya significa «usted está aquí» —es la
   * pastilla que va detrás del icono del destino activo—, y un segundo bulto
   * naranja al lado dice el mismo color para dos cosas distintas, un estado y
   * una acción. Caleb se viste como las demás celdas (icono arriba, palabra
   * debajo) y así la barra se lee de un golpe: cuatro sitios y una pregunta.
   */
  variante: "pastilla" | "celda";
}) {
  if (variante === "pastilla") {
    return (
      <button
        type="button"
        onClick={alAbrir}
        aria-label="Preguntarle a Caleb"
        className="tactil burbuja-caleb w-full rounded-full border border-line bg-accent px-5 text-[15px] font-bold text-accent-fg"
      >
        Caleb
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={alAbrir}
      aria-label="Preguntarle a Caleb"
      className="tactil burbuja-caleb h-full w-full flex-col justify-center gap-1 rounded-[12px] px-1 py-1.5 text-[12px] text-muted focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <span aria-hidden="true" className="flex items-center justify-center px-3.5 py-1">
        <IconoCaleb className="h-[22px] w-[22px]" />
      </span>
      <span className="leading-none">Caleb</span>
    </button>
  );
}

export function Caleb({
  pantalla,
  abierta,
  alCerrar,
}: {
  pantalla?: string;
  abierta: boolean;
  alCerrar: () => void;
}) {
  const setAbierta = (v: boolean) => {
    if (!v) alCerrar();
  };
  const [historial, setHistorial] = useState<Mensaje[]>([]);
  const [burbujas, setBurbujas] = useState<Burbuja[]>([]);
  const [escrito, setEscrito] = useState("");
  const [pensando, setPensando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permiso, setPermiso] = useState<{ accionId: string; resumen: string } | null>(null);

  const final = useRef<HTMLDivElement>(null);
  useEffect(() => {
    final.current?.scrollIntoView({ block: "end" });
  }, [burbujas, pensando]);

  const aplicar = (r: Respuesta): void => {
    setHistorial(r.historial);
    if (r.texto.trim() !== "") setBurbujas((b) => [...b, { de: "caleb", texto: r.texto }]);
    setPermiso(r.clase === "pide_permiso" ? { accionId: r.accionId, resumen: r.resumen } : null);
  };

  const mandar = async (): Promise<void> => {
    const texto = escrito.trim();
    if (texto === "" || pensando) return;

    const conmigo: Mensaje[] = [...historial, { rol: "user", contenido: texto }];
    setEscrito("");
    setBurbujas((b) => [...b, { de: "yo", texto }]);
    setHistorial(conmigo);
    setPensando(true);
    setError(null);

    try {
      const r = await pedir<Respuesta>("/api/asistente", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mensajes: conmigo,
          ...(pantalla === undefined ? {} : { pantalla }),
        }),
      });
      aplicar(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Algo salió mal.");
    } finally {
      setPensando(false);
    }
  };

  const decidir = async (decision: "permitir" | "rechazar"): Promise<void> => {
    if (permiso === null || pensando) return;
    setPensando(true);
    setError(null);
    try {
      await pedir(`/api/asistente/acciones/${encodeURIComponent(permiso.accionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      setBurbujas((b) => [
        ...b,
        { de: "caleb", texto: decision === "permitir" ? "Hecho." : "No lo hice." },
      ]);
      setPermiso(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo.");
    } finally {
      setPensando(false);
    }
  };

  return (
    <>
      {/* El disparador ya no vive aquí: lo pone el armazón dentro de la barra
          que toque (`BotonCaleb`), porque flotando se sentaba encima de botones
          que deciden dinero. Aquí queda solo la hoja. */}
      <Hoja
        abierta={abierta}
        titulo="Caleb"
        alCerrar={() => setAbierta(false)}
        pie={
          permiso === null ? undefined : (
            <div className="grid gap-2">
              <p className="m-0 text-[14px]">{permiso.resumen}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void decidir("rechazar")}
                  disabled={pensando}
                  className="tactil flex-1 rounded-[10px] border border-line px-3 py-2 text-[15px]"
                >
                  No
                </button>
                <button
                  type="button"
                  onClick={() => void decidir("permitir")}
                  disabled={pensando}
                  className="tactil flex-1 rounded-[10px] bg-accent px-3 py-2 text-[15px] font-bold text-accent-fg"
                >
                  Permitir
                </button>
              </div>
            </div>
          )
        }
      >
        <div className="grid gap-3 p-4">
          {burbujas.length === 0 ? (
            <p className="m-0 rounded-[10px] border border-line bg-bg p-3 text-[14px] text-muted">
              Pregúntele lo que quiera del negocio: cuánto queda de una talla, qué se vendió, dónde
              está un pedido. Las cifras las busca; no se las inventa.
            </p>
          ) : null}

          {burbujas.map((b, i) => (
            <p
              key={i}
              className={
                b.de === "yo"
                  ? "m-0 ml-auto max-w-[85%] rounded-[12px] bg-accent px-3 py-2 text-[15px] text-accent-fg"
                  : "m-0 mr-auto max-w-[85%] rounded-[12px] border border-line bg-bg px-3 py-2 text-[15px]"
              }
            >
              {b.texto}
            </p>
          ))}

          {pensando ? <p className="m-0 text-[14px] text-muted">Pensando…</p> : null}
          {error !== null ? (
            <p className="m-0 rounded-[10px] border border-line p-3 text-[14px]">{error}</p>
          ) : null}

          <div ref={final} />

          {/* NO va dentro de un <form>.
              
              `Hoja` ya envuelve su contenido en un `<form method="dialog">`, y
              los formularios anidados no son HTML válido: el navegador
              descarta el de dentro, así que un botón `type="submit"` acaba
              enviando el de FUERA — y ese cierra la hoja. Se veía exactamente
              así: la hoja abría y el propio botón de enviar la cerraba sin
              preguntar nada. Lo encontró una captura, no una prueba. */}
          <div className="flex gap-2">
            <input
              type="text"
              value={escrito}
              onChange={(e) => setEscrito(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void mandar();
                }
              }}
              placeholder="Pregúntele a Caleb"
              aria-label="Pregúntele a Caleb"
              disabled={pensando}
              className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
            />
            <button
              type="button"
              onClick={() => void mandar()}
              disabled={pensando || escrito.trim() === ""}
              className="tactil shrink-0 rounded-[10px] bg-accent px-4 text-[15px] font-bold text-accent-fg disabled:opacity-60"
            >
              Enviar
            </button>
          </div>
        </div>
      </Hoja>
    </>
  );
}
