import { fecha, useCarga } from "../api";
import { Carga, Celda, Fila, Pastilla, Rejilla, Tarjeta } from "../componentes";
import reglas from "../../../reglas.json";

interface Vigente {
  clave: string;
  version: number;
  valor: unknown;
  vigente_desde: number;
  cambiado_por: string;
  motivo: string | null;
}

/** Lo que se muestra de un valor, sea texto, número, lista o PENDIENTE. */
function comoSeLee(valor: unknown): { texto: string; pendiente: boolean } {
  if (valor === "PENDIENTE") return { texto: "Falta decidirlo", pendiente: true };
  if (valor === null || valor === undefined) return { texto: "—", pendiente: false };
  if (typeof valor === "boolean") return { texto: valor ? "Sí" : "No", pendiente: false };
  if (Array.isArray(valor)) {
    return { texto: valor.length === 0 ? "ninguno" : valor.join(", "), pendiente: false };
  }
  return { texto: String(valor), pendiente: false };
}

/** Las claves que terminan en `_cents` se leen en dólares, no en centavos. */
function enDolares(clave: string, valor: unknown): string | null {
  if (!clave.endsWith("_cents") || typeof valor !== "number") return null;
  return `$${Math.trunc(valor / 100)}.${String(Math.abs(valor % 100)).padStart(2, "0")}`;
}

/**
 * Los ajustes: las reglas con cifras del negocio.
 *
 * Cada una puede tener versiones, y vale la más nueva cuya vigencia ya empezó.
 * Lo que nadie ha cambiado todavía cae en el valor de fábrica de
 * `reglas.json`, y la pantalla lo DICE: un número sin decir de dónde sale
 * invita a creérselo, y aquí hay varios que todavía nadie ha confirmado.
 */
export function Ajustes() {
  const estado = useCarga<{ vigentes: Vigente[]; ahora: number }>("/api/ajustes");
  const deFabrica = reglas as unknown as Record<string, unknown>;

  return (
    <Carga estado={estado} que="los ajustes">
      {(d) => {
        const puestos = new Map(d.vigentes.map((v) => [v.clave, v]));
        const claves = Object.keys(deFabrica)
          .filter((k) => !k.startsWith("_"))
          .sort();
        const pendientes = claves.filter(
          (k) => !puestos.has(k) && deFabrica[k] === "PENDIENTE",
        );

        return (
          <div className="grid gap-4">
            {pendientes.length > 0 ? (
              <Tarjeta className="border-accent-edge">
                <p className="m-0 font-bold">
                  {pendientes.length} regla{pendientes.length === 1 ? "" : "s"} sin decidir
                </p>
                <p className="m-0 mt-1 text-muted">
                  El sistema no las rellena solo. Hasta que usted decida, lo que dependa de ellas
                  no se enciende — que es mejor que funcionar con un número inventado.
                </p>
              </Tarjeta>
            ) : null}

            <Rejilla columnas={["Regla", "Valor", "De dónde sale", "Desde cuándo"]}>
              {claves.map((clave) => {
                const puesto = puestos.get(clave);
                const valor = puesto ? puesto.valor : deFabrica[clave];
                const { texto, pendiente } = comoSeLee(valor);
                const dolares = enDolares(clave, valor);

                return (
                  <Fila key={clave}>
                    <Celda etiqueta="">{clave.replace(/_/g, " ")}</Celda>
                    <Celda etiqueta="Valor" papel="clave">
                      {pendiente ? (
                        <Pastilla tono="aviso">Falta decidirlo</Pastilla>
                      ) : (
                        <strong>{dolares ?? texto}</strong>
                      )}
                    </Celda>
                    <Celda etiqueta="De dónde sale" className="text-muted">
                      {puesto ? (
                        <>
                          Lo puso {puesto.cambiado_por}
                          {puesto.motivo ? `: ${puesto.motivo}` : ""}
                        </>
                      ) : (
                        "Valor de fábrica"
                      )}
                    </Celda>
                    <Celda etiqueta="Desde cuándo" className="text-muted">
                      {puesto ? fecha(puesto.vigente_desde) : "—"}
                    </Celda>
                  </Fila>
                );
              })}
            </Rejilla>

            <Tarjeta>
              <p className="m-0 text-muted">
                Un ajuste solo cambia hacia adelante: lo que ya pasó se queda como pasó. Por eso
                un pedido guarda su abono mínimo al crearse — si usted sube el mínimo mañana, el
                pedido de hoy no cambia de reglas a mitad.
              </p>
            </Tarjeta>
          </div>
        );
      }}
    </Carga>
  );
}
