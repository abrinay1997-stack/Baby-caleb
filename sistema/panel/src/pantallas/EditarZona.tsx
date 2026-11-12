import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { aCentavos, deCentavos } from "../dinero";
import { Aviso, BOTON, Campo, ENTRADA, Grupo, Opcion } from "../formulario";
import {
  ETIQUETA_METODO,
  ETIQUETA_REGION,
  METODOS,
  REGIONES,
  type Metodo,
  type Region,
} from "../../../src/dominio/zonas";

/**
 * Crear o cambiar una zona de envío.
 *
 * ## La tarifa vacía NO es cero
 *
 * Es lo que define esta hoja. `tarifa_cents` admite nulo y significa **se
 * cotiza a mano**: son las del interior, donde el costo depende de la
 * encomienda y nadie lo sabe hasta preguntarlo. Cero significa otra cosa muy
 * distinta: que el envío no se cobra.
 *
 * Un campo de texto vacío no distingue las dos. Por eso aquí se pregunta con
 * palabras —dos opciones que se eligen— y el número solo aparece cuando se ha
 * dicho que hay tarifa fija. Un cero es una afirmación; «no se sabe» es otra, y
 * escribir la primera cuando se quería la segunda regala el envío de cada
 * pedido del interior sin que nada falle.
 *
 * Las regiones y los métodos salen de `src/dominio/zonas.ts`, que es la misma
 * lista que valida el servidor y la misma del CHECK de la tabla. Teclearlas
 * aquí sería una tercera copia, y las copias discrepan.
 */

export interface ZonaEditable {
  id: string;
  nombre: string;
  alias: string[];
  region: Region;
  metodo: Metodo;
  tarifa_cents: number | null;
  requiere_pago_total: number;
  activa: number;
  bodega_preferida_id: string | null;
}

export interface BodegaParaZona {
  id: string;
  nombre: string;
  activa: number;
}

export type EdicionDeZona = { modo: "nueva" } | { modo: "editar"; zona: ZonaEditable };

type FormaDeCobrar = "fija" | "a_mano";

export function EditarZona({
  edicion,
  bodegas,
  alCerrar,
  alGuardar,
}: {
  edicion: EdicionDeZona | null;
  bodegas: BodegaParaZona[];
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [alias, setAlias] = useState("");
  const [region, setRegion] = useState<Region>("ciudad");
  const [metodo, setMetodo] = useState<Metodo>("motorizado");
  const [forma, setForma] = useState<FormaDeCobrar>("fija");
  const [tarifa, setTarifa] = useState("");
  const [pagoTotal, setPagoTotal] = useState(false);
  const [bodegaId, setBodegaId] = useState("");
  const [entregando, setEntregando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cargado, setCargado] = useState<string | null>(null);

  const llave = edicion === null ? null : edicion.modo === "nueva" ? "nueva" : edicion.zona.id;
  if (edicion !== null && cargado !== llave) {
    setCargado(llave);
    const z = edicion.modo === "editar" ? edicion.zona : null;
    setNombre(z?.nombre ?? "");
    // Uno por línea y no separados por comas: un alias puede llevar coma
    // («Juan Díaz, frente a la escuela») y partirlo por ahí crearía dos.
    setAlias((z?.alias ?? []).join("\n"));
    setRegion(z?.region ?? "ciudad");
    setMetodo(z?.metodo ?? "motorizado");
    setForma(z === null || z.tarifa_cents !== null ? "fija" : "a_mano");
    setTarifa(z === null || z.tarifa_cents === null ? "" : deCentavos(z.tarifa_cents));
    setPagoTotal(z?.requiere_pago_total === 1);
    setBodegaId(z?.bodega_preferida_id ?? "");
    setEntregando(z === null ? true : z.activa === 1);
    setError(null);
  }

  if (edicion === null) return null;

  const zona = edicion.modo === "editar" ? edicion.zona : null;

  const cerrar = () => {
    setCargado(null);
    setError(null);
    alCerrar();
  };

  async function guardar() {
    const limpio = nombre.trim();
    if (limpio === "") {
      setError("La zona necesita un nombre: es lo que la clienta elige al pedir.");
      return;
    }

    let tarifaCents: number | null = null;
    if (forma === "fija") {
      tarifaCents = aCentavos(tarifa);
      if (tarifaCents === null) {
        setError(
          "La tarifa no se entiende. Escríbala como 3.50. Si el envío no se cobra, escriba 0.00.",
        );
        return;
      }
    }

    const listaDeAlias = alias
      .split("\n")
      .map((a) => a.trim())
      .filter((a) => a !== "");

    const cuerpo = {
      nombre: limpio,
      alias: listaDeAlias,
      region,
      metodo,
      // `null` viaja de verdad: es «se cotiza a mano», no «déjala como
      // estaba». El servidor mira si la clave vino, no si trae valor.
      tarifaCents,
      requierePagoTotal: pagoTotal,
      bodegaPreferidaId: bodegaId === "" ? null : bodegaId,
      activa: entregando,
    };

    setGuardando(true);
    setError(null);
    try {
      await pedir(zona === null ? "/api/zonas" : `/api/zonas/${encodeURIComponent(zona.id)}`, {
        method: zona === null ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      alGuardar();
      cerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  const centavos = forma === "fija" ? aCentavos(tarifa) : null;

  return (
    <Hoja
      abierta
      titulo={zona === null ? "Zona nueva" : zona.nombre}
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
      {error === null ? null : <Aviso>{error}</Aviso>}

      <Campo etiqueta="Nombre" ayuda="Como la elige la clienta al pedir. Por ejemplo: Tocumen.">
        <input
          className={ENTRADA}
          value={nombre}
          onChange={(e) => {
            setNombre(e.target.value);
            setError(null);
          }}
        />
      </Campo>

      <Campo
        etiqueta="Otras formas de escribirla"
        ayuda="Una por línea. Con ellas la clienta encuentra su zona aunque la escriba sin tildes o con otro nombre del barrio."
      >
        <textarea
          // `rows` y no una altura mínima en píxeles: con una altura fija, la
          // caja corta la tercera línea por la mitad y parece una palabra
          // partida en vez de una lista que sigue. Con `rows` el alto sale de
          // la letra, así que siempre se ven líneas enteras.
          rows={3}
          className={ENTRADA}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder={"doce de octubre\n12 de oct"}
        />
      </Campo>

      <Grupo pregunta="¿Dónde queda?">
        {REGIONES.map((r) => (
          <Opcion
            key={r}
            nombre="region-de-zona"
            marcada={region === r}
            alElegir={() => {
              setRegion(r);
              setError(null);
            }}
            titulo={ETIQUETA_REGION[r]}
          />
        ))}
      </Grupo>

      <Grupo pregunta="¿Cómo llega el pedido?">
        {METODOS.map((m) => (
          <Opcion
            key={m}
            nombre="metodo-de-zona"
            marcada={metodo === m}
            alElegir={() => {
              setMetodo(m);
              setError(null);
            }}
            titulo={ETIQUETA_METODO[m]}
            {...(m === "ferguson"
              ? { ayuda: "Por encomienda. Estas zonas se cobran completas antes de enviar." }
              : {})}
          />
        ))}
      </Grupo>

      <Grupo
        pregunta="¿Cuánto cuesta el envío?"
        ayuda="Son dos cosas distintas, y la diferencia importa: un envío gratis es una tarifa de 0.00, no una zona sin tarifa."
      >
        <Opcion
          nombre="forma-de-cobrar"
          marcada={forma === "fija"}
          alElegir={() => {
            setForma("fija");
            setError(null);
          }}
          titulo="Tarifa fija"
          ayuda="Siempre cuesta lo mismo. Escriba 0.00 si el envío no se cobra."
        />
        <Opcion
          nombre="forma-de-cobrar"
          marcada={forma === "a_mano"}
          alElegir={() => {
            setForma("a_mano");
            setError(null);
          }}
          titulo="Se cotiza a mano"
          ayuda="Todavía no se sabe cuánto cuesta. El sistema no inventa un precio: se lo dice a la clienta y usted le confirma el costo."
        />
      </Grupo>

      {forma === "fija" ? (
        <Campo etiqueta="Tarifa">
          <input
            className={ENTRADA}
            inputMode="decimal"
            value={tarifa}
            onChange={(e) => {
              setTarifa(e.target.value);
              setError(null);
            }}
            placeholder="3.50"
          />
          {centavos === 0 ? (
            <span className="mt-1 block text-[13px] font-bold">
              A esta zona el envío le sale gratis: la clienta no paga nada por el envío.
            </span>
          ) : null}
        </Campo>
      ) : null}

      <Grupo pregunta="¿Se puede abonar, o hay que pagar completo?">
        <Opcion
          nombre="pago-de-zona"
          marcada={!pagoTotal}
          alElegir={() => setPagoTotal(false)}
          titulo="Admite abono"
          ayuda="La clienta aparta con el abono mínimo y paga el resto al recibir."
        />
        <Opcion
          nombre="pago-de-zona"
          marcada={pagoTotal}
          alElegir={() => setPagoTotal(true)}
          titulo="Completo antes de enviar"
        />
      </Grupo>

      {metodo === "ferguson" && !pagoTotal ? (
        // Ferguson exige pago total aunque la casilla diga otra cosa: lo
        // decide `exigePagoTotal` en el servidor. Decirlo aquí evita que
        // alguien crea que lo dejó en «admite abono» y se encuentre con otra.
        <p className="mb-4 mt-[-8px] text-[13px] text-muted">
          Aunque aquí diga que admite abono, los pedidos por Ferguson se cobran completos: lo pide
          la encomienda, no esta casilla.
        </p>
      ) : null}

      <Campo
        etiqueta="Sale de"
        ayuda="La bodega desde la que normalmente se surte esta zona. Se puede cambiar en cada pedido."
      >
        <select
          className={ENTRADA}
          value={bodegaId}
          onChange={(e) => {
            setBodegaId(e.target.value);
            setError(null);
          }}
        >
          <option value="">Sin preferencia</option>
          {bodegas
            .filter((b) => b.activa === 1 || b.id === bodegaId)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.nombre}
              </option>
            ))}
        </select>
      </Campo>

      <Grupo pregunta="¿Se está entregando ahí?">
        <Opcion
          nombre="estado-de-zona"
          marcada={entregando}
          alElegir={() => setEntregando(true)}
          titulo="Entregando"
        />
        <Opcion
          nombre="estado-de-zona"
          marcada={!entregando}
          alElegir={() => setEntregando(false)}
          titulo="Pausada"
          ayuda="Deja de salir en la lista del checkout y el bot no la cotiza. Los pedidos que ya estaban no se tocan."
        />
      </Grupo>
    </Hoja>
  );
}
