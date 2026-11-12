import { useState } from "react";
import { Hoja } from "../armazon/Hoja";
import { fecha, pedir, useCarga } from "../api";

/**
 * Las llaves de MCP de cada quien.
 *
 * MCP es la tercera puerta del asistente, y vive FUERA de Cloudflare Access:
 * un cliente de MCP no tiene navegador y no puede iniciar sesión con Google.
 * Su llave es esto.
 *
 * Cada persona ve y maneja SOLO las suyas. Una dueña podría revocar las de
 * otra, pero eso es una pantalla de administración que nadie ha pedido, y
 * dárselo a todo el mundo «por si acaso» es cómo se revoca la llave
 * equivocada un viernes.
 */

interface Llave {
  id: string;
  nombre: string;
  creado_en: number;
  ultimo_uso_en: number | null;
  revocado_en: number | null;
}

/**
 * «1 llave revocada» / «3 llaves revocadas».
 *
 * Decía «1 revocada(s)»: sin el sustantivo —revocada ¿qué?— y con el paréntesis
 * de plural, que es la forma de no decidir. Las dos formas se escriben enteras,
 * igual que en Ajustes («1 regla sin decidir»).
 */
export function textoDeRevocadas(cuantas: number): string {
  return cuantas === 1 ? "1 llave revocada" : `${cuantas} llaves revocadas`;
}

export function Llaves() {
  // Una sola consulta, que se repite al cambiar `recarga`. Tenía dos y era un
  // viaje de más por nada.
  const [recarga, setRecarga] = useState(0);
  const datos = useCarga<Llave[]>("/api/mcp/llaves", [recarga]);
  const llaves = datos.fase === "listo" ? datos.datos : [];

  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [recien, setRecien] = useState<{ nombre: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Qué llave está esperando el segundo toque. Revocar no se deshace: la llave
  // revocada no vuelve, hay que crear otra y volver a pegarla en el programa
  // de fuera. El patrón es el de «No cuadra» en Cobros — un toque abre la
  // pregunta, el segundo la contesta, y «Mejor no» sale sin hacer nada.
  const [confirmando, setConfirmando] = useState<string | null>(null);

  const crear = async (): Promise<void> => {
    if (nombre.trim() === "" || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await pedir<{ nombre: string; token: string }>("/api/mcp/llaves", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nombre: nombre.trim() }),
      });
      setRecien(r);
      setNombre("");
      setCreando(false);
      setRecarga((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear.");
    } finally {
      setOcupado(false);
    }
  };

  const revocar = async (id: string): Promise<void> => {
    if (ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      await pedir(`/api/mcp/llaves/${encodeURIComponent(id)}/revocar`, { method: "POST" });
      setConfirmando(null);
      setRecarga((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo revocar.");
    } finally {
      setOcupado(false);
    }
  };

  const vivas = llaves.filter((l) => l.revocado_en === null);
  const muertas = llaves.filter((l) => l.revocado_en !== null);

  return (
    <section className="grid gap-4">
      {/* Sin <h1>: la cabecera del armazón ya pone el nombre de la pantalla, y
          repetirlo le roba media pantalla a un teléfono. El resto del panel
          tampoco lo repite. */}
      <p className="m-0 text-[14px] text-muted">
        Sirven para que un programa de fuera —por ejemplo un asistente de IA en su computadora—
        pueda consultar el sistema sin abrir el panel. Cada llave es suya y de un solo sitio.
      </p>

      {error !== null ? (
        <p className="m-0 rounded-[10px] border border-line p-3 text-[14px]">{error}</p>
      ) : null}

      {/* El token se enseña UNA vez. No es ceremonia: en la base solo queda su
          huella, así que ni el sistema puede volver a decirlo. Por eso se
          enseña grande, con el aviso delante y no debajo. */}
      {recien !== null ? (
        <div className="grid gap-2 rounded-[12px] border border-line bg-bg p-4">
          <p className="m-0 text-[15px] font-bold">
            Copie esta llave ahora. No se vuelve a mostrar.
          </p>
          <p className="m-0 text-[13px] text-muted">
            El sistema solo guarda una huella, así que no puede volver a enseñársela. Si la pierde,
            revóquela y cree otra — es más barato que poder recuperarla.
          </p>
          <code className="block overflow-x-auto rounded-[10px] bg-surface p-3 text-[13px]">
            {recien.token}
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(recien.token)}
              className="tactil rounded-[10px] bg-accent px-4 py-2 text-[15px] font-bold text-accent-fg"
            >
              Copiar
            </button>
            <button
              type="button"
              onClick={() => setRecien(null)}
              className="tactil rounded-[10px] border border-line px-4 py-2 text-[15px]"
            >
              Ya la copié
            </button>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setCreando(true)}
        className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg focus-visible:outline-accent-edge focus-visible:outline-2 md:w-auto md:justify-self-start"
      >
        + Crear una llave
      </button>

      {vivas.length === 0 ? (
        <p className="m-0 rounded-[10px] border border-line bg-bg p-3 text-[14px] text-muted">
          No tiene ninguna llave. Mientras no cree una, nada de fuera puede entrar con su nombre.
        </p>
      ) : (
        <div className="grid gap-2">
          {vivas.map((l) => (
            <div key={l.id} className="rounded-[12px] border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="block min-w-0">
                  <span className="block font-bold">{l.nombre}</span>
                  <span className="block text-[13px] text-muted">
                    Creada el {fecha(l.creado_en)}
                  </span>
                  <span className="block text-[13px] text-muted">
                    {l.ultimo_uso_en === null
                      ? "Nunca se ha usado"
                      : `Usada por última vez el ${fecha(l.ultimo_uso_en)}`}
                  </span>
                </span>
                {confirmando === l.id ? null : (
                  <button
                    type="button"
                    onClick={() => setConfirmando(l.id)}
                    disabled={ocupado}
                    className="tactil shrink-0 rounded-[10px] border border-line px-3 py-2 text-[14px]"
                  >
                    Revocar
                    {/* En la lista hay tres botones que dicen «Revocar». */}
                    <span className="sr-only"> {l.nombre}</span>
                  </button>
                )}
              </div>

              {confirmando === l.id ? (
                <div className="mt-3 grid gap-2 border-t border-line pt-3">
                  <p className="m-0 text-[14px]">
                    Lo que entre con <strong>{l.nombre}</strong> deja de entrar en cuanto toque
                    abajo. La llave no vuelve: si la sigue necesitando, hay que crear otra y
                    volver a pegarla donde estaba.
                  </p>
                  {/* El navy de lo que no se deshace: el mismo de «Quitar el
                      acceso» en Usuarios y del «Ocultarlo» de la hoja del
                      catálogo. */}
                  <button
                    type="button"
                    onClick={() => void revocar(l.id)}
                    disabled={ocupado}
                    className="tactil w-full rounded-[10px] bg-fg px-4 py-3 font-bold text-bg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2"
                  >
                    {ocupado ? "Revocando…" : `Sí, revocar ${l.nombre}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmando(null)}
                    disabled={ocupado}
                    className="tactil w-full rounded-[10px] border border-line px-4 py-3 font-bold disabled:opacity-60"
                  >
                    Mejor no
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {muertas.length > 0 ? (
        <details className="rounded-[12px] border border-line p-3">
          {/* `tactil` y no solo texto: un <summary> es un botón, y el §7 pide
              44 px de alto. Sin esto medía 21 y el auditor lo cazó. */}
          <summary className="tactil flex cursor-pointer items-center text-[14px] text-muted">
            {textoDeRevocadas(muertas.length)}
          </summary>
          {/* Revocar no borra la fila: la bitácora apunta a quién hizo qué y
              hay que poder reconstruir por dónde entró cada cosa. */}
          <ul className="m-0 mt-2 grid gap-1 pl-5 text-[13px] text-muted">
            {muertas.map((l) => (
              <li key={l.id}>
                {l.nombre} · revocada el {fecha(l.revocado_en ?? 0)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Hoja
        abierta={creando}
        titulo="Crear una llave"
        alCerrar={() => setCreando(false)}
        pie={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCreando(false)}
              className="tactil flex-1 rounded-[14px] border border-line px-4 py-3 font-bold"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void crear()}
              disabled={ocupado || nombre.trim() === ""}
              className="tactil flex-1 rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg disabled:opacity-60"
            >
              Crear
            </button>
          </div>
        }
      >
        <label className="grid gap-1">
          <span className="text-[14px] font-bold">¿Para qué es?</span>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Mi computadora"
            className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          />
          <span className="text-[13px] text-muted">
            El nombre es para usted: cuando tenga tres llaves, es lo único que le dirá cuál sobra.
          </span>
        </label>
      </Hoja>
    </section>
  );
}
