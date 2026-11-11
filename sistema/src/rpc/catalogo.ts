import { libresSQL } from "../db/inventario";
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

export interface CatalogoPublico {
  /** La versión más alta del catálogo: cambia cuando cambia cualquier variante. */
  readonly version: number;
  readonly generadoEn: number;
  readonly variantes: VariantePublica[];
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
  const { results } = await db
    .prepare(`${CONSULTA} ORDER BY p.orden, p.nombre, v.talla, v.codigo`)
    .all<Fila>();

  return {
    // La versión más alta de las variantes publicadas. La web la usa para
    // saber si su copia sirve todavía sin comparar el catálogo entero.
    version: results.reduce((maxima, f) => Math.max(maxima, f.version), 0),
    generadoEn: ahora,
    // `results.map(aPublica)` NO: `Array.prototype.map` pasa
    // `(elemento, indice, array)`, así que el índice se colaba como
    // `cantidad` y la variante de la posición i con menos de i libres salía
    // con `maximoDisponible` —la cantidad exacta— hacia el navegador.
    variantes: results.map((f) => aPublica(f)),
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
