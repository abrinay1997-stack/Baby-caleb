import { useEffect, useState } from "react";
import { pedir } from "../api";
import { aCentavos } from "../dinero";
import { Hoja } from "../armazon/Hoja";

/**
 * Registrar un movimiento de inventario.
 *
 * Aquí NO se escribe «ahora hay 40». El inventario es un libro: se registra lo
 * que entró o lo que salió, y la existencia es la suma. La base lo defiende con
 * un trigger que prohíbe editar un movimiento y otro que prohíbe borrarlo, así
 * que una pantalla que ofreciera escribir el número directo estaría ofreciendo
 * algo que el sistema no puede hacer.
 *
 * Lo más parecido es CONTAR, que sí pregunta «¿cuántas hay?» y guarda la
 * diferencia. Y es la operación más segura de las seis: el servidor exige que
 * el resultado sea exactamente lo contado, así que si entró una venta mientras
 * la dueña contaba, no se escribe nada y se vuelve a contar.
 *
 * Los nombres de aquí son los de la dueña, no los del esquema: ella dice «se
 * me dañó una caja», no «un movimiento de tipo merma». La traducción vive en
 * esta tabla y en ningún otro sitio.
 */

interface Operacion {
  /** Lo que ve la dueña. */
  readonly nombre: string;
  /** El `tipo` del esquema. */
  readonly tipo: string;
  /** 1 entra, −1 sale, 0 es un conteo (se manda el total, no la diferencia). */
  readonly signo: 1 | -1 | 0;
  /** El esquema obliga a justificar estas. Se pide ANTES de dejar guardar. */
  readonly pideMotivo: boolean;
  readonly ayuda: string;
}

const OPERACIONES: readonly Operacion[] = [
  {
    nombre: "Entró mercancía",
    tipo: "compra",
    signo: 1,
    pideMotivo: false,
    ayuda: "Llegó del proveedor y ya está en la bodega.",
  },
  {
    nombre: "Carga inicial",
    tipo: "apertura",
    signo: 1,
    pideMotivo: false,
    ayuda: "Lo que ya había el día que arrancó el sistema. Se usa una sola vez por producto.",
  },
  {
    nombre: "Conté el estante",
    tipo: "conteo",
    signo: 0,
    pideMotivo: true,
    ayuda: "Diga cuántas hay de verdad. El sistema guarda la diferencia, no el número.",
  },
  {
    nombre: "Devolución de una clienta",
    tipo: "devolucion",
    signo: 1,
    pideMotivo: false,
    ayuda: "Volvió a la bodega y se puede vender.",
  },
  {
    nombre: "Se dañó o se perdió",
    tipo: "merma",
    signo: -1,
    pideMotivo: true,
    ayuda: "Sale del inventario y no se vendió.",
  },
  {
    nombre: "Regalo o muestra",
    tipo: "regalo",
    signo: -1,
    pideMotivo: true,
    ayuda: "Salió sin cobrarse.",
  },
];

export interface FilaDeExistencia {
  codigo: string;
  nombre: string;
  bodega_id: string;
  bodega: string;
  fisico: number;
  reservado: number;
}

export function MoverExistencias({
  fila,
  alCerrar,
  alGuardar,
}: {
  fila: FilaDeExistencia | null;
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [op, setOp] = useState<Operacion>(OPERACIONES[0] as Operacion);
  const [cantidad, setCantidad] = useState("");
  const [motivo, setMotivo] = useState("");
  const [costo, setCosto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Cada vez que se abre con otra fila, se empieza limpio: si no, la cantidad
  // de la caja anterior se queda escrita y se registra sobre el producto
  // equivocado de un toque.
  useEffect(() => {
    if (fila === null) return;
    setOp(OPERACIONES[0] as Operacion);
    setCantidad("");
    setMotivo("");
    setCosto("");
    setError(null);
  }, [fila]);

  if (fila === null) return null;

  const n = Number(cantidad.trim());
  // El costo solo tiene sentido cuando ENTRA mercancía: en una salida lo
  // decide el promedio, no quien la registra, y el servidor rechaza con
  // mensaje un costo en una salida.
  const pideCosto = op.signo === 1;
  const costoCents = costo.trim() === "" ? null : aCentavos(costo);
  const cantidadValida = cantidad.trim() !== "" && Number.isInteger(n) && n >= 0;
  const quedaria = op.signo === 0 ? n : fila.fisico + op.signo * n;

  async function guardar() {
    if (fila === null) return;
    if (!cantidadValida) {
      setError("Escriba cuántas unidades, con un número entero.");
      return;
    }
    if (op.signo !== 0 && n === 0) {
      setError("Un movimiento de cero unidades no registra nada.");
      return;
    }
    if (op.pideMotivo && motivo.trim() === "") {
      setError("Esta operación necesita que diga por qué. Queda escrito en el libro.");
      return;
    }
    // Se avisa ANTES de mandar: el servidor también lo rechaza, pero un
    // mensaje que explica qué pasa es mejor que uno que diga «no alcanza».
    if (op.signo === -1 && fila.fisico - n < fila.reservado) {
      setError(
        `No se puede: quedarían ${fila.fisico - n} y hay ${fila.reservado} comprometidas en pedidos sin entregar.`,
      );
      return;
    }

    if (pideCosto && costo.trim() !== "" && (costoCents === null || costoCents < 0)) {
      setError("El costo no se entiende. Escríbalo como 2.50");
      return;
    }

    setError(null);
    setGuardando(true);
    try {
      await pedir("/api/existencias/movimientos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tipo: op.tipo,
          ...(motivo.trim() === "" ? {} : { motivo: motivo.trim() }),
          lineas: [
            {
              codigo: fila.codigo,
              bodegaId: fila.bodega_id,
              ...(op.signo === 0 ? { contado: n } : { delta: op.signo * n }),
              // Solo si se escribió. Mandar 0 por omisión diría que la
              // mercancía fue gratis y pondría el margen en 100 % (trampa §7):
              // «no lo sé» y «costó cero» son cosas distintas.
              ...(pideCosto && costoCents !== null ? { costoUnitCents: costoCents } : {}),
            },
          ],
        }),
      });
      alGuardar();
      alCerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  const etiquetaCantidad =
    op.signo === 0 ? "¿Cuántas hay en el estante?" : op.signo === 1 ? "¿Cuántas entraron?" : "¿Cuántas salieron?";

  return (
    <Hoja
      abierta={fila !== null}
      titulo={fila.nombre}
      alCerrar={alCerrar}
      pie={
        <button
          type="button"
          onClick={guardar}
          disabled={guardando}
          className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg disabled:opacity-60 focus-visible:outline-accent-edge focus-visible:outline-2"
        >
          {guardando ? "Registrando…" : "Registrar"}
        </button>
      }
    >
      <div className="grid gap-4">
        <p className="m-0 text-[13px] text-muted">
          {fila.bodega} · hay <strong className="text-fg">{fila.fisico}</strong>
          {fila.reservado > 0 ? `, ${fila.reservado} comprometidas en pedidos` : ""}
        </p>

        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] font-bold">¿Qué pasó?</legend>
          <div className="grid gap-2">
            {OPERACIONES.map((o) => (
              <label
                key={o.tipo}
                className={`tactil flex cursor-pointer items-start gap-3 rounded-[12px] border p-3 ${
                  op.tipo === o.tipo ? "border-accent bg-surface" : "border-line"
                }`}
              >
                <input
                  type="radio"
                  name="operacion"
                  checked={op.tipo === o.tipo}
                  onChange={() => {
                    setOp(o);
                    setError(null);
                  }}
                  className="mt-1"
                />
                <span className="block">
                  <span className="block font-bold">{o.nombre}</span>
                  <span className="block text-[13px] font-normal text-muted">{o.ayuda}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1 block text-[13px] font-bold">{etiquetaCantidad}</span>
          <input
            // `inputMode` saca el teclado numérico en el teléfono sin perder el
            // 16 px que evita el zoom al enfocar (§7 del sistema de diseño).
            type="text"
            inputMode="numeric"
            value={cantidad}
            onChange={(e) => {
              setCantidad(e.target.value.replace(/[^0-9]/g, ""));
              setError(null);
            }}
            className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
          />
          {cantidadValida ? (
            <span className="mt-1 block text-[13px] text-muted">
              {op.signo === 0 && quedaria === fila.fisico
                ? "Cuadra con lo que dice el sistema: no se registra nada."
                : `Quedarían ${quedaria}.`}
            </span>
          ) : null}
        </label>

        {pideCosto ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-bold">
              ¿Cuánto costó cada unidad?
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={costo}
              onChange={(e) => {
                setCosto(e.target.value.replace(/[^0-9.,]/g, ""));
                setError(null);
              }}
              placeholder="2.50"
              className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
            />
            <span className="mt-1 block text-[13px] text-muted">
              {costo.trim() === ""
                ? "Puede dejarlo vacío, pero entonces la ganancia de lo que se venda de este producto no se va a poder calcular."
                : costoCents === null
                  ? "No se entiende. Escríbalo como 2.50"
                  : `Entran ${cantidadValida ? n : 0} a ese costo. Es lo que paga usted, no lo que cobra.`}
            </span>
          </label>
        ) : null}

        {op.pideMotivo ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-bold">¿Por qué?</span>
            <input
              type="text"
              value={motivo}
              onChange={(e) => {
                setMotivo(e.target.value);
                setError(null);
              }}
              placeholder="Se mojó una caja en la bodega"
              className="tactil w-full rounded-[10px] border border-line bg-bg px-3 py-2 text-[16px] text-fg focus-visible:outline-accent-edge focus-visible:outline-2"
            />
            <span className="mt-1 block text-[13px] text-muted">
              Queda escrito en el libro y no se puede borrar después.
            </span>
          </label>
        ) : null}

        {error === null ? null : (
          <p role="alert" className="m-0 rounded-[10px] bg-surface p-3 text-[14px] text-fg">
            {error}
          </p>
        )}
      </div>
    </Hoja>
  );
}
