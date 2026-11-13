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
const delSistema = (imagen: string | null | undefined): string | undefined =>
  typeof imagen === 'string' && imagen.trim() !== '' ? imagen : undefined;

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
  const sistema = delSistema(variante?.imagen);
  if (sistema !== undefined) return { src: sistema, respaldo: deContenido };
  return deContenido === undefined ? undefined : { src: deContenido };
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
  for (const v of producto.variants ?? []) {
    if (v.codigo === undefined) continue;
    const sistema = delSistema(catalogo.get(v.codigo)?.imagen);
    if (sistema !== undefined) return { src: sistema, respaldo: producto.image };
  }
  return producto.image === undefined ? undefined : { src: producto.image };
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
