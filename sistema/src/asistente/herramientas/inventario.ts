import { z } from "zod";
import { UMBRAL_POCAS, disponibilidad } from "../../dominio/existencias";
import { definir } from "../registro";

/**
 * Las primeras herramientas: mirar el inventario.
 *
 * Son de lectura y las puede usar cualquier rol del equipo, porque saber si
 * algo hay o no hay es lo que preguntan todos. El costo NO sale por aquí: el
 * costo es de `costo_y_margen`, que no todos tienen, y una herramienta que a
 * veces trae costo y a veces no sería una forma difícil de equivocarse.
 *
 * Ninguna de las dos toca `clientes`, así que no hay nada de una persona que
 * se pueda escapar hacia el modelo. Aun así pasan por la guarda de D-20 como
 * todas las demás: la regla vale porque se aplica sin excepciones, no porque
 * en este caso se vea que sobra.
 */

export const verStock = definir({
  nombre: "ver_stock",
  descripcion:
    "Cuánto hay de un artículo y en qué bodega. Sin código los devuelve todos, empezando por lo que está más escaso. Ejemplo: ver_stock con codigo «BC-001-03» dice cuántos bodies de 0 a 3 meses quedan en cada bodega.",
  parametros: z.object({
    codigo: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("El código del artículo, como BC-001-03. Si falta, los devuelve todos."),
    bodega: z.string().min(1).max(60).optional().describe("Nombre de la bodega, si solo interesa una."),
  }),
  nivel: "lectura",
  categoria: "inventario",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const condiciones: string[] = [];
    const valores: unknown[] = [];
    if (args.codigo !== undefined) {
      condiciones.push("e.codigo = ?");
      valores.push(args.codigo);
    }
    if (args.bodega !== undefined) {
      condiciones.push("b.nombre = ?");
      valores.push(args.bodega);
    }
    const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

    const { results } = await ctx.db
      .prepare(
        `SELECT e.codigo, v.nombre, b.nombre AS bodega,
                e.fisico, e.reservado, e.fisico - e.reservado AS libres, e.minimo
         FROM existencias e
         JOIN variantes v ON v.codigo = e.codigo
         JOIN bodegas b ON b.id = e.bodega_id
         ${donde}
         ORDER BY libres, e.codigo
         LIMIT 100`,
      )
      .bind(...valores)
      .all<{
        codigo: string;
        nombre: string;
        bodega: string;
        fisico: number;
        reservado: number;
        libres: number;
        minimo: number | null;
      }>();

    return {
      articulos: results.map((f) => ({
        codigo: f.codigo,
        nombre: f.nombre,
        bodega: f.bodega,
        // «libres» es lo físico menos lo ya comprometido: es lo que de verdad
        // se puede vender, y es lo único que debería usarse para prometer.
        libres: f.libres,
        comprometido: f.reservado,
        hay: disponibilidad(f.libres, UMBRAL_POCAS),
        bajoElMinimo: f.minimo !== null && f.libres <= f.minimo,
      })),
      cuantos: results.length,
      // Si se cortó en 100, decirlo: un total que en realidad era un recorte
      // es la forma más fácil de que el asistente afirme una cifra falsa.
      recortado: results.length === 100,
      aviso: await porQueNoSalioNada(ctx.db, args, results.length),
    };
  },
});

/**
 * Por qué una consulta de stock volvió vacía.
 *
 * Una lista vacía es la respuesta más peligrosa que puede dar esta herramienta:
 * el modelo lee `articulos: []` y contesta «no hay», que es una de tres cosas
 * distintas y se parecen solo desde aquí.
 *
 *  - El código no existe → no hay nada que contestar; hay que preguntar bien.
 *  - Es un COMBO → sí se puede vender, pero no tiene existencias propias: se
 *    arma con sus componentes. Decir «no hay» de un combo que se puede armar es
 *    perder una venta y quedar mal.
 *  - Existe y no está dado de alta en bodega → NO SE SABE cuánto hay, que no es
 *    lo mismo que cero. Un modelo que recibe «no se sabe» dice «déjeme
 *    confirmarlo»; uno que recibe cero dice «no hay».
 *
 * Hacia fuera la decisión es la contraria y también es correcta: el catálogo
 * público lee la falta de existencias como «agotado», porque de cara a la
 * clienta lo prudente es no prometer. Hacia dentro lo prudente es no mentirle a
 * quien tiene que ir a mirar.
 *
 * La consulta extra solo se hace cuando no salió nada Y se preguntó por un
 * código: en el camino normal esto no cuesta un viaje a la base.
 */
async function porQueNoSalioNada(
  db: D1Database,
  args: { codigo?: string | undefined; bodega?: string | undefined },
  cuantos: number,
): Promise<string | null> {
  if (cuantos > 0 || args.codigo === undefined) return null;

  const v = await laVariante(db, args.codigo);
  if (v === null) return noExiste(args.codigo);

  if (v.es_combo === 1) {
    return (
      `«${args.codigo}» (${v.nombre}) es un combo: no tiene existencias propias, ` +
      "se arma con sus componentes. Para saber cuántos se pueden armar use ver_combo."
    );
  }

  const donde = args.bodega === undefined ? "en ninguna bodega" : `en «${args.bodega}»`;
  return (
    `«${args.codigo}» (${v.nombre}) existe pero no está dado de alta ${donde}: ` +
    "NO SE SABE cuánto hay, y eso no es lo mismo que cero. Hay que darlo de alta o mirar otra bodega."
  );
}

const laVariante = (db: D1Database, codigo: string) =>
  db
    .prepare("SELECT nombre, es_combo FROM variantes WHERE codigo = ?")
    .bind(codigo)
    .first<{ nombre: string; es_combo: number }>();

const noExiste = (codigo: string) => `no existe ningún artículo con el código «${codigo}»`;

export const movimientos = definir({
  nombre: "movimientos",
  descripcion:
    "El historial de entradas y salidas de un artículo: compras, ventas, ajustes, mermas y traslados, del más nuevo al más viejo. Ejemplo: movimientos con codigo «BC-002-U» muestra por qué bajó el stock de las mantas.",
  parametros: z.object({
    codigo: z.string().min(1).max(40).describe("El código del artículo. Es obligatorio."),
    cuantos: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Cuántos movimientos devolver, del más reciente hacia atrás."),
  }),
  nivel: "lectura",
  categoria: "inventario",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const { results } = await ctx.db
      .prepare(
        `SELECT m.id, m.codigo, b.nombre AS bodega, m.delta, m.tipo, m.motivo,
                m.referencia_tipo, m.referencia_id, m.creado_en
         FROM movimientos_inventario m
         JOIN bodegas b ON b.id = m.bodega_id
         WHERE m.codigo = ?
         ORDER BY m.creado_en DESC, m.id DESC
         LIMIT ?`,
      )
      .bind(args.codigo, args.cuantos)
      .all<{
        id: string;
        codigo: string;
        bodega: string;
        delta: number;
        tipo: string;
        motivo: string | null;
        referencia_tipo: string | null;
        referencia_id: string | null;
        creado_en: number;
      }>();

    return {
      codigo: args.codigo,
      movimientos: results.map((m) => ({
        cuando: m.creado_en,
        bodega: m.bodega,
        // El signo ya lo lleva `delta`; se nombra para que el modelo no tenga
        // que deducirlo y se equivoque en el borde.
        entraron: m.delta > 0 ? m.delta : 0,
        salieron: m.delta < 0 ? -m.delta : 0,
        porque: m.tipo,
        motivo: m.motivo,
        // Se dice QUÉ lo originó, nunca de quién era: un pedido es un número,
        // y quién lo hizo no sale hacia el modelo (D-20).
        origen: m.referencia_tipo,
      })),
      cuantos: results.length,
      // `actor` y `costo_unit_cents` existen en la tabla y NO salen: el primero
      // puede ser una persona y el segundo es costo, que tiene su propio
      // permiso. Que estén en el SELECT de al lado y no aquí es a propósito.
      aviso: await porQueNoHayHistorial(ctx.db, args.codigo, results.length),
    };
  },
});

/**
 * Por qué un artículo no tiene historial.
 *
 * Mismo problema que en `ver_stock` y mismo remedio: una lista vacía son dos
 * cosas distintas. «El código está mal escrito» y «este artículo es nuevo y no
 * se ha movido nunca» llevan a respuestas opuestas, y desde una lista vacía se
 * parecen. La segunda además es una respuesta buena —no es un hueco de datos—,
 * así que conviene poder darla con confianza.
 */
async function porQueNoHayHistorial(
  db: D1Database,
  codigo: string,
  cuantos: number,
): Promise<string | null> {
  if (cuantos > 0) return null;

  const v = await laVariante(db, codigo);
  if (v === null) return noExiste(codigo);

  return (
    `«${codigo}» (${v.nombre}) existe y no tiene ningún movimiento anotado todavía: ` +
    "nunca ha entrado ni salido nada. No es que falten datos."
  );
}

export const HERRAMIENTAS_DE_INVENTARIO = [verStock, movimientos] as const;
