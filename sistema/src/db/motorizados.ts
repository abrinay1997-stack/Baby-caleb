import { fallo, ok, type Resultado } from "../contrato/resultado";
import { normalizarCelular } from "./clientes";
import {
  ESTADOS_MOTORIZADO,
  ETIQUETAS_MOTORIZADO,
  VEHICULOS,
  esEstadoMotorizado,
  esVehiculo,
  type EstadoMotorizado,
  type Vehiculo,
} from "../dominio/motorizado";
import { ulid } from "../ids";

/**
 * Los motorizados: darlos de alta, corregirlos y pausarlos.
 *
 * ## Por qué este archivo tenía que existir hoy
 *
 * Toda la cadena de entregas pedía un `motorizadoId` y NINGÚN código del
 * sistema podía crear uno. `armarRuta`, `despacharRuta`, `sugerirMotorizado`,
 * `cuenta_motorizado` en los libros: todo escrito, todo probado, y todo
 * esperando una fila que solo se podía meter con SQL a mano. El circuito se
 * cortaba exactamente ahí — la trampa §12, pero en el eslabón que convierte un
 * pedido pagado en una caja que sale a la calle.
 *
 * Así que esto NO añade una capacidad nueva: destapa las que ya estaban.
 *
 * ## Un motorizado no se borra
 *
 * No hay `DELETE` aquí, igual que en `bodegas.ts` y por el mismo motivo: su id
 * queda en cada `rutas`, en cada `envios` que llevó y en cada asiento de su
 * cuenta. Borrarlo dejaría el libro que explica quién llevó qué apuntando a
 * nadie. Lo que sí se puede es `pausa` —hoy no trabaja, mañana sí— e
 * `inactivo`, que es la salida definitiva.
 *
 * La diferencia importa porque `puedeRecibirEntregas` (en `dominio/`) solo
 * deja asignarle ruta a un `activo`, y `GET /entregas` ya esconde a los
 * inactivos de la lista de a quién asignar. O sea: el estado ya tenía
 * consecuencias antes de que existiera forma de cambiarlo.
 *
 * ## Lo que este archivo NO hace, a propósito
 *
 * **No pone el PIN.** `pin_hash` se queda en NULL. El PIN es la llave de la
 * puerta del motorizado (`ruta.babycaleb.com`: celular + PIN, sin Access), y
 * esa puerta es una superficie PÚBLICA nueva —con su Turnstile, su límite de
 * intentos y su sesión— que no se decide de madrugada; está dicho con esas
 * palabras en el comentario de las rutas de entregas del panel. Las piezas
 * están listas (`seguridad/pin.ts` lleva `hashearPin` probado y sin usar).
 * Mientras no exista esa puerta, un motorizado sin PIN no bloquea nada: quien
 * despacha mueve las entregas desde el panel.
 *
 * **No le pone tarifa.** Lo que se le paga por entrega es `pago_regla_json` y
 * está PENDIENTE de la dueña. Ninguna cifra a ojo (CLAUDE.md): un número
 * inventado aquí acabaría en un asiento de su cuenta.
 */

export interface ContextoMotorizado {
  readonly db: D1Database;
  readonly ahora: number;
}

export interface MotorizadoEnLista {
  readonly id: string;
  readonly nombre: string;
  readonly celular_e164: string;
  readonly estado: EstadoMotorizado;
  readonly vehiculo: Vehiculo | null;
  readonly tiene_pin: boolean;
  readonly entregas_hoy: number;
}

/** El mismo tope que el nombre de una bodega: cabe en la pantalla del teléfono. */
const LARGO_NOMBRE = 60;

function revisarNombre(crudo: unknown): Resultado<string> {
  if (typeof crudo !== "string") return fallo("entrada_invalida", "falta el nombre");
  const nombre = crudo.trim().replace(/\s+/g, " ");
  if (nombre === "") return fallo("entrada_invalida", "falta el nombre");
  if (nombre.length > LARGO_NOMBRE) {
    return fallo("entrada_invalida", `el nombre no puede pasar de ${LARGO_NOMBRE} letras`);
  }
  return ok(nombre);
}

/**
 * El celular, con la MISMA función que normaliza el de una clienta.
 *
 * No es comodidad: la columna es UNIQUE, así que «6000-0001» y «50760000001»
 * tienen que llegar a la misma forma o el mismo motorizado entra dos veces y
 * la lista de a quién asignar enseña dos personas que son una.
 */
function revisarCelular(crudo: unknown): Resultado<string> {
  if (typeof crudo !== "string") return fallo("entrada_invalida", "falta el celular");
  const celular = normalizarCelular(crudo);
  if (celular === null) {
    return fallo("entrada_invalida", "ese celular no se entiende: son 8 dígitos, o 507 y 8 más");
  }
  return ok(celular);
}

function revisarVehiculo(crudo: unknown): Resultado<Vehiculo | null> {
  if (crudo === undefined || crudo === null || crudo === "") return ok(null);
  if (typeof crudo !== "string" || !esVehiculo(crudo)) {
    return fallo("entrada_invalida", `en qué anda: ${VEHICULOS.join(", ")}`);
  }
  return ok(crudo);
}

/** ¿Hay OTRO con ese celular? Se pregunta; no se lee el mensaje de error de D1. */
async function otroTieneElCelular(
  db: D1Database,
  celular: string,
  exceptoId: string,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare("SELECT id, nombre FROM motorizados WHERE celular_e164 = ? AND id <> ?")
    .bind(celular, exceptoId)
    .first<{ id: string; nombre: string }>();
}

/**
 * Uno nuevo. Nace `activo`, porque a nadie se le da de alta para dejarlo
 * guardado: se le da de alta el día que empieza a trabajar.
 */
export async function crear(
  ctx: ContextoMotorizado,
  datos: { nombre?: unknown; celular?: unknown; vehiculo?: unknown },
): Promise<Resultado<{ id: string; nombre: string; celular_e164: string }>> {
  const nombre = revisarNombre(datos.nombre);
  if (!nombre.ok) return nombre;
  const celular = revisarCelular(datos.celular);
  if (!celular.ok) return celular;
  const vehiculo = revisarVehiculo(datos.vehiculo);
  if (!vehiculo.ok) return vehiculo;

  // Se pregunta ANTES para poder decir CON QUIÉN choca. El UNIQUE de la
  // columna sigue siendo el candado de verdad —entre la pregunta y el INSERT
  // cabe otra petición—, pero un «ya está dado de alta como Pedro» se arregla
  // solo y un «constraint failed» hay que venir a leerlo aquí.
  const choque = await otroTieneElCelular(ctx.db, celular.datos, "");
  if (choque !== null) {
    return fallo("repetido", `ese celular ya es de ${choque.nombre}`);
  }

  const id = ulid(ctx.ahora);
  try {
    await ctx.db
      .prepare(
        `INSERT INTO motorizados (id, nombre, celular_e164, estado, vehiculo, pin_fallos, creado_en)
         VALUES (?,?,?,'activo',?,0,?)`,
      )
      .bind(id, nombre.datos, celular.datos, vehiculo.datos, ctx.ahora)
      .run();
  } catch {
    const quien = await otroTieneElCelular(ctx.db, celular.datos, id);
    if (quien !== null) return fallo("repetido", `ese celular ya es de ${quien.nombre}`);
    return fallo("interno", "no se pudo dar de alta");
  }

  // Aquí no hay fila de control detrás, y es a propósito: un INSERT o entra o
  // revienta. Un control que no puede ser falso hace creer que algo está
  // vigilado cuando no lo está (es lo que ya dice `bodegas.ts`).
  return ok({ id, nombre: nombre.datos, celular_e164: celular.datos });
}

/**
 * Corregir el nombre, el celular o en qué anda.
 *
 * El estado NO se cambia por aquí: tiene su propia función porque tiene
 * consecuencias (deja o no deja asignarle ruta) y porque así la bitácora de
 * quién lo pausó no se mezcla con «le arreglé una tilde al nombre».
 */
export async function editar(
  ctx: ContextoMotorizado,
  id: string,
  cambios: { nombre?: unknown; celular?: unknown; vehiculo?: unknown },
): Promise<Resultado<{ id: string }>> {
  const campos: string[] = [];
  const valores: (string | null)[] = [];

  if (cambios.nombre !== undefined) {
    const nombre = revisarNombre(cambios.nombre);
    if (!nombre.ok) return nombre;
    campos.push("nombre = ?");
    valores.push(nombre.datos);
  }
  if (cambios.celular !== undefined) {
    const celular = revisarCelular(cambios.celular);
    if (!celular.ok) return celular;
    const choque = await otroTieneElCelular(ctx.db, celular.datos, id);
    if (choque !== null) return fallo("repetido", `ese celular ya es de ${choque.nombre}`);
    campos.push("celular_e164 = ?");
    valores.push(celular.datos);
  }
  if (cambios.vehiculo !== undefined) {
    const vehiculo = revisarVehiculo(cambios.vehiculo);
    if (!vehiculo.ok) return vehiculo;
    campos.push("vehiculo = ?");
    valores.push(vehiculo.datos);
  }

  if (campos.length === 0) return fallo("entrada_invalida", "no dijo qué cambiar");

  // Un UPDATE que no casa con ninguna fila NO falla en D1: afecta cero filas y
  // la petición sale con un «listo» sobre un motorizado que no existe (trampa
  // nº 1). Así que se mira cuántas filas cambió.
  const r = await ctx.db
    .prepare(`UPDATE motorizados SET ${campos.join(", ")} WHERE id = ?`)
    .bind(...valores, id)
    .run();
  if (r.meta.changes === 0) return fallo("no_encontrado", "ese motorizado no existe");

  return ok({ id });
}

/**
 * Activo, en pausa o fuera.
 *
 * Pasa por aquí y no por `editar` porque esto cambia lo que el sistema LE DEJA
 * hacer: `puedeRecibirEntregas` solo admite `activo`. Y se comprueba que el
 * estado que llega sea uno de los tres antes de tocar la base, porque el CHECK
 * de la columna lo rechazaría con un error que nadie sabe leer.
 */
export async function cambiarEstado(
  ctx: ContextoMotorizado,
  id: string,
  estadoCrudo: unknown,
): Promise<Resultado<{ id: string; estado: EstadoMotorizado; rutasAbiertas: number }>> {
  if (typeof estadoCrudo !== "string" || !esEstadoMotorizado(estadoCrudo)) {
    return fallo("entrada_invalida", `el estado es uno de: ${ESTADOS_MOTORIZADO.join(", ")}`);
  }
  const estado = estadoCrudo;

  // Lo que hay en la calle ahora mismo. No bloquea el cambio —si alguien se
  // accidentó, hay que poder pausarlo con la ruta a medias— pero se DEVUELVE,
  // para que la pantalla pueda decir «tiene 4 entregas sin cerrar» en vez de
  // dejar que se descubra mañana.
  const abiertas = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM rutas
        WHERE motorizado_id = ? AND estado NOT IN ('cerrada','cancelada')`,
    )
    .bind(id)
    .first<{ n: number }>();

  const r = await ctx.db
    .prepare("UPDATE motorizados SET estado = ? WHERE id = ? AND estado <> ?")
    .bind(estado, id, estado)
    .run();
  if (r.meta.changes === 0) {
    // Cero filas son dos cosas distintas y la persona merece saber cuál.
    const hay = await ctx.db
      .prepare("SELECT estado FROM motorizados WHERE id = ?")
      .bind(id)
      .first<{ estado: string }>();
    if (hay === null) return fallo("no_encontrado", "ese motorizado no existe");
    return ok({ id, estado, rutasAbiertas: abiertas?.n ?? 0 });
  }

  return ok({ id, estado, rutasAbiertas: abiertas?.n ?? 0 });
}

/**
 * La lista, con lo que hace falta para decidir a quién asignarle.
 *
 * `entregas_hoy` cuenta lo que ya lleva encima hoy, que es el dato que falta
 * cuando hay que repartir tres rutas entre dos personas. Se cuenta por
 * `envios` y no por `rutas` porque una ruta de diez paradas y otra de dos no
 * son la misma carga.
 */
export async function listar(
  db: D1Database,
  opciones: { incluirInactivos?: boolean; hoy?: string } = {},
): Promise<Resultado<{ motorizados: MotorizadoEnLista[] }>> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.nombre, m.celular_e164, m.estado, m.vehiculo,
              CASE WHEN m.pin_hash IS NULL THEN 0 ELSE 1 END AS tiene_pin,
              (SELECT COUNT(*) FROM envios e
                 JOIN rutas r ON r.id = e.ruta_id
                WHERE r.motorizado_id = m.id
                  AND r.fecha = COALESCE(?, r.fecha)
                  AND r.estado NOT IN ('cancelada')) AS entregas_hoy
         FROM motorizados m
        WHERE (? = 1 OR m.estado <> 'inactivo')
        ORDER BY m.estado = 'activo' DESC, m.nombre`,
    )
    .bind(opciones.hoy ?? null, opciones.incluirInactivos === true ? 1 : 0)
    .all<{
      id: string;
      nombre: string;
      celular_e164: string;
      estado: string;
      vehiculo: string | null;
      tiene_pin: number;
      entregas_hoy: number;
    }>();

  return ok({
    motorizados: results.map((m) => ({
      id: m.id,
      nombre: m.nombre,
      celular_e164: m.celular_e164,
      // El CHECK de la columna ya garantiza los tres valores; el `as` es para
      // el tipo, no para confiar en lo que venga.
      estado: m.estado as EstadoMotorizado,
      vehiculo: m.vehiculo === null ? null : (m.vehiculo as Vehiculo),
      tiene_pin: m.tiene_pin === 1,
      entregas_hoy: m.entregas_hoy,
    })),
  });
}

/** Las etiquetas en español, para que la pantalla no las vuelva a escribir. */
export { ETIQUETAS_MOTORIZADO };
