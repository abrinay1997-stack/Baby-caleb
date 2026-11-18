import { useEffect, useState } from 'react';
import type { Catalogo, VariantePublica } from '../hooks/useCatalogo';

/**
 * Qué foto se enseña de un producto, y qué pasa si esa foto no está.
 *
 * ## El problema que resuelve
 *
 * La dueña subía una foto desde su panel y no la veía en la tienda jamás. No
 * era un fallo de la subida: la foto llegaba a R2, quedaba guardada en el
 * sistema y `/foto/<clave>` la servía con un 200. Lo que faltaba era el último
 * eslabón —el catálogo público no llevaba el campo—, así que la tienda seguía
 * pintando la foto de `content.json` como si nada hubiera cambiado. Un panel
 * que promete algo que no pasa es peor que un panel que no lo ofrece.
 *
 * ## Un dato, un solo dueño
 *
 * A partir de aquí la foto es del SISTEMA. La de `content.json` no es una
 * segunda verdad: es el RESPALDO, lo que se enseña mientras no haya foto
 * subida —que hoy es el caso de los doce artículos— y lo que vuelve a salir si
 * la del sistema no carga. No se borra nada de `content.json`: ese archivo es
 * de la clienta y ahí siguen las fotos que lleva el sitio.
 *
 * ## Y si la clave ya no está en R2
 *
 * Una foto se reemplaza subiendo otra, y la anterior se borra de R2 a las 24
 * horas. Una pestaña abierta desde antes, o una copia del catálogo guardada en
 * el borde, pueden quedarse apuntando a la clave vieja. Eso NO puede dejar la
 * ficha con un hueco: cuando el navegador dice que esa imagen no cargó, se
 * pinta la de `content.json`, que es exactamente lo que se veía ayer. Es lo
 * mismo que pasa si el sistema está caído —entonces `/foto/…` contesta 503— y
 * lo que pasa en la auditoría del build, donde no hay sistema ninguno.
 */

/** La foto que se pinta, y la que la releva si esa no carga. */
export interface Foto {
  readonly src: string;
  /** Solo cuando hay DOS: la del sistema primero y esta detrás. */
  readonly respaldo?: string;
}

/** Lo mínimo que estas decisiones necesitan de `content.json`. */
export interface ProductoDeContenido {
  readonly image?: string;
  readonly variants?: readonly { readonly codigo?: string }[];
}

/** `null`, `undefined` y la cadena vacía son lo mismo aquí: no hay foto. */
const noVacia = (imagen: string | null | undefined): string | undefined =>
  typeof imagen === 'string' && imagen.trim() !== '' ? imagen : undefined;

/** Lo que `content.json` guarda de UNA presentación, en materia de fotos. */
export interface FotosDeContenido {
  readonly image?: string;
  /** Las demás de la misma caja. `image` es la primera y no se repite. */
  readonly images?: readonly string[];
}

/**
 * TODAS las fotos de una variante, en el orden en que se enseñan.
 *
 * ## La galería tiene UN dueño, igual que la foto
 *
 * Si el sistema tiene foto subida, la galería es la del sistema — y hoy el
 * sistema guarda UNA por variante, así que es una sola foto y la ficha no
 * pinta miniaturas. Las de `content.json` NO se le cuelgan detrás: son las
 * demás fotos *de la foto del archivo*, y si la dueña subió otra caja desde el
 * panel, la segunda del archivo puede ser de otro producto. Una galería
 * mezclada enseñaría la caja nueva junto a la vieja sin que nadie lo hubiera
 * decidido.
 *
 * La consecuencia hay que decirla en voz alta: **el día que la dueña suba una
 * foto desde el panel, esa variante pasa de dos fotos a una.** Eso no es un
 * fallo de aquí, es que al sistema le falta guardar varias; está apuntado como
 * su propia pieza (con MCP, como todo). Hoy no hay ninguna subida, así que hoy
 * no le quita nada a nadie.
 *
 * Sin foto del sistema, la galería es la del archivo: `image` primero y
 * después `images`, sin vacíos y sin repetidas — una misma ruta dos veces
 * serían dos miniaturas que enseñan lo mismo.
 */
export function fotosDeVariante(
  variante: Pick<VariantePublica, 'imagen'> | undefined,
  deContenido: FotosDeContenido | undefined,
): readonly Foto[] {
  const delArchivo = noVacia(deContenido?.image);

  const sistema = noVacia(variante?.imagen);
  if (sistema !== undefined) return [{ src: sistema, respaldo: delArchivo }];

  const puestas = new Set<string>();
  const galeria: Foto[] = [];
  for (const candidata of [delArchivo, ...(deContenido?.images ?? [])]) {
    const src = noVacia(candidata);
    if (src === undefined || puestas.has(src)) continue;
    puestas.add(src);
    galeria.push({ src });
  }
  return galeria;
}

/**
 * La foto de UNA variante: la del sistema si la hay, la de `content.json` si no.
 *
 * Devuelve `undefined` cuando no hay ninguna de las dos — y entonces no se
 * pinta ninguna caja de imagen, que es como se ha comportado la ficha desde
 * siempre con los productos que no llevan foto.
 */
export function fotoDeVariante(
  variante: Pick<VariantePublica, 'imagen'> | undefined,
  deContenido: string | undefined,
): Foto | undefined {
  // La PRIMERA de la galería, no una segunda regla escrita aparte: si un día
  // cambia quién gana, cambia en un sitio y cambia para las dos.
  return fotosDeVariante(variante, { image: deContenido })[0];
}

/**
 * La foto de una TARJETA del catálogo, que es la de un producto entero.
 *
 * La tarjeta enseña una sola foto y el sistema las guarda por presentación, así
 * que hay que elegir: se usa la primera presentación que tenga foto subida, en
 * el mismo orden en que la tarjeta lista las presentaciones. Así, la dueña que
 * sube la foto de una caja ve cambiar la tarjeta sin tener que subir las seis.
 *
 * El respaldo es el de siempre: la foto del producto en `content.json`.
 */
export function fotoDelProducto(
  producto: ProductoDeContenido,
  catalogo: Catalogo,
): Foto | undefined {
  return fotoPorCodigos(
    (producto.variants ?? []).map((v) => v.codigo),
    catalogo,
    producto.image,
  );
}

/**
 * La misma regla, por códigos sueltos.
 *
 * Existe porque desde que la lista de la tienda la arma el SISTEMA hay
 * productos que no tienen ficha en `content.json` —los que la dueña crea desde
 * el panel— y por tanto no hay un `producto` que pasarle a la función de
 * arriba. La regla es una y vive aquí: la primera presentación con foto subida
 * manda, y si ninguna la tiene se cae a la del archivo, que es lo que se
 * enseñaba ayer.
 *
 * Partirla en dos reglas habría significado que una tarjeta armada por el
 * sistema y la misma tarjeta armada del archivo pudieran enseñar fotos
 * distintas.
 */
export function fotoPorCodigos(
  codigos: readonly (string | undefined)[],
  catalogo: Catalogo,
  respaldo: string | undefined,
): Foto | undefined {
  for (const codigo of codigos) {
    if (codigo === undefined) continue;
    const sistema = noVacia(catalogo.get(codigo)?.imagen);
    if (sistema !== undefined) return { src: sistema, respaldo };
  }
  return respaldo === undefined ? undefined : { src: respaldo };
}

/**
 * El `<img>`, con el relevo ya puesto.
 *
 * No trae estilos propios a propósito: recibe las clases de quien la usa, que
 * son las que ya tenían la ficha y la tarjeta. Una foto que se vea distinta al
 * resto del sitio no es una mejora.
 */
export function FotoDeProducto({
  foto,
  alt,
  className,
  loading,
  fetchPriority,
}: {
  foto: Foto;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
}) {
  const [noCargo, setNoCargo] = useState(false);

  // Cambiar de producto —o de foto— empieza de cero. Sin esto, abrir una ficha
  // cuya foto falló y navegar a otra enseñaría el respaldo de la segunda
  // aunque su foto esté perfecta.
  useEffect(() => {
    setNoCargo(false);
  }, [foto.src]);

  const src = noCargo && foto.respaldo !== undefined ? foto.respaldo : foto.src;

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding="async"
      // Aquí es donde la ficha deja de poder romperse: si la del sistema no
      // está, el navegador avisa y entra la de `content.json`. Si tampoco
      // carga esa, esto se vuelve a llamar y no cambia nada — no hay vuelta
      // atrás infinita porque solo hay dos candidatas.
      onError={() => setNoCargo(true)}
    />
  );
}
