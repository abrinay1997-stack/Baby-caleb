import { useCarga } from "../api";
import { Carga, Celda, Cifra, Fila, Rejilla, Tarjeta, Vacio } from "../componentes";

interface Bajo {
  codigo: string;
  nombre: string;
  bodega: string;
  libres: number;
  minimo: number;
}

interface DatosResumen {
  variantes: number;
  bodegas: number;
  zonas: number;
  clientes: number;
  avisosSinPublicar: number;
  avisoMasViejo: number | null;
  porAcabarse: Bajo[];
}

/**
 * Lo primero que ve la dueña al abrir el panel.
 *
 * Son cuentas y una lista corta, no un tablero lleno de gráficas: lo que hace
 * falta al abrir es saber si algo va mal. Las dos cosas que pueden ir mal hoy
 * son que algo se esté acabando y que los avisos a las clientas no estén
 * saliendo, así que son las dos que están arriba.
 */
export function Resumen() {
  const estado = useCarga<DatosResumen>("/api/resumen");

  return (
    <Carga estado={estado} que="el resumen">
      {(d) => (
        <div className="grid gap-4">
          {/* Los avisos atrasados van primero y solo si los hay: una tarjeta
              que casi siempre dice «0» se vuelve invisible a las dos semanas. */}
          {d.avisosSinPublicar > 0 ? (
            <Tarjeta className="border-accent-edge">
              <p className="m-0 font-bold">
                {d.avisosSinPublicar} aviso{d.avisosSinPublicar === 1 ? "" : "s"} sin salir
              </p>
              <p className="m-0 mt-1 text-muted">
                El sistema los reintenta cada 5 minutos. Si el número no baja en media hora,
                avísele a Juan: puede que las clientas no estén recibiendo sus mensajes.
              </p>
            </Tarjeta>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* «Artículos» y no «Productos»: la cuenta es de variantes —un
                body en cuatro tallas son cuatro— y poner «productos» le haría
                creer que tiene 118 cosas distintas. La nota lo dice entero. */}
            <Cifra
              etiqueta="Artículos"
              valor={String(d.variantes)}
              nota="activos, contando cada talla"
            />
            <Cifra etiqueta="Bodegas" valor={String(d.bodegas)} nota="en uso" />
            <Cifra etiqueta="Zonas" valor={String(d.zonas)} nota="a donde se entrega" />
            <Cifra etiqueta="Clientas" valor={String(d.clientes)} nota="registradas" />
          </div>

          <section>
            <h2 className="mb-2 mt-0 text-[17px] font-bold">Lo que se está acabando</h2>
            {d.porAcabarse.length === 0 ? (
              <Vacio
                titulo="Nada por acabarse"
                detalle="Aquí sale lo que ya llegó al mínimo que usted puso para esa talla en esa bodega. Lo que no tiene mínimo puesto no avisa nunca."
              />
            ) : (
              <Rejilla columnas={["Producto", "Bodega", "Quedan", "Mínimo"]}>
                {d.porAcabarse.map((b) => (
                  <Fila key={`${b.codigo}-${b.bodega}`}>
                    <Celda etiqueta="">{b.nombre}</Celda>
                    <Celda etiqueta="Bodega">{b.bodega}</Celda>
                    <Celda etiqueta="Quedan">
                      <strong>{b.libres}</strong>
                    </Celda>
                    <Celda etiqueta="Mínimo" className="text-muted">
                      {b.minimo}
                    </Celda>
                  </Fila>
                ))}
              </Rejilla>
            )}
          </section>
        </div>
      )}
    </Carga>
  );
}
