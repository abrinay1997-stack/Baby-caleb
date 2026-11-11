import { ulid } from "../ids";
import { type Resultado, fallo, ok } from "../contrato/resultado";
import {
  type Asiento,
  type Balance,
  type EstadoDeResultados,
  type Hecho,
  type Hueco,
  type Origen,
  type SaldoDeCuenta,
  type Tramo,
  HUECOS,
  ajusteDeRedondeo,
  asientoContrario,
  balance,
  codigoDeCaja,
  conSaldoNatural,
  cuentaDelPlan,
  diasEntre,
  estadoDeResultados,
  fechaContable,
  mesDe,
  rangoDelMes,
  tramoDeAntiguedad,
} from "../dominio/contabilidad";
import { esPendiente } from "../dominio/ajustes";
import { leerVigentes } from "./ajustes";

/**
 * Escribir los asientos y leer los libros (F5.1 y F5.8).
 *
 * El dominio (`src/dominio/contabilidad.ts`) decide QUÉ asiento genera cada
 * hecho; aquí se escribe, y se escribe de una sola manera:
 *
 *   1. el asiento,
 *   2. sus líneas,
 *   3. la fila de `control_cuadre`, calculada SOBRE LAS LÍNEAS QUE ACABA DE
 *      ESCRIBIR ESE MISMO BATCH.
 *
 * El punto 3 es el que importa y es la lección que este proyecto ya pagó tres
 * veces: una fila de control solo vale si comprueba los valores que ESE batch
 * escribió. Aquí el id del asiento es nuevo, así que todas las líneas que suma
 * son de este batch; un control que mirara «¿hay asientos que cuadren?» pasaría
 * siempre y no protegería nada.
 *
 * **Los enunciados se devuelven, no se ejecutan.** `enunciadosDeAsiento` existe
 * para que el asiento entre en el MISMO batch que el hecho que lo provoca: un
 * pago confirmado y su asiento, una entrega y su costo. Si fueran dos
 * escrituras, un corte en medio dejaría dinero cobrado sin asiento —o un
 * asiento de un cobro que no pasó—, y eso no se descubre hasta el cierre.
 */

export interface ContextoContable {
  readonly db: D1Database;
  readonly ahora: number;
  /** Quién lo hizo. Sale de la sesión, nunca del cuerpo de la petición. */
  readonly actor: string;
}

/** Leer no necesita saber quién pregunta: un saldo es el mismo para todos. */
export type ContextoDeLectura = Pick<ContextoContable, "db" | "ahora">;

// ---------------------------------------------------------------------------
// Escribir
// ---------------------------------------------------------------------------

/**
 * Los enunciados de un asiento, para meterlos en el batch de quien llama.
 *
 * La cuenta se busca por su CÓDIGO dentro del propio INSERT
 * (`(SELECT id FROM cuentas WHERE codigo = ?)`) en vez de leerla antes. Dos
 * motivos: una lectura previa es un viaje más a la base por cada línea, y si el
 * código no existe la subconsulta da NULL, el `NOT NULL` de `cuenta_id` salta y
 * el batch entero se cae — que es exactamente lo que tiene que pasar. Con una
 * lectura previa habría que acordarse de comprobar el resultado.
 */
export function enunciadosDeAsiento(
  ctx: ContextoContable,
  a: Asiento,
): { asientoId: string; enunciados: D1PreparedStatement[] } {
  const asientoId = ulid(ctx.ahora);

  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO asientos (id,fecha,descripcion,origen,hecho,referencia_tipo,referencia_id,
           revierte_id,creado_por,creado_en)
         VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
      )
      .bind(
        asientoId,
        a.fecha,
        a.descripcion,
        a.origen,
        a.hecho,
        a.referencia?.tipo ?? null,
        a.referencia?.id ?? null,
        ctx.actor,
        ctx.ahora,
      ),
  ];

  for (const l of a.lineas) {
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO asiento_lineas (id,asiento_id,cuenta_id,debe_cents,haber_cents,detalle)
           VALUES (?,?,(SELECT id FROM cuentas WHERE codigo = ?),?,?,?)`,
        )
        .bind(ulid(ctx.ahora), asientoId, l.cuenta, l.debeCents, l.haberCents, l.detalle),
    );
  }

  enunciados.push(
    // El cuadre, sobre las líneas de ESTE asiento y de este batch. Si la suma
    // no da cero, el CHECK de `control_cuadre` tumba el batch; si no hay ni una
    // línea, `SUM` de cero filas es NULL y lo tumba el NOT NULL.
    ctx.db
      .prepare(
        `INSERT INTO control_cuadre (asiento_id, diferencia)
         SELECT ?1, SUM(debe_cents) - SUM(haber_cents) FROM asiento_lineas WHERE asiento_id = ?1`,
      )
      .bind(asientoId),
  );

  return { asientoId, enunciados };
}

/** Traduce lo que puede fallar al escribir un asiento. */
function comoSeLee(err: unknown): Resultado<never> {
  const texto = err instanceof Error ? err.message : String(err);
  if (/periodo_cerrado/.test(texto)) {
    return fallo(
      "periodo_cerrado",
      "ese mes ya está cerrado: para registrar algo con esa fecha hay que reabrirlo, y reabrir pide motivo",
    );
  }
  if (/ya está cuadrado/.test(texto)) {
    return fallo("repetido", "ese asiento ya está terminado: lo que falte va en otro asiento");
  }
  if (/control_cuadre/.test(texto)) {
    // No debería llegar aquí: el dominio ya cuadró el asiento antes. Si pasa,
    // es un fallo del código y no del dato, y vale más decirlo así.
    return fallo("interno", "el asiento no cuadró al escribirlo; no se guardó nada");
  }
  if (/NOT NULL.*cuenta_id|FOREIGN KEY/i.test(texto)) {
    return fallo("entrada_invalida", "alguna cuenta del asiento no existe en la base");
  }
  if (/UNIQUE/i.test(texto)) {
    return fallo("repetido", "ese asiento ya estaba registrado");
  }
  return fallo("interno", texto);
}

/** Escribe un asiento solo. Si va con otro hecho, use `enunciadosDeAsiento`. */
export async function registrarAsiento(
  ctx: ContextoContable,
  a: Asiento,
): Promise<Resultado<{ asientoId: string }>> {
  const { asientoId, enunciados } = enunciadosDeAsiento(ctx, a);
  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    return comoSeLee(err);
  }
  return ok({ asientoId });
}

/**
 * La caja de un motorizado (1104-xx), creada cuando hace falta.
 *
 * `INSERT OR IGNORE`: llamarlo dos veces no es un error, es el segundo cobro
 * del mismo motorizado. Se devuelven enunciados para que la cuenta nazca en el
 * MISMO batch que el primer cobro que la usa — si fueran dos escrituras, un
 * corte en medio dejaría un cobro apuntando a una cuenta que no existe.
 */
export function enunciadosDeCuentaDeMotorizado(
  ctx: ContextoContable,
  motorizadoId: string,
  nombre: string,
): D1PreparedStatement[] {
  const codigo = codigoDeCaja(motorizadoId);
  return [
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO cuentas (id,codigo,nombre,tipo,subtipo,motorizado_id,activa)
         VALUES (?,?,?,'activo','caja_motorizado',?,1)`,
      )
      .bind(`cta-${codigo}`, codigo, `Caja de ${nombre}`, motorizadoId),
  ];
}

export async function cuentaDeMotorizado(
  ctx: ContextoContable,
  motorizadoId: string,
): Promise<Resultado<{ codigo: string }>> {
  const m = await ctx.db
    .prepare("SELECT nombre FROM motorizados WHERE id = ?")
    .bind(motorizadoId)
    .first<{ nombre: string }>();
  if (m === null) return fallo("no_encontrado", "no existe ese motorizado");

  try {
    await ctx.db.batch(enunciadosDeCuentaDeMotorizado(ctx, motorizadoId, m.nombre));
  } catch (err) {
    return comoSeLee(err);
  }
  return ok({ codigo: codigoDeCaja(motorizadoId) });
}

interface FilaAsiento {
  id: string;
  fecha: string;
  descripcion: string;
  origen: string;
  hecho: string;
  referencia_tipo: string | null;
  referencia_id: string | null;
  revierte_id: string | null;
  creado_por: string;
  creado_en: number;
}

/**
 * Corregir un asiento equivocado: se registra el contrario (05 §3).
 *
 * No se edita ni se borra nada — los triggers de la 0011 no lo permiten, y por
 * eso esto es el único camino. El `revierte_id` es UNIQUE, así que un asiento
 * se revierte UNA vez: dos reversos del mismo error descontarían el doble y los
 * dos cuadrarían por separado, así que nada lo delataría.
 */
export async function revertirAsiento(
  ctx: ContextoContable,
  asientoId: string,
  motivo: string,
): Promise<Resultado<{ asientoId: string }>> {
  const original = await ctx.db
    .prepare(
      `SELECT id, fecha, descripcion, origen, hecho, referencia_tipo, referencia_id,
              revierte_id, creado_por, creado_en
         FROM asientos WHERE id = ?`,
    )
    .bind(asientoId)
    .first<FilaAsiento>();
  if (original === null) return fallo("no_encontrado", "no existe ese asiento");

  const { results: lineas } = await ctx.db
    .prepare(
      `SELECT c.codigo, l.debe_cents, l.haber_cents, l.detalle
         FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
        WHERE l.asiento_id = ? ORDER BY l.id`,
    )
    .bind(asientoId)
    .all<{ codigo: string; debe_cents: number; haber_cents: number; detalle: string | null }>();

  const propuesta = asientoContrario(
    {
      descripcion: original.descripcion,
      origen: original.origen as Origen,
      referencia:
        original.referencia_tipo === null || original.referencia_id === null
          ? null
          : { tipo: original.referencia_tipo, id: original.referencia_id },
      lineas: lineas.map((l) => ({
        cuenta: l.codigo,
        debeCents: l.debe_cents,
        haberCents: l.haber_cents,
        detalle: l.detalle,
      })),
    },
    fechaContable(ctx.ahora),
    motivo,
  );
  if (!propuesta.ok) return propuesta;

  const { asientoId: nuevoId, enunciados } = enunciadosDeAsiento(ctx, propuesta.datos);
  // El `revierte_id` se pone en el mismo INSERT y no con un UPDATE después:
  // los asientos no se editan, así que un UPDATE rebotaría contra el trigger.
  // Se reemplaza el primer enunciado por el mismo INSERT con el enlace puesto.
  enunciados[0] = ctx.db
    .prepare(
      `INSERT INTO asientos (id,fecha,descripcion,origen,hecho,referencia_tipo,referencia_id,
         revierte_id,creado_por,creado_en)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      nuevoId,
      propuesta.datos.fecha,
      propuesta.datos.descripcion,
      propuesta.datos.origen,
      propuesta.datos.hecho,
      propuesta.datos.referencia?.tipo ?? null,
      propuesta.datos.referencia?.id ?? null,
      asientoId,
      ctx.actor,
      ctx.ahora,
    );

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const r = comoSeLee(err);
    // El UNIQUE de `revierte_id`: alguien ya corrigió este asiento.
    return !r.ok && r.codigo === "repetido"
      ? fallo("repetido", "ese asiento ya fue corregido con un contrario")
      : r;
  }
  return ok({ asientoId: nuevoId });
}

// ---------------------------------------------------------------------------
// El residuo del costo promedio (asiento 18)
// ---------------------------------------------------------------------------

export interface ResiduoDeInventario {
  readonly codigo: string;
  readonly residuoCents: number;
}

export interface RedondeoAjustado extends ResiduoDeInventario {
  readonly asientoId: string;
}

/**
 * Las variantes que se quedaron con centavos de inventario y sin unidades.
 *
 * El costo de una salida es `round(valor_cents × q / unidades)` (05 §4), así
 * que cuando las unidades llegan a cero puede quedar un residuo en
 * `valor_cents`: inventario que ya no existe. `marcarEntregada` lo deja ahí a
 * propósito —«los centavos de redondeo los ajusta el asiento 18»— porque
 * inventarse un ajuste en medio de una entrega le metería al costo de ESA venta
 * un centavo que no es suyo.
 */
export async function residuosPorAjustar(
  ctx: ContextoDeLectura,
): Promise<ResiduoDeInventario[]> {
  const { results } = await ctx.db
    .prepare(
      "SELECT codigo, valor_cents FROM valor_inventario WHERE unidades = 0 AND valor_cents <> 0",
    )
    .all<{ codigo: string; valor_cents: number }>();
  return results.map((v) => ({ codigo: v.codigo, residuoCents: v.valor_cents }));
}

/**
 * El asiento 18 de un residuo, con la bajada del valor y su control.
 *
 * Se devuelve en vez de ejecutarse, como todo en este archivo, y aquí además
 * por una razón concreta: es lo que permite PROBAR las dos carreras de abajo
 * contra los enunciados de verdad en vez de contra una copia escrita a mano en
 * la prueba —una copia que seguiría pasando si estos enunciados cambiaran—.
 *
 * ## Las dos carreras, y qué cierra cada una
 *
 * **Otro proceso limpió el mismo residuo primero.** La resta va SIN guarda de
 * valor en el `WHERE`: `valor_cents = valor_cents - residuo`. Si ya estaba en
 * cero, la resta lo deja en negativo y el `CHECK (valor_cents >= 0)` de la tabla
 * tumba el batch entero, asiento incluido. La tabla es más fiable que un `WHERE`
 * porque no se puede olvidar.
 *
 * **Llegó una compra en medio y la variante ya no está en cero unidades.** Ahí
 * el `WHERE` no casa, el UPDATE cambia cero filas —y un UPDATE que no casa NO
 * falla— así que el asiento entraría solo, llevándose al costo un residuo que
 * sigue puesto. Eso lo caza la fila de control, que mira lo que ESTE batch
 * escribió: esa variante en cero unidades Y en cero valor.
 *
 * Las DOS cosas en el control, y no solo el valor: si pasaran las dos a la vez
 * —otro se llevó el residuo y además entró mercancía— el valor estaría en cero
 * sin que este batch hubiera hecho nada, el CHECK no tendría nada que restar de
 * más, y un control que solo mirara el valor dejaría entrar el asiento cobrando
 * por segunda vez lo que ya se cobró. Lo probé quitando esa parte: entraba. Hay
 * una prueba que lo fija.
 */
export function enunciadosDeAjusteDeRedondeo(
  ctx: ContextoContable,
  r: ResiduoDeInventario,
): Resultado<{ asientoId: string; enunciados: D1PreparedStatement[] }> {
  const propuesta = ajusteDeRedondeo({
    fecha: fechaContable(ctx.ahora),
    referencia: { tipo: "variante", id: r.codigo },
    residuoCents: r.residuoCents,
    codigo: r.codigo,
  });
  if (!propuesta.ok) return propuesta;

  const { asientoId, enunciados } = enunciadosDeAsiento(ctx, propuesta.datos);
  return ok({
    asientoId,
    enunciados: [
      ...enunciados,
      ctx.db
        .prepare(
          "UPDATE valor_inventario SET valor_cents = valor_cents - ? WHERE codigo = ? AND unidades = 0",
        )
        .bind(r.residuoCents, r.codigo),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, 'inventario:residuo',
                   (SELECT COUNT(*) FROM valor_inventario
                     WHERE codigo = ? AND unidades = 0 AND valor_cents = 0), ?)`,
        )
        .bind(ulid(ctx.ahora), r.codigo, ctx.ahora),
    ],
  });
}

/**
 * Limpia los centavos de redondeo que dejó el costo promedio (asiento 18).
 *
 * Es idempotente: si no queda residuo, no hay nada que ajustar y no se escribe
 * ningún asiento. Un asiento de cero centavos no corrige nada y ensucia el
 * libro.
 */
export async function ajustarRedondeoDeInventario(
  ctx: ContextoContable,
): Promise<Resultado<{ ajustes: RedondeoAjustado[] }>> {
  const residuos = await residuosPorAjustar(ctx);
  const ajustes: RedondeoAjustado[] = [];

  for (const r of residuos) {
    const paso = enunciadosDeAjusteDeRedondeo(ctx, r);
    if (!paso.ok) return paso;
    try {
      await ctx.db.batch(paso.datos.enunciados);
    } catch (err) {
      return comoSeLee(err);
    }
    ajustes.push({ ...r, asientoId: paso.datos.asientoId });
  }

  return ok({ ajustes });
}

// ---------------------------------------------------------------------------
// Leer · saldos y movimientos
// ---------------------------------------------------------------------------

interface FilaSaldo {
  codigo: string;
  nombre: string;
  tipo: string;
  subtipo: string | null;
  debe: number;
  haber: number;
}

const aSaldos = (filas: readonly FilaSaldo[]): SaldoDeCuenta[] =>
  filas.map((f) =>
    conSaldoNatural({
      codigo: f.codigo,
      nombre: f.nombre,
      tipo: f.tipo as SaldoDeCuenta["tipo"],
      subtipo: f.subtipo,
      debeCents: f.debe,
      haberCents: f.haber,
    }),
  );

/**
 * El SALDO de cada cuenta al día X: todo lo anotado hasta ese día, inclusive.
 *
 * El filtro de fecha va DENTRO del `SUM` y no en el `WHERE`: con un `WHERE
 * a.fecha <= ?` las cuentas sin un solo movimiento desaparecerían de la lista,
 * y una cuenta que desaparece es una que nadie vuelve a mirar (y el balance
 * dejaría de poder decir «esta está en cero»).
 */
export async function saldosAl(ctx: ContextoDeLectura, hasta: string): Promise<SaldoDeCuenta[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT c.codigo, c.nombre, c.tipo, c.subtipo,
              COALESCE(SUM(CASE WHEN a.fecha <= ?1 THEN l.debe_cents END), 0)  AS debe,
              COALESCE(SUM(CASE WHEN a.fecha <= ?1 THEN l.haber_cents END), 0) AS haber
         FROM cuentas c
         LEFT JOIN asiento_lineas l ON l.cuenta_id = c.id
         LEFT JOIN asientos a ON a.id = l.asiento_id
        GROUP BY c.id, c.codigo, c.nombre, c.tipo, c.subtipo
        ORDER BY c.codigo`,
    )
    .bind(hasta)
    .all<FilaSaldo>();
  return aSaldos(results);
}

/** Los MOVIMIENTOS de cada cuenta entre dos días, los dos inclusive. */
export async function movimientosEntre(
  ctx: ContextoDeLectura,
  desde: string,
  hasta: string,
): Promise<SaldoDeCuenta[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT c.codigo, c.nombre, c.tipo, c.subtipo,
              COALESCE(SUM(CASE WHEN a.fecha BETWEEN ?1 AND ?2 THEN l.debe_cents END), 0)  AS debe,
              COALESCE(SUM(CASE WHEN a.fecha BETWEEN ?1 AND ?2 THEN l.haber_cents END), 0) AS haber
         FROM cuentas c
         LEFT JOIN asiento_lineas l ON l.cuenta_id = c.id
         LEFT JOIN asientos a ON a.id = l.asiento_id
        GROUP BY c.id, c.codigo, c.nombre, c.tipo, c.subtipo
        ORDER BY c.codigo`,
    )
    .bind(desde, hasta)
    .all<FilaSaldo>();
  return aSaldos(results);
}

/**
 * La fecha contable de una entrega, en SQL.
 *
 * `entregado_en` son milisegundos UTC y la fecha contable es la de Panamá, así
 * que se convierte igual que `fechaContable` del dominio: `-5 hours`. Si por lo
 * que sea no hubiera hora de entrega, se usa la última actualización del pedido
 * antes que dejar la fila fuera del informe.
 */
const FECHA_DE_ENTREGA = `date(COALESCE(
  (SELECT MAX(e.entregado_en) FROM envios e WHERE e.pedido_id = p.id AND e.estado = 'entregado'),
  p.actualizado_en) / 1000, 'unixepoch', '-5 hours')`;

/**
 * Pedidos entregados en el periodo a los que les falta el costo.
 *
 * Es el número que hace que la tarjeta de ganancia no muestre un margen del
 * 100 % cuando lo que falta es el costo: «sin costo de ventas no es ganancia»
 * (05 §5). También es una de las casillas del cierre de mes.
 */
export async function entregasSinCosto(
  ctx: ContextoDeLectura,
  desde: string,
  hasta: string,
): Promise<number> {
  const r = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM pedidos p
        WHERE p.estado = 'entregado'
          AND EXISTS (SELECT 1 FROM pedido_lineas pl
                       WHERE pl.pedido_id = p.id AND pl.costo_unit_cents IS NULL)
          AND ${FECHA_DE_ENTREGA} BETWEEN ?1 AND ?2`,
    )
    .bind(desde, hasta)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Leer · el libro diario
// ---------------------------------------------------------------------------

export interface LineaDelLibro {
  readonly codigo: string;
  readonly cuenta: string;
  readonly debeCents: number;
  readonly haberCents: number;
  readonly detalle: string | null;
}

export interface AsientoDelLibro {
  readonly id: string;
  readonly fecha: string;
  readonly descripcion: string;
  readonly origen: string;
  readonly hecho: Hecho;
  readonly referenciaTipo: string | null;
  readonly referenciaId: string | null;
  /** El asiento al que este corrige, si es un reverso. */
  readonly revierteId: string | null;
  /** `true` si alguien ya lo corrigió: entonces no se puede volver a revertir. */
  readonly revertido: boolean;
  readonly creadoPor: string;
  readonly creadoEn: number;
  readonly totalCents: number;
  readonly lineas: readonly LineaDelLibro[];
}

/**
 * El libro diario de un periodo, con sus líneas.
 *
 * Dos consultas y no una por asiento: con una por asiento, una página de
 * cincuenta apuntes son cincuenta viajes a la base (02-datos §11: ninguna
 * consulta crece con el número de registros).
 */
export async function libroDiario(
  ctx: ContextoDeLectura,
  r: { desde: string; hasta: string; limite?: number },
): Promise<AsientoDelLibro[]> {
  const limite = Math.min(Math.max(r.limite ?? 50, 1), 200);

  const { results: cabezas } = await ctx.db
    .prepare(
      `SELECT a.id, a.fecha, a.descripcion, a.origen, a.hecho, a.referencia_tipo, a.referencia_id,
              a.revierte_id, a.creado_por, a.creado_en,
              (SELECT COALESCE(SUM(debe_cents),0) FROM asiento_lineas WHERE asiento_id = a.id) AS total,
              EXISTS (SELECT 1 FROM asientos r WHERE r.revierte_id = a.id) AS revertido
         FROM asientos a
        WHERE a.fecha BETWEEN ?1 AND ?2
        ORDER BY a.fecha DESC, a.id DESC
        LIMIT ?3`,
    )
    .bind(r.desde, r.hasta, limite)
    .all<FilaAsiento & { total: number; revertido: number }>();

  if (cabezas.length === 0) return [];

  const huecos = cabezas.map(() => "?").join(",");
  const { results: lineas } = await ctx.db
    .prepare(
      `SELECT l.asiento_id, c.codigo, c.nombre, l.debe_cents, l.haber_cents, l.detalle
         FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
        WHERE l.asiento_id IN (${huecos})
        ORDER BY l.id`,
    )
    .bind(...cabezas.map((c) => c.id))
    .all<{
      asiento_id: string;
      codigo: string;
      nombre: string;
      debe_cents: number;
      haber_cents: number;
      detalle: string | null;
    }>();

  const porAsiento = new Map<string, LineaDelLibro[]>();
  for (const l of lineas) {
    const ya = porAsiento.get(l.asiento_id) ?? [];
    ya.push({
      codigo: l.codigo,
      cuenta: l.nombre,
      debeCents: l.debe_cents,
      haberCents: l.haber_cents,
      detalle: l.detalle,
    });
    porAsiento.set(l.asiento_id, ya);
  }

  return cabezas.map((c) => ({
    id: c.id,
    fecha: c.fecha,
    descripcion: c.descripcion,
    origen: c.origen,
    hecho: c.hecho as Hecho,
    referenciaTipo: c.referencia_tipo,
    referenciaId: c.referencia_id,
    revierteId: c.revierte_id,
    revertido: c.revertido === 1,
    creadoPor: c.creado_por,
    creadoEn: c.creado_en,
    totalCents: c.total,
    lineas: porAsiento.get(c.id) ?? [],
  }));
}

/**
 * Un apunte del mayor: la línea de una cuenta CON el asiento del que viene.
 *
 * Lleva el id del asiento a propósito. Es lo que hace que una cifra de la
 * pantalla pueda decir de dónde sale: sin eso, la contadora ve un importe y no
 * tiene por dónde empezar a buscar. Una cifra que no puede decir de dónde viene
 * invita a creérsela.
 */
export interface ApunteDeMayor {
  readonly asientoId: string;
  readonly fecha: string;
  readonly descripcion: string;
  readonly hecho: Hecho;
  readonly debeCents: number;
  readonly haberCents: number;
  readonly detalle: string | null;
}

/** El mayor de una cuenta: sus apuntes del periodo, para cuadrar con el banco. */
export async function mayorDeCuenta(
  ctx: ContextoDeLectura,
  codigo: string,
  r: { desde: string; hasta: string; limite?: number },
): Promise<Resultado<{ codigo: string; nombre: string; apuntes: readonly ApunteDeMayor[] }>> {
  if (cuentaDelPlan(codigo) === null) {
    return fallo("no_encontrado", `la cuenta ${codigo} no está en el plan de cuentas`);
  }
  const cuenta = await ctx.db
    .prepare("SELECT id, nombre FROM cuentas WHERE codigo = ?")
    .bind(codigo)
    .first<{ id: string; nombre: string }>();
  if (cuenta === null) return fallo("no_encontrado", "esa cuenta todavía no existe en la base");

  const { results } = await ctx.db
    .prepare(
      `SELECT a.id AS asiento_id, a.fecha, a.descripcion, a.hecho,
              l.debe_cents, l.haber_cents, l.detalle
         FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
        WHERE l.cuenta_id = ?1 AND a.fecha BETWEEN ?2 AND ?3
        ORDER BY a.fecha DESC, a.id DESC
        LIMIT ?4`,
    )
    .bind(cuenta.id, r.desde, r.hasta, Math.min(Math.max(r.limite ?? 100, 1), 500))
    .all<{
      asiento_id: string;
      fecha: string;
      descripcion: string;
      hecho: string;
      debe_cents: number;
      haber_cents: number;
      detalle: string | null;
    }>();

  return ok({
    codigo,
    nombre: cuenta.nombre,
    apuntes: results.map((f) => ({
      asientoId: f.asiento_id,
      fecha: f.fecha,
      descripcion: f.descripcion,
      hecho: f.hecho as Hecho,
      debeCents: f.debe_cents,
      haberCents: f.haber_cents,
      detalle: f.detalle,
    })),
  });
}

// ---------------------------------------------------------------------------
// Leer · lo que te deben
// ---------------------------------------------------------------------------

export interface DeudaDeClienta {
  readonly pedidoId: string;
  readonly numero: string;
  readonly cliente: string | null;
  readonly saldoCents: number;
  readonly entregadoEl: string;
  readonly dias: number;
  readonly tramo: Tramo;
}

export interface PorCobrar {
  readonly al: string;
  readonly totalCents: number;
  readonly porTramo: Record<Tramo, number>;
  readonly deudas: readonly DeudaDeClienta[];
}

/**
 * Lo que le deben, por pedido entregado y con su antigüedad (05 §5).
 *
 * Sale de `pedidos` y no del mayor de 1201: el saldo por clienta necesita saber
 * de QUÉ pedido es cada dólar, y `asiento_lineas` no guarda el pedido de cada
 * línea.
 *
 * **Lo que este comentario decía antes y no era verdad.** Decía que el total de
 * aquí y el saldo de 1201 tienen que coincidir, y que la lista de cierre lo
 * dice cuando no. La lista no lo decía: la comprobación estaba prometida y sin
 * escribir, que es peor que no prometer nada — quien lee esto da por hecho que
 * alguien vigila.
 *
 * Y escrita tal cual tampoco sirve todavía: los asientos existen desde el día
 * en que el sistema empezó a llevarlos, así que las entregas anteriores salen
 * en esta cifra y no en 1201, y la comparación saldría en rojo durante meses
 * por algo que nadie puede arreglar. Eso es lo que espera el hueco
 * `fecha_arranque`, que hoy «todavía no tiene dónde guardarse».
 *
 * Lo que la lista de cierre SÍ comprueba, y es computable hoy sin inventar
 * nada, son las dos mitades que de verdad rompen el cuadre: `venta_sin_asiento`
 * (una entrega cuya venta no está en los libros) y `cobro_sin_asiento` (un
 * saldo cobrado sin que se sepa a qué cuenta entró). Las dos nombran el pedido
 * y bloquean el cierre.
 */
export async function porCobrar(ctx: ContextoDeLectura, al: string): Promise<PorCobrar> {
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id, p.numero, cl.nombre AS cliente,
              p.total_cents - p.pagado_cents AS saldo,
              ${FECHA_DE_ENTREGA} AS entregado_el
         FROM pedidos p
         LEFT JOIN clientes cl ON cl.id = p.cliente_id
        WHERE p.estado = 'entregado' AND p.pagado_cents < p.total_cents
          AND ${FECHA_DE_ENTREGA} <= ?1
        ORDER BY entregado_el`,
    )
    .bind(al)
    .all<{
      id: string;
      numero: string;
      cliente: string | null;
      saldo: number;
      entregado_el: string;
    }>();

  const porTramo: Record<Tramo, number> = { "0-7": 0, "8-30": 0, "mas-de-30": 0 };
  const deudas = results.map((f) => {
    const dias = diasEntre(f.entregado_el, al);
    const tramo = tramoDeAntiguedad(dias);
    porTramo[tramo] += f.saldo;
    return {
      pedidoId: f.id,
      numero: f.numero,
      cliente: f.cliente,
      saldoCents: f.saldo,
      entregadoEl: f.entregado_el,
      dias,
      tramo,
    };
  });

  return {
    al,
    totalCents: deudas.reduce((t, d) => t + d.saldoCents, 0),
    porTramo,
    deudas,
  };
}

// ---------------------------------------------------------------------------
// Leer · el resumen de la pantalla
// ---------------------------------------------------------------------------

export interface CuentaConSaldo {
  readonly codigo: string;
  readonly nombre: string;
  readonly saldoCents: number;
}

export interface ResumenContable {
  readonly desde: string;
  readonly hasta: string;
  /** Saldos AL `hasta`: el dinero que hay, no el que se movió. */
  readonly dinero: readonly CuentaConSaldo[];
  readonly dineroTotalCents: number;
  readonly teDebenCents: number;
  readonly debesCents: number;
  readonly inventarioCents: number;
  /** Movimientos DEL `desde` AL `hasta`. */
  readonly resultados: EstadoDeResultados;
  readonly balance: Balance;
  readonly asientos: number;
  readonly asientosSinCuadre: number;
  readonly cajasConSaldo: readonly CuentaConSaldo[];
}

const soloConSaldo = (filas: readonly SaldoDeCuenta[], cual: (f: SaldoDeCuenta) => boolean) =>
  filas
    .filter(cual)
    .map((f) => ({ codigo: f.codigo, nombre: f.nombre, saldoCents: f.saldoCents }));

/**
 * Lo que la pantalla de la contadora enseña arriba.
 *
 * Mezcla a propósito dos cosas de naturaleza distinta, y por eso cada campo
 * dice cuál es: el dinero y lo que deben son SALDOS al día final; las ventas,
 * la ganancia y los gastos son MOVIMIENTOS del periodo (05 §5).
 */
export async function resumenContable(
  ctx: ContextoDeLectura,
  r: { desde: string; hasta: string },
): Promise<ResumenContable> {
  const [alFinal, delPeriodo, sinCosto, cuentas] = await Promise.all([
    saldosAl(ctx, r.hasta),
    movimientosEntre(ctx, r.desde, r.hasta),
    entregasSinCosto(ctx, r.desde, r.hasta),
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS asientos,
                COALESCE(SUM(CASE WHEN cc.asiento_id IS NULL THEN 1 ELSE 0 END), 0) AS sin_cuadre
           FROM asientos a LEFT JOIN control_cuadre cc ON cc.asiento_id = a.id
          WHERE a.fecha BETWEEN ?1 AND ?2`,
      )
      .bind(r.desde, r.hasta)
      .first<{ asientos: number; sin_cuadre: number }>(),
  ]);

  const dinero = soloConSaldo(
    alFinal,
    (f) =>
      f.subtipo === "yappy" ||
      f.subtipo === "banco" ||
      f.subtipo === "efectivo" ||
      f.subtipo === "por_liquidar",
  );

  return {
    desde: r.desde,
    hasta: r.hasta,
    dinero,
    dineroTotalCents: dinero.reduce((t, c) => t + c.saldoCents, 0),
    teDebenCents: alFinal.find((f) => f.codigo === "1201")?.saldoCents ?? 0,
    debesCents: alFinal.find((f) => f.codigo === "2102")?.saldoCents ?? 0,
    inventarioCents: alFinal.find((f) => f.codigo === "1301")?.saldoCents ?? 0,
    resultados: estadoDeResultados(delPeriodo, sinCosto),
    balance: balance(alFinal),
    asientos: cuentas?.asientos ?? 0,
    asientosSinCuadre: cuentas?.sin_cuadre ?? 0,
    // Una caja con saldo es efectivo que está en la calle. A fin de mes tienen
    // que estar todas en cero (05 §9).
    cajasConSaldo: soloConSaldo(
      alFinal,
      (f) => f.subtipo === "caja_motorizado" && f.saldoCents !== 0,
    ),
  };
}

// ---------------------------------------------------------------------------
// Lo que falta por decidir
// ---------------------------------------------------------------------------

export interface HuecoConEstado extends Hueco {
  /**
   * `abierto` cuando se puede comprobar que sigue faltando; `resuelto` cuando
   * el dato ya está; `lo_dice_una_persona` cuando el sistema no tiene forma de
   * saberlo —y entonces se enseña igual, porque un hueco que no se ve es un
   * hueco que nadie llena.
   */
  readonly estado: "abierto" | "resuelto" | "lo_dice_una_persona";
  readonly nota: string | null;
}

/**
 * Los `PENDIENTE` de la contabilidad, con lo que se puede comprobar comprobado.
 *
 * Tres de ellos se miran en la base (el ITBMS, el banco y los costos de
 * apertura) y uno en los ajustes (las comisiones). Los demás son decisiones que
 * no dejan rastro hasta que alguien las dice, así que se enseñan como lo que
 * son. Ninguno desaparece de la lista: el que desaparece es el que nadie llena.
 */
export async function huecosAbiertos(ctx: ContextoDeLectura): Promise<HuecoConEstado[]> {
  const [itbms, banco, costos, ajustes] = await Promise.all([
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM variantes WHERE activo = 1 AND tasa_itbms_bp IS NULL")
      .first<{ n: number }>(),
    ctx.db
      .prepare("SELECT nombre FROM cuentas WHERE codigo = '1102'")
      .first<{ nombre: string }>(),
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM variantes v
          WHERE v.activo = 1 AND v.es_combo = 0
            AND NOT EXISTS (SELECT 1 FROM valor_inventario vi
                             WHERE vi.codigo = v.codigo AND vi.unidades > 0)`,
      )
      .first<{ n: number }>(),
    leerVigentes(ctx),
  ]);

  const comisiones = ajustes.ok
    ? ajustes.datos.ajustes.find((a) => a.clave === "comisiones")
    : undefined;
  const comisionesFaltan =
    comisiones === undefined ||
    comisiones.pendiente ||
    Object.values(comisiones.valor as Record<string, unknown>).some(esPendiente);

  const medido: Record<string, { estado: HuecoConEstado["estado"]; nota: string }> = {
    itbms:
      (itbms?.n ?? 0) > 0
        ? { estado: "abierto", nota: `${itbms?.n ?? 0} artículos sin tasa de ITBMS` }
        : { estado: "resuelto", nota: "todos los artículos tienen su tasa" },
    banco: (banco?.nombre ?? "").includes("PENDIENTE")
      ? { estado: "abierto", nota: `la cuenta 1102 se sigue llamando «${banco?.nombre ?? ""}»` }
      : { estado: "resuelto", nota: `la cuenta 1102 es «${banco?.nombre ?? ""}»` },
    costos_apertura:
      (costos?.n ?? 0) > 0
        ? { estado: "abierto", nota: `${costos?.n ?? 0} artículos sin costo cargado` }
        : { estado: "resuelto", nota: "todos los artículos tienen costo" },
    comisiones: comisionesFaltan
      ? { estado: "abierto", nota: "falta el contrato de alguna pasarela" }
      : { estado: "resuelto", nota: "las tres pasarelas tienen su comisión" },
  };

  return HUECOS.map((h) => {
    const m = medido[h.clave];
    return m === undefined
      ? { ...h, estado: "lo_dice_una_persona" as const, nota: null }
      : { ...h, estado: m.estado, nota: m.nota };
  });
}

// ---------------------------------------------------------------------------
// Cierre de mes (05 §9)
// ---------------------------------------------------------------------------

export interface Casilla {
  readonly clave: string;
  readonly titulo: string;
  /**
   * `ok` se puede cerrar; `falta` hay trabajo pendiente y BLOQUEA el cierre;
   * `aviso` conviene mirarlo pero no bloquea; `no_se_puede_comprobar` todavía
   * no existe la parte del sistema que lo sabría, y se enseña igual.
   */
  readonly estado: "ok" | "falta" | "aviso" | "no_se_puede_comprobar";
  readonly detalle: string;
}

export interface RevisionDeCierre {
  readonly mes: string;
  readonly estadoDelMes: "abierto" | "cerrado";
  readonly casillas: readonly Casilla[];
  /** `true` si no queda ninguna casilla que bloquee. */
  readonly sePuedeCerrar: boolean;
  /** `false` mientras el mes no haya terminado. */
  readonly mesTerminado: boolean;
}

/**
 * La lista de chequeo del cierre, con datos de verdad (05 §9).
 *
 * Tres de las casillas del documento no se pueden comprobar todavía porque la
 * parte del sistema que las sabría no existe —las compras y sus facturas llegan
 * en F5.4, y las liquidaciones de pasarela cuando haya pasarelas— y se enseñan
 * igual, diciendo por qué. Esconderlas haría que la lista pareciera completa.
 */
export async function revisionDeCierre(
  ctx: ContextoDeLectura,
  mes: string,
): Promise<Resultado<RevisionDeCierre>> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) {
    return fallo("entrada_invalida", `«${mes}» no es un mes (YYYY-MM)`);
  }
  const { desde, hasta } = rangoDelMes(mes);

  const [
    periodo,
    extracto,
    pagosSinCruzar,
    sinCosto,
    descuadres,
    saldos,
    sinCuadre,
    sinVenta,
    sinAsiento,
  ] = await Promise.all([
      ctx.db
        .prepare("SELECT estado FROM periodos WHERE mes = ?")
        .bind(mes)
        .first<{ estado: string }>(),
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS lineas,
                  COALESCE(SUM(CASE WHEN conciliado_con_id IS NULL THEN 1 ELSE 0 END), 0) AS sin_cruzar
             FROM extracto_lineas WHERE fecha BETWEEN ?1 AND ?2`,
        )
        .bind(desde, hasta)
        .first<{ lineas: number; sin_cruzar: number }>(),
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pagos p
            WHERE p.estado = 'aprobado'
              AND date(p.confirmado_en / 1000, 'unixepoch', '-5 hours') BETWEEN ?1 AND ?2
              AND NOT EXISTS (SELECT 1 FROM extracto_lineas el
                               WHERE el.conciliado_con_tipo = 'pago' AND el.conciliado_con_id = p.id)`,
        )
        .bind(desde, hasta)
        .first<{ n: number }>(),
      entregasSinCosto(ctx, desde, hasta),
      // Existencias contra movimientos: la suma de los movimientos de una
      // variante en una bodega tiene que ser lo que hay en esa bodega.
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT e.fisico AS fisico,
                    COALESCE((SELECT SUM(m.delta) FROM movimientos_inventario m
                               WHERE m.codigo = e.codigo AND m.bodega_id = e.bodega_id), 0) AS movido
               FROM existencias e)
            WHERE fisico <> movido`,
        )
        .first<{ n: number }>(),
      saldosAl(ctx, hasta),
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM asientos a
            LEFT JOIN control_cuadre cc ON cc.asiento_id = a.id
            WHERE a.fecha BETWEEN ?1 AND ?2 AND cc.asiento_id IS NULL`,
        )
        .bind(desde, hasta)
        .first<{ n: number }>(),
      // Entregas sin su asiento de venta: mercancía que salió del inventario y
      // que ningún libro explica. Es el peor de los descuadres porque no se
      // nota en ninguna pantalla —el pedido dice «entregado», el stock bajó— y
      // solo aparece cuando el margen del mes sale raro.
      //
      // Los pedidos de cero quedan fuera: un regalo o un canje no genera
      // asiento de venta a propósito (lo rechaza el constructor), así que
      // contarlos aquí sería una alarma que nunca se puede apagar.
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pedidos p
            WHERE p.estado = 'entregado' AND p.total_cents > 0
              AND ${FECHA_DE_ENTREGA} BETWEEN ?1 AND ?2
              AND NOT EXISTS (SELECT 1 FROM asientos a
                               WHERE a.referencia_tipo = 'pedido'
                                 AND a.referencia_id = p.id AND a.hecho = '3')`,
        )
        .bind(desde, hasta)
        .first<{ n: number }>(),
      // Dinero que entró y los libros no dicen a dónde.
      //
      // Es el hueco que el sistema deja A PROPÓSITO en los dos sitios donde
      // entra dinero, cuando no se sabe a qué cuenta fue: el motorizado que
      // cobra con «otro» o sin estar asignado a la parada, y el pago manual
      // por un método que no tiene cuenta en el plan. En los dos casos se
      // prefirió no escribir asiento antes que meterlo en una cuenta «que
      // suena razonable», porque eso es poner una cifra a ojo en los libros.
      //
      // Esta casilla es la otra mitad de esa decisión: no saber está bien,
      // callarlo no. Mira los PAGOS y no las entregas —antes miraba las
      // entregas y se le escapaba la mitad: un comprobante confirmado desde el
      // panel no toca `envios`— y por eso los asientos de cobro llevan su
      // referencia al pago y no al pedido: un pedido tiene varios pagos y cada
      // uno lleva el suyo.
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pagos p
            WHERE p.estado = 'aprobado'
              AND date(p.confirmado_en / 1000, 'unixepoch', '-5 hours') BETWEEN ?1 AND ?2
              AND NOT EXISTS (SELECT 1 FROM asientos a
                               WHERE a.referencia_tipo = 'pago' AND a.referencia_id = p.id)`,
        )
        .bind(desde, hasta)
        .first<{ n: number }>(),
    ]);

  const cajas = saldos.filter((s) => s.subtipo === "caja_motorizado" && s.saldoCents !== 0);

  const b = balance(saldos);
  const hoy = fechaContable(ctx.ahora);

  const casillas: Casilla[] = [
    {
      clave: "extracto",
      titulo: "Extractos del mes importados y sin líneas por cruzar",
      estado:
        (extracto?.lineas ?? 0) === 0
          ? "no_se_puede_comprobar"
          : (extracto?.sin_cruzar ?? 0) === 0
            ? "ok"
            : "falta",
      detalle:
        (extracto?.lineas ?? 0) === 0
          ? "No se ha importado ningún extracto de este mes. La importación de CSV llega con la conciliación (F5.7)."
          : `${extracto?.sin_cruzar ?? 0} de ${extracto?.lineas ?? 0} líneas sin cruzar.`,
    },
    {
      clave: "pagos",
      titulo: "Pagos aprobados sin conciliar",
      estado: (pagosSinCruzar?.n ?? 0) === 0 ? "ok" : "aviso",
      detalle:
        (pagosSinCruzar?.n ?? 0) === 0
          ? "Ninguno."
          : `${pagosSinCruzar?.n ?? 0} pagos aprobados que todavía no se han cruzado con un extracto.`,
    },
    {
      clave: "liquidaciones",
      titulo: "Liquidaciones de las pasarelas recibidas",
      estado: "no_se_puede_comprobar",
      detalle:
        "Todavía no hay ninguna pasarela encendida: los trámites de Yappy, Tilopay y PayPal siguen en curso.",
    },
    {
      clave: "cajas",
      titulo: "Cajas de los motorizados en cero",
      estado: cajas.length === 0 ? "ok" : "falta",
      detalle:
        cajas.length === 0
          ? "Todo liquidado."
          : `${cajas.length} con saldo: ${cajas.map((c) => c.nombre).join(", ")}.`,
    },
    {
      clave: "sin_costo",
      titulo: "Pedidos entregados sin costo",
      estado: sinCosto === 0 ? "ok" : "falta",
      detalle:
        sinCosto === 0
          ? "Ninguno."
          : `${sinCosto} pedidos entregados sin saber lo que costó la mercancía. Falta el costo de apertura de esas tallas, que lo pone la contadora.`,
    },
    {
      clave: "facturas",
      titulo: "Compras recibidas sin factura adjunta",
      estado: "no_se_puede_comprobar",
      detalle: "Las compras a proveedor llegan en otra parte del sistema (F5.4).",
    },
    {
      clave: "existencias",
      titulo: "Las existencias cuadran con sus movimientos",
      estado: (descuadres?.n ?? 0) === 0 ? "ok" : "falta",
      detalle:
        (descuadres?.n ?? 0) === 0
          ? "Cuadran."
          : `${descuadres?.n ?? 0} combinaciones de artículo y bodega donde lo que hay no es la suma de sus movimientos.`,
    },
    {
      clave: "balance",
      titulo: "El balance cuadra",
      estado: b.cuadra ? "ok" : "falta",
      detalle: b.cuadra
        ? "Activos = pasivos + patrimonio + el resultado del periodo."
        : `Falta ${b.diferenciaCents} centavos por cuadrar.`,
    },
    {
      clave: "venta_sin_asiento",
      titulo: "Todas las entregas del mes tienen su asiento de venta",
      estado: (sinVenta?.n ?? 0) === 0 ? "ok" : "falta",
      detalle:
        (sinVenta?.n ?? 0) === 0
          ? "Todas."
          : `${sinVenta?.n ?? 0} pedidos entregados sin asiento de venta: salió mercancía del inventario que los libros no explican. Avísele a Juan.`,
    },
    {
      clave: "pago_sin_asiento",
      titulo: "Todo el dinero que entró tiene su asiento",
      estado: (sinAsiento?.n ?? 0) === 0 ? "ok" : "falta",
      detalle:
        (sinAsiento?.n ?? 0) === 0
          ? "Todo."
          : `${sinAsiento?.n ?? 0} pagos aprobados sin que los libros digan a qué cuenta entró el dinero. Pasa cuando el motorizado cobró con «otro» o sin estar asignado a la parada, y cuando un pago llegó por un método que no tiene cuenta. El sistema no lo adivina: hay que anotar a dónde fue, en Contabilidad › asiento nuevo.`,
    },
    {
      clave: "cuadre",
      titulo: "Todos los asientos del mes tienen su cuadre",
      estado: (sinCuadre?.n ?? 0) === 0 ? "ok" : "falta",
      detalle:
        (sinCuadre?.n ?? 0) === 0
          ? "Todos."
          : `${sinCuadre?.n ?? 0} asientos sin su fila de cuadre. Avísele a Juan: se escribieron por fuera del camino normal.`,
    },
  ];

  return ok({
    mes,
    estadoDelMes: periodo?.estado === "cerrado" ? "cerrado" : "abierto",
    casillas,
    sePuedeCerrar: !casillas.some((c) => c.estado === "falta"),
    // Cerrar un mes que no ha terminado bloquearía los asientos de los días que
    // quedan: el trigger rechaza cualquier fecha de un mes cerrado.
    mesTerminado: mes < mesDe(hoy),
  });
}

/**
 * Cerrar el mes (05 §9). Lo hace la dueña, no la contadora.
 *
 * Quién puede llamarlo lo decide la ruta con el permiso `cierre_de_mes`, que en
 * `roles.ts` solo tiene la dueña — «la contadora lleva la contabilidad pero NO
 * cierra el mes».
 *
 * A partir de aquí el trigger `asientos_periodo_cerrado` rechaza cualquier
 * asiento con fecha de ese mes. Eso es lo que hace que un cierre signifique
 * algo, y también por qué no se cierra un mes que no ha terminado.
 */
export async function cerrarMes(
  ctx: ContextoContable,
  mes: string,
): Promise<Resultado<{ mes: string }>> {
  const revision = await revisionDeCierre(ctx, mes);
  if (!revision.ok) return revision;
  if (revision.datos.estadoDelMes === "cerrado") {
    return fallo("repetido", `${mes} ya estaba cerrado`);
  }
  if (!revision.datos.mesTerminado) {
    return fallo(
      "transicion_invalida",
      `${mes} todavía no ha terminado: cerrarlo ahora dejaría los días que quedan sin poder registrar nada`,
    );
  }
  if (!revision.datos.sePuedeCerrar) {
    const faltan = revision.datos.casillas.filter((c) => c.estado === "falta");
    return fallo(
      "transicion_invalida",
      `falta por resolver: ${faltan.map((c) => c.titulo.toLowerCase()).join("; ")}`,
    );
  }

  try {
    await ctx.db
      .prepare(
        `INSERT INTO periodos (mes, estado, cerrado_por, cerrado_en, reabierto_motivo)
         VALUES (?,'cerrado',?,?,NULL)`,
      )
      .bind(mes, ctx.actor, ctx.ahora)
      .run();
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    // La llave primaria: dos personas cerrando el mismo mes a la vez.
    return /UNIQUE|PRIMARY/i.test(texto)
      ? fallo("repetido", `${mes} ya estaba cerrado`)
      : fallo("interno", texto);
  }

  return ok({ mes });
}

/** Reabrir pide motivo y queda registrado (05 §9). */
export async function reabrirMes(
  ctx: ContextoContable,
  mes: string,
  motivo: string,
): Promise<Resultado<{ mes: string }>> {
  if (motivo.trim() === "") {
    return fallo("entrada_invalida", "reabrir un mes pide un motivo, y queda registrado");
  }

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE periodos SET estado = 'abierto', reabierto_motivo = ?
            WHERE mes = ? AND estado = 'cerrado'`,
        )
        .bind(motivo.trim(), mes),
      // El control mira lo que ESTE batch escribió: el mes abierto CON ESTE
      // motivo. Mirar solo «¿está abierto?» pasaría también si el mes nunca se
      // cerró o si otra persona lo reabrió un instante antes por otra razón, y
      // entonces el motivo que queda registrado no sería el de quien pidió
      // reabrir.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, 'periodo:reabierto',
                   (SELECT COUNT(*) FROM periodos
                     WHERE mes = ? AND estado = 'abierto' AND reabierto_motivo = ?), ?)`,
        )
        .bind(ulid(ctx.ahora), mes, motivo.trim(), ctx.ahora),
    ]);
  } catch {
    return fallo("transicion_invalida", `${mes} no estaba cerrado`);
  }

  return ok({ mes });
}
