import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { estadoDePagoSegunSaldo, puedeAgendar } from "../dominio/abonos";
import { bodegaQuePuede, componentesDe, enunciadosDeApartado } from "./pedidos";
import { enunciadosDeParada } from "./paradas";

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
  numero: string;
  estado: string;
  estado_pago: string;
  total_cents: number;
  pagado_cents: number;
  abono_minimo_cents: number;
  requiere_pago_total: number;
  vence_en: number | null;
}

const leer = (db: D1Database, pedidoId: string) =>
  db
    .prepare(
      `SELECT id, numero, estado, estado_pago, total_cents, pagado_cents,
              abono_minimo_cents, requiere_pago_total, vence_en
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
 * `cotizacion → por_abonar`: confirmar. **AQUÍ se aparta el inventario.**
 *
 * El dueño lo pidió al modelo de Odoo: una cotización, al confirmarse, SE
 * CONVIERTE en pedido. No se copia nada — es el mismo documento, con su mismo
 * número y sus mismos precios, cambiando de estado. Por eso esto es una
 * transición y no un `crearPedido` disfrazado.
 *
 * ## Lo que hace, y por qué en este orden
 *
 * 1. **Se comprueba que siga siendo una cotización y que no haya caducado.**
 *    Una cotización vencida no se confirma en silencio: el precio que lleva
 *    escrito podía valer hace tres semanas y ya no.
 *
 * 2. **Se resuelve la receta de los combos AHORA, no la del día de la
 *    cotización.** Es a propósito y es lo contrario de lo que hace un pedido.
 *    Un pedido congela lo apartado porque ya lo apartó; una cotización no
 *    apartó nada, así que lo que vale es la receta con la que se va a armar la
 *    caja de verdad — la de hoy.
 *
 * 3. **Se vuelve a elegir la bodega.** La que quedó anotada al cotizar era
 *    provisional (puede haberse elegido sin existencias, porque cotizar no
 *    exige tenerlas). Si la nueva es otra, la línea se corrige en el mismo
 *    batch, con su fila de control.
 *
 * 4. **Se aparta, con `enunciadosDeApartado`** — la MISMA función que usa
 *    `crearPedido`. Dos formas de apartar mercancía acabarían discrepando, y
 *    la que se equivoca del lado flojo es la que nadie revisa.
 *
 * 5. **Se transiciona, con `enunciadosDeTransicion`** — el camino que ya
 *    existía, con su `WHERE estado = 'cotizacion'` y su fila de control. No se
 *    escribe uno paralelo.
 *
 * Todo en UN batch: o la cotización pasa a pedido con su mercancía apartada, o
 * no pasa nada. Lo que no puede quedar es un pedido `por_abonar` sin reserva
 * —se vendería dos veces la misma caja— ni unas existencias apartadas para una
 * cotización que sigue siendo cotización.
 *
 * ## Si ya no hay existencias
 *
 * Se dice, nombrando el artículo, y **la cotización NO pasa a pedido**: se
 * queda donde estaba, intacta y confirmable mañana. Eso también es lo que se
 * pidió. Ningún asiento contable se escribe aquí: confirmar no es vender, y la
 * venta se sigue reconociendo al entregar.
 *
 * ## Qué impide que dos confirmaciones a la vez aparten el doble
 *
 * Y conviene decirlo, porque la fila de control de la transición NO lo
 * impide: comprueba que el pedido esté en `por_abonar`, y si otra petición ya
 * lo movió, eso es cierto aunque este batch no haya hecho nada. Es justo la
 * trampa nº 1 de `docs/TRAMPAS.md`, y por eso aquí no se añade un control
 * más: un control que pasa siempre hace creer que algo está vigilado.
 *
 * Lo que de verdad lo impide es la **llave primaria
 * `(linea_id, codigo, bodega_id)` de `pedido_linea_componentes`**. El segundo
 * batch intenta escribir la misma fila de lo apartado y revienta contra ella,
 * así que su `reservado` se deshace con él. Está probado directamente en
 * `test/cotizaciones.test.ts` («apartar dos veces lo mismo no se puede»),
 * porque desde esta función la guarda de arriba corta antes y la prueba no
 * llegaría a tocar la defensa de abajo (TRAMPAS §6).
 *
 * Queda un hueco estrecho y se dice en vez de taparlo a medias: si entre las
 * dos lecturas la mercancía se moviera de bodega, las dos confirmaciones
 * elegirían bodegas distintas, la llave no chocaría y se apartaría en las dos.
 * Para cerrarlo hace falta serializar por pedido —una columna de versión en la
 * condición del UPDATE, como en `enunciadosDeCobro`— y eso es un cambio del
 * camino común, no de las cotizaciones. PENDIENTE, anotado aquí.
 */
export async function confirmarCotizacion(
  ctx: ContextoTransicion,
  pedidoId: string,
  /**
   * Por qué se confirma. Opcional desde el panel —ahí el acto ya lo explica
   * todo: alguien tocó «Confirmar» con la clienta delante— y obligatorio
   * cuando la confirma el asistente, porque su catálogo exige un motivo a todo
   * lo que escribe. Queda en `pedido_eventos`.
   */
  motivo?: string,
): Promise<Resultado<{ confirmada: true; numero: string; apartadas: number }>> {
  const p = await leer(ctx.db, pedidoId);
  if (p === null) return fallo("no_encontrado", "no existe ese documento");

  if (p.estado !== "cotizacion") {
    // Dos causas distintas, dos mensajes distintos (TRAMPAS §10). «Ya se
    // confirmó» manda a mirar el pedido; «no es una cotización» manda a mirar
    // qué se abrió.
    return fallo(
      "transicion_invalida",
      p.estado === "por_abonar"
        ? `la cotización ${p.numero} ya se confirmó: hoy es un pedido esperando su abono`
        : `${p.numero} no es una cotización: está ${p.estado}`,
      { motivo: p.estado === "por_abonar" ? "ya_confirmada" : "no_es_cotizacion", estado: p.estado },
    );
  }

  if (p.vence_en !== null && p.vence_en <= ctx.ahora) {
    return fallo(
      "transicion_invalida",
      `la cotización ${p.numero} caducó: hay que hacerle una nueva con los precios de hoy`,
      { motivo: "caducada", vence_en: p.vence_en },
    );
  }

  const { results: lineas } = await ctx.db
    .prepare(
      `SELECT pl.id, pl.codigo, pl.cantidad, pl.bodega_id, v.es_combo
         FROM pedido_lineas pl
         JOIN variantes v ON v.codigo = pl.codigo
        WHERE pl.pedido_id = ?`,
    )
    .bind(pedidoId)
    .all<{ id: string; codigo: string; cantidad: number; bodega_id: string; es_combo: number }>();

  if (lineas.length === 0) {
    return fallo("entrada_invalida", `la cotización ${p.numero} no tiene líneas que confirmar`);
  }

  /**
   * Que no haya NADA apartado ya.
   *
   * Es una guarda, NO una fila de control, y la diferencia importa: una fila
   * de control que comprobara esto estaría comprobando algo que ya era cierto
   * antes del batch, o sea pasando siempre (TRAMPAS §1, la que ha mordido
   * tres veces). Aquí lo que hace falta es negarse ANTES de escribir.
   *
   * Si llegara a pasar —una cotización con componentes apartados— confirmarla
   * apartaría el doble y la cancelación posterior devolvería de menos. Es un
   * dato roto, y seguir adelante en silencio lo entierra.
   */
  const yaApartado = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id
        WHERE pl.pedido_id = ?`,
    )
    .bind(pedidoId)
    .first<{ n: number }>();
  if ((yaApartado?.n ?? 0) > 0) {
    return fallo(
      "interno",
      `la cotización ${p.numero} tiene inventario apartado, que una cotización no debería tener. No se confirma: avísele a Juan.`,
      { motivo: "cotizacion_con_apartado", componentes: yaApartado?.n ?? 0 },
    );
  }

  const enunciados = enunciadosDeTransicion(ctx, pedidoId, "cotizacion", "por_abonar", {
    totalCents: p.total_cents,
    ...(motivo === undefined ? {} : { motivo }),
  });
  let apartadas = 0;

  for (const l of lineas) {
    const componentes = await componentesDe(ctx.db, l.codigo, l.es_combo === 1, l.cantidad);
    if (componentes === null) {
      return fallo(
        "sin_stock",
        `el combo ${l.codigo} no tiene componentes: no se puede armar, así que la cotización ${p.numero} no se puede confirmar`,
      );
    }

    const bodegaId = await bodegaQuePuede(ctx.db, componentes);
    if (bodegaId === null) {
      // Lo que pidió el encargo, dicho con el nombre del artículo: así quien
      // lo lee sabe qué reponer en vez de recibir «no se pudo».
      return fallo(
        "sin_stock",
        l.es_combo === 1
          ? `ya no hay con qué armar ${l.cantidad} de ${l.codigo} en ninguna bodega. La cotización ${p.numero} sigue siendo cotización.`
          : `ya no hay ${l.cantidad} de ${l.codigo} en ninguna bodega. La cotización ${p.numero} sigue siendo cotización.`,
        { motivo: "sin_existencias_al_confirmar", codigo: l.codigo, cantidad: l.cantidad },
      );
    }

    // La bodega anotada al cotizar era provisional. Si hoy toca otra, la línea
    // se corrige aquí para que el panel y la entrega lean la misma.
    if (bodegaId !== l.bodega_id) {
      enunciados.push(
        ctx.db
          .prepare("UPDATE pedido_lineas SET bodega_id = ? WHERE id = ? AND pedido_id = ?")
          .bind(bodegaId, l.id, pedidoId),
        // Control de LO QUE ESTE BATCH ESCRIBIÓ: la línea tiene la bodega
        // nueva. Antes del batch era falso —por eso se emite solo cuando
        // cambia— así que esto sí detecta un UPDATE que no casó con nada.
        ctx.db
          .prepare(
            `INSERT INTO controles (id, regla, ok, creado_en)
             VALUES (?, ?, (SELECT COUNT(*) FROM pedido_lineas WHERE id = ? AND bodega_id = ?), ?)`,
          )
          .bind(ulid(ctx.ahora), `cotizacion:bodega:${l.codigo}`, l.id, bodegaId, ctx.ahora),
      );
    }

    for (const c of componentes) {
      enunciados.push(
        ...enunciadosDeApartado(ctx, {
          lineaId: l.id,
          codigo: c.codigo,
          bodegaId,
          cantidad: c.cantidad,
        }),
      );
      apartadas += 1;
    }
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    // Entre elegir la bodega y apartar, se metió otro pedido o alguien
    // confirmó esta misma cotización. Las dos cosas caen aquí y las dos se
    // arreglan igual: volver a intentarlo con el documento releído.
    const texto = e instanceof Error ? e.message : String(e);
    return /CHECK|controles/i.test(texto)
      ? fallo(
          "sin_stock",
          `alguien se llevó las últimas unidades mientras se confirmaba ${p.numero}. Sigue siendo cotización: inténtelo otra vez.`,
        )
      : fallo("interno", texto);
  }

  return ok({ confirmada: true, numero: p.numero, apartadas });
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
 * Se puede cancelar desde `cotizacion`, desde `por_abonar` y desde `agendado`.
 * Desde `en_ruta` no: el pedido ya salió y lo que corresponde es una entrega
 * fallida o una devolución, no un borrón.
 *
 * **Una cotización se cancela sin tocar los libros**, y no por una excepción
 * escrita aquí: no hubo venta, así que no hay asiento que revertir, y no
 * apartó nada, así que no hay reserva que devolver. El bucle de abajo
 * simplemente no encuentra nada que liberar, porque
 * `pedido_linea_componentes` está vacío para ella. Lo único que queda escrito
 * es el motivo, en `pedido_eventos`.
 *
 * Si hubo abono, el pedido queda en `estado_pago = abonado` a propósito: ese
 * dinero existe y alguien tiene que decidir si se devuelve o queda como
 * crédito. Ponerlo en `sin_pago` haría desaparecer la deuda del sistema. Una
 * cotización no puede tener abono: no se cobra lo que no se ha confirmado.
 */
export async function cancelar(
  ctx: ContextoTransicion,
  pedidoId: string,
  motivo: string,
): Promise<Resultado<{ cancelado: true; liberadas: number }>> {
  const p = await leer(ctx.db, pedidoId);
  if (p === null) return fallo("no_encontrado", "no existe ese pedido");
  if (p.estado !== "cotizacion" && p.estado !== "por_abonar" && p.estado !== "agendado") {
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

  /**
   * Y su ENTREGA. Cancelar el pedido y dejar el envío vivo manda a un
   * motorizado a la calle con un paquete que ya nadie quiere.
   *
   * La máquina de estados ya permitía `pendiente -> anulado` desde siempre.
   * Lo que no había era nadie que la llamara: `cancelar()` no tocaba `envios`
   * ni una vez. Es la trampa §12 —una pieza terminada que nadie llama— y aquí
   * se notaba solo el día que alguien cancelara un pedido ya agendado.
   *
   * Un envío `pendiente` todavía no es nada: sin motorizado, sin ruta, sin
   * nadie esperándolo. Ese se anula aquí mismo, en el MISMO batch que la
   * cancelación, para que no exista un instante con el pedido cancelado y la
   * entrega viva.
   *
   * Desde `asignado` en adelante NO se anula solo, y se prefiere no cancelar
   * el pedido a dejar las dos cosas a medias: ya hay una persona con una
   * tarea, o un paquete en la calle. Se dice qué hacer primero.
   */
  const { results: envios } = await ctx.db
    .prepare("SELECT id, estado, version FROM envios WHERE pedido_id = ?")
    .bind(pedidoId)
    .all<{ id: string; estado: string; version: number }>();

  const vivos = envios.filter((e) => e.estado !== "anulado" && e.estado !== "devuelto" && e.estado !== "entregado");
  const enMarcha = vivos.filter((e) => e.estado !== "pendiente");
  if (enMarcha.length > 0) {
    const cual = enMarcha[0];
    return fallo(
      "transicion_invalida",
      `este pedido ya tiene una entrega ${cual === undefined ? "" : cual.estado} y hay que resolverla ` +
        `antes de cancelarlo: sáquela de la ruta, o márquela fallida o devuelta si ya salió`,
    );
  }

  const enunciados = enunciadosDeTransicion(ctx, pedidoId, p.estado, "cancelado", { motivo });

  for (const e of vivos) {
    enunciados.push(
      ...enunciadosDeParada(ctx, e.id, "pendiente", "anulado", e.version, {
        nota: `el pedido se canceló: ${motivo}`,
      }),
    );
  }

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
