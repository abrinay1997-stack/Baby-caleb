import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { formatear } from "../dominio/dinero";
import type { CobroCreado, OrdenDeCobro, PaymentProvider } from "../pagos/proveedor";
import { confirmarPago, rechazarPago, type ContextoPago } from "./pagos";

/**
 * El cobro en línea: iniciarlo y resolverlo (F4.12).
 *
 * Es la capa entre un adaptador de pasarela —que solo habla con su pasarela— y
 * la base. Aquí vive lo que protege el dinero, y se puede decir en una frase:
 *
 *   **La pasarela dice cuánto cobró. Nosotros decimos cuánto había que cobrar.
 *   Si los dos números no son el MISMO número, no se aprueba nada.**
 *
 * Sin esa comparación, una pasarela que conteste «aprobado» sobre una orden de
 * un dólar aprobaría un pedido de cincuenta. Y no hace falta que la pasarela
 * mienta: basta con que la orden se cree dos veces, que alguien manipule el
 * importe antes de que salga del navegador, o que una respuesta llegue con el
 * importe de OTRA orden. El monto es lo único que ata la respuesta al pedido.
 *
 * ## Por qué no hay webhook aquí
 *
 * Tilopay no tiene webhook en esta API: la clienta vuelve a nuestra página por
 * GET con unos parámetros que no se pueden verificar (el algoritmo del
 * `OrderHash` no es público). Así que la vuelta del navegador solo sirve para
 * saber QUÉ orden mirar. Quien decide es la consulta al servidor.
 *
 * Eso es la regla del CLAUDE.md —«el navegador no decide un pago»— llevada al
 * caso en que la pasarela no te da otra opción.
 */

/** Lo que hay que saber para arrancar un cobro. */
export interface CobroPorIniciar {
  readonly pedidoId: string;
  /** Debe casar con el CHECK de `pagos.proveedor`. */
  readonly proveedor: "tilopay" | "paypal" | "yappy";
  /** Cómo se llama en pantalla: «tarjeta», «Yappy». Texto libre. */
  readonly metodo: string;
  readonly tipo: "abono" | "total" | "saldo";
  readonly montoCents: number;
  /** A dónde vuelve la clienta, o a dónde manda la pasarela su aviso. */
  readonly urlAviso: string;
}

export interface CobroArrancado {
  readonly pagoId: string;
  /** NUESTRO número de orden hacia la pasarela (`pagos.intento_ref`). */
  readonly intentoRef: string;
  /** La página de pago a la que mandar la clienta, si la pasarela da una. */
  readonly redirectUrl?: string;
  /** Lo que necesita el componente del navegador, si lo hay. Sin secretos. */
  readonly datosBoton?: Readonly<Record<string, string>>;
}

interface FilaPedido {
  readonly id: string;
  readonly numero: string;
  readonly estado: string;
  readonly total_cents: number;
  readonly pagado_cents: number;
}

/**
 * Los estados de `pagos` desde los que un cobro en línea puede resolverse.
 *
 * `creado` entra además de `esperando_cliente` porque la pasarela puede
 * contestar antes de que nuestro UPDATE haya corrido —son dos escrituras
 * separadas por una llamada de red— y perder un pago bueno por llegar
 * demasiado pronto sería absurdo.
 */
const RESOLVIBLES = new Set(["creado", "esperando_cliente"]);

// ---------------------------------------------------------------------------
// Arrancar
// ---------------------------------------------------------------------------

/**
 * Crea el pago y le pide a la pasarela que cobre.
 *
 * El orden importa y no es el intuitivo: la fila de `pagos` se escribe ANTES
 * de llamar a la pasarela. Si se hiciera al revés, una llamada que sale bien y
 * una escritura que falla después dejarían un cobro vivo en la pasarela que no
 * existe en nuestra base: la clienta paga y aquí no hay ni rastro de a qué
 * pedido aplicarlo. Al revés —fila escrita, pasarela que falla— lo que queda
 * es una fila en `rechazado`, que es una anotación de lo que se intentó.
 */
export async function iniciarCobro<C, A, E extends string>(
  ctx: ContextoPago,
  c: CobroPorIniciar,
  pasarela: PaymentProvider<C, A, E>,
  credenciales: C,
): Promise<Resultado<CobroArrancado>> {
  if (!Number.isSafeInteger(c.montoCents) || c.montoCents <= 0) {
    return fallo("entrada_invalida", "el monto a cobrar tiene que ser un entero de centavos positivo");
  }

  const p = await ctx.db
    .prepare("SELECT id, numero, estado, total_cents, pagado_cents FROM pedidos WHERE id = ?")
    .bind(c.pedidoId)
    .first<FilaPedido>();
  if (p === null) return fallo("no_encontrado", "no existe ese pedido");

  /**
   * A QUÉ PEDIDOS SE LES PUEDE COBRAR. Lista blanca, no lista negra.
   *
   * Mi primera versión era una lista negra —«si está anulado o devuelto, no»—
   * y tenía dos fallos, uno encima del otro:
   *
   *  1. `'anulado'` NO EXISTE. El estado se llama `'cancelado'`, así que la
   *     comprobación no protegía de nada: a un pedido cancelado se le habría
   *     cobrado sin más. Lo encontró la prueba al intentar poner ese estado y
   *     chocar con el CHECK del esquema — la base sabía el nombre y yo no.
   *  2. Una lista negra falla hacia el lado caro. El día que alguien añada un
   *     estado nuevo, cobrar ahí queda permitido por omisión y nadie se enteró
   *     de que estaba decidiendo eso. Con lista blanca, el estado nuevo se
   *     niega hasta que alguien lo piense: lo que se rompe es un cobro que no
   *     se hace, no un cobro que no se debía hacer.
   *
   * `cotizacion` queda fuera a propósito aunque no esté cancelada: una
   * cotización NO aparta stock (F4 §cotizaciones), así que cobrarla sería
   * tomar dinero por mercancía que puede no estar cuando toque entregar. Se
   * confirma primero —y ahí se aparta— y después se cobra.
   */
  const COBRABLES = new Set(["por_abonar", "agendado", "en_ruta", "entregado"]);
  if (!COBRABLES.has(p.estado)) {
    return fallo(
      "transicion_invalida",
      p.estado === "cotizacion"
        ? `${p.numero} todavía es una cotización: hay que confirmarla antes de cobrarla, que es cuando se aparta la mercancía`
        : `el pedido ${p.numero} está ${p.estado}: no se le puede cobrar`,
    );
  }

  /**
   * NO SE COBRA MÁS DE LO QUE SE DEBE.
   *
   * Parece de manual y es el control que falta en la mitad de los checkouts:
   * sin él, un formulario manipulado o una ventana reenviada cobra dos veces
   * el total, y devolver dinero cuesta mucho más trabajo que no cobrarlo. El
   * saldo se calcula aquí y no se recibe de fuera.
   */
  const saldo = p.total_cents - p.pagado_cents;
  if (c.montoCents > saldo) {
    return fallo(
      "monto_no_coincide",
      saldo <= 0
        ? `el pedido ${p.numero} ya está pagado`
        : `ese pedido debe ${formatear(saldo)} y se intentó cobrar ${formatear(c.montoCents)}`,
    );
  }

  const pagoId = ulid(ctx.ahora);
  /**
   * El `intento_ref`, con el formato QUE ESA PASARELA ACEPTE.
   *
   * Lo decide el adaptador (`referenciaDeOrden`) porque las reglas son suyas:
   * Yappy solo acepta 1 a 15 caracteres alfanuméricos, y la referencia larga
   * de abajo —treinta y cinco, con guiones— la rechaza con un error que no
   * dice que el problema sea el largo. Generarla aquí para todas obligaba a
   * esta función a conocer los límites de cada pasarela; lo encontró la prueba
   * de punta a punta del aviso de Yappy.
   *
   * La de por defecto lleva el número del pedido DELANTE.
   *
   * Es lo que la dueña ve en el panel de Tilopay, y «BC-104-01K9…» le dice de
   * qué pedido es sin abrir nada. Un ULID a secas la obligaría a buscarlo aquí
   * para saber qué está mirando. Y el ULID detrás es lo que lo hace único
   * —`pagos.intento_ref` tiene UNIQUE— así que un reintento del mismo pedido
   * no choca con el anterior.
   */
  const intentoRef = pasarela.referenciaDeOrden?.(p.numero) ?? `${p.numero}-${pagoId}`;

  await ctx.db
    .prepare(
      `INSERT INTO pagos (id, pedido_id, proveedor, metodo, tipo, estado, monto_cents,
                          intento_ref, creado_en, actualizado_en)
       VALUES (?, ?, ?, ?, ?, 'creado', ?, ?, ?, ?)`,
    )
    .bind(
      pagoId,
      c.pedidoId,
      c.proveedor,
      c.metodo,
      c.tipo,
      c.montoCents,
      intentoRef,
      ctx.ahora,
      ctx.ahora,
    )
    .run();

  const orden: OrdenDeCobro = {
    ordenId: intentoRef,
    montoCents: c.montoCents,
    urlAviso: c.urlAviso,
  };

  let creado: Resultado<CobroCreado>;
  try {
    creado = await pasarela.createPayment(credenciales, orden);
  } catch (err) {
    // Un adaptador que revienta no deja el pago en el aire: queda anotado como
    // lo que fue, un intento que no llegó a ninguna parte.
    await marcarRechazado(ctx, pagoId, "la pasarela no contestó");
    return fallo("pasarela_no_disponible", err instanceof Error ? err.message : String(err));
  }

  if (!creado.ok) {
    await marcarRechazado(ctx, pagoId, creado.mensaje);
    return creado;
  }

  if (creado.datos.tipo === "ya_estaba") {
    /**
     * La pasarela dice que esa orden ya la tenía, con NUESTRA referencia nueva.
     * Eso no debería poder pasar —el `intento_ref` lleva un ULID— así que no se
     * finge que todo va bien: se anota y se dice.
     */
    await marcarRechazado(ctx, pagoId, "la pasarela dice que esa orden ya existía");
    return fallo(
      "repetido",
      "la pasarela dice que ese cobro ya existía. No se creó uno nuevo: revise en su panel antes de volver a intentarlo.",
    );
  }

  await ctx.db
    .prepare(
      `UPDATE pagos SET estado = 'esperando_cliente', proveedor_ref = ?, actualizado_en = ?
        WHERE id = ? AND estado = 'creado'`,
    )
    .bind(creado.datos.referencia, ctx.ahora, pagoId)
    .run();

  return ok({
    pagoId,
    intentoRef,
    ...(creado.datos.redirectUrl === undefined ? {} : { redirectUrl: creado.datos.redirectUrl }),
    ...(creado.datos.datosBoton === undefined ? {} : { datosBoton: creado.datos.datosBoton }),
  });
}

async function marcarRechazado(ctx: ContextoPago, pagoId: string, motivo: string): Promise<void> {
  await ctx.db
    .prepare(
      `UPDATE pagos SET estado = 'rechazado', confirmado_por = ?, confirmado_en = ?, actualizado_en = ?
        WHERE id = ? AND estado = 'creado'`,
    )
    .bind(`sistema: ${motivo}`.slice(0, 200), ctx.ahora, ctx.ahora, pagoId)
    .run();
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Lo que la pasarela contestó cuando se le preguntó por una orden. */
export interface LoQueDiceLaPasarela {
  readonly estado: "aprobado" | "rechazado" | "pendiente";
  /** Cuánto dice que cobró. `null` si no lo dijo o no se entendió. */
  readonly montoCents: number | null;
  readonly referencia: string | null;
  readonly comisionCents: number | null;
}

export type ComoQuedo =
  | { readonly resultado: "aprobado"; readonly pagadoCents: number; readonly agendado: boolean }
  | { readonly resultado: "rechazado" }
  | { readonly resultado: "pendiente" }
  /** Ya se había resuelto antes. Un reintento no lo vuelve a aplicar. */
  | { readonly resultado: "ya_estaba"; readonly estado: string };

/**
 * Aplica lo que contestó el SERVIDOR de la pasarela.
 *
 * No recibe nada del navegador. Lo que entra es la respuesta de una consulta
 * servidor a servidor, y lo que sale es lo que se escribió en la base.
 */
export async function resolverCobro(
  ctx: ContextoPago,
  intentoRef: string,
  dice: LoQueDiceLaPasarela,
): Promise<Resultado<ComoQuedo>> {
  const pago = await ctx.db
    .prepare(
      "SELECT id, pedido_id, monto_cents, estado, proveedor FROM pagos WHERE intento_ref = ?",
    )
    .bind(intentoRef)
    .first<{
      id: string;
      pedido_id: string;
      monto_cents: number;
      estado: string;
      proveedor: string;
    }>();
  if (pago === null) return fallo("no_encontrado", "no hay ningún cobro con esa referencia");

  /**
   * IDEMPOTENCIA, y por qué va ANTES de cualquier escritura.
   *
   * La clienta recarga la página de vuelta. O pulsa «atrás» y vuelve a entrar.
   * O la pasarela reintenta. Sin esto, el segundo paso sumaría el pago otra vez
   * al pedido y la clienta aparecería habiendo pagado el doble.
   */
  if (!RESOLVIBLES.has(pago.estado)) {
    return ok({ resultado: "ya_estaba", estado: pago.estado });
  }

  await anotarEvento(ctx, pago.proveedor, intentoRef, dice);

  if (dice.estado === "pendiente") {
    // No se toca el pago: sigue esperando. Lo que NO se hace es cerrarlo, que
    // es lo que haría perder un pago que todavía puede entrar.
    return ok({ resultado: "pendiente" });
  }

  if (dice.estado === "rechazado") {
    const aConfirmando = await aEstadoConfirmando(ctx, pago.id);
    if (!aConfirmando) return ok({ resultado: "ya_estaba", estado: "otro" });
    const r = await rechazarPago(ctx, pago.id, "la pasarela no autorizó el pago");
    return r.ok ? ok({ resultado: "rechazado" }) : r;
  }

  /**
   * AQUÍ ESTÁ EL CONTROL QUE IMPORTA.
   *
   * «Aprobado» no alcanza. Tiene que ser aprobado POR NUESTRO MONTO, al
   * centavo. Los dos casos que esto ataja:
   *
   *  · La pasarela no dijo cuánto (`null`). Aprobar sin saber el importe es
   *    aprobar a ciegas: si la respuesta fuera de otra orden, nadie lo notaría.
   *  · Dijo otra cantidad. Un pedido de $50 aprobado con un cobro de $1 es la
   *    forma más barata de robarle a la tienda, y no requiere tocar nada
   *    nuestro: basta con crear la orden por otro importe.
   *
   * En los dos casos el pago se queda donde está —ni aprobado ni rechazado— y
   * una PERSONA lo mira. Cerrarlo automáticamente sería peor: si el dinero
   * entró de verdad, un rechazo automático deja a la clienta pagando sin
   * pedido y sin nadie mirando.
   */
  if (dice.montoCents === null) {
    return fallo(
      "monto_no_coincide",
      `la pasarela aprobó el cobro ${intentoRef} pero no dijo por cuánto. No se aplicó: revíselo en el panel de la pasarela.`,
    );
  }
  if (dice.montoCents !== pago.monto_cents) {
    return fallo(
      "monto_no_coincide",
      `la pasarela aprobó ${formatear(dice.montoCents)} y aquí ese cobro es de ${formatear(pago.monto_cents)}. No se aplicó: revíselo en el panel de la pasarela.`,
    );
  }

  // La comisión que REPORTA la pasarela, antes de confirmar: así queda escrita
  // aunque la confirmación falle por una carrera y haya que reintentarla.
  if (dice.comisionCents !== null) {
    await ctx.db
      .prepare("UPDATE pagos SET comision_cents = ?, actualizado_en = ? WHERE id = ?")
      .bind(dice.comisionCents, ctx.ahora, pago.id)
      .run();
  }
  if (dice.referencia !== null) {
    await ctx.db
      .prepare("UPDATE pagos SET proveedor_ref = ?, actualizado_en = ? WHERE id = ?")
      .bind(dice.referencia, ctx.ahora, pago.id)
      .run();
  }

  const aConfirmando = await aEstadoConfirmando(ctx, pago.id);
  if (!aConfirmando) {
    // Otro proceso lo movió entre nuestro SELECT y este UPDATE. No es un error:
    // es la carrera que la idempotencia existe para absorber.
    const ahoraEsta = await ctx.db
      .prepare("SELECT estado FROM pagos WHERE id = ?")
      .bind(pago.id)
      .first<{ estado: string }>();
    return ok({ resultado: "ya_estaba", estado: ahoraEsta?.estado ?? "otro" });
  }

  const r = await confirmarPago(ctx, pago.id);
  if (!r.ok) return r;
  return ok({
    resultado: "aprobado",
    pagadoCents: r.datos.pagadoCents,
    agendado: r.datos.agendado,
  });
}

/**
 * `esperando_cliente` (o `creado`) → `confirmando`, con guardia.
 *
 * `confirmarPago` y `rechazarPago` exigen `confirmando` a propósito: es el
 * estado que significa «una decisión está en curso sobre este pago». El
 * `WHERE … IN (…)` es lo que hace que dos vueltas simultáneas no confirmen
 * dos veces: la segunda afecta cero filas y se va por el camino de la carrera.
 */
async function aEstadoConfirmando(ctx: ContextoPago, pagoId: string): Promise<boolean> {
  const r = await ctx.db
    .prepare(
      `UPDATE pagos SET estado = 'confirmando', actualizado_en = ?
        WHERE id = ? AND estado IN ('creado', 'esperando_cliente')`,
    )
    .bind(ctx.ahora, pagoId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Deja constancia de lo que contestó la pasarela.
 *
 * `eventos_pasarela` tiene `UNIQUE (proveedor, evento_id)`, así que el segundo
 * aviso idéntico choca. Se ignora ese choque a propósito —`OR IGNORE`— porque
 * la idempotencia de verdad la da el estado del pago, que se mira arriba;
 * esta tabla es la bitácora, y una bitácora que tumba la operación por
 * duplicarse no protege nada, estorba.
 *
 * `firma_valida` es 1 porque esto NO viene del navegador: viene de una
 * consulta servidor a servidor con nuestras credenciales. Esa consulta ES la
 * verificación. Si algún día entra un webhook de verdad, su firma se comprueba
 * y este valor dejará de ser siempre 1 — por eso la columna existe.
 */
async function anotarEvento(
  ctx: ContextoPago,
  proveedor: string,
  intentoRef: string,
  dice: LoQueDiceLaPasarela,
): Promise<void> {
  const cuerpo = JSON.stringify({
    estado: dice.estado,
    montoCents: dice.montoCents,
    referencia: dice.referencia,
    comisionCents: dice.comisionCents,
  });
  await ctx.db
    .prepare(
      `INSERT OR IGNORE INTO eventos_pasarela
         (id, proveedor, evento_id, firma_valida, cuerpo_sha256, resultado, recibido_en)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      ulid(ctx.ahora),
      proveedor,
      `consulta:${intentoRef}:${dice.estado}`,
      await sha256(cuerpo),
      dice.estado,
      ctx.ahora,
    )
    .run();
}

async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
