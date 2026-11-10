import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { estadoDePagoSegunSaldo, puedeAgendar } from "../dominio/abonos";

/**
 * Mover un pedido de un estado a otro (F4.2).
 *
 * El diagrama de 02-datos §6 dice qué transiciones existen. Este archivo las
 * hace cumplir, y lo hace con el mismo patrón de todo el sistema: la condición
 * se comprueba DENTRO del `UPDATE`, no antes.
 *
 * La diferencia importa y no es sutil. Esto:
 *
 *     const p = await leerPedido(id);
 *     if (p.estado === "por_abonar") await marcarAgendado(id);
 *
 * tiene una grieta del tamaño de un pedido: entre la lectura y la escritura,
 * otro proceso puede haberlo cancelado. El pedido acabaría agendado y
 * cancelado a la vez, y la reserva liberada dos veces. D1 no tiene
 * transacciones interactivas, así que no hay forma de cerrar esa grieta
 * leyendo primero.
 *
 * Lo que sí la cierra: `UPDATE … WHERE id = ? AND estado = ?`. Si el estado ya
 * cambió, el UPDATE no casa con nada. Y como un UPDATE que no casa con nada NO
 * FALLA —afecta cero filas y sigue—, hace falta la fila de control detrás,
 * mirando el estado ya cambiado, para que el batch entero se caiga.
 */

export interface ContextoTransicion {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
}

interface FilaPedido {
  id: string;
  estado: string;
  estado_pago: string;
  total_cents: number;
  pagado_cents: number;
  abono_minimo_cents: number;
  requiere_pago_total: number;
}

const leer = (db: D1Database, pedidoId: string) =>
  db
    .prepare(
      `SELECT id, estado, estado_pago, total_cents, pagado_cents,
              abono_minimo_cents, requiere_pago_total
         FROM pedidos WHERE id = ?`,
    )
    .bind(pedidoId)
    .first<FilaPedido>();

/**
 * Los enunciados de una transición: el UPDATE condicionado, su control y el
 * evento. Se devuelven para que quien llama los meta en SU batch — así un
 * pago y la transición que provoca entran juntos o no entran.
 */
export function enunciadosDeTransicion(
  ctx: ContextoTransicion,
  pedidoId: string,
  de: string,
  a: string,
  datos?: Record<string, unknown>,
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `UPDATE pedidos SET estado = ?, actualizado_en = ?, version = version + 1
          WHERE id = ? AND estado = ?`,
      )
      .bind(a, ctx.ahora, pedidoId, de),
    // El control mira el estado YA CAMBIADO. Si el pedido no estaba en `de`
    // —porque alguien se adelantó— el UPDATE no casó con nada, aquí sale 0 y
    // el CHECK de `controles` tumba el batch.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM pedidos WHERE id = ? AND estado = ?), ?)`,
      )
      .bind(ulid(ctx.ahora), `pedido:${de}->${a}`, pedidoId, a, ctx.ahora),
    ctx.db
      .prepare(
        `INSERT INTO pedido_eventos (id,pedido_id,tipo,de,a,actor,datos_json,creado_en)
         VALUES (?,?,'transicion',?,?,?,?,?)`,
      )
      .bind(
        ulid(ctx.ahora),
        pedidoId,
        de,
        a,
        ctx.actor,
        datos === undefined ? null : JSON.stringify(datos),
        ctx.ahora,
      ),
  ];
}

/**
 * `por_abonar → agendado`: el pedido entra en la lista de entregas.
 *
 * La condición no se inventa aquí: la decide `puedeAgendar`, que es la regla
 * pura portada de Nébula. Con `requiere_pago_total` hace falta el total; sin
 * él, basta el abono mínimo COPIADO EN EL PEDIDO —no el de los ajustes de
 * hoy—, porque la regla del pedido es la del día en que se hizo.
 */
export async function agendar(
  ctx: ContextoTransicion,
  pedidoId: string,
): Promise<Resultado<{ agendado: true }>> {
  const p = await leer(ctx.db, pedidoId);
  if (p === null) return fallo("no_encontrado", "no existe ese pedido");
  if (p.estado !== "por_abonar") {
    return fallo("transicion_invalida", `un pedido ${p.estado} no se agenda`);
  }

  const d = puedeAgendar({
    total_cents: p.total_cents,
    pagado_cents: p.pagado_cents,
    abono_minimo_cents: p.abono_minimo_cents,
    requiere_pago_total: p.requiere_pago_total === 1,
  });
  if (!d.puede) return fallo("transicion_invalida", d.motivo);

  try {
    await ctx.db.batch(
      enunciadosDeTransicion(ctx, pedidoId, "por_abonar", "agendado", {
        pagadoCents: p.pagado_cents,
      }),
    );
  } catch {
    // El control se cayó: alguien movió el pedido entre la lectura y el batch.
    return fallo("conflicto_version", "el pedido cambió de estado mientras se agendaba");
  }

  return ok({ agendado: true });
}

/**
 * Cancelar: libera lo reservado.
 *
 * Se puede cancelar desde `por_abonar` y desde `agendado`. Desde `en_ruta` no:
 * el pedido ya salió y lo que corresponde es una entrega fallida o una
 * devolución, no un borrón.
 *
 * Si hubo abono, el pedido queda en `estado_pago = abonado` a propósito: ese
 * dinero existe y alguien tiene que decidir si se devuelve o queda como
 * crédito. Ponerlo en `sin_pago` haría desaparecer la deuda del sistema.
 */
export async function cancelar(
  ctx: ContextoTransicion,
  pedidoId: string,
  motivo: string,
): Promise<Resultado<{ cancelado: true; liberadas: number }>> {
  const p = await leer(ctx.db, pedidoId);
  if (p === null) return fallo("no_encontrado", "no existe ese pedido");
  if (p.estado !== "por_abonar" && p.estado !== "agendado") {
    return fallo(
      "transicion_invalida",
      `un pedido ${p.estado} no se cancela: lo que corresponde es una devolución`,
    );
  }

  const { results: lineas } = await ctx.db
    .prepare("SELECT codigo, cantidad, bodega_id FROM pedido_lineas WHERE pedido_id = ?")
    .bind(pedidoId)
    .all<{ codigo: string; cantidad: number; bodega_id: string }>();

  const enunciados = enunciadosDeTransicion(ctx, pedidoId, p.estado, "cancelado", { motivo });

  for (const l of lineas) {
    enunciados.push(
      ctx.db
        .prepare(
          "UPDATE existencias SET reservado = reservado - ? WHERE codigo = ? AND bodega_id = ? AND reservado >= ?",
        )
        .bind(l.cantidad, l.codigo, l.bodega_id, l.cantidad),
      // Sin este control, liberar de más pasaría callando: el `WHERE
      // reservado >= ?` haría que el UPDATE no casara con nada y el pedido
      // quedaría cancelado con su reserva todavía puesta — stock bloqueado
      // para siempre sin que nada fallara.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM existencias
                          WHERE codigo = ? AND bodega_id = ? AND reservado >= 0), ?)`,
        )
        .bind(ulid(ctx.ahora), `liberar:${l.codigo}`, l.codigo, l.bodega_id, ctx.ahora),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch {
    return fallo("conflicto_version", "el pedido cambió de estado mientras se cancelaba");
  }

  return ok({ cancelado: true, liberadas: lineas.length });
}

/**
 * Recalcular el estado de pago tras un cobro o un reembolso.
 *
 * Devuelve enunciados en vez de ejecutarlos: el estado de pago tiene que
 * cambiar EN EL MISMO BATCH que el pago que lo provoca. Si fueran dos
 * escrituras, entre una y otra el pedido diría que no se ha pagado nada
 * mientras el pago ya existe.
 *
 * El estado se DERIVA con `estadoDePagoSegunSaldo` y no se escribe a mano:
 * dos formas de decidir el mismo estado acaban discrepando y nadie sabe cuál
 * creer.
 */
export function enunciadosDeCobro(
  ctx: ContextoTransicion,
  pedidoId: string,
  totalCents: number,
  pagadoDespuesCents: number,
): D1PreparedStatement[] {
  const estadoPago = estadoDePagoSegunSaldo(totalCents, pagadoDespuesCents);
  return [
    ctx.db
      .prepare(
        "UPDATE pedidos SET pagado_cents = ?, estado_pago = ?, actualizado_en = ?, version = version + 1 WHERE id = ?",
      )
      .bind(pagadoDespuesCents, estadoPago, ctx.ahora, pedidoId),
    // `pagado_cents <= total_cents` ya lo vigila la tabla. Esto vigila lo
    // otro: que el estado de pago guardado SEA el que corresponde al saldo.
    // Un pedido que dice «pagado» con saldo pendiente es una entrega que nadie
    // va a cobrar.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM pedidos WHERE id = ? AND estado_pago = ?), ?)`,
      )
      .bind(ulid(ctx.ahora), `cobro:${estadoPago}`, pedidoId, estadoPago, ctx.ahora),
  ];
}
