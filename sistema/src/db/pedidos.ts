import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";

/**
 * Crear un pedido (F4.2).
 *
 * Tres cosas que este archivo existe para garantizar, y que no son obvias:
 *
 * **1. El precio y el envío los pone el SERVIDOR.** Nunca llegan de fuera. Lo
 * que manda la web es qué códigos y cuántos; el resto se lee de `variantes` y
 * de `zonas_envio` aquí dentro. Si el precio viniera del navegador, cualquiera
 * podría comprar una caja a un centavo cambiando un número antes de enviar.
 *
 * **2. La reserva y el pedido entran o no entran JUNTOS.** D1 no tiene
 * transacciones interactivas: no se puede leer el stock, decidir, y escribir
 * con la garantía de que nadie se metió en medio. El patrón que lo resuelve es
 * la FILA DE CONTROL, el mismo del inventario: después de cada
 * `UPDATE existencias SET reservado = reservado + n` se inserta una fila cuyo
 * CHECK mira el estado YA CAMBIADO. Si el UPDATE no encontró su fila, o dejó
 * las existencias libres en negativo, el control sale 0 y el batch entero se
 * cae. No hay pedido sin reserva ni reserva sin pedido.
 *
 * **3. Las reglas se COPIAN al pedido.** El abono mínimo y si exige pago total
 * quedan escritos en la fila. Si la dueña cambia una regla el martes, el
 * pedido del lunes se cierra con la del lunes — una regla que cambia a mitad
 * de un pedido es una discusión con la clienta.
 */

export interface LineaPedida {
  readonly codigo: string;
  readonly cantidad: number;
  /** La bodega; si no viene, se elige la que tenga con qué. */
  readonly bodega?: string;
}

export interface PedidoNuevo {
  readonly idempotencia: string;
  readonly clienteId: string;
  readonly origen: "web" | "whatsapp" | "instagram" | "messenger" | "telegram" | "panel";
  readonly lineas: readonly LineaPedida[];
  /** El nombre de la zona de envío. Sin zona, el envío se cotiza aparte. */
  readonly zona?: string;
  readonly direccionId?: string;
  readonly conversacionRef?: string;
  readonly notasCliente?: string;
}

export interface PedidoCreado {
  readonly id: string;
  readonly numero: string;
  readonly token: string;
  readonly totalCents: number;
  readonly envioCents: number;
  readonly abonoMinimoCents: number;
  readonly requierePagoTotal: boolean;
  readonly venceEn: number | null;
}

export interface ContextoPedido {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
  /** De `ajustes`, ya resueltos por quien llama: aquí no se inventa ninguno. */
  readonly abonoMinimoCents: number;
  /** Minutos que se le guarda el pedido sin abono. `null` = no vence. */
  readonly minutosParaAbonar: number | null;
}

interface FilaVariante {
  codigo: string;
  nombre: string;
  precio_cents: number;
  tasa_itbms_bp: number | null;
  activo: number;
}

/**
 * El número que ve la clienta: `BC-000123`.
 *
 * Se saca ANTES del batch, con un `UPDATE … RETURNING` que es atómico: dos
 * pedidos a la vez no pueden llevarse el mismo. Si el batch falla después, ese
 * número se pierde y queda un hueco en la serie.
 *
 * El hueco es a propósito. La alternativa —calcular el número dentro del batch
 * para no perder ninguno— deja que dos pedidos simultáneos lean el mismo valor
 * y uno de los dos reviente contra el UNIQUE. Un hueco en la numeración no le
 * importa a nadie; dos pedidos con el mismo número sí.
 */
async function siguienteNumero(db: D1Database): Promise<number | null> {
  const f = await db
    .prepare("UPDATE secuencias SET valor = valor + 1 WHERE nombre = 'pedido' RETURNING valor")
    .first<{ valor: number }>();
  return f?.valor ?? null;
}

/** 256 bits en base64url: lo que abre el enlace de seguimiento. */
function tokenPublico(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function crearPedido(
  ctx: ContextoPedido,
  entrada: PedidoNuevo,
): Promise<Resultado<PedidoCreado>> {
  if (entrada.lineas.length === 0) {
    return fallo("entrada_invalida", "un pedido sin líneas no es un pedido");
  }

  // ── Las líneas, con el precio y el nombre del SERVIDOR ────────────────────
  const resueltas: {
    codigo: string;
    nombre: string;
    cantidad: number;
    precioUnitCents: number;
    itbmsBp: number;
    bodegaId: string;
  }[] = [];

  for (const l of entrada.lineas) {
    if (!Number.isSafeInteger(l.cantidad) || l.cantidad <= 0) {
      return fallo("entrada_invalida", `la cantidad de ${l.codigo} tiene que ser un entero positivo`);
    }

    const v = await ctx.db
      .prepare("SELECT codigo, nombre, precio_cents, tasa_itbms_bp, activo FROM variantes WHERE codigo = ?")
      .bind(l.codigo)
      .first<FilaVariante>();

    if (v === null) return fallo("no_encontrado", `no existe la variante ${l.codigo}`);
    if (v.activo !== 1) return fallo("entrada_invalida", `${l.codigo} no está activo`);

    // La bodega: la que digan, o la que tenga con qué. Se elige MIRANDO lo
    // libre, pero esa lectura no garantiza nada —entre leer y escribir cabe
    // otro pedido—; lo que garantiza es la fila de control de más abajo.
    let bodegaId: string | null = null;
    if (l.bodega !== undefined) {
      const b = await ctx.db
        .prepare("SELECT id FROM bodegas WHERE nombre = ? AND activa = 1")
        .bind(l.bodega)
        .first<{ id: string }>();
      if (b === null) return fallo("no_encontrado", `no existe la bodega «${l.bodega}»`);
      bodegaId = b.id;
    } else {
      const e = await ctx.db
        .prepare(
          `SELECT e.bodega_id AS id FROM existencias e
             JOIN bodegas b ON b.id = e.bodega_id
            WHERE e.codigo = ? AND b.activa = 1 AND e.fisico - e.reservado >= ?
            ORDER BY e.fisico - e.reservado DESC
            LIMIT 1`,
        )
        .bind(l.codigo, l.cantidad)
        .first<{ id: string }>();
      if (e === null) return fallo("sin_stock", `no hay ${l.cantidad} de ${l.codigo} en ninguna bodega`);
      bodegaId = e.id;
    }

    resueltas.push({
      codigo: v.codigo,
      nombre: v.nombre,
      cantidad: l.cantidad,
      precioUnitCents: v.precio_cents,
      // `tasa_itbms_bp` NULL significa PENDIENTE —la dueña todavía no lo
      // confirmó— y PENDIENTE no es cero. Pero un pedido necesita un número, y
      // cobrar un impuesto que nadie confirmó es peor que no cobrarlo: se
      // guarda 0 y la auditoría de `reglas.json` es la que tiene que gritar.
      itbmsBp: v.tasa_itbms_bp ?? 0,
      bodegaId,
    });
  }

  // ── El envío y si exige pago total, de la ZONA ────────────────────────────
  let envioCents = 0;
  let zonaId: string | null = null;
  let requierePagoTotal = false;

  if (entrada.zona !== undefined) {
    const z = await ctx.db
      .prepare("SELECT id, tarifa_cents, requiere_pago_total FROM zonas_envio WHERE nombre = ?")
      .bind(entrada.zona)
      .first<{ id: string; tarifa_cents: number | null; requiere_pago_total: number }>();
    if (z === null) return fallo("no_encontrado", `no existe la zona «${entrada.zona}»`);

    zonaId = z.id;
    requierePagoTotal = z.requiere_pago_total === 1;

    // Una zona SIN tarifa fija —Panamá Oeste, el interior— no se estima: el
    // pedido se crea con envío en cero y alguien lo cotiza. Poner un número a
    // ojo aquí es cobrarle a una clienta algo que nadie decidió.
    envioCents = z.tarifa_cents ?? 0;
  }

  const subtotalCents = resueltas.reduce((s, l) => s + l.precioUnitCents * l.cantidad, 0);
  const itbmsCents = resueltas.reduce(
    (s, l) => s + Math.round((l.precioUnitCents * l.cantidad * l.itbmsBp) / 10_000),
    0,
  );
  const totalCents = subtotalCents + envioCents + itbmsCents;

  const valor = await siguienteNumero(ctx.db);
  if (valor === null) return fallo("interno", "falta la secuencia de pedidos");

  const pedidoId = ulid(ctx.ahora);
  const numero = `BC-${String(valor).padStart(6, "0")}`;
  const token = tokenPublico();
  const venceEn =
    ctx.minutosParaAbonar === null ? null : ctx.ahora + ctx.minutosParaAbonar * 60_000;

  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO pedidos (id,numero,token,cliente_id,origen,conversacion_ref,estado,estado_pago,
           direccion_id,zona_id,subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,
           pagado_cents,abono_minimo_cents,requiere_pago_total,vence_en,notas_cliente,creado_en,actualizado_en)
         VALUES (?,?,?,?,?,?,'por_abonar','sin_pago',?,?,?,?,0,?,?,0,?,?,?,?,?,?)`,
      )
      .bind(
        pedidoId, numero, token, entrada.clienteId, entrada.origen,
        entrada.conversacionRef ?? null, entrada.direccionId ?? null, zonaId,
        subtotalCents, envioCents, itbmsCents, totalCents,
        ctx.abonoMinimoCents, requierePagoTotal ? 1 : 0, venceEn,
        entrada.notasCliente ?? null, ctx.ahora, ctx.ahora,
      ),
  ];

  for (const l of resueltas) {
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,itbms_bp,bodega_id)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(ulid(ctx.ahora), pedidoId, l.codigo, l.nombre, l.cantidad, l.precioUnitCents, l.itbmsBp, l.bodegaId),
      ctx.db
        .prepare("UPDATE existencias SET reservado = reservado + ? WHERE codigo = ? AND bodega_id = ?")
        .bind(l.cantidad, l.codigo, l.bodegaId),
      // La fila de control, mirando el estado YA CAMBIADO.
      //
      // Lo que aporta, exactamente: que el UPDATE NO ENCUENTRE SU FILA. Un
      // `UPDATE … WHERE codigo=? AND bodega_id=?` que no casa con nada no
      // falla — afecta cero filas y sigue—, así que sin esto el pedido se
      // crearía SIN NINGUNA RESERVA y nadie se enteraría hasta que faltara la
      // mercancía. Pasa con una bodega que no tiene fila de existencias para
      // ese código: recién creada, o un código que nunca estuvo ahí.
      //
      // Reservar de más NO lo caza esta fila: lo caza el
      // `CHECK (reservado <= fisico)` de la propia tabla `existencias`. Vale
      // la pena tenerlo claro para no creer que esta línea protege algo que
      // protege otra.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM existencias
                          WHERE codigo = ? AND bodega_id = ? AND fisico >= reservado), ?)`,
        )
        .bind(ulid(ctx.ahora), `reservar:${l.codigo}`, l.codigo, l.bodegaId, ctx.ahora),
    );
  }

  enunciados.push(
    ctx.db
      .prepare(
        `INSERT INTO pedido_eventos (id,pedido_id,tipo,de,a,actor,datos_json,creado_en)
         VALUES (?,?,'creado',NULL,'por_abonar',?,?,?)`,
      )
      .bind(
        ulid(ctx.ahora),
        pedidoId,
        ctx.actor,
        JSON.stringify({ idempotencia: entrada.idempotencia, origen: entrada.origen, totalCents }),
        ctx.ahora,
      ),
  );

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    // Casi siempre es que no alcanzaba: entre elegir la bodega y reservar, se
    // metió otro pedido. El número de pedido ya se gastó y queda un hueco.
    const texto = e instanceof Error ? e.message : String(e);
    return /CHECK|controles/i.test(texto)
      ? fallo("sin_stock", "alguien se llevó las últimas unidades mientras se creaba el pedido")
      : fallo("interno", texto);
  }

  return ok({
    id: pedidoId,
    numero,
    token,
    totalCents,
    envioCents,
    abonoMinimoCents: ctx.abonoMinimoCents,
    requierePagoTotal,
    venceEn,
  });
}
