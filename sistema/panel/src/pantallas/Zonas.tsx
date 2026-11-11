import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, dinero, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";
import { BOTON_SUELTO } from "../formulario";
import {
  EditarZona,
  type BodegaParaZona,
  type EdicionDeZona,
  type ZonaEditable,
} from "./EditarZona";
import { ETIQUETA_METODO, ETIQUETA_REGION } from "../../../src/dominio/zonas";

/**
 * Las zonas de envío: a dónde se entrega y cuánto cuesta.
 *
 * Lo que esta pantalla tiene que dejar claro, y por eso se repite en la
 * tarjeta de arriba y dentro de la hoja: una zona SIN TARIFA no es una zona
 * con envío gratis. Son dos cosas distintas —«todavía no se sabe» y «no se
 * cobra»— y la tabla las enseña distinto a propósito: una pastilla que dice
 * «Se cotiza» frente a un monto de $0.00.
 */

interface ZonaFila extends ZonaEditable {
  bodega_preferida: string | null;
}

export function Zonas() {
  const yo = useOutletContext<Yo>();
  const [recarga, setRecarga] = useState(0);
  const estado = useCarga<{ zonas: ZonaFila[] }>("/api/zonas", [recarga]);
  // Las bodegas, para poder elegir de cuál sale cada zona. Se piden aquí y no
  // dentro de la hoja para que el desplegable no salga vacío el primer
  // segundo, que es cuando la persona va a tocarlo.
  const bodegas = useCarga<{ bodegas: BodegaParaZona[] }>("/api/bodegas", [recarga]);
  const [edicion, setEdicion] = useState<EdicionDeZona | null>(null);

  // La tarifa de envío es una cifra del negocio: la cambia quien cambia los
  // ajustes. La asistente toma pedidos, así que NECESITA ver las zonas, pero
  // no le toca mover una tarifa. El servidor lo comprueba igual.
  const puedeTocar = yo.permisos["ajustes"] === "editar";

  return (
    <Carga estado={estado} que="las zonas de envío">
      {(d) => (
        <div className="grid gap-4">
          <Tarjeta>
            <p className="m-0 text-muted">
              Una zona sin tarifa <strong>no es gratis</strong>: es que se cotiza a mano. El
              sistema no inventa un precio de envío — se lo dice a la clienta y usted le confirma
              el costo. Un envío que de verdad no se cobra lleva una tarifa de $0.00.
              {puedeTocar
                ? " Toque una zona para cambiar su tarifa, sus alias o pausarla."
                : " Su rol puede ver las zonas, pero no cambiar una tarifa."}
            </p>
          </Tarjeta>

          {puedeTocar ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setEdicion({ modo: "nueva" })}
                className={`${BOTON_SUELTO} bg-accent text-accent-fg`}
              >
                Zona nueva
              </button>
            </div>
          ) : null}

          {d.zonas.length === 0 ? (
            <Vacio
              titulo="Todavía no hay zonas"
              detalle="Una zona es un sitio a donde se entrega, con lo que cuesta llevarlo. Los alias son las otras formas de escribir el nombre: con ellos, la clienta encuentra su zona aunque la escriba distinto."
            />
          ) : (
            <Rejilla columnas={["Zona", "Región", "Cómo llega", "Tarifa", "Pago", "Estado"]}>
              {d.zonas.map((z) => (
                <Fila key={z.id}>
                  <Celda etiqueta="">
                    {puedeTocar ? (
                      // El nombre ES el botón: en un teléfono, un lápiz de
                      // 24 px al lado de cada fila se falla con el pulgar.
                      <button
                        type="button"
                        onClick={() => setEdicion({ modo: "editar", zona: z })}
                        className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {z.nombre}
                        {z.alias.length > 0 ? (
                          <span className="block text-[12px] font-normal text-muted">
                            también: {z.alias.join(", ")}
                          </span>
                        ) : null}
                        <span className="sr-only"> — tocar para cambiarla</span>
                      </button>
                    ) : (
                      <>
                        {z.nombre}
                        {z.alias.length > 0 ? (
                          <span className="block text-[12px] font-normal text-muted">
                            también: {z.alias.join(", ")}
                          </span>
                        ) : null}
                      </>
                    )}
                  </Celda>
                  <Celda etiqueta="Región">{ETIQUETA_REGION[z.region]}</Celda>
                  <Celda etiqueta="Cómo llega">
                    {ETIQUETA_METODO[z.metodo]}
                    {z.bodega_preferida ? (
                      <span className="block text-[12px] font-normal text-muted">
                        sale de {z.bodega_preferida}
                      </span>
                    ) : null}
                  </Celda>
                  <Celda etiqueta="Tarifa" papel="clave">
                    {z.tarifa_cents === null ? (
                      <Pastilla tono="neutro">Se cotiza</Pastilla>
                    ) : (
                      <strong>{dinero(z.tarifa_cents)}</strong>
                    )}
                  </Celda>
                  <Celda etiqueta="Pago">
                    {z.requiere_pago_total === 1 || z.metodo === "ferguson" ? (
                      <Pastilla tono="aviso">Completo</Pastilla>
                    ) : (
                      <span className="text-muted">Admite abono</span>
                    )}
                  </Celda>
                  <Celda etiqueta="Estado" papel="estado">
                    {z.activa === 1 ? (
                      <Pastilla tono="bien">Entregando</Pastilla>
                    ) : (
                      <Pastilla tono="neutro">Pausada</Pastilla>
                    )}
                  </Celda>
                </Fila>
              ))}
            </Rejilla>
          )}

          <EditarZona
            edicion={edicion}
            bodegas={bodegas.fase === "listo" ? bodegas.datos.bodegas : []}
            alCerrar={() => setEdicion(null)}
            alGuardar={() => setRecarga((n) => n + 1)}
          />
        </div>
      )}
    </Carga>
  );
}
