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

  /**
   * Lo que se APARTÓ, no lo que dice la línea.
   *
   * Una línea de combo nombra el combo, y un combo no tiene existencias: hay
   * que devolver sus piezas. Y no se vuelve a leer la receta para saber
   * cuáles — la receta puede haber cambiado desde la venta, y entonces se
   * liberaría una cantidad distinta de la apartada, dejando la diferencia
   * bloqueada para siempre sin que nada fallara.
   *
   * `pedido_linea_componentes` guarda exactamente lo que se quitó. Para una
   * variante normal lleva una fila con ella misma, así que aquí no hay dos
   * caminos: hay uno.
   */
  const { results: lineas } = await ctx.db
    .prepare(
      `SELECT plc.codigo, plc.cantidad, plc.bodega_id
         FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id
        WHERE pl.pedido_id = ?`,
    )
    .bind(pedidoId)
    .all<{ codigo: string; cantidad: number; bodega_id: string }>();

  const enunciados = enunciadosDeTransicion(ctx, pedidoId, p.estado, "cancelado", { motivo });

  for (const l of lineas) {
    // SIN guarda en el `WHERE`, y sin fila de control. A propósito, y con
    // una historia detrás.
    //
    // Antes esto era `… WHERE reservado >= ?` con un control que comprobaba
    // `reservado >= 0`. El comentario de al lado decía que ese control cazaba
    // el caso de que el UPDATE no casara con nada. No lo cazaba: la tabla YA
    // tiene `CHECK (reservado >= 0)`, así que ese SELECT contaba filas que
    // existen, nunca cero. Si `reservado` quedaba por debajo de `cantidad`,
    // el UPDATE no casaba, el control salía 1, y el pedido se cancelaba con
    // su reserva puesta: stock trabado para siempre, en verde.
    //
    // Es la tercera vez en este proyecto que un control comprueba algo que ya
    // era cierto antes del batch. La regla, otra vez: un control vale si mira
    // lo que ESTE batch escribió.
    //
    // Aquí ni siquiera hace falta control. Quitando la guarda, restar de más
    // deja `reservado` en negativo y el `CHECK` de la tabla tumba el batch
    // entero — que es justo lo que se quiere. Una línea menos y una defensa
    // de verdad, en vez de dos líneas que decían defender y no defendían.
    enunciados.push(
      ctx.db
        .prepare("UPDATE existencias SET reservado = reservado - ? WHERE codigo = ? AND bodega_id = ?")
        .bind(l.cantidad, l.codigo, l.bodega_id),
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
  /**
   * La `version` del pedido que se leyó para calcular `pagadoDespuesCents`.
   *
   * Es lo que cierra la ACTUALIZACIÓN PERDIDA, que es el fallo caro de aquí y
   * que no es el que parece. No es confirmar dos veces el mismo pago —eso
   * escribe el mismo valor absoluto dos veces y queda bien— es confirmar DOS
   * PAGOS DISTINTOS a la vez: los dos leen `pagado_cents = 0`, uno calcula
   * $5 y el otro $3, el último que escribe gana, y uno de los dos cobros
   * desaparece del pedido aunque el dinero esté en la cuenta.
   *
   * **Lo que lo cierra es el CONTROL, no el WHERE.** Probándolo con el WHERE
   * quitado, el batch se sigue cayendo: el control exige `version =
   * versionLeida + 1`, y si otro escribió en medio la versión ya no cuadra.
   * El WHERE está igualmente, y vale la pena: evita escribir un valor que
   * después hay que revertir, y deja dicha la intención en el sitio donde se
   * lee el UPDATE.
   *
   * Quien llama reintenta con el pedido ya releído.
   */
  versionLeida: number,
): D1PreparedStatement[] {
  const estadoPago = estadoDePagoSegunSaldo(totalCents, pagadoDespuesCents);
  return [
    ctx.db
      .prepare(
        `UPDATE pedidos SET pagado_cents = ?, estado_pago = ?, actualizado_en = ?, version = version + 1
          WHERE id = ? AND version = ?`,
      )
      .bind(pagadoDespuesCents, estadoPago, ctx.ahora, pedidoId, versionLeida),
    // El control mira el estado YA CAMBIADO, y mira las TRES cosas a la vez:
    // la versión nueva (que nadie se metió en medio), el monto exacto, y que
    // el estado de pago sea el que corresponde a ese saldo. Mirar solo el
    // estado de pago no bastaba: «abonado» es verdad tanto si el cobro lo hizo
    // este batch como si lo hizo otro.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM pedidos
                        WHERE id = ? AND version = ? AND pagado_cents = ? AND estado_pago = ?), ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        `cobro:${estadoPago}`,
        pedidoId,
        versionLeida + 1,
        pagadoDespuesCents,
        estadoPago,
        ctx.ahora,
      ),
  ];
}
