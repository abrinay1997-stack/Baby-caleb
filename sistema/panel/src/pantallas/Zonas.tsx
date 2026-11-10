import { dinero, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta, Vacio } from "../componentes";

interface Zona {
  id: string;
  nombre: string;
  alias: string[];
  region: "ciudad" | "interior";
  metodo: "motorizado" | "ferguson" | "otro";
  tarifa_cents: number | null;
  requiere_pago_total: number;
  activa: number;
  bodega_preferida: string | null;
}

export function Zonas() {
  const estado = useCarga<{ zonas: Zona[] }>("/api/zonas");

  return (
    <Carga estado={estado} que="las zonas de envío">
      {(d) =>
        d.zonas.length === 0 ? (
          <Vacio
            titulo="Todavía no hay zonas"
            detalle="Se cargan en F3.1 desde el tarifario que ya existe en el CRM, que a su vez sale de su documento. Los alias son las otras formas de escribir el nombre: con ellos, la clienta encuentra su zona aunque la escriba distinto."
          />
        ) : (
          <div className="grid gap-4">
            <Tarjeta>
              <p className="m-0 text-muted">
                Una zona sin tarifa no es gratis: es que se cotiza a mano. El sistema no inventa un
                precio de envío — se lo dice a la clienta y usted le confirma el costo.
              </p>
            </Tarjeta>

            <Rejilla columnas={["Zona", "Región", "Cómo llega", "Tarifa", "Pago", "Estado"]}>
              {d.zonas.map((z) => (
                <Fila key={z.id}>
                  <Celda etiqueta="">
                    {z.nombre}
                    {z.alias.length > 0 ? (
                      <span className="block text-[12px] font-normal text-muted">
                        también: {z.alias.join(", ")}
                      </span>
                    ) : null}
                  </Celda>
                  <Celda etiqueta="Región">
                    {z.region === "ciudad" ? "Ciudad" : "Interior"}
                  </Celda>
                  <Celda etiqueta="Cómo llega">
                    {z.metodo === "motorizado"
                      ? "Motorizado"
                      : z.metodo === "ferguson"
                        ? "Ferguson"
                        : "Otro"}
                    {z.bodega_preferida ? (
                      <span className="block text-[12px] font-normal text-muted">
                        sale de {z.bodega_preferida}
                      </span>
                    ) : null}
                  </Celda>
                  <Celda etiqueta="Tarifa">
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
                  <Celda etiqueta="Estado">
                    {z.activa === 1 ? (
                      <Pastilla tono="bien">Entregando</Pastilla>
                    ) : (
                      <Pastilla tono="neutro">Pausada</Pastilla>
                    )}
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
