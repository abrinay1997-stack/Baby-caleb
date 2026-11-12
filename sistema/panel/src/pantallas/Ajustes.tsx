import { useState } from "react";
import { fecha, pedir, useCarga, type Yo } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta } from "../componentes";
import { Hoja } from "../armazon/Hoja";
import { aCentavos, aPuntosBasicos, deCentavos, dePuntosBasicos } from "../dinero";
import { puedeEditar } from "../permisos";
import {
  CLAVES,
  ESQUEMAS,
  PASARELAS_CON_COMISION,
  PENDIENTE,
  esPendiente,
  type Clave,
  type Comision,
  type Esquema,
  type Ventana,
} from "../../../src/dominio/ajustes";

/**
 * Los ajustes: las cifras del negocio, y dónde se cambian.
 *
 * El dueño lo pidió así: «todas esas preguntas abiertas deberían ser
 * ajustables, no un sistema estrictamente así». Antes esta pantalla solo las
 * MOSTRABA; ahora se cambian aquí.
 *
 * ## Tres cosas que definen la pantalla
 *
 * 1. **Lo que falta decidir se ve DISTINTO de un cero.** «Falta decidirlo» y
 *    «0» no son lo mismo, y enseñarlos igual hace que alguien crea que un dato
 *    está resuelto cuando nadie lo ha confirmado. De las quince reglas, siete
 *    están sin decidir, así que esto no es un caso raro: es la mitad.
 *
 * 2. **El qué es cada cifra no se decide aquí.** El tipo, la unidad y los
 *    límites salen de `src/dominio/ajustes.ts`, el mismo módulo que usa el
 *    servidor para validar. Si esta pantalla llevara su propia idea de qué es
 *    `reserva_minutos_pago_en_linea`, tarde o temprano una de las dos diría
 *    horas.
 *
 * 3. **Se usa desde un teléfono casi siempre.** Por eso se cambia en la hoja
 *    que sube desde abajo (`armazon/Hoja`), con Guardar siempre a la vista, y
 *    por eso los campos van a 16 px — por debajo, el teléfono hace zoom al
 *    tocarlos y la dueña acaba peleando con el viewport (§7b).
 *
 * El motivo del cambio se pide siempre. Es lo que convierte la tabla en un
 * historial que contesta «¿quién bajó la comisión en marzo?».
 */

export interface AjusteVigente {
  clave: Clave;
  valor: unknown;
  pendiente: boolean;
  origen: "fabrica" | "guardado";
  version: number | null;
  vigente_desde: number | null;
  cambiado_por: string | null;
  motivo: string | null;
  aviso: string | null;
}

interface VersionDeAjuste {
  version: number;
  valor: unknown;
  vigente_desde: number;
  cambiado_por: string;
  motivo: string | null;
  vigente: boolean;
  futura: boolean;
}

/** Cómo se lee una opción. El nombre técnico no es para la dueña. */
const ETIQUETAS_OPCION: Record<string, string> = {
  yappy: "Yappy",
  tilopay: "Tarjeta (Tilopay)",
  paypal: "PayPal",
  manual: "Comprobante (transferencia, Yappy Comercial)",
  efectivo: "Efectivo",
  reembolso: "Se le devuelve el dinero",
  credito: "Le queda como crédito para otro pedido",
};

const comoSeLeeOpcion = (o: string): string => ETIQUETAS_OPCION[o] ?? o;

const enDolares = (centavos: number): string =>
  `$${Math.trunc(centavos / 100)}.${String(Math.abs(centavos % 100)).padStart(2, "0")}`;

/**
 * El valor en una línea, para la lista.
 *
 * Devuelve texto y no JSX porque lo mismo se lee en la fila y en el historial,
 * y dos formas de escribir el mismo valor acabarían discrepando en una de las
 * dos.
 */
export function comoSeLee(clave: Clave, valor: unknown): string {
  if (esPendiente(valor)) return "Falta decidirlo";
  const e = ESQUEMAS[clave];
  switch (e.tipo) {
    case "dinero_cents":
      return typeof valor === "number" ? enDolares(valor) : "—";
    case "dinero_usd":
      return typeof valor === "number" ? `$${valor} al mes` : "—";
    case "entero":
      return typeof valor === "number" ? `${valor} ${e.unidad ?? ""}`.trim() : "—";
    case "booleano":
      return valor === true ? "Encendido" : "Apagado";
    case "texto":
      return typeof valor === "string" ? valor : "—";
    case "telefono":
      // Con el `+` delante, que es como se lee un número internacional. Se
      // GUARDA sin él porque es lo que quiere `wa.me`; esto es solo la lectura.
      return typeof valor === "string" ? `+${valor}` : "—";
    case "opcion":
      return typeof valor === "string" ? comoSeLeeOpcion(valor) : "—";
    case "lista_de_opciones":
      if (!Array.isArray(valor)) return "—";
      // «Ninguno» y no una celda vacía: una lista vacía es una decisión
      // tomada, y una celda en blanco parece un dato que falta.
      return valor.length === 0 ? "Ninguno" : valor.map((v) => comoSeLeeOpcion(String(v))).join(", ");
    case "ventanas":
      if (!Array.isArray(valor)) return "—";
      return (valor as Ventana[]).map((v) => `${v.etiqueta} ${v.desde}–${v.hasta}`).join(" · ");
    case "comisiones": {
      if (typeof valor !== "object" || valor === null) return "—";
      const tabla = valor as Record<string, Comision | string>;
      return PASARELAS_CON_COMISION.map((p) => {
        const c = tabla[p];
        if (c === undefined || esPendiente(c)) return `${comoSeLeeOpcion(p)}: falta`;
        const com = c as Comision;
        return `${comoSeLeeOpcion(p)} ${dePuntosBasicos(com.porcentaje_bp)} % + ${enDolares(com.fijo_cents)}`;
      }).join(" · ");
    }
  }
}

// Las clases, copiadas de `EditarVariante` para que los dos formularios del
// panel se vean y se toquen igual. 16 px en los campos es contrato (§7b) y lo
// pone `estilos.css` para todo `input`; el `tactil` es el alto de 44 px (§7c).
const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

const BOTON =
  "tactil flex-1 rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[14px] font-bold">{etiqueta}</span>
      {children}
      {ayuda === undefined ? null : (
        <span className="mt-1 block text-[12px] text-muted">{ayuda}</span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// El borrador: lo que se está escribiendo antes de guardar
// ---------------------------------------------------------------------------

/**
 * Lo que se teclea vive como TEXTO hasta que se guarda.
 *
 * Es a propósito: si el estado fuera un número, borrar el último dígito de un
 * campo lo dejaría en `NaN` o en cero, y un cero en el abono mínimo no es lo
 * mismo que un campo a medio escribir. El texto se convierte al pulsar
 * Guardar, y lo que no se entiende se dice entonces.
 */
export interface Borrador {
  pendiente: boolean;
  texto: string;
  booleano: boolean;
  lista: string[];
  ventanas: Ventana[];
  comisiones: Record<string, { sinDecidir: boolean; porcentaje: string; fijo: string; itbms: boolean }>;
}

const ventanaVacia = (): Ventana => ({ id: "", etiqueta: "", desde: "", hasta: "" });

export function borradorDe(a: AjusteVigente): Borrador {
  const e = ESQUEMAS[a.clave];
  const v = a.valor;
  const pendiente = esPendiente(v);

  const comisiones: Borrador["comisiones"] = {};
  for (const p of PASARELAS_CON_COMISION) {
    const c =
      typeof v === "object" && v !== null ? (v as Record<string, unknown>)[p] : undefined;
    const puesta = c !== undefined && !esPendiente(c) ? (c as Comision) : null;
    comisiones[p] = {
      sinDecidir: puesta === null,
      porcentaje: puesta === null ? "" : dePuntosBasicos(puesta.porcentaje_bp),
      fijo: puesta === null ? "" : deCentavos(puesta.fijo_cents),
      itbms: puesta?.lleva_itbms ?? false,
    };
  }

  return {
    pendiente,
    texto:
      pendiente || typeof v === "boolean"
        ? ""
        : e.tipo === "dinero_cents" && typeof v === "number"
          ? deCentavos(v)
          : typeof v === "string" || typeof v === "number"
            ? String(v)
            : "",
    booleano: v === true,
    lista: Array.isArray(v) && e.tipo === "lista_de_opciones" ? (v as string[]) : [],
    ventanas:
      Array.isArray(v) && e.tipo === "ventanas" ? (v as Ventana[]) : [ventanaVacia()],
    comisiones,
  };
}

/**
 * Del borrador al valor que se manda.
 *
 * Devuelve el valor, o un motivo en español para enseñar pegado al campo. No
 * comprueba límites: de eso manda el servidor, que usa el mismo esquema y es
 * la única copia que cuenta. Aquí solo se traduce lo que se escribió —dólares
 * a centavos, por ciento a puntos básicos— y se avisa de lo que no se entiende.
 */
export function valorDelBorrador(
  clave: Clave,
  b: Borrador,
): { valor: unknown } | { error: string } {
  if (b.pendiente) return { valor: PENDIENTE };
  const e = ESQUEMAS[clave];

  switch (e.tipo) {
    case "booleano":
      return { valor: b.booleano };

    case "dinero_cents": {
      const centavos = aCentavos(b.texto);
      if (centavos === null) {
        return { error: "El monto no se entiende. Escríbalo como 12.50, en dólares." };
      }
      return { valor: centavos };
    }

    case "entero":
    case "dinero_usd": {
      const limpio = b.texto.trim();
      if (!/^\d+$/.test(limpio)) {
        return {
          error: `Escriba un número entero${e.unidad === undefined ? "" : ` de ${e.unidad}`}, sin decimales.`,
        };
      }
      return { valor: Number(limpio) };
    }

    case "texto":
      return { valor: b.texto.trim() };

    case "telefono":
      // Sin limpiar aquí: el `+`, los espacios y los guiones los quita
      // `validar` en el servidor, que es la única copia que cuenta. Dos sitios
      // normalizando el mismo número acabarían discrepando en uno.
      return { valor: b.texto.trim() };

    case "opcion":
      if (b.texto === "") return { error: "Elija una de las opciones." };
      return { valor: b.texto };

    case "lista_de_opciones":
      return { valor: b.lista };

    case "ventanas":
      return { valor: b.ventanas };

    case "comisiones": {
      const tabla: Record<string, Comision | string> = {};
      for (const p of PASARELAS_CON_COMISION) {
        const c = b.comisiones[p];
        if (c === undefined || c.sinDecidir) {
          tabla[p] = PENDIENTE;
          continue;
        }
        const bp = aPuntosBasicos(c.porcentaje);
        if (bp === null) {
          return {
            error: `El porcentaje de ${comoSeLeeOpcion(p)} no se entiende. Escríbalo como 3.5`,
          };
        }
        const fijo = aCentavos(c.fijo);
        if (fijo === null) {
          return {
            error: `El cargo fijo de ${comoSeLeeOpcion(p)} no se entiende. Escríbalo como 0.35`,
          };
        }
        tabla[p] = { porcentaje_bp: bp, fijo_cents: fijo, lleva_itbms: c.itbms };
      }
      return { valor: tabla };
    }
  }
}

// ---------------------------------------------------------------------------
// Los editores, uno por tipo
// ---------------------------------------------------------------------------

function Editor({
  esquema,
  borrador,
  cambiar,
}: {
  esquema: Esquema;
  borrador: Borrador;
  cambiar: (parche: Partial<Borrador>) => void;
}) {
  switch (esquema.tipo) {
    case "booleano":
      return (
        <label className="tactil mb-4 flex items-center gap-3">
          <input
            type="checkbox"
            checked={borrador.booleano}
            onChange={(ev) => cambiar({ booleano: ev.target.checked })}
            className="h-5 w-5 accent-[var(--accent)]"
          />
          <span className="font-bold">{borrador.booleano ? "Encendido" : "Apagado"}</span>
        </label>
      );

    case "dinero_cents":
      return (
        <Campo etiqueta="Cuánto" ayuda="En dólares. Se guarda en centavos.">
          <input
            className={ENTRADA}
            inputMode="decimal"
            value={borrador.texto}
            onChange={(ev) => cambiar({ texto: ev.target.value })}
            placeholder="5.00"
          />
        </Campo>
      );

    case "entero":
    case "dinero_usd":
      return (
        <Campo etiqueta={esquema.unidad === undefined ? "Cuánto" : `Cuántos ${esquema.unidad}`}>
          <input
            className={ENTRADA}
            inputMode="numeric"
            value={borrador.texto}
            onChange={(ev) => cambiar({ texto: ev.target.value })}
          />
        </Campo>
      );

    case "texto":
      return (
        <Campo etiqueta="Nombre técnico del modelo">
          <input
            className={ENTRADA}
            value={borrador.texto}
            onChange={(ev) => cambiar({ texto: ev.target.value })}
            placeholder="muse-spark-1.2-contributor"
          />
        </Campo>
      );

    case "telefono":
      return (
        <Campo
          etiqueta="El número, con el código del país"
          ayuda="Se puede pegar tal cual sale del teléfono: 507 6757-5065 o +50767575065. Se guarda solo con los números."
        >
          <input
            className={ENTRADA}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={borrador.texto}
            onChange={(ev) => cambiar({ texto: ev.target.value })}
            placeholder="+507 6757-5065"
          />
        </Campo>
      );

    case "opcion":
      return (
        <Campo etiqueta="Qué se hace">
          <select
            className={ENTRADA}
            value={borrador.texto}
            onChange={(ev) => cambiar({ texto: ev.target.value })}
          >
            <option value="">Elija una…</option>
            {(esquema.opciones ?? []).map((o) => (
              <option key={o} value={o}>
                {comoSeLeeOpcion(o)}
              </option>
            ))}
          </select>
        </Campo>
      );

    case "lista_de_opciones":
      return (
        <fieldset className="mb-4 border-0 p-0">
          <legend className="mb-1 text-[14px] font-bold">Marque las que sí</legend>
          {(esquema.opciones ?? []).map((o) => (
            <label key={o} className="tactil flex items-center gap-3">
              <input
                type="checkbox"
                checked={borrador.lista.includes(o)}
                onChange={(ev) =>
                  cambiar({
                    lista: ev.target.checked
                      ? [...borrador.lista, o]
                      : borrador.lista.filter((x) => x !== o),
                  })
                }
                className="h-5 w-5 accent-[var(--accent)]"
              />
              <span>{comoSeLeeOpcion(o)}</span>
            </label>
          ))}
          {borrador.lista.length === 0 ? (
            <p className="mt-1 mb-0 text-[12px] text-muted">
              Ninguna marcada. Es una decisión válida y no lo mismo que dejarlo sin decidir.
            </p>
          ) : null}
        </fieldset>
      );

    case "ventanas":
      return (
        <EditorDeVentanas
          ventanas={borrador.ventanas}
          cambiar={(ventanas) => cambiar({ ventanas })}
        />
      );

    case "comisiones":
      return (
        <EditorDeComisiones
          comisiones={borrador.comisiones}
          cambiar={(comisiones) => cambiar({ comisiones })}
        />
      );
  }
}

function EditorDeVentanas({
  ventanas,
  cambiar,
}: {
  ventanas: Ventana[];
  cambiar: (v: Ventana[]) => void;
}) {
  const poner = (i: number, parche: Partial<Ventana>) =>
    cambiar(ventanas.map((v, j) => (i === j ? { ...v, ...parche } : v)));

  return (
    <fieldset className="mb-4 border-0 p-0">
      <legend className="mb-1 text-[14px] font-bold">Las franjas del día</legend>
      <p className="mt-0 mb-3 text-[12px] text-muted">
        El código queda escrito en cada envío, así que no se cambia después: escríbalo en
        minúsculas y sin acentos («manana», «tarde»). El nombre sí se puede cambiar cuando quiera.
      </p>
      {ventanas.map((v, i) => (
        // El índice como clave es correcto aquí: las filas no se reordenan en
        // la pantalla, solo se añaden y se quitan desde el final visible.
        <div key={i} className="mb-3 rounded-[12px] border border-line p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[12px] text-muted">Código</span>
              <input
                className={ENTRADA}
                value={v.id}
                onChange={(ev) => poner(i, { id: ev.target.value })}
                placeholder="manana"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-muted">Nombre que lee la clienta</span>
              <input
                className={ENTRADA}
                value={v.etiqueta}
                onChange={(ev) => poner(i, { etiqueta: ev.target.value })}
                placeholder="Mañana"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-muted">Desde</span>
              <input
                className={ENTRADA}
                inputMode="numeric"
                value={v.desde}
                onChange={(ev) => poner(i, { desde: ev.target.value })}
                placeholder="08:00"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-muted">Hasta</span>
              <input
                className={ENTRADA}
                inputMode="numeric"
                value={v.hasta}
                onChange={(ev) => poner(i, { hasta: ev.target.value })}
                placeholder="12:00"
              />
            </label>
          </div>
          {ventanas.length > 1 ? (
            <button
              type="button"
              onClick={() => cambiar(ventanas.filter((_, j) => j !== i))}
              className="tactil mt-2 rounded-[12px] border border-line px-4 py-2 font-bold"
            >
              Quitar esta franja
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        onClick={() => cambiar([...ventanas, ventanaVacia()])}
        className="tactil w-full rounded-[14px] border border-line px-4 py-3 font-bold"
      >
        Añadir otra franja
      </button>
    </fieldset>
  );
}

function EditorDeComisiones({
  comisiones,
  cambiar,
}: {
  comisiones: Borrador["comisiones"];
  cambiar: (c: Borrador["comisiones"]) => void;
}) {
  const poner = (p: string, parche: Partial<Borrador["comisiones"][string]>) => {
    const actual = comisiones[p];
    if (actual === undefined) return;
    cambiar({ ...comisiones, [p]: { ...actual, ...parche } });
  };

  return (
    <fieldset className="mb-4 border-0 p-0">
      <legend className="mb-1 text-[14px] font-bold">Una por pasarela</legend>
      <p className="mt-0 mb-3 text-[12px] text-muted">
        Cada una sale de su contrato, y los contratos llegan de uno en uno: puede llenar la que
        tenga y dejar las otras sin decidir. El efectivo y la transferencia no están aquí porque su
        comisión se toma del extracto del banco.
      </p>
      {PASARELAS_CON_COMISION.map((p) => {
        const c = comisiones[p];
        if (c === undefined) return null;
        return (
          <div key={p} className="mb-3 rounded-[12px] border border-line p-3">
            <p className="m-0 mb-2 font-bold">{comoSeLeeOpcion(p)}</p>
            <label className="tactil flex items-center gap-3">
              <input
                type="checkbox"
                checked={c.sinDecidir}
                onChange={(ev) => poner(p, { sinDecidir: ev.target.checked })}
                className="h-5 w-5 accent-[var(--accent)]"
              />
              <span>Todavía no tengo su contrato</span>
            </label>
            {c.sinDecidir ? null : (
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] text-muted">Porcentaje (%)</span>
                  <input
                    className={ENTRADA}
                    inputMode="decimal"
                    value={c.porcentaje}
                    onChange={(ev) => poner(p, { porcentaje: ev.target.value })}
                    placeholder="3.5"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] text-muted">Cargo fijo ($)</span>
                  <input
                    className={ENTRADA}
                    inputMode="decimal"
                    value={c.fijo}
                    onChange={(ev) => poner(p, { fijo: ev.target.value })}
                    placeholder="0.35"
                  />
                </label>
                <label className="tactil flex items-center gap-3 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={c.itbms}
                    onChange={(ev) => poner(p, { itbms: ev.target.checked })}
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  <span>La comisión lleva ITBMS encima</span>
                </label>
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// La hoja de cambiar un ajuste
// ---------------------------------------------------------------------------

function HojaDeAjuste({
  ajuste,
  alCerrar,
  alGuardar,
}: {
  ajuste: AjusteVigente | null;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [cargado, setCargado] = useState<Clave | null>(null);
  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [versiones, setVersiones] = useState<VersionDeAjuste[] | null>(null);

  // Los campos se llenan cuando cambia el ajuste, no en cada render: si no,
  // cada tecla se perdería al volver a pintar. Es el mismo patrón que
  // `EditarVariante`.
  if (ajuste !== null && cargado !== ajuste.clave) {
    setCargado(ajuste.clave);
    setBorrador(borradorDe(ajuste));
    setMotivo("");
    setError(null);
    setVersiones(null);
    void pedir<{ versiones: VersionDeAjuste[] }>(
      `/api/ajustes/${encodeURIComponent(ajuste.clave)}/historial`,
    )
      .then((r) => setVersiones(r.versiones))
      // Un historial que no carga no impide cambiar la regla: es contexto, no
      // parte del guardado.
      .catch(() => setVersiones([]));
  }

  if (ajuste === null || borrador === null) return null;

  const esquema = ESQUEMAS[ajuste.clave];

  const cerrar = () => {
    setCargado(null);
    setBorrador(null);
    setError(null);
    alCerrar();
  };

  async function guardar() {
    if (ajuste === null || borrador === null) return;
    const salida = valorDelBorrador(ajuste.clave, borrador);
    if ("error" in salida) {
      setError(salida.error);
      return;
    }
    if (motivo.trim() === "") {
      setError("Escriba por qué lo cambia: es lo que explica este cambio dentro de seis meses.");
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      await pedir(`/api/ajustes/${encodeURIComponent(ajuste.clave)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ valor: salida.valor, motivo: motivo.trim() }),
      });
      alGuardar();
      cerrar();
    } catch (e) {
      // El motivo del servidor se enseña tal cual: ya viene en español y
      // dirigido a ella (`src/dominio/ajustes.ts` los escribe así). Traducirlo
      // otra vez aquí perdería lo concreto, que es lo único que sirve para
      // arreglar el campo.
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  const cambiar = (parche: Partial<Borrador>) =>
    setBorrador((b) => (b === null ? b : { ...b, ...parche }));

  return (
    <Hoja
      abierta
      titulo={esquema.titulo}
      alCerrar={cerrar}
      pie={
        <>
          <button type="button" onClick={cerrar} className={`${BOTON} border border-line`}>
            Cancelar
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
      <p className="mt-0 mb-4 text-muted">{esquema.explica}</p>

      {error === null ? null : (
        <p
          role="alert"
          className="mt-0 mb-4 rounded-[12px] border border-accent-edge bg-bg p-3 font-bold"
        >
          {error}
        </p>
      )}

      {esquema.admitePendiente ? (
        <label className="tactil mb-4 flex items-start gap-3 rounded-[12px] border border-line p-3">
          <input
            type="checkbox"
            checked={borrador.pendiente}
            onChange={(ev) => cambiar({ pendiente: ev.target.checked })}
            className="mt-0.5 h-5 w-5 accent-[var(--accent)]"
          />
          <span>
            <span className="block font-bold">Todavía no lo he decidido</span>
            <span className="block text-[12px] text-muted">
              Lo que dependa de esta regla no se enciende hasta que usted la decida. Es mejor que
              funcionar con un número inventado.
            </span>
          </span>
        </label>
      ) : null}

      {borrador.pendiente ? null : (
        <Editor esquema={esquema} borrador={borrador} cambiar={cambiar} />
      )}

      <Campo
        etiqueta="¿Por qué lo cambia?"
        ayuda="Queda escrito con su nombre y la fecha. Es lo que contesta «¿quién cambió esto y cuándo?»."
      >
        <input
          className={ENTRADA}
          value={motivo}
          onChange={(ev) => setMotivo(ev.target.value)}
          placeholder="Lo confirmó el contrato de Yappy"
        />
      </Campo>

      <details className="rounded-[12px] border border-line p-3">
        <summary className="tactil flex cursor-pointer items-center font-bold">
          Lo que ha valido antes
        </summary>
        {versiones === null ? (
          <p className="m-0 mt-2 text-muted">Cargando…</p>
        ) : versiones.length === 0 ? (
          <p className="m-0 mt-2 text-muted">
            Nunca se ha cambiado: hasta ahora vale el valor con el que arrancó el sistema.
          </p>
        ) : (
          <ul className="m-0 mt-2 list-none p-0">
            {versiones.map((v) => (
              <li key={v.version} className="border-b border-line py-2 last:border-0">
                <span className="block font-bold">{comoSeLee(ajuste.clave, v.valor)}</span>
                <span className="block text-[12px] text-muted">
                  {fecha(v.vigente_desde)} · {v.cambiado_por}
                  {v.motivo === null ? "" : ` · ${v.motivo}`}
                  {v.futura ? " · programado, todavía no vale" : ""}
                  {v.vigente ? " · es el que vale hoy" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Hoja>
  );
}

// ---------------------------------------------------------------------------
// La pantalla
// ---------------------------------------------------------------------------

export function Ajustes() {
  const [abierto, setAbierto] = useState<AjusteVigente | null>(null);
  // `recargas` sube al guardar: es la dependencia que hace que `useCarga`
  // vuelva a pedir la lista. Sin ella, la fila seguiría enseñando el valor
  // viejo hasta que alguien recargara la página, y nadie recarga una página en
  // el teléfono para comprobar si su cambio entró.
  const [recargas, setRecargas] = useState(0);
  const datos = useCarga<{ ajustes: AjusteVigente[]; ahora: number }>("/api/ajustes", [recargas]);
  // El rol se vuelve a pedir aquí en vez de recibirse por props porque
  // `App.tsx` no se lo pasa a las pantallas. Hace falta para no ofrecer un
  // botón que va a responder 403: esconder sin comprobar no es seguridad, y
  // comprobar sin esconder es ofrecer algo que luego se niega.
  const yo = useCarga<Yo>("/api/yo");

  const puedeCambiar = yo.fase === "listo" && puedeEditar(yo.datos.usuario.rol, "ajustes");

  /**
   * Qué está consiguiendo `checkout_activo`.
   *
   * Hasta hoy esta pantalla decía «Encendido» y se quedaba tan ancha. Era
   * verdad sobre el valor guardado y mentira sobre el mundo: ningún código
   * consultaba ese interruptor, así que la dueña podía encenderlo y no pasaba
   * nada (docs/TRAMPAS.md §13). Ahora se le pregunta al servidor qué está
   * haciendo, y se escribe.
   *
   * Se pide aparte y no se calcula aquí: cruzar el interruptor con las
   * pasarelas desde el navegador serían dos sitios decidiendo lo mismo, y el
   * que se equivoca del lado flojo es el que nadie revisa.
   */
  const checkout = useCarga<{
    interruptor: boolean;
    cobra: boolean;
    inerte: boolean;
    listas: string[];
    enPrueba: string[];
    impedimentos: string[];
    resumen: string;
    llave_maestra_puesta: boolean | null;
  }>("/api/checkout", [recargas]);

  return (
    <Carga estado={datos} que="los ajustes">
      {(d) => {
        const puestos = new Map(d.ajustes.map((a) => [a.clave, a]));
        // El orden es el de `CLAVES` —el del dominio, que agrupa las reglas por
        // tema— y no el que devuelva el servidor.
        const enOrden = CLAVES.map((c) => puestos.get(c)).filter(
          (a): a is AjusteVigente => a !== undefined,
        );
        const sinDecidir = enOrden.filter((a) => a.pendiente);
        const avisos = enOrden.filter((a) => a.aviso !== null);

        return (
          <div className="grid gap-4">
            {sinDecidir.length > 0 ? (
              <Tarjeta className="border-accent-edge">
                <p className="m-0 font-bold">
                  {sinDecidir.length} regla{sinDecidir.length === 1 ? "" : "s"} sin decidir
                </p>
                <p className="m-0 mt-1 text-muted">
                  El sistema no las rellena solo. Hasta que usted decida, lo que dependa de ellas no
                  se enciende — que es mejor que funcionar con un número inventado. Toque
                  «Cambiar» en cualquiera para decidirla.
                </p>
              </Tarjeta>
            ) : null}

            {avisos.map((a) => (
              <Tarjeta key={a.clave} className="border-accent-edge">
                <p role="alert" className="m-0 font-bold">
                  {ESQUEMAS[a.clave].titulo}: hay algo guardado que el sistema no puede usar
                </p>
                <p className="m-0 mt-1 text-muted">{a.aviso}</p>
              </Tarjeta>
            ))}

            {/* El cobro en la web, dicho como está.
                No es una tarjeta más: es la que existe porque este interruptor
                llevaba meses encendido sin hacer nada y la pantalla decía
                «Encendido» a secas. Sale SIEMPRE que hay respuesta —cobre o no
                cobre— porque «sí cobra, con Yappy» es tan útil como la lista
                de lo que falta. */}
            {checkout.fase === "listo" ? (
              <Tarjeta className={checkout.datos.cobra ? "" : "border-accent-edge"}>
                <p className="m-0 font-bold">Pagar desde la web: {checkout.datos.resumen}</p>
                {checkout.datos.impedimentos.length > 0 ? (
                  <ul className="m-0 mt-2 grid gap-1 pl-5 text-muted">
                    {checkout.datos.impedimentos.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                ) : null}
                {checkout.datos.enPrueba.length > 0 ? (
                  <p className="m-0 mt-2 text-muted">
                    En modo de prueba: {checkout.datos.enPrueba.join(", ")}. Cobrarían con
                    credenciales de prueba, así que no cuentan.
                  </p>
                ) : null}
                {checkout.datos.llave_maestra_puesta === false ? (
                  <p role="alert" className="m-0 mt-2 text-muted">
                    Y al sistema le falta la llave con la que se guardan las credenciales. Eso no se
                    arregla aquí: avísele a Juan.
                  </p>
                ) : null}
              </Tarjeta>
            ) : null}
            {/* Si no se pudo preguntar, se dice. Callar dejaría la fila de
                abajo diciendo «Encendido» sin nadie que lo matice, que es
                exactamente el estado del que venimos. */}
            {checkout.fase === "error" ? (
              <Tarjeta className="border-accent-edge">
                <p role="alert" className="m-0 font-bold">
                  No pudimos comprobar si la web puede cobrar
                </p>
                <p className="m-0 mt-1 text-muted">
                  {checkout.mensaje}. Mientras no se sepa, no dé por hecho que el interruptor de
                  abajo está haciendo algo.
                </p>
              </Tarjeta>
            ) : null}

            <Rejilla
              columnas={["Regla", "Valor", "De dónde sale", "Desde cuándo", "Cambiar"]}
            >
              {enOrden.map((a) => (
                <Fila key={a.clave}>
                  <Celda etiqueta="">{ESQUEMAS[a.clave].titulo}</Celda>
                  <Celda etiqueta="Valor" papel="clave">
                    {/* Lo que falta decidir va con pastilla y no con texto a
                        secas: a un lado de un «0» o de un «Apagado» tiene que
                        verse que NO es un valor elegido. */}
                    {a.pendiente ? (
                      <Pastilla tono="aviso">Falta decidirlo</Pastilla>
                    ) : (
                      <strong>{comoSeLee(a.clave, a.valor)}</strong>
                    )}
                    {/* «Encendido» a secas era la mentira. La fila sigue
                        diciendo el valor guardado —que es lo que esta columna
                        es— y al lado dice si está surtiendo efecto. */}
                    {a.clave === "checkout_activo" &&
                    checkout.fase === "listo" &&
                    checkout.datos.inerte ? (
                      <span className="mt-1 block text-[13px] text-muted">
                        Sin efecto todavía: la web no cobra. Arriba está lo que falta.
                      </span>
                    ) : null}
                  </Celda>
                  <Celda etiqueta="De dónde sale" className="text-muted">
                    {a.origen === "guardado" ? (
                      <>
                        Lo puso {a.cambiado_por}
                        {a.motivo === null ? "" : `: ${a.motivo}`}
                      </>
                    ) : (
                      "Valor con el que arrancó el sistema"
                    )}
                  </Celda>
                  <Celda etiqueta="Desde cuándo" className="text-muted">
                    {a.vigente_desde === null ? "—" : fecha(a.vigente_desde)}
                  </Celda>
                  <Celda etiqueta="Cambiar" papel="estado">
                    {puedeCambiar ? (
                      <button
                        type="button"
                        onClick={() => setAbierto(a)}
                        className="tactil rounded-[12px] border border-line px-4 py-2 font-bold focus-visible:outline-accent-edge focus-visible:outline-2"
                      >
                        Cambiar
                        {/* El nombre completo para quien navega con lector: en
                            la lista hay quince botones que dicen «Cambiar». */}
                        <span className="sr-only"> {ESQUEMAS[a.clave].titulo}</span>
                      </button>
                    ) : null}
                  </Celda>
                </Fila>
              ))}
            </Rejilla>

            {puedeCambiar ? null : (
              <Tarjeta>
                <p className="m-0 text-muted">
                  {yo.fase === "listo"
                    ? "Su rol puede ver estas reglas, pero cambiarlas es de la dueña."
                    : "Mientras no se sepa quién abrió el panel, estas reglas solo se pueden leer."}
                </p>
              </Tarjeta>
            )}

            <Tarjeta>
              <p className="m-0 text-muted">
                Un ajuste solo cambia hacia adelante: lo que ya pasó se queda como pasó. Por eso un
                pedido guarda su abono mínimo al crearse — si usted sube el mínimo mañana, el pedido
                de hoy no cambia de reglas a mitad. Y nada se borra: cada cambio queda como una
                versión nueva, con su fecha, su nombre y su motivo.
              </p>
            </Tarjeta>

            <HojaDeAjuste
              ajuste={abierto}
              alCerrar={() => setAbierto(null)}
              alGuardar={() => setRecargas((n) => n + 1)}
            />
          </div>
        );
      }}
    </Carga>
  );
}
