/**
 * Buscar un producto para añadirlo a un pedido.
 *
 * Vive aparte de la pantalla porque es lo único de esa hoja que se puede
 * equivocar en silencio: una captura enseña que la lista sale, no que salga la
 * correcta. Y porque quien atiende escribe a toda prisa en un teléfono.
 */

export interface Buscable {
  readonly codigo: string;
  readonly nombre: string;
  readonly talla: string | null;
}

/**
 * Ocho y no más.
 *
 * Pasado eso se vuelve a bajar y subir, que es justo lo que se estaba
 * quitando: la hoja enseñaba el catálogo entero. Cuando hay más, se dice y se
 * pide afinar en vez de alargar la lista.
 */
export const TOPE_RESULTADOS = 8;

/**
 * Sin tildes y sin mayúsculas.
 *
 * Quien toma un pedido por teléfono escribe «panal», no «pañal». Si la eñe
 * dejara el producto fuera, el buscador falla justo cuando más falta hace.
 */
export function sinTildes(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export interface Hallazgo<T> {
  readonly resultados: readonly T[];
  /** Había más de los que caben: se le dice a la persona que afine. */
  readonly hayMas: boolean;
}

/**
 * Los que coinciden, recortados al tope.
 *
 * Con la consulta vacía NO devuelve todo: devuelve nada. Enseñar el catálogo
 * entero es el problema que esto viene a resolver.
 */
export function buscarProductos<T extends Buscable>(
  productos: readonly T[],
  consulta: string,
  tope: number = TOPE_RESULTADOS,
): Hallazgo<T> {
  const aguja = sinTildes(consulta.trim());
  if (aguja === "") return { resultados: [], hayMas: false };

  // El código y la talla se buscan junto al nombre porque son como se
  // distingue una presentación de otra: seis tallas del mismo pañal comparten
  // nombre, y quien atiende suele saber la talla antes que el nombre exacto.
  const coinciden = productos.filter((p) =>
    sinTildes(`${p.nombre} ${p.talla ?? ""} ${p.codigo}`).includes(aguja),
  );

  return { resultados: coinciden.slice(0, tope), hayMas: coinciden.length > tope };
}
