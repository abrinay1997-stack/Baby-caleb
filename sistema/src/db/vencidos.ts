import { type ContextoTransicion, cancelar } from "./transiciones";

/**
 * Las reservas que se vencieron y nadie soltó.
 *
 * EL PROBLEMA
 *
 * Un pedido `por_abonar` aparta su mercancía en el momento de crearse: esas
 * cajas dejan de estar a la venta para que la clienta pague con calma. Y lleva
 * `vence_en`, el plazo que le da la dueña —`reserva_minutos_pago_en_linea` o
 * `reserva_horas_comprobante`, según cómo vaya a pagar—.
 *
 * Cumplido el plazo no pasaba nada. Nada en absoluto: ni se cancelaba, ni se
 * soltaba la mercancía, ni nadie se enteraba. `metricas.ts` ya CONTABA esos
 * pedidos (`por_abonar_vencidos`) y el panel ya enseñaba el número — pero
 * contar no es actuar. La mercancía se quedaba apartada para siempre, y la
 * dueña veía «agotado» en un artículo que tenía en la bodega, sin ninguna
 * forma de saber por qué.
 *
 * LO QUE ESTE BARRIDO HACE, Y LO QUE NO
 *
 * Cancela los vencidos **que no han pagado nada**. Ahí no hay ninguna decisión
 * que tomar: se acabó el plazo, la mercancía vuelve a la venta, y el motivo
 * queda escrito en el pedido.
 *
 * **Los que tienen un abono NO se tocan.** Qué pasa con ese dinero —si se
 * devuelve, si queda como crédito, si se pierde— es una regla del negocio que
 * la dueña todavía no ha decidido: el ajuste `cancelacion_con_abono` está en
 * PENDIENTE. Cancelar por nuestra cuenta un pedido con plata adentro sería
 * inventarse esa regla, y es dinero de una clienta de verdad. Se devuelven en
 * la lista para que alguien los mire; siguen contados en la métrica.
 *
 * El tope por vuelta existe porque esto corre cada cinco minutos: con mil
 * vencidos de golpe, más vale ir soltándolos de a poco que pasarse del tiempo
 * del cron y no soltar ninguno.
 */

/** Cuántos se sueltan como mucho en una vuelta del cron. */
const POR_VUELTA = 50;

export interface Vencidos {
  /** Los que se cancelaron y devolvieron su mercancía a la venta. */
  readonly soltados: readonly string[];
  /** Los que se vencieron CON dinero adentro: los decide una persona. */
  readonly conAbono: readonly string[];
  /** Los que no se pudieron cancelar, con su motivo. */
  readonly atascados: readonly { readonly pedidoId: string; readonly porQue: string }[];
}

export async function soltarVencidos(ctx: ContextoTransicion): Promise<Vencidos> {
  const { results } = await ctx.db
    .prepare(
      `SELECT id, pagado_cents FROM pedidos
        WHERE estado = 'por_abonar' AND vence_en IS NOT NULL AND vence_en <= ?
        ORDER BY vence_en
        LIMIT ?`,
    )
    .bind(ctx.ahora, POR_VUELTA)
    .all<{ id: string; pagado_cents: number }>();

  const soltados: string[] = [];
  const conAbono: string[] = [];
  const atascados: { pedidoId: string; porQue: string }[] = [];

  for (const p of results) {
    if (p.pagado_cents > 0) {
      conAbono.push(p.id);
      continue;
    }
    const r = await cancelar(
      ctx,
      p.id,
      "se venció el plazo para pagar: la mercancía vuelve a estar a la venta",
    );
    if (r.ok) soltados.push(p.id);
    else atascados.push({ pedidoId: p.id, porQue: r.mensaje });
  }

  return { soltados, conAbono, atascados };
}
