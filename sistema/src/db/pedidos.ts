import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { type ContextoDeLectura, leerVigentes } from "./ajustes";

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
 *
 * ## Y una cotización, que es este mismo documento sin apartar nada
 *
 * El dueño lo pidió «tomando el modelo de Odoo»: una cotización, al
 * confirmarse, SE CONVIERTE en pedido. Es el mismo documento cambiando de
 * estado, así que se crea con esta misma función y `entrada.cotizacion = true`
 * — no hay una `crearCotizacion` paralela que vuelva a decidir los precios, ni
 * una tabla aparte de la que haya que copiar las líneas al confirmar.
 *
 * Lo único que cambia la bandera es LO QUE NO HACE: no toca
 * `existencias.reservado`, no escribe `pedido_linea_componentes` y por tanto no
 * lleva ninguna fila de control de reserva. El apartado ocurre al confirmar
 * (`confirmarCotizacion` en `transiciones.ts`), que es la transición a
 * `por_abonar` y el único camino por el que este sistema aparta mercancía.
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
  /**
   * Por qué se hace, cuando quien lo hace es el asistente.
   *
   * Queda en `pedido_eventos.datos_json` del evento «creado». No es decorado:
   * el catálogo de herramientas EXIGE un motivo a todo lo que escribe
   * (`registro.test.ts`), y un parámetro que se pide y no se guarda sería
   * pedir una explicación para tirarla.
   */
  readonly motivo?: string;
  /**
   * `true` crea una COTIZACIÓN: el mismo documento, con sus precios ya puestos
   * por el servidor, pero sin apartar ni una caja.
   *
   * Es una bandera y no una función aparte porque el documento es el mismo
   * (modelo de Odoo): confirmarla no copia nada, solo cambia su estado.
   */
  readonly cotizacion?: boolean;
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
  /**
   * En qué estado nació: `cotizacion` o `por_abonar`.
   *
   * Va en la respuesta y no se deduce de la entrada porque la pantalla tiene
   * que decir dos cosas distintas —«ya está apartado el inventario» o «esto no
   * aparta nada todavía»— y deducirlo de lo que ELLA mandó es creerse a sí
   * misma en vez de al servidor.
   */
  readonly estado: "cotizacion" | "por_abonar";
  /** Si se apartó inventario. `false` en una cotización, siempre. */
  readonly aparto: boolean;
}

export interface ContextoPedido {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
  /** De `ajustes`, ya resueltos por quien llama: aquí no se inventa ninguno. */
  readonly abonoMinimoCents: number;
  /** Minutos que se le guarda el pedido sin abono. `null` = no vence. */
  readonly minutosParaAbonar: number | null;
  /**
   * Minutos que vale una COTIZACIÓN. `null` o ausente = no caduca sola.
   *
   * Sale de `ajustes.cotizacion_dias_validez`, que nace en `PENDIENTE`: nadie
   * ha confirmado cuántos días vale una cotización de Baby Caleb. Y PENDIENTE
   * no es cero ni es «una semana porque suena razonable»: con la clave sin
   * decidir la cotización se crea sin fecha de caducidad y la pantalla de
   * Ajustes dice que falta decidirlo.
   *
   * Es un campo aparte de `minutosParaAbonar` porque son dos relojes
   * distintos: uno mide cuánto se le GUARDA la mercancía a una clienta (y por
   * eso aprieta), el otro cuánto vale un precio que se le pasó por escrito.
   */
  readonly minutosDeValidezCotizacion?: number | null;
}

interface FilaVariante {
  es_combo: number;
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

// ---------------------------------------------------------------------------
// Apartar inventario: un solo sitio, dos momentos posibles
// ---------------------------------------------------------------------------

/** Lo que hay que quitar de lo libre, ya resuelto a piezas y a bodega. */
export interface Apartado {
  /** La línea del pedido de la que cuelga. */
  readonly lineaId: string;
  readonly codigo: string;
  readonly bodegaId: string;
  readonly cantidad: number;
}

/**
 * Los enunciados que APARTAN una pieza, y la prueba de que lo hicieron.
 *
 * Están aquí, en una función, porque se usan en DOS momentos: al crear un
 * pedido normal y al confirmar una cotización. Escribirlos dos veces sería
 * tener dos formas de apartar mercancía, y el día que una se corrigiera y la
 * otra no, el inventario diría una cosa distinta según por dónde entró la
 * venta. Es la razón por la que `confirmarCotizacion` no escribe su propio
 * camino: llama a este.
 *
 * Son tres enunciados y cada uno tiene su motivo:
 *
 * 1. `UPDATE existencias SET reservado = reservado + ?` — lo que aparta.
 *
 * 2. **La fila de control, mirando el estado YA CAMBIADO.** Lo que aporta,
 *    exactamente: que el UPDATE NO ENCUENTRE SU FILA. Un `UPDATE … WHERE
 *    codigo=? AND bodega_id=?` que no casa con nada no falla —afecta cero
 *    filas y sigue—, así que sin esto el pedido quedaría SIN NINGUNA RESERVA y
 *    nadie se enteraría hasta que faltara la mercancía. Pasa con una bodega
 *    que no tiene fila de existencias para ese código: recién creada, o un
 *    código que nunca estuvo ahí.
 *
 *    Reservar de más NO lo caza esta fila: lo caza el
 *    `CHECK (reservado <= fisico)` de la propia tabla `existencias`. Vale la
 *    pena tenerlo claro para no creer que esta línea protege algo que protege
 *    otra.
 *
 * 3. `pedido_linea_componentes` guarda LO APARTADO, no la receta de donde
 *    salió: la receta puede cambiar, y al cancelar hay que devolver
 *    exactamente lo que se quitó.
 */
export function enunciadosDeApartado(
  ctx: { readonly db: D1Database; readonly ahora: number },
  a: Apartado,
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare("UPDATE existencias SET reservado = reservado + ? WHERE codigo = ? AND bodega_id = ?")
      .bind(a.cantidad, a.codigo, a.bodegaId),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM existencias
                        WHERE codigo = ? AND bodega_id = ? AND fisico >= reservado), ?)`,
      )
      .bind(ulid(ctx.ahora), `reservar:${a.codigo}`, a.codigo, a.bodegaId, ctx.ahora),
    ctx.db
      .prepare(
        `INSERT INTO pedido_linea_componentes (linea_id,codigo,bodega_id,cantidad)
         VALUES (?,?,?,?)`,
      )
      .bind(a.lineaId, a.codigo, a.bodegaId, a.cantidad),
  ];
}

/**
 * Las piezas que hay que apartar para vender `cantidad` de `codigo`.
 *
 * Para una variante normal es ella misma; para un COMBO son sus componentes
 * con la receta YA MULTIPLICADA. Devuelve `null` cuando el combo no tiene
 * receta, que no es lo mismo que un combo de cero piezas: un combo sin
 * componentes no se puede armar, y dejarlo pasar crearía un documento que no
 * aparta NADA — la mercancía se vendería dos veces.
 *
 * Se lee en el momento de apartar, no antes: en una cotización eso es al
 * confirmar, y es lo correcto, porque la receta que vale es la del día en que
 * se saca la mercancía de la bodega.
 */
export async function componentesDe(
  db: D1Database,
  codigo: string,
  esCombo: boolean,
  cantidad: number,
): Promise<{ codigo: string; cantidad: number }[] | null> {
  if (!esCombo) return [{ codigo, cantidad }];

  const { results } = await db
    .prepare("SELECT codigo, cantidad FROM combo_componentes WHERE combo_codigo = ?")
    .bind(codigo)
    .all<{ codigo: string; cantidad: number }>();

  if (results.length === 0) return null;
  return results.map((r) => ({ codigo: r.codigo, cantidad: r.cantidad * cantidad }));
}

/**
 * Una bodega activa que tenga libre TODO lo que se le pide, o `null`.
 *
 * Tiene que poder con todos los componentes a la vez. Para una variante normal
 * eso es ella sola; para un combo son sus piezas, y repartirlo entre dos
 * bodegas sería una entrega que alguien tendría que armar a mano sin que el
 * sistema lo dijera.
 *
 * Esta lectura NO garantiza nada —entre leer y escribir cabe otro pedido—; lo
 * que garantiza es la fila de control de `enunciadosDeApartado`.
 */
export async function bodegaQuePuede(
  db: D1Database,
  componentes: readonly { codigo: string; cantidad: number }[],
): Promise<string | null> {
  const faltanEn = componentes
    .map(
      () =>
        "(SELECT COALESCE(SUM(e.fisico - e.reservado), 0) FROM existencias e WHERE e.codigo = ? AND e.bodega_id = b.id) < ?",
    )
    .join(" OR ");
  const valores = componentes.flatMap((c) => [c.codigo, c.cantidad]);

  const e = await db
    .prepare(`SELECT b.id AS id FROM bodegas b WHERE b.activa = 1 AND NOT (${faltanEn}) LIMIT 1`)
    .bind(...valores)
    .first<{ id: string }>();
  return e?.id ?? null;
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
  const esCotizacion = entrada.cotizacion === true;

  if (entrada.lineas.length === 0) {
    return fallo(
      "entrada_invalida",
      esCotizacion
        ? "una cotización sin líneas no cotiza nada"
        : "un pedido sin líneas no es un pedido",
    );
  }

  // ── Las líneas, con el precio y el nombre del SERVIDOR ────────────────────
  const resueltas: {
    codigo: string;
    nombre: string;
    cantidad: number;
    precioUnitCents: number;
    itbmsBp: number;
    bodegaId: string;
    /**
     * Lo que hay que apartar de verdad.
     *
     * Para una variante normal es ella misma. Para un COMBO son sus piezas,
     * con la receta YA MULTIPLICADA por lo pedido: lo que se guarda es lo
     * apartado, no la receta de donde salió, porque la receta puede cambiar y
     * al cancelar hay que devolver exactamente lo que se quitó.
     */
    componentes: { codigo: string; cantidad: number }[];
  }[] = [];

  for (const l of entrada.lineas) {
    if (!Number.isSafeInteger(l.cantidad) || l.cantidad <= 0) {
      return fallo("entrada_invalida", `la cantidad de ${l.codigo} tiene que ser un entero positivo`);
    }

    const v = await ctx.db
      .prepare(
        "SELECT codigo, nombre, precio_cents, tasa_itbms_bp, activo, es_combo FROM variantes WHERE codigo = ?",
      )
      .bind(l.codigo)
      .first<FilaVariante>();

    if (v === null) return fallo("no_encontrado", `no existe la variante ${l.codigo}`);
    if (v.activo !== 1) return fallo("entrada_invalida", `${l.codigo} no está activo`);

    // Un combo no tiene existencias propias: lo que se aparta son sus piezas.
    // La receta se lee AQUÍ y se congela en `componentes`; de ahí sale lo que
    // se guarda, y es lo que se devolverá al cancelar.
    //
    // En una cotización esto se lee igual —hace falta para saber si hay con
    // qué y en qué bodega— pero NO se guarda: la receta que vale es la del día
    // en que se saque la mercancía, y ese día es el de la confirmación.
    const componentes = await componentesDe(ctx.db, v.codigo, v.es_combo === 1, l.cantidad);
    if (componentes === null) {
      return fallo("sin_stock", `el combo ${l.codigo} no tiene componentes: no se puede armar`);
    }

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
      bodegaId = await bodegaQuePuede(ctx.db, componentes);

      // Y aquí está la diferencia que define una cotización: **que no haya
      // existencias NO la frena**. Cotizar es decir un precio, no apartar
      // mercancía, y negarse a cotizar lo que hoy está agotado es negarse
      // justo cuando la clienta pregunta si lo van a traer.
      //
      // Sin bodega que pueda se anota una activa cualquiera, y se anota
      // sabiendo que es provisional: al confirmar se vuelve a elegir con las
      // existencias de ESE momento (ver `confirmarCotizacion`). Si entonces no
      // hay, la confirmación falla y el documento se queda siendo una
      // cotización — que es exactamente lo que se pidió.
      if (bodegaId === null && esCotizacion) {
        const cualquiera = await ctx.db
          .prepare("SELECT id FROM bodegas WHERE activa = 1 LIMIT 1")
          .first<{ id: string }>();
        // Sin NINGUNA bodega activa no se puede ni cotizar: `bodega_id` es
        // NOT NULL y no hay nada honesto que escribir ahí.
        if (cualquiera === null) {
          return fallo("entrada_invalida", "no hay ninguna bodega activa donde anotar las líneas");
        }
        bodegaId = cualquiera.id;
      }

      if (bodegaId === null) {
        return fallo(
          "sin_stock",
          v.es_combo === 1
            ? `no hay con qué armar ${l.cantidad} de ${l.codigo} en ninguna bodega`
            : `no hay ${l.cantidad} de ${l.codigo} en ninguna bodega`,
        );
      }
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
      componentes,
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
  const estado = esCotizacion ? "cotizacion" : "por_abonar";

  // Dos relojes distintos para la misma columna, según lo que sea el
  // documento: cuánto vale la cotización, o cuánto se le guarda el apartado.
  // Los dos admiten `null` —«no caduca»— y en la cotización eso es lo normal
  // hoy, porque `cotizacion_dias_validez` está en PENDIENTE y PENDIENTE no se
  // rellena con un número que suene razonable.
  const minutos = esCotizacion
    ? (ctx.minutosDeValidezCotizacion ?? null)
    : ctx.minutosParaAbonar;
  const venceEn = minutos === null ? null : ctx.ahora + minutos * 60_000;

  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO pedidos (id,numero,token,cliente_id,origen,conversacion_ref,estado,estado_pago,
           direccion_id,zona_id,subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,
           pagado_cents,abono_minimo_cents,requiere_pago_total,vence_en,notas_cliente,creado_en,actualizado_en)
         VALUES (?,?,?,?,?,?,?,'sin_pago',?,?,?,?,0,?,?,0,?,?,?,?,?,?)`,
      )
      .bind(
        pedidoId, numero, token, entrada.clienteId, entrada.origen,
        entrada.conversacionRef ?? null, estado, entrada.direccionId ?? null, zonaId,
        subtotalCents, envioCents, itbmsCents, totalCents,
        ctx.abonoMinimoCents, requierePagoTotal ? 1 : 0, venceEn,
        entrada.notasCliente ?? null, ctx.ahora, ctx.ahora,
      ),
  ];

  for (const l of resueltas) {
    const lineaId = ulid(ctx.ahora);
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,itbms_bp,bodega_id)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(lineaId, pedidoId, l.codigo, l.nombre, l.cantidad, l.precioUnitCents, l.itbmsBp, l.bodegaId),
    );

    // Lo que se aparta. Para una variante normal es ella misma; para un combo,
    // sus piezas con la receta ya multiplicada.
    //
    // **Una cotización no entra aquí, y es lo esencial de todo el encargo.**
    // No se toca `existencias.reservado`, así que no hay nada que vigilar con
    // una fila de control, y no se escribe `pedido_linea_componentes`, que es
    // la tabla de LO APARTADO. Diez cotizaciones por la misma caja no mienten
    // sobre el inventario; diez pedidos, sí.
    if (!esCotizacion) {
      for (const c of l.componentes) {
        enunciados.push(
          ...enunciadosDeApartado(ctx, {
            lineaId,
            codigo: c.codigo,
            bodegaId: l.bodegaId,
            cantidad: c.cantidad,
          }),
        );
      }
    }
  }

  enunciados.push(
    ctx.db
      .prepare(
        `INSERT INTO pedido_eventos (id,pedido_id,tipo,de,a,actor,datos_json,creado_en)
         VALUES (?,?,'creado',NULL,?,?,?,?)`,
      )
      .bind(
        ulid(ctx.ahora),
        pedidoId,
        estado,
        ctx.actor,
        JSON.stringify({
          idempotencia: entrada.idempotencia,
          origen: entrada.origen,
          totalCents,
          ...(entrada.motivo === undefined ? {} : { motivo: entrada.motivo }),
        }),
        ctx.ahora,
      ),
  );

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    // Casi siempre es que no alcanzaba: entre elegir la bodega y reservar, se
    // metió otro pedido. El número de pedido ya se gastó y queda un hueco.
    //
    // En una cotización esto NO puede ser falta de existencias, porque no se
    // apartó nada: si el batch se cayó, es otra cosa, y decir «sin stock»
    // mandaría a quien lo lea a mirar la bodega en vez del error de verdad
    // (TRAMPAS §10: cada código de error nombra SU causa).
    const texto = e instanceof Error ? e.message : String(e);
    return !esCotizacion && /CHECK|controles/i.test(texto)
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
    estado,
    aparto: !esCotizacion,
  });
}

// ---------------------------------------------------------------------------
// Las reglas que `crearPedido` exige, resueltas
// ---------------------------------------------------------------------------

/**
 * Las reglas que `crearPedido` exige RESUELTAS.
 *
 * Esa función se niega a inventar ninguna —«aquí no se inventa ninguno», dice
 * su contrato— así que quien la llama tiene que leer los ajustes y traérselas.
 * Esto es ese paso, **en un solo sitio** para que la ruta del panel, la de la
 * web y la herramienta del asistente no acaben resolviéndolas distinto.
 *
 * Vivía dentro de `src/api/panel.ts`, atada a un `Context` de Hono, y por eso
 * no se podía reutilizar: la herramienta `crear_pedido` del asistente habría
 * tenido que escribir su propia copia de esta interpretación, y dos sitios
 * leyendo el mismo ajuste con criterio propio es exactamente cómo una regla del
 * negocio empieza a significar dos cosas. Ahora vive al lado de `crearPedido`,
 * que es quien la necesita.
 *
 * `abono_minimo_cents` NO admite PENDIENTE por diseño (su esquema lo dice), así
 * que siempre hay un número: el de la dueña, o el de fábrica.
 *
 * El plazo sale de `reserva_horas_comprobante` y no de
 * `reserva_minutos_pago_en_linea`, porque un pedido que toma la casa lo toma
 * una persona hablando con la clienta, y se paga con comprobante o en efectivo,
 * no por un enlace de pago. Con la clave sin decidir el plazo es `null` —«no
 * vence»—, que es un valor que el contrato de `crearPedido` contempla, no un
 * hueco: un pedido que tomó una persona no se cancela solo a espaldas de quien
 * lo tomó.
 */
export async function reglasDelPedido(
  ctx: ContextoDeLectura,
): Promise<
  Resultado<{
    abonoMinimoCents: number;
    minutosParaAbonar: number | null;
    minutosDeValidezCotizacion: number | null;
  }>
> {
  const r = await leerVigentes(ctx);
  if (!r.ok) return r;
  const de = (clave: string) => r.datos.ajustes.find((a) => a.clave === clave);

  const abono = de("abono_minimo_cents");
  if (abono === undefined || abono.pendiente || typeof abono.valor !== "number") {
    return fallo(
      "entrada_invalida",
      "falta decidir el abono mínimo. Está en Configuración › Ajustes.",
    );
  }

  const horas = de("reserva_horas_comprobante");
  const minutosParaAbonar =
    horas === undefined || horas.pendiente || typeof horas.valor !== "number"
      ? null
      : horas.valor * 60;

  // Cuánto vale una cotización. Nace PENDIENTE —nadie ha confirmado cuántos
  // días Baby Caleb mantiene un precio por escrito— y PENDIENTE no se rellena:
  // sin decidir, la cotización no caduca sola. Ese es el lado seguro, porque
  // una cotización vencida no se puede confirmar y un número inventado de
  // menos dejaría a la clienta con un papel que el sistema rechaza.
  const dias = de("cotizacion_dias_validez");
  const minutosDeValidezCotizacion =
    dias === undefined || dias.pendiente || typeof dias.valor !== "number"
      ? null
      : dias.valor * 24 * 60;

  return ok({ abonoMinimoCents: abono.valor, minutosParaAbonar, minutosDeValidezCotizacion });
}
