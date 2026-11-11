import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { enunciadosDeCobro, enunciadosDeTransicion } from "./transiciones";
import { puedeAgendar } from "../dominio/abonos";

/**
 * Pago manual: Yappy, transferencia, efectivo (F4.4).
 *
 * Es como Baby Caleb cobra HOY, y seguirá siendo como cobra la mayoría de las
 * clientas aunque mañana haya pasarelas: una transferencia por Yappy y una
 * captura de pantalla por WhatsApp.
 *
 * **La regla que manda aquí es «el navegador no decide un pago»**
 * (docs/plan/README.md §4). Una captura que manda una clienta NO es un pago
 * confirmado: es una afirmación. Puede estar recortada, puede ser de otro
 * pedido, puede ser de ayer, puede ser de otra persona. Así que
 * `registrarComprobante` crea el pago en `confirmando` — nunca en `aprobado`—
 * y hace falta que UNA PERSONA lo mire y lo confirme.
 *
 * Esa separación no es ceremonia. Sin ella, cualquiera que sepa el número de
 * un pedido puede subir una imagen y agendarse una entrega.
 *
 * Lo que sí hace el sistema solo, una vez confirmado: sumar el monto, derivar
 * el estado de pago, y agendar el pedido si ya alcanza. Todo en UN batch — si
 * fueran escrituras sueltas, entre una y otra el pedido diría que no se ha
 * pagado nada mientras el pago ya existe.
 */

export interface ContextoPago {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
}

/** Los métodos que se cobran a mano. Los de pasarela llegan en F4b. */
export const METODOS_MANUALES = ["yappy", "transferencia", "efectivo", "nequi"] as const;
export type MetodoManual = (typeof METODOS_MANUALES)[number];

export const esMetodoManual = (v: string): v is MetodoManual =>
  (METODOS_MANUALES as readonly string[]).includes(v);

export interface ComprobanteNuevo {
  readonly idempotencia: string;
  readonly pedidoId: string;
  readonly montoCents: number;
  readonly metodo: MetodoManual;
  /** La clave en R2 de la foto del comprobante, si la hay. */
  readonly comprobanteR2?: string;
  /** `abono` o `total`; `saldo` es lo que cobra el motorizado al entregar. */
  readonly tipo: "abono" | "total" | "saldo";
}

interface FilaPedido {
  id: string;
  estado: string;
  total_cents: number;
  pagado_cents: number;
  abono_minimo_cents: number;
  requiere_pago_total: number;
  version: number;
}

const leerPedido = (db: D1Database, id: string) =>
  db
    .prepare(
      `SELECT id, estado, total_cents, pagado_cents, abono_minimo_cents, requiere_pago_total, version
         FROM pedidos WHERE id = ?`,
    )
    .bind(id)
    .first<FilaPedido>();

/**
 * Anotar que alguien dice haber pagado.
 *
 * NO suma nada al pedido. Deja el pago en `confirmando`, que es exactamente lo
 * que es: algo que hay que mirar. El pedido no se mueve.
 *
 * `intento_ref` lleva la clave de idempotencia: si la misma clienta pulsa
 * «enviar» dos veces, el UNIQUE de la tabla rechaza el segundo y no quedan dos
 * comprobantes por el mismo dinero.
 */
export async function registrarComprobante(
  ctx: ContextoPago,
  e: ComprobanteNuevo,
): Promise<Resultado<{ pagoId: string; estado: "confirmando" }>> {
  if (!Number.isSafeInteger(e.montoCents) || e.montoCents <= 0) {
    return fallo("entrada_invalida", "el monto tiene que ser un entero positivo");
  }
  if (!esMetodoManual(e.metodo)) {
    return fallo("entrada_invalida", `«${e.metodo}» no es un método manual`);
  }

  const p = await leerPedido(ctx.db, e.pedidoId);
  if (p === null) return fallo("no_encontrado", "no existe ese pedido");
  if (p.estado === "cancelado" || p.estado === "devuelto") {
    return fallo("transicion_invalida", `no se registra un pago en un pedido ${p.estado}`);
  }

  // Lo que ya se cobró más lo que se dice haber pagado no puede pasar del
  // total. Se comprueba aquí para poder decirlo con palabras; la tabla lo
  // vuelve a comprobar al confirmar, que es cuando el dinero entra de verdad.
  const yaCobrado = p.pagado_cents;
  const pendientes = await ctx.db
    .prepare(
      "SELECT COALESCE(SUM(monto_cents),0) AS n FROM pagos WHERE pedido_id = ? AND estado = 'confirmando'",
    )
    .bind(e.pedidoId)
    .first<{ n: number }>();

  if (yaCobrado + (pendientes?.n ?? 0) + e.montoCents > p.total_cents) {
    return fallo(
      "monto_no_coincide",
      "entre lo cobrado y lo que está por confirmar se pasa del total del pedido",
    );
  }

  const pagoId = ulid(ctx.ahora);

  try {
    await ctx.db
      .prepare(
        `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,
           comprobante_r2,intento_ref,creado_en,actualizado_en)
         VALUES (?,?,'manual',?,?,'confirmando',?,?,?,?,?)`,
      )
      .bind(
        pagoId, e.pedidoId, e.metodo, e.tipo, e.montoCents,
        e.comprobanteR2 ?? null, e.idempotencia, ctx.ahora, ctx.ahora,
      )
      .run();
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    // El UNIQUE de `intento_ref`: la misma clave ya entró. No es un error de
    // la clienta, es el segundo clic del mismo botón.
    return /UNIQUE|constraint/i.test(texto)
      ? fallo("repetido", "ese comprobante ya estaba registrado")
      : fallo("interno", texto);
  }

  return ok({ pagoId, estado: "confirmando" });
}

/**
 * El paso de `confirmando` a `aprobado`, con su control.
 *
 * Se devuelve en vez de ejecutarse para que entre en el MISMO batch que el
 * cobro y la transición del pedido — y para poder probar la carrera, que es
 * lo único que estos dos enunciados protegen.
 *
 * El `WHERE … AND estado = 'confirmando'` es para cuando DOS PERSONAS están
 * mirando el mismo comprobante en el panel y las dos pulsan confirmar. La
 * lectura previa de `confirmarPago` caza al segundo que llega después; esto
 * caza al que llega a la vez. Sin ello, el mismo comprobante se sumaría dos
 * veces al pedido.
 */
export function enunciadosDeConfirmacion(
  ctx: ContextoPago,
  pagoId: string,
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `UPDATE pagos SET estado = 'aprobado', confirmado_por = ?, confirmado_en = ?, actualizado_en = ?
          WHERE id = ? AND estado = 'confirmando'`,
      )
      .bind(ctx.actor, ctx.ahora, ctx.ahora, pagoId),
    // Un UPDATE que no casa con nada NO falla: afecta cero filas y sigue. El
    // control mira el estado ya cambiado.
    //
    // Y mira QUIÉN y CUÁNDO, no solo que esté aprobado. Esa fue mi primera
    // versión y no detectaba nada: «¿está aprobado?» es cierto tanto si lo
    // aprobó este batch como si lo aprobó el de al lado un milisegundo antes.
    // Lo escribí, la prueba de la carrera se puso roja, y ahí se vio.
    //
    // Lo que esto NO distingue: la misma persona pulsando dos veces dentro
    // del mismo milisegundo. Es inofensivo —el cobro escribe un valor
    // absoluto, no una suma, así que el segundo escribe lo mismo— y lo caro,
    // que es perder un cobro distinto, lo cierra la versión del pedido.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, 'pago:confirmado',
                 (SELECT COUNT(*) FROM pagos
                   WHERE id = ? AND estado = 'aprobado'
                     AND confirmado_por = ? AND confirmado_en = ?), ?)`,
      )
      .bind(ulid(ctx.ahora), pagoId, ctx.actor, ctx.ahora, ctx.ahora),
  ];
}

/**
 * Una persona mira el comprobante y dice que sí.
 *
 * Aquí es donde el dinero entra. Todo en un batch: el pago pasa a `aprobado`,
 * el pedido suma, su estado de pago se deriva, y si ya alcanza el abono
 * mínimo, se agenda — con su fila de control y su evento.
 *
 * El `WHERE … AND estado = 'confirmando'` no sobra: dos personas pueden estar
 * mirando el mismo comprobante en el panel. La segunda no vuelve a sumarlo.
 */
export async function confirmarPago(
  ctx: ContextoPago,
  pagoId: string,
): Promise<Resultado<{ pagadoCents: number; agendado: boolean }>> {
  const pago = await ctx.db
    .prepare("SELECT id, pedido_id, monto_cents, estado FROM pagos WHERE id = ?")
    .bind(pagoId)
    .first<{ id: string; pedido_id: string; monto_cents: number; estado: string }>();

  if (pago === null) return fallo("no_encontrado", "no existe ese pago");
  if (pago.estado !== "confirmando") {
    return fallo("transicion_invalida", `ese pago ya está ${pago.estado}`);
  }

  const p = await leerPedido(ctx.db, pago.pedido_id);
  if (p === null) return fallo("no_encontrado", "no existe el pedido de ese pago");

  const pagadoDespues = p.pagado_cents + pago.monto_cents;

  const enunciados: D1PreparedStatement[] = [
    ...enunciadosDeConfirmacion(ctx, pagoId),
    ...enunciadosDeCobro(
      { db: ctx.db, ahora: ctx.ahora, actor: ctx.actor },
      p.id,
      p.total_cents,
      pagadoDespues,
      p.version,
    ),
  ];

  // ¿Ya alcanza para agendar? Se decide con la regla pura y con el abono
  // mínimo COPIADO en el pedido, no con el de los ajustes de hoy.
  const d = puedeAgendar({
    total_cents: p.total_cents,
    pagado_cents: pagadoDespues,
    abono_minimo_cents: p.abono_minimo_cents,
    requiere_pago_total: p.requiere_pago_total === 1,
  });
  const agenda = d.puede && p.estado === "por_abonar";

  if (agenda) {
    enunciados.push(
      ...enunciadosDeTransicion(
        { db: ctx.db, ahora: ctx.ahora, actor: ctx.actor },
        p.id,
        "por_abonar",
        "agendado",
        { porPago: pagoId, pagadoCents: pagadoDespues },
      ),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    return /CHECK|controles/i.test(texto)
      ? fallo(
          "conflicto_version",
          "el pedido cambió mientras se confirmaba este pago; vuelva a intentarlo",
        )
      : fallo("interno", texto);
  }

  return ok({ pagadoCents: pagadoDespues, agendado: agenda });
}

/**
 * Una persona mira el comprobante y dice que no.
 *
 * No se borra: se marca `rechazado`. Un comprobante rechazado es parte de lo
 * que pasó con ese pedido, y borrarlo deja a quien lo mire mañana sin saber
 * por qué la clienta insiste en que ya pagó.
 */
export async function rechazarPago(
  ctx: ContextoPago,
  pagoId: string,
  motivo: string,
): Promise<Resultado<{ rechazado: true }>> {
  if (motivo.trim() === "") {
    return fallo("entrada_invalida", "un rechazo sin motivo no le sirve a nadie");
  }

  const r = await ctx.db
    .prepare(
      `UPDATE pagos SET estado = 'rechazado', confirmado_por = ?, confirmado_en = ?, actualizado_en = ?
        WHERE id = ? AND estado = 'confirmando'`,
    )
    .bind(ctx.actor, ctx.ahora, ctx.ahora, pagoId)
    .run();

  if ((r.meta.changes ?? 0) === 0) {
    return fallo("transicion_invalida", "ese pago no estaba esperando confirmación");
  }

  const pago = await ctx.db
    .prepare("SELECT pedido_id FROM pagos WHERE id = ?")
    .bind(pagoId)
    .first<{ pedido_id: string }>();

  if (pago !== null) {
    await ctx.db
      .prepare(
        `INSERT INTO pedido_eventos (id,pedido_id,tipo,actor,datos_json,creado_en)
         VALUES (?,?,'pago_rechazado',?,?,?)`,
      )
      .bind(ulid(ctx.ahora), pago.pedido_id, ctx.actor, JSON.stringify({ pagoId, motivo }), ctx.ahora)
      .run();
  }

  return ok({ rechazado: true });
}
