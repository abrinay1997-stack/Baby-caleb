import { SITE_NAME, type MetaDeRuta } from './rutas';

/**
 * El `<head>` y el JSON-LD de una ficha de producto (F3.7).
 *
 * Vive aquí, junto a `rutas.ts`, y por el mismo motivo: lo leen DOS cosas. El
 * Worker lo escribe en el HTML antes de mandarlo —que es lo único que ven
 * Google y WhatsApp, porque no ejecutan JavaScript— y la página lo vuelve a
 * poner al navegar dentro de la SPA. Si estuviera escrito en dos sitios, el
 * día que alguien cambie uno el enlace compartido diría una cosa y la pestaña
 * otra, y nadie se enteraría hasta que lo notara una clienta.
 *
 * Los textos se arman del CATÁLOGO, no de un archivo: el precio que aparece en
 * la ficha, el que lee Google y el que cotiza el bot salen todos de la misma
 * D1.
 */

export interface VarianteParaFicha {
  readonly codigo: string;
  readonly slug: string;
  readonly nombre: string;
  readonly talla: string | null;
  readonly pesoMinLb: number | null;
  readonly pesoMaxLb: number | null;
  readonly unidadesPorCaja: number;
  readonly precioCents: number;
  readonly disponibilidad: 'disponible' | 'pocas' | 'agotado';
}

/** `5000` da `50.00`: schema.org quiere el número, no el símbolo. */
export const precioPlano = (cents: number): string => (cents / 100).toFixed(2);

/** `5000` da `$50`; `4650` da `$46.50`. */
export const precioLegible = (cents: number): string =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

/** El rango de peso tal como lo pregunta una mamá: en libras. */
export function rangoDePeso(v: VarianteParaFicha): string | null {
  if (v.pesoMinLb === null) return null;
  return v.pesoMaxLb === null
    ? `desde ${v.pesoMinLb} lb`
    : `de ${v.pesoMinLb} a ${v.pesoMaxLb} lb`;
}

export function metaDeProducto(v: VarianteParaFicha): MetaDeRuta {
  const peso = rangoDePeso(v);
  // El nombre del catálogo ya trae la talla y la caja. Se usa tal cual: es el
  // que la dueña ve en su panel, y dos nombres para lo mismo es cómo empiezan
  // las confusiones en un pedido.
  const title = `${v.nombre} | ${SITE_NAME}`;

  const partes = [
    v.talla === null ? null : `Talla ${v.talla}`,
    peso,
    `caja de ${v.unidadesPorCaja}`,
    `${precioLegible(v.precioCents)}`,
  ].filter((p): p is string => p !== null);

  return {
    title,
    description:
      `${partes.join(' · ')}. Pedido por WhatsApp con entrega a domicilio en Ciudad de Panamá.`,
  };
}

/**
 * El JSON-LD `Product` que lee Google.
 *
 * Lo que NO lleva, a propósito:
 *
 *  - **`brand`.** El catálogo guarda un nombre, no una marca. Deducirla del
 *    texto («empieza por Nateen») funciona hasta el día que no, y un dato
 *    estructurado equivocado es peor que uno ausente: Google lo cree.
 *  - **La cantidad exacta.** `availability` dice si hay o no hay. Cuántas
 *    quedan es del negocio y no sale del sistema ni siquiera aquí.
 */
export function jsonLdProducto(v: VarianteParaFicha, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: v.nombre,
    sku: v.codigo,
    ...(v.talla === null ? {} : { size: v.talla }),
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'USD',
      price: precioPlano(v.precioCents),
      availability:
        v.disponibilidad === 'agotado'
          ? 'https://schema.org/OutOfStock'
          : 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: SITE_NAME },
    },
  };
}

/** `/productos/panales-nateen-cierre-nat-m` da `panales-nateen-cierre-nat-m`. */
export function slugDeRuta(camino: string): string | null {
  const m = /^\/productos\/([^/]+)\/?$/.exec(camino);
  return m?.[1] ?? null;
}

/**
 * El enlace corto de una ficha: `/p/<slug>` lleva a `/productos/<slug>`.
 *
 * Existe para compartir por chat. `babycaleb.com/p/nat-m` cabe en un mensaje,
 * se dicta por teléfono sin equivocarse y no se parte en dos líneas; la ruta
 * larga, pegada en WhatsApp junto a un texto, se corta y deja de ser enlace.
 *
 * No hace falta ninguna tabla ni ningún servicio de acortado: el slug YA es el
 * identificador de la ficha, así que esto es un cambio de prefijo y nada más.
 * Un acortador de verdad —con códigos propios— haría falta el día que se
 * quieran contar los clics por campaña, y ese día se añade; hoy sería una
 * tabla que mantener a cambio de nada.
 *
 * Devuelve la ruta de destino, o `null` si no es un enlace corto. No valida el
 * slug: si no existe, la ficha ya sabe decir que no existe, y comprobarlo aquí
 * obligaría a consultar el catálogo en CADA petición para una ruta que casi
 * siempre es buena.
 */
export function rutaCortaDeProducto(camino: string): string | null {
  const m = /^\/p\/([^/]+)\/?$/.exec(camino);
  const slug = m?.[1];
  return slug === undefined || slug === "" ? null : `/productos/${slug}`;
}
