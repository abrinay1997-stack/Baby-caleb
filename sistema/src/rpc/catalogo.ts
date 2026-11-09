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
         (SELECT SUM(e.fisico - e.reservado) FROM existencias e WHERE e.codigo = v.codigo) AS libres
  FROM variantes v
  JOIN productos p ON p.id = v.producto_id
  WHERE v.activo = 1 AND v.publicado = 1 AND p.activo = 1`;

function aPublica(f: Fila): VariantePublica {
  return {
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
    disponibilidad: disponibilidad(f.libres ?? 0, UMBRAL_POCAS),
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
    variantes: results.map(aPublica),
  };
}

export async function listar(db: D1Database): Promise<VariantePublica[]> {
  const { results } = await db
    .prepare(`${CONSULTA} ORDER BY p.orden, p.nombre, v.talla, v.codigo`)
    .all<Fila>();
  return results.map(aPublica);
}

/**
 * Buscar como busca una clienta.
 *
 * No es una búsqueda por parecido: es LIKE sobre el nombre, el código y la
 * talla. Un catálogo de doce artículos no necesita más, y lo que sí necesita
 * es ser predecible — con búsqueda por parecido, «M» puede devolver XL.
 */
export async function buscar(db: D1Database, q: string, limite = 20): Promise<VariantePublica[]> {
  const texto = q.trim();
  if (texto === "") return await listar(db);

  const tope = Math.min(Math.max(Math.trunc(limite), 1), 100);

  // `%` y `_` son los comodines de LIKE: sin quitarlos, quien escribe «%»
  // recibe el catálogo entero como si fuera un acierto. Y si al quitarlos no
  // queda nada que buscar, eso ES una búsqueda vacía —devolver todo con cara
  // de resultado sería peor que decirlo.
  const limpio = texto.replaceAll("%", "").replaceAll("_", "").trim();
  if (limpio === "") return await listar(db);
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

  return results.map(aPublica);
}
