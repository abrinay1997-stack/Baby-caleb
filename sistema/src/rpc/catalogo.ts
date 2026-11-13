import { leerVigentes } from "../db/ajustes";
import { libresSQL } from "../db/inventario";
import { esPendiente } from "../dominio/ajustes";
import { UMBRAL_POCAS, type Disponibilidad, disponibilidad } from "../dominio/existencias";

/**
 * El catálogo que sale del sistema hacia fuera.
 *
 * Una sola función para la web y para el CRM, a propósito: si cada uno armara
 * el suyo, un día dirían cosas distintas del mismo artículo y nadie sabría
 * cuál creer. Eso es justo lo que esta fase existe para terminar.
 *
 * Lo que NUNCA sale de aquí:
 *  - el **costo**, que vive en `valor_inventario` y es interno;
 *  - la **cantidad exacta**, que se vuelve «disponible / pocas / agotado».
 *
 * Lo segundo lo decidió el dueño y está en el CRM desde siempre: la clienta no
 * necesita saber que quedan 3, necesita saber que si lo quiere lo pida ya. Y
 * decir el número exacto hacia fuera es además regalarle a cualquiera el
 * inventario del negocio.
 */

export interface VariantePublica {
  readonly codigo: string;
  readonly slug: string;
  readonly nombre: string;
  readonly talla: string | null;
  readonly pesoMinLb: number | null;
  readonly pesoMaxLb: number | null;
  readonly unidadesPorCaja: number;
  readonly precioCents: number;
  readonly disponibilidad: Disponibilidad;
  /** Solo si se preguntó por una cantidad concreta. */
  readonly pedido?: Cobertura;
}

/**
 * La respuesta a «¿alcanza para 30?».
 *
 * Es la ÚNICA forma en que un número de inventario sale hacia el bot, y solo
 * cuando la respuesta es que NO alcanza: decir «de 30 no, de 25 sí» es la
 * respuesta útil y no hay manera de darla sin el número. Si alcanza, basta un
 * sí — el número sigue sin salir.
 *
 * La regla es del CRM, que ya la tenía pensada así (`cobertura` en
 * `src/tools/catalogQuery.ts`), y se conserva entera al mudar el catálogo
 * aquí.
 *
 * `alcanza` es un sí o un no, y eso puede salir para cada artículo de la
 * respuesta: saber que 30 no alcanza para la L dice «menos de 30» y nada más.
 * `maximoDisponible` ES la cantidad exacta, y por eso sale UNA VEZ por
 * llamada, en el artículo que mejor casa con lo que se buscó — el que la
 * clienta nombró. Con una `cantidad` aplicada a toda la lista, `listarCatalogo`
 * devolvía en una sola llamada el número exacto de cada artículo publicado:
 * el inventario entero, por la puerta pensada para un contraofrecimiento.
 */
export interface Cobertura {
  readonly cantidadPedida: number;
  readonly alcanza: boolean;
  /** Solo cuando NO alcanza, y solo en el mejor acierto: lo máximo que se puede prometer. */
  readonly maximoDisponible?: number;
}

/**
 * Una variante en el catálogo de la WEB: lo de siempre más la decisión del
 * botón de WhatsApp, ya tomada.
 *
 * Es un tipo aparte de `VariantePublica` a propósito. `listar` y `buscar` —las
 * que usa el asistente para contestar un WhatsApp— no necesitan saber nada de
 * botones, y darles el campo obligaría a leer los ajustes en cada turno del
 * asistente para rellenar algo que nadie mira.
 */
export interface VarianteDelCatalogo extends VariantePublica {
  /**
   * Si la web enseña el botón «Pedir por WhatsApp» en este artículo.
   *
   * Llega **ya resuelto**: el navegador no combina nada. Es un booleano y no
   * «el ajuste global más la columna» porque la regla de combinarlos tiene que
   * tener un solo dueño, y ese dueño es `seEnseniaElBoton` de aquí abajo. Con
   * las dos piezas sueltas en el navegador, cambiar la regla exigiría
   * desplegar la web, y un navegador con una versión vieja la combinaría a su
   * manera.
   */
  readonly pedirPorWhatsapp: boolean;
  /**
   * La foto que la dueña subió desde el panel, o `null` si no subió ninguna.
   *
   * **Quién es el dueño de la foto, a partir de aquí.** La tienda pintaba la
   * foto de `content.json` —un archivo del repositorio de la web— y la dueña
   * subía fotos desde el panel que no se veían en ninguna parte: llegaban a
   * R2, quedaban en `variantes.imagen`, `/foto/<clave>` las servía con un 200
   * … y el catálogo público no llevaba el campo, así que la tienda ni se
   * enteraba. Un panel que promete algo que no pasa. Desde hoy la foto del
   * sistema MANDA y la de `content.json` es el respaldo: no son dos verdades,
   * es una verdad y una red.
   *
   * **Es una ruta RELATIVA, y eso no es un detalle.** Puesta como
   * `panel.babycaleb.com/foto/…` la foto subía bien y no se veía nunca: ese
   * dominio está entero detrás de Cloudflare Access, y la CSP del panel es
   * `img-src 'self'`. Dos muros independientes y los dos callados. Relativa,
   * la pide cada dominio al suyo —la tienda a `babycaleb.com/foto/…`, el panel
   * a sí mismo— y las dos la ven. El porqué largo está en `src/index.ts`,
   * sobre la ruta `/foto/*`.
   *
   * Va en `VarianteDelCatalogo` y no en `VariantePublica` por lo mismo que
   * `pedirPorWhatsapp`: el asistente contesta WhatsApps con texto y una ruta
   * de imagen no le sirve para nada. Lo que por MCP sí hace falta —«¿a qué
   * artículos les falta foto?»— es otra pregunta y se contesta sobre
   * `variantes.imagen`, no sobre este campo. Ver `rpc/web.ts`.
   */
  readonly imagen: string | null;
}

export interface CatalogoPublico {
  /** La versión más alta del catálogo: cambia cuando cambia cualquier variante. */
  readonly version: number;
  readonly generadoEn: number;
  readonly variantes: VarianteDelCatalogo[];
  /**
   * A qué celular van los pedidos por WhatsApp. `null` = no hay ninguno.
   *
   * Sale del ajuste `whatsapp_numero` y no de una constante en el código: es un
   * dato del negocio y cambia cuando la dueña cambia de celular, sin desplegar
   * nada. Con `null`, ninguna variante trae `pedirPorWhatsapp` en `true`.
   */
  readonly whatsapp: { readonly numero: string | null };
}

interface Fila {
  codigo: string;
  slug_producto: string;
  nombre: string;
  talla: string | null;
  peso_min_lb: number | null;
  peso_max_lb: number | null;
  unidades_por_caja: number;
  precio_cents: number;
  version: number;
  libres: number | null;
  /** `null` = «lo que diga Ajustes». Ver `migrations/0013`. */
  pedir_por_whatsapp?: number | null;
  /** `/foto/<clave>` si tiene foto subida; `null` si no. Ver `fotoPublica`. */
  imagen?: string | null;
}

// ---------------------------------------------------------------------------
// El botón de WhatsApp: las dos decisiones, combinadas en UN sitio
// ---------------------------------------------------------------------------

/** Lo que el negocio ha decidido sobre pedir por WhatsApp, en global. */
export interface WhatsappDelNegocio {
  /** El ajuste `whatsapp_pedidos_activo`. */
  readonly activo: boolean;
  /** El ajuste `whatsapp_numero`, o `null` si está sin decidir. */
  readonly numero: string | null;
}

/** Con el ajuste sin leer, apagado. Un botón que no se sabe no se enseña. */
const WHATSAPP_APAGADO: WhatsappDelNegocio = { activo: false, numero: null };

/**
 * ¿Se enseña el botón en ESTE artículo?
 *
 * Las tres condiciones, y las tres hacen falta:
 *
 *  1. el negocio deja pedir por WhatsApp (`whatsapp_pedidos_activo`);
 *  2. hay un celular puesto (`whatsapp_numero`);
 *  3. este artículo no lo tiene apagado en su ficha (`pedir_por_whatsapp`).
 *
 * El nulo de la columna es «lo que diga Ajustes», así que NO apaga nada. Y un
 * `1` en la columna tampoco ENCIENDE nada por su cuenta: si pudiera saltarse
 * el ajuste global, apagar WhatsApp en Ajustes —lo que la dueña haría si pierde
 * el celular— dejaría botones vivos apuntando a un número que ya no contesta.
 * El porqué largo está en `migrations/0013_whatsapp_por_variante.sql`.
 */
export function seEnseniaElBoton(
  negocio: WhatsappDelNegocio,
  pedirPorWhatsapp: number | null | undefined,
): boolean {
  if (!negocio.activo) return false;
  if (negocio.numero === null) return false;
  return pedirPorWhatsapp !== 0;
}

/**
 * Qué cuenta como un celular usable, de lo que haya guardado.
 *
 * Está aparte y exportada por una razón concreta: es la única de las guardas de
 * este bloque que hoy NO se puede alcanzar desde `whatsappDelNegocio`, porque
 * `whatsapp_numero` no admite quedarse sin decidir y `leerVigentes` ya rechaza
 * lo que no sea un número. O sea que una mutación aquí sobrevivía a las pruebas
 * —comprobado— y eso es una guarda que no defiende nada (trampa §1).
 *
 * Sigue estando porque el día que alguien le ponga `admitePendiente: true` a
 * esa clave, lo guardado sería la palabra «PENDIENTE» y el botón apuntaría a
 * `wa.me/PENDIENTE`. Así que se prueba por abajo, directamente, que es lo que
 * manda la trampa §6 cuando una guarda queda detrás de otra capa.
 */
export function numeroUsable(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  // «PENDIENTE» es «falta decidirlo», no un número. Tratarlo como «no hay
  // número» es lo único honesto que se puede hacer con él: deja el botón
  // fuera, que es mejor que mandar a nadie.
  if (esPendiente(valor)) return null;
  const limpio = valor.trim();
  return limpio === "" ? null : limpio;
}

/**
 * Lee del negocio las dos reglas de WhatsApp.
 *
 * Pasa por `leerVigentes` y no por una consulta propia a `ajustes` para no
 * tener dos dueños de «cuánto vale un ajuste ahora mismo»: ahí viven la caída
 * al valor de fábrica y la regla de que un valor guardado que hoy no se
 * entiende NO se usa. Una segunda consulta se las saltaría sin que nada
 * fallara.
 */
export async function whatsappDelNegocio(
  db: D1Database,
  ahora: number,
): Promise<WhatsappDelNegocio> {
  const r = await leerVigentes({ db, ahora });
  if (!r.ok) return WHATSAPP_APAGADO;

  const de = (clave: string): unknown => r.datos.ajustes.find((a) => a.clave === clave)?.valor;

  return {
    activo: de("whatsapp_pedidos_activo") === true,
    numero: numeroUsable(de("whatsapp_numero")),
  };
}

// ---------------------------------------------------------------------------
// La foto: qué forma tiene que tener para salir hacia un navegador
// ---------------------------------------------------------------------------

/**
 * Con qué empieza una ruta de foto, aquí y en la web.
 *
 * Lo escribe el panel al subirla (`PUT /catalogo/variantes/:codigo/foto`), lo
 * sirve esta misma aplicación en `/foto/*` y lo sirve la web en
 * `worker/imagenes.ts`, donde la constante se llama `PREFIJO`. Son tres sitios
 * para un prefijo, así que hay una prueba de la web
 * (`test/la-foto-del-sistema.test.ts`) que los compara: cambiar uno sin el
 * otro deja todas las fotos en 404, que es exactamente lo que pasó la vez que
 * se eligió `/img/`.
 */
export const PREFIJO_FOTO = "/foto/";

/**
 * Lo que puede salir de `variantes.imagen` hacia un navegador: nada, o una
 * ruta relativa que la tienda pueda pedirle a su propio dominio.
 *
 * Tres filtros, y cada uno tapa un agujero que ya se vio en este repositorio:
 *
 *  1. **Tiene que empezar por `/foto/`.** Eso excluye de una vez cualquier
 *     cosa absoluta (`https://…`) y cualquier cosa de otro origen (`//otro`,
 *     que el navegador lee como «el mismo esquema, otro dominio»). Una foto
 *     apuntada a `panel.babycaleb.com` subía bien y no se veía JAMÁS: Access
 *     delante y la CSP del panel detrás. Si el valor guardado no es relativo,
 *     la tienda no lo enseña — enseña la de `content.json`, que es lo que
 *     enseñaba ayer.
 *  2. **Tiene que haber algo DETRÁS del prefijo.** `/foto/` a secas no es una
 *     foto: es un enlace a la lista de nada. `leerPublico` lo rechazaría, pero
 *     para entonces el navegador ya habría pedido y ya habría roto el hueco.
 *  3. **Y tiene que caber.** `SistemaWeb.archivo` rechaza una clave de más de
 *     512 caracteres, así que una más larga es un 404 asegurado. Prometer una
 *     foto que el único que la sirve va a rechazar es prometer un hueco.
 *
 * Lo que NO decide esta función es si esa clave existe o si se puede servir en
 * abierto: eso es de `leerPublico`, del lado de los datos, porque en ese
 * bucket viven también los comprobantes de pago de las clientas. Aquí solo se
 * decide la FORMA.
 *
 * `/img/…` —la forma que anticipaba el comentario de `migrations/0001`— se
 * queda fuera a propósito: esos archivos viven en el paquete de la web y su
 * dueño es `content.json`. Dejarlos salir por aquí sería crear un segundo
 * dueño de la misma ruta, que es justo lo que este cambio viene a terminar.
 */
export function fotoPublica(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  if (!limpio.startsWith(PREFIJO_FOTO)) return null;
  const clave = limpio.slice(PREFIJO_FOTO.length);
  if (clave === "" || clave.length > 512) return null;
  return limpio;
}

/**
 * `publicado = 1` es el interruptor de lo que se ve fuera.
 *
 * Un artículo activo pero sin publicar existe en el panel y no en la web: es lo
 * que permite cargar el catálogo a medias, o retirar algo de la venta sin
 * borrar su historia.
 */
const CONSULTA = `
  SELECT v.codigo, p.slug AS slug_producto, v.nombre, v.talla,
         v.peso_min_lb, v.peso_max_lb, v.unidades_por_caja, v.precio_cents, v.version,
         v.pedir_por_whatsapp, v.imagen,
         -- La regla del combo tiene UN dueño: libresSQL en src/db/inventario.ts,
         -- que es la misma expresión que usan las herramientas del asistente.
         ${libresSQL("v")} AS libres
  FROM variantes v
  JOIN productos p ON p.id = v.producto_id
  WHERE v.activo = 1 AND v.publicado = 1 AND p.activo = 1`;

/**
 * `conNumero` decide si este artículo puede soltar `maximoDisponible`.
 *
 * Se pasa explícito y por artículo, no se deduce: es el único interruptor de la
 * cantidad exacta y tiene que verse en el sitio donde se decide.
 */
function aPublica(f: Fila, cantidad?: number, conNumero = false): VariantePublica {
  // Aguas arriba `normalizarCantidad` ya rechaza un 0, un negativo o un
  // decimal: si algo así llega hasta aquí es un error de programación, no una
  // entrada mala. Y el error de programación que ya pasó una vez fue
  // `results.map(aPublica)`, que cuela el índice del array como cantidad y
  // hace que la cantidad exacta de inventario salga hacia fuera. Reventar
  // aquí convierte esa fuga silenciosa en una prueba roja.
  if (cantidad !== undefined && (!Number.isSafeInteger(cantidad) || cantidad < 1)) {
    throw new Error(`aPublica: cantidad inválida (${cantidad}) — ¿se pasó aPublica a .map()?`);
  }

  const libres = f.libres ?? 0;
  return {
    ...(cantidad === undefined
      ? {}
      : {
          pedido:
            libres >= cantidad
              ? { cantidadPedida: cantidad, alcanza: true }
              : // El sí o el no siempre; el número exacto solo donde se
                // autorizó. Sin `conNumero`, el bot se queda con «no alcanza
                // para 30», que es verdad y no es el inventario.
                {
                  cantidadPedida: cantidad,
                  alcanza: false,
                  ...(conNumero ? { maximoDisponible: libres } : {}),
                },
        }),
    codigo: f.codigo,
    // El slug del producto más el código: la web necesita una URL por variante
    // y dos tallas del mismo producto comparten el slug del producto.
    slug: `${f.slug_producto}-${f.codigo.toLowerCase()}`,
    nombre: f.nombre,
    talla: f.talla,
    pesoMinLb: f.peso_min_lb,
    pesoMaxLb: f.peso_max_lb,
    unidadesPorCaja: f.unidades_por_caja,
    precioCents: f.precio_cents,
    // `libres` es NULL si la variante no tiene ninguna fila de existencias: eso
    // es agotado, no «no se sabe». `?? 0` lo dice sin rodeos.
    disponibilidad: disponibilidad(libres, UMBRAL_POCAS),
  };
}

export async function catalogoPublico(db: D1Database, ahora: number): Promise<CatalogoPublico> {
  const [{ results }, negocio] = await Promise.all([
    db.prepare(`${CONSULTA} ORDER BY p.orden, p.nombre, v.talla, v.codigo`).all<Fila>(),
    whatsappDelNegocio(db, ahora),
  ]);

  return {
    whatsapp: { numero: negocio.numero },
    // La versión más alta de las variantes publicadas. La web la usa para
    // saber si su copia sirve todavía sin comparar el catálogo entero.
    version: results.reduce((maxima, f) => Math.max(maxima, f.version), 0),
    generadoEn: ahora,
    // `results.map(aPublica)` NO: `Array.prototype.map` pasa
    // `(elemento, indice, array)`, así que el índice se colaba como
    // `cantidad` y la variante de la posición i con menos de i libres salía
    // con `maximoDisponible` —la cantidad exacta— hacia el navegador.
    variantes: results.map((f) => ({
      ...aPublica(f),
      pedirPorWhatsapp: seEnseniaElBoton(negocio, f.pedir_por_whatsapp),
      // La foto sale por la MISMA puerta que el precio, y no por una segunda
      // consulta: la pieza que decidía qué ve la tienda tiene un solo dueño y
      // es esta función (trampa §12 — una pieza que nadie llama, y su
      // contraria: dos piezas que dicen lo mismo y se separan).
      imagen: fotoPublica(f.imagen),
    })),
  };
}

/**
 * El catálogo entero.
 *
 * Con una `cantidad` contesta «¿alcanza para 30?» de cada artículo con un sí o
 * un no, y de NINGUNO suelta el número: una lista completa no es la pregunta de
 * una clienta por un artículo, y aquí estaba la fuga —una sola llamada con una
 * cantidad absurda devolvía el inventario exacto de todo lo publicado—.
 */
export async function listar(db: D1Database, cantidad?: number): Promise<VariantePublica[]> {
  const { results } = await db
    .prepare(`${CONSULTA} ORDER BY p.orden, p.nombre, v.talla, v.codigo`)
    .all<Fila>();
  return results.map((f) => aPublica(f, cantidad, false));
}

/**
 * Buscar como busca una clienta.
 *
 * No es una búsqueda por parecido: es LIKE sobre el nombre, el código y la
 * talla. Un catálogo de doce artículos no necesita más, y lo que sí necesita
 * es ser predecible — con búsqueda por parecido, «M» puede devolver XL.
 */
export async function buscar(
  db: D1Database,
  q: string,
  limite = 20,
  cantidad?: number,
): Promise<VariantePublica[]> {
  const texto = q.trim();
  if (texto === "") return await listar(db, cantidad);

  const tope = Math.min(Math.max(Math.trunc(limite), 1), 100);

  // `%` y `_` son los comodines de LIKE: sin quitarlos, quien escribe «%»
  // recibe el catálogo entero como si fuera un acierto. Y si al quitarlos no
  // queda nada que buscar, eso ES una búsqueda vacía —devolver todo con cara
  // de resultado sería peor que decirlo.
  const limpio = texto.replaceAll("%", "").replaceAll("_", "").trim();
  if (limpio === "") return await listar(db, cantidad);
  const como = `%${limpio}%`;

  const { results } = await db
    .prepare(
      `${CONSULTA}
         AND (v.nombre LIKE ?1 COLLATE NOCASE
              OR v.codigo LIKE ?1 COLLATE NOCASE
              OR p.nombre LIKE ?1 COLLATE NOCASE)
       ORDER BY
         -- Lo que empieza por lo buscado va antes que lo que solo lo contiene:
         -- quien escribe «NAT-M» espera NAT-M y no «... compatible con NAT-M».
         CASE WHEN v.codigo LIKE ?2 COLLATE NOCASE THEN 0 ELSE 1 END,
         p.orden, p.nombre, v.talla, v.codigo
       LIMIT ?3`,
    )
    .bind(como, `${limpio}%`, tope)
    .all<Fila>();

  // El número exacto, solo en el primero. El ORDER BY de arriba pone delante lo
  // que EMPIEZA por lo buscado, así que el primero es el artículo del que se
  // preguntó; el resto se lleva el sí o el no y nada más.
  return results.map((f, i) => aPublica(f, cantidad, i === 0));
}
