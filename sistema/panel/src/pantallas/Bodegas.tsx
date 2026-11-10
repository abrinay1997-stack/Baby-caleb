import { useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Vacio } from "../componentes";

interface Bodega {
  id: string;
  nombre: string;
  activa: number;
  variantes: number;
  unidades: number;
}

export function Bodegas() {
  const estado = useCarga<{ bodegas: Bodega[] }>("/api/bodegas");

  return (
    <Carga estado={estado} que="las bodegas">
      {(d) =>
        d.bodegas.length === 0 ? (
          <Vacio
            titulo="Todavía no hay bodegas"
            detalle="Se cargan en F3.1 desde las sucursales que ya tiene el CRM. Una bodega no se borra nunca: se desactiva, porque sus movimientos tienen que seguir existiendo."
          />
        ) : (
          <Rejilla columnas={["Bodega", "Variantes", "Unidades", "Estado"]}>
            {d.bodegas.map((b) => (
              <Fila key={b.id}>
                <Celda etiqueta="">{b.nombre}</Celda>
                <Celda etiqueta="Variantes">{b.variantes}</Celda>
                <Celda etiqueta="Unidades" papel="clave">
                  <strong>{b.unidades}</strong>
                </Celda>
                <Celda etiqueta="Estado" papel="estado">
                  {b.activa === 1 ? (
                    <Pastilla tono="bien">En uso</Pastilla>
                  ) : (
                    <Pastilla tono="neutro">Desactivada</Pastilla>
                  )}
                </Celda>
              </Fila>
            ))}
          </Rejilla>
        )
      }
    </Carga>
  );
}
