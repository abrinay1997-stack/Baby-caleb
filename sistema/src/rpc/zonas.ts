import type { Zona } from "../dominio/zonas";

/**
 * Las zonas de envío, como las ven la web y el CRM.
 *
 * El alias viaja como texto JSON en la base y aquí se vuelve lista. Un alias
 * ilegible no tumba nada: esa zona sale sin sus alias, que es mejor que una
 * pantalla en blanco o un bot que no cotiza ningún envío porque una fila está
 * mal escrita.
 */

export interface ZonaPublica {
  readonly id: string;
  readonly nombre: string;
  readonly alias: string[];
  readonly region: "ciudad" | "interior";
  /** NULL = no hay tarifa fija y se cotiza con una persona. */
  readonly tarifaCents: number | null;
  readonly requierePagoTotal: boolean;
}

interface Fila {
  id: string;
  nombre: string;
  alias_json: string;
  region: string;
  tarifa_cents: number | null;
  requiere_pago_total: number;
}

export function aliasDe(json: string): string[] {
  try {
    const leido: unknown = JSON.parse(json);
    return Array.isArray(leido) ? leido.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

function aPublica(f: Fila): ZonaPublica {
  return {
    id: f.id,
    nombre: f.nombre,
    alias: aliasDe(f.alias_json),
    region: f.region === "interior" ? "interior" : "ciudad",
    tarifaCents: f.tarifa_cents,
    requierePagoTotal: f.requiere_pago_total === 1,
  };
}

export async function zonasPublicas(db: D1Database): Promise<ZonaPublica[]> {
  const { results } = await db
    .prepare(
      `SELECT id, nombre, alias_json, region, tarifa_cents, requiere_pago_total
       FROM zonas_envio WHERE activa = 1 ORDER BY region, nombre`,
    )
    .all<Fila>();
  return results.map(aPublica);
}

/**
 * Las mismas zonas con la forma del dominio.
 *
 * El dominio las nombra como la base (`tarifa_cents`) y lo público como el
 * contrato (`tarifaCents`). No es un descuido: el de fuera es un contrato con
 * otros repositorios y cambiarlo rompe la web, mientras que el de dentro sigue
 * a la tabla. Esta función es el único sitio donde los dos se tocan.
 */
export async function zonasParaBuscar(db: D1Database): Promise<Zona[]> {
  const { results } = await db
    .prepare(
      `SELECT id, nombre, alias_json, region, metodo, tarifa_cents, requiere_pago_total, activa
       FROM zonas_envio WHERE activa = 1 ORDER BY region, nombre`,
    )
    .all<Fila & { metodo: string; activa: number }>();

  return results.map((z) => ({
    id: z.id,
    nombre: z.nombre,
    alias: aliasDe(z.alias_json),
    region: z.region === "interior" ? ("interior" as const) : ("ciudad" as const),
    metodo:
      z.metodo === "ferguson"
        ? ("ferguson" as const)
        : z.metodo === "otro"
          ? ("otro" as const)
          : ("motorizado" as const),
    tarifa_cents: z.tarifa_cents,
    requiere_pago_total: z.requiere_pago_total === 1,
    activa: z.activa === 1,
  }));
}
