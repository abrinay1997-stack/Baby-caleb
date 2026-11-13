import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { MoverExistencias } from "./MoverExistencias";
import { UMBRAL_POCAS, disponibilidad } from "../../../src/dominio/existencias";

interface Existencia {
  codigo: string;
  nombre: string;
  bodega_id: string;
  bodega: string;
  fisico: number;
  reservado: number;
  libres: number;
  minimo: number | null;
}

/**
 * Las existencias, por variante y bodega.
 *
 * Aquí SÍ se ven los números exactos: es el panel de la dueña y los necesita
 * para reponer. Lo que no sale del sistema es la cifra hacia la clienta o el
 * bot — esos reciben la etiqueta, y se enseña al lado para que se vea qué es lo
 * que ellos están viendo.
 *
 * La etiqueta se calcula con la MISMA función que usa el servidor
 * (`src/dominio/existencias.ts`), no con una copia: dos formas de decidir lo
 * mismo acaban discrepando, y aquí discrepar significa que el panel dice una
 * cosa y el bot le dice otra a la clienta.
 */
export function Existencias() {
  const yo = useOutletContext<Yo>();
  // Cambia al registrar un movimiento, y eso hace que `useCarga` vuelva a
  // pedir la lista: sin esto la pantalla seguiría enseñando el número viejo.
  const [recarga, setRecarga] = useState(0);
  const estado = useCarga<{ existencias: Existencia[] }>("/api/existencias", [recarga]);
  const [moviendo, setMoviendo] = useState<Existencia | null>(null);

  // Mirar cuánto hay es una cosa y cambiarlo es otra: según la matriz de roles
  // solo la dueña mueve inventario. Ofrecer el botón a quien no puede no es
  // amable, es enseñarle a ignorar los errores. El servidor lo comprueba igual.
  const puedeTocar = yo.permisos["precios_y_stock"] === "editar";

  return (
    <Carga estado={estado} que="las existencias">
      {(d) =>
        d.existencias.length === 0 ? (
          <Vacio
            titulo="Todavía no hay existencias"
            detalle="Aparecen aquí en cuanto el catálogo tenga productos. Entonces se toca cada uno y se registra la carga inicial: lo que ya había en la bodega el día que arrancó el sistema."
          />
        ) : (
          <div className="grid gap-4">
            <Tarjeta>
              <p className="m-0 text-muted">
                «Libres» es lo físico menos lo que está comprometido en pedidos sin entregar. Es lo
                que de verdad se puede vender. La columna de la derecha es lo único que ven la web
                y el bot: nunca la cifra.
                {puedeTocar
                  ? " Toque un producto para registrar lo que entró, lo que salió o lo que contó."
                  : " Su rol puede ver las existencias, pero no moverlas."}
              </p>
            </Tarjeta>

            <Rejilla
              columnas={["Producto", "Bodega", "Físico", "Reservado", "Libres", "Lo que se dice"]}
            >
              {d.existencias.map((e) => (
                <Fila key={`${e.codigo}-${e.bodega_id}`}>
                  <Celda etiqueta="">
                    {puedeTocar ? (
                      // El nombre ES el botón: en un teléfono, un lápiz de
                      // 24 px al lado de cada fila se falla con el pulgar.
                      <button
                        type="button"
                        onClick={() => setMoviendo(e)}
                        className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {e.nombre}
                        <span className="block text-[12px] font-normal text-muted">{e.codigo}</span>
                        <span className="sr-only"> — tocar para registrar un movimiento</span>
                      </button>
                    ) : (
                      <>
                        {e.nombre}
                        <span className="block text-[12px] font-normal text-muted">{e.codigo}</span>
                      </>
                    )}
                  </Celda>
                  <Celda etiqueta="Bodega">{e.bodega}</Celda>
                  <Celda etiqueta="Físico">{e.fisico}</Celda>
                  <Celda etiqueta="Reservado" className="text-muted">
                    {e.reservado}
                  </Celda>
                  <Celda etiqueta="Libres" papel="clave">
                    <strong>{e.libres}</strong>
                    {/* «mínimo 6» y no «por debajo del mínimo (6)»: en el
                        teléfono la celda clave tiene hasta el 40 % de la fila
                        —el resto es para el nombre, que dice de qué es la
                        cifra—, y la frase larga le robaba dos renglones al
                        nombre del producto. Solo aparece cuando SE ESTÁ por
                        debajo, así que las cuatro palabras no decían nada que
                        el número grande de encima no diga ya. */}
                    {e.minimo !== null && e.libres <= e.minimo ? (
                      <span className="block text-[12px] font-normal text-muted">
                        mínimo {e.minimo}
                      </span>
                    ) : null}
                  </Celda>
                  <Celda etiqueta="Lo que se dice" papel="estado">
                    {(() => {
                      const etiqueta = disponibilidad(e.libres, UMBRAL_POCAS);
                      return etiqueta === "disponible" ? (
                        <Pastilla tono="bien">Disponible</Pastilla>
                      ) : etiqueta === "pocas" ? (
                        <Pastilla tono="aviso">Quedan pocas</Pastilla>
                      ) : (
                        <Pastilla tono="mal">Agotado</Pastilla>
                      );
                    })()}
                  </Celda>
                </Fila>
              ))}
            </Rejilla>

            <MoverExistencias
              fila={moviendo}
              alCerrar={() => setMoviendo(null)}
              alGuardar={() => setRecarga((n) => n + 1)}
            />
          </div>
        )
      }
    </Carga>
  );
}
