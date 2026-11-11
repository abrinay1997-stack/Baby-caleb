import { token, ulid } from "../ids";
import { fallo, ok, type Resultado } from "../contrato/resultado";
import { enunciadosDeCobro, enunciadosDeTransicion } from "./transiciones";
import { EXTENSIONES, MAXIMO_BYTES, tipoDeImagen } from "./imagenes";
import { claveDe, subir } from "./archivos";
import { type EstadoEnvio, esEstadoEnvio, validarTransicionEnvio } from "../dominio/estado-envio";
import { type Parada, ahorroDeLaRuta, proponerRuta } from "../dominio/rutas";
import { type Candidato, sugerirMotorizado } from "../dominio/asignacion";
import { type Punto, esPuntoValido } from "../dominio/geo";
import { esEstadoMotorizado, puedeRecibirEntregas } from "../dominio/motorizado";
import reglas from "../../reglas.json";
import { leerVigentes } from "./ajustes";
import {
  cobroDelSaldo,
  codigoDeCaja,
  costoDeLaEntrega,
  entregaDelPedido,
  fechaContable,
} from "../dominio/contabilidad";
import { enunciadosDeAsiento, enunciadosDeCuentaDeMotorizado } from "./contabilidad";
import type { Ventana } from "../dominio/ajustes";

/**
 * La entrega: de la bodega a la puerta (F4.5).
 *
 * El dominio ya decide lo difícil y está probado aparte: en qué orden conviene
 * ir (`dominio/rutas.ts`), a quién le toca (`dominio/asignacion.ts`), qué
 * transición es válida (`dominio/estado-envio.ts`). Aquí no se vuelve a decidir
 * nada de eso: aquí se escribe, y escribir es el problema.
 *
 * ## Las tres cosas que este archivo existe para garantizar
 *
 * **1. Marcar entregado es idempotente.** El motorizado está en la calle con
 * mala señal y va a tocar el botón dos veces. La primera capa es la fila de
 * `idempotencia` DENTRO del batch: su llave primaria es el candado, así que dos
 * peticiones con la misma clave no pueden entrar las dos — la segunda choca y
 * se cae el batch entero, cobro incluido. La segunda capa es la llave única de
 * `pagos.intento_ref`, que se deriva del ENVÍO y no de la clave: aunque el
 * teléfono genere dos claves distintas, el saldo de una entrega solo se puede
 * cobrar una vez. Y la tercera es el estado: una parada entregada no vuelve a
 * «en ruta» (trigger de la 0009).
 *
 * **2. El navegador no decide un pago.** El teléfono dice CÓMO cobró; CUÁNTO lo
 * calcula el servidor del pedido. Si el teléfono manda un monto distinto del
 * saldo, no se escribe nada y se devuelve `monto_no_coincide`. Un cobro parcial
 * en la puerta no se acepta desde el teléfono a propósito: es una decisión, y
 * las decisiones se toman desde el panel.
 *
 * **3. Lo que se apartó es lo que se devuelve.** Una parada que no se pudo
 * entregar libera exactamente las unidades que `pedido_linea_componentes` dice
 * que se apartaron, no las que diga la receta de hoy. Es el mismo criterio de
 * `crearPedido` y de `cancelar`, y existe porque la receta de un combo puede
 * haber cambiado desde la venta: liberar según la receta nueva deja la
 * diferencia bloqueada para siempre sin que nada falle.
 *
 * ## Ninguna cifra del negocio sale de aquí
 *
 * Las ventanas de entrega y lo que se le paga a un motorizado los pone la dueña
 * (`ajustes`, valores de fábrica en `reglas.json`, los dos hoy en PENDIENTE).
 * Este archivo los LEE con `ajustesDeEntrega` y, cuando faltan, lo dice: una
 * ventana inventada es una promesa que alguien va a tener que cumplir.
 */

export interface ContextoEntrega {
  readonly db: D1Database;
  readonly ahora: number;
  /** Quién lo hizo: el correo de quien despacha, o `motorizado:<id>`. */
  readonly actor: string;
}

/** Para guardar la prueba de entrega hace falta además el bucket privado. */
export interface ContextoPrueba extends ContextoEntrega {
  readonly r2: R2Bucket;
}

/** Las rutas de `idempotencia`, para que dos operaciones no compartan clave. */
const RUTA_ENTREGAR = "entregas:entregar";
const RUTA_FALLAR = "entregas:fallar";

/** 48 horas, como pide el contrato (03-contratos §5). */
const VENCE_IDEMPOTENCIA_MS = 48 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// El día de Panamá
// ---------------------------------------------------------------------------

/**
 * La fecha del negocio, 'YYYY-MM-DD'.
 *
 * No es la de UTC: con la fecha en UTC, todo lo que se entrega después de las
 * siete de la noche contaría como del día siguiente, y la ruta de hoy
 * aparecería partida en dos días.
 *
 * Es `fechaContable` del dominio y no una copia. Lo era hasta ahora —el mismo
 * cálculo escrito dos veces, con su propia constante de cinco horas— y eso
 * importa justo aquí: el día de la ruta y el mes del asiento de la entrega
 * tienen que salir del MISMO cálculo, porque si un día se separan, una entrega
 * de las siete de la noche cae en la ruta de hoy y en el mes contable de
 * mañana, y eso no lo delata ninguna prueba: cuadra por los dos lados.
 *
 * Queda una tercera copia, `fechaPanama` en `dominio/metricas.ts`, con su
 * propio `DESFASE_PANAMA_MS`. Esa sí tiene una prueba que la pega a esta
 * instante a instante (`dominio/metricas.test.ts`), así que no puede separarse
 * en silencio; unirlas es una limpieza aparte.
 */
export function fechaDePanama(ahora: number): string {
  return fechaContable(ahora);
}

// ---------------------------------------------------------------------------
// Los ajustes que necesita una entrega
// ---------------------------------------------------------------------------

/** `"PENDIENTE"` no es un valor: es que la dueña todavía no lo decidió. */
export type Pendiente = "PENDIENTE";

export interface AjustesDeEntrega {
  /** Las ventanas que la dueña ofrece («mañana», «tarde»…). */
  readonly ventanas: readonly string[] | Pendiente;
  /** Lo que se le paga a un motorizado. Este archivo no lo usa: lo enseña. */
  readonly comisiones: unknown | Pendiente;
}

const deFabrica = reglas as unknown as Record<string, unknown>;

/**
 * Los ajustes vigentes de las entregas.
 *
 * La consulta es la misma que `GET /ajustes` (src/api/panel.ts): vale la
 * versión más alta cuya vigencia ya empezó. Lo que no tiene ninguna versión cae
 * en el valor de fábrica de `reglas.json`, que para estas dos claves es
 * `PENDIENTE` — y PENDIENTE se devuelve tal cual en vez de rellenarse, para que
 * la pantalla pueda decir que falta.
 *
 * Vive aquí y no en un módulo de ajustes porque el módulo de escritura de
 * ajustes se está construyendo aparte; cuando exista, esta función se cambia
 * por la suya y nada más de este archivo se entera.
 */
export async function ajustesDeEntrega(
  db: D1Database,
  ahora: number,
): Promise<AjustesDeEntrega> {
  // Lee del módulo de ajustes, no con una consulta propia.
  //
  // Antes esta función tenía su copia de la consulta Y entendía
  // `ventanas_entrega` como una lista de textos (`["manana","tarde"]`),
  // mientras el esquema de ajustes la define como objetos con código, nombre
  // y horario. Dos lecturas del mismo dato con dos ideas distintas de qué es:
  // el resultado habría sido que la dueña decidiera sus ventanas desde el
  // panel y esta función siguiera diciendo «falta decidirlas».
  //
  // Fallaba del lado seguro —decía «falta», no un horario equivocado— pero
  // era un error igual, y de los que nadie encuentra hasta que una clienta
  // no puede agendar.
  const r = await leerVigentes({ db, ahora });
  if (!r.ok) {
    // Sin poder leer los ajustes no se inventa ninguno: todo PENDIENTE, y
    // quien llame decidirá si puede seguir sin ellos.
    return { ventanas: "PENDIENTE", comisiones: "PENDIENTE" };
  }

  const de = (clave: string) => r.datos.ajustes.find((a) => a.clave === clave);

  const ve = de("ventanas_entrega");
  /**
   * De cada ventana se guarda su CÓDIGO, no su nombre.
   *
   * `envios.ventana` lleva escrito el código (`manana`), y por eso el esquema
   * separa `id` de `etiqueta`: el día que la dueña renombre «Mañana» a «Antes
   * del mediodía», los envíos que ya dicen `manana` tienen que seguir
   * significando algo. Guardar aquí el nombre rompería esa promesa.
   */
  // `ve.pendiente` es la comprobación que dice lo que queremos decir; hoy
  // `Array.isArray` sola bastaría, porque una clave sin decidir vale el texto
  // «PENDIENTE» y eso no es una lista. Lo compruebo: quitar `ve.pendiente` no
  // tumba ninguna prueba. Se queda por legible, no porque defienda algo — y
  // lo digo aquí para que nadie cuente con ella como defensa.
  const ventanas =
    ve === undefined || ve.pendiente || !Array.isArray(ve.valor)
      ? ("PENDIENTE" as const)
      : (ve.valor as Ventana[]).map((v) => v.id);

  const co = de("comisiones");
  const comisiones = co === undefined || co.pendiente ? ("PENDIENTE" as const) : co.valor;

  return { ventanas, comisiones };
}

// ---------------------------------------------------------------------------
// Piezas que repiten casi todas las operaciones
// ---------------------------------------------------------------------------

interface FilaEnvio {
  id: string;
  pedido_id: string;
  estado: string;
  metodo: string;
  motorizado_id: string | null;
  bodega_id: string;
  ruta_id: string | null;
  cobro_cents: number;
  cobrado_cents: number;
  version: number;
}

const leerEnvio = (db: D1Database, envioId: string) =>
  db
    .prepare(
      `SELECT id, pedido_id, estado, metodo, motorizado_id, bodega_id, ruta_id,
              cobro_cents, cobrado_cents, version
         FROM envios WHERE id = ?`,
    )
    .bind(envioId)
    .first<FilaEnvio>();

interface FilaPedido {
  id: string;
  numero: string;
  estado: string;
  total_cents: number;
  // Las partes del total, que el asiento de la entrega necesita una por una:
  // la venta va a 4101 sin ITBMS, el envío a 4102 y el impuesto a su pasivo
  // (05-contabilidad §2). Con solo el total no se puede armar.
  subtotal_cents: number;
  envio_cents: number;
  descuento_cents: number;
  itbms_cents: number;
  pagado_cents: number;
  zona_id: string | null;
  direccion_id: string | null;
  version: number;
}

const leerPedido = (db: D1Database, pedidoId: string) =>
  db
    .prepare(
      `SELECT id, numero, estado, total_cents, subtotal_cents, envio_cents, descuento_cents,
              itbms_cents, pagado_cents, zona_id, direccion_id, version
         FROM pedidos WHERE id = ?`,
    )
    .bind(pedidoId)
    .first<FilaPedido>();

/**
 * El cambio de estado de una parada, con su control y su bitácora.
 *
 * Son tres enunciados que van juntos siempre, y se devuelven en vez de
 * ejecutarse para que entren en el MISMO batch que lo que provocan — el stock,
 * el cobro, la transición del pedido.
 *
 * **El control mira los valores que este batch escribió**, no solo la versión.
 * La diferencia es la que ya costó dos veces en este proyecto: si otro guardó
 * en medio, la versión que se esperaba YA es la que hay, y un control que solo
 * mire el número pasa tan contento aunque el UPDATE no haya tocado nada.
 */
function enunciadosDeParada(
  ctx: ContextoEntrega,
  envioId: string,
  de: EstadoEnvio,
  a: EstadoEnvio,
  versionLeida: number,
  extra: {
    readonly nota?: string | undefined;
    readonly punto?: Punto | undefined;
    /** Columnas que este cambio escribe además del estado. */
    readonly columnas?: { readonly sql: string; readonly valores: unknown[] } | undefined;
    /** Condición añadida al control, sobre lo que acaba de escribirse. */
    readonly controlExtra?: { readonly sql: string; readonly valores: unknown[] } | undefined;
  } = {},
): D1PreparedStatement[] {
  const columnas = extra.columnas === undefined ? "" : `, ${extra.columnas.sql}`;
  const valoresColumnas = extra.columnas?.valores ?? [];
  const controlExtra = extra.controlExtra === undefined ? "" : ` AND ${extra.controlExtra.sql}`;
  const valoresControl = extra.controlExtra?.valores ?? [];
  const punto = extra.punto !== undefined && esPuntoValido(extra.punto) ? extra.punto : null;

  return [
    ctx.db
      .prepare(
        `UPDATE envios SET estado = ?${columnas}, version = version + 1
          WHERE id = ? AND estado = ? AND version = ?`,
      )
      .bind(a, ...valoresColumnas, envioId, de, versionLeida),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, ?, (SELECT COUNT(*) FROM envios
                        WHERE id = ? AND version = ? AND estado = ?${controlExtra}), ?)`,
      )
      .bind(
        ulid(ctx.ahora),
        `envio:${de}->${a}`,
        envioId,
        versionLeida + 1,
        a,
        ...valoresControl,
        ctx.ahora,
      ),
    ctx.db
      .prepare(
        `INSERT INTO envio_eventos (id,envio_id,de,a,actor,nota,lat,lng,creado_en)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        ulid(ctx.ahora),
        envioId,
        de,
        a,
        ctx.actor,
        extra.nota ?? null,
        punto?.lat ?? null,
        punto?.lng ?? null,
        ctx.ahora,
      ),
  ];
}

/** Lo mismo pedido dos veces se contesta una vez. */
async function yaHecha<T>(
  db: D1Database,
  clave: string,
  ruta: string,
  huella: string,
  ahora: number,
): Promise<{ respuesta: T } | { repetida: true } | null> {
  const fila = await db
    .prepare("SELECT ruta, huella_entrada, respuesta_json FROM idempotencia WHERE clave = ? AND vence_en > ?")
    .bind(clave, ahora)
    .first<{ ruta: string; huella_entrada: string; respuesta_json: string | null }>();

  if (fila === null) return null;
  // Misma clave con otra entrada es `repetido` y no la respuesta de antes
  // (03-contratos §5): contestar lo de la otra entrada sería contestar a una
  // pregunta que nadie hizo.
  if (fila.ruta !== ruta || fila.huella_entrada !== huella) return { repetida: true };
  if (fila.respuesta_json === null) return { repetida: true };
  try {
    return { respuesta: JSON.parse(fila.respuesta_json) as T };
  } catch {
    return { repetida: true };
  }
}

/**
 * La huella de la entrada. No se guarda la entrada entera: lleva la ubicación
 * del teléfono y la clave de una foto, y la huella basta para saber si la
 * segunda petición pregunta lo mismo que la primera.
 */
function huellaDe(partes: readonly (string | number | null | undefined)[]): string {
  return partes.map((p) => (p === undefined || p === null ? "" : String(p))).join("|");
}

/**
 * La fila de `idempotencia`, DENTRO del batch y con un INSERT a secas.
 *
 * Es el candado. No es `INSERT OR REPLACE`: la llave primaria tiene que chocar
 * para que la segunda petición tumbe el batch entero en vez de volver a cobrar.
 */
function enunciadoDeIdempotencia(
  ctx: ContextoEntrega,
  clave: string,
  ruta: string,
  huella: string,
  respuesta: unknown,
): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO idempotencia (clave, ruta, huella_entrada, respuesta_json, creado_en, vence_en)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(
      clave,
      ruta,
      huella,
      JSON.stringify(respuesta),
      ctx.ahora,
      ctx.ahora + VENCE_IDEMPOTENCIA_MS,
    );
}

// ---------------------------------------------------------------------------
// 1. El envío de un pedido agendado
// ---------------------------------------------------------------------------

export interface EnvioNuevo {
  readonly pedidoId: string;
  /** 'YYYY-MM-DD' en hora de Panamá. Si falta, el día de `ctx.ahora`. */
  readonly programadoPara?: string;
  /** Tiene que ser una de las de `ajustes.ventanas_entrega`. */
  readonly ventana?: string;
}

export interface EnvioCreado {
  readonly envioId: string;
  readonly guiaToken: string;
  readonly bodegaId: string;
  readonly metodo: string;
  readonly cobroCents: number;
}

/**
 * Prepara la entrega de un pedido ya agendado.
 *
 * Un pedido se agenda cuando alcanza su abono mínimo (`transiciones.agendar`);
 * recién entonces tiene sentido una guía y un sitio en la lista del día. Antes
 * de eso no: una parada de un pedido que todavía no pagó es una caja que sale
 * de la bodega contra una promesa.
 *
 * NO vuelve a apartar stock: lo apartó `crearPedido`. Lo único que hace es
 * decir dónde está apartado y cuánto queda por cobrar.
 */
export async function crearEnvio(
  ctx: ContextoEntrega,
  e: EnvioNuevo,
): Promise<Resultado<EnvioCreado>> {
  const p = await leerPedido(ctx.db, e.pedidoId);
  if (p === null) return fallo("no_encontrado", "no existe ese pedido");
  if (p.estado !== "agendado") {
    return fallo(
      "transicion_invalida",
      `un pedido ${p.estado} no se despacha: la entrega se prepara cuando está agendado`,
    );
  }

  // La ventana la ofrece la dueña, no este código. Mientras `ventanas_entrega`
  // esté en PENDIENTE no hay ninguna que ofrecer, y aceptar una sería
  // inventarle un horario al negocio.
  if (e.ventana !== undefined) {
    const ajustes = await ajustesDeEntrega(ctx.db, ctx.ahora);
    if (ajustes.ventanas === "PENDIENTE") {
      return fallo(
        "entrada_invalida",
        "las ventanas de entrega todavía no están decididas: la dueña las pone en los ajustes",
      );
    }
    if (!ajustes.ventanas.includes(e.ventana)) {
      return fallo("entrada_invalida", `«${e.ventana}» no es una de las ventanas de entrega`);
    }
  }

  /**
   * De dónde sale la mercancía: de donde está APARTADA.
   *
   * No de la bodega preferida de la zona ni de la que más tenga: de la que ya
   * tiene las unidades de este pedido comprometidas. Mandar al motorizado a
   * otra bodega es mandarlo a buscar algo que no está ahí.
   *
   * Si el pedido quedó apartado en dos bodegas, nadie puede armarlo en un solo
   * viaje y el sistema no debe fingir que sí.
   */
  const { results: bodegas } = await ctx.db
    .prepare(
      `SELECT DISTINCT plc.bodega_id
         FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id
        WHERE pl.pedido_id = ?`,
    )
    .bind(e.pedidoId)
    .all<{ bodega_id: string }>();

  if (bodegas.length === 0) {
    return fallo("entrada_invalida", "ese pedido no tiene nada apartado: no hay qué entregar");
  }
  if (bodegas.length > 1) {
    return fallo(
      "transicion_invalida",
      "este pedido está apartado en más de una bodega: hay que resolverlo a mano antes de despacharlo",
    );
  }
  const bodegaId = bodegas[0]!.bodega_id;

  // El método sale de la zona: Ferguson no lo lleva un motorizado nuestro, y
  // eso cambia quién puede marcarlo entregado.
  let metodo = "otro";
  if (p.zona_id !== null) {
    const z = await ctx.db
      .prepare("SELECT metodo FROM zonas_envio WHERE id = ?")
      .bind(p.zona_id)
      .first<{ metodo: string }>();
    metodo = z?.metodo ?? "otro";
  }

  const envioId = ulid(ctx.ahora);
  const guia = token();
  const cobroCents = Math.max(p.total_cents - p.pagado_cents, 0);
  const programadoPara = e.programadoPara ?? fechaDePanama(ctx.ahora);

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO envios (id,pedido_id,estado,metodo,bodega_id,guia_token,
             programado_para,ventana,cobro_cents,creado_en)
           VALUES (?,?,'pendiente',?,?,?,?,?,?,?)`,
        )
        .bind(
          envioId, e.pedidoId, metodo, bodegaId, guia,
          programadoPara, e.ventana ?? null, cobroCents, ctx.ahora,
        ),
      ctx.db
        .prepare(
          `INSERT INTO envio_eventos (id,envio_id,de,a,actor,nota,creado_en)
           VALUES (?,?,NULL,'pendiente',?,?,?)`,
        )
        .bind(ulid(ctx.ahora), envioId, ctx.actor, `saldo por cobrar: ${cobroCents}`, ctx.ahora),
    ]);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    // La llave única parcial `envios_uno_vivo_por_pedido`: este pedido ya tiene
    // una entrega viva. No es un error del que llama, es que ya estaba hecho.
    return /UNIQUE|constraint/i.test(texto)
      ? fallo("repetido", "ese pedido ya tiene una entrega en curso")
      : fallo("interno", texto);
  }

  return ok({ envioId, guiaToken: guia, bodegaId, metodo, cobroCents });
}

// ---------------------------------------------------------------------------
// 2. A quién le toca
// ---------------------------------------------------------------------------

/**
 * Los candidatos para una parada, ordenados, con el motivo de cada uno.
 *
 * No asigna: `dominio/asignacion.ts` explica por qué —quien despacha sabe cosas
 * que esto no—. Aquí solo se juntan los datos que la función pura necesita: la
 * zona de la parada, su punto, y qué lleva encima hoy cada motorizado.
 *
 * Los inactivos no salen. El dominio devuelve a los saturados con su motivo
 * porque saber por qué no se propone a alguien vale tanto como la propuesta,
 * pero quien ya no trabaja aquí no es un candidato con un motivo: no es un
 * candidato.
 */
export async function sugerirParaEnvio(
  db: D1Database,
  envioId: string,
): Promise<Resultado<{ candidatos: Candidato[] }>> {
  const envio = await leerEnvio(db, envioId);
  if (envio === null) return fallo("no_encontrado", "no existe esa entrega");

  const destino = await db
    .prepare(
      `SELECT p.zona_id, d.lat, d.lng
         FROM pedidos p LEFT JOIN direcciones d ON d.id = p.direccion_id
        WHERE p.id = ?`,
    )
    .bind(envio.pedido_id)
    .first<{ zona_id: string | null; lat: number | null; lng: number | null }>();

  const { results } = await db
    .prepare(
      `SELECT m.id, m.nombre, m.estado,
              e.id AS envio_id, p.zona_id AS zona_id, d.lat AS lat, d.lng AS lng
         FROM motorizados m
         LEFT JOIN envios e
                ON e.motorizado_id = m.id
               AND e.estado IN ('asignado','recogido','en_ruta')
         LEFT JOIN pedidos p ON p.id = e.pedido_id
         LEFT JOIN direcciones d ON d.id = p.direccion_id
        WHERE m.estado <> 'inactivo'
        ORDER BY m.nombre`,
    )
    .all<{
      id: string;
      nombre: string;
      estado: string;
      envio_id: string | null;
      zona_id: string | null;
      lat: number | null;
      lng: number | null;
    }>();

  const porMotorizado = new Map<
    string,
    { id: string; nombre: string; estado: string; entregas: { zona_id: string; punto: Punto | null }[] }
  >();

  for (const f of results) {
    const ya = porMotorizado.get(f.id) ?? {
      id: f.id,
      nombre: f.nombre,
      estado: f.estado,
      entregas: [],
    };
    if (f.envio_id !== null) {
      ya.entregas.push({
        // Un pedido sin zona no tiene afinidad con nada, y una cadena vacía no
        // casa con ninguna zona de verdad. Es lo honesto: no hay señal.
        zona_id: f.zona_id ?? "",
        punto: f.lat !== null && f.lng !== null ? { lat: f.lat, lng: f.lng } : null,
      });
    }
    porMotorizado.set(f.id, ya);
  }

  const disponibles = [...porMotorizado.values()].map((m) => ({
    id: m.id,
    nombre: m.nombre,
    // El CHECK de la tabla ya limita la columna a los tres estados; esto es la
    // frontera entre el texto de la base y el tipo del dominio.
    estado: esEstadoMotorizado(m.estado) ? m.estado : ("inactivo" as const),
    entregas: m.entregas,
  }));

  return ok({
    candidatos: sugerirMotorizado(
      {
        zona_id: destino?.zona_id ?? "",
        destino:
          destino?.lat != null && destino.lng != null
            ? { lat: destino.lat, lng: destino.lng }
            : null,
      },
      disponibles,
    ),
  });
}

// ---------------------------------------------------------------------------
// 3. La ruta del día
// ---------------------------------------------------------------------------

export interface RutaNueva {
  /** 'YYYY-MM-DD' en hora de Panamá. Si falta, el día de `ctx.ahora`. */
  readonly fecha?: string;
  readonly motorizadoId: string;
  /** De dónde carga. Todas las paradas tienen que estar apartadas ahí. */
  readonly bodegaId: string;
  readonly envioIds: readonly string[];
  /**
   * De dónde sale, para medir el orden. Si falta, las paradas se quedan en el
   * orden en que llegaron y no se propone nada: medir desde un punto inventado
   * da un orden que parece pensado y no lo está.
   */
  readonly origen?: Punto;
}

export interface RutaArmada {
  readonly rutaId: string;
  readonly paradas: { readonly envioId: string; readonly orden: number }[];
  /** Las que no tienen punto en el mapa: van al final y hay que llamar. */
  readonly sinUbicar: string[];
  readonly kmPropuestos: number | null;
  readonly ahorroKm: number | null;
}

/**
 * Arma la tanda del día: una ruta, un motorizado, sus paradas en orden.
 *
 * El orden lo propone `proponerRuta`, que mide en línea recta y lo dice de sí
 * mismo. Por eso se guarda también el origen y los kilómetros: quien reparte va
 * a cambiar el orden cuando conozca el barrio mejor —y suele conocerlo— y
 * entonces hace falta poder comparar.
 */
export async function armarRuta(
  ctx: ContextoEntrega,
  e: RutaNueva,
): Promise<Resultado<RutaArmada>> {
  if (e.envioIds.length === 0) {
    return fallo("entrada_invalida", "una ruta sin paradas es un paseo");
  }
  if (new Set(e.envioIds).size !== e.envioIds.length) {
    return fallo("entrada_invalida", "hay una parada repetida en la lista");
  }

  const m = await ctx.db
    .prepare("SELECT id, nombre, estado FROM motorizados WHERE id = ?")
    .bind(e.motorizadoId)
    .first<{ id: string; nombre: string; estado: string }>();
  if (m === null) return fallo("no_encontrado", "no existe ese motorizado");
  if (!esEstadoMotorizado(m.estado) || !puedeRecibirEntregas(m.estado)) {
    return fallo(
      "transicion_invalida",
      `${m.nombre} no está activo: no recibe entregas nuevas`,
    );
  }

  const b = await ctx.db
    .prepare("SELECT id FROM bodegas WHERE id = ? AND activa = 1")
    .bind(e.bodegaId)
    .first<{ id: string }>();
  if (b === null) return fallo("no_encontrado", "no existe esa bodega, o está cerrada");

  const fecha = e.fecha ?? fechaDePanama(ctx.ahora);

  // Un motorizado tiene UNA ruta por día. Se pregunta antes para poder decirlo
  // con palabras; lo que de verdad lo impide es la llave única
  // `rutas_una_por_dia`, que es la que cierra la carrera entre dos personas
  // armando rutas a la vez — y esa sube como conflicto, no como repetido.
  const yaTiene = await ctx.db
    .prepare("SELECT id FROM rutas WHERE motorizado_id = ? AND fecha = ? AND estado <> 'cancelada'")
    .bind(e.motorizadoId, fecha)
    .first<{ id: string }>();
  if (yaTiene !== null) {
    return fallo("repetido", `${m.nombre} ya tiene una ruta para el ${fecha}`);
  }

  // Las paradas, con su punto. Se leen todas antes de escribir nada para que un
  // error diga exactamente cuál falló y no deje media ruta hecha.
  const marcas = e.envioIds.map(() => "?").join(",");
  const { results: paradas } = await ctx.db
    .prepare(
      `SELECT v.id, v.estado, v.metodo, v.bodega_id, v.ruta_id, v.version,
              d.lat AS lat, d.lng AS lng
         FROM envios v
         JOIN pedidos p ON p.id = v.pedido_id
         LEFT JOIN direcciones d ON d.id = p.direccion_id
        WHERE v.id IN (${marcas})`,
    )
    .bind(...e.envioIds)
    .all<{
      id: string;
      estado: string;
      metodo: string;
      bodega_id: string;
      ruta_id: string | null;
      version: number;
      lat: number | null;
      lng: number | null;
    }>();

  if (paradas.length !== e.envioIds.length) {
    return fallo("no_encontrado", "alguna de esas entregas no existe");
  }
  for (const p of paradas) {
    if (p.ruta_id !== null) {
      return fallo("repetido", `la entrega ${p.id} ya está en otra ruta`);
    }
    if (p.estado !== "pendiente") {
      return fallo("transicion_invalida", `la entrega ${p.id} está ${p.estado}, no pendiente`);
    }
    if (p.metodo !== "motorizado") {
      return fallo(
        "transicion_invalida",
        `la entrega ${p.id} va por ${p.metodo}: no entra en la ruta de un motorizado`,
      );
    }
    if (p.bodega_id !== e.bodegaId) {
      return fallo(
        "transicion_invalida",
        `la entrega ${p.id} está apartada en otra bodega: el motorizado no la encontraría aquí`,
      );
    }
  }

  // El orden. Sin origen no se propone: se respeta el que llegó.
  const puntos: Parada[] = paradas.map((p) => ({
    id: p.id,
    punto: p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng } : null,
  }));

  let orden: string[];
  let sinUbicar: string[];
  let kmPropuestos: number | null = null;
  let ahorroKm: number | null = null;

  if (e.origen !== undefined && esPuntoValido(e.origen)) {
    const propuesta = proponerRuta(e.origen, puntos);
    // Las que no tienen punto NO se intercalan: van al final, porque no son un
    // problema de orden sino de datos — hay que llamar por teléfono, y eso se
    // planifica distinto.
    orden = [...propuesta.orden.map((p) => p.id), ...propuesta.sinUbicar.map((p) => p.id)];
    sinUbicar = propuesta.sinUbicar.map((p) => p.id);
    kmPropuestos = propuesta.distanciaKm;
    ahorroKm = ahorroDeLaRuta(propuesta).km;
  } else {
    orden = puntos.map((p) => p.id);
    sinUbicar = puntos.filter((p) => p.punto === null).map((p) => p.id);
  }

  const versiones = new Map(paradas.map((p) => [p.id, p.version]));
  const rutaId = ulid(ctx.ahora);
  const origen = e.origen !== undefined && esPuntoValido(e.origen) ? e.origen : null;

  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO rutas (id,fecha,motorizado_id,bodega_id,estado,
           origen_lat,origen_lng,km_propuestos,creada_por,creada_en)
         VALUES (?,?,?,?,'borrador',?,?,?,?,?)`,
      )
      .bind(
        rutaId, fecha, e.motorizadoId, e.bodegaId,
        origen?.lat ?? null, origen?.lng ?? null, kmPropuestos, ctx.actor, ctx.ahora,
      ),
  ];

  orden.forEach((envioId, i) => {
    const numero = i + 1;
    enunciados.push(
      ...enunciadosDeParada(ctx, envioId, "pendiente", "asignado", versiones.get(envioId)!, {
        nota: `ruta ${fecha}, parada ${numero}`,
        columnas: {
          sql: "ruta_id = ?, orden_ruta = ?, motorizado_id = ?, programado_para = ?",
          valores: [rutaId, numero, e.motorizadoId, fecha],
        },
        // El control mira la ruta y el orden que ESTE batch escribió. Y la ruta
        // es un ULID recién hecho que nadie más puede haber escrito, así que no
        // hay forma de que otro batch satisfaga esta condición por casualidad.
        controlExtra: { sql: "ruta_id = ? AND orden_ruta = ?", valores: [rutaId, numero] },
      }),
    );
  });

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    return /CHECK|controles|UNIQUE/i.test(texto)
      ? fallo("conflicto_version", "alguna parada cambió mientras se armaba la ruta; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok({
    rutaId,
    paradas: orden.map((envioId, i) => ({ envioId, orden: i + 1 })),
    sinUbicar,
    kmPropuestos,
    ahorroKm,
  });
}

/**
 * Deshace una ruta que todavía no salió.
 *
 * Hace falta porque un motorizado tiene UNA ruta por día: una armada por
 * error, sin poder deshacerla, le bloquea el día entero. Las paradas vuelven a
 * `pendiente` y quedan libres para otra ruta; la ruta se marca `cancelada` y no
 * se borra, porque alguien la armó y eso pasó.
 */
export async function cancelarRuta(
  ctx: ContextoEntrega,
  rutaId: string,
  motivo: string,
): Promise<Resultado<{ cancelada: true; paradas: number }>> {
  if (motivo.trim() === "") {
    return fallo("entrada_invalida", "una ruta no se cancela sin motivo");
  }

  const r = await ctx.db
    .prepare("SELECT id, estado, version FROM rutas WHERE id = ?")
    .bind(rutaId)
    .first<{ id: string; estado: string; version: number }>();
  if (r === null) return fallo("no_encontrado", "no existe esa ruta");
  if (r.estado !== "borrador") {
    return fallo(
      "transicion_invalida",
      `esta ruta está ${r.estado}: solo se cancela una que todavía no salió`,
    );
  }

  const { results: paradas } = await ctx.db
    .prepare("SELECT id, estado, version FROM envios WHERE ruta_id = ?")
    .bind(rutaId)
    .all<{ id: string; estado: string; version: number }>();

  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `UPDATE rutas SET estado = 'cancelada', version = version + 1
          WHERE id = ? AND estado = 'borrador' AND version = ?`,
      )
      .bind(rutaId, r.version),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, 'ruta:cancelada', (SELECT COUNT(*) FROM rutas
                 WHERE id = ? AND version = ? AND estado = 'cancelada'), ?)`,
      )
      .bind(ulid(ctx.ahora), rutaId, r.version + 1, ctx.ahora),
  ];

  for (const p of paradas) {
    if (p.estado !== "asignado") {
      return fallo("transicion_invalida", `la parada ${p.id} está ${p.estado}: no se puede soltar`);
    }
    enunciados.push(
      ...enunciadosDeParada(ctx, p.id, "asignado", "pendiente", p.version, {
        nota: `ruta cancelada: ${motivo}`,
        // Las tres juntas: una parada `pendiente` con ruta sería invisible en
        // la lista de pendientes, y con motorizado sería una mentira sobre
        // quién la lleva.
        columnas: {
          sql: "ruta_id = NULL, orden_ruta = NULL, motorizado_id = NULL",
          valores: [],
        },
        controlExtra: { sql: "ruta_id IS NULL AND motorizado_id IS NULL", valores: [] },
      }),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    return /CHECK|controles|ABORT|abort/i.test(texto)
      ? fallo("conflicto_version", "la ruta cambió mientras se cancelaba; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok({ cancelada: true as const, paradas: paradas.length });
}

// ---------------------------------------------------------------------------
// 4. La ruta sale de la bodega
// ---------------------------------------------------------------------------

/**
 * La ruta sale: la mercancía deja la bodega y los pedidos van en camino.
 *
 * Un botón, dos hechos. `recogido` («ya cargué») y `en_ruta` («voy en camino»)
 * pasan los dos, con un minuto de diferencia, y los dos quedan escritos con su
 * hora: la máquina de estados del dominio no permite saltarse `recogido`, y
 * saltárselo igual sería escribir en la bitácora algo que no pasó. Si algún día
 * la bodega quiere confirmar la carga aparte, esto se parte en dos funciones y
 * la bitácora no cambia de forma.
 *
 * Los pedidos pasan a `en_ruta` en el MISMO batch. Si fueran dos escrituras,
 * entre una y otra la clienta vería «agendado» mientras su caja ya va en una
 * moto.
 */
export async function despacharRuta(
  ctx: ContextoEntrega,
  rutaId: string,
): Promise<Resultado<{ paradas: number; pedidos: number }>> {
  const r = await ctx.db
    .prepare("SELECT id, estado, fecha, version FROM rutas WHERE id = ?")
    .bind(rutaId)
    .first<{ id: string; estado: string; fecha: string; version: number }>();
  if (r === null) return fallo("no_encontrado", "no existe esa ruta");
  if (r.estado !== "borrador") {
    return fallo("transicion_invalida", `esta ruta ya está ${r.estado}`);
  }

  const { results: paradas } = await ctx.db
    .prepare(
      `SELECT v.id, v.estado, v.version, v.pedido_id,
              p.estado AS pedido_estado, p.numero AS numero
         FROM envios v JOIN pedidos p ON p.id = v.pedido_id
        WHERE v.ruta_id = ? ORDER BY v.orden_ruta`,
    )
    .bind(rutaId)
    .all<{
      id: string;
      estado: string;
      version: number;
      pedido_id: string;
      pedido_estado: string;
      numero: string;
    }>();

  if (paradas.length === 0) return fallo("transicion_invalida", "esta ruta no tiene paradas");

  for (const p of paradas) {
    if (p.estado !== "asignado") {
      return fallo("transicion_invalida", `la parada ${p.id} está ${p.estado}, no asignada`);
    }
    if (p.pedido_estado !== "agendado") {
      return fallo(
        "transicion_invalida",
        `el pedido ${p.numero} está ${p.pedido_estado}: no puede salir a la calle`,
      );
    }
  }

  // La ruta primero: el trigger `envio_no_se_mueve_sin_salir_la_ruta` no deja
  // mover una parada de una ruta en borrador, así que el orden dentro del batch
  // no es estético. Y el trigger es lo que impide marcar entregada una parada
  // que nunca salió.
  const enunciados: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `UPDATE rutas SET estado = 'en_curso', salio_en = ?, version = version + 1
          WHERE id = ? AND estado = 'borrador' AND version = ?`,
      )
      .bind(ctx.ahora, rutaId, r.version),
    ctx.db
      .prepare(
        `INSERT INTO controles (id, regla, ok, creado_en)
         VALUES (?, 'ruta:en_curso', (SELECT COUNT(*) FROM rutas
                 WHERE id = ? AND version = ? AND estado = 'en_curso' AND salio_en = ?), ?)`,
      )
      .bind(ulid(ctx.ahora), rutaId, r.version + 1, ctx.ahora, ctx.ahora),
  ];

  // Las dos transiciones que hace este paso, preguntadas al dominio una vez: si
  // algún día la tabla de `estado-envio.ts` deja de permitirlas, esto se cae
  // aquí y no escribiendo una bitácora imposible.
  const mal =
    validarTransicionEnvio("asignado", "recogido") ?? validarTransicionEnvio("recogido", "en_ruta");
  if (mal !== null) return fallo("transicion_invalida", mal.mensaje);

  for (const p of paradas) {
    enunciados.push(
      ...enunciadosDeParada(ctx, p.id, "asignado", "recogido", p.version, {
        nota: "cargado en la bodega",
      }),
      // La segunda transición parte de la versión que dejó la primera.
      ...enunciadosDeParada(ctx, p.id, "recogido", "en_ruta", p.version + 1, {
        nota: `salió con la ruta del ${r.fecha}`,
      }),
      ...enunciadosDeTransicion(ctx, p.pedido_id, "agendado", "en_ruta", { rutaId }),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    return /CHECK|controles|ABORT|abort/i.test(texto)
      ? fallo("conflicto_version", "algo cambió mientras la ruta salía; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok({ paradas: paradas.length, pedidos: paradas.length });
}

// ---------------------------------------------------------------------------
// 5. La prueba de entrega
// ---------------------------------------------------------------------------

/**
 * Guarda la foto de la entrega en el R2 privado.
 *
 * **Es un dato personal**, no una foto de producto: sale la puerta de una
 * clienta y a veces ella misma. Entra con `sensible` en su valor por defecto,
 * que es 1, y eso es lo que impide que `leerPublico` la sirva sin sesión.
 *
 * El tipo sale de los BYTES y no de la cabecera `Content-Type`: esa la escribe
 * quien sube el archivo, y guardarla tal cual permitiría colar un HTML con cara
 * de foto.
 *
 * El ciclo de vida del archivo ya está resuelto en `db/archivos.ts` y no se
 * vuelve a escribir aquí: la fila entra marcada, después se sube, y solo
 * entonces se desmarca, de modo que una subida a medias la limpia el barrido.
 */
export async function guardarPrueba(
  ctx: ContextoPrueba,
  envioId: string,
  cuerpo: ArrayBuffer,
): Promise<Resultado<{ r2Key: string; mime: string }>> {
  const envio = await leerEnvio(ctx.db, envioId);
  if (envio === null) return fallo("no_encontrado", "no existe esa entrega");
  if (envio.estado === "entregado" || envio.estado === "devuelto" || envio.estado === "anulado") {
    return fallo("transicion_invalida", `esta entrega ya está ${envio.estado}`);
  }

  if (cuerpo.byteLength > MAXIMO_BYTES) {
    return fallo(
      "limite",
      `La foto pesa ${Math.round(cuerpo.byteLength / 1024 / 1024)} MB y el tope son 5 MB.`,
    );
  }

  const tipo = tipoDeImagen(cuerpo);
  if (tipo === null) {
    return fallo("entrada_invalida", "Ese archivo no es una foto (se aceptan JPG, PNG, WebP y AVIF).");
  }

  const clave = claveDe("entregas", envioId, EXTENSIONES[tipo], ctx.ahora);
  const r = await subir(ctx, clave, cuerpo, {
    tipo: "entregas",
    mime: tipo,
    bytes: cuerpo.byteLength,
    // `sensible` se deja en su valor por defecto (1) a propósito: no se escribe
    // `sensible: false` ni por costumbre.
    referenciaTipo: "envio",
    referenciaId: envioId,
  });
  if (!r.ok) return r;

  return ok({ r2Key: r.datos.r2Key, mime: tipo });
}

// ---------------------------------------------------------------------------
// 6. El motorizado marca la parada
// ---------------------------------------------------------------------------

export const METODOS_DE_COBRO = ["efectivo", "yappy", "otro"] as const;
export type MetodoDeCobro = (typeof METODOS_DE_COBRO)[number];
export const esMetodoDeCobro = (v: string): v is MetodoDeCobro =>
  (METODOS_DE_COBRO as readonly string[]).includes(v);

export interface EntregaMarcada {
  /** La clave del intento. Sin ella no se marca nada: es el candado. */
  readonly idempotencia: string;
  readonly envioId: string;
  /** Si lo marca el motorizado, su id. El servidor comprueba que sea el suyo. */
  readonly motorizadoId?: string;
  /** Cómo cobró el saldo. Si falta, no cobró nada. */
  readonly metodoCobro?: MetodoDeCobro;
  /**
   * Lo que dice haber cobrado. NO decide: se compara con el saldo que calcula
   * el servidor, y si no coincide no se escribe nada.
   */
  readonly montoCents?: number;
  /** La clave en R2 de la prueba, ya subida con `guardarPrueba`. */
  readonly pruebaR2?: string;
  /** Dónde estaba el teléfono al marcar. */
  readonly punto?: Punto;
  readonly nota?: string;
}

export interface EntregaHecha {
  readonly envioId: string;
  readonly cobradoCents: number;
  readonly entregadoEn: number;
  readonly pedidoEntregado: boolean;
  /**
   * `true` cuando no se sabe lo que costó la mercancía que salió: no hay
   * promedio cargado todavía. Se dice en vez de poner un cero, porque un cero
   * afirma que no costó nada.
   */
  readonly costoDesconocido: boolean;
  /** `true` si ya estaba marcada: el segundo toque del mismo botón. */
  readonly yaEstaba: boolean;
}

/**
 * Llegó.
 *
 * Es la operación más delicada del archivo porque hace cinco cosas que tienen
 * que pasar juntas o no pasar: la parada se cierra, el stock sale de verdad, se
 * fija el costo de lo vendido, entra el cobro del saldo y el pedido pasa a
 * entregado. Todo en un batch. Si fueran escrituras sueltas, cualquier corte
 * dejaría mercancía fuera del inventario sin venta que la explique, o una venta
 * sin mercancía.
 */
export async function marcarEntregada(
  ctx: ContextoEntrega,
  e: EntregaMarcada,
): Promise<Resultado<EntregaHecha>> {
  if (e.idempotencia.trim() === "") {
    return fallo("entrada_invalida", "falta la clave del intento");
  }
  if (e.metodoCobro !== undefined && !esMetodoDeCobro(e.metodoCobro)) {
    return fallo("entrada_invalida", `«${e.metodoCobro}» no es una forma de cobro`);
  }

  const huella = huellaDe([e.envioId, e.metodoCobro, e.montoCents, e.pruebaR2]);
  const antes = await yaHecha<EntregaHecha>(
    ctx.db,
    e.idempotencia,
    RUTA_ENTREGAR,
    huella,
    ctx.ahora,
  );
  if (antes !== null) {
    return "respuesta" in antes
      ? ok({ ...antes.respuesta, yaEstaba: true })
      : fallo("repetido", "esa clave ya se usó para otra cosa");
  }

  const envio = await leerEnvio(ctx.db, e.envioId);
  if (envio === null) return fallo("no_encontrado", "no existe esa entrega");
  if (!esEstadoEnvio(envio.estado)) return fallo("interno", "esa entrega tiene un estado raro");

  const mal = validarTransicionEnvio(envio.estado, "entregado");
  if (mal !== null) return fallo("transicion_invalida", mal.mensaje);

  // Un motorizado solo cierra lo suyo. No es cortesía: su teléfono conoce los
  // ids de sus paradas y nada más debería poder cerrar las de otro.
  if (e.motorizadoId !== undefined && envio.motorizado_id !== e.motorizadoId) {
    return fallo("no_autorizado", "esta entrega no está asignada a usted");
  }

  const p = await leerPedido(ctx.db, envio.pedido_id);
  if (p === null) return fallo("no_encontrado", "no existe el pedido de esa entrega");
  if (p.estado !== "en_ruta") {
    return fallo("transicion_invalida", `el pedido ${p.numero} está ${p.estado}, no en ruta`);
  }

  // ── El cobro. El monto lo pone el servidor ───────────────────────────────
  const saldo = Math.max(p.total_cents - p.pagado_cents, 0);
  let cobrado = 0;

  if (e.metodoCobro === undefined) {
    // Entregar sin cobrar es posible —la dueña decide qué hacer con el saldo—
    // pero un monto sin decir cómo entró no se escribe.
    if (e.montoCents !== undefined && e.montoCents > 0) {
      return fallo("entrada_invalida", "diga cómo cobró: efectivo, yappy u otro");
    }
  } else {
    if (saldo === 0) {
      return fallo("monto_no_coincide", `el pedido ${p.numero} no tiene saldo por cobrar`);
    }
    if (e.montoCents !== undefined && e.montoCents !== saldo) {
      // Un cobro parcial en la puerta es una decisión, y las decisiones no se
      // toman desde un teléfono: el servidor sabe cuánto se debe y no acepta
      // otro número.
      return fallo(
        "monto_no_coincide",
        `el saldo de ${p.numero} es ${saldo} centavos y no se puede cobrar otra cantidad`,
      );
    }
    cobrado = saldo;
  }

  // ── La prueba ────────────────────────────────────────────────────────────
  if (e.pruebaR2 !== undefined) {
    const archivo = await ctx.db
      .prepare(
        `SELECT r2_key FROM archivos
          WHERE r2_key = ? AND referencia_tipo = 'envio' AND referencia_id = ?
            AND borrar_despues_de IS NULL`,
      )
      .bind(e.pruebaR2, e.envioId)
      .first<{ r2_key: string }>();
    if (archivo === null) {
      // La llave foránea ya impediría apuntar a un archivo que no existe; esto
      // además impide colgar de una entrega la foto de OTRA.
      return fallo("entrada_invalida", "esa foto no es la prueba de esta entrega");
    }
  }

  // ── Lo que sale del inventario: LO QUE SE APARTÓ ─────────────────────────
  const { results: componentes } = await ctx.db
    .prepare(
      `SELECT plc.linea_id, plc.codigo, plc.cantidad, plc.bodega_id,
              pl.cantidad AS linea_cantidad
         FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id
        WHERE pl.pedido_id = ?`,
    )
    .bind(envio.pedido_id)
    .all<{
      linea_id: string;
      codigo: string;
      cantidad: number;
      bodega_id: string;
      linea_cantidad: number;
    }>();

  if (componentes.length === 0) {
    return fallo("entrada_invalida", "ese pedido no tiene nada apartado: no hay qué entregar");
  }

  // El costo promedio del momento, para que la venta de hoy no se reescriba si
  // el promedio cambia mañana (05-contabilidad §4).
  const codigos = [...new Set(componentes.map((c) => c.codigo))];
  const { results: valores } = await ctx.db
    .prepare(
      `SELECT codigo, unidades, valor_cents FROM valor_inventario
        WHERE codigo IN (${codigos.map(() => "?").join(",")})`,
    )
    .bind(...codigos)
    .all<{ codigo: string; unidades: number; valor_cents: number }>();
  const promedio = new Map(valores.map((v) => [v.codigo, v]));

  const costoPorComponente = new Map<string, number | null>();
  let costoDesconocido = false;
  for (const c of componentes) {
    const v = promedio.get(c.codigo);
    // Sin promedio cargado, el costo NO se sabe. Un cero afirmaría que no costó
    // nada, y eso sí es una cifra inventada.
    if (v === undefined || v.unidades < c.cantidad || v.unidades <= 0) {
      costoPorComponente.set(`${c.linea_id}:${c.codigo}`, null);
      costoDesconocido = true;
      continue;
    }
    costoPorComponente.set(
      `${c.linea_id}:${c.codigo}`,
      Math.round((v.valor_cents * c.cantidad) / v.unidades),
    );
  }

  const respuesta: EntregaHecha = {
    envioId: e.envioId,
    cobradoCents: cobrado,
    entregadoEn: ctx.ahora,
    pedidoEntregado: true,
    costoDesconocido,
    yaEstaba: false,
  };

  // ── El batch ─────────────────────────────────────────────────────────────
  const enunciados: D1PreparedStatement[] = [
    // El candado va PRIMERO. Dos peticiones con la misma clave no pueden entrar
    // las dos: la segunda choca con la llave primaria y se cae el batch entero.
    enunciadoDeIdempotencia(ctx, e.idempotencia, RUTA_ENTREGAR, huella, respuesta),
    ...enunciadosDeParada(ctx, e.envioId, envio.estado, "entregado", envio.version, {
      nota: e.nota,
      punto: e.punto,
      columnas: {
        // `cobro_cents` se refresca al saldo de AHORA: lo que se le pidió
        // cobrar puede haber cambiado desde que salió (un pago en línea en
        // medio), y el CHECK `cobrado <= cobro` tiene que seguir cuadrando.
        sql: "entregado_en = ?, cobro_cents = ?, cobrado_cents = ?, cobro_metodo = ?, foto_r2 = COALESCE(?, foto_r2)",
        valores: [ctx.ahora, saldo, cobrado, e.metodoCobro ?? null, e.pruebaR2 ?? null],
      },
      // Lo que ESTE batch escribió, y no solo la versión: la hora exacta y el
      // monto. Si otro batch se metió en medio, su hora es otra y esto cae.
      controlExtra: {
        sql: "entregado_en = ? AND cobrado_cents = ?",
        valores: [ctx.ahora, cobrado],
      },
    }),
  ];

  // El stock. `aplicar()` de db/inventario.ts no sirve aquí: suma al físico sin
  // tocar lo reservado, y una entrega tiene que bajar los dos — si bajara solo
  // el físico, las unidades quedarían reservadas para siempre para un pedido ya
  // entregado, bloqueando stock que sí está disponible. Y tiene que ir en ESTE
  // batch, con la parada y el cobro.
  const costoPorLinea = new Map<string, { costo: number; cantidad: number } | null>();

  for (const c of componentes) {
    const costo = costoPorComponente.get(`${c.linea_id}:${c.codigo}`) ?? null;

    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO movimientos_inventario
             (id,codigo,bodega_id,delta,tipo,costo_unit_cents,referencia_tipo,referencia_id,
              motivo,actor,creado_en)
           VALUES (?,?,?,?,'venta',?,'envio',?,NULL,?,?)`,
        )
        .bind(
          ulid(ctx.ahora), c.codigo, c.bodega_id, -c.cantidad,
          costo === null ? null : Math.round(costo / c.cantidad),
          e.envioId, ctx.actor, ctx.ahora,
        ),
      /**
       * Sin guarda en el WHERE, y SIN fila de control. Las dos decisiones son a
       * propósito y las dos se comprobaron rompiéndolas:
       *
       * - **Sin `WHERE reservado >= ?`.** Con la guarda, un UPDATE que no casa
       *   con nada no falla: afecta cero filas y el batch sigue. Sin ella, los
       *   CHECK de `existencias` (`fisico >= 0`, `reservado >= 0`) tumban el
       *   batch si esto dejara algo en negativo. La tabla es más fiable que el
       *   WHERE porque no se puede olvidar.
       * - **Sin fila de control.** Aquí una no aportaría nada, y escribirla
       *   haría creer que protege algo. Lo único que podría pasar callando es
       *   que la fila de `existencias` no exista, y eso ya lo impide la llave
       *   foránea `(codigo, bodega_id)` de `movimientos_inventario`: el
       *   movimiento se inserta justo antes y no puede entrar sin su fila. Lo
       *   probé neutralizando el control —`ok = 1` fijo— y ninguna prueba se
       *   movió; probé borrando la fila de existencias y lo que salta es la
       *   llave foránea. Hay una prueba que lo fija.
       *
       * `aplicar()` de db/inventario.ts sí lleva el control, y ahí sí hace
       * falta: esa función solo mueve el físico, así que puede dejarlo por
       * debajo de lo reservado. Esta baja los dos a la vez y conserva la
       * invariante por construcción.
       */
      ctx.db
        .prepare(
          "UPDATE existencias SET fisico = fisico - ?, reservado = reservado - ? WHERE codigo = ? AND bodega_id = ?",
        )
        .bind(c.cantidad, c.cantidad, c.codigo, c.bodega_id),
    );

    if (costo !== null) {
      const v = promedio.get(c.codigo)!;
      // El promedio baja con la salida. Los centavos de redondeo que queden
      // cuando `unidades` llegue a cero los ajusta el asiento 18 en F5: aquí no
      // se inventan.
      enunciados.push(
        ctx.db
          .prepare(
            "UPDATE valor_inventario SET unidades = unidades - ?, valor_cents = valor_cents - ? WHERE codigo = ?",
          )
          .bind(c.cantidad, Math.min(costo, v.valor_cents), c.codigo),
        ctx.db
          .prepare(
            `INSERT INTO controles (id, regla, ok, creado_en)
             VALUES (?, ?, (SELECT COUNT(*) FROM valor_inventario WHERE codigo = ?), ?)`,
          )
          .bind(ulid(ctx.ahora), `costo:${c.codigo}`, c.codigo, ctx.ahora),
      );
    }

    // El costo de la LÍNEA es la suma de sus componentes: para un combo, lo que
    // costaron sus piezas. Se acumula aquí y se escribe una vez por línea.
    const ya = costoPorLinea.get(c.linea_id);
    if (costo === null || ya === null) {
      costoPorLinea.set(c.linea_id, null);
    } else {
      costoPorLinea.set(c.linea_id, {
        costo: (ya?.costo ?? 0) + costo,
        cantidad: c.linea_cantidad,
      });
    }
  }

  for (const [lineaId, acumulado] of costoPorLinea) {
    if (acumulado === null || acumulado.cantidad <= 0) continue;
    enunciados.push(
      // `IS NULL` en el WHERE: si ya tenía costo, no se reescribe. Un cambio
      // posterior del promedio no reescribe ventas pasadas (05-contabilidad §4).
      ctx.db
        .prepare(
          "UPDATE pedido_lineas SET costo_unit_cents = ? WHERE id = ? AND costo_unit_cents IS NULL",
        )
        .bind(Math.round(acumulado.costo / acumulado.cantidad), lineaId),
    );
  }

  // El cobro del saldo.
  //
  // El id se nombra en vez de generarse dentro del `bind` porque el asiento 4
  // lo necesita: su referencia apunta al PAGO, no al pedido. Un pedido tiene
  // varios pagos (el abono, el saldo) y cada uno lleva su asiento, así que una
  // referencia al pedido no permite preguntar «¿este cobro está en los
  // libros?» — que es justo la casilla del cierre que lo vigila.
  const pagoDelSaldo = ulid(ctx.ahora);

  if (cobrado > 0) {
    enunciados.push(
      ctx.db
        .prepare(
          `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,
             intento_ref,confirmado_por,confirmado_en,creado_en,actualizado_en)
           VALUES (?,?,'manual',?,'saldo','aprobado',?,?,?,?,?,?)`,
        )
        .bind(
          pagoDelSaldo,
          envio.pedido_id,
          e.metodoCobro ?? "otro",
          cobrado,
          // Derivado del ENVÍO y no de la clave de idempotencia: aunque el
          // teléfono genere dos claves distintas, el saldo de una entrega solo
          // se puede cobrar una vez.
          //
          // **Hoy es un cinturón de más, y conviene decirlo.** Lo comprobé
          // cambiándolo por la clave de idempotencia y la prueba de la carrera
          // siguió verde: lo que de verdad caza al batch perdedor es el control
          // de `enunciadosDeCobro`, porque la versión del pedido avanza DOS
          // veces en el batch ganador —el cobro y la transición— y la que el
          // perdedor esperaba ya no es la que hay. Se queda porque no cuesta
          // nada y sobrevive a que alguien toque ese control, pero quien lo lea
          // no debe creer que es lo que está defendiendo.
          `saldo:${e.envioId}`,
          ctx.actor,
          ctx.ahora,
          ctx.ahora,
          ctx.ahora,
        ),
      /**
       * El pago entra `aprobado` y no `confirmando`, al contrario que el
       * comprobante que manda una clienta (`db/pagos.ts`). La diferencia no es
       * de confianza: es que aquí **el monto lo puso el servidor** y el actor
       * es una persona identificada con su ficha de motorizado. Lo que queda
       * abierto es otra cosa —que ese efectivo llegue a la cuenta— y eso no se
       * resuelve dejando el pedido debiendo: se resuelve con la caja del
       * motorizado y su liquidación (F5.6). Mientras eso llega, lo cobrado por
       * cada motorizado se ve en la pantalla de entregas, que es lo que la
       * dueña le reclama al final del día.
       */
      ...enunciadosDeCobro(ctx, p.id, p.total_cents, p.pagado_cents + cobrado, p.version),
    );
  }

  // ── Los asientos ─────────────────────────────────────────────────────────
  //
  // Van en ESTE batch porque son parte del hecho y no una consecuencia suya.
  // Hasta hoy no iban: los veinte constructores de `dominio/contabilidad.ts`
  // estaban escritos, cuadraban y tenían pruebas, y NADIE LOS LLAMABA. Así que
  // una entrega descontaba el inventario, cobraba el saldo, movía el pedido
  // a «entregado»… y dejaba los libros exactamente igual que antes: vacíos.
  //
  // Si fueran una escritura aparte, un corte en medio dejaría la venta sin
  // asiento —mercancía fuera del inventario que ningún libro explica— o el
  // asiento sin la venta. Ninguna de las dos se descubre hasta el cierre, que
  // es un mes después, cuando ya nadie recuerda de qué entrega venía.
  const fechaDelAsiento = fechaContable(ctx.ahora);
  const referencia = { tipo: "pedido", id: p.id };

  // Asiento 3 · la venta se reconoce AQUÍ, al entregar, no al cobrar.
  //
  // `abonadoCents` es lo que había pagado ANTES de esta entrega: ese anticipo
  // deja de ser una deuda con la clienta y lo que falte se vuelve cuenta por
  // cobrar — que es justo lo que descarga el asiento 4 de más abajo. Los dos
  // tienen que ir juntos o 1201 queda con un saldo que nadie abrió.
  //
  // Un pedido de cero no genera asiento y el constructor lo rechaza. No es un
  // error: es un regalo o un canje, y la mercancía que salió ya quedó escrita
  // arriba como movimiento de inventario.
  if (p.total_cents > 0) {
    const venta = entregaDelPedido({
      fecha: fechaDelAsiento,
      referencia,
      numero: p.numero,
      totalCents: p.total_cents,
      subtotalCents: p.subtotal_cents,
      descuentoCents: p.descuento_cents,
      envioCents: p.envio_cents,
      itbmsCents: p.itbms_cents,
      abonadoCents: p.pagado_cents,
    });
    // Si el asiento no se puede armar, NO se entrega. Lo pensé al revés
    // primero, con el motorizado en la puerta: mejor registrar la entrega y
    // apuntar el asiento para después.
    //
    // No. Lo único que puede fallar aquí es que las partes del pedido no sumen
    // su total, y `pedidos` tiene ese mismo CHECK, así que con datos sanos no
    // pasa. Si pasa, el pedido está roto. La alternativa —escribir la entrega
    // y callar el asiento— es exactamente el descuadre silencioso que este
    // sistema existe para evitar. Un error ahora se arregla hoy.
    if (!venta.ok) return venta;
    enunciados.push(...enunciadosDeAsiento(ctx, venta.datos).enunciados);

    // Asiento 3b · lo que costó la mercancía que salió.
    //
    // Se salta cuando no se sabe, y eso es a propósito: el constructor falla
    // con un costo nulo en vez de escribir un cero, porque un cero afirma que
    // la mercancía no costó nada y convierte el margen en 100 %. El pedido
    // queda en la casilla «pedidos entregados sin costo» del cierre de mes,
    // que es donde la contadora lo ve y lo arregla con la factura.
    if (!costoDesconocido) {
      let costoTotal = 0;
      for (const c of costoPorComponente.values()) costoTotal += c ?? 0;
      // Cero SABIENDO el costo es otra cosa que cero por no saberlo: es
      // mercancía valorada en cero (donada, de muestra). No hay costo que
      // anotar, y tampoco nada que avisar.
      if (costoTotal > 0) {
        const costo = costoDeLaEntrega({
          fecha: fechaDelAsiento,
          referencia,
          numero: p.numero,
          costoCents: costoTotal,
        });
        if (!costo.ok) return costo;
        enunciados.push(...enunciadosDeAsiento(ctx, costo.datos).enunciados);
      }
    }
  }

  // Asientos 4 y 4b · el cobro del saldo descarga la cuenta por cobrar que
  // acaba de abrir el asiento 3.
  //
  // La cuenta sale del MÉTODO y no de un parámetro: en efectivo el dinero lo
  // tiene el motorizado y vive en su caja (1104-xx, asiento 4); por Yappy ya
  // está en la cuenta (1101, asiento 4b). Pasar el número del asiento aparte
  // permitiría decir «4b» con la caja de un motorizado, que es un asiento que
  // dice una cosa y hace otra.
  if (cobrado > 0) {
    const caja =
      e.metodoCobro === "efectivo" && envio.motorizado_id !== null ? envio.motorizado_id : null;
    const cuenta =
      e.metodoCobro === "yappy" ? "1101" : caja === null ? null : codigoDeCaja(caja);

    if (cuenta === null) {
      // `otro`, o efectivo sin motorizado asignado (una recogida en el local).
      //
      // El dinero entró y el pedido queda pagado, pero NO SE SABE A QUÉ CUENTA
      // entró, y los dieciocho asientos del documento no tienen uno para eso.
      // Inventar la caja de un motorizado que no está, o meterlo en 1103
      // «porque suena razonable», es poner una cifra a ojo en los libros —y la
      // regla del proyecto es que lo que falta queda PENDIENTE, no aproximado.
      //
      // Así que no se escribe asiento, y el hueco queda a la vista en vez de
      // enterrado: 1201 se queda con ese saldo mientras el pedido dice que
      // está pagado, y la casilla «lo por cobrar cuadra con 1201» del cierre
      // lo canta con su número y su pedido. Es la forma honesta de no saber.
    } else {
      if (caja !== null) {
        const m = await ctx.db
          .prepare("SELECT nombre FROM motorizados WHERE id = ?")
          .bind(caja)
          .first<{ nombre: string }>();
        // La llave foránea de `envios.motorizado_id` ya lo garantiza; si
        // llegara nulo es que la base está rota, y eso no se arregla
        // entregando sin asiento.
        if (m === null) return fallo("interno", "esta entrega apunta a un motorizado que no existe");
        // La caja nace en el MISMO batch que el primer cobro que la usa, y
        // ANTES de la línea del asiento: esa línea busca la cuenta por su
        // código dentro del propio INSERT, así que si la cuenta no existiera
        // todavía el `NOT NULL` de `cuenta_id` tumbaría el batch.
        enunciados.push(...enunciadosDeCuentaDeMotorizado(ctx, caja, m.nombre));
      }
      const cobro = cobroDelSaldo({
        fecha: fechaDelAsiento,
        // Al PAGO y no al pedido: los asientos 3 y 3b son del pedido (la venta
        // y su costo pasan una vez), pero un cobro es de UN pago concreto, y
        // sin esa referencia no se puede preguntar por un pago si está
        // anotado. La columna no tiene llave foránea a propósito, así que el
        // orden dentro del batch da igual.
        referencia: { tipo: "pago", id: pagoDelSaldo },
        cuenta,
        montoCents: cobrado,
        numero: p.numero,
      });
      if (!cobro.ok) return cobro;
      enunciados.push(...enunciadosDeAsiento(ctx, cobro.datos).enunciados);
    }
  }

  // Y el pedido. Va al final porque `enunciadosDeCobro` exige la versión que se
  // leyó, y la transición la sube otra vez.
  enunciados.push(
    ...enunciadosDeTransicion(ctx, p.id, "en_ruta", "entregado", {
      envioId: e.envioId,
      cobradoCents: cobrado,
    }),
  );

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);

    // Antes de dar un error, mirar si ya estaba hecho. El motorizado está en la
    // calle con mala señal: si su primer toque llegó y la respuesta no volvió,
    // el segundo tiene que decirle que sí, no asustarlo con un conflicto.
    const ahoraMismo = await leerEnvio(ctx.db, e.envioId);
    if (ahoraMismo !== null && ahoraMismo.estado === "entregado") {
      return ok({
        ...respuesta,
        cobradoCents: ahoraMismo.cobrado_cents,
        yaEstaba: true,
      });
    }

    // El mes de la entrega está cerrado: lo tumbó el trigger
    // `asientos_periodo_cerrado`. No es una carrera, así que decirle «algo
    // cambió, vuelva a intentarlo» lo manda a fallar otra vez igual. Hoy solo
    // puede pasar si alguien cerró un mes que no había terminado; cuando haya
    // entregas con fecha de ayer, será lo normal.
    if (/periodo_cerrado/.test(texto)) {
      return fallo(
        "periodo_cerrado",
        "el mes de esta entrega ya está cerrado: para registrarla hay que reabrir ese mes, y reabrir pide motivo",
      );
    }

    return /CHECK|controles|UNIQUE|constraint|ABORT|abort/i.test(texto)
      ? fallo("conflicto_version", "algo cambió mientras se marcaba la entrega; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok(respuesta);
}

export interface FalloDeEntrega {
  readonly idempotencia: string;
  readonly envioId: string;
  readonly motorizadoId?: string;
  readonly motivo: string;
  readonly punto?: Punto;
}

/**
 * No se pudo entregar.
 *
 * **El stock apartado NO se libera.** Una entrega fallida se reintenta: el
 * pedido vuelve a `agendado` y su mercancía sigue comprometida, porque sigue
 * siendo de esa clienta. Liberarla aquí la pondría a la venta y el reintento de
 * mañana se quedaría sin con qué.
 *
 * Lo que sí libera es `devolverParada`, que es cuando el pedido se cae de
 * verdad.
 */
export async function marcarFallida(
  ctx: ContextoEntrega,
  e: FalloDeEntrega,
): Promise<Resultado<{ envioId: string; pedidoReprogramado: boolean; yaEstaba: boolean }>> {
  if (e.idempotencia.trim() === "") {
    return fallo("entrada_invalida", "falta la clave del intento");
  }
  if (e.motivo.trim() === "") {
    // Sin motivo, mañana nadie sabe si hay que volver, llamar o devolver.
    return fallo("entrada_invalida", "diga por qué no se pudo entregar");
  }

  const huella = huellaDe([e.envioId, e.motivo]);
  const antes = await yaHecha<{ envioId: string; pedidoReprogramado: boolean; yaEstaba: boolean }>(
    ctx.db,
    e.idempotencia,
    RUTA_FALLAR,
    huella,
    ctx.ahora,
  );
  if (antes !== null) {
    return "respuesta" in antes
      ? ok({ ...antes.respuesta, yaEstaba: true })
      : fallo("repetido", "esa clave ya se usó para otra cosa");
  }

  const envio = await leerEnvio(ctx.db, e.envioId);
  if (envio === null) return fallo("no_encontrado", "no existe esa entrega");
  if (!esEstadoEnvio(envio.estado)) return fallo("interno", "esa entrega tiene un estado raro");

  const mal = validarTransicionEnvio(envio.estado, "fallido");
  if (mal !== null) return fallo("transicion_invalida", mal.mensaje);

  if (e.motorizadoId !== undefined && envio.motorizado_id !== e.motorizadoId) {
    return fallo("no_autorizado", "esta entrega no está asignada a usted");
  }

  const p = await leerPedido(ctx.db, envio.pedido_id);
  if (p === null) return fallo("no_encontrado", "no existe el pedido de esa entrega");

  const reprograma = p.estado === "en_ruta";
  const respuesta = { envioId: e.envioId, pedidoReprogramado: reprograma, yaEstaba: false };

  const enunciados: D1PreparedStatement[] = [
    enunciadoDeIdempotencia(ctx, e.idempotencia, RUTA_FALLAR, huella, respuesta),
    ...enunciadosDeParada(ctx, e.envioId, envio.estado, "fallido", envio.version, {
      nota: e.motivo,
      punto: e.punto,
    }),
  ];

  if (reprograma) {
    enunciados.push(
      ...enunciadosDeTransicion(ctx, p.id, "en_ruta", "agendado", { motivo: e.motivo }),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    const ahoraMismo = await leerEnvio(ctx.db, e.envioId);
    if (ahoraMismo !== null && ahoraMismo.estado === "fallido") {
      return ok({ ...respuesta, yaEstaba: true });
    }
    return /CHECK|controles|UNIQUE|constraint|ABORT|abort/i.test(texto)
      ? fallo("conflicto_version", "algo cambió mientras se marcaba el fallo; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok(respuesta);
}

/**
 * La parada se devuelve: el pedido se cae y su mercancía vuelve a la venta.
 *
 * Libera EXACTAMENTE lo que se apartó, leyéndolo de
 * `pedido_linea_componentes`. No se vuelve a leer la receta de un combo: pudo
 * cambiar desde la venta, y liberar según la receta nueva dejaría la diferencia
 * bloqueada para siempre sin que nada fallara.
 *
 * No reutiliza `cancelar()` de db/transiciones.ts por dos razones: desde
 * `en_ruta` ese camino se niega a propósito —y hace bien: desde la calle lo que
 * corresponde es una devolución, no un borrón— y, sobre todo, el estado de la
 * parada y la liberación tienen que entrar en el MISMO batch. En dos batches,
 * un corte en medio deja el envío devuelto con la mercancía todavía apartada.
 */
export async function devolverParada(
  ctx: ContextoEntrega,
  envioId: string,
  motivo: string,
): Promise<Resultado<{ devuelta: true; liberadas: number }>> {
  if (motivo.trim() === "") {
    return fallo("entrada_invalida", "una devolución sin motivo no le sirve a nadie");
  }

  const envio = await leerEnvio(ctx.db, envioId);
  if (envio === null) return fallo("no_encontrado", "no existe esa entrega");
  if (!esEstadoEnvio(envio.estado)) return fallo("interno", "esa entrega tiene un estado raro");

  const mal = validarTransicionEnvio(envio.estado, "devuelto");
  if (mal !== null) {
    return fallo(
      "transicion_invalida",
      `${mal.mensaje} Marque primero el intento como fallido.`,
    );
  }

  const p = await leerPedido(ctx.db, envio.pedido_id);
  if (p === null) return fallo("no_encontrado", "no existe el pedido de esa entrega");
  if (p.estado !== "agendado" && p.estado !== "por_abonar") {
    return fallo(
      "transicion_invalida",
      `el pedido ${p.numero} está ${p.estado}: no se puede devolver desde ahí`,
    );
  }

  const { results: componentes } = await ctx.db
    .prepare(
      `SELECT plc.codigo, plc.cantidad, plc.bodega_id
         FROM pedido_linea_componentes plc
         JOIN pedido_lineas pl ON pl.id = plc.linea_id
        WHERE pl.pedido_id = ?`,
    )
    .bind(envio.pedido_id)
    .all<{ codigo: string; cantidad: number; bodega_id: string }>();

  const enunciados: D1PreparedStatement[] = [
    ...enunciadosDeParada(ctx, envioId, envio.estado, "devuelto", envio.version, { nota: motivo }),
    ...enunciadosDeTransicion(ctx, p.id, p.estado, "cancelado", { motivo, envioId }),
  ];

  for (const c of componentes) {
    enunciados.push(
      // Sin `WHERE reservado >= ?`: el CHECK `reservado >= 0` de la tabla tumba
      // el batch si esto liberara de más, y la guarda haría justo lo contrario
      // de lo que parece —un UPDATE que no casa con nada no falla, y el pedido
      // quedaría cancelado con su reserva todavía puesta—.
      ctx.db
        .prepare("UPDATE existencias SET reservado = reservado - ? WHERE codigo = ? AND bodega_id = ?")
        .bind(c.cantidad, c.codigo, c.bodega_id),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM existencias
                          WHERE codigo = ? AND bodega_id = ?), ?)`,
        )
        .bind(ulid(ctx.ahora), `devolver:${c.codigo}`, c.codigo, c.bodega_id, ctx.ahora),
    );
  }

  try {
    await ctx.db.batch(enunciados);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    return /CHECK|controles|ABORT|abort/i.test(texto)
      ? fallo("conflicto_version", "algo cambió mientras se devolvía la parada; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok({ devuelta: true as const, liberadas: componentes.length });
}

/**
 * El día terminó.
 *
 * El trigger `ruta_no_se_cierra_con_paradas_abiertas` no deja cerrar con una
 * parada sin marcar, y por eso aquí no hace falta volver a comprobarlo: lo que
 * se comprueba antes es solo para poder decirlo con palabras.
 */
export async function cerrarRuta(
  ctx: ContextoEntrega,
  rutaId: string,
): Promise<Resultado<{ cerrada: true; entregadas: number; cobradoCents: number }>> {
  const r = await ctx.db
    .prepare("SELECT id, estado, version FROM rutas WHERE id = ?")
    .bind(rutaId)
    .first<{ id: string; estado: string; version: number }>();
  if (r === null) return fallo("no_encontrado", "no existe esa ruta");
  if (r.estado !== "en_curso") {
    return fallo("transicion_invalida", `esta ruta está ${r.estado}: solo se cierra una en curso`);
  }

  const cuenta = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN estado = 'entregado' THEN 1 ELSE 0 END) AS entregadas,
              SUM(CASE WHEN estado IN ('entregado','fallido','devuelto','anulado') THEN 1 ELSE 0 END) AS cerradas,
              COALESCE(SUM(cobrado_cents), 0) AS cobrado
         FROM envios WHERE ruta_id = ?`,
    )
    .bind(rutaId)
    .first<{ total: number; entregadas: number; cerradas: number; cobrado: number }>();

  const abiertas = (cuenta?.total ?? 0) - (cuenta?.cerradas ?? 0);
  if (abiertas > 0) {
    return fallo(
      "transicion_invalida",
      `quedan ${abiertas} parada${abiertas === 1 ? "" : "s"} sin marcar: no se puede cerrar el día`,
    );
  }

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE rutas SET estado = 'cerrada', cerrada_en = ?, version = version + 1
            WHERE id = ? AND estado = 'en_curso' AND version = ?`,
        )
        .bind(ctx.ahora, rutaId, r.version),
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, 'ruta:cerrada', (SELECT COUNT(*) FROM rutas
                   WHERE id = ? AND version = ? AND estado = 'cerrada' AND cerrada_en = ?), ?)`,
        )
        .bind(ulid(ctx.ahora), rutaId, r.version + 1, ctx.ahora, ctx.ahora),
    ]);
  } catch (err) {
    const texto = err instanceof Error ? err.message : String(err);
    return /CHECK|controles|ABORT|abort/i.test(texto)
      ? fallo("conflicto_version", "la ruta cambió mientras se cerraba; vuelva a intentarlo")
      : fallo("interno", texto);
  }

  return ok({
    cerrada: true as const,
    entregadas: cuenta?.entregadas ?? 0,
    cobradoCents: cuenta?.cobrado ?? 0,
  });
}

// ---------------------------------------------------------------------------
// 7. Lo que ve la pantalla
// ---------------------------------------------------------------------------

export interface ParadaDelDia {
  readonly envioId: string;
  readonly estado: EstadoEnvio;
  readonly orden: number | null;
  readonly pedido: string;
  /** De dónde se carga. Una ruta solo puede llevar paradas de su bodega. */
  readonly bodegaId: string;
  readonly bodega: string;
  readonly cliente: string | null;
  readonly zona: string | null;
  readonly direccion: string | null;
  readonly referencia: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly ventana: string | null;
  readonly cobroCents: number;
  readonly cobradoCents: number;
  readonly cobroMetodo: string | null;
  readonly entregadoEn: number | null;
  /** Si tiene prueba, no la clave: la clave es de un archivo sensible. */
  readonly conPrueba: boolean;
}

export interface RutaDelDia {
  readonly rutaId: string;
  readonly motorizado: string;
  readonly motorizadoId: string;
  readonly bodega: string;
  readonly estado: string;
  readonly salioEn: number | null;
  readonly cerradaEn: number | null;
  readonly kmPropuestos: number | null;
  readonly paradas: ParadaDelDia[];
}

/** Un pedido agendado al que todavía no se le ha preparado la entrega. */
export interface PedidoPorPreparar {
  readonly pedidoId: string;
  readonly numero: string;
  readonly cliente: string | null;
  readonly zona: string | null;
  readonly saldoCents: number;
}

export interface EntregasDelDia {
  readonly fecha: string;
  readonly rutas: RutaDelDia[];
  /** Entregas listas pero todavía sin ruta: el trabajo por repartir. */
  readonly sinRuta: ParadaDelDia[];
  /**
   * Lo que todavía no es una entrega.
   *
   * Sin esto la pantalla no serviría para empezar el día: un pedido agendado
   * sin envío no sale en ninguna de las dos listas de arriba, así que la dueña
   * vería la pantalla vacía sin saber que tiene trabajo esperando.
   */
  readonly porPreparar: PedidoPorPreparar[];
  readonly resumen: {
    readonly porEntregar: number;
    readonly entregadas: number;
    readonly fallidas: number;
    readonly cobradoCents: number;
  };
  readonly ajustes: AjustesDeEntrega;
}

const FILA_PARADA = `
  SELECT v.id, v.estado, v.orden_ruta, v.ventana, v.cobro_cents, v.cobrado_cents,
         v.cobro_metodo, v.entregado_en, v.foto_r2, v.ruta_id, v.bodega_id,
         b.nombre AS bodega, p.numero AS pedido, c.nombre AS cliente,
         z.nombre AS zona, d.texto AS direccion, d.referencia, d.lat, d.lng
    FROM envios v
    JOIN pedidos p ON p.id = v.pedido_id
    JOIN bodegas b ON b.id = v.bodega_id
    LEFT JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN zonas_envio z ON z.id = p.zona_id
    LEFT JOIN direcciones d ON d.id = p.direccion_id
`;

interface FilaParada {
  id: string;
  estado: string;
  orden_ruta: number | null;
  ventana: string | null;
  cobro_cents: number;
  cobrado_cents: number;
  cobro_metodo: string | null;
  entregado_en: number | null;
  foto_r2: string | null;
  ruta_id: string | null;
  bodega_id: string;
  bodega: string;
  pedido: string;
  cliente: string | null;
  zona: string | null;
  direccion: string | null;
  referencia: string | null;
  lat: number | null;
  lng: number | null;
}

const comoParada = (f: FilaParada): ParadaDelDia => ({
  envioId: f.id,
  estado: esEstadoEnvio(f.estado) ? f.estado : "pendiente",
  orden: f.orden_ruta,
  pedido: f.pedido,
  bodegaId: f.bodega_id,
  bodega: f.bodega,
  cliente: f.cliente,
  zona: f.zona,
  direccion: f.direccion,
  referencia: f.referencia,
  lat: f.lat,
  lng: f.lng,
  ventana: f.ventana,
  cobroCents: f.cobro_cents,
  cobradoCents: f.cobrado_cents,
  cobroMetodo: f.cobro_metodo,
  entregadoEn: f.entregado_en,
  // La clave del archivo NO sale: es un dato sensible y se sirve por su propia
  // ruta, con sesión. La pantalla solo necesita saber si hay foto.
  conPrueba: f.foto_r2 !== null,
});

/**
 * Las entregas de un día: las rutas con sus paradas, y lo que falta por
 * repartir.
 *
 * Trae el resumen YA CONTADO —cuánto falta, cuánto se entregó, cuánto se
 * cobró— para que la pantalla no tenga que sumarlo: si cada pantalla cuenta por
 * su cuenta, dos pantallas acaban diciendo números distintos del mismo día.
 */
export async function entregasDelDia(
  db: D1Database,
  fecha: string,
  ahora: number,
): Promise<Resultado<EntregasDelDia>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return fallo("entrada_invalida", "la fecha se escribe así: 2026-11-11");
  }

  const { results: rutas } = await db
    .prepare(
      `SELECT r.id, r.estado, r.salio_en, r.cerrada_en, r.km_propuestos,
              r.motorizado_id, m.nombre AS motorizado, b.nombre AS bodega
         FROM rutas r
         JOIN motorizados m ON m.id = r.motorizado_id
         JOIN bodegas b ON b.id = r.bodega_id
        WHERE r.fecha = ? AND r.estado <> 'cancelada'
        ORDER BY m.nombre`,
    )
    .bind(fecha)
    .all<{
      id: string;
      estado: string;
      salio_en: number | null;
      cerrada_en: number | null;
      km_propuestos: number | null;
      motorizado_id: string;
      motorizado: string;
      bodega: string;
    }>();

  const { results: paradas } = await db
    .prepare(`${FILA_PARADA} WHERE v.programado_para = ? ORDER BY v.orden_ruta, v.creado_en`)
    .bind(fecha)
    .all<FilaParada>();

  const porRuta = new Map<string, ParadaDelDia[]>();
  const sinRuta: ParadaDelDia[] = [];
  for (const f of paradas) {
    const parada = comoParada(f);
    if (f.ruta_id === null) {
      sinRuta.push(parada);
      continue;
    }
    const ya = porRuta.get(f.ruta_id) ?? [];
    ya.push(parada);
    porRuta.set(f.ruta_id, ya);
  }

  // Los pedidos agendados que todavía no tienen entrega preparada. No se filtran
  // por fecha: un pedido agendado el viernes y no despachado sigue siendo
  // trabajo del lunes, y esconderlo porque «no es de hoy» es cómo se olvida.
  const { results: porPreparar } = await db
    .prepare(
      `SELECT p.id, p.numero, p.total_cents - p.pagado_cents AS saldo,
              c.nombre AS cliente, z.nombre AS zona
         FROM pedidos p
         LEFT JOIN clientes c ON c.id = p.cliente_id
         LEFT JOIN zonas_envio z ON z.id = p.zona_id
        WHERE p.estado = 'agendado'
          AND NOT EXISTS (SELECT 1 FROM envios v
                           WHERE v.pedido_id = p.id
                             AND v.estado NOT IN ('entregado','devuelto','anulado'))
        ORDER BY p.creado_en
        LIMIT 100`,
    )
    .all<{ id: string; numero: string; saldo: number; cliente: string | null; zona: string | null }>();

  const todas = [...sinRuta, ...[...porRuta.values()].flat()];
  const abiertas = todas.filter(
    (p) => p.estado !== "entregado" && p.estado !== "devuelto" && p.estado !== "anulado",
  );

  return ok({
    fecha,
    rutas: rutas.map((r) => ({
      rutaId: r.id,
      motorizado: r.motorizado,
      motorizadoId: r.motorizado_id,
      bodega: r.bodega,
      estado: r.estado,
      salioEn: r.salio_en,
      cerradaEn: r.cerrada_en,
      kmPropuestos: r.km_propuestos,
      paradas: porRuta.get(r.id) ?? [],
    })),
    sinRuta,
    porPreparar: porPreparar.map((p) => ({
      pedidoId: p.id,
      numero: p.numero,
      cliente: p.cliente,
      zona: p.zona,
      saldoCents: Math.max(p.saldo, 0),
    })),
    resumen: {
      // «Fallido» cuenta como por entregar: la caja sigue siendo de alguien y
      // alguien tiene que decidir si se reintenta o se devuelve.
      porEntregar: abiertas.length,
      entregadas: todas.filter((p) => p.estado === "entregado").length,
      fallidas: todas.filter((p) => p.estado === "fallido").length,
      cobradoCents: todas.reduce((s, p) => s + p.cobradoCents, 0),
    },
    ajustes: await ajustesDeEntrega(db, ahora),
  });
}
