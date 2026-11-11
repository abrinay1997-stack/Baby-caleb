import { ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { guardar, leerVigentes } from "./ajustes";
import {
  CONECTORES,
  MODOS,
  PASARELAS,
  contextoDeCifrado,
  esModo,
  esPasarela,
  puedeEncenderse,
  queFalta,
  validarCredencial,
  type Modo,
  type Pasarela,
} from "../dominio/pasarelas";
import { abrirLlaveMaestra, cifrar, descifrar } from "../seguridad/cifrado";

/**
 * Configurar las pasarelas de cobro en D1.
 *
 * ## La regla que manda aquí: un secreto que entra NO SALE
 *
 * De este módulo no hay forma de obtener el valor de una credencial para
 * enseñárselo a nadie. No «no se usa»: no existe. Lo que hay es:
 *
 *  - `estado()`, que dice SI una credencial está puesta, quién la puso y
 *    cuándo. Su consulta **no nombra la columna `secreto_cifrado`**, así que
 *    aunque alguien devolviera la fila entera por error, el secreto no viene en
 *    ella. Eso es más fuerte que acordarse de borrarlo antes de responder.
 *  - `abrirCredenciales()`, que sí descifra, para el adaptador que habla con la
 *    pasarela. Devuelve un `Map`, y eso es a propósito: `JSON.stringify` de un
 *    `Map` es `{}`. Si alguien, dentro de un año y con prisa, mete esto en una
 *    respuesta del panel, lo que sale al cable es un objeto vacío. La
 *    convención protege; la forma del dato defiende.
 *
 * Y en ningún sitio de este archivo hay un `console.log`, ni un mensaje de
 * error, ni una línea del libro que lleve un valor. El libro no tiene ni
 * columna donde cupiera (migrations/0010).
 *
 * ## Quién manda sobre qué
 *
 *  - **Qué pide cada pasarela y qué se acepta**: `src/dominio/pasarelas.ts`.
 *  - **Qué está encendido**: `ajustes.pasarelas_activas`, por `./ajustes`. No
 *    hay una segunda copia aquí. Encender es cambiar ese ajuste, con su
 *    historial, su firma y su motivo.
 *  - **El modo (prueba o real)**: la tabla `pasarelas` de esta migración.
 *  - **El secreto**: cifrado, en `pasarela_credenciales`. La llave maestra vive
 *    en un secreto del Worker; sin ella, guardar FALLA.
 */

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

export interface ContextoPasarelas {
  readonly db: D1Database;
  readonly ahora: number;
  /** Quién. Sale de la sesión, nunca del cuerpo de la petición. */
  readonly actor: string;
  /**
   * El material de la llave maestra, tal cual viene del secreto del Worker
   * (`env.PASARELAS_LLAVE_MAESTRA`). Se pasa en vez de leerse de un global para
   * que las pruebas puedan correr con una llave propia y para que se vea, en la
   * ruta, que esto necesita el secreto.
   */
  readonly llaveMaestra?: string | undefined;
}

/**
 * Leer el estado no necesita saber quién pregunta —el permiso lo comprueba la
 * ruta— pero sí la llave maestra, para poder decir si está puesta. Decir «si
 * está puesta o no» es lo único que se puede decir de un secreto.
 */
export type ContextoDeLectura = Omit<ContextoPasarelas, "actor">;

/** La clave de ajustes que dice qué está encendido. No hay otra. */
const CLAVE_ENCENDIDAS = "pasarelas_activas";

/** Lo más largo que puede ser un motivo, como en `ajustes`. */
const MOTIVO_MAXIMO = 500;

/** Cuántas líneas del libro se devuelven con el estado. */
const LINEAS_DEL_LIBRO = 30;

// ---------------------------------------------------------------------------
// Leer el estado: sin un solo valor
// ---------------------------------------------------------------------------

export interface CredencialPuesta {
  readonly nombre: string;
  /** Lo único que se puede saber de un secreto desde fuera. */
  readonly puesta: boolean;
  readonly version: number | null;
  readonly puesta_por: string | null;
  readonly puesta_en: number | null;
  /**
   * Con qué llave maestra se cifró. Sirve para una sola cosa: enterarse de que
   * una credencial vieja ya no se puede abrir porque la llave cambió.
   */
  readonly llave_id: string | null;
}

export interface EstadoDeModo {
  readonly modo: Modo;
  /** Si es el modo en el que está la pasarela ahora mismo. */
  readonly esElActual: boolean;
  readonly credenciales: readonly CredencialPuesta[];
  /** Los títulos de las obligatorias que faltan. Para decir CUÁL falta. */
  readonly faltan: readonly string[];
  readonly completo: boolean;
}

export interface EstadoDePasarela {
  readonly pasarela: Pasarela;
  readonly titulo: string;
  readonly explica: string;
  /** Por qué todavía no se puede configurar, o `null`. */
  readonly por_confirmar: string | null;
  readonly fuente: string;
  readonly modo: Modo;
  readonly modo_cambiado_por: string | null;
  readonly modo_cambiado_en: number | null;
  /** Sale de `ajustes.pasarelas_activas`, que es su único dueño. */
  readonly encendida: boolean;
  readonly modos: readonly EstadoDeModo[];
  readonly puede_encenderse: boolean;
  /** En español y nombrando lo que falta. `null` si se puede encender. */
  readonly por_que_no: string | null;
  /**
   * Está encendida y le falta algo para poder estarlo.
   *
   * No debería pasar por estas funciones —`encender` no deja— pero la lista de
   * encendidas también se puede editar desde la pantalla de Ajustes, que no
   * sabe nada de credenciales. Si pasa, la pantalla tiene que gritarlo: una
   * pasarela encendida a medias es un checkout que ofrece un botón que no
   * cobra.
   */
  readonly incoherente: boolean;
}

export interface LineaDelLibro {
  readonly id: string;
  readonly pasarela: Pasarela;
  readonly accion: "credencial_puesta" | "credencial_cambiada" | "modo_cambiado";
  readonly modo: Modo;
  readonly credencial: string | null;
  readonly version: number | null;
  readonly actor: string;
  readonly motivo: string;
  readonly creado_en: number;
}

export interface EstadoDeLasPasarelas {
  readonly pasarelas: readonly EstadoDePasarela[];
  /** Si el sistema puede cifrar. No se dice nada más de la llave. */
  readonly llave_maestra_puesta: boolean;
  /** Qué le pasa a la llave maestra, si le pasa algo. Sin su valor. */
  readonly llave_maestra_problema: string | null;
  readonly libro: readonly LineaDelLibro[];
}

interface FilaPasarela {
  pasarela: string;
  modo: string;
  modo_cambiado_por: string | null;
  modo_cambiado_en: number | null;
}

interface FilaCredencial {
  pasarela: string;
  modo: string;
  credencial: string;
  version: number;
  llave_id: string;
  puesta_por: string;
  puesta_en: number;
}

/**
 * El estado completo para la pantalla.
 *
 * Contesta de un vistazo las cuatro preguntas que importan: qué pasarelas hay,
 * cuáles están encendidas, a cuál le falta algo (y QUÉ le falta, por su nombre)
 * y en qué modo está cada una.
 */
export async function estado(
  ctx: ContextoDeLectura,
): Promise<Resultado<EstadoDeLasPasarelas>> {
  const llave = await abrirLlaveMaestra(ctx.llaveMaestra);

  let modos: FilaPasarela[];
  let puestas: FilaCredencial[];
  let libro: LineaDelLibro[];
  try {
    const [a, b, c] = await ctx.db.batch<unknown>([
      ctx.db.prepare(
        "SELECT pasarela, modo, modo_cambiado_por, modo_cambiado_en FROM pasarelas",
      ),
      // `secreto_cifrado` NO está en esta lista, y no es un descuido al
      // revés: es la defensa. Lo que no se lee no se puede devolver por
      // error, ni acabar en un registro, ni viajar dentro de un objeto que
      // alguien serializa entero sin mirar.
      ctx.db.prepare(
        `SELECT pasarela, modo, credencial, version, llave_id, puesta_por, puesta_en
           FROM pasarela_credenciales`,
      ),
      ctx.db
        .prepare(
          `SELECT id, pasarela, accion, modo, credencial, version, actor, motivo, creado_en
             FROM pasarela_bitacora ORDER BY creado_en DESC, id DESC LIMIT ?`,
        )
        .bind(LINEAS_DEL_LIBRO),
    ]);
    modos = (a?.results ?? []) as FilaPasarela[];
    puestas = (b?.results ?? []) as FilaCredencial[];
    libro = (c?.results ?? []) as LineaDelLibro[];
  } catch {
    return fallo("interno", "no se pudo leer la configuración de las pasarelas");
  }

  const encendidas = await leerEncendidas(ctx);
  if (!encendidas.ok) return encendidas;

  const porPasarela = new Map(modos.map((f) => [f.pasarela, f]));

  const pasarelas = PASARELAS.map((p): EstadoDePasarela => {
    const conector = CONECTORES[p];
    const fila = porPasarela.get(p);
    // Si la fila no está —alguien la borró a mano— se trata como `prueba`, que
    // es el modo que no cobra. Fallar hacia el lado que no mueve dinero.
    const modo: Modo = fila !== undefined && esModo(fila.modo) ? fila.modo : "prueba";
    const encendida = encendidas.datos.includes(p);

    const estadoDeModos = MODOS.map((m): EstadoDeModo => {
      const nombres = puestas
        .filter((c) => c.pasarela === p && c.modo === m)
        .map((c) => c.credencial);
      const faltan = queFalta(p, nombres);
      return {
        modo: m,
        esElActual: m === modo,
        credenciales: conector.credenciales.map((cr): CredencialPuesta => {
          const puesta = puestas.find(
            (c) => c.pasarela === p && c.modo === m && c.credencial === cr.nombre,
          );
          return {
            nombre: cr.nombre,
            puesta: puesta !== undefined,
            version: puesta?.version ?? null,
            puesta_por: puesta?.puesta_por ?? null,
            puesta_en: puesta?.puesta_en ?? null,
            llave_id: puesta?.llave_id ?? null,
          };
        }),
        faltan: faltan.map((c) => c.titulo),
        // Una pasarela sin credenciales confirmadas NO está completa: si lo
        // estuviera, «no falta nada» sonaría a «lista para encender».
        completo: conector.porConfirmar === null && faltan.length === 0,
      };
    });

    const nombresDelModo = puestas
      .filter((c) => c.pasarela === p && c.modo === modo)
      .map((c) => c.credencial);
    const decision = puedeEncenderse(p, nombresDelModo);

    return {
      pasarela: p,
      titulo: conector.titulo,
      explica: conector.explica,
      por_confirmar: conector.porConfirmar,
      fuente: conector.fuente,
      modo,
      modo_cambiado_por: fila?.modo_cambiado_por ?? null,
      modo_cambiado_en: fila?.modo_cambiado_en ?? null,
      encendida,
      modos: estadoDeModos,
      puede_encenderse: decision.puede,
      por_que_no: decision.puede ? null : decision.motivo,
      incoherente: encendida && !decision.puede,
    };
  });

  return ok({
    pasarelas,
    llave_maestra_puesta: llave.ok,
    llave_maestra_problema: llave.ok ? null : llave.mensaje,
    libro,
  });
}

/** Lo que dice `ajustes.pasarelas_activas` ahora mismo. */
async function leerEncendidas(ctx: {
  readonly db: D1Database;
  readonly ahora: number;
}): Promise<Resultado<Pasarela[]>> {
  const vigentes = await leerVigentes(ctx);
  if (!vigentes.ok) return vigentes;
  const ajuste = vigentes.datos.ajustes.find((a) => a.clave === CLAVE_ENCENDIDAS);
  const valor = ajuste?.valor;
  if (!Array.isArray(valor)) {
    // `pasarelas_activas` no admite PENDIENTE y su valor de fábrica es `[]`,
    // así que esto solo pasa si lo guardado no se puede leer — y en ese caso
    // `leerVigentes` ya devolvió el valor de fábrica con su aviso. Se trata
    // como «ninguna encendida»: es el lado que no cobra.
    return ok([]);
  }
  return ok(valor.filter(esPasarela));
}

// ---------------------------------------------------------------------------
// Poner una credencial
// ---------------------------------------------------------------------------

export interface CredencialNueva {
  readonly pasarela: unknown;
  readonly modo: unknown;
  readonly credencial: unknown;
  /** El secreto. Entra, se cifra y no vuelve a salir. */
  readonly valor: unknown;
  readonly motivo: string;
}

export interface CredencialGuardada {
  readonly pasarela: Pasarela;
  readonly modo: Modo;
  readonly credencial: string;
  readonly version: number;
  /** `false` cuando ya había una y se reemplazó. */
  readonly primera_vez: boolean;
}

/**
 * Los enunciados de poner una credencial: el baúl y su línea en el libro.
 *
 * Se devuelven en vez de ejecutarse para que los dos entren en el MISMO lote
 * —un secreto cambiado sin línea en el libro es un cambio que nadie puede
 * explicar— y para poder probar el candado del cambio simultáneo sin montar
 * dos peticiones de verdad.
 *
 * **Aquí no hay fila de `controles`, y es a propósito.** La tentación era
 * añadir una que comprobara que el baúl quedó con esta versión y este
 * criptograma. Lo escribí, y no vigila nada: el `INSERT … ON CONFLICT DO
 * UPDATE` siempre escribe —inserta o actualiza, nunca «no casa con nada»— así
 * que ese `SELECT COUNT(*)` sale 1 siempre y da por bueno lo que ya era cierto.
 * Es la cuarta vez en este proyecto que un control comprueba algo anterior al
 * lote; esta vez se quedó fuera. Lo que de verdad cierra el cambio perdido es
 * el trigger `pasarela_credencial_sube_de_version` de migrations/0010, que sí
 * mira lo que este lote escribe contra lo que había. Hay una prueba que lo
 * demuestra: con el trigger quitado, el segundo escritor pisa al primero.
 */
export function enunciadosDeCredencial(
  ctx: ContextoPasarelas,
  datos: {
    readonly pasarela: Pasarela;
    readonly modo: Modo;
    readonly credencial: string;
    readonly secretoCifrado: string;
    readonly llaveId: string;
    readonly version: number;
    readonly motivo: string;
  },
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `INSERT INTO pasarela_credenciales
           (pasarela, modo, credencial, version, secreto_cifrado, llave_id, puesta_por, puesta_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pasarela, modo, credencial) DO UPDATE SET
           version         = excluded.version,
           secreto_cifrado = excluded.secreto_cifrado,
           llave_id        = excluded.llave_id,
           puesta_por      = excluded.puesta_por,
           puesta_en       = excluded.puesta_en`,
      )
      .bind(
        datos.pasarela,
        datos.modo,
        datos.credencial,
        datos.version,
        datos.secretoCifrado,
        datos.llaveId,
        ctx.actor,
        ctx.ahora,
      ),
    // La línea del libro dice QUÉ credencial, de qué pasarela, en qué modo y en
    // qué versión quedó. El valor no está porque la tabla no tiene dónde
    // ponerlo.
    ctx.db
      .prepare(
        `INSERT INTO pasarela_bitacora
           (id, pasarela, accion, modo, credencial, version, llave_id, actor, motivo, creado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        datos.pasarela,
        datos.version === 1 ? "credencial_puesta" : "credencial_cambiada",
        datos.modo,
        datos.credencial,
        datos.version,
        datos.llaveId,
        ctx.actor,
        datos.motivo,
        ctx.ahora,
      ),
  ];
}

/**
 * Pega una credencial en su sitio: cifrada, firmada y anotada.
 *
 * No enciende nada. Configurar y encender son dos actos, y el segundo es de la
 * dueña (04-pagos §10: una pasarela entra en `pasarelas_activas` después de un
 * cobro real de prueba y su reembolso).
 */
export async function configurarCredencial(
  ctx: ContextoPasarelas,
  e: CredencialNueva,
): Promise<Resultado<CredencialGuardada>> {
  const revisado = validarCredencial(e.pasarela, e.credencial, e.valor);
  if (!revisado.ok) return revisado;
  // `validarCredencial` ya dijo que las dos cosas existen.
  const pasarela = e.pasarela as Pasarela;
  const credencial = e.credencial as string;

  if (!esModo(e.modo)) {
    return fallo(
      "entrada_invalida",
      "Hay que decir si esta credencial es la del modo de prueba o la del modo real. Son dos juegos distintos: usar una por la otra cobra de verdad en un ensayo, o deja un pedido agendado que nadie pagó.",
    );
  }
  const modo = e.modo;

  const motivo = e.motivo.trim();
  if (motivo === "") {
    return fallo(
      "entrada_invalida",
      "Escriba por qué pone esta credencial. Queda en el libro con su nombre y la fecha, y es lo que explica mañana por qué el cobro empezó a funcionar — o dejó de funcionar.",
    );
  }
  if (motivo.length > MOTIVO_MAXIMO) {
    return fallo("entrada_invalida", "El motivo es demasiado largo: resúmalo en una frase.");
  }

  if (ctx.actor.trim() === "") {
    return fallo("no_autorizado", "No se sabe quién está poniendo esta credencial.");
  }

  // Sin llave maestra NO se guarda. Ni en claro «mientras tanto», ni con un
  // cifrado de juguete: las dos cosas dejan un secreto legible en una tabla que
  // nadie vuelve a mirar.
  const llave = await abrirLlaveMaestra(ctx.llaveMaestra);
  if (!llave.ok) return llave;

  const sobre = await cifrar(
    llave.datos,
    revisado.datos,
    contextoDeCifrado(pasarela, modo, credencial),
  );
  if (!sobre.ok) return sobre;

  let anterior: { version: number } | null;
  try {
    anterior = await ctx.db
      .prepare(
        // Otra vez: `secreto_cifrado` no se lee. Para saber qué versión toca
        // basta el número.
        `SELECT version FROM pasarela_credenciales
          WHERE pasarela = ? AND modo = ? AND credencial = ?`,
      )
      .bind(pasarela, modo, credencial)
      .first<{ version: number }>();
  } catch {
    return fallo("interno", "no se pudo leer la credencial antes de cambiarla");
  }

  const version = (anterior?.version ?? 0) + 1;

  try {
    await ctx.db.batch(
      enunciadosDeCredencial(ctx, {
        pasarela,
        modo,
        credencial,
        secretoCifrado: sobre.datos,
        llaveId: llave.datos.id,
        version,
        motivo,
      }),
    );
  } catch {
    // El trigger de versión, o el UNIQUE del criptograma. En los dos casos es
    // lo mismo desde fuera: alguien más tocó esto. El mensaje no lleva nada del
    // valor.
    return fallo(
      "conflicto_version",
      "Alguien cambió esta credencial mientras usted la tenía abierta. Cierre la pantalla, vuelva a abrirla y péguela de nuevo.",
    );
  }

  return ok({ pasarela, modo, credencial, version, primera_vez: version === 1 });
}

// ---------------------------------------------------------------------------
// Quitar una credencial
// ---------------------------------------------------------------------------

/**
 * Los enunciados de quitar una credencial: el DELETE y su control, más la línea
 * del libro.
 *
 * **Este control sí hace falta.** Un `DELETE` que no casa con nada no falla:
 * borra cero filas y el lote sigue a escribir en el libro que la credencial se
 * quitó. El control mira el estado YA ESCRITO —que esa fila no está— así que si
 * el borrado no ocurrió, el `CHECK (ok = 1)` de `controles` tumba el lote y no
 * queda una línea en el libro contando algo que no pasó.
 *
 * Lo que este control NO distingue: que la haya quitado otra persona un
 * instante antes. El estado final es el mismo —no está— y es el que se quería,
 * así que se da por bueno; lo único que se pierde es de quién es la firma de
 * esa línea, y las dos líneas quedan en el libro.
 */
export function enunciadosDeQuitar(
  ctx: ContextoPasarelas,
  datos: {
    readonly pasarela: Pasarela;
    readonly modo: Modo;
    readonly credencial: string;
    readonly motivo: string;
  },
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `DELETE FROM pasarela_credenciales
          WHERE pasarela = ? AND modo = ? AND credencial = ?`,
      )
      .bind(datos.pasarela, datos.modo, datos.credencial),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) = 0 FROM pasarela_credenciales
                        WHERE pasarela = ? AND modo = ? AND credencial = ?), ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        `pasarela:credencial_quitada:${datos.pasarela}`,
        datos.pasarela,
        datos.modo,
        datos.credencial,
        ctx.ahora,
      ),
    ctx.db
      .prepare(
        `INSERT INTO pasarela_bitacora
           (id, pasarela, accion, modo, credencial, actor, motivo, creado_en)
         VALUES (?, ?, 'credencial_quitada', ?, ?, ?, ?, ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        datos.pasarela,
        datos.modo,
        datos.credencial,
        ctx.actor,
        datos.motivo,
        ctx.ahora,
      ),
  ];
}

/**
 * Quita una credencial del baúl y lo anota.
 *
 * Existe porque poder borrar un secreto es una propiedad de seguridad, no una
 * comodidad: el día que el negocio deje de usar una pasarela, su clave no se
 * queda guardada y descifrable «por si acaso».
 *
 * No se puede con la pasarela encendida, por lo mismo que no se cambia de modo
 * encendida: dejaría el checkout ofreciendo un botón que no puede cobrar.
 */
export async function quitarCredencial(
  ctx: ContextoPasarelas,
  e: {
    readonly pasarela: unknown;
    readonly modo: unknown;
    readonly credencial: unknown;
    readonly motivo: string;
  },
): Promise<Resultado<{ pasarela: Pasarela; modo: Modo; credencial: string }>> {
  if (!esPasarela(e.pasarela)) {
    return fallo("no_encontrado", `«${String(e.pasarela)}» no es una pasarela de este sistema.`);
  }
  if (!esModo(e.modo)) {
    return fallo("entrada_invalida", "Hay que decir de qué modo es la credencial que se quita.");
  }
  if (typeof e.credencial !== "string") {
    return fallo("entrada_invalida", "No se dijo qué credencial se quita.");
  }
  const motivo = e.motivo.trim();
  if (motivo === "") {
    return fallo(
      "entrada_invalida",
      "Escriba por qué la quita. Es lo que explica mañana por qué esta pasarela dejó de poder cobrar.",
    );
  }
  if (motivo.length > MOTIVO_MAXIMO) {
    return fallo("entrada_invalida", "El motivo es demasiado largo: resúmalo en una frase.");
  }
  if (ctx.actor.trim() === "") {
    return fallo("no_autorizado", "No se sabe quién está quitando esta credencial.");
  }

  const pasarela = e.pasarela;
  const modo = e.modo;
  const credencial = e.credencial;

  const encendidas = await leerEncendidas(ctx);
  if (!encendidas.ok) return encendidas;
  if (encendidas.datos.includes(pasarela)) {
    return fallo(
      "transicion_invalida",
      `${CONECTORES[pasarela].titulo} está encendida. Apáguela antes de quitarle una credencial: si no, el checkout seguiría ofreciéndola y no podría cobrar.`,
    );
  }

  const hay = await ctx.db
    .prepare(
      "SELECT version FROM pasarela_credenciales WHERE pasarela = ? AND modo = ? AND credencial = ?",
    )
    .bind(pasarela, modo, credencial)
    .first<{ version: number }>();
  if (hay === null) {
    return fallo("no_encontrado", "esa credencial no estaba puesta");
  }

  try {
    await ctx.db.batch(enunciadosDeQuitar(ctx, { pasarela, modo, credencial, motivo }));
  } catch {
    return fallo(
      "conflicto_version",
      "No se pudo quitar esa credencial: algo cambió mientras lo intentaba. Vuelva a abrir la pantalla.",
    );
  }

  return ok({ pasarela, modo, credencial });
}

// ---------------------------------------------------------------------------
// Cambiar de modo
// ---------------------------------------------------------------------------

/**
 * Los enunciados de cambiar el modo: el UPDATE condicionado, su control y la
 * línea del libro.
 *
 * **Este control sí hace falta**, al contrario que el de la credencial. El
 * `UPDATE … WHERE modo = <el viejo>` no falla cuando no casa con nada: cambia
 * cero filas y el lote sigue tranquilamente a escribir en el libro que el modo
 * cambió. El control mira la fila YA ESCRITA y mira el modo nuevo, el actor y
 * el instante que ESTE lote quería dejar puestos: una fila que ya estaba en
 * `real` porque otra persona se adelantó no se hace pasar por la nuestra.
 */
export function enunciadosDeModo(
  ctx: ContextoPasarelas,
  datos: {
    readonly pasarela: Pasarela;
    readonly de: Modo;
    readonly a: Modo;
    readonly motivo: string;
  },
): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `UPDATE pasarelas SET modo = ?, modo_cambiado_por = ?, modo_cambiado_en = ?
          WHERE pasarela = ? AND modo = ?`,
      )
      .bind(datos.a, ctx.actor, ctx.ahora, datos.pasarela, datos.de),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM pasarelas
                        WHERE pasarela = ? AND modo = ?
                          AND modo_cambiado_por = ? AND modo_cambiado_en = ?), ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        `pasarela:modo:${datos.pasarela}`,
        datos.pasarela,
        datos.a,
        ctx.actor,
        ctx.ahora,
        ctx.ahora,
      ),
    ctx.db
      .prepare(
        `INSERT INTO pasarela_bitacora
           (id, pasarela, accion, modo, actor, motivo, creado_en)
         VALUES (?, ?, 'modo_cambiado', ?, ?, ?, ?)`,
      )
      .bind(ulid(ctx.ahora), datos.pasarela, datos.a, ctx.actor, datos.motivo, ctx.ahora),
  ];
}

/**
 * Pasa una pasarela de prueba a real, o al revés.
 *
 * **No se puede con la pasarela encendida.** Es la regla que impide el fallo
 * caro de esta pieza: el modo decide qué juego de credenciales se usa, así que
 * cambiarlo con el cobro abierto cambia en silencio con qué claves se cobra —y
 * el siguiente pedido se cobra de verdad con las de prueba, o al revés. El
 * camino es apagar, cambiar, revisar y volver a encender, que son cuatro actos
 * de los que cada uno queda escrito.
 */
export async function cambiarModo(
  ctx: ContextoPasarelas,
  e: { readonly pasarela: unknown; readonly modo: unknown; readonly motivo: string },
): Promise<Resultado<{ pasarela: Pasarela; modo: Modo; cambio: boolean }>> {
  if (!esPasarela(e.pasarela)) {
    return fallo("no_encontrado", `«${String(e.pasarela)}» no es una pasarela de este sistema.`);
  }
  if (!esModo(e.modo)) {
    return fallo("entrada_invalida", "El modo solo puede ser de prueba o real.");
  }
  const motivo = e.motivo.trim();
  if (motivo === "") {
    return fallo(
      "entrada_invalida",
      "Escriba por qué cambia el modo. Pasar a real significa que el próximo cobro es dinero de verdad.",
    );
  }
  if (motivo.length > MOTIVO_MAXIMO) {
    return fallo("entrada_invalida", "El motivo es demasiado largo: resúmalo en una frase.");
  }
  if (ctx.actor.trim() === "") {
    return fallo("no_autorizado", "No se sabe quién está cambiando el modo.");
  }

  const actual = await ctx.db
    .prepare("SELECT pasarela, modo, modo_cambiado_por, modo_cambiado_en FROM pasarelas WHERE pasarela = ?")
    .bind(e.pasarela)
    .first<FilaPasarela>();
  if (actual === null) {
    return fallo("no_encontrado", "no existe la configuración de esa pasarela");
  }
  const de: Modo = esModo(actual.modo) ? actual.modo : "prueba";
  if (de === e.modo) {
    // Nada que escribir, así que nada que anotar: una línea en el libro
    // diciendo que algo pasó de real a real no explica nada y ensucia el
    // historial que sí hay que leer.
    return ok({ pasarela: e.pasarela, modo: de, cambio: false });
  }

  const encendidas = await leerEncendidas(ctx);
  if (!encendidas.ok) return encendidas;
  if (encendidas.datos.includes(e.pasarela)) {
    return fallo(
      "transicion_invalida",
      `${CONECTORES[e.pasarela].titulo} está encendida. Apáguela antes de cambiar de modo: el modo decide con qué claves se cobra, y cambiarlo con el cobro abierto es exactamente como se acaba cobrando de verdad con las credenciales de prueba.`,
    );
  }

  try {
    await ctx.db.batch(enunciadosDeModo(ctx, { pasarela: e.pasarela, de, a: e.modo, motivo }));
  } catch {
    return fallo(
      "conflicto_version",
      "Alguien cambió el modo de esta pasarela mientras usted la tenía abierta. Vuelva a abrir la pantalla para ver en cuál está.",
    );
  }

  return ok({ pasarela: e.pasarela, modo: e.modo, cambio: true });
}

// ---------------------------------------------------------------------------
// Encender y apagar
// ---------------------------------------------------------------------------

/**
 * Enciende una pasarela: la mete en `ajustes.pasarelas_activas`.
 *
 * Se escribe con `guardar` de `./ajustes` y no con un `INSERT` propio porque
 * ese ajuste ya tiene dueño, historial, validación y candado contra el cambio
 * simultáneo. Reescribirlo aquí sería tener dos formas de encender una
 * pasarela, y la que se equivoca es la que nadie revisa.
 *
 * Se niega si falta una credencial obligatoria, y lo dice por su nombre. No
 * comprueba que la pasarela funcione: eso lo dice un cobro real de prueba y su
 * reembolso, y eso lo hace una persona (04-pagos §10).
 */
export async function encender(
  ctx: ContextoPasarelas,
  e: { readonly pasarela: unknown; readonly motivo: string },
): Promise<Resultado<{ pasarela: Pasarela; encendida: true; cambio: boolean }>> {
  if (!esPasarela(e.pasarela)) {
    return fallo("no_encontrado", `«${String(e.pasarela)}» no es una pasarela de este sistema.`);
  }
  const pasarela = e.pasarela;

  const actual = await estado(ctx);
  if (!actual.ok) return actual;
  const suyo = actual.datos.pasarelas.find((p) => p.pasarela === pasarela);
  if (suyo === undefined) return fallo("no_encontrado", "no existe esa pasarela");

  if (suyo.encendida) return ok({ pasarela, encendida: true, cambio: false });

  if (!suyo.puede_encenderse) {
    return fallo("transicion_invalida", suyo.por_que_no ?? "esta pasarela no se puede encender");
  }

  const encendidas = await leerEncendidas(ctx);
  if (!encendidas.ok) return encendidas;

  const guardado = await guardar(
    { db: ctx.db, ahora: ctx.ahora, actor: ctx.actor },
    {
      clave: CLAVE_ENCENDIDAS,
      valor: [...encendidas.datos, pasarela],
      motivo: e.motivo,
    },
  );
  if (!guardado.ok) return guardado;

  return ok({ pasarela, encendida: true, cambio: true });
}

/**
 * Apaga una pasarela. Siempre se puede.
 *
 * Es el interruptor de emergencia de 04-pagos §10 («el interruptor apaga una
 * pasarela al instante desde el panel; el checkout deja de ofrecerla»), así que
 * no lleva ninguna condición: una condición aquí es un interruptor que no
 * responde el día que hace falta.
 */
export async function apagar(
  ctx: ContextoPasarelas,
  e: { readonly pasarela: unknown; readonly motivo: string },
): Promise<Resultado<{ pasarela: Pasarela; encendida: false; cambio: boolean }>> {
  if (!esPasarela(e.pasarela)) {
    return fallo("no_encontrado", `«${String(e.pasarela)}» no es una pasarela de este sistema.`);
  }
  const pasarela = e.pasarela;

  const encendidas = await leerEncendidas(ctx);
  if (!encendidas.ok) return encendidas;
  if (!encendidas.datos.includes(pasarela)) {
    return ok({ pasarela, encendida: false, cambio: false });
  }

  const guardado = await guardar(
    { db: ctx.db, ahora: ctx.ahora, actor: ctx.actor },
    {
      clave: CLAVE_ENCENDIDAS,
      valor: encendidas.datos.filter((p) => p !== pasarela),
      motivo: e.motivo,
    },
  );
  if (!guardado.ok) return guardado;

  return ok({ pasarela, encendida: false, cambio: true });
}

// ---------------------------------------------------------------------------
// Para el adaptador que habla con la pasarela, y para nadie más
// ---------------------------------------------------------------------------

/**
 * Las credenciales descifradas de una pasarela, en el modo en el que está.
 *
 * **Esto no es para una respuesta HTTP.** Es para el adaptador que va a llamar
 * a Yappy o a PayPal (F4.6–4.8), que es el único que necesita el valor.
 *
 * Tres cosas lo hacen difícil de filtrar por accidente:
 *
 *  1. devuelve un `Map`, y `JSON.stringify(new Map(…))` es `{}`: metido en una
 *     respuesta del panel, al cable sale un objeto vacío;
 *  2. lee el modo de la base y solo descifra las credenciales de ESE modo, así
 *     que no hay forma de pedir «las de prueba» mientras la pasarela está en
 *     real — y al revés, que es el caso que cuesta dinero;
 *  3. falla si falta una obligatoria, en vez de devolver media configuración
 *     con la que el adaptador haría una llamada a medias.
 */
export async function abrirCredenciales(
  ctx: ContextoDeLectura,
  pasarela: unknown,
): Promise<Resultado<{ modo: Modo; valores: Map<string, string> }>> {
  if (!esPasarela(pasarela)) {
    return fallo("no_encontrado", `«${String(pasarela)}» no es una pasarela de este sistema.`);
  }
  const conector = CONECTORES[pasarela];
  if (conector.porConfirmar !== null) {
    return fallo("pasarela_no_disponible", conector.porConfirmar);
  }

  const llave = await abrirLlaveMaestra(ctx.llaveMaestra);
  if (!llave.ok) return llave;

  const fila = await ctx.db
    .prepare("SELECT pasarela, modo, modo_cambiado_por, modo_cambiado_en FROM pasarelas WHERE pasarela = ?")
    .bind(pasarela)
    .first<FilaPasarela>();
  if (fila === null) return fallo("no_encontrado", "no existe la configuración de esa pasarela");
  const modo: Modo = esModo(fila.modo) ? fila.modo : "prueba";

  const { results } = await ctx.db
    .prepare(
      `SELECT credencial, secreto_cifrado FROM pasarela_credenciales
        WHERE pasarela = ? AND modo = ?`,
    )
    .bind(pasarela, modo)
    .all<{ credencial: string; secreto_cifrado: string }>();

  const faltan = queFalta(
    pasarela,
    results.map((r) => r.credencial),
  );
  if (faltan.length > 0) {
    return fallo(
      "pasarela_no_disponible",
      `${conector.titulo} no tiene puestas todas sus credenciales de ${modo === "prueba" ? "prueba" : "modo real"}: falta ${faltan.map((c) => `«${c.titulo}»`).join(" y ")}.`,
    );
  }

  const valores = new Map<string, string>();
  for (const r of results) {
    const claro = await descifrar(
      llave.datos,
      r.secreto_cifrado,
      contextoDeCifrado(pasarela, modo, r.credencial),
    );
    // Si una no se puede abrir, no se devuelve el resto: media configuración
    // produce una llamada a la pasarela que falla de una forma que nadie sabe
    // leer. Mejor decir qué credencial hay que volver a pegar.
    if (!claro.ok) return claro;
    valores.set(r.credencial, claro.datos);
  }

  return ok({ modo, valores });
}
