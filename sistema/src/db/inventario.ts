import { fallo, ok } from "../contrato/resultado";
import type { Fallo, Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import { mermaOMuestra } from "../dominio/contabilidad";
import { fechaPanama } from "../dominio/metricas";
import { enunciadosDeAsiento } from "./contabilidad";

/**
 * Mover el inventario sin transacciones interactivas.
 *
 * D1 no las tiene. `db.batch()` es todo o nada, PERO un UPDATE que no encuentra
 * su fila cambia cero filas y el batch sigue tan contento. Así que «descuenta
 * 5 si hay 5» no se puede escribir como un UPDATE con WHERE y confiar.
 *
 * La forma que sí funciona (02-datos §1) es la fila de control: después del
 * UPDATE se inserta en `controles` una fila cuyo `ok` se calcula con un SELECT
 * sobre el estado YA cambiado, y la tabla tiene `CHECK (ok = 1)`. Si el UPDATE
 * no hizo lo suyo, el SELECT da 0, el CHECK revienta y se cae el batch entero
 * —movimiento incluido—. `SELECT RAISE()` no sirve fuera de un trigger; esta
 * fila sí.
 *
 * Todo lo que escribe en el inventario pasa por aquí. Es a propósito: si cada
 * sitio armara su propio batch, bastaría uno que se olvidara de la fila de
 * control para que el stock quedara en negativo sin que nada protestara.
 */

/**
 * Las unidades libres de una variante, en SQL, contando los combos.
 *
 * Un combo no tiene existencias propias: caben tantos como permita el
 * componente que menos alcance. Es la MISMA regla que `src/dominio/combos.ts`,
 * escrita en SQL porque el catálogo entero sale en una consulta y traerse las
 * recetas para calcularlo en JavaScript serían N+1 consultas en el camino que
 * más se usa.
 *
 * Vive AQUÍ y no dentro de cada consulta porque ya tenía dos copias —el
 * catálogo público y, a punto de nacer, las herramientas del asistente— y tres
 * copias de una regla discrepan antes o después. La que se equivoca del lado
 * flojo es la que nadie revisa. `test/combos-catalogo.test.ts` siembra combos
 * en D1 y exige que esta expresión y `cuantosCombos` den el MISMO número; con
 * un solo dueño, esa prueba ahora cubre también al asistente.
 *
 * `MIN` sobre un conjunto vacío da NULL, así que un combo sin receta sale con
 * libres nulo: quien lo lea tiene que decidir qué significa eso, y no es lo
 * mismo hacia fuera (agotado, para no prometer) que hacia dentro (no se sabe).
 * Y la división de dos enteros en SQLite trunca, igual que el `Math.floor` de
 * la regla pura.
 */
export const libresSQL = (v = "v"): string => `
         CASE WHEN ${v}.es_combo = 1 THEN (
           SELECT MIN(
             (SELECT COALESCE(SUM(e.fisico - e.reservado), 0)
                FROM existencias e WHERE e.codigo = cc.codigo) / cc.cantidad
           )
           FROM combo_componentes cc WHERE cc.combo_codigo = ${v}.codigo
         ) ELSE (
           SELECT SUM(e.fisico - e.reservado) FROM existencias e WHERE e.codigo = ${v}.codigo
         ) END`;

/**
 * Los tipos de movimiento que estas funciones escriben.
 *
 * Es una lista y no solo un tipo de TypeScript porque hace falta comprobarlos
 * en tiempo de EJECUCIÓN: lo que llega por HTTP es texto que escribió alguien,
 * y un tipo de TypeScript no existe ya cuando esa petición entra. Sin la
 * lista, un `tipo` inventado llegaría hasta el CHECK del esquema y volvería
 * como «SQLITE_CONSTRAINT», que no le dice nada a nadie.
 *
 * Los mismos once del esquema y en el mismo orden, a propósito: si alguien
 * añade uno allí y no aquí, la ruta lo rechaza y se nota enseguida.
 */
export const TIPOS_DE_MOVIMIENTO = [
  "apertura",
  "compra",
  "venta",
  "devolucion",
  "ajuste",
  "merma",
  "muestra",
  "regalo",
  "traslado_salida",
  "traslado_entrada",
  "conteo",
] as const;

export type TipoMovimiento = (typeof TIPOS_DE_MOVIMIENTO)[number];

/** Si ese texto es uno de los once. Lo usa la ruta antes de tocar la base. */
export const esTipoDeMovimiento = (v: unknown): v is TipoMovimiento =>
  typeof v === "string" && (TIPOS_DE_MOVIMIENTO as readonly string[]).includes(v);

/** Los que el esquema obliga a justificar. */
const EXIGEN_MOTIVO = new Set(["ajuste", "merma", "muestra", "regalo", "conteo"]);

/**
 * Lo que sale del inventario SIN ser una venta: asiento 12.
 *
 * `ajuste` y `conteo` quedan fuera a propósito aunque también resten: un
 * conteo que encuentra menos no es una pérdida del negocio, es que lo anotado
 * estaba mal, y lo suyo es el asiento 18 de corrección — que tiene su propio
 * camino. Meter los cuatro en 5201 mezclaría «se me rompió una caja» con «la
 * cuenta estaba mal», y son cosas distintas para quien lee los libros.
 */
const SALEN_SIN_VENDER: ReadonlySet<string> = new Set(["merma", "muestra", "regalo"]);

export interface Linea {
  readonly codigo: string;
  readonly cantidad: number;
  /** Nombre de la bodega. Si falta, se elige la que tenga con qué. */
  readonly bodega?: string;
}

export interface Movimiento {
  readonly codigo: string;
  readonly bodegaId: string;
  /** Positivo entra, negativo sale. Nunca cero: el esquema lo prohíbe. */
  readonly delta: number;
  readonly tipo: TipoMovimiento;
  readonly motivo?: string;
  readonly costoUnitCents?: number;
  readonly revierteId?: string;
  /**
   * En cuánto tiene que quedar el físico después de este movimiento.
   *
   * Es para el CONTEO, que es la única operación que se calcula con una
   * lectura previa: «hay 40 en la base, conté 37, así que el delta es −3». Si
   * entre esa lectura y esta escritura entra una venta, el delta ya no lleva a
   * 37 y el conteo deja el inventario peor que antes, en silencio.
   *
   * Con esto, la fila de control exige además que el físico resultante sea
   * EXACTAMENTE este número. Si alguien se movió en medio, el CHECK tumba el
   * batch y no se escribe nada: la dueña vuelve a contar, que es lo correcto.
   *
   * Lo demás (apertura, compra, merma…) no lo usa: ahí el delta es lo que la
   * persona dijo que entró o salió, no una diferencia contra una lectura.
   */
  readonly quedaEn?: number;
  /**
   * Estas unidades NUNCA estuvieron valoradas: el promedio no se toca.
   *
   * No es «no sé lo que costó» —eso ya lo dice un `costoUnitCents` ausente—
   * sino «ya se sabe que estas unidades no están en el promedio».
   *
   * Lo pone `deshacer()` y solo él, para el contrario de una ENTRADA que entró
   * sin costo. Esas unidades subieron el físico sin subir el promedio, así que
   * al deshacerlas hay que bajar el físico y NO bajar el promedio: cobrarles
   * el promedio sería sacar de `1301` un valor que nunca entró ahí, y encima
   * dejaría más caras las unidades que sí tienen costo.
   *
   * También es lo que hace que deshacer un traslado no invente ni destruya
   * valor: la entrada del traslado no lleva costo, así que su contrario entra
   * por aquí.
   */
  readonly fueraDelPromedio?: boolean;
}

export interface Contexto {
  readonly db: D1Database;
  readonly actor: string;
  readonly ahora: number;
}

// ---------------------------------------------------------------------------
// El costo promedio (`valor_inventario`) · 05-contabilidad §4
// ---------------------------------------------------------------------------

/**
 * El promedio ponderado POR VARIANTE, y el que lo llena.
 *
 * `valor_inventario` llevaba desde la migración 0001 siendo leída al entregar,
 * bajada al entregar y subida al devolver — y **nadie la llenaba nunca**. No
 * había un solo INSERT en todo `src/`. Consecuencia: toda entrega salía con
 * `costoDesconocido`, sin asiento 3b, y la ganancia bruta no se podía calcular.
 * El sistema se portaba bien —se negaba a escribir un cero, que es una cifra
 * inventada (TRAMPAS §7)— pero no había por dónde cargar el costo. Esto es esa
 * puerta.
 *
 * ## Qué es `unidades`, y por qué no es el físico
 *
 * `unidades` son las unidades **valoradas**: las que se sabe lo que costaron.
 * NO es la suma de `existencias.fisico`, y no tiene que serlo. Una entrada sin
 * costo sube el físico y no sube el promedio, así que
 * `unidades <= Σ fisico` y la diferencia es, literalmente, «unidades cuyo
 * costo nadie sabe». Esa diferencia es lo que enseña el hueco «costos de
 * apertura» del panel (`db/contabilidad.ts`, `huecosAbiertos`), y la que se
 * cierra cargando el costo.
 *
 * ## Quién toca el promedio y quién no
 *
 * - **`traslado_salida` y `traslado_entrada`: NUNCA.** El promedio es por
 *   variante, no por bodega: la salida y la entrada se anulan. Tocarlo
 *   inventaría valor en la entrada y lo destruiría en la salida, en cada
 *   traslado, y el promedio quedaría corrompido cuadrando igual — que es lo
 *   peor que puede pasar.
 * - **Entradas (`delta > 0`) con costo: suben.** `unidades += q`,
 *   `valor_cents += q × costo`. Es la aritmética del §4, sobre un costo que
 *   escribió la dueña.
 * - **Entradas sin costo: no tocan nada.** Las unidades existen físicamente y
 *   no se sabe qué costaron. Un cero diría que no costaron nada y pondría el
 *   margen en 100 % (TRAMPAS §7).
 * - **Salidas (`delta < 0`): bajan su parte proporcional**
 *   (`round(valor × q / unidades)`), que es lo que el §4 manda y lo mismo que
 *   ya hace `marcarEntregada`. Vale para `venta`, `merma`, `muestra`,
 *   `regalo`, y para un `ajuste` o un `conteo` que encuentra MENOS de lo
 *   anotado: en todos, la mercancía se fue y su costo se tiene que ir con
 *   ella, o el inventario queda valiendo más de lo que hay y el costo de las
 *   ventas siguientes sale inflado.
 * - **Salidas sin promedio que alcance (`unidades < q`): no tocan nada**, y el
 *   movimiento guarda `costo_unit_cents` nulo. Misma condición y misma
 *   decisión que `marcarEntregada`: una parte del costo no es el costo de esta
 *   salida, y repartir lo que hay sería inventar.
 * - **En una salida el costo no lo decide quien la pide: lo decide el
 *   promedio.** Un `costoUnitCents` en una salida se ignora para el promedio y
 *   el movimiento anota lo que de verdad salió (§4: «el costo de la salida
 *   queda copiado en el movimiento»).
 *
 * La venta por la entrega NO pasa por aquí: `marcarEntregada` escribe su
 * propio lote y baja el promedio ella misma, porque tiene que bajar el físico
 * y lo reservado a la vez. Así que esto no la cuenta dos veces. La `venta` que
 * sí pasa por aquí es la del CRM (`rpc/crm.ts`, `registrarVenta`), que no pasa
 * por pedidos.
 */
interface Promedio {
  unidades: number;
  valorCents: number;
}

/** Los dos tipos que no tocan el promedio por lo que SON, no por sus datos. */
const NO_TOCAN_EL_PROMEDIO: ReadonlySet<string> = new Set([
  "traslado_salida",
  "traslado_entrada",
]);

/** Lo que un movimiento le hace al promedio, ya decidido. */
interface Efecto {
  /** Si hay que escribir en `valor_inventario`. */
  readonly toca: boolean;
  /** Cuánto sube (+) o baja (−) `unidades`. */
  readonly unidades: number;
  /** Cuánto sube (+) o baja (−) `valor_cents`. */
  readonly valorCents: number;
  /** Lo que se anota en `movimientos_inventario.costo_unit_cents`. */
  readonly costoUnitCents: number | null;
}

const NO_TOCA = (costoUnitCents: number | null): Efecto => ({
  toca: false,
  unidades: 0,
  valorCents: 0,
  costoUnitCents,
});

/**
 * Qué le hace este movimiento al promedio que tiene AHORA esa variante.
 *
 * `Math.round` y no un redondeo propio: es exactamente lo que hace
 * `marcarEntregada`, y dos caminos hacia el mismo promedio con dos redondeos
 * distintos discreparían por un centavo de vez en cuando — y el que se
 * equivocara sería el que nadie revisa.
 */
function efectoEnElPromedio(m: Movimiento, ahora: Promedio): Efecto {
  if (NO_TOCAN_EL_PROMEDIO.has(m.tipo)) return NO_TOCA(m.costoUnitCents ?? null);
  if (m.fueraDelPromedio === true) return NO_TOCA(null);

  if (m.delta > 0) {
    if (m.costoUnitCents === undefined) return NO_TOCA(null);
    return {
      toca: true,
      unidades: m.delta,
      valorCents: m.delta * m.costoUnitCents,
      costoUnitCents: m.costoUnitCents,
    };
  }

  const q = -m.delta;
  if (ahora.unidades <= 0 || ahora.unidades < q) return NO_TOCA(null);

  const costo = Math.round((ahora.valorCents * q) / ahora.unidades);
  return {
    toca: true,
    unidades: -q,
    valorCents: -costo,
    // Por unidad, que es lo que guarda la columna. El residuo del redondeo lo
    // limpia el asiento 18 cuando las unidades llegan a cero; aquí no se
    // inventa nada para taparlo.
    costoUnitCents: Math.round(costo / q),
  };
}

/**
 * El promedio de cada variante que vaya a tocarse, antes de escribir.
 *
 * De una sola consulta: un conteo de tres bodegas son decenas de renglones y
 * una consulta por renglón convierte una pantalla en una espera. Las variantes
 * sin fila salen en cero, que aquí no es una cifra inventada sino la verdad —
 * no hay nada valorado todavía.
 */
async function leerPromedios(
  db: D1Database,
  codigos: readonly string[],
): Promise<Map<string, Promedio>> {
  const leido = new Map<string, Promedio>(codigos.map((c) => [c, { unidades: 0, valorCents: 0 }]));
  if (codigos.length === 0) return leido;

  const { results } = await db
    .prepare(
      `SELECT codigo, unidades, valor_cents FROM valor_inventario
        WHERE codigo IN (${codigos.map(() => "?").join(",")})`,
    )
    .bind(...codigos)
    .all<{ codigo: string; unidades: number; valor_cents: number }>();

  for (const v of results) leido.set(v.codigo, { unidades: v.unidades, valorCents: v.valor_cents });
  return leido;
}

/**
 * ¿Se movió el promedio de alguna de estas variantes desde que se leyó?
 *
 * Se pregunta SOLO en el camino del fallo, y existe por TRAMPAS §10: sin esto,
 * un lote que se cae porque otro cambió el promedio en medio contestaría «no
 * alcanza el inventario», y quien lo lea se pondría a contar cajas que están
 * perfectamente. Son dos causas distintas y cada una nombra la suya.
 */
async function promedioQueCambio(
  db: D1Database,
  leido: Map<string, Promedio>,
): Promise<string | null> {
  const codigos = [...leido.keys()];
  if (codigos.length === 0) return null;

  const ahora = await leerPromedios(db, codigos);
  for (const [codigo, antes] of leido) {
    const hoy = ahora.get(codigo);
    if (hoy === undefined) continue;
    if (hoy.unidades !== antes.unidades || hoy.valorCents !== antes.valorCents) return codigo;
  }
  return null;
}

/**
 * Escribe varios movimientos y deja las existencias cuadradas, o no escribe
 * ninguno.
 *
 * `referenciaId` es la llave que agrupa la operación entera, y es también el
 * `deshacerId` que se devuelve: deshacer es buscar por ahí y escribir lo
 * contrario.
 */
export async function aplicar(
  ctx: Contexto,
  movimientos: readonly Movimiento[],
  referencia: { tipo: string; id: string },
): Promise<Resultado<{ deshacerId: string; sinAsiento: readonly string[] }>> {
  if (movimientos.length === 0) {
    return fallo("entrada_invalida", "no hay nada que mover");
  }

  for (const m of movimientos) {
    if (!Number.isSafeInteger(m.delta) || m.delta === 0) {
      return fallo("entrada_invalida", `el movimiento de ${m.codigo} no puede ser ${m.delta}`);
    }
    if (EXIGEN_MOTIVO.has(m.tipo) && (m.motivo ?? "").trim() === "") {
      // El esquema también lo exige con un CHECK; aquí se dice antes y con
      // palabras, para que el mensaje sirva de algo.
      return fallo("entrada_invalida", `un movimiento de «${m.tipo}» necesita motivo`);
    }
    if (m.costoUnitCents !== undefined && !Number.isSafeInteger(m.costoUnitCents)) {
      return fallo("entrada_invalida", `el costo de ${m.codigo} no puede ser ${m.costoUnitCents}`);
    }
    if (m.costoUnitCents !== undefined && m.costoUnitCents < 0) {
      // Un costo negativo metido en el promedio lo deja debajo de cero y lo
      // tumba el CHECK de la tabla; mejor decirlo con palabras.
      return fallo("entrada_invalida", `el costo de ${m.codigo} no puede ser negativo`);
    }
  }

  // El promedio de ahora, para los movimientos que lo vayan a tocar. Se lee
  // antes del lote porque el costo de una salida se calcula con él; si otro
  // lote lo mueve en medio, la fila de control de más abajo lo caza y no se
  // escribe nada.
  const codigosConPromedio = [
    ...new Set(
      movimientos
        .filter((m) => !NO_TOCAN_EL_PROMEDIO.has(m.tipo) && m.fueraDelPromedio !== true)
        .map((m) => m.codigo),
    ),
  ];
  const leido = await leerPromedios(ctx.db, codigosConPromedio);

  // Lo que ESTE lote va a dejar en `valor_inventario`, en absoluto. Arranca en
  // lo leído y se va acumulando movimiento a movimiento, así que dos
  // movimientos de la misma variante en el mismo lote salen bien: el segundo
  // calcula sobre lo que dejó el primero.
  const corriendo = new Map<string, Promedio>([...leido].map(([c, p]) => [c, { ...p }]));
  const tocadas = new Map<string, Promedio>();
  const plan: { efecto: Efecto; despues: Promedio }[] = [];

  for (const m of movimientos) {
    const antes = corriendo.get(m.codigo) ?? { unidades: 0, valorCents: 0 };
    const efecto = efectoEnElPromedio(m, antes);
    const despues = {
      unidades: antes.unidades + efecto.unidades,
      valorCents: antes.valorCents + efecto.valorCents,
    };
    plan.push({ efecto, despues });
    if (!efecto.toca) continue;
    corriendo.set(m.codigo, despues);
    tocadas.set(m.codigo, leido.get(m.codigo) ?? { unidades: 0, valorCents: 0 });
  }

  const enunciados: D1PreparedStatement[] = [];
  /** Los que salieron sin que se supiera su costo: sin asiento, y dicho. */
  const sinAsiento: string[] = [];

  for (const [i, m] of movimientos.entries()) {
    const { efecto, despues } = plan[i] as { efecto: Efecto; despues: Promedio };
    // El id se saca aparte porque el asiento de la merma apunta a ESTE
    // movimiento: sin él, el contador tiene un gasto en los libros y ninguna
    // forma de llegar a la caja que se perdió.
    const movId = ulid(ctx.ahora);
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO movimientos_inventario
             (id, codigo, bodega_id, delta, tipo, costo_unit_cents, referencia_tipo, referencia_id,
              motivo, actor, revierte_id, creado_en)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          movId,
          m.codigo,
          m.bodegaId,
          m.delta,
          m.tipo,
          // En una entrada es el costo que mandó quien la pide; en una salida,
          // lo que de verdad salió del promedio (§4: «el costo de la salida
          // queda copiado en el movimiento»), para que un cambio posterior del
          // promedio no reescriba lo que ya pasó.
          efecto.costoUnitCents,
          referencia.tipo,
          referencia.id,
          m.motivo ?? null,
          ctx.actor,
          m.revierteId ?? null,
          ctx.ahora,
        ),
    );

    enunciados.push(
      ctx.db
        .prepare("UPDATE existencias SET fisico = fisico + ? WHERE codigo = ? AND bodega_id = ?")
        .bind(m.delta, m.codigo, m.bodegaId),
    );

    /**
     * Y su ASIENTO, en el mismo batch.
     *
     * Una merma es mercancía que se fue y que nadie pagó: en los libros es un
     * gasto. El asiento 12 —Debe 5201 · Haber 1301— estaba escrito, probado y
     * documentado en `dominio/contabilidad.ts` desde el principio, y la cuenta
     * 5201 «Mermas, muestras y regalos» existe en el plan desde la migración
     * 0011. No lo llamaba nadie. Cuarta vez que aparece lo mismo en este
     * repositorio: la pieza terminada sin caller (TRAMPAS §12).
     *
     * Qué costaba: la caja desaparecía del inventario y su costo se quedaba
     * dentro del valor del inventario. El balance cuadraba —el promedio bajaba
     * igual— pero el gasto no existía en ninguna parte, así que la ganancia
     * salía más alta de lo que fue. Un negocio que pierde mercancía y cuyos
     * libros no lo notan.
     *
     * En el MISMO batch y no después: un movimiento sin su asiento, o un
     * asiento sin su movimiento, es justo lo que `enunciadosDeAsiento` existe
     * para evitar.
     *
     * **Sin costo conocido no se inventa un asiento.** Si la mercancía entró
     * sin que nadie dijera lo que costó, el promedio no alcanza y el asiento
     * sería un número inventado — un cero diría que no costó nada (TRAMPAS §7).
     * Se queda sin asiento y se devuelve en `sinAsiento`, que es la misma
     * decisión que ya toma `marcarEntregada` con las ventas sin costo.
     */
    if (SALEN_SIN_VENDER.has(m.tipo) && m.delta < 0) {
      if (efecto.costoUnitCents === null) {
        sinAsiento.push(m.codigo);
      } else {
        const asiento = mermaOMuestra({
          fecha: fechaPanama(ctx.ahora),
          referencia: { tipo: "inventario", id: movId },
          costoCents: Math.abs(m.delta) * efecto.costoUnitCents,
          motivo: m.motivo ?? "",
        });
        if (!asiento.ok) return asiento;
        enunciados.push(...enunciadosDeAsiento(ctx, asiento.datos).enunciados);
      }
    }

    // La fila de control. Mira el estado YA cambiado: si el UPDATE no encontró
    // su fila, o si dejó el físico por debajo de lo reservado, aquí `ok` sale 0
    // y el CHECK tumba el batch entero.
    //
    // Con `quedaEn` exige además que el físico resultante sea exactamente ese
    // número. Eso es lo que hace seguro al conteo, cuyo delta se calculó con
    // una lectura anterior: si alguien vendió en medio, el resultado no
    // coincide, `ok` sale 0 y no se escribe nada.
    //
    // El `? IS NULL OR` es lo que deja que la MISMA consulta sirva para los dos
    // casos sin partir el camino en dos: quien no manda `quedaEn` obtiene la
    // comprobación de siempre.
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM existencias
                          WHERE codigo = ? AND bodega_id = ? AND fisico >= reservado
                            AND (? IS NULL OR fisico = ?)), ?)`,
        )
        .bind(
          ulid(ctx.ahora),
          `mover:${m.tipo}:${m.codigo}`,
          m.codigo,
          m.bodegaId,
          m.quedaEn ?? null,
          m.quedaEn ?? null,
          ctx.ahora,
        ),
    );

    if (!efecto.toca) continue;

    /**
     * El promedio, en el MISMO lote que su movimiento. Es el punto: el libro y
     * el promedio no se pueden separar ni por un fallo en medio.
     *
     * **El UPDATE SUMA, nunca escribe un absoluto.** Con un absoluto se
     * pisaría lo que otro lote hubiera hecho en medio y la fila de control
     * pasaría tan contenta, porque habría escrito justo lo que esperaba. Es
     * exactamente el error que ya se evitó en los asientos de devolución.
     *
     * **En la ENTRADA, el `ON CONFLICT` es lo que FALTABA.** Sin él, una
     * variante sin fila —todas, hoy— no tiene qué actualizar: el UPDATE no
     * casa con nada, no falla, y el costo se perdería en silencio. Con él, la
     * primera entrada crea la fila y las siguientes suman.
     *
     * **En la SALIDA no se puede usar el mismo enunciado, y se comprobó.**
     * SQLite evalúa los CHECK de la fila que PROPONE el INSERT antes de
     * resolver el `ON CONFLICT`, así que un upsert con cantidades negativas
     * muere en `CHECK (unidades >= 0)` aunque la fila exista y la suma final
     * sea positiva (probado: «CHECK constraint failed: unidades >= 0»). Una
     * salida va con un UPDATE relativo, como el de `marcarEntregada`. No le
     * hace falta crear nada: si no hay unidades valoradas, no toca el
     * promedio, así que cuando llega aquí la fila existe — y si alguien la
     * borró en medio, el UPDATE no casa, no falla, y lo caza la fila de
     * control de abajo, que cuenta cero.
     */
    enunciados.push(
      efecto.unidades > 0
        ? ctx.db
            .prepare(
              `INSERT INTO valor_inventario (codigo, unidades, valor_cents) VALUES (?,?,?)
                 ON CONFLICT(codigo) DO UPDATE SET unidades = unidades + excluded.unidades,
                                                   valor_cents = valor_cents + excluded.valor_cents`,
            )
            .bind(m.codigo, efecto.unidades, efecto.valorCents)
        : ctx.db
            .prepare(
              `UPDATE valor_inventario SET unidades = unidades - ?, valor_cents = valor_cents - ?
                WHERE codigo = ?`,
            )
            .bind(-efecto.unidades, -efecto.valorCents, m.codigo),
      /**
       * La fila de control del promedio: las unidades y el valor EXACTOS que
       * este lote esperaba dejar, en absoluto y no en delta.
       *
       * En absoluto es lo único que sirve. Un control que comprobara el delta
       * comprobaría la resta que acaba de hacer la base —algo que ya era
       * cierto— y pasaría siempre (TRAMPAS §1). Así, si otro lote movió el
       * promedio entre la lectura y esta escritura, el resultado no es el que
       * se esperaba, `ok` sale 0, el `CHECK (ok = 1)` tumba el lote entero
       * —movimiento, existencias y promedio— y nadie se queda con un promedio
       * a medias.
       */
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM valor_inventario
                          WHERE codigo = ? AND unidades = ? AND valor_cents = ?), ?)`,
        )
        .bind(
          ulid(ctx.ahora),
          `promedio:${m.tipo}:${m.codigo}`,
          m.codigo,
          despues.unidades,
          despues.valorCents,
          ctx.ahora,
        ),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    // Dos causas distintas, dos mensajes distintos (TRAMPAS §10): que no
    // alcanzara la mercancía, o que el promedio se moviera en medio. Sin
    // separarlas, una carrera del promedio mandaría a contar cajas que están
    // perfectamente. Se pregunta AQUÍ, en el camino del fallo, para no pagar
    // una consulta más en el camino bueno; el lote no escribió nada, así que
    // cualquier diferencia es de otro.
    const carrera = await promedioQueCambio(ctx.db, tocadas);
    if (carrera !== null) {
      return fallo(
        "conflicto_version",
        `el costo promedio de ${carrera} cambió mientras se escribía: no se escribió nada, vuelva a intentarlo`,
      );
    }
    // `sin_stock` y no un código inventado: los doce del contrato son los
    // que hay (03-contratos §5), y el que llega aquí casi siempre es que
    // no alcanzaba.
    return fallo("sin_stock", comoSeLee(e, movimientos));
  }

  // `sinAsiento` sube hasta quien llamó: lo que salió sin costo conocido no
  // tiene gasto en los libros, y eso lo tiene que saber alguien. Callarlo
  // dejaría una pérdida sin registrar y nadie se enteraría nunca.
  return ok({ deshacerId: referencia.id, sinAsiento });
}

/**
 * Traduce el error de la base a algo que se pueda leer.
 *
 * Sin esto, lo que sube es «SQLITE_CONSTRAINT», que no le dice a nadie que lo
 * que pasó es que no había suficiente.
 */
function comoSeLee(e: unknown, movimientos: readonly Movimiento[]): string {
  const crudo = e instanceof Error ? e.message : String(e);

  if (/CHECK|controles/i.test(crudo)) {
    const salidas = movimientos.filter((m) => m.delta < 0).map((m) => m.codigo);
    return salidas.length > 0
      ? `no alcanza el inventario de ${salidas.join(", ")}, o esa bodega no tiene ese artículo`
      : "el inventario no quedó cuadrado y no se escribió nada";
  }
  if (/FOREIGN KEY/i.test(crudo)) {
    return "ese artículo no existe en esa bodega";
  }
  return crudo;
}

/** Lo máximo que acepta una sola operación. Un conteo de tres bodegas cabe. */
const TOPE_DE_LINEAS = 200;

/** Un renglón tal como lo manda el panel. */
export interface LineaDelPanel {
  readonly codigo: string;
  readonly bodegaId: string;
  /** Lo que entra (+) o sale (−). Excluyente con `contado`. */
  readonly delta?: number;
  /** Lo que se contó en el estante. El delta sale de la diferencia. */
  readonly contado?: number;
  /**
   * Con qué costo entra cada unidad, en centavos.
   *
   * Es por donde se carga el costo promedio: una entrada con costo lo sube
   * (`unidades += n`, `valor_cents += n × costo`). Si no viene, el promedio no
   * se toca —las unidades existen y no se sabe qué costaron— y la entrega de
   * esa variante sigue saliendo con `costoDesconocido`. Un cero NO es «no sé»:
   * un cero aquí afirma que la mercancía fue gratis (TRAMPAS §7).
   *
   * **Solo al entrar.** En una salida el costo lo decide el promedio, no quien
   * la pide (05-contabilidad §4), así que mandarlo en una salida se rechaza en
   * vez de ignorarse en silencio.
   */
  readonly costoUnitCents?: number;
}

/**
 * Registrar movimientos desde el panel.
 *
 * Esto es lo que faltaba para que la dueña pudiera cargar el inventario: el
 * motor (`aplicar`) estaba escrito y probado desde hacía semanas, pero no
 * había ninguna puerta hacia él que no fuera el bot o el CRM. Una pantalla de
 * existencias que solo lee deja el sistema creyendo que hay cero de todo.
 *
 * Hace tres cosas que la ruta no debería hacer por su cuenta:
 *
 *  1. **Comprueba el tipo contra la lista**, no contra el CHECK del esquema.
 *  2. **Traduce `contado` a un delta**, leyendo el físico de ahora. Esa lectura
 *     es lo que obliga a mandar `quedaEn`: entre leer y escribir puede entrar
 *     una venta, y entonces el delta calculado ya no lleva al número contado.
 *  3. **Deja pasar el conteo que cuadra.** Contar y que todo esté bien NO es un
 *     error: es el caso bueno. Devuelve `movimientos: 0` y no escribe nada,
 *     porque un movimiento de cero unidades lo prohíbe el esquema y además
 *     ensuciaría el libro con ruido que no pasó.
 */
export async function registrar(
  ctx: Contexto,
  peticion: {
    readonly tipo: unknown;
    readonly motivo?: string;
    readonly lineas: readonly LineaDelPanel[];
  },
): Promise<Resultado<{ movimientos: number; deshacerId: string | null }>> {
  if (!esTipoDeMovimiento(peticion.tipo)) {
    return fallo(
      "entrada_invalida",
      `«${String(peticion.tipo)}» no es un tipo de movimiento; los hay: ${TIPOS_DE_MOVIMIENTO.join(", ")}`,
    );
  }
  const tipo = peticion.tipo;

  if (!Array.isArray(peticion.lineas) || peticion.lineas.length === 0) {
    return fallo("entrada_invalida", "no hay ningún renglón que registrar");
  }
  if (peticion.lineas.length > TOPE_DE_LINEAS) {
    return fallo(
      "entrada_invalida",
      `son ${peticion.lineas.length} renglones y el tope es ${TOPE_DE_LINEAS}`,
    );
  }

  // Cada renglón dice UNA de las dos cosas. Aceptar las dos obligaría a decidir
  // cuál gana, y esa decisión siempre sorprende a alguien.
  for (const l of peticion.lineas) {
    // Lo que llega por HTTP es lo que alguien escribió, no lo que el tipo de
    // TypeScript promete. Un `null` aquí sería un 500 sin explicación en vez
    // de un mensaje que se pueda leer.
    if (typeof (l as unknown) !== "object" || l === null) {
      return fallo("entrada_invalida", "cada renglón tiene que ser un objeto");
    }
    if (typeof l.codigo !== "string" || l.codigo.trim() === "") {
      return fallo("entrada_invalida", "un renglón se quedó sin código de producto");
    }
    if (typeof l.bodegaId !== "string" || l.bodegaId.trim() === "") {
      return fallo("entrada_invalida", `${l.codigo}: falta decir en qué bodega`);
    }

    const tieneDelta = l.delta !== undefined;
    const tieneContado = l.contado !== undefined;
    if (tieneDelta === tieneContado) {
      return fallo(
        "entrada_invalida",
        `${l.codigo}: diga cuánto entra o sale, o cuánto contó, pero no las dos cosas`,
      );
    }
    if (tieneContado && (!Number.isSafeInteger(l.contado) || (l.contado as number) < 0)) {
      return fallo("entrada_invalida", `${l.codigo}: lo contado no puede ser «${l.contado}»`);
    }
    if (tieneDelta && (!Number.isSafeInteger(l.delta) || l.delta === 0)) {
      return fallo("entrada_invalida", `${l.codigo}: el movimiento no puede ser «${l.delta}»`);
    }
    if (l.costoUnitCents !== undefined && (!Number.isSafeInteger(l.costoUnitCents) || l.costoUnitCents < 0)) {
      return fallo("entrada_invalida", `${l.codigo}: el costo no puede ser «${l.costoUnitCents}»`);
    }
  }

  // El físico de ahora, para los renglones que vienen por conteo. En UNA
  // consulta: un conteo de tres bodegas son decenas de renglones, y una
  // consulta por renglón convierte una pantalla en una espera.
  const porContado = peticion.lineas.filter((l) => l.contado !== undefined);
  const fisicoDe = new Map<string, number>();
  const llave = (codigo: string, bodegaId: string): string => `${codigo}\u0000${bodegaId}`;

  if (porContado.length > 0) {
    const codigos = [...new Set(porContado.map((l) => l.codigo))];
    const bodegas = [...new Set(porContado.map((l) => l.bodegaId))];
    const { results } = await ctx.db
      .prepare(
        `SELECT codigo, bodega_id, fisico FROM existencias
          WHERE codigo IN (${codigos.map(() => "?").join(",")})
            AND bodega_id IN (${bodegas.map(() => "?").join(",")})`,
      )
      .bind(...codigos, ...bodegas)
      .all<{ codigo: string; bodega_id: string; fisico: number }>();
    for (const f of results) fisicoDe.set(llave(f.codigo, f.bodega_id), f.fisico);
  }

  const movimientos: Movimiento[] = [];

  /**
   * El costo solo se dice al ENTRAR.
   *
   * En una salida el costo lo decide el promedio (05-contabilidad §4), así que
   * un costo en una salida no se puede cumplir. Ignorarlo en silencio dejaría
   * a quien lo mandó creyendo que se guardó, que es el fallo que menos se nota
   * de los dos. Se comprueba contra el delta YA calculado, porque el renglón
   * de un conteo no dice si entra o sale hasta que se resta lo contado.
   */
  const costoSoloAlEntrar = (l: LineaDelPanel, delta: number): Fallo | null =>
    l.costoUnitCents !== undefined && delta < 0
      ? fallo(
          "entrada_invalida",
          `${l.codigo}: el costo se dice cuando ENTRA mercancía; en una salida lo decide el costo promedio`,
        )
      : null;

  for (const l of peticion.lineas) {
    if (l.contado === undefined) {
      const mal = costoSoloAlEntrar(l, l.delta as number);
      if (mal !== null) return mal;
      movimientos.push({
        codigo: l.codigo,
        bodegaId: l.bodegaId,
        delta: l.delta as number,
        tipo,
        ...(peticion.motivo === undefined ? {} : { motivo: peticion.motivo }),
        ...(l.costoUnitCents === undefined ? {} : { costoUnitCents: l.costoUnitCents }),
      });
      continue;
    }

    const antes = fisicoDe.get(llave(l.codigo, l.bodegaId));
    if (antes === undefined) {
      // No se supone cero: una variante que no está dada de alta en esa bodega
      // y una que está en cero son cosas distintas, y tratarlas igual haría
      // que un código mal tecleado se convirtiera en una entrada de mercancía.
      return fallo("no_encontrado", `${l.codigo} no está dado de alta en esa bodega`);
    }

    const delta = l.contado - antes;
    if (delta === 0) continue; // Contó y cuadra. No pasó nada, y eso está bien.

    const mal = costoSoloAlEntrar(l, delta);
    if (mal !== null) return mal;

    movimientos.push({
      codigo: l.codigo,
      bodegaId: l.bodegaId,
      delta,
      tipo,
      // `quedaEn` es lo que hace que el conteo no pise una venta simultánea.
      quedaEn: l.contado,
      ...(peticion.motivo === undefined ? {} : { motivo: peticion.motivo }),
      ...(l.costoUnitCents === undefined ? {} : { costoUnitCents: l.costoUnitCents }),
    });
  }

  if (movimientos.length === 0) {
    return ok({ movimientos: 0, deshacerId: null });
  }

  const r = await aplicar(ctx, movimientos, { tipo, id: ulid(ctx.ahora) });
  return r.ok ? ok({ movimientos: movimientos.length, deshacerId: r.datos.deshacerId }) : r;
}

/**
 * Mover mercancía de una bodega a otra.
 *
 * Son DOS movimientos —`traslado_salida` y `traslado_entrada`— en el MISMO
 * batch de `aplicar`. Si se escribieran por separado, un fallo en medio
 * dejaría la mercancía existiendo en ninguna parte: ya salió de una y todavía
 * no entró en la otra, y el libro no diría dónde está.
 *
 * No pasa por `registrar()` y no es un descuido: `registrar` toma UN `tipo`
 * para todos sus renglones, y aquí los dos renglones son de tipos distintos a
 * propósito. Lo que se reusa es el motor, que es donde viven la fila de
 * control y la invariante de que el físico no queda por debajo de lo
 * reservado. Un segundo camino hacia `movimientos_inventario` sería un
 * segundo sitio donde olvidarse del control.
 *
 * Las comprobaciones de aquí arriba NO son la defensa —esa es la fila de
 * control de `aplicar`, que mira el estado ya cambiado y aguanta una venta
 * simultánea—: son para que el mensaje diga qué pasó. Sin ellas, mandar un
 * artículo a una bodega donde no está dado de alta devuelve «no alcanza el
 * inventario», que manda a contar cajas cuando el problema era otro.
 */
export async function trasladar(
  ctx: Contexto,
  peticion: {
    readonly codigo: string;
    readonly desdeId: string;
    readonly haciaId: string;
    readonly cantidad: number;
    readonly motivo?: string;
  },
): Promise<Resultado<{ deshacerId: string; codigo: string; cantidad: number }>> {
  const { codigo, desdeId, haciaId, cantidad } = peticion;

  if (typeof codigo !== "string" || codigo.trim() === "") {
    return fallo("entrada_invalida", "diga qué artículo se traslada");
  }
  if (typeof desdeId !== "string" || desdeId.trim() === "") {
    return fallo("entrada_invalida", "diga de qué bodega sale");
  }
  if (typeof haciaId !== "string" || haciaId.trim() === "") {
    return fallo("entrada_invalida", "diga a qué bodega entra");
  }
  if (desdeId === haciaId) {
    return fallo("entrada_invalida", "el origen y el destino son la misma bodega");
  }
  if (!Number.isSafeInteger(cantidad) || cantidad <= 0) {
    return fallo("entrada_invalida", "la cantidad a trasladar tiene que ser un entero positivo");
  }

  // Las dos bodegas y el casillero del artículo en cada una, de una vez. El
  // LEFT JOIN es lo que distingue «la bodega no existe» de «la bodega existe y
  // ese artículo no está dado de alta ahí», que son dos arreglos distintos.
  const { results } = await ctx.db
    .prepare(
      `SELECT b.id, b.nombre, b.activa, e.fisico, e.reservado
         FROM bodegas b
         LEFT JOIN existencias e ON e.bodega_id = b.id AND e.codigo = ?
        WHERE b.id IN (?, ?)`,
    )
    .bind(codigo, desdeId, haciaId)
    .all<{
      id: string;
      nombre: string;
      activa: number;
      fisico: number | null;
      reservado: number | null;
    }>();

  const origen = results.find((b) => b.id === desdeId);
  const destino = results.find((b) => b.id === haciaId);
  if (origen === undefined) return fallo("no_encontrado", "no existe la bodega de origen");
  if (destino === undefined) return fallo("no_encontrado", "no existe la bodega de destino");

  // Entrar mercancía en una bodega que ya no se usa es esconderla: nada va a
  // salir de ahí, porque `bodegaConExistencia` solo mira las activas. Salir de
  // una apagada SÍ se permite, y es justo como se vacía antes de retirarla.
  if (destino.activa !== 1) {
    return fallo(
      "entrada_invalida",
      `«${destino.nombre}» no está en uso: vuelva a ponerla en uso antes de mandarle mercancía`,
    );
  }

  if (origen.fisico === null) {
    return fallo("no_encontrado", `«${codigo}» no está dado de alta en «${origen.nombre}»`);
  }
  if (destino.fisico === null) {
    return fallo("no_encontrado", `«${codigo}» no está dado de alta en «${destino.nombre}»`);
  }

  const libres = origen.fisico - (origen.reservado ?? 0);
  if (libres < cantidad) {
    return fallo(
      "sin_stock",
      `en «${origen.nombre}» quedan ${libres} libres de ${codigo} y quiere mover ${cantidad}`,
    );
  }

  const r = await aplicar(
    ctx,
    [
      {
        codigo,
        bodegaId: desdeId,
        delta: -cantidad,
        tipo: "traslado_salida",
        ...(peticion.motivo === undefined ? {} : { motivo: peticion.motivo }),
      },
      {
        codigo,
        bodegaId: haciaId,
        delta: cantidad,
        tipo: "traslado_entrada",
        ...(peticion.motivo === undefined ? {} : { motivo: peticion.motivo }),
      },
    ],
    { tipo: "traslado", id: ulid(ctx.ahora) },
  );
  if (!r.ok) return r;

  return ok({ deshacerId: r.datos.deshacerId, codigo, cantidad });
}

/**
 * En qué bodega hay con qué.
 *
 * Elige la que más libre tenga, no la primera: repartir las salidas por donde
 * hay evita que una bodega quede en cero mientras otra está llena, que es lo
 * que obliga a un traslado de urgencia.
 */
export async function bodegaConExistencia(
  db: D1Database,
  codigo: string,
  cantidad: number,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare(
      `SELECT b.id, b.nombre FROM existencias e
       JOIN bodegas b ON b.id = e.bodega_id
       WHERE e.codigo = ? AND b.activa = 1 AND e.fisico - e.reservado >= ?
       ORDER BY e.fisico - e.reservado DESC
       LIMIT 1`,
    )
    .bind(codigo, cantidad)
    .first<{ id: string; nombre: string }>();
}

export async function bodegaPorNombre(
  db: D1Database,
  nombre: string,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare("SELECT id, nombre FROM bodegas WHERE nombre = ? AND activa = 1")
    .bind(nombre)
    .first<{ id: string; nombre: string }>();
}

/**
 * Resuelve en qué bodega va cada línea antes de tocar nada.
 *
 * Se hace entero y por adelantado: si la tercera línea no tiene dónde salir, no
 * se ha escrito nada todavía y el mensaje puede decir exactamente cuál falló.
 */
export async function resolverLineas(
  db: D1Database,
  lineas: readonly Linea[],
): Promise<Resultado<{ codigo: string; cantidad: number; bodegaId: string; bodega: string }[]>> {
  const salida: { codigo: string; cantidad: number; bodegaId: string; bodega: string }[] = [];

  for (const l of lineas) {
    if (!Number.isSafeInteger(l.cantidad) || l.cantidad <= 0) {
      return fallo("entrada_invalida", `la cantidad de ${l.codigo} tiene que ser un entero positivo`);
    }

    const bodega =
      l.bodega === undefined
        ? await bodegaConExistencia(db, l.codigo, l.cantidad)
        : await bodegaPorNombre(db, l.bodega);

    if (bodega === null) {
      return l.bodega === undefined
        ? fallo("sin_stock", `no hay ${l.cantidad} de ${l.codigo} en ninguna bodega`)
        : fallo("no_encontrado", `no existe la bodega «${l.bodega}»`);
    }

    salida.push({ codigo: l.codigo, cantidad: l.cantidad, bodegaId: bodega.id, bodega: bodega.nombre });
  }

  return ok(salida);
}

/**
 * Deshacer: escribir lo contrario, nunca borrar.
 *
 * Los libros no se editan (02-datos §1). Deshacer una venta no es quitar la
 * venta: es anotar la entrada que la compensa, con `revierte_id` apuntando al
 * movimiento original para que se vea qué deshizo qué.
 *
 * Deshacer dos veces no duplica nada: la segunda no encuentra movimientos sin
 * revertir y se va con `no_encontrado`.
 */
export async function deshacer(
  ctx: Contexto,
  deshacerId: string,
): Promise<Resultado<{ hecho: true; movimientos: number }>> {
  const { results } = await ctx.db
    .prepare(
      `SELECT m.id, m.codigo, m.bodega_id, m.delta, m.tipo, m.costo_unit_cents
       FROM movimientos_inventario m
       WHERE m.referencia_id = ?
         AND NOT EXISTS (SELECT 1 FROM movimientos_inventario r WHERE r.revierte_id = m.id)`,
    )
    .bind(deshacerId)
    .all<{
      id: string;
      codigo: string;
      bodega_id: string;
      delta: number;
      tipo: string;
      costo_unit_cents: number | null;
    }>();

  if (results.length === 0) {
    return fallo("no_encontrado", "no hay nada que deshacer con ese identificador (o ya se deshizo)");
  }

  const contrarios: Movimiento[] = results.map((m) => ({
    codigo: m.codigo,
    bodegaId: m.bodega_id,
    delta: -m.delta,
    // El contrario de una salida es una devolución y el de una entrada un
    // ajuste: así el tipo sigue diciendo qué pasó en vez de mentir «venta».
    tipo: m.delta < 0 ? ("devolucion" as const) : ("ajuste" as const),
    motivo: `deshace ${deshacerId}`,
    revierteId: m.id,
    ...(m.costo_unit_cents === null ? {} : { costoUnitCents: m.costo_unit_cents }),
    /**
     * Deshacer una ENTRADA que entró sin costo no baja el promedio.
     *
     * Esas unidades subieron el físico y no subieron el promedio, así que al
     * deshacerlas hay que bajar el físico y nada más. Sin esto, el contrario
     * sería una salida como cualquier otra y se llevaría su parte proporcional
     * del promedio: sacaría de `1301` un valor que nunca entró ahí y dejaría
     * más caras las unidades que sí tienen costo. Es destruir valor en
     * silencio, y cuadra igual.
     *
     * Es también lo que hace que **deshacer un traslado no invente ni
     * destruya nada**: la entrada del traslado no lleva costo, su contrario
     * entra por aquí, y la salida del traslado vuelve como una entrada sin
     * costo, que tampoco toca el promedio. Las dos mitades siguen anulándose.
     *
     * El caso contrario —deshacer una SALIDA que salió sin costo— no necesita
     * marca: el contrario es una entrada sin `costoUnitCents`, y una entrada
     * sin costo ya no toca el promedio.
     */
    ...(m.delta > 0 && m.costo_unit_cents === null ? { fueraDelPromedio: true } : {}),
  }));

  const r = await aplicar(ctx, contrarios, { tipo: "deshacer", id: ulid(ctx.ahora) });
  if (!r.ok) return r;

  return ok({ hecho: true as const, movimientos: contrarios.length });
}

/**
 * Las etiquetas de disponibilidad DESPUÉS de mover.
 *
 * El CRM las necesita para contestar en el mismo turno («quedan pocas»), y
 * tienen que salir de después y no de antes, o el bot diría que hay de algo
 * que se acaba de llevar la última caja.
 */
export async function etiquetasDe(
  db: D1Database,
  codigos: readonly string[],
): Promise<Record<string, number>> {
  if (codigos.length === 0) return {};
  const marcas = codigos.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT codigo, SUM(fisico - reservado) AS libres FROM existencias
       WHERE codigo IN (${marcas}) GROUP BY codigo`,
    )
    .bind(...codigos)
    .all<{ codigo: string; libres: number }>();

  return Object.fromEntries(results.map((r) => [r.codigo, r.libres]));
}
