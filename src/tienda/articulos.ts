import type {
  Catalogo,
  Disponibilidad,
  ProductoDelSistema,
  VariantePublica,
} from '../hooks/useCatalogo';

/**
 * La tienda, artículo por artículo, para poder buscar y comparar.
 *
 * ## El problema que resuelve
 *
 * Hasta aquí la tienda enseñaba una tarjeta por PRODUCTO con sus
 * presentaciones dentro: «Pañales Nateen» y debajo las seis tallas. Eso
 * funciona para mirar un catálogo pequeño de una sola marca, y deja de
 * funcionar en cuanto hay dos: para comparar la talla M de Nateen con la M de
 * Velvee hay que abrir dos tarjetas, acordarse de un precio y volver. Con $15
 * de diferencia entre las dos, no enseñar esa comparación es dejar la venta en
 * la mesa.
 *
 * Así que la tienda se desagrupa: cada presentación es un artículo con su
 * precio, su marca y su talla, y encima van los filtros. Juntar en el carrito
 * una talla de una marca y otra talla de otra tiene que ser una sola compra —
 * nada de elegir categoría antes de poder añadir.
 *
 * ## Por qué todo esto son funciones puras
 *
 * Para poder probarlas sin navegador. El fallo de «creo un producto y no sale
 * en la tienda» vivió cuatro días porque la regla de qué se enseña estaba
 * metida dentro de un componente, donde una prueba no llega.
 */

export interface ArticuloDeLaTienda {
  readonly codigo: string;
  /** Para `/productos/:slug`. */
  readonly slug: string;
  /** El título del producto en la tienda: «Pañales Nateen». */
  readonly producto: string;
  readonly productoSlug: string;
  readonly marca: string | null;
  readonly familia: string;
  readonly talla: string | null;
  /** «160 uds», ya redactado. `null` si no aplica. */
  readonly unidades: string | null;
  readonly precioCents: number;
  readonly disponibilidad: Disponibilidad;
  readonly foto: string | undefined;
  /** El orden que decidió el panel, para poder volver a él. */
  readonly orden: number;
}

/**
 * Las tallas en el orden del cuerpo de un bebé, no del alfabeto.
 *
 * Ordenadas como texto saldrían «L, M, RN, S, XL, XXL», que no es ningún orden
 * que una mamá reconozca. Lo que no está en la lista va al final, por orden
 * alfabético: así una talla nueva aparece —en un sitio raro, pero aparece— en
 * vez de desaparecer del filtro.
 */
const ORDEN_DE_TALLA = ['RN', 'S', 'M', 'L', 'XL', 'XXL', 'Unitalla'] as const;

export function compararTallas(a: string, b: string): number {
  const ia = ORDEN_DE_TALLA.indexOf(a as (typeof ORDEN_DE_TALLA)[number]);
  const ib = ORDEN_DE_TALLA.indexOf(b as (typeof ORDEN_DE_TALLA)[number]);
  if (ia === -1 && ib === -1) return a.localeCompare(b, 'es');
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

/**
 * El peso de cada estado para ordenar «por existencias».
 *
 * Aquí NO se puede ordenar por cantidad, y no es una limitación que haya que
 * sortear: el sistema no manda la cantidad exacta al navegador a propósito
 * —«la clienta no necesita saber que quedan 3, necesita saber que si lo quiere
 * lo pida ya», y decirlo hacia fuera es regalar el inventario del negocio—.
 * Lo que llega son tres estados, y con tres estados se ordena.
 */
const PESO: Record<Disponibilidad, number> = { disponible: 0, pocas: 1, agotado: 2 };

export type Orden = 'tienda' | 'precio-asc' | 'precio-desc' | 'disponibles' | 'ultimas';

export interface Filtros {
  /** Vacío = todas. NO «ninguna»: un filtro sin marcar no filtra. */
  readonly marcas: readonly string[];
  readonly familias: readonly string[];
  readonly tallas: readonly string[];
  readonly orden: Orden;
}

export const SIN_FILTROS: Filtros = { marcas: [], familias: [], tallas: [], orden: 'tienda' };

/** Aplana el catálogo a artículos sueltos, con la marca y la familia de su producto. */
export function articulosDeLaTienda(
  productos: readonly ProductoDelSistema[],
  catalogo: Catalogo,
  foto: (codigo: string) => string | undefined,
  unidadesDe: (v: VariantePublica | undefined) => { talla: string | null; unidades: string | null },
): ArticuloDeLaTienda[] {
  const porSlug = new Map(productos.map((p) => [p.slug, p]));
  const fuera: ArticuloDeLaTienda[] = [];
  for (const v of catalogo.values()) {
    const p = porSlug.get(v.productoSlug);
    // Una variante sin su producto no se pinta a medias con el nombre en
    // blanco: el catálogo y la lista de productos vienen en el mismo sobre,
    // así que esto solo pasa si alguna vez se sirven de cachés distintas.
    if (p === undefined) continue;
    const puesto = unidadesDe(v);
    fuera.push({
      codigo: v.codigo,
      slug: v.slug,
      producto: p.nombre,
      productoSlug: v.productoSlug,
      marca: p.marca ?? null,
      // Sin familia declarada, «otro»: así cae en un grupo en vez de
      // desaparecer del filtro, que es lo que haría una cadena vacía.
      familia: p.familia === undefined || p.familia === '' ? 'otro' : p.familia,
      talla: v.talla ?? puesto.talla,
      unidades: puesto.unidades,
      precioCents: v.precioCents,
      disponibilidad: v.disponibilidad,
      foto: foto(v.codigo),
      orden: p.orden,
    });
  }
  return fuera;
}

/** Lo que hay para elegir, con cuántos artículos tiene cada opción. */
export interface Opciones {
  readonly marcas: ReadonlyArray<{ valor: string; cuantos: number }>;
  readonly familias: ReadonlyArray<{ valor: string; cuantos: number }>;
  readonly tallas: ReadonlyArray<{ valor: string; cuantos: number }>;
}

/**
 * Las opciones salen de lo que HAY, no de una lista escrita a mano.
 *
 * Una lista escrita a mano es un sitio más que alguien tiene que acordarse de
 * actualizar: el día que la dueña publique una marca nueva, aparecería en la
 * tienda y no en su propio filtro. Saliendo de los artículos, no hay nada que
 * recordar.
 */
export function opcionesDe(articulos: readonly ArticuloDeLaTienda[]): Opciones {
  const cuenta = (
    saca: (a: ArticuloDeLaTienda) => string | null,
    ordena?: (a: string, b: string) => number,
  ) => {
    const m = new Map<string, number>();
    for (const a of articulos) {
      const v = saca(a);
      if (v === null || v === '') continue;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([valor, cuantos]) => ({ valor, cuantos }))
      .sort((x, y) => (ordena ? ordena(x.valor, y.valor) : x.valor.localeCompare(y.valor, 'es')));
  };
  return {
    marcas: cuenta((a) => a.marca),
    familias: cuenta((a) => a.familia),
    tallas: cuenta((a) => a.talla, compararTallas),
  };
}

/**
 * Filtra y ordena.
 *
 * Lo agotado NO se esconde nunca, con ningún orden: se manda al final. Una
 * clienta que busca su talla y no la encuentra se va creyendo que la tienda no
 * la vende; viéndola agotada, pregunta cuándo llega. Y ese «¿cuándo llega?» es
 * la venta de la semana que entra.
 */
export function filtrar(
  articulos: readonly ArticuloDeLaTienda[],
  f: Filtros,
): ArticuloDeLaTienda[] {
  const encaja = (elegidas: readonly string[], valor: string | null) =>
    elegidas.length === 0 || (valor !== null && elegidas.includes(valor));

  const vivos = articulos.filter(
    (a) =>
      encaja(f.marcas, a.marca) && encaja(f.familias, a.familia) && encaja(f.tallas, a.talla),
  );

  const porDefecto = (x: ArticuloDeLaTienda, y: ArticuloDeLaTienda) =>
    x.orden - y.orden ||
    x.producto.localeCompare(y.producto, 'es') ||
    compararTallas(x.talla ?? '', y.talla ?? '') ||
    x.codigo.localeCompare(y.codigo);

  const agotadoAlFinal = (x: ArticuloDeLaTienda, y: ArticuloDeLaTienda) =>
    (x.disponibilidad === 'agotado' ? 1 : 0) - (y.disponibilidad === 'agotado' ? 1 : 0);

  const criterio: Record<Orden, (x: ArticuloDeLaTienda, y: ArticuloDeLaTienda) => number> = {
    tienda: (x, y) => agotadoAlFinal(x, y) || porDefecto(x, y),
    'precio-asc': (x, y) => agotadoAlFinal(x, y) || x.precioCents - y.precioCents || porDefecto(x, y),
    'precio-desc': (x, y) => agotadoAlFinal(x, y) || y.precioCents - x.precioCents || porDefecto(x, y),
    disponibles: (x, y) => PESO[x.disponibilidad] - PESO[y.disponibilidad] || porDefecto(x, y),
    // «Últimas»: lo que se está acabando primero, porque es lo que hay que
    // mover ya. Lo agotado sigue al final: no queda ninguno que mover.
    ultimas: (x, y) =>
      agotadoAlFinal(x, y) ||
      (x.disponibilidad === 'pocas' ? 0 : 1) - (y.disponibilidad === 'pocas' ? 0 : 1) ||
      porDefecto(x, y),
  };

  return [...vivos].sort(criterio[f.orden]);
}
