import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, dinero, useCarga } from "../api";
import { EditarVariante, type VarianteEditable } from "./EditarVariante";
import { NuevoProducto } from "./NuevoProducto";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";

interface Variante {
  codigo: string;
  producto: string;
  familia: string;
  nombre: string;
  talla: string | null;
  unidades_por_caja: number;
  precio_cents: number;
  tasa_itbms_bp: number | null;
  publicado: number;
  /**
   * Si una clienta la ve AHORA en babycaleb.com, y si no, por qué.
   *
   * No sale de la base: lo decide `src/tienda/fichas.ts` mirando las fichas de
   * `content.json`, que es donde viven la descripción, la foto y el texto de
   * venta. Un producto recién creado tiene precio y existencia pero no tiene
   * ficha, así que la tienda no lo sabe pintar.
   */
  saleEnLaTienda?: boolean;
  porQueNoSale?: string | null;
  activo: number;
  version: number;
  imagen: string | null;
  es_combo: number;
  /** El botón de WhatsApp en este artículo. `null` = lo que diga Ajustes. */
  pedir_por_whatsapp: number | null;
  costo_unidades?: number | null;
  costo_valor_cents?: number | null;
}

interface DatosCatalogo {
  variantes: Variante[];
  /** El servidor decide si manda el costo; la pantalla solo lo enseña si vino. */
  muestraCosto: boolean;
}

/** Costo promedio = valor / unidades. Sin unidades no hay promedio, y no se inventa. */
function costoPromedio(v: Variante): string {
  if (!v.costo_unidades || v.costo_unidades <= 0 || v.costo_valor_cents == null) return "—";
  return dinero(Math.round(v.costo_valor_cents / v.costo_unidades));
}

export function Catalogo() {
  const yo = useOutletContext<Yo>();
  // Cambia al guardar, y eso hace que `useCarga` vuelva a pedir la lista: sin
  // esto, la pantalla seguiría enseñando el precio viejo después de cambiarlo.
  const [recarga, setRecarga] = useState(0);
  const estado = useCarga<DatosCatalogo>("/api/catalogo", [recarga]);
  const [editando, setEditando] = useState<VarianteEditable | null>(null);
  const [creando, setCreando] = useState(false);

  // Ofrecer el botón a quien no puede no es amable, es enseñarle a ignorar los
  // errores. Quien sí puede lo comprueba igual el servidor.
  const puedeTocar = yo.permisos["precios_y_stock"] === "editar";

  return (
    <Carga estado={estado} que="el catálogo">
      {(d) =>
        d.variantes.length === 0 ? (
          <Vacio
            titulo="El catálogo todavía está vacío"
            detalle="Se llena en la carga inicial (F3.1), con los productos que hoy están en el CRM. A partir de ese momento, el precio que se ponga aquí es el que ve la web."
          />
        ) : (
          <div className="grid gap-4">
            <Tarjeta>
              {/*
                Este aviso decía «la web y el bot lo preguntan aquí, así que
                cambiarlo aquí lo cambia en los TRES sitios sin publicar nada».
                Las dos mitades eran falsas, y la dueña las lee justo donde iba
                a actuar:

                - El bot NO pregunta aquí. Hoy lee su propia base, y por eso
                  llegó a cobrar $20 por una caja que la web vende a $25.
                - Y «sin publicar nada» solo vale para el PRECIO de un producto
                  que ya esté en la tienda. Qué productos enseña la tienda lo
                  decide una lista escrita a mano en el repositorio, así que un
                  producto nuevo sale aquí con su pastilla verde «En la web» y
                  no aparece en la tienda hasta que alguien toque esa lista.

                Decirle a alguien que algo se cambió en tres sitios cuando se
                cambió en uno es peor que no decirle nada: deja de comprobarlo.
                Así que el aviso dice lo que es verdad hoy, con el nombre del
                guion que lo vigila para que se pueda comprobar sin creerme.
              */}
              <p className="m-0 text-muted">
                Este es el único lugar donde vive el precio, y la tienda lo pregunta aquí: cambiarlo
                aquí lo cambia en la web sin publicar nada. El bot de WhatsApp todavía no:
                lee su propia copia, así que un precio cambiado aquí hay que cambiarlo también
                allá hasta que se conecten. Y un producto NUEVO no sale solo en la tienda aunque
                diga «En la web»: avísele a Juan para que lo añada.
                {d.muestraCosto ? null : " Su rol no ve el costo ni el margen."}
              </p>
            </Tarjeta>

            {puedeTocar ? (
              <button
                type="button"
                onClick={() => setCreando(true)}
                className="tactil w-full rounded-[14px] bg-accent px-4 py-3 font-bold text-accent-fg focus-visible:outline-accent-edge focus-visible:outline-2 md:w-auto md:justify-self-start"
              >
                + Producto nuevo
              </button>
            ) : null}

            <Rejilla
              columnas={
                d.muestraCosto
                  ? ["Producto", "Talla", "Por caja", "Precio", "Costo", "ITBMS", "Estado"]
                  : ["Producto", "Talla", "Por caja", "Precio", "ITBMS", "Estado"]
              }
            >
              {d.variantes.map((v) => (
                <Fila key={v.codigo}>
                  <Celda etiqueta="">
                    {puedeTocar ? (
                      // El nombre ES el botón: en un teléfono, un lápiz de
                      // 24 px al lado de cada fila se falla con el pulgar.
                      <button
                        type="button"
                        onClick={() => setEditando(v)}
                        className="m-0 block w-full cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-fg underline decoration-line underline-offset-4 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {v.nombre}
                        <span className="block text-[12px] font-normal text-muted">{v.codigo}</span>
                        <span className="sr-only"> — tocar para editar</span>
                      </button>
                    ) : (
                      <>
                        {v.nombre}
                        <span className="block text-[12px] font-normal text-muted">{v.codigo}</span>
                      </>
                    )}
                  </Celda>
                  <Celda etiqueta="Talla">{v.talla ?? "—"}</Celda>
                  <Celda etiqueta="Por caja">{v.unidades_por_caja}</Celda>
                  <Celda etiqueta="Precio" papel="clave">
                    <strong>{dinero(v.precio_cents)}</strong>
                  </Celda>
                  {d.muestraCosto ? (
                    <Celda etiqueta="Costo promedio">{costoPromedio(v)}</Celda>
                  ) : null}
                  <Celda etiqueta="ITBMS">
                    {/* Una tasa sin confirmar NO se enseña como 0 %: la pone la
                        contadora, y un cero inventado es una declaración mal
                        hecha. */}
                    {v.tasa_itbms_bp === null ? (
                      <Pastilla tono="aviso">Falta</Pastilla>
                    ) : (
                      `${v.tasa_itbms_bp / 100} %`
                    )}
                  </Celda>
                  <Celda etiqueta="Estado" papel="estado">
                    {/*
                        «En la web» se decía mirando SOLO `publicado`, y eso era
                        mentira: la lista de la tienda se arma con las fichas de
                        `content.json`, así que un producto publicado sin ficha
                        tiene precio, tiene existencia, y NO aparece. El dueño
                        preguntó cuatro días seguidos por qué, y esta pastilla
                        le contestaba «En la web» cada vez.

                        Ahora dice lo que pasa de verdad, y debajo por qué. El
                        motivo se escribe en el sistema, no aquí: una frase
                        repetida en dos sitios se separa.
                    */}
                    {v.activo !== 1 ? (
                      <Pastilla tono="neutro">Descatalogado</Pastilla>
                    ) : v.saleEnLaTienda === true ? (
                      <Pastilla tono="bien">En la web</Pastilla>
                    ) : v.publicado === 1 ? (
                      <>
                        <Pastilla tono="aviso">Publicado, pero no en la web</Pastilla>
                        {v.porQueNoSale ? (
                          <span className="mt-1 block text-[12px] font-normal text-muted">
                            {v.porQueNoSale}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <Pastilla tono="neutro">Solo interno</Pastilla>
                    )}
                  </Celda>
                </Fila>
              ))}
            </Rejilla>

            <NuevoProducto
              abierta={creando}
              alCerrar={() => setCreando(false)}
              alCrear={() => setRecarga((n) => n + 1)}
            />

            <EditarVariante
              variante={editando}
              alCerrar={() => setEditando(null)}
              alGuardar={() => setRecarga((n) => n + 1)}
            />
          </div>
        )
      }
    </Carga>
  );
}
