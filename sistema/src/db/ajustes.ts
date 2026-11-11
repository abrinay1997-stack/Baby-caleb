import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { CLAVES, esClave, esPendiente, validar, type Clave, type Valor } from "../dominio/ajustes";
import reglas from "../../reglas.json";

/**
 * Leer y cambiar los ajustes del negocio en D1.
 *
 * ## La tabla es un historial, no un formulario
 *
 * `ajustes` tiene llave `(clave, version)` y **solo crece**: cambiar una cifra
 * es insertar la versión siguiente, nunca editar la fila que hay. Eso no es
 * puntilloso, es el punto: es lo que contesta «¿quién bajó la comisión en
 * marzo?», y un `UPDATE` borraría la respuesta. Por eso aquí no hay ninguna
 * función que actualice.
 *
 * Vale la versión más alta cuya vigencia ya empezó (docs/plan/02-datos.md §9).
 * Lo que no tiene ninguna versión cae en el valor de fábrica de `reglas.json`,
 * y `leerVigentes` dice de dónde sale cada valor: una pantalla que enseña un
 * número sin decir de dónde viene invita a creérselo.
 *
 * ## Tres reglas duras
 *
 *  1. **`cambiado_por` sale de la sesión, nunca del cuerpo de la petición.**
 *     Si viajara en el cuerpo, cualquiera podría firmar un cambio con el
 *     nombre de otro, y el historial dejaría de servir para lo único que
 *     sirve.
 *  2. **`vigente_desde` solo hacia adelante.** Una vigencia en el pasado
 *     reescribiría la historia de un pedido ya cobrado.
 *  3. **Si dos personas guardan a la vez, la segunda falla.** No se
 *     sobrescribe en silencio. La protege la llave primaria —las dos calculan
 *     la misma versión y la segunda choca— y detrás va una fila de control que
 *     mira que lo escrito sea lo que este batch quería escribir.
 */

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

export interface ContextoAjustes {
  readonly db: D1Database;
  readonly ahora: number;
  /**
   * Quién está cambiando esto. Sale de la sesión (el correo del usuario de
   * Access), nunca del cuerpo de la petición.
   */
  readonly actor: string;
}

/** Leer no necesita saber quién pregunta: un ajuste vigente es el mismo para todos. */
export type ContextoDeLectura = Pick<ContextoAjustes, "db" | "ahora">;

const DE_FABRICA = reglas as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

export interface AjusteVigente {
  readonly clave: Clave;
  readonly valor: Valor;
  /** `true` si vale `"PENDIENTE"`: falta decidirlo, que no es lo mismo que cero. */
  readonly pendiente: boolean;
  readonly origen: "fabrica" | "guardado";
  readonly version: number | null;
  readonly vigente_desde: number | null;
  readonly cambiado_por: string | null;
  readonly motivo: string | null;
  /**
   * Qué se ignoró y por qué. Null si no se ignoró nada.
   *
   * Pasa cuando lo guardado en D1 no pasa la validación de hoy: alguien lo
   * escribió a mano en la consola de D1, o el esquema cambió desde que se
   * guardó. En ese caso el valor que vale es el de fábrica —el sistema no corre
   * con un dato que no sabe interpretar— y esto dice qué había, para que se
   * pueda arreglar en vez de quedarse sin explicación.
   */
  readonly aviso: string | null;
}

interface Fila {
  clave: string;
  version: number;
  valor_json: string;
  vigente_desde: number;
  cambiado_por: string;
  motivo: string | null;
}

/**
 * Lo que vale cada ajuste ahora mismo, con su procedencia.
 *
 * Devuelve las quince claves siempre, en el orden de `ESQUEMAS` —que es el de
 * la pantalla—, estén guardadas o no. Una clave que desaparece de la lista es
 * una que nadie vuelve a buscar.
 */
export async function leerVigentes(
  ctx: ContextoDeLectura,
): Promise<Resultado<{ ajustes: AjusteVigente[]; ahora: number }>> {
  let filas: Fila[];
  try {
    const { results } = await ctx.db
      .prepare(
        // La misma consulta que ya usaba el panel: la versión más alta de cada
        // clave entre las que YA empezaron a valer. Una versión programada para
        // el futuro está en la tabla y no cuenta todavía.
        `SELECT a.clave, a.version, a.valor_json, a.vigente_desde, a.cambiado_por, a.motivo
         FROM ajustes a
         WHERE a.vigente_desde <= ?1
           AND a.version = (SELECT MAX(b.version) FROM ajustes b
                            WHERE b.clave = a.clave AND b.vigente_desde <= ?1)`,
      )
      .bind(ctx.ahora)
      .all<Fila>();
    filas = results;
  } catch {
    return fallo("interno", "no se pudieron leer los ajustes");
  }

  const guardadas = new Map(filas.map((f) => [f.clave, f]));

  const ajustes = CLAVES.map((clave): AjusteVigente => {
    const deFabrica = (): AjusteVigente => {
      const valor = DE_FABRICA[clave];
      return {
        clave,
        // El valor de fábrica ya pasa `validar` —hay una prueba en el dominio
        // que lo comprueba—, así que aquí no hace falta volver a mirarlo.
        valor: valor as Valor,
        pendiente: esPendiente(valor),
        origen: "fabrica",
        version: null,
        vigente_desde: null,
        cambiado_por: null,
        motivo: null,
        aviso: null,
      };
    };

    const fila = guardadas.get(clave);
    if (fila === undefined) return deFabrica();

    let leido: unknown;
    try {
      leido = JSON.parse(fila.valor_json);
    } catch {
      return {
        ...deFabrica(),
        aviso: `La versión ${fila.version} que guardó ${fila.cambiado_por} no se puede leer, así que vale el valor de arranque. Avísele a Juan.`,
      };
    }

    const revisado = validar(clave, leido);
    if (!revisado.ok) {
      // No se devuelve el valor malo: lo que dependa de este ajuste correría
      // con un dato que el sistema no sabe interpretar. Vale el de fábrica y se
      // dice por qué.
      return {
        ...deFabrica(),
        aviso: `La versión ${fila.version} que guardó ${fila.cambiado_por} no se puede usar (${revisado.mensaje}), así que vale el valor de arranque.`,
      };
    }

    return {
      clave,
      valor: revisado.datos,
      pendiente: esPendiente(revisado.datos),
      origen: "guardado",
      version: fila.version,
      vigente_desde: fila.vigente_desde,
      cambiado_por: fila.cambiado_por,
      motivo: fila.motivo,
      aviso: null,
    };
  });

  return ok({ ajustes, ahora: ctx.ahora });
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

export interface VersionDeAjuste {
  readonly version: number;
  /** `null` si lo guardado ya no se puede leer. El historial no se corrige. */
  readonly valor: Valor | null;
  readonly vigente_desde: number;
  readonly cambiado_por: string;
  readonly motivo: string | null;
  /** La que manda ahora mismo. */
  readonly vigente: boolean;
  /** Programada: su vigencia todavía no ha empezado. */
  readonly futura: boolean;
}

/**
 * Todas las versiones de una clave, de la más nueva a la más vieja.
 *
 * El valor de una versión vieja se devuelve tal como se guardó aunque hoy no
 * pasara la validación: el historial cuenta lo que pasó, y «corregirlo» sería
 * borrar la prueba de que alguien guardó eso aquel día.
 */
export async function historial(
  ctx: ContextoDeLectura,
  clave: string,
): Promise<Resultado<{ clave: Clave; versiones: VersionDeAjuste[] }>> {
  if (!esClave(clave)) {
    return fallo("no_encontrado", `«${clave}» no es un ajuste de este sistema.`);
  }

  let filas: Fila[];
  try {
    const { results } = await ctx.db
      .prepare(
        `SELECT clave, version, valor_json, vigente_desde, cambiado_por, motivo
         FROM ajustes WHERE clave = ? ORDER BY version DESC`,
      )
      .bind(clave)
      .all<Fila>();
    filas = results;
  } catch {
    return fallo("interno", "no se pudo leer el historial de este ajuste");
  }

  // La que manda es la de versión más alta entre las que ya empezaron. Se
  // calcula sobre las mismas filas que se devuelven para que la pantalla y la
  // lectura de arriba no puedan discrepar.
  const empezadas = filas.filter((f) => f.vigente_desde <= ctx.ahora);
  const laQueManda = empezadas.length === 0 ? null : Math.max(...empezadas.map((f) => f.version));

  const versiones = filas.map((f): VersionDeAjuste => {
    let valor: Valor | null = null;
    try {
      valor = JSON.parse(f.valor_json) as Valor;
    } catch {
      valor = null;
    }
    return {
      version: f.version,
      valor,
      vigente_desde: f.vigente_desde,
      cambiado_por: f.cambiado_por,
      motivo: f.motivo,
      vigente: f.version === laQueManda,
      futura: f.vigente_desde > ctx.ahora,
    };
  });

  return ok({ clave, versiones });
}

// ---------------------------------------------------------------------------
// Guardar
// ---------------------------------------------------------------------------

/**
 * Lo que hace falta para cambiar un ajuste.
 *
 * No lleva `cambiado_por` a propósito: eso sale de `ctx.actor`, o sea de la
 * sesión. Si viajara aquí, cualquiera podría firmar con el nombre de otro.
 */
export interface Cambio {
  readonly clave: string;
  readonly valor: unknown;
  /** Por qué. Obligatorio: un historial sin motivos no contesta nada. */
  readonly motivo: string;
  /** Desde cuándo vale, en ms UTC. Si falta, ahora. Nunca en el pasado. */
  readonly vigenteDesde?: number;
}

export interface Guardado {
  readonly clave: Clave;
  readonly version: number;
  readonly vigente_desde: number;
  readonly valor: Valor;
}

/** Lo más largo que puede ser un motivo. Un motivo es una frase, no un informe. */
const MOTIVO_MAXIMO = 500;

/**
 * Los dos enunciados del guardado: el INSERT y su control.
 *
 * Se devuelven en vez de ejecutarse para que **el control se pueda probar sin
 * el INSERT**. Es el guardia contra la actualización perdida, y un guardia que
 * nadie prueba es un guardia del que no se sabe nada — la misma razón por la
 * que `catalogo-admin.ts` exporta los suyos.
 */
export function enunciadosDeGuardado(
  ctx: ContextoAjustes,
  datos: {
    readonly clave: Clave;
    readonly valorJson: string;
    readonly version: number;
    readonly vigenteDesde: number;
    readonly motivo: string;
  },
): D1PreparedStatement[] {
  return [
    // La versión va calculada AQUÍ, en el enunciado, y no con un
    // `MAX(version)+1` dentro del SQL. Con el subconsulta las dos personas que
    // guardan a la vez se llevarían versiones distintas y las dos entrarían:
    // la segunda ganaría y la primera se habría ido creyendo que su valor es el
    // que vale. Con el número fijo, las dos calculan el mismo y la llave
    // primaria tumba a la segunda, que es lo que se pidió: fallar, no pisar.
    ctx.db
      .prepare(
        `INSERT INTO ajustes (clave, version, valor_json, vigente_desde, cambiado_por, motivo)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        datos.clave,
        datos.version,
        datos.valorJson,
        datos.vigenteDesde,
        ctx.actor,
        datos.motivo,
      ),
    // El control mira el estado YA ESCRITO, y mira EL VALOR, no solo la
    // versión.
    //
    // Comprobar `version = la que esperaba` a secas no detecta nada: si otro
    // guardó en medio, esa versión YA existe —es la suya— y el control la
    // encuentra y da por bueno un guardado que no escribió una sola fila. Es la
    // misma lección amarga de `catalogo-admin.ts`, y aquí es más fácil caer en
    // ella porque la versión es justo lo que las dos personas calculan igual.
    //
    // Mirando también el valor, el actor y la vigencia que este batch quería
    // dejar escritos, una fila ajena no puede hacerse pasar por la nuestra.
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM ajustes
                        WHERE clave = ? AND version = ? AND valor_json = ?
                          AND vigente_desde = ? AND cambiado_por = ?), ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        `ajuste:${datos.clave}`,
        datos.clave,
        datos.version,
        datos.valorJson,
        datos.vigenteDesde,
        ctx.actor,
        ctx.ahora,
      ),
  ];
}

/**
 * Cambia un ajuste: escribe la versión siguiente.
 *
 * Nunca toca la fila que hay. Comprueba, en este orden:
 *
 *  1. que la clave exista y el valor valga lo que su esquema dice;
 *  2. que haya un motivo;
 *  3. que la vigencia no empiece en el pasado ni antes de una versión que ya
 *     esté programada.
 */
export async function guardar(
  ctx: ContextoAjustes,
  cambio: Cambio,
): Promise<Resultado<Guardado>> {
  const revisado = validar(cambio.clave, cambio.valor);
  if (!revisado.ok) return revisado;
  // `validar` ya dijo que la clave existe; esto es para que TypeScript lo sepa.
  const clave = cambio.clave as Clave;

  const motivo = cambio.motivo.trim();
  if (motivo === "") {
    // El motivo es lo que hace que el historial sirva de algo. Sin él queda un
    // registro de guardados —quién tocó qué y cuándo— que no contesta por qué,
    // que es justo la pregunta que alguien va a hacer dentro de seis meses.
    return fallo(
      "entrada_invalida",
      "Escriba por qué cambia esta regla. Queda guardado con su nombre y la fecha, y es lo que explica el cambio dentro de seis meses.",
    );
  }
  if (motivo.length > MOTIVO_MAXIMO) {
    return fallo("entrada_invalida", "El motivo es demasiado largo: resúmalo en una frase.");
  }

  if (ctx.actor.trim() === "") {
    // Un cambio sin firma no se guarda. Si esto salta, es que la ruta no está
    // pasando el usuario de la sesión, y guardarlo con un «panel» genérico
    // dejaría un historial que no contesta quién.
    return fallo("no_autorizado", "No se sabe quién está haciendo este cambio.");
  }

  const vigenteDesde = cambio.vigenteDesde ?? ctx.ahora;
  if (!Number.isSafeInteger(vigenteDesde)) {
    return fallo("entrada_invalida", "La fecha desde la que vale este cambio no se entiende.");
  }
  if (vigenteDesde < ctx.ahora) {
    return fallo(
      "entrada_invalida",
      "Un cambio no puede empezar a valer en el pasado: lo que ya pasó se queda como pasó. Déjelo desde hoy o desde una fecha futura.",
    );
  }

  let maximos: { version: number; vigente_desde: number } | null;
  try {
    maximos = await ctx.db
      .prepare(
        // MAX(version) sobre TODAS las versiones, incluidas las programadas
        // para el futuro: la siguiente va detrás de todas, no detrás de la que
        // vale hoy.
        `SELECT COALESCE(MAX(version), 0) AS version,
                COALESCE(MAX(vigente_desde), 0) AS vigente_desde
         FROM ajustes WHERE clave = ?`,
      )
      .bind(clave)
      .first<{ version: number; vigente_desde: number }>();
  } catch {
    return fallo("interno", "no se pudo leer el ajuste antes de cambiarlo");
  }

  const versionAnterior = maximos?.version ?? 0;
  const vigenciaAnterior = maximos?.vigente_desde ?? 0;

  if (vigenteDesde < vigenciaAnterior) {
    // Si esta versión empezara antes que una ya programada, la programada no
    // llegaría a valer nunca: lo vigente es la versión MÁS ALTA entre las
    // empezadas, y la nueva es más alta. Quedaría una fila en la tabla, con su
    // fecha y su motivo, que nunca va a tener efecto — y nadie lo vería.
    return fallo(
      "transicion_invalida",
      `Ya hay un cambio de esta regla programado para más adelante. Este tendría que empezar en esa fecha o después; si no, el programado no llegaría a valer nunca.`,
    );
  }

  const version = versionAnterior + 1;
  const valorJson = JSON.stringify(revisado.datos);

  try {
    await ctx.db.batch(
      enunciadosDeGuardado(ctx, { clave, valorJson, version, vigenteDesde, motivo }),
    );
  } catch {
    return fallo(
      "conflicto_version",
      "Alguien cambió esta regla mientras usted la tenía abierta. Cierre y vuelva a abrirla para ver lo que hay ahora.",
    );
  }

  return ok({ clave, version, vigente_desde: vigenteDesde, valor: revisado.datos });
}
