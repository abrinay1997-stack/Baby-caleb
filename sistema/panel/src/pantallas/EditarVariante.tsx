import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { aCentavos, aPuntosBasicos, deCentavos, dePuntosBasicos } from "../dinero";
// Las mismas piezas que las demás hojas. Una copia por pantalla es cómo se
// acaba teniendo un campo a 14 px que hace zoom en el teléfono (§7b).
import { BOTON, Campo, ENTRADA } from "../formulario";

/**
 * Editar una variante del catálogo, y borrarla.
 *
 * Dos cosas que no son obvias y que definen esta pantalla:
 *
 * 1. **La versión viaja con el guardado.** Si alguien cambió el precio desde
 *    otro sitio mientras esta hoja estaba abierta, el servidor responde 409 y
 *    aquí se dice qué pasó y qué hacer, en vez de pisarlo en silencio. Es el
 *    caso real: el panel abierto en el teléfono mientras alguien toca la
 *    computadora.
 *
 * 2. **«Borrar» no siempre borra, y hay que decirlo ANTES.** Un producto que
 *    ya se vendió no se puede borrar —`pedido_lineas` guarda lo que una
 *    clienta compró— así que se oculta. La hoja le pregunta al servidor qué va
 *    a pasar de verdad y enseña ESA frase, no una genérica. Es el único sitio
 *    del sistema donde el botón no hace literalmente lo que dice, y por eso se
 *    avisa en vez de sorprender.
 */

export interface VarianteEditable {
  codigo: string;
  nombre: string;
  talla: string | null;
  unidades_por_caja: number;
  precio_cents: number;
  tasa_itbms_bp: number | null;
  publicado: number;
  version: number;
  imagen: string | null;
  es_combo: number;
  /** `null` = «lo que diga Ajustes». Ver `migrations/0013`. */
  pedir_por_whatsapp: number | null;
}

interface Ingrediente {
  codigo: string;
  nombre: string;
  cantidad: number;
  libres: number;
}

interface Veredicto {
  modo: "se_borra" | "se_oculta";
  yaOculta?: boolean;
  razones: string[];
}

export function EditarVariante({
  variante,
  alCerrar,
  alGuardar,
}: {
  variante: VarianteEditable | null;
  alCerrar: () => void;
  /** Se llama cuando algo cambió de verdad, para que la lista se recargue. */
  alGuardar: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [talla, setTalla] = useState("");
  const [porCaja, setPorCaja] = useState("");
  const [precio, setPrecio] = useState("");
  const [itbms, setItbms] = useState("");
  const [publicado, setPublicado] = useState(false);
  /**
   * El botón de WhatsApp, en TRES estados y guardado como texto.
   *
   * `""` es «lo que diga Ajustes» (la columna en nulo), que es el valor de
   * todos los artículos hasta que alguien decida uno. Un desplegable de tres
   * opciones y no una casilla: con una casilla, «heredado» y «apagado» se
   * dibujan igual, y entonces apagar Ajustes parecería no hacer nada en los
   * artículos que estaban heredando.
   */
  const [botonWhatsapp, setBotonWhatsapp] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [veredicto, setVeredicto] = useState<Veredicto | null>(null);
  const [foto, setFoto] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  /**
   * El fallo de la FOTO va aparte del `error` de la hoja.
   *
   * El `error` general se pinta arriba, antes del primer campo. El campo de la
   * foto está a media hoja, así que en un teléfono se toca «Cambiar foto»
   * mirando ese campo y el mensaje aparece fuera de la pantalla: existe, nadie
   * lo lee, y lo que se ve es un botón que no hizo nada. Importa especialmente
   * aquí porque el mensaje más largo del sistema es justo éste —cómo sacar una
   * foto del iPhone sin HEIC— y no serviría de nada escrito donde no se mira.
   */
  const [errorFoto, setErrorFoto] = useState<string | null>(null);
  const [receta, setReceta] = useState<Ingrediente[] | null>(null);
  const [cargado, setCargado] = useState<string | null>(null);

  // Los campos se llenan cuando cambia la variante, no en cada render: si no,
  // cada tecla se perdería al volver a pintar.
  if (variante !== null && cargado !== variante.codigo) {
    setCargado(variante.codigo);
    setNombre(variante.nombre);
    setTalla(variante.talla ?? "");
    setPorCaja(String(variante.unidades_por_caja));
    setPrecio(deCentavos(variante.precio_cents));
    setItbms(variante.tasa_itbms_bp === null ? "" : dePuntosBasicos(variante.tasa_itbms_bp));
    setPublicado(variante.publicado === 1);
    setBotonWhatsapp(
      variante.pedir_por_whatsapp === null ? "" : variante.pedir_por_whatsapp === 1 ? "si" : "no",
    );
    setMotivo("");
    setError(null);
    setVeredicto(null);
    setFoto(variante.imagen);
    setErrorFoto(null);
    setReceta(null);
    if (variante.es_combo === 1) {
      void pedir<Ingrediente[]>(
        `/api/catalogo/variantes/${encodeURIComponent(variante.codigo)}/receta`,
      )
        .then(setReceta)
        .catch(() => setReceta([]));
    }
  }

  if (variante === null) return null;

  const cerrar = () => {
    setCargado(null);
    setVeredicto(null);
    setError(null);
    alCerrar();
  };

  /**
   * Sube la foto en cuanto se elige, sin esperar a «Guardar».
   *
   * Es a propósito: una imagen tarda, y meterla dentro del guardado haría que
   * un botón que normalmente es instantáneo se quede pensando medio minuto sin
   * explicar por qué. Además la foto es una escritura aparte en el servidor —
   * no viaja con los demás campos— así que juntarlas en la pantalla sería
   * mentir sobre lo que pasa.
   */
  async function cambiarFoto(archivo: File) {
    if (variante === null) return;
    setSubiendo(true);
    setErrorFoto(null);
    try {
      const r = await pedir<{ imagen: string }>(
        `/api/catalogo/variantes/${encodeURIComponent(variante.codigo)}/foto`,
        { method: "PUT", body: archivo, headers: { "content-type": archivo.type || "application/octet-stream" } },
      );
      setFoto(r.imagen);
      alGuardar();
    } catch (e) {
      setErrorFoto((e as Error).message);
    } finally {
      setSubiendo(false);
    }
  }

  async function guardar() {
    if (variante === null) return;
    const centavos = aCentavos(precio);
    if (centavos === null || centavos <= 0) {
      setError("El precio no se entiende. Escríbalo como 12.50");
      return;
    }
    const caja = Number(porCaja);
    if (!Number.isSafeInteger(caja) || caja <= 0) {
      setError("Las unidades por caja tienen que ser un número mayor que cero.");
      return;
    }
    const bp = itbms.trim() === "" ? null : aPuntosBasicos(itbms);
    if (itbms.trim() !== "" && bp === null) {
      setError("El ITBMS no se entiende. Escríbalo como 7");
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      await pedir(`/api/catalogo/variantes/${encodeURIComponent(variante.codigo)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nombre: nombre.trim(),
          talla: talla.trim() === "" ? null : talla.trim(),
          unidadesPorCaja: caja,
          precioCents: centavos,
          tasaItbmsBp: bp,
          publicado,
          // `null` y no `undefined`: el servidor distingue «vuelve a heredar
          // de Ajustes» de «no toques este campo», y aquí siempre se está
          // diciendo lo que la pantalla enseña.
          pedirPorWhatsapp: botonWhatsapp === "" ? null : botonWhatsapp === "si",
          ...(motivo.trim() === "" ? {} : { motivo: motivo.trim() }),
          version: variante.version,
        }),
      });
      alGuardar();
      cerrar();
    } catch (e) {
      const err = e as Error & { codigo?: string };
      setError(
        err.codigo === "conflicto_version"
          ? "Alguien cambió este producto mientras usted lo tenía abierto. Cierre y vuelva a abrirlo para ver lo que hay ahora."
          : err.message,
      );
    } finally {
      setGuardando(false);
    }
  }

  /** Le pregunta al servidor qué va a pasar ANTES de enseñar el «¿seguro?». */
  async function preguntarQuePasa() {
    if (variante === null) return;
    setError(null);
    try {
      const v = await pedir<Veredicto>(
        `/api/catalogo/variantes/${encodeURIComponent(variante.codigo)}/borrado`,
      );
      setVeredicto(v);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function borrar() {
    if (variante === null) return;
    setGuardando(true);
    try {
      await pedir(`/api/catalogo/variantes/${encodeURIComponent(variante.codigo)}`, {
        method: "DELETE",
      });
      alGuardar();
      cerrar();
    } catch (e) {
      setError((e as Error).message);
      setVeredicto(null);
    } finally {
      setGuardando(false);
    }
  }

  // ---- La confirmación, que dice la verdad -------------------------------
  if (veredicto !== null) {
    const seBorra = veredicto.modo === "se_borra";
    return (
      <Hoja
        abierta
        titulo={seBorra ? "¿Borrar este producto?" : "Este producto no se puede borrar"}
        alCerrar={() => setVeredicto(null)}
        pie={
          <>
            <button type="button" onClick={() => setVeredicto(null)} className={`${BOTON} border border-line`}>
              Cancelar
            </button>
            <button
              type="button"
              onClick={borrar}
              disabled={guardando || veredicto.yaOculta === true}
              className={`${BOTON} bg-fg text-bg disabled:opacity-50`}
            >
              {seBorra ? "Sí, borrar" : "Ocultarlo"}
            </button>
          </>
        }
      >
        <p className="m-0 mb-3">
          <strong>{variante.nombre}</strong> ({variante.codigo})
        </p>
        {seBorra ? (
          <p className="m-0">
            Se va a borrar del todo, junto con sus fotos. Esto no se puede deshacer.
          </p>
        ) : (
          <>
            <p className="m-0 mb-2">
              Ya tiene historia en el sistema, así que borrarlo destruiría el registro de lo que
              pasó. En vez de eso se <strong>oculta</strong>: deja de aparecer en la web y el bot
              deja de ofrecerlo, pero sigue existiendo para los pedidos que lo nombran.
            </p>
            <ul className="m-0 list-disc pl-5 text-muted">
              {veredicto.razones.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {veredicto.yaOculta === true ? (
              <p className="mt-3 mb-0 font-bold">Ya estaba oculto: no hay nada que hacer.</p>
            ) : null}
          </>
        )}
        {error === null ? null : <p className="mt-3 mb-0 font-bold text-accent-strong">{error}</p>}
      </Hoja>
    );
  }

  // ---- El formulario ------------------------------------------------------
  return (
    <Hoja
      abierta
      titulo={variante.codigo}
      alCerrar={cerrar}
      pie={
        <>
          <button type="button" onClick={preguntarQuePasa} className={`${BOTON} border border-line`}>
            Borrar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={guardando}
            className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      {error === null ? null : (
        <p role="alert" className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3 font-bold">
          {error}
        </p>
      )}

      {variante.es_combo === 1 ? (
        <Campo
          etiqueta="Qué lleva este combo"
          ayuda="Un combo no tiene existencias propias: caben tantos como permita la pieza que menos alcance."
        >
          {receta === null ? (
            <p className="m-0 text-muted">Cargando…</p>
          ) : receta.length === 0 ? (
            // Un combo sin receta sale AGOTADO y no se puede vender. Decirlo
            // aquí evita que alguien lo publique y se pregunte por qué nadie
            // lo compra.
            <p className="m-0 font-bold text-accent-strong">
              Todavía no lleva nada, así que aparece agotado y no se puede vender.
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {receta.map((i) => {
                const caben = Math.floor(i.libres / i.cantidad);
                return (
                  <li
                    key={i.codigo}
                    className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0"
                  >
                    <span>
                      <span className="block font-bold">{i.nombre}</span>
                      <span className="block text-[12px] text-muted">
                        {i.cantidad} por combo · quedan {i.libres}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-[12px] font-bold ${caben === 0 ? "text-accent-strong" : "text-muted"}`}
                    >
                      {caben === 0 ? "frena el combo" : `da para ${caben}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Campo>
      ) : null}

      <Campo etiqueta="Foto" ayuda="JPG, PNG, WebP o AVIF, hasta 5 MB. Se cambia al momento, sin esperar a Guardar.">
        <div className="flex items-center gap-3">
          {foto === null ? (
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-[12px] border border-dashed border-line text-[12px] text-muted">
              Sin foto
            </span>
          ) : (
            <img
              src={foto}
              alt=""
              className="h-16 w-16 shrink-0 rounded-[12px] border border-line object-cover"
            />
          )}
          <label className="tactil flex cursor-pointer items-center rounded-[14px] border border-line px-4 py-2.5 font-bold focus-within:outline-accent-edge focus-within:outline-2">
            {subiendo ? "Subiendo…" : foto === null ? "Poner foto" : "Cambiar foto"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              disabled={subiendo}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // El valor se limpia para que elegir OTRA VEZ el mismo archivo
                // vuelva a disparar el cambio: sin esto, reintentar una subida
                // que falló no hace nada y parece que el botón está roto.
                e.target.value = "";
                if (f !== undefined) void cambiarFoto(f);
              }}
              className="sr-only"
            />
          </label>
        </div>
        {errorFoto === null ? null : (
          <p
            role="alert"
            className="mt-2 mb-0 rounded-[12px] border border-line bg-bg p-3 text-[14px] font-bold"
          >
            {errorFoto}
          </p>
        )}
      </Campo>

      <Campo etiqueta="Nombre">
        <input className={ENTRADA} value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </Campo>

      <Campo etiqueta="Talla" ayuda="Déjelo vacío si este producto no tiene tallas.">
        <input className={ENTRADA} value={talla} onChange={(e) => setTalla(e.target.value)} />
      </Campo>

      <Campo etiqueta="Unidades por caja">
        <input
          className={ENTRADA}
          inputMode="numeric"
          value={porCaja}
          onChange={(e) => setPorCaja(e.target.value)}
        />
      </Campo>

      <Campo
        etiqueta="Precio"
        ayuda="Este es el precio que ven la web y el bot. Cambiarlo aquí lo cambia en los tres sitios."
      >
        <input
          className={ENTRADA}
          inputMode="decimal"
          value={precio}
          onChange={(e) => setPrecio(e.target.value)}
          placeholder="12.50"
        />
      </Campo>

      <Campo etiqueta="ITBMS" ayuda="En por ciento. Vacío significa «todavía no se sabe», que no es lo mismo que 0.">
        <input
          className={ENTRADA}
          inputMode="decimal"
          value={itbms}
          onChange={(e) => setItbms(e.target.value)}
          placeholder="7"
        />
      </Campo>

      {precio !== deCentavos(variante.precio_cents) ? (
        <Campo etiqueta="¿Por qué cambia el precio?" ayuda="Queda escrito con su nombre y la fecha.">
          <input
            className={ENTRADA}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Subió el proveedor"
          />
        </Campo>
      ) : null}

      <Campo
        etiqueta="Botón de «Pedir por WhatsApp»"
        ayuda="Lo de Ajustes manda: si allí está apagado, este botón no sale en ningún producto aunque aquí diga que sí."
      >
        <select
          className={ENTRADA}
          value={botonWhatsapp}
          onChange={(e) => setBotonWhatsapp(e.target.value)}
        >
          <option value="">Lo que diga Ajustes</option>
          <option value="si">Sí, enseñarlo en este producto</option>
          <option value="no">No, en este no</option>
        </select>
      </Campo>

      <label className="tactil mb-2 flex items-center gap-3">
        <input
          type="checkbox"
          checked={publicado}
          onChange={(e) => setPublicado(e.target.checked)}
          // Sin esto la casilla sale del azul de fábrica del navegador, que no
          // es de la marca y canta al lado de todo lo demás.
          className="h-5 w-5 accent-[var(--accent)]"
        />
        <span>
          <span className="block font-bold">Mostrarlo en la web</span>
          <span className="block text-[12px] text-muted">
            Apagado, nadie lo ve y el bot no lo ofrece.
          </span>
        </span>
      </label>
    </Hoja>
  );
}
