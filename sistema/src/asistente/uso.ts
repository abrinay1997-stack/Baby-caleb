import { fechaContable, mesDe } from "../dominio/contabilidad";
import { ulid } from "../ids";
import type { Uso } from "./proveedor";
import type { Canal } from "./registro";

/**
 * Lo que gasta el asistente, anotado.
 *
 * La tabla `asistente_uso` existía desde la migración 0002 y NADIE escribía en
 * ella. Daba igual mientras el asistente no tuviera puerta: sin puerta no hay
 * llamadas y no hay gasto. Abrir la puerta es lo que lo vuelve real, así que
 * esto va antes.
 *
 * Se cuenta en MICRODÓLARES enteros y no en centavos: una llamada de $0.0006
 * redondea a cero en centavos, y mil llamadas sumarían cero (06-asistente §6).
 *
 * **La tarifa del modelo no está y no se inventa.** Nadie ha dicho cuánto
 * cuesta un millón de fichas del Contributor de Meta. Así que hoy se anotan las
 * FICHAS —que son un hecho medible— y el costo queda en cero, con un hueco a
 * la vista que dice por qué. El día que llegue la tarifa, el cálculo ya está
 * escrito y lo único que cambia es de dónde sale el número.
 *
 * Lo que NO se hace es poner una tarifa «aproximada» para que la columna no
 * esté vacía: un costo inventado se convierte en el costo real del informe del
 * mes siguiente, y nadie vuelve a preguntarse de dónde salió.
 */

/** Microdólares por millón de fichas. Lo que falta por saber. */
export interface Tarifa {
  readonly entrada: number;
  readonly salida: number;
  readonly cacheLeida?: number;
  readonly cacheEscrita?: number;
}

/**
 * El costo de un turno, si se sabe la tarifa.
 *
 * Devuelve `null` —y no cero— cuando no se sabe. Son cosas distintas: cero es
 * «no costó nada» y `null` es «no se puede saber», y quien llame tiene que
 * decidir qué hacer con cada una en vez de que se parezcan.
 */
export function costoMicroUsd(uso: Uso, tarifa: Tarifa | null): number | null {
  if (tarifa === null) return null;
  const porMillon = (fichas: number, precio: number): number => (fichas * precio) / 1_000_000;
  return Math.round(
    porMillon(uso.entrada, tarifa.entrada) +
      porMillon(uso.salida, tarifa.salida) +
      porMillon(uso.cacheLeida, tarifa.cacheLeida ?? tarifa.entrada) +
      porMillon(uso.cacheEscrita, tarifa.cacheEscrita ?? tarifa.entrada),
  );
}

export interface Anotacion {
  readonly usuarioId: string;
  readonly canal: Canal;
  readonly modelo: string;
  readonly uso: Uso;
  readonly ahora: number;
  /** `null` mientras nadie diga cuánto cuesta el modelo. */
  readonly tarifa: Tarifa | null;
}

/**
 * Anota un turno.
 *
 * No revienta si falla: dejar a la dueña sin asistente porque no se pudo
 * escribir una fila de contabilidad sería cambiar un problema pequeño por uno
 * grande. Pero se queja en el registro, porque un contador que deja de contar
 * en silencio es peor que no tenerlo.
 */
export async function anotarUso(db: D1Database, a: Anotacion): Promise<void> {
  const costo = costoMicroUsd(a.uso, a.tarifa);
  try {
    await db
      .prepare(
        `INSERT INTO asistente_uso
           (id, usuario_id, canal, modelo, entrada, salida, cache_leida, cache_escrita,
            costo_micro_usd, mes, creado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ulid(a.ahora),
        a.usuarioId,
        a.canal,
        a.modelo,
        a.uso.entrada,
        a.uso.salida,
        a.uso.cacheLeida,
        a.uso.cacheEscrita,
        // La columna no admite nulos. Cuando no se sabe, va cero — y por eso
        // el hueco tiene que verse: si no, una suma de ceros parece gasto cero.
        costo ?? 0,
        mesDe(fechaContable(a.ahora)),
        a.ahora,
      )
      .run();
  } catch (e) {
    console.warn(
      JSON.stringify({ evento: "asistente_uso_no_anotado", error: e instanceof Error ? e.message : String(e) }),
    );
  }
}

export interface Gasto {
  /** Fichas de entrada y salida del mes. Esto SÍ se sabe. */
  readonly fichas: number;
  /** Microdólares, que valen cero mientras no haya tarifa. */
  readonly microUsd: number;
  readonly turnos: number;
}

/** Lo gastado en el mes: todo el negocio, o una sola persona. */
export async function gastoDelMes(
  db: D1Database,
  ahora: number,
  usuarioId?: string,
): Promise<Gasto> {
  const mes = mesDe(fechaContable(ahora));
  const fila = await db
    .prepare(
      `SELECT COALESCE(SUM(entrada + salida), 0) AS fichas,
              COALESCE(SUM(costo_micro_usd), 0)  AS micro,
              COUNT(*)                            AS turnos
         FROM asistente_uso
        WHERE mes = ?${usuarioId === undefined ? "" : " AND usuario_id = ?"}`,
    )
    .bind(...(usuarioId === undefined ? [mes] : [mes, usuarioId]))
    .first<{ fichas: number; micro: number; turnos: number }>();

  return { fichas: fila?.fichas ?? 0, microUsd: fila?.micro ?? 0, turnos: fila?.turnos ?? 0 };
}
