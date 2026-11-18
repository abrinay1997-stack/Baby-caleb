import { useEffect, useState } from 'react';
import { FotoDeProducto, type Foto } from './FotoDeProducto';

/**
 * La galería de la ficha: la foto grande y, si hay más de una, las miniaturas.
 *
 * ## Por qué existe
 *
 * La clienta nos mandó DOS fotos de cada caja —la de frente y la del dorso, con
 * la tabla de pesos y las unidades— y la ficha solo enseñaba la primera. La
 * segunda es justo la que contesta la pregunta que más llega por WhatsApp
 * («¿esta talla le sirve a mi bebé?»), así que tenerla en el repositorio y no
 * en la pantalla era tenerla en ninguna parte (`docs/TRAMPAS.md` §12).
 *
 * ## Qué decide esta pieza y qué NO
 *
 * No decide qué fotos hay: eso lo decide `fotosDeVariante`, que es el único
 * sitio donde se sabe quién gana entre el sistema y `content.json`. Aquí llega
 * una lista ya resuelta y esto solo la pinta. Con una sola foto se ve
 * exactamente como se veía ayer: ni miniaturas, ni botones, ni nada que tocar.
 *
 * ## Accesibilidad
 *
 * Son `<button>` de verdad, no `<div onClick>`: entran con el tabulador, se
 * activan con Espacio y con Intro, y el aro de foco del sitio (el navy de
 * `@layer base`) se les pone solo. El `aria-pressed` es lo que se oye al
 * activar una: «Ver la foto 2 de 2, pulsado». La diana mide 64 px — la tienda
 * se mide con la WCAG 2.5.8 (24×24 px o separación suficiente), que es su
 * contrato, no con los 44 px del panel (`docs/design-system.md` §7a).
 */
export function GaleriaDeProducto({
  fotos,
  nombre,
}: {
  fotos: readonly Foto[];
  nombre: string;
}) {
  const [activa, setActiva] = useState(0);

  // Cambiar de producto vuelve a la primera. La dependencia es el TEXTO de las
  // rutas y no la lista: la ficha la calcula en cada pintado, así que una
  // dependencia sobre el array se dispararía siempre y la galería no se dejaría
  // cambiar de foto nunca.
  const rutas = fotos.map((f) => f.src).join('|');
  useEffect(() => {
    setActiva(0);
  }, [rutas]);

  if (fotos.length === 0) return null;

  // El efecto de arriba corre DESPUÉS del pintado: en el pintado en que la
  // lista se acorta, `activa` todavía apunta fuera y `fotos[activa]` sería
  // `undefined` — una ficha en blanco. Se recorta aquí, antes de pintar.
  const indice = activa < fotos.length ? activa : 0;
  const actual = fotos[indice];

  const alt =
    fotos.length > 1
      ? `Caja de ${nombre} — foto ${indice + 1} de ${fotos.length}`
      : `Caja de ${nombre}`;

  return (
    <div className="flex flex-col gap-3">
      {/* `aspect-[4/3]`: la MISMA caja que usan las tarjetas del catálogo, y
          por la misma razón — reserva el sitio antes de que la foto llegue.

          Sin ella, en un teléfono (una sola columna: foto arriba, datos debajo)
          la columna de la derecha saltaba 223 px hacia abajo en cuanto cargaba
          la imagen. Medido con la red a 400 kbps: CLS de 0.194 en la ficha, que
          es la pantalla donde se decide la compra — el precio y el botón se
          mueven justo cuando el pulgar va a tocarlos. El umbral de «bien» es
          0.1.

          `object-contain` ya estaba y se queda: las cajas no tienen todas la
          misma proporción y recortarlas para cuadrarlas sería enseñar media
          caja. */}
      <div className="bg-sage/15 border border-line rounded-lg overflow-hidden flex aspect-[4/3] items-center justify-center">
        <FotoDeProducto
          foto={actual}
          alt={alt}
          className="w-full h-full object-contain p-6"
          // Es la imagen más grande de la pantalla y la que decide cuándo se ve
          // «cargada»: se pide antes que el resto.
          loading="eager"
          fetchPriority="high"
        />
      </div>

      {fotos.length > 1 && (
        <ul className="flex flex-wrap gap-2" aria-label={`Fotos de ${nombre}`}>
          {fotos.map((foto, i) => (
            <li key={foto.src}>
              <button
                type="button"
                onClick={() => setActiva(i)}
                aria-pressed={i === indice}
                aria-label={`Ver la foto ${i + 1} de ${fotos.length}`}
                className={`bg-sage/15 block h-16 w-16 md:h-20 md:w-20 cursor-pointer overflow-hidden rounded-md border-2 transition-colors ${
                  i === indice ? 'border-accent-edge' : 'border-line hover:border-accent-edge'
                }`}
              >
                {/* `alt=""`: el nombre lo lleva el botón. Repetirlo aquí haría
                    que un lector de pantalla leyera la misma foto dos veces. */}
                <FotoDeProducto
                  foto={foto}
                  alt=""
                  className="w-full h-full object-contain p-1"
                  // La miniatura usa el MISMO archivo que la grande, así que
                  // pedirla aquí deja la grande ya en la caché del navegador:
                  // tocar una miniatura cambia la foto al instante, sin esperar
                  // ninguna descarga.
                  loading="lazy"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
