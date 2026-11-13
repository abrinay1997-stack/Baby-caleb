import { ulid } from "../ids";
import type { EstadoEnvio } from "../dominio/estado-envio";
import { type Punto, esPuntoValido } from "../dominio/geo";

/**
 * Lo que hace falta para mover una parada: la base, la hora y quién lo hizo.
 *
 * Es la parte común de `ContextoEntrega` y `ContextoTransicion`, que son
 * idénticos. Se declara aquí para que este módulo no dependa de ninguno de los
 * dos y los dos puedan depender de él.
 */
export interface ContextoDeParada {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
}

/**
 * Mover una parada de un estado a otro, en enunciados.
 *
 * Vivía dentro de `entregas.ts` como función privada. Se saca aquí porque
 * `transiciones.ts` también necesita mover una parada —al cancelar un pedido
 * hay que anular su entrega— y `entregas.ts` YA importa de `transiciones.ts`:
 * importarlo al revés habría cerrado un ciclo. La otra salida era copiar los
 * tres enunciados, y una copia de un control se separa de su original sin que
 * nadie lo note, que es justo lo que este archivo existe para impedir.
 */
/**
 * El cambio de estado de una parada, con su control y su bitácora.
 *
 * Son tres enunciados que van juntos siempre, y se devuelven en vez de
 * ejecutarse para que entren en el MISMO batch que lo que provocan — el stock,
 * el cobro, la transición del pedido.
 *
 * **El control mira los valores que este batch escribió**, no solo la versión.
 * La diferencia es la que ya costó dos veces en este proyecto: si otro guardó
 * en medio, la versión que se esperaba YA es la que hay, y un control que solo
 * mire el número pasa tan contento aunque el UPDATE no haya tocado nada.
 */
export function enunciadosDeParada(
  ctx: ContextoDeParada,
  envioId: string,
  de: EstadoEnvio,
  a: EstadoEnvio,
  versionLeida: number,
  extra: {
    readonly nota?: string | undefined;
    readonly punto?: Punto | undefined;
    /** Columnas que este cambio escribe además del estado. */
    readonly columnas?: { readonly sql: string; readonly valores: unknown[] } | undefined;
    /** Condición añadida al control, sobre lo que acaba de escribirse. */
    readonly controlExtra?: { readonly sql: string; readonly valores: unknown[] } | undefined;
  } = {},
): D1PreparedStatement[] {
  const columnas = extra.columnas === undefined ? "" : `, ${extra.columnas.sql}`;
  const valoresColumnas = extra.columnas?.valores ?? [];
  const controlExtra = extra.controlExtra === undefined ? "" : ` AND ${extra.controlExtra.sql}`;
  const valoresControl = extra.controlExtra?.valores ?? [];
  const punto = extra.punto !== undefined && esPuntoValido(extra.punto) ? extra.punto : null;

  return [
    ctx.db
      .prepare(
        `UPDATE envios SET estado = ?${columnas}, version = version + 1
          WHERE id = ? AND estado = ? AND version = ?`,
      )
      .bind(a, ...valoresColumnas, envioId, de, versionLeida),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM envios
                        WHERE id = ? AND version = ? AND estado = ?${controlExtra}), ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        `envio:${de}->${a}`,
        envioId,
        versionLeida + 1,
        a,
        ...valoresControl,
        ctx.ahora,
      ),
    ctx.db
      .prepare(
        `INSERT INTO envio_eventos (id,envio_id,de,a,actor,nota,lat,lng,creado_en)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        ulid(ctx.ahora),
        envioId,
        de,
        a,
        ctx.actor,
        extra.nota ?? null,
        punto?.lat ?? null,
        punto?.lng ?? null,
        ctx.ahora,
      ),
  ];
}
