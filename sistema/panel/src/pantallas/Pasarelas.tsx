import { useState } from "react";
import { fecha, pedir, useCarga, type Yo } from "../api";
import { Carga, Pastilla, Tarjeta } from "../componentes";
import { Hoja } from "../armazon/Hoja";
import { puedeEditar } from "../permisos";
import {
  CONECTORES,
  ETIQUETAS_MODO,
  elOtroModo,
  type Credencial,
  type Modo,
  type Pasarela,
} from "../../../src/dominio/pasarelas";

/**
 * Las pasarelas de cobro: dónde se configuran y dónde se encienden.
 *
 * El dueño lo pidió así: «necesitamos poder poner los conectores o pasarelas
 * de pago en el panel administrativo, poder integrarlos así como en Odoo».
 *
 * ## Las cuatro preguntas que esta pantalla contesta de un vistazo
 *
 *  1. ¿Qué pasarelas hay? Las tres, siempre, aunque ninguna esté configurada.
 *     Una pasarela que no aparece es una que nadie vuelve a buscar.
 *  2. ¿Cuáles están encendidas? Con pastilla y con palabras, no con color:
 *     el color por sí solo no es un estado para quien no lo distingue (§7i).
 *  3. ¿A cuál le falta algo? Y **qué le falta, por su nombre**. «Configuración
 *     incompleta» deja a la dueña abriendo campos a ver cuál es.
 *  4. ¿Está en modo de prueba o en modo real? Es lo primero que se lee de cada
 *     tarjeta, porque confundirlos es el fallo que cuesta dinero.
 *
 * ## Lo que esta pantalla NO puede hacer
 *
 * **Leer una credencial.** El servidor no la devuelve: ni enmascarada, ni los
 * últimos cuatro caracteres, ni a quien la escribió. Por eso el campo sale
 * siempre vacío y dice «hay una puesta» en vez de enseñar puntitos: unos
 * puntitos darían a entender que el valor está ahí y que podría salir.
 *
 * ## Se dibuja del catálogo, no a mano
 *
 * Los campos de cada pasarela salen de `src/dominio/pasarelas.ts`, el mismo
 * módulo con el que el servidor valida. Aquí no hay tres formularios escritos a
 * mano: el día que Tilopay confirme sus credenciales, se escriben allí y esta
 * pantalla las pinta sin que nadie la toque.
 *
 * ## Teléfono
 *
 * Es donde se usa el 95 % del tiempo. Cada pasarela es una tarjeta —no una
 * fila de tabla— porque lo que hay que leer de una pasarela son varias cosas a
 * la vez, y una fila de siete columnas en 390 px no es una tabla, es un
 * desplazamiento de lado. Lo que se escribe se escribe en la hoja que sube
 * desde abajo, con Guardar al alcance del pulgar.
 */

// ---------------------------------------------------------------------------
// Lo que contesta el servidor
// ---------------------------------------------------------------------------

// Las formas se escriben aquí y no se importan de `src/db/pasarelas.ts`: ese
// módulo habla de D1 y el navegador no lo puede cargar. Es el mismo arreglo que
// usa la pantalla de Ajustes con `AjusteVigente`.

export interface CredencialPuesta {
  nombre: string;
  /** Lo único que se sabe de un secreto desde aquí. */
  puesta: boolean;
  version: number | null;
  puesta_por: string | null;
  puesta_en: number | null;
  llave_id: string | null;
}

export interface EstadoDeModo {
  modo: Modo;
  esElActual: boolean;
  credenciales: CredencialPuesta[];
  faltan: string[];
  completo: boolean;
}

export interface EstadoDePasarela {
  pasarela: Pasarela;
  titulo: string;
  explica: string;
  por_confirmar: string | null;
  fuente: string;
  modo: Modo;
  modo_cambiado_por: string | null;
  modo_cambiado_en: number | null;
  encendida: boolean;
  modos: EstadoDeModo[];
  puede_encenderse: boolean;
  por_que_no: string | null;
  incoherente: boolean;
}

export interface LineaDelLibro {
  id: string;
  pasarela: Pasarela;
  accion: "credencial_puesta" | "credencial_cambiada" | "credencial_quitada" | "modo_cambiado";
  modo: Modo;
  credencial: string | null;
  version: number | null;
  actor: string;
  motivo: string;
  creado_en: number;
}

export interface EstadoDeLasPasarelas {
  pasarelas: EstadoDePasarela[];
  llave_maestra_puesta: boolean;
  llave_maestra_problema: string | null;
  libro: LineaDelLibro[];
}

// ---------------------------------------------------------------------------
// Cómo se leen las cosas
// ---------------------------------------------------------------------------

/** El título de una credencial sale del catálogo, no de su nombre técnico. */
export function tituloDeCredencial(pasarela: Pasarela, nombre: string): string {
  return CONECTORES[pasarela].credenciales.find((c) => c.nombre === nombre)?.titulo ?? nombre;
}

/**
 * Una línea del libro, en una frase.
 *
 * Se escribe aquí y no en el servidor porque es texto para leer, no un dato; y
 * se escribe en un solo sitio para que la del libro y la de la tarjeta no
 * acaben contando lo mismo de dos maneras.
 */
export function comoSeLeeLaLinea(l: LineaDelLibro): string {
  const donde = CONECTORES[l.pasarela]?.titulo ?? l.pasarela;
  const cual = l.credencial === null ? "" : `«${tituloDeCredencial(l.pasarela, l.credencial)}» de `;
  switch (l.accion) {
    case "credencial_puesta":
      return `Se puso ${cual}${donde} (${ETIQUETAS_MODO[l.modo].toLowerCase()})`;
    case "credencial_cambiada":
      return `Se cambió ${cual}${donde} (${ETIQUETAS_MODO[l.modo].toLowerCase()})`;
    case "credencial_quitada":
      return `Se quitó ${cual}${donde} (${ETIQUETAS_MODO[l.modo].toLowerCase()})`;
    case "modo_cambiado":
      return `${donde} pasó a ${ETIQUETAS_MODO[l.modo].toLowerCase()}`;
  }
}

// Las clases, copiadas de `Ajustes` para que los formularios del panel se vean
// y se toquen igual. Los 16 px de los campos los pone `estilos.css` para todo
// `input` (§7b) y `tactil` es el alto de 44 px (§7c).
const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

const BOTON =
  "tactil flex-1 rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

const BOTON_FILA =
  "tactil rounded-[12px] border border-line px-4 py-2 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

// ---------------------------------------------------------------------------
// Lo que se está por hacer
// ---------------------------------------------------------------------------

export type Accion =
  | { tipo: "poner"; pasarela: EstadoDePasarela; modo: Modo; credencial: Credencial }
  | { tipo: "quitar"; pasarela: EstadoDePasarela; modo: Modo; credencial: Credencial }
  | { tipo: "modo"; pasarela: EstadoDePasarela; a: Modo }
  | { tipo: "encender"; pasarela: EstadoDePasarela }
  | { tipo: "apagar"; pasarela: EstadoDePasarela };

/** El título de la hoja. Dice exactamente qué se va a hacer y sobre qué. */
export function tituloDeAccion(a: Accion): string {
  switch (a.tipo) {
    case "poner":
      return `${a.credencial.titulo} · ${a.pasarela.titulo}`;
    case "quitar":
      return `Quitar ${a.credencial.titulo}`;
    case "modo":
      return `${a.pasarela.titulo}: pasar a ${ETIQUETAS_MODO[a.a].toLowerCase()}`;
    case "encender":
      return `Encender ${a.pasarela.titulo}`;
    case "apagar":
      return `Apagar ${a.pasarela.titulo}`;
  }
}

/** Qué se le manda al servidor. Separado para poder leerlo de un vistazo. */
export function peticionDeAccion(
  a: Accion,
  valor: string,
  motivo: string,
): { ruta: string; cuerpo: Record<string, unknown> } {
  const base = `/api/pasarelas/${a.pasarela.pasarela}`;
  switch (a.tipo) {
    case "poner":
      return {
        ruta: `${base}/credenciales/${a.credencial.nombre}`,
        cuerpo: { modo: a.modo, valor, motivo },
      };
    case "quitar":
      return {
        ruta: `${base}/credenciales/${a.credencial.nombre}/quitar`,
        cuerpo: { modo: a.modo, motivo },
      };
    case "modo":
      return { ruta: `${base}/modo`, cuerpo: { modo: a.a, motivo } };
    case "encender":
      return { ruta: `${base}/encendida`, cuerpo: { encendida: true, motivo } };
    case "apagar":
      return { ruta: `${base}/encendida`, cuerpo: { encendida: false, motivo } };
  }
}

/**
 * Qué acción es exactamente.
 *
 * Sirve para saber cuándo los campos de la hoja hay que limpiarlos: con una
 * firma menos precisa, abrir «Clave secreta» justo después de «ID de comercio»
 * dejaría en el campo lo que se escribió para la otra. Un secreto que se queda
 * en un campo que no le corresponde es la forma más fácil de guardarlo en el
 * sitio equivocado.
 */
export function firmaDe(a: Accion): string {
  switch (a.tipo) {
    case "poner":
    case "quitar":
      return `${a.tipo}:${a.pasarela.pasarela}:${a.modo}:${a.credencial.nombre}`;
    case "modo":
      return `modo:${a.pasarela.pasarela}:${a.a}`;
    case "encender":
    case "apagar":
      return `${a.tipo}:${a.pasarela.pasarela}`;
  }
}

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
// La hoja que escribe
// ---------------------------------------------------------------------------

function HojaDeAccion({
  accion,
  alCerrar,
  alGuardar,
}: {
  accion: Accion | null;
  alCerrar: () => void;
  alGuardar: (que: string) => void;
}) {
  const [cargada, setCargada] = useState<string | null>(null);
  const [valor, setValor] = useState("");
  const [mostrar, setMostrar] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Los campos se limpian cuando cambia la acción, no en cada pintada: si no,
  // cada tecla se perdería. Es el patrón de `Ajustes` y de `EditarVariante`.
  const firma = accion === null ? null : firmaDe(accion);
  if (firma !== null && cargada !== firma) {
    setCargada(firma);
    setValor("");
    setMostrar(false);
    setMotivo("");
    setError(null);
  }

  if (accion === null) return null;

  const cerrar = () => {
    setCargada(null);
    // El secreto no se queda en la memoria de la pantalla después de cerrar.
    setValor("");
    setMostrar(false);
    setError(null);
    alCerrar();
  };

  async function guardar() {
    if (accion === null) return;
    if (accion.tipo === "poner" && valor.trim() === "") {
      setError("Pegue la credencial completa, tal como aparece en el portal de la pasarela.");
      return;
    }
    if (motivo.trim() === "") {
      setError("Escriba por qué lo hace: queda en el libro con su nombre y la fecha.");
      return;
    }

    setGuardando(true);
    setError(null);
    const { ruta, cuerpo } = peticionDeAccion(accion, valor.trim(), motivo.trim());
    try {
      await pedir(ruta, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      alGuardar(tituloDeAccion(accion));
      cerrar();
    } catch (e) {
      // El motivo del servidor se enseña tal cual: ya viene en español, dirigido
      // a ella, y nombrando lo concreto. Volver a traducirlo aquí perdería justo
      // eso. Y no puede traer el valor: el servidor no lo repite nunca.
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  const laQueHay =
    accion.tipo === "poner"
      ? accion.pasarela.modos
          .find((m) => m.modo === accion.modo)
          ?.credenciales.find((c) => c.nombre === accion.credencial.nombre)
      : undefined;

  return (
    <Hoja
      abierta
      titulo={tituloDeAccion(accion)}
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
      {/* En qué modo se está trabajando, arriba y en palabras. Es el dato que
          cuesta dinero si se confunde, así que no se deduce de un color. */}
      {accion.tipo === "poner" || accion.tipo === "quitar" ? (
        <p className="mt-0 mb-3">
          <Pastilla tono={accion.modo === "real" ? "aviso" : "neutro"}>
            {ETIQUETAS_MODO[accion.modo]}
          </Pastilla>
        </p>
      ) : null}

      {error === null ? null : (
        <p
          role="alert"
          className="mt-0 mb-4 rounded-[12px] border border-accent-edge bg-bg p-3 font-bold"
        >
          {error}
        </p>
      )}

      {accion.tipo === "poner" ? (
        <>
          <p className="mt-0 mb-4 text-muted">{accion.credencial.explica}</p>
          {laQueHay?.puesta === true ? (
            <p className="mt-0 mb-4 rounded-[12px] border border-line p-3 text-[14px]">
              Ya hay una puesta: la puso {laQueHay.puesta_por}
              {laQueHay.puesta_en === null ? "" : ` el ${fecha(laQueHay.puesta_en)}`}. El sistema no
              la puede leer ni enseñar, así que lo que escriba aquí la reemplaza.
            </p>
          ) : null}
          <Campo
            etiqueta={accion.credencial.titulo}
            ayuda="Péguela completa y de una sola línea. El campo sale vacío siempre: el sistema guarda la credencial cifrada y no la puede volver a leer, ni para enseñársela a usted."
          >
            <input
              className={ENTRADA}
              // El tipo cambia con el interruptor de abajo. Oculto por defecto
              // porque esto se usa en el teléfono, a veces delante de gente; y
              // con interruptor porque pegar una clave de sesenta caracteres a
              // ciegas y no poder comprobarla es como se guarda una a medias.
              type={mostrar ? "text" : "password"}
              value={valor}
              onChange={(ev) => setValor(ev.target.value)}
              // Nada de que el navegador la guarde o la autocomplete: esto no
              // es la contraseña de nadie, es una llave del negocio.
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="aviso-credencial"
            />
          </Campo>
          <button
            type="button"
            onClick={() => setMostrar((m) => !m)}
            className={`${BOTON_FILA} mb-4`}
            aria-pressed={mostrar}
          >
            {mostrar ? "Ocultar lo que escribí" : "Ver lo que escribí"}
          </button>
          <p id="aviso-credencial" className="mt-0 mb-4 text-[12px] text-muted">
            Guardar no enciende la pasarela. Encenderla es aparte, y después de
            probar un cobro de verdad.
          </p>
        </>
      ) : null}

      {accion.tipo === "quitar" ? (
        <p className="mt-0 mb-4 text-muted">
          Se borra de la base y no se puede recuperar: para volver a usarla habrá que pegarla otra
          vez desde el portal de la pasarela. Queda escrito en el libro quién la quitó y por qué.
        </p>
      ) : null}

      {accion.tipo === "modo" ? (
        <div className="mt-0 mb-4">
          <p className="mt-0 mb-2 text-muted">
            {accion.a === "real"
              ? "En modo real, el próximo cobro es dinero de verdad. Se usan las credenciales de producción, que son otras: compruebe que están puestas antes de encender la pasarela."
              : "En modo de prueba no se cobra nada de verdad. Se usan las credenciales de la caja de arena de la pasarela, que son otras."}
          </p>
          <p className="m-0 text-[12px] text-muted">
            Las credenciales de {ETIQUETAS_MODO[accion.a].toLowerCase()}:{" "}
            {accion.pasarela.modos.find((m) => m.modo === accion.a)?.completo === true
              ? "están todas puestas."
              : `falta ${(accion.pasarela.modos.find((m) => m.modo === accion.a)?.faltan ?? []).join(", ")}.`}
          </p>
        </div>
      ) : null}

      {accion.tipo === "encender" ? (
        <p className="mt-0 mb-4 text-muted">
          A partir de ahora la web le ofrece esta forma de pago a las clientas, en{" "}
          {ETIQUETAS_MODO[accion.pasarela.modo].toLowerCase()}. Hágalo cuando ya haya probado un
          cobro de verdad y su reembolso.
        </p>
      ) : null}

      {accion.tipo === "apagar" ? (
        <p className="mt-0 mb-4 text-muted">
          La web deja de ofrecerla al instante. Las clientas podrán seguir pagando con comprobante,
          que no se apaga nunca.
        </p>
      ) : null}

      <Campo
        etiqueta="¿Por qué?"
        ayuda="Queda escrito con su nombre y la fecha. Es lo que explica dentro de seis meses por qué esta pasarela empezó o dejó de cobrar."
        >
        <input
          className={ENTRADA}
          value={motivo}
          onChange={(ev) => setMotivo(ev.target.value)}
          placeholder="Me llegaron las credenciales de Yappy"
        />
      </Campo>
    </Hoja>
  );
}

// ---------------------------------------------------------------------------
// Una pasarela
// ---------------------------------------------------------------------------

function FilaDeCredencial({
  pasarela,
  modo,
  credencial,
  puesta,
  puedeCambiar,
  haceFalta,
  abrir,
}: {
  pasarela: EstadoDePasarela;
  modo: Modo;
  credencial: Credencial;
  puesta: CredencialPuesta | undefined;
  puedeCambiar: boolean;
  haceFalta: boolean;
  abrir: (a: Accion) => void;
}) {
  const estaPuesta = puesta?.puesta === true;
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-line py-3 last:border-0">
      {/* `basis-full` en el teléfono: el nombre se lleva una línea entera y
          las pastillas y los botones bajan a la siguiente. Sin eso, el nombre
          queda aplastado por sus hermanos de ancho fijo — es el caso del
          §7l «row-wrap/row-grow». El punto de quiebre es `md` (768 px), el
          único del sistema de diseño (§7a). */}
      <span className="min-w-0 flex-1 basis-full md:basis-auto">
        <span className="block font-bold">{credencial.titulo}</span>
        <span className="block text-[12px] text-muted">
          {estaPuesta
            ? `La puso ${puesta?.puesta_por ?? "alguien"}${
                puesta?.puesta_en === null || puesta?.puesta_en === undefined
                  ? ""
                  : ` el ${fecha(puesta.puesta_en)}`
              }`
            : haceFalta
              ? "Falta: sin ella la pasarela no se puede encender"
              : "Sin poner"}
        </span>
      </span>
      {/* Con texto, no solo con color (§7i). */}
      <Pastilla tono={estaPuesta ? "bien" : "aviso"}>{estaPuesta ? "Puesta" : "Falta"}</Pastilla>
      {puedeCambiar ? (
        <button
          type="button"
          className={BOTON_FILA}
          onClick={() => abrir({ tipo: "poner", pasarela, modo, credencial })}
        >
          {estaPuesta ? "Cambiar" : "Poner"}
          {/* En la pantalla hay siete botones que dicen «Poner» o «Cambiar»:
              quien navega con lector necesita saber cuál es cuál. */}
          <span className="sr-only">
            {" "}
            {credencial.titulo} de {pasarela.titulo}, {ETIQUETAS_MODO[modo].toLowerCase()}
          </span>
        </button>
      ) : null}
      {puedeCambiar && estaPuesta ? (
        <button
          type="button"
          className={BOTON_FILA}
          onClick={() => abrir({ tipo: "quitar", pasarela, modo, credencial })}
        >
          Quitar
          <span className="sr-only">
            {" "}
            {credencial.titulo} de {pasarela.titulo}, {ETIQUETAS_MODO[modo].toLowerCase()}
          </span>
        </button>
      ) : null}
    </li>
  );
}

function TarjetaDePasarela({
  p,
  puedeCambiar,
  abrir,
}: {
  p: EstadoDePasarela;
  puedeCambiar: boolean;
  abrir: (a: Accion) => void;
}) {
  const conector = CONECTORES[p.pasarela];
  const actual = p.modos.find((m) => m.modo === p.modo);
  const otro = p.modos.find((m) => m.modo === elOtroModo(p.modo));

  return (
    <Tarjeta className={p.incoherente ? "border-accent-edge" : ""}>
      <h2 className="m-0 text-[17px] font-bold">{p.titulo}</h2>

      {/* Lo primero que se lee: encendida o apagada, y en qué modo. Las dos
          cosas con palabras. */}
      <p className="m-0 mt-2 flex flex-wrap gap-2">
        <Pastilla tono={p.encendida ? "bien" : "neutro"}>
          {p.encendida ? "Encendida: se le ofrece a las clientas" : "Apagada"}
        </Pastilla>
        <Pastilla tono={p.modo === "real" ? "aviso" : "neutro"}>{ETIQUETAS_MODO[p.modo]}</Pastilla>
      </p>

      <p className="m-0 mt-2 text-muted">{p.explica}</p>

      {p.incoherente ? (
        <p
          role="alert"
          className="m-0 mt-3 rounded-[12px] border border-accent-edge bg-bg p-3 font-bold"
        >
          Está encendida y no puede cobrar: {p.por_que_no} Apáguela o complétela.
        </p>
      ) : null}

      {p.por_confirmar !== null ? (
        <div className="mt-3 rounded-[12px] border border-line p-3">
          <p className="m-0 font-bold">Todavía no se puede configurar</p>
          <p className="m-0 mt-1 text-muted">{p.por_confirmar}</p>
          <p className="m-0 mt-2 text-[12px] text-muted">
            En cuanto se sepan los nombres exactos de sus credenciales, aparecen aquí solas. Está
            escrito en {p.fuente}.
          </p>
        </div>
      ) : (
        <>
          <h3 className="m-0 mt-4 text-[14px] font-bold uppercase tracking-wide text-muted">
            Credenciales de {ETIQUETAS_MODO[p.modo].toLowerCase()}
          </h3>
          <ul className="m-0 list-none p-0">
            {conector.credenciales.map((c) => (
              <FilaDeCredencial
                key={c.nombre}
                pasarela={p}
                modo={p.modo}
                credencial={c}
                puesta={actual?.credenciales.find((x) => x.nombre === c.nombre)}
                puedeCambiar={puedeCambiar}
                haceFalta={(actual?.faltan ?? []).includes(c.titulo)}
                abrir={abrir}
              />
            ))}
          </ul>

          {/* Qué falta, por su nombre. Nunca «configuración incompleta». */}
          {p.puede_encenderse ? (
            <p className="m-0 mt-3 font-bold">
              {p.encendida ? "Está cobrando." : "Lista para encender."}
            </p>
          ) : (
            <p className="m-0 mt-3 font-bold">{p.por_que_no}</p>
          )}

          {puedeCambiar ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {p.encendida ? (
                <button
                  type="button"
                  className={BOTON_FILA}
                  onClick={() => abrir({ tipo: "apagar", pasarela: p })}
                >
                  Apagar<span className="sr-only"> {p.titulo}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`${BOTON_FILA} ${
                    p.puede_encenderse ? "bg-accent text-accent-fg" : "opacity-50"
                  }`}
                  disabled={!p.puede_encenderse}
                  onClick={() => abrir({ tipo: "encender", pasarela: p })}
                >
                  Encender<span className="sr-only"> {p.titulo}</span>
                </button>
              )}
              <button
                type="button"
                className={BOTON_FILA}
                // Con la pasarela encendida no se cambia de modo: cambiaría en
                // silencio con qué claves se cobra. El servidor lo rechaza
                // igual; esto es para no ofrecer un botón que va a decir no.
                disabled={p.encendida}
                onClick={() => abrir({ tipo: "modo", pasarela: p, a: elOtroModo(p.modo) })}
              >
                Pasar a {ETIQUETAS_MODO[elOtroModo(p.modo)].toLowerCase()}
                <span className="sr-only"> en {p.titulo}</span>
              </button>
            </div>
          ) : null}

          {p.encendida ? (
            <p className="m-0 mt-2 text-[12px] text-muted">
              Para cambiar de modo, apáguela primero: el modo decide con qué claves se cobra.
            </p>
          ) : null}

          {/* El otro juego de credenciales, plegado: se prepara antes de
              cambiar de modo, pero no es lo que se mira todos los días. */}
          <details className="mt-3 rounded-[12px] border border-line p-3">
            <summary className="tactil flex cursor-pointer items-center font-bold">
              Credenciales de {ETIQUETAS_MODO[elOtroModo(p.modo)].toLowerCase()}
              {otro?.completo === true ? " · están todas" : " · falta algo"}
            </summary>
            <ul className="m-0 mt-2 list-none p-0">
              {conector.credenciales.map((c) => (
                <FilaDeCredencial
                  key={c.nombre}
                  pasarela={p}
                  modo={elOtroModo(p.modo)}
                  credencial={c}
                  puesta={otro?.credenciales.find((x) => x.nombre === c.nombre)}
                  puedeCambiar={puedeCambiar}
                  haceFalta={false}
                  abrir={abrir}
                />
              ))}
            </ul>
          </details>

          {p.modo_cambiado_por === null ? null : (
            <p className="m-0 mt-2 text-[12px] text-muted">
              El modo lo puso {p.modo_cambiado_por}
              {p.modo_cambiado_en === null ? "" : ` el ${fecha(p.modo_cambiado_en)}`}.
            </p>
          )}
        </>
      )}
    </Tarjeta>
  );
}

// ---------------------------------------------------------------------------
// La pantalla
// ---------------------------------------------------------------------------

export function Pasarelas() {
  const [accion, setAccion] = useState<Accion | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  // Sube al guardar: es la dependencia que hace que `useCarga` vuelva a pedir.
  // Sin ella la tarjeta seguiría diciendo «Falta» después de poner la
  // credencial, y nadie recarga una página en el teléfono para comprobarlo.
  const [recargas, setRecargas] = useState(0);
  const datos = useCarga<EstadoDeLasPasarelas>("/api/pasarelas", [recargas]);
  const yo = useCarga<Yo>("/api/yo");

  // El permiso que toca es `ajustes`, que hoy solo tiene la dueña. Esconder el
  // botón es una cortesía: el servidor comprueba cada llamada igual.
  const puedeCambiar = yo.fase === "listo" && puedeEditar(yo.datos.usuario.rol, "ajustes");

  return (
    <Carga estado={datos} que="las pasarelas de cobro">
      {(d) => (
        <div className="grid gap-4">
          {hecho === null ? null : (
            <p
              role="status"
              aria-live="polite"
              className="m-0 rounded-[14px] border border-sage-edge bg-surface p-3 font-bold"
            >
              Guardado: {hecho}
            </p>
          )}

          {/* Sin llave maestra no se puede guardar NINGUNA credencial, y eso
              hay que decirlo arriba y entero: es lo primero que explica por qué
              un guardado va a fallar. */}
          {d.llave_maestra_puesta ? null : (
            <Tarjeta className="border-accent-edge">
              <p role="alert" className="m-0 font-bold">
                Falta la llave con la que el sistema guarda las credenciales
              </p>
              <p className="m-0 mt-1 text-muted">{d.llave_maestra_problema}</p>
              <p className="m-0 mt-2 text-[12px] text-muted">
                Hasta que esté puesta no se puede guardar ninguna credencial, y es a propósito: una
                clave de cobro no se guarda sin cifrar.
              </p>
            </Tarjeta>
          )}

          <Tarjeta>
            <p className="m-0 text-muted">
              Aquí se configuran las formas de cobro de la web. Configurar una NO la enciende:
              encenderla es aparte, y se hace cuando usted ya probó un cobro de verdad y su
              reembolso. El pago con comprobante —Yappy Comercial, transferencia, efectivo— no está
              en esta lista porque no se apaga nunca.
            </p>
          </Tarjeta>

          {d.pasarelas.map((p) => (
            <TarjetaDePasarela
              key={p.pasarela}
              p={p}
              puedeCambiar={puedeCambiar}
              abrir={setAccion}
            />
          ))}

          {puedeCambiar ? null : (
            <Tarjeta>
              <p className="m-0 text-muted">
                {yo.fase === "listo"
                  ? "Configurar las pasarelas de cobro es de la dueña."
                  : "Mientras no se sepa quién abrió el panel, esto solo se puede leer."}
              </p>
            </Tarjeta>
          )}

          <Tarjeta>
            <details>
              <summary className="tactil flex cursor-pointer items-center font-bold">
                Lo que se ha cambiado aquí
              </summary>
              {d.libro.length === 0 ? (
                <p className="m-0 mt-2 text-muted">
                  Todavía no se ha configurado ninguna pasarela.
                </p>
              ) : (
                <ul className="m-0 mt-2 list-none p-0">
                  {d.libro.map((l) => (
                    <li key={l.id} className="border-b border-line py-2 last:border-0">
                      <span className="block font-bold">{comoSeLeeLaLinea(l)}</span>
                      <span className="block text-[12px] text-muted">
                        {fecha(l.creado_en)} · {l.actor} · {l.motivo}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="m-0 mt-2 text-[12px] text-muted">
                Este libro no se edita ni se borra, y nunca guarda el valor de una credencial: solo
                cuál se cambió, quién y por qué.
              </p>
            </details>
          </Tarjeta>

          <HojaDeAccion
            accion={accion}
            alCerrar={() => setAccion(null)}
            alGuardar={(que) => {
              setHecho(que);
              setRecargas((n) => n + 1);
            }}
          />
        </div>
      )}
    </Carga>
  );
}
