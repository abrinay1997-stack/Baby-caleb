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

  const dice = cargando
    ? 'Un momento…'
    : agregado
      ? 'Agregado'
      : agotado
        ? 'Agotado'
        : lleno
          ? 'Máximo'
          : 'Agregar';

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
          // Donde iría el «+», un punto que late. Dice «todavía no sé si hay»
          // sin afirmar que no hay — que es lo que haría salir el botón
          // apagado y encenderse solo.
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-muted"
          />
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

  if (!sePuede) {
    return (
      <div
        className={`${clases} ${cargando ? '' : 'opacity-60'}`}
        aria-busy={cargando ? true : undefined}
      >
        {contenido}
        <span className="sr-only">{dice}</span>
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
