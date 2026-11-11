import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { BOTON_SUELTO } from "../formulario";
import { EditarBodega, type BodegaEditable, type EdicionDeBodega } from "./EditarBodega";
import { TrasladarBodega, type ExistenciaEnBodega } from "./TrasladarBodega";

/**
 * Las bodegas: dónde se guarda la mercancía.
 *
 * Hasta hace poco esta pantalla solo leía. Lo que faltaba no era un botón de
 * borrar —una bodega no se borra, y aquí se explica por qué— sino las tres
 * cosas que la dueña sí hace: abrir una bodega, corregirle el nombre y, sobre
 * todo, MOVER MERCANCÍA de una a otra.
 *
 * Las existencias se piden aquí y no dentro de la hoja del traslado porque la
 * hoja necesita saber qué hay libre en cada bodega para poder ofrecerlo, y
 * pedirlas al abrirla dejaría el desplegable vacío el primer segundo, que es
 * justo cuando la persona va a tocarlo.
 */

export function Bodegas() {
  const yo = useOutletContext<Yo>();
  // Cambia al guardar, y eso hace que las dos cargas vuelvan a pedir: sin
  // esto la pantalla seguiría enseñando los números de antes del traslado.
  const [recarga, setRecarga] = useState(0);
  const estado = useCarga<{ bodegas: BodegaEditable[] }>("/api/bodegas", [recarga]);
  const existencias = useCarga<{ existencias: ExistenciaEnBodega[] }>("/api/existencias", [
    recarga,
  ]);
  const [edicion, setEdicion] = useState<EdicionDeBodega | null>(null);
  const [trasladando, setTrasladando] = useState(false);

  // Mirar dónde se guarda la mercancía es una cosa y moverla es otra: según la
  // matriz de roles solo la dueña toca el inventario. Ofrecer el botón a quien
  // no puede no es amable, es enseñarle a ignorar los errores. El servidor lo
  // comprueba igual.
  const puedeTocar = yo.permisos["precios_y_stock"] === "editar";

  const refrescar = () => setRecarga((n) => n + 1);

  return (
    <Carga estado={estado} que="las bodegas">
      {(d) => (
        <div className="grid gap-4">
          <Tarjeta>
            <p className="m-0 text-muted">
              Una bodega <strong>no se borra nunca</strong>: aparece en cada movimiento de
              inventario que pasó por ella, y esos movimientos son lo que explica de dónde salió
              cada caja. Lo que se hace es dejar de usarla, y entonces ningún pedido sale de ahí.
              {puedeTocar
                ? " Toque una bodega para cambiarle el nombre o dejar de usarla."
                : " Su rol puede ver las bodegas, pero no cambiarlas."}
            </p>
          </Tarjeta>

          {puedeTocar ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setEdicion({ modo: "nueva" })}
                className={`${BOTON_SUELTO} border border-line`}
              >
                Bodega nueva
              </button>
              <button
                type="button"
                onClick={() => setTrasladando(true)}
                disabled={d.bodegas.length < 2}
                className={`${BOTON_SUELTO} bg-accent text-accent-fg disabled:opacity-50`}
              >
                Trasladar mercancía
              </button>
            </div>
          ) : null}

          {d.bodegas.length === 0 ? (
            <Vacio
              titulo="Todavía no hay bodegas"
              detalle="Una bodega es un sitio donde se guarda la mercancía: la casa, el local, el cuarto de la feria. Sin al menos una, el sistema no tiene dónde contar lo que hay."
            />
          ) : (
            <Rejilla columnas={["Bodega", "Productos", "Unidades", "Estado"]}>
              {d.bodegas.map((b) => (
                <Fila key={b.id}>
                  <Celda etiqueta="">
                    {puedeTocar ? (
                      // El nombre ES el botón: en un teléfono, un lápiz de
                      // 24 px al lado de cada fila se falla con el pulgar.
                      <button
                        type="button"
                        onClick={() => setEdicion({ modo: "editar", bodega: b })}
                        className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {b.nombre}
                        <span className="sr-only"> — tocar para cambiarla</span>
                      </button>
                    ) : (
                      b.nombre
                    )}
                  </Celda>
                  <Celda etiqueta="Productos">{b.variantes}</Celda>
                  <Celda etiqueta="Unidades" papel="clave">
                    <strong>{b.unidades}</strong>
                    {/* En el teléfono la cifra clave va sin etiqueta, pegada
                        al título, y aquí le queda al lado «Productos 96»: dos
                        números seguidos que se leen como uno. La palabra
                        debajo los separa. Salió mirando la captura, no las
                        medidas: de alto estaba perfecto. */}
                    <span className="block text-[12px] font-normal text-muted">
                      {b.unidades === 1 ? "unidad" : "unidades"}
                    </span>
                  </Celda>
                  <Celda etiqueta="Estado" papel="estado">
                    {b.activa === 1 ? (
                      <Pastilla tono="bien">En uso</Pastilla>
                    ) : (
                      <Pastilla tono="neutro">Ya no se usa</Pastilla>
                    )}
                  </Celda>
                </Fila>
              ))}
            </Rejilla>
          )}

          <EditarBodega edicion={edicion} alCerrar={() => setEdicion(null)} alGuardar={refrescar} />

          <TrasladarBodega
            abierta={trasladando}
            bodegas={d.bodegas}
            // Si las existencias no cargaron, la hoja se abre sin productos y
            // lo dice. Es mejor que no poder abrirla: el resto de la pantalla
            // sigue sirviendo.
            existencias={existencias.fase === "listo" ? existencias.datos.existencias : []}
            alCerrar={() => setTrasladando(false)}
            alGuardar={refrescar}
          />
        </div>
      )}
    </Carga>
  );
}
