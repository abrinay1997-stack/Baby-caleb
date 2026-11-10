import { useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
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
  const estado = useCarga<{ existencias: Existencia[] }>("/api/existencias");

  return (
    <Carga estado={estado} que="las existencias">
      {(d) =>
        d.existencias.length === 0 ? (
          <Vacio
            titulo="Todavía no hay existencias"
            detalle="Se cargan en F3.1, con un movimiento de apertura por bodega. A partir de ahí, cada entrada y cada salida deja su movimiento y el número de aquí sale de ellos."
          />
        ) : (
          <div className="grid gap-4">
            <Tarjeta>
              <p className="m-0 text-muted">
                «Libres» es lo físico menos lo que está comprometido en pedidos sin entregar. Es lo
                que de verdad se puede vender. La columna de la derecha es lo único que ven la web
                y el bot: nunca la cifra.
              </p>
            </Tarjeta>

            <Rejilla
              columnas={["Producto", "Bodega", "Físico", "Reservado", "Libres", "Lo que se dice"]}
            >
              {d.existencias.map((e) => (
                <Fila key={`${e.codigo}-${e.bodega_id}`}>
                  <Celda etiqueta="">
                    {e.nombre}
                    <span className="block text-[12px] font-normal text-muted">{e.codigo}</span>
                  </Celda>
                  <Celda etiqueta="Bodega">{e.bodega}</Celda>
                  <Celda etiqueta="Físico">{e.fisico}</Celda>
                  <Celda etiqueta="Reservado" className="text-muted">
                    {e.reservado}
                  </Celda>
                  <Celda etiqueta="Libres">
                    <strong>{e.libres}</strong>
                    {e.minimo !== null && e.libres <= e.minimo ? (
                      <span className="block text-[12px] font-normal text-muted">
                        por debajo del mínimo ({e.minimo})
                      </span>
                    ) : null}
                  </Celda>
                  <Celda etiqueta="Lo que se dice">
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
          </div>
        )
      }
    </Carga>
  );
}
