import { fallo, ok } from "../contrato/resultado";
import type { Fallo, Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import { listarPedidos } from "./pedidos-lectura";
import type { PedidoEnLista, QuienMira } from "./pedidos-lectura";

/**
 * Las clientas, para quien atiende desde el panel.
 *
 * El camino del CRM (`rpc/crm.ts`) resuelve una clienta por su IDENTIDAD en un
 * canal —el id de WhatsApp, el de Telegram—, que es lo que trae un chat. Quien
 * atiende por teléfono no tiene eso: tiene un nombre y un celular. Son dos
 * puertas distintas a la misma persona, y por eso esto vive aparte en vez de
 * retorcer la otra.
 *
 * Lo que NO es distinto es la regla contra los duplicados, y aquí es el punto
 * entero del módulo: un negocio que lleva años atendiendo por WhatsApp acaba
 * con la misma señora tres veces —«Rosa», «Rosa E.», «rosa sanchez»— y
 * entonces su historial de compras no existe, está repartido. Limpiar eso
 * después es trabajo manual y se hace mal.
 *
 * Por eso aquí no hay «crear clienta». Hay `encontrarOCrear`: si el celular ya
 * es de alguien, devuelve a ESA persona en vez de inventar otra ficha. El
 * esquema además lo respalda con `celular_e164 UNIQUE`, así que ni una carrera
 * entre dos pestañas puede colar la segunda.
 */

export interface Contexto {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
}

export interface ClientaEnLista {
  readonly id: string;
  readonly nombre: string | null;
  readonly celular_e164: string | null;
  readonly pedidos: number;
  readonly ultimo_pedido: number | null;
}

/** Cuántas caben en una búsqueda. Es un selector, no un listado. */
const TOPE = 20;

/**
 * El celular, en el formato en que lo guarda la base: `5076XXXXXXX`, sin `+`.
 *
 * Quien atiende lo teclea como le sale —con espacios, con guiones, con `+`, o
 * solo los ocho dígitos de Panamá— y las tres formas tienen que llegar a la
 * MISMA fila. Si no, el formato de tecleo se convierte en una clienta nueva, y
 * el duplicado que este módulo existe para evitar entra por la puerta de atrás.
 */
export function normalizarCelular(crudo: string): string | null {
  const solo = crudo.replace(/\D/g, "");
  if (solo === "") return null;
  // Panamá: 8 dígitos sueltos se asumen locales. Con 507 delante, ya está.
  if (solo.length === 8) return `507${solo}`;
  if (solo.length === 11 && solo.startsWith("507")) return solo;
  // Cualquier otro largo es un número de otro país o un dedo gordo: se guarda
  // tal cual y se deja que la persona lo vea escrito.
  return solo.length >= 7 && solo.length <= 15 ? solo : null;
}

/**
 * Buscar por nombre o por celular, entero o por el final.
 *
 * La búsqueda por celular normaliza ANTES de comparar, para que «6000-0001»
 * encuentre a quien está guardada como `50760000001`.
 *
 * Y acepta un TROZO del número, que es como lo usa una persona. Antes solo
 * valía el celular completo: escribir «6999» —los cuatro dígitos que uno
 * recuerda de una clienta que acaba de llamar— no devolvía nada, mientras la
 * propia pantalla invitaba a «probar con el celular». Buscar es justo lo que
 * se hace cuando NO se tiene el dato entero; pedir el número completo es
 * pedir lo que se estaba buscando.
 *
 * Por el FINAL y no por cualquier parte: un celular se recuerda por sus
 * últimas cifras, y buscar «507» en medio devolvería a todo Panamá. Se piden
 * tres dígitos como mínimo por lo mismo.
 *
 * Lo encontró una persona usando el panel, no una prueba: la consulta hacía
 * exactamente lo que decía su comentario, y su comentario no describía cómo
 * busca alguien de verdad.
 */
export async function buscar(
  db: D1Database,
  consulta: string,
  limite = TOPE,
): Promise<Resultado<{ clientas: ClientaEnLista[] }>> {
  const texto = consulta.trim();
  if (texto === "") return ok({ clientas: [] });

  const tope = Math.min(Math.max(1, limite), TOPE);
  const porNombre = `%${texto.toLowerCase()}%`;
  const porCelular = normalizarCelular(texto);
  // El trozo final: solo si lo que se escribió son dígitos (con separadores),
  // para que un nombre con un número dentro no se convierta en una búsqueda
  // de teléfonos.
  const digitos = /^[\d\s()+-]+$/.test(texto) ? texto.replace(/\D/g, "") : "";
  const finalDelCelular = digitos.length >= 3 ? `%${digitos}` : null;

  const { results } = await db
    .prepare(
      `SELECT c.id, c.nombre, c.celular_e164,
              (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = c.id) AS pedidos,
              (SELECT MAX(p.creado_en) FROM pedidos p WHERE p.cliente_id = c.id) AS ultimo_pedido
         FROM clientes c
        WHERE c.anonimizado_en IS NULL
          AND c.fusionado_en_id IS NULL
          AND (LOWER(COALESCE(c.nombre,'')) LIKE ?1
               OR (?2 IS NOT NULL AND c.celular_e164 = ?2)
               OR (?3 IS NOT NULL AND c.celular_e164 LIKE ?3))
        ORDER BY ultimo_pedido DESC NULLS LAST, c.nombre
        LIMIT ?4`,
    )
    .bind(porNombre, porCelular, finalDelCelular, tope)
    .all<ClientaEnLista>();

  return ok({ clientas: results });
}

/**
 * La clienta de ese celular, o una nueva si no existe.
 *
 * Devuelve `nuevo` para que la pantalla pueda decir «ya la tenía» en vez de
 * dejar a quien atiende con la duda de si acaba de crear un duplicado.
 *
 * Una clienta FUSIONADA devuelve la ficha que quedó viva: el celular viejo
 * sigue apuntando a la persona, que es de lo que se trata.
 */
export async function encontrarOCrear(
  ctx: Contexto,
  datos: { readonly nombre: string; readonly celular: string },
): Promise<Resultado<{ clienteId: string; nuevo: boolean; nombre: string | null }>> {
  const nombre = datos.nombre.trim();
  if (nombre === "") return fallo("entrada_invalida", "la clienta necesita un nombre");

  const celular = normalizarCelular(datos.celular);
  if (celular === null) {
    return fallo("entrada_invalida", "ese celular no se entiende. Escríbalo como 6000-0001");
  }

  const ya = await ctx.db
    .prepare(
      "SELECT id, nombre, fusionado_en_id FROM clientes WHERE celular_e164 = ? AND anonimizado_en IS NULL",
    )
    .bind(celular)
    .first<{ id: string; nombre: string | null; fusionado_en_id: string | null }>();

  if (ya !== null) {
    // Si esa ficha se fusionó en otra, la persona es la que quedó viva.
    const id = ya.fusionado_en_id ?? ya.id;
    return ok({ clienteId: id, nuevo: false, nombre: ya.nombre });
  }

  const clienteId = ulid(ctx.ahora);
  try {
    await ctx.db
      .prepare(
        `INSERT INTO clientes (id,nombre,celular_e164,consentimiento_origen,creado_en,actualizado_en)
         VALUES (?,?,?,'panel',?,?)`,
      )
      .bind(clienteId, nombre, celular, ctx.ahora, ctx.ahora)
      .run();
  } catch (e) {
    // El UNIQUE del celular: otra pestaña la creó entre la lectura y esta
    // escritura. No es un error que la persona deba ver — la clienta existe,
    // que es lo que se pedía.
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
      const otra = await ctx.db
        .prepare("SELECT id, nombre FROM clientes WHERE celular_e164 = ?")
        .bind(celular)
        .first<{ id: string; nombre: string | null }>();
      if (otra !== null) return ok({ clienteId: otra.id, nuevo: false, nombre: otra.nombre });
    }
    return fallo("interno", "no se pudo guardar la clienta");
  }

  return ok({ clienteId, nuevo: true, nombre });
}

// ---------------------------------------------------------------------------
// La ficha completa (F4.20)
//
// Hasta aquí este módulo servía para UNA cosa: encontrar a la clienta al tomar
// un pedido. Con eso se entrega y se cobra por Yappy, y por eso tres columnas
// alcanzaban.
//
// Lo que no alcanza son las dos cosas que todavía no se hacen: cobrar con
// tarjeta —Tilopay exige los campos de facturación completos, con el apellido
// SEPARADO del nombre y la provincia en ISO— y emitir la factura de la DGI,
// que necesita la cédula o el RUC. Y la cédula no va a venir nunca de la
// pasarela: ese campo no existe en su API, así que o vive aquí o no existe el
// día que haya que facturar.
//
// La migración 0012 añadió esas columnas, todas anulables. NULL aquí no es
// «no tiene»: es «todavía no se lo hemos preguntado», y la pantalla de
// Clientas lo dice con esas palabras en vez de pintar un hueco.
// ---------------------------------------------------------------------------

/** Lo que puede ser el número de identificación. Es el CHECK de la columna. */
export const TIPOS_DE_IDENTIFICACION = ["cedula", "ruc"] as const;

export type TipoDeIdentificacion = (typeof TIPOS_DE_IDENTIFICACION)[number];

export const esTipoDeIdentificacion = (v: string): v is TipoDeIdentificacion =>
  (TIPOS_DE_IDENTIFICACION as readonly string[]).includes(v);

export interface FichaDeClienta {
  readonly id: string;
  readonly nombre: string | null;
  readonly apellido: string | null;
  readonly celular_e164: string | null;
  readonly correo: string | null;
  readonly identificacion: string | null;
  readonly identificacion_tipo: string | null;
  readonly notas: string | null;
  readonly creado_en: number;
  readonly actualizado_en: number;
  /** Si no es nulo, esta ficha se fusionó: la persona vive en esa otra. */
  readonly fusionado_en_id: string | null;
  readonly anonimizado_en: number | null;
}

export interface DireccionDeClienta {
  readonly id: string;
  readonly zona: string | null;
  /** Calle, casa o edificio, piso. Es lo que lee el motorizado para llegar. */
  readonly texto: string;
  readonly referencia: string | null;
  readonly ciudad: string | null;
  readonly provincia_iso: string | null;
  readonly codigo_postal: string | null;
  readonly pais: string | null;
  readonly activa: number;
}

/**
 * Qué falta para cada cosa, dicho en español.
 *
 * Se calcula EN EL SERVIDOR y no en la pantalla a propósito: quien sabe qué
 * exige la pasarela es el sistema, no la vista. Si la lista viviera en el
 * navegador, el día que Tilopay pida un campo más habría que acordarse de
 * cambiarlo en dos sitios — y el que se olvida es el que nadie mira.
 */
export interface LoQueFalta {
  readonly paraTarjeta: string[];
  readonly paraFactura: string[];
}

/**
 * Los campos de facturación de Tilopay, traducidos a lo que tenemos.
 *
 *   billToFirstName   → clientes.nombre
 *   billToLastName    → clientes.apellido
 *   billToEmail       → clientes.correo
 *   billToTelephone   → clientes.celular_e164
 *   billToAddress     → direcciones.texto
 *   billToAddress2    → direcciones.referencia
 *   billToCity        → direcciones.ciudad
 *   billToState       → direcciones.provincia_iso   (ISO: «PA-8»)
 *   billToZipPostCode → direcciones.codigo_postal
 *   billToCountry     → direcciones.pais            («PA»)
 *
 * PENDIENTE, y por eso la pantalla lo dice en voz alta: son DIEZ, y los
 * obligatorios son doce. Los otros dos no se inventan — hay que sacarlos de la
 * documentación de Tilopay y anotarlos en docs/plan/04-pagos.md §4.2, que hoy
 * describe la integración pero no lista estos campos.
 *
 * `referencia` (billToAddress2) NO cuenta como faltante: el campo es
 * obligatorio como campo, pero si puede viajar vacío está sin confirmar, y
 * pintar un «falta» que a lo mejor no falta enseña a ignorar los avisos. En
 * cuanto Tilopay lo confirme, es una línea más en esta función.
 */
export function loQueFalta(
  clienta: Pick<
    FichaDeClienta,
    "nombre" | "apellido" | "correo" | "celular_e164" | "identificacion" | "identificacion_tipo"
  >,
  direccion: DireccionDeClienta | null,
): LoQueFalta {
  const paraTarjeta: string[] = [];
  const vacio = (v: string | null) => v === null || v.trim() === "";

  if (vacio(clienta.nombre)) paraTarjeta.push("el nombre");
  if (vacio(clienta.apellido)) paraTarjeta.push("el apellido");
  if (vacio(clienta.correo)) paraTarjeta.push("el correo");
  if (vacio(clienta.celular_e164)) paraTarjeta.push("el celular");

  if (direccion === null) {
    paraTarjeta.push("una dirección");
  } else {
    if (vacio(direccion.texto)) paraTarjeta.push("la calle o el edificio");
    if (vacio(direccion.ciudad)) paraTarjeta.push("la ciudad");
    if (vacio(direccion.provincia_iso)) paraTarjeta.push("la provincia");
    if (vacio(direccion.codigo_postal)) paraTarjeta.push("el código postal");
    if (vacio(direccion.pais)) paraTarjeta.push("el país");
  }

  // La factura se teclea en el facturador de la DGI, que no tiene API
  // (docs/plan/00-revision.md, M3). Lo que el sistema puede hacer es tener los
  // datos listos para que teclearlos sea rápido y sin errores.
  //
  // PENDIENTE: qué pide EXACTAMENTE ese formulario además del nombre y la
  // identificación. Hasta que alguien lo mire, aquí solo entra lo que es
  // seguro que hace falta; añadir campos a ojo haría que la pantalla pidiera
  // datos que quizá nadie necesita.
  const paraFactura: string[] = [];
  if (vacio(clienta.nombre)) paraFactura.push("el nombre");
  if (vacio(clienta.apellido)) paraFactura.push("el apellido");
  if (vacio(clienta.identificacion)) paraFactura.push("la cédula o el RUC");
  else if (vacio(clienta.identificacion_tipo)) paraFactura.push("si ese número es cédula o RUC");

  return { paraTarjeta, paraFactura };
}

export interface Ficha {
  readonly clienta: FichaDeClienta;
  readonly direcciones: DireccionDeClienta[];
  readonly pedidos: PedidoEnLista[];
  readonly falta: LoQueFalta;
}

/**
 * La ficha de una clienta: sus datos, sus direcciones y sus pedidos.
 *
 * Los pedidos salen de `listarPedidos` y no de una consulta propia, y eso es
 * deliberado: ahí vive la regla de QUIÉN VE EL DINERO. Escribir aquí otro
 * SELECT con su propio recorte sería tener dos sitios decidiendo lo mismo, y
 * el que se equivoca del lado flojo es el que nadie revisa.
 *
 * Una ficha fusionada o anonimizada SÍ se devuelve, con sus marcas. `buscar`
 * no las ofrece, así que para llegar aquí hace falta un enlace directo — y
 * entonces es mejor explicar qué pasó con esa persona que contestar «no
 * existe» a una ficha que sí está.
 */
export async function leerFicha(
  db: D1Database,
  quien: QuienMira,
  id: string,
): Promise<Resultado<Ficha>> {
  const clienta = await db
    .prepare(
      `SELECT id, nombre, apellido, celular_e164, correo, identificacion, identificacion_tipo,
              notas, creado_en, actualizado_en, fusionado_en_id, anonimizado_en
         FROM clientes WHERE id = ?`,
    )
    .bind(id)
    .first<FichaDeClienta>();
  if (clienta === null) return fallo("no_encontrado", "no existe esa clienta");

  const { results: direcciones } = await db
    .prepare(
      `SELECT d.id, z.nombre AS zona, d.texto, d.referencia, d.ciudad, d.provincia_iso,
              d.codigo_postal, d.pais, d.activa
         FROM direcciones d
         LEFT JOIN zonas_envio z ON z.id = d.zona_id
        WHERE d.cliente_id = ?
        ORDER BY d.activa DESC, d.creado_en DESC`,
    )
    .bind(id)
    .all<DireccionDeClienta>();

  const pedidos = await listarPedidos(db, quien, { clienteId: id, limite: 50 });
  if (!pedidos.ok) return pedidos;

  // La dirección contra la que se mide «qué falta» es la primera activa: es la
  // que se usaría al cobrar. Si no hay ninguna activa, falta una dirección, que
  // es exactamente lo que dirá la lista.
  const principal = direcciones.find((d) => d.activa === 1) ?? null;

  return ok({
    clienta,
    direcciones,
    pedidos: pedidos.datos.pedidos,
    falta: loQueFalta(clienta, principal),
  });
}

/** Lo que se puede cambiar de la dirección. La calle y la zona no se tocan aquí. */
export interface CambiosEnDireccion {
  readonly id: string;
  readonly ciudad?: string | null;
  readonly provinciaIso?: string | null;
  readonly codigoPostal?: string | null;
  readonly pais?: string | null;
}

export interface CambiosEnClienta {
  readonly nombre?: string;
  readonly apellido?: string | null;
  readonly celular?: string;
  readonly correo?: string | null;
  readonly identificacion?: string | null;
  readonly identificacionTipo?: string | null;
  readonly notas?: string | null;
  /** Los datos de facturación de UNA de sus direcciones. */
  readonly direccion?: CambiosEnDireccion;
}

/**
 * Lo que escribe la pantalla cuando el campo queda en blanco.
 *
 * Un `""` no es un dato: es «lo borré» o «nunca lo llené», y las dos cosas se
 * guardan igual —NULL— para que `loQueFalta` lo vea. Guardar la cadena vacía
 * dejaría una ficha que parece completa y no lo está.
 */
const vacioEsNulo = (v: string | null): string | null => {
  if (v === null) return null;
  const limpio = v.trim();
  return limpio === "" ? null : limpio;
};

/**
 * Editar la ficha de una clienta.
 *
 * `encontrarOCrear` se queda como está: su razón de ser es no crear
 * duplicados, y para eso tiene que seguir siendo la única puerta por la que
 * nace una ficha. Esto es la otra mitad —corregir lo que ya existe— y por eso
 * no crea nada.
 *
 * ## Cómo se garantiza que lo escrito se escribió
 *
 * `clientes` no tiene columna `version`, así que no hay versión optimista que
 * mandar. Lo que sí hay es la regla de la casa: toda escritura va en un
 * `db.batch()` con una FILA DE CONTROL detrás que comprueba **el estado que
 * ese batch acaba de dejar**. Hace falta porque un `UPDATE` que no casa con
 * ninguna fila NO falla en D1: afecta cero filas, el batch sigue, y el
 * guardado diría que todo fue bien sin haber escrito nada.
 *
 * Aquí eso no es teórico: el control es lo ÚNICO que impide escribir los datos
 * de facturación en la dirección de OTRA clienta. El `UPDATE` lleva
 * `WHERE id = ? AND cliente_id = ?`, no casa con nada, y sin el control la
 * pantalla diría «guardado» con los datos en ningún sitio. Hay una prueba de
 * ese caso; neutralizar el control (dejarlo en `ok = 1` fijo) la pone roja.
 *
 * ## `IS` y no `=`
 *
 * Todas las columnas nuevas son anulables, y en SQL `ciudad = NULL` no es
 * falso: es DESCONOCIDO. Un control que compare con `=` da cero en cuanto
 * alguien deja un campo en blanco —que es el caso normal de esta pantalla— y
 * tumba un guardado perfecto. `IS` sí compara nulos. Es el mismo error que
 * rompió el catálogo, y aquí tenía siete columnas por donde volver a entrar.
 */
export async function editar(
  ctx: Contexto,
  id: string,
  cambios: CambiosEnClienta,
): Promise<Resultado<{ cambiado: boolean }>> {
  // Se lee la identificación que YA hay porque el número y su tipo se miran
  // juntos, más abajo. Lo que NO se comprueba aquí es si la ficha está
  // anonimizada o fusionada: eso lo deciden los controles del batch.
  //
  // Es a propósito. Comprobarlo aquí dejaría los controles vigilando algo que
  // esta función ya había dado por bueno —un control que solo puede pasar no
  // protege nada— y además no cubriría la carrera: entre esta lectura y la
  // escritura caben otra pestaña y un `anonimizar_cliente` entero.
  const actual = await ctx.db
    .prepare("SELECT identificacion, identificacion_tipo FROM clientes WHERE id = ?")
    .bind(id)
    .first<{ identificacion: string | null; identificacion_tipo: string | null }>();
  if (actual === null) return fallo("no_encontrado", "no existe esa clienta");

  // Dos listas con las mismas columnas: una para ASIGNAR y otra para
  // COMPROBAR. Se escriben distinto (`=` contra `IS`) porque son dos cosas
  // distintas que se parecen demasiado.
  const campos: string[] = [];
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const poner = (columna: string, valor: unknown) => {
    campos.push(`${columna} = ?`);
    condiciones.push(`${columna} IS ?`);
    valores.push(valor);
  };

  if (cambios.nombre !== undefined) {
    const nombre = cambios.nombre.trim();
    // El nombre sí puede ser NULL en el esquema —hay fichas que nacen de un
    // pago en la web sin que nadie teclee nada— pero borrarlo A MANO desde el
    // panel deja una ficha que no se vuelve a encontrar: `buscar` va por
    // nombre y por celular, y sin nombre solo queda el número.
    if (nombre === "") {
      return fallo("entrada_invalida", "la clienta necesita un nombre: es como se la encuentra");
    }
    poner("nombre", nombre);
  }
  if (cambios.apellido !== undefined) poner("apellido", vacioEsNulo(cambios.apellido));
  if (cambios.correo !== undefined) poner("correo", vacioEsNulo(cambios.correo));
  if (cambios.notas !== undefined) poner("notas", vacioEsNulo(cambios.notas));

  if (cambios.celular !== undefined) {
    const celular = normalizarCelular(cambios.celular);
    // Tampoco se deja vaciar: el celular es la llave contra los duplicados, y
    // una ficha sin él se vuelve a crear desde cero el día que ella escriba.
    if (celular === null) {
      return fallo("entrada_invalida", "ese celular no se entiende. Escríbalo como 6000-0001");
    }
    poner("celular_e164", celular);
  }

  // El número y su tipo se miran JUNTOS, y contra el estado que QUEDA, no
  // contra lo que viene en el cambio: si la ficha ya tenía cédula y alguien
  // borra solo el tipo, queda un número que nadie sabe leer. En la factura,
  // una cédula y un RUC no son lo mismo.
  let identificacion = actual.identificacion;
  let tipo = actual.identificacion_tipo;
  if (cambios.identificacion !== undefined) {
    identificacion = vacioEsNulo(cambios.identificacion);
    poner("identificacion", identificacion);
  }
  if (cambios.identificacionTipo !== undefined) {
    tipo = vacioEsNulo(cambios.identificacionTipo);
    if (tipo !== null && !esTipoDeIdentificacion(tipo)) {
      return fallo("entrada_invalida", "la identificación es cédula o RUC");
    }
    poner("identificacion_tipo", tipo);
  }
  if ((identificacion === null) !== (tipo === null)) {
    return fallo(
      "entrada_invalida",
      identificacion === null
        ? "escriba el número, o deje en blanco también el tipo"
        : "diga si ese número es cédula o RUC: en la factura no es lo mismo",
    );
  }

  const enunciados: D1PreparedStatement[] = [];

  if (campos.length > 0) {
    enunciados.push(
      ctx.db
        .prepare(
          `UPDATE clientes SET ${campos.join(", ")}, actualizado_en = ?
            WHERE id = ? AND anonimizado_en IS NULL AND fusionado_en_id IS NULL`,
        )
        .bind(...valores, ctx.ahora, id),
      // El control mira el estado YA CAMBIADO, con los MISMOS valores que el
      // UPDATE quería dejar escritos. Comprobar solo que la fila existe no
      // detectaría nada: existe igual cuando el UPDATE no escribió nada.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT COUNT(*) FROM clientes
                          WHERE id = ? AND anonimizado_en IS NULL AND fusionado_en_id IS NULL
                            AND ${condiciones.join(" AND ")}), ?)`,
        )
        .bind(ulid(ctx.ahora), `editar-clienta:${id}`, id, ...valores, ctx.ahora),
    );
  }

  const direccion = cambios.direccion;
  if (direccion !== undefined) {
    const camposD: string[] = [];
    const condicionesD: string[] = [];
    const valoresD: unknown[] = [];
    const ponerD = (columna: string, valor: unknown) => {
      camposD.push(`${columna} = ?`);
      condicionesD.push(`${columna} IS ?`);
      valoresD.push(valor);
    };
    if (direccion.ciudad !== undefined) ponerD("ciudad", vacioEsNulo(direccion.ciudad));
    if (direccion.provinciaIso !== undefined) {
      ponerD("provincia_iso", vacioEsNulo(direccion.provinciaIso));
    }
    if (direccion.codigoPostal !== undefined) {
      ponerD("codigo_postal", vacioEsNulo(direccion.codigoPostal));
    }
    if (direccion.pais !== undefined) ponerD("pais", vacioEsNulo(direccion.pais));

    if (camposD.length > 0) {
      enunciados.push(
        // `cliente_id` en el WHERE: la dirección de otra clienta no se toca
        // desde aquí. Quien lo garantiza es el control de abajo, porque este
        // UPDATE, si no casa con nada, no falla.
        ctx.db
          .prepare(`UPDATE direcciones SET ${camposD.join(", ")} WHERE id = ? AND cliente_id = ?`)
          .bind(...valoresD, direccion.id, id),
        // El JOIN con `clientes` no es decoración: sin él, los datos de
        // facturación de una ficha ANONIMIZADA se podrían volver a llenar sin
        // tocar `clientes` —el UPDATE de arriba no la mira— y una ficha que se
        // borró a petición de la persona volvería a tener dirección.
        ctx.db
          .prepare(
            `INSERT INTO controles (id, regla, ok, creado_en)
             VALUES (?, ?, (SELECT COUNT(*) FROM direcciones d
                              JOIN clientes c ON c.id = d.cliente_id
                            WHERE d.id = ? AND d.cliente_id = ?
                              AND c.anonimizado_en IS NULL AND c.fusionado_en_id IS NULL
                              AND ${condicionesD.map((c) => `d.${c}`).join(" AND ")}), ?)`,
          )
          .bind(
            ulid(ctx.ahora),
            `facturacion-direccion:${direccion.id}`,
            direccion.id,
            id,
            ...valoresD,
            ctx.ahora,
          ),
      );
    }
  }

  // Guardar sin cambiar nada no es un error, pero tampoco se escribe: subir
  // `actualizado_en` por abrir y cerrar la hoja convertiría esa columna en un
  // registro de visitas y dejaría de decir cuándo cambió la ficha de verdad.
  if (enunciados.length === 0) return ok({ cambiado: false });

  try {
    await ctx.db.batch(enunciados);
  } catch {
    return await porQueFallo(ctx, id, cambios);
  }

  return ok({ cambiado: true });
}

/** Las dos razones por las que una ficha no se toca. Cada una con su frase. */
function porQueNoSeToca(fila: {
  anonimizado_en: number | null;
  fusionado_en_id: string | null;
}): Fallo | null {
  if (fila.anonimizado_en !== null) {
    return fallo(
      "transicion_invalida",
      "esta ficha se anonimizó: sus datos se borraron a propósito y no se vuelven a escribir",
    );
  }
  if (fila.fusionado_en_id !== null) {
    return fallo(
      "transicion_invalida",
      "esta ficha se fusionó en otra. Abra la que quedó viva: ahí está su historial",
    );
  }
  return null;
}

/**
 * Por qué se cayó el batch, PREGUNTÁNDOLE a la base.
 *
 * No se lee el texto del error a propósito. Adivinar la redacción de un error
 * ajeno es apostar a que nadie la cambie ni la traduzca, y en SQLite «UNIQUE
 * constraint» y «CHECK constraint» dicen las dos «constraint»: una sola prueba
 * sobre el texto contestaría «repetido» a cualquier cosa y mandaría a buscar un
 * duplicado que no existe.
 *
 * Así que se mira el estado y se contesta por la causa que de verdad está ahí.
 */
async function porQueFallo(
  ctx: Contexto,
  id: string,
  cambios: CambiosEnClienta,
): Promise<Fallo> {
  if (cambios.celular !== undefined) {
    const celular = normalizarCelular(cambios.celular);
    const otra = await ctx.db
      .prepare("SELECT id FROM clientes WHERE celular_e164 = ? AND id <> ?")
      .bind(celular, id)
      .first<{ id: string }>();
    if (otra !== null) {
      return fallo(
        "repetido",
        "ese celular ya es de otra clienta. Búsquela por ese número: puede ser la misma persona con dos fichas",
      );
    }
  }

  if (cambios.direccion !== undefined) {
    const suya = await ctx.db
      .prepare("SELECT id FROM direcciones WHERE id = ? AND cliente_id = ?")
      .bind(cambios.direccion.id, id)
      .first<{ id: string }>();
    if (suya === null) {
      return fallo("no_encontrado", "esa dirección no es de esta clienta");
    }
  }

  const sigue = await ctx.db
    .prepare("SELECT anonimizado_en, fusionado_en_id FROM clientes WHERE id = ?")
    .bind(id)
    .first<{ anonimizado_en: number | null; fusionado_en_id: string | null }>();
  if (sigue === null) return fallo("no_encontrado", "esa clienta ya no está");
  const cerrada = porQueNoSeToca(sigue);
  if (cerrada !== null) return cerrada;

  return fallo("interno", "no se pudo guardar la ficha de la clienta");
}
