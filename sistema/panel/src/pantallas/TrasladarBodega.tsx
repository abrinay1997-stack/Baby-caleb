import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { Aviso, BOTON, Campo, ENTRADA } from "../formulario";
import type { BodegaEditable } from "./EditarBodega";

/**
 * Mover mercancía de una bodega a otra.
 *
 * Es la operación que antes solo sabía hacer el bot: el motor llevaba semanas
 * escrito y probado, y para usarlo había que escribirle por Telegram.
 *
 * Son DOS movimientos —una salida y una entrada— que el servidor escribe en el
 * mismo batch: o salen de una y entran en la otra, o no pasa nada. Nunca queda
 * mercancía existiendo en ninguna parte, y eso no se puede conseguir desde la
 * pantalla, así que aquí no se intenta: se manda una sola llamada.
 *
 * Lo que se mueve es lo LIBRE, no lo físico. Lo apartado está comprometido en
 * un pedido que todavía no sale, y llevárselo dejaría ese pedido sin con qué
 * surtirse desde donde se prometió. La hoja enseña el número libre al lado de
 * cada producto para que eso no sorprenda al guardar.
 */

export interface ExistenciaEnBodega {
  codigo: string;
  nombre: string;
  bodega_id: string;
  bodega: string;
  fisico: number;
  reservado: number;
  libres: number;
}

export function TrasladarBodega({
  abierta,
  bodegas,
  existencias,
  alCerrar,
  alGuardar,
}: {
  abierta: boolean;
  bodegas: BodegaEditable[];
  existencias: ExistenciaEnBodega[];
  alCerrar: () => void;
  alGuardar: () => void;
}) {
  const [desdeId, setDesdeId] = useState("");
  const [haciaId, setHaciaId] = useState("");
  const [codigo, setCodigo] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [estabaAbierta, setEstabaAbierta] = useState(false);

  // Cada vez que se abre, se empieza limpio: si no, la cantidad del traslado
  // anterior se queda escrita y se registra sobre otro producto de un toque.
  if (abierta !== estabaAbierta) {
    setEstabaAbierta(abierta);
    if (abierta) {
      setDesdeId("");
      setHaciaId("");
      setCodigo("");
      setCantidad("");
      setMotivo("");
      setError(null);
    }
  }

  if (!abierta) return null;

  // De una bodega apagada SÍ se puede sacar —es justo como se vacía antes de
  // retirarla— pero a una apagada no se le puede meter nada: ahí la mercancía
  // quedaría escondida, porque ningún pedido se surte de una bodega que no se
  // usa. El servidor lo rechaza igual; esto es para no ofrecerlo.
  const destinos = bodegas.filter((b) => b.activa === 1 && b.id !== desdeId);
  const enElOrigen = existencias.filter((e) => e.bodega_id === desdeId && e.libres > 0);
  const elegido = enElOrigen.find((e) => e.codigo === codigo) ?? null;

  const n = Number(cantidad.trim());
  const cantidadValida = cantidad.trim() !== "" && Number.isSafeInteger(n) && n > 0;
  const enDestino =
    elegido === null
      ? null
      : (existencias.find((e) => e.bodega_id === haciaId && e.codigo === elegido.codigo) ?? null);

  async function guardar() {
    if (desdeId === "") {
      setError("Diga de qué bodega sale.");
      return;
    }
    if (elegido === null) {
      setError("Diga qué producto se mueve.");
      return;
    }
    if (haciaId === "") {
      setError("Diga a qué bodega entra.");
      return;
    }
    if (!cantidadValida) {
      setError("Escriba cuántas unidades, con un número entero mayor que cero.");
      return;
    }
    // Se avisa ANTES de mandar. El servidor lo rechaza igual, pero un mensaje
    // con los dos números explica qué pasa; «no alcanza» manda a contar cajas.
    if (n > elegido.libres) {
      setError(
        `En ${elegido.bodega} hay ${elegido.libres} libres de ${elegido.codigo}${
          elegido.reservado > 0 ? ` (${elegido.reservado} están apartadas en pedidos)` : ""
        }, y usted quiere mover ${n}.`,
      );
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      await pedir("/api/bodegas/traslados", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          codigo: elegido.codigo,
          desdeId,
          haciaId,
          cantidad: n,
          ...(motivo.trim() === "" ? {} : { motivo: motivo.trim() }),
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

  return (
    <Hoja
      abierta
      titulo="Trasladar mercancía"
      alCerrar={alCerrar}
      pie={
        <>
          <button type="button" onClick={alCerrar} className={`${BOTON} border border-line`}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={guardando}
            className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
          >
            {guardando ? "Moviendo…" : "Mover"}
          </button>
        </>
      }
    >
      {error === null ? null : <Aviso>{error}</Aviso>}

      <p className="mt-0 mb-4 text-[13px] text-muted">
        La mercancía sale de una bodega y entra en la otra en la misma operación: o pasan las dos
        cosas, o no pasa ninguna. Queda escrito en el libro con las dos puntas.
      </p>

      <Campo etiqueta="Sale de">
        <select
          className={ENTRADA}
          value={desdeId}
          onChange={(e) => {
            setDesdeId(e.target.value);
            // El producto se limpia al cambiar de origen: lo que hay en una
            // bodega no tiene por qué estar en la otra, y dejarlo escrito
            // mandaría un código que esa bodega no tiene.
            setCodigo("");
            if (e.target.value === haciaId) setHaciaId("");
            setError(null);
          }}
        >
          <option value="">Elija una bodega…</option>
          {bodegas.map((b) => (
            <option key={b.id} value={b.id}>
              {b.nombre}
              {b.activa === 1 ? "" : " (ya no se usa)"}
            </option>
          ))}
        </select>
      </Campo>

      {desdeId === "" ? null : enElOrigen.length === 0 ? (
        <p className="mb-4 mt-0 rounded-[12px] border border-line bg-bg p-3">
          En esa bodega no hay nada libre que mover. Puede que todo lo que tiene esté apartado en
          pedidos sin entregar.
        </p>
      ) : (
        <Campo
          etiqueta="Qué se mueve"
          ayuda="Solo sale lo libre: lo apartado está comprometido en un pedido que no ha salido."
        >
          <select
            className={ENTRADA}
            value={codigo}
            onChange={(e) => {
              setCodigo(e.target.value);
              setError(null);
            }}
          >
            <option value="">Elija un producto…</option>
            {enElOrigen.map((e) => (
              <option key={e.codigo} value={e.codigo}>
                {e.nombre} ({e.codigo}) — {e.libres} libres
              </option>
            ))}
          </select>
        </Campo>
      )}

      <Campo etiqueta="Entra en">
        <select
          className={ENTRADA}
          value={haciaId}
          onChange={(e) => {
            setHaciaId(e.target.value);
            setError(null);
          }}
        >
          <option value="">Elija una bodega…</option>
          {destinos.map((b) => (
            <option key={b.id} value={b.id}>
              {b.nombre}
            </option>
          ))}
        </select>
      </Campo>

      {desdeId !== "" && destinos.length === 0 ? (
        <p className="mb-4 mt-0 rounded-[12px] border border-line bg-bg p-3">
          No hay otra bodega en uso a la que mandarlo. Abra una, o vuelva a poner en uso la que
          necesite: a una bodega apagada no se le puede mandar mercancía, porque de ahí no sale
          ningún pedido.
        </p>
      ) : null}

      <Campo etiqueta="Cuántas unidades">
        <input
          // `inputMode` saca el teclado numérico en el teléfono sin perder los
          // 16 px que evitan el zoom al enfocar (§7b).
          type="text"
          inputMode="numeric"
          className={ENTRADA}
          value={cantidad}
          onChange={(e) => {
            setCantidad(e.target.value.replace(/[^0-9]/g, ""));
            setError(null);
          }}
        />
      </Campo>

      {elegido !== null && cantidadValida && n <= elegido.libres ? (
        <p className="mb-4 mt-[-8px] text-[13px] text-muted">
          Quedarían {elegido.libres - n} libres en {elegido.bodega}
          {enDestino === null ? "" : ` y ${enDestino.libres + n} en ${enDestino.bodega}`}.
        </p>
      ) : null}

      <Campo
        etiqueta="Por qué (opcional)"
        ayuda="Queda escrito en el libro y no se puede borrar después."
      >
        <input
          className={ENTRADA}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Reparto de la semana"
        />
      </Campo>
    </Hoja>
  );
}
