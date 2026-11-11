import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { enunciadosDeCobro, enunciadosDeTransicion } from "./transiciones";
import { puedeAgendar } from "../dominio/abonos";
import { abonoAntesDeEntregar, cobroDelSaldo, fechaContable } from "../dominio/contabilidad";
import { enunciadosDeAsiento } from "./contabilidad";

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
export const METODOS_MANUALES = ["yappy", "transferencia", "efectivo"] as const;
export type MetodoManual = (typeof METODOS_MANUALES)[number];

export const esMetodoManual = (v: string): v is MetodoManual =>
  (METODOS_MANUALES as readonly string[]).includes(v);

/**
 * A qué cuenta del plan entra el dinero de cada método (05-contabilidad §2).
 *
 * Está aquí y no en el dominio porque es la correspondencia entre CÓMO cobra
 * Baby Caleb y el plan de cuentas, y el dominio no tiene que saber que esta
 * tienda cobra por Yappy.
 *
 * Aquí estuvo `nequi`, heredado del proyecto del que sale este código, sin
 * cuenta en el plan y sin aparecer en ningún documento del negocio. Juan lo
 * confirmó: **Nequi ya no es un método de pago en Panamá**, así que no se le
 * busca cuenta — se quita. No quedaba ni un pago con ese método en ninguna de
 * las dos bases, así que no hay historia que arrastrar.
 *
 * Los tres que quedan tienen cuenta, así que este mapa no tiene huecos. El
 * `null` del lado de quien llama no desaparece por eso: `pagos.metodo` es una
 * columna de texto sin CHECK, y una fila con un método que este código no
 * conoce tiene que poder leerse sin reventar.
 */
const CUENTA_DEL_METODO: Record<MetodoManual, string> = {
  yappy: "1101",
  transferencia: "1102",
  efectivo: "1103",
};

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
  /** Para el detalle del asiento: un apunte que no nombra el pedido no sirve. */
  numero: string;
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
      `SELECT id, numero, estado, total_cents, pagado_cents, abono_minimo_cents,
              requiere_pago_total, version
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
    if (/UNIQUE/i.test(texto)) {
      return fallo("repetido", "ese comprobante ya estaba registrado");
    }

    /**
     * Cualquier OTRA restricción es un dato que no cabe en la tabla, y hasta
     * hoy se contaba como si fuera la de arriba.
     *
     * El `catch` miraba `/UNIQUE|constraint/i`, y en SQLite las dos cosas
     * dicen «constraint»: «UNIQUE constraint failed» y «CHECK constraint
     * failed». Así que un `tipo` que no existe —el CHECK de la columna—
     * respondía **409 «ese comprobante ya estaba registrado»**. Lo medí
     * quitando la guarda de la ruta y mandando `tipo: "inventado"`: eso es
     * exactamente lo que salió.
     *
     * Y es de los errores que cuestan tiempo de verdad: quien lo recibe busca
     * un comprobante repetido que no existe, en vez de mirar lo que mandó.
     */
    if (/CHECK|constraint/i.test(texto)) {
      return fallo(
        "entrada_invalida",
        "algo de ese comprobante no cabe en la tabla: revise el método, el tipo y el monto",
      );
    }

    return fallo("interno", texto);
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
    .prepare("SELECT id, pedido_id, monto_cents, estado, metodo FROM pagos WHERE id = ?")
    .bind(pagoId)
    .first<{
      id: string;
      pedido_id: string;
      monto_cents: number;
      estado: string;
      metodo: string;
    }>();

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

  // ── El asiento, en ESTE batch ────────────────────────────────────────────
  //
  // Aquí es donde el dinero entra de verdad —`registrarComprobante` solo anota
  // una afirmación— así que aquí va el asiento. Partido en dos escrituras, un
  // corte deja un cobro sumado al pedido que los libros no vieron.
  //
  // Cuál asiento depende de si el pedido ya salió, y la diferencia no es un
  // detalle contable:
  //
  //  · ANTES de entregar, lo abonado es un PASIVO (asiento 1, contra 2101):
  //    es dinero de la clienta que todavía hay que ganarse. Contarlo como
  //    venta aquí sería dar por ganado algo que falta entregar.
  //  · DESPUÉS de entregar, la venta ya se reconoció y 1201 lleva el saldo, así
  //    que lo que entra lo DESCARGA (asiento 4b). De este caso el documento
  //    solo contempla Yappy, que es como pagan las clientas que se quedaron
  //    debiendo; una transferencia o un efectivo que llegan después de la
  //    entrega no tienen asiento en los dieciocho, y no me voy a inventar el
  //    diecinueve a las tantas de la noche. Se queda sin anotar y lo canta la
  //    casilla del cierre, con el pago en la mano.
  const cuenta = esMetodoManual(pago.metodo) ? CUENTA_DEL_METODO[pago.metodo] : null;
  const yaSalio = p.estado === "entregado";
  const fecha = fechaContable(ctx.ahora);
  // Al PAGO y no al pedido: un pedido tiene varios pagos y cada uno lleva su
  // asiento, así que la referencia al pedido no permite preguntar por uno.
  const referencia = { tipo: "pago", id: pagoId };

  const asiento =
    !yaSalio && cuenta !== null
      ? abonoAntesDeEntregar({
          fecha,
          referencia,
          cuenta,
          montoCents: pago.monto_cents,
          detalle: `Pedido ${p.numero}`,
        })
      : yaSalio && cuenta === "1101"
        ? cobroDelSaldo({
            fecha,
            referencia,
            cuenta,
            montoCents: pago.monto_cents,
            numero: p.numero,
          })
        : null;

  if (asiento !== null) {
    // Aquí un fallo SÍ es un error: las combinaciones que llegan a este punto
    // son las que el constructor acepta, así que lo único que puede fallar es
    // el dato (un monto que no es un entero positivo, una fecha imposible), y
    // confirmar el cobro callando el asiento es el descuadre silencioso.
    if (!asiento.ok) return asiento;
    enunciados.push(...enunciadosDeAsiento(ctx, asiento.datos).enunciados);
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    // El mes del pago está cerrado: lo tumbó el trigger del periodo, no una
    // carrera. Decirle «vuelva a intentarlo» lo manda a fallar igual.
    if (/periodo_cerrado/.test(texto)) {
      return fallo(
        "periodo_cerrado",
        "el mes de este pago ya está cerrado: para confirmarlo hay que reabrir ese mes, y reabrir pide motivo",
      );
    }
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

// ---------------------------------------------------------------------------
// Leer · los comprobantes que esperan a una persona
// ---------------------------------------------------------------------------

export interface ComprobantePorConfirmar {
  readonly pagoId: string;
  readonly pedidoId: string;
  readonly numero: string;
  readonly cliente: string | null;
  readonly montoCents: number;
  readonly metodo: string;
  readonly tipo: string;
  /** La clave en R2 de la captura, si la hay. Se abre con otra ruta. */
  readonly comprobanteR2: string | null;
  readonly creadoEn: number;
  /** El total del pedido y lo que ya se cobró, para decidir sin salir de aquí. */
  readonly totalCents: number;
  readonly pagadoCents: number;
  readonly estadoPedido: string;
}

/** Cuántos a la vez. Más que esto no se revisa de una sentada. */
const TOPE = 100;

/**
 * La bandeja de comprobantes: lo que una persona tiene que mirar.
 *
 * Es la lista que hace útil la regla «el navegador no decide un pago». La
 * regla ya estaba y el panel no tenía dónde verla, así que un comprobante
 * entraba en `confirmando` y se quedaba ahí para siempre: nadie podía
 * confirmarlo porque no había pantalla ni ruta que lo hiciera.
 *
 * Trae el total y lo ya cobrado del pedido porque la decisión necesita las dos
 * cifras: «¿este abono de $30 completa el mínimo?» no se contesta mirando solo
 * el comprobante, y obligar a abrir el pedido en otra pestaña para cada uno es
 * cómo se confirma lo que no se debía.
 */
export async function comprobantesPorConfirmar(
  db: D1Database,
  limite = 50,
): Promise<Resultado<{ comprobantes: ComprobantePorConfirmar[]; hayMas: boolean }>> {
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > TOPE) {
    return fallo("entrada_invalida", `el límite va de 1 a ${TOPE}`);
  }

  // Se pide uno más del límite para saber si hay más SIN contar la tabla
  // entera: un COUNT(*) aparte es un segundo viaje que solo sirve para pintar
  // «y N más».
  const { results } = await db
    .prepare(
      `SELECT g.id, g.pedido_id, g.monto_cents, g.metodo, g.tipo, g.comprobante_r2, g.creado_en,
              p.numero, p.total_cents, p.pagado_cents, p.estado AS estado_pedido,
              cl.nombre AS cliente
         FROM pagos g
         JOIN pedidos p ON p.id = g.pedido_id
         LEFT JOIN clientes cl ON cl.id = p.cliente_id
        WHERE g.estado = 'confirmando'
        ORDER BY g.creado_en
        LIMIT ?`,
    )
    .bind(limite + 1)
    .all<{
      id: string;
      pedido_id: string;
      monto_cents: number;
      metodo: string;
      tipo: string;
      comprobante_r2: string | null;
      creado_en: number;
      numero: string;
      total_cents: number;
      pagado_cents: number;
      estado_pedido: string;
      cliente: string | null;
    }>();

  const hayMas = results.length > limite;
  return ok({
    comprobantes: results.slice(0, limite).map((f) => ({
      pagoId: f.id,
      pedidoId: f.pedido_id,
      numero: f.numero,
      cliente: f.cliente,
      montoCents: f.monto_cents,
      metodo: f.metodo,
      tipo: f.tipo,
      comprobanteR2: f.comprobante_r2,
      creadoEn: f.creado_en,
      totalCents: f.total_cents,
      pagadoCents: f.pagado_cents,
      estadoPedido: f.estado_pedido,
    })),
    hayMas,
  });
}
