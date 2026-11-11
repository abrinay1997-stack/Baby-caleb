import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { ulid } from "../ids";

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
}

export interface Contexto {
  readonly db: D1Database;
  readonly actor: string;
  readonly ahora: number;
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
): Promise<Resultado<{ deshacerId: string }>> {
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
  }

  const enunciados: D1PreparedStatement[] = [];

  for (const m of movimientos) {
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO movimientos_inventario
             (id, codigo, bodega_id, delta, tipo, costo_unit_cents, referencia_tipo, referencia_id,
              motivo, actor, revierte_id, creado_en)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ulid(ctx.ahora),
          m.codigo,
          m.bodegaId,
          m.delta,
          m.tipo,
          m.costoUnitCents ?? null,
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
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (e) {
    // `sin_stock` y no un código inventado: los doce del contrato son los
    // que hay (03-contratos §5), y el que llega aquí casi siempre es que
    // no alcanzaba.
    return fallo("sin_stock", comoSeLee(e, movimientos));
  }

  return ok({ deshacerId: referencia.id });
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
  /** Con qué costo entra, para el asiento. Solo tiene sentido al entrar. */
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

  for (const l of peticion.lineas) {
    if (l.contado === undefined) {
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
