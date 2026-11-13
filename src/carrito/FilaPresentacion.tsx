import { useEffect, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { dolares, type VariantePublica } from '../hooks/useCatalogo';
import { useCarrito } from './useCarrito';
import { MAXIMO_POR_LINEA } from './carrito';

/**
 * Una presentación del catálogo, que se toca para agregarla.
 *
 * LA FILA ENTERA ES EL BOTÓN, y no un «+» al lado. En un teléfono un icono de
 * 44 px dentro de una fila de 30 obligaría a estirar la fila igual, y una
 * diana del ancho de la tarjeta se acierta sin mirar. El «+» se queda como
 * señal de que se puede tocar, no como el sitio al que hay que apuntar.
 *
 * CUATRO ESTADOS, Y EL QUE IMPORTA ES EL PRIMERO
 *
 *  1. `cargando` — todavía no sabemos si hay existencias. Dice «un momento» y
 *     no se deja tocar.
 *  2. `agotado` — no se puede agregar, y lo dice.
 *  3. normal — «Agregar».
 *  4. recién agregado — lo confirma dos segundos.
 *
 * El primero existe por un detalle feo: la copia del catálogo que viaja en el
 * build trae las doce variantes en `agotado`, así que entre la primera pintada
 * y la respuesta del sistema la página diría que no hay nada. Sin este estado
 * el botón saldría apagado y se encendería solo — y quien lo tocó en medio ve
 * que no pasa nada y lo vuelve a tocar, que es justo lo que no queremos.
 */

const AVISO_MS = 2000;

/**
 * La palabra que explica por qué una fila está como está.
 *
 * ## Por qué es una función exportada y no un ternario dentro del JSX
 *
 * Por lo mismo que `mensajeDePedido` en `PedirPorWhatsapp.tsx`: dentro del JSX
 * haría falta un navegador para leerla, y las pruebas de la web corren en
 * Node. Lo que hay que vigilar aquí no es cómo se pinta la fila — es que
 * ninguna combinación acabe diciendo algo falso.
 *
 * ## Qué pasó cuando esto vivía escondido
 *
 * La palabra estaba en un `sr-only`, así que una rama equivocada no la veía
 * nadie. Al sacarla a la vista salió el hueco: una presentación cuyo código no
 * está en el catálogo —retirada, o con el código cambiado— caía en la última
 * rama y la fila decía **«Agregar»** sin dejarse tocar. Es la peor respuesta
 * posible: invita a hacer justo lo que no va a funcionar.
 *
 * ## El orden importa, y este es el orden
 *
 * 1. `cargando` manda sobre todo: mientras no se sabe, no se afirma nada.
 * 2. `agregado` es el acuse de lo que la persona acaba de hacer.
 * 3. **Estar en el catálogo** va antes que «agotado»: sin ficha en el
 *    catálogo no sabemos si hay existencias, y decir «Agotado» sería afirmar
 *    algo que nadie ha comprobado (`docs/TRAMPAS.md` §7: el cero no es «no sé»).
 * 4. Agotado, lleno, y por fin «Agregar».
 *
 * «Pregúntanos» y no «Consultar»: el precio de esa misma fila ya dice
 * «Consultar» cuando no hay ficha, y las dos juntas se leían
 * «ConsultarConsultar». La palabra del estado dice qué HACER.
 */
export function motivoDeLaFila({
  cargando,
  agregado,
  enElCatalogo,
  agotado,
  lleno,
}: {
  readonly cargando: boolean;
  readonly agregado: boolean;
  /** `false` si el código de esta presentación no está en el catálogo. */
  readonly enElCatalogo: boolean;
  readonly agotado: boolean;
  readonly lleno: boolean;
}): string {
  if (cargando) return 'Un momento…';
  if (agregado) return 'Agregado';
  if (!enElCatalogo) return 'Pregúntanos';
  if (agotado) return 'Agotado';
  if (lleno) return 'Máximo';
  return 'Agregar';
}

export function FilaPresentacion({
  codigo,
  talla,
  unidades,
  variante,
  cargando,
}: {
  readonly codigo: string | undefined;
  readonly talla: string;
  readonly unidades: string;
  /** Del catálogo. `undefined` mientras carga o si el código no existe. */
  readonly variante: VariantePublica | undefined;
  readonly cargando: boolean;
}) {
  const { agregar, carrito } = useCarrito();
  const [agregado, setAgregado] = useState(false);

  useEffect(() => {
    if (!agregado) return;
    const t = window.setTimeout(() => setAgregado(false), AVISO_MS);
    return () => window.clearTimeout(t);
  }, [agregado]);

  const yaLleva = codigo === undefined ? 0 : carrito.lineas.find((l) => l.codigo === codigo)?.cantidad ?? 0;
  const agotado = variante?.disponibilidad === 'agotado';
  const lleno = yaLleva >= MAXIMO_POR_LINEA;
  // Sin código no hay nada que agregar: esa presentación no está en el
  // catálogo del sistema y no vamos a inventarle uno.
  const sePuede = !cargando && codigo !== undefined && variante !== undefined && !agotado && !lleno;

  /**
   * El precio se enseña SIEMPRE, también mientras carga.
   *
   * De la copia del build el precio es bueno —se regenera en cada despliegue—
   * y la tarjeta ya lo usa arriba para el «Desde $X». Lo único que esa copia
   * no sabe es la DISPONIBILIDAD, porque el stock cambia cada día. Así que se
   * aprovecha lo que sirve y se calla lo que no: el precio sale, y el botón
   * espera a saber si hay existencias.
   *
   * Taparlo también mientras carga era más coherente a primera vista y peor:
   * escondía un dato bueno y dejaba la tarjeta diciendo «$45» arriba y nada
   * abajo.
   */
  const precio = variante === undefined ? 'Consultar' : dolares(variante.precioCents);

  const dice = motivoDeLaFila({ cargando, agregado, enElCatalogo: variante !== undefined, agotado, lleno });

  const contenido = (
    <>
      <span className="min-w-0 text-left">
        <span className="font-bold text-fg">{talla}</span>
        <span className="text-muted"> · {unidades}</span>
        {yaLleva > 0 ? (
          <span className="text-accent-strong"> · {yaLleva} en tu carrito</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="font-bold text-accent-strong tabular-nums">{precio}</span>
        {cargando ? (
          // Nada: donde iría el «+» va la palabra «Un momento…», que la pinta
          // la rama de abajo. Aquí hubo un punto que latía, y con la palabra
          // delante eran dos señales de lo mismo en una fila de 390 px — y una
          // de las dos, la que de verdad se entiende, llegaba segunda.
          null
        ) : agregado ? (
          <Check className="h-4 w-4 text-accent-strong" aria-hidden="true" />
        ) : sePuede ? (
          <Plus className="h-4 w-4 text-muted" aria-hidden="true" />
        ) : null}
      </span>
    </>
  );

  const clases =
    'flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-xs transition-colors';

  /**
   * LA FILA QUE NO SE PUEDE TOCAR DICE POR QUÉ, Y LO DICE A LA VISTA.
   *
   * Antes esta rama hacía dos cosas mal a la vez, y las dos se midieron:
   *
   *  1. `opacity-60` sobre toda la fila dejaba el texto en 2.35, 2.39 y 3.73
   *     contra el mínimo de 4.5 de AA. La auditoría de contraste no lo veía
   *     porque no aplicaba la opacidad de los ancestros; axe sí.
   *  2. La palabra —«Agotado», «Máximo», «Un momento…»— vivía en un
   *     `sr-only`. O sea: quien usa lector de pantalla se enteraba y quien
   *     MIRA la pantalla, no. Veía una fila apagada, sin el «+», y sin nada
   *     que explicara si no hay existencias, si ya llenó el máximo o si la
   *     página todavía está cargando. Eso es comunicar con el color —aquí,
   *     con la opacidad— y nada más, que es WCAG 1.4.1.
   *
   * Ahora el motivo se escribe donde iba el «+»: en el mismo sitio donde la
   * fila que sí se puede tocar pone su señal de que se puede tocar. El texto
   * se queda a plena fuerza; lo que baja de tono es el borde y el fondo, que
   * no llevan información.
   */
  if (!sePuede) {
    return (
      <div
        className={`${clases} ${cargando ? '' : 'border-dashed bg-surface'}`}
        aria-busy={cargando ? true : undefined}
      >
        {contenido}
        <span className="shrink-0 font-bold text-muted">{dice}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        agregar(codigo);
        setAgregado(true);
      }}
      aria-label={`Agregar ${talla}, ${unidades}, ${precio}`}
      className={`${clases} hover:border-accent-edge hover:bg-surface focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2`}
    >
      {contenido}
    </button>
  );
}
