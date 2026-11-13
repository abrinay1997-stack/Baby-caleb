import { Link } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { Button, buttonVariants } from '../components/ui/Button';
import { useCatalogo, dolares, type VariantePublica } from '../hooks/useCatalogo';
import { useCarrito } from '../carrito/useCarrito';
import { MAXIMO_POR_LINEA } from '../carrito/carrito';
import { whatsappCon } from '../data/contacto';

/**
 * El título y la descripción, pasados a mano.
 *
 * `/carrito` no está en `seo/rutas.ts` y no debe estarlo: esa lista es de las
 * siete páginas públicas, y el carrito está en `SIN_INDEXAR` porque es de una
 * persona, no del público.
 *
 * Pero `Seo` con una ruta que no conoce no hace NADA —ni siquiera cambiar el
 * título—, así que al llegar aquí desde otra página la pestaña seguiría
 * diciendo «Preguntas frecuentes». Se le pasa el texto por la misma vía que
 * usan las fichas de producto, que existe justo para esto.
 */
const META = {
  title: 'Tu carrito | Baby Caleb Panamá',
  description: 'Los productos que has ido agregando, listos para enviarnos tu pedido.',
};

/**
 * El carrito: `/carrito`.
 *
 * QUÉ ES ESTA PANTALLA Y QUÉ NO ES, HOY
 *
 * Hoy Baby Caleb **no puede cobrar en línea**: los trámites de las pasarelas
 * están en curso y `pasarelas_activas` está vacío a propósito. Así que este
 * carrito no termina en un cobro: termina en un mensaje de WhatsApp con la
 * lista ya escrita.
 *
 * Eso no es un carrito a medias, es lo que de verdad sirve hoy. Lo que hace la
 * clienta ahora mismo es escribir a mano «quiero dos de los de talla M» y
 * esperar a que alguien adivine cuál era; esto manda códigos exactos y
 * cantidades exactas.
 *
 * ## `checkout_activo` NO hace nada aquí, y conviene decirlo
 *
 * Este comentario decía antes que «el día que la dueña active `checkout_activo`
 * desde el panel, el final de esta misma pantalla pasa a crear el pedido en el
 * sistema». No es verdad, y durante meses nadie lo notó: esta pantalla no
 * consulta ese ajuste por ningún lado, así que encenderlo no cambia una línea
 * de lo que pasa aquí. En producción vale `true` desde hace tiempo y el
 * carrito sigue terminando en WhatsApp.
 *
 * Lo que sí hace falta, en este orden, está escrito en el panel: una pasarela
 * con sus credenciales y encendida (hoy hay **tres pasarelas y cero
 * credenciales**), y después programar aquí el paso de crear el pedido y
 * mandar a pagar. Mientras ese paso no exista, el ajuste no puede encenderlo
 * — y la pantalla de Ajustes del panel lo dice con esas palabras en vez de
 * enseñar un «Encendido» que no significa nada.
 *
 * Quien programe ese paso: la constante `LA_WEB_TIENE_CHECKOUT` de
 * `sistema/src/dominio/checkout.ts` declara que este archivo todavía no cobra,
 * y `sistema/test/node/checkout-de-la-web.test.ts` lee ESTE archivo y se pone
 * rojo si las dos cosas dejan de coincidir. O sea: al añadir aquí la llamada,
 * la prueba avisa de que hay que cambiar la constante.
 *
 * LOS PRECIOS DE ESTA PANTALLA SON PARA ORIENTARSE
 *
 * Salen del catálogo (D1, a través de `/api/catalogo`) y se calculan al
 * pintar, pero **no son el total que se cobra**: al pedido le falta el envío
 * por zona y el ITBMS por línea, que los calcula el servidor. Por eso el
 * subtotal dice lo que es, en vez de parecer una factura. Y por eso el mensaje
 * de WhatsApp NO lleva precios: un precio en ese mensaje es una promesa, y el
 * precio lo pone el catálogo en el momento de cerrar, no el navegador hace
 * media hora.
 *
 * LA VOZ: esta página TUTEA, como el resto del sitio («Haz tu pedido», «te
 * avisamos»). El «usted» es del bot de atención, no de la web. Mezclarlos hace
 * que una página parezca de otra tienda.
 */

/** Lo que se ve de una línea: lo del carrito, cruzado con el catálogo. */
interface LineaVista {
  readonly codigo: string;
  readonly cantidad: number;
  /** `undefined` si el código ya no está en el catálogo. */
  readonly variante: VariantePublica | undefined;
}

/** Un botón de ± con 44 px de lado: lo mínimo para un dedo en un teléfono. */
function Paso({
  etiqueta,
  onClick,
  disabled,
  children,
}: {
  etiqueta: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={etiqueta}
      className="grid h-11 w-11 place-items-center rounded-full border border-line text-lg font-bold text-fg transition-colors hover:bg-surface focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export default function Carrito() {
  const catalogo = useCatalogo();
  const { carrito, poner, quitar, vaciar } = useCarrito();

  const lineas: LineaVista[] = carrito.lineas.map((l) => ({
    ...l,
    variante: catalogo.get(l.codigo),
  }));

  // Una línea sin variante en el catálogo no se suma a nada: no sabemos su
  // precio y no vamos a inventarlo. Se muestra aparte para que la clienta
  // sepa que está ahí y pueda quitarla.
  const conPrecio = lineas.filter((l) => l.variante !== undefined);
  const subtotalCents = conPrecio.reduce(
    (n, l) => n + (l.variante?.precioCents ?? 0) * l.cantidad,
    0
  );
  const hayAgotados = conPrecio.some((l) => l.variante?.disponibilidad === 'agotado');

  /**
   * El mensaje: códigos, cantidades y nombres. Sin precios, a propósito.
   *
   * El código va entre paréntesis porque es lo que Yarielis busca en el panel;
   * el nombre va para que la clienta reconozca lo que pidió al releer su
   * propio mensaje.
   */
  const mensaje = [
    'Hola, quiero hacer este pedido:',
    '',
    ...lineas.map((l) => {
      const nombre = l.variante?.nombre ?? 'Producto';
      const talla = l.variante?.talla === null ? '' : ` ${l.variante?.talla ?? ''}`;
      return `• ${l.cantidad} × ${nombre}${talla} (${l.codigo})`;
    }),
    '',
    'Quedo pendiente de la cotización con el envío. Gracias.',
  ].join('\n');

  if (carrito.lineas.length === 0) {
    return (
      <main id="main-content" className="min-h-dvh pt-32 md:pt-24">
        <Seo ruta="/carrito" meta={META} />
        <Section>
          <h1 className="font-display text-3xl font-bold md:text-4xl">Tu carrito</h1>
          <p className="mt-4 text-muted">
            Todavía no has agregado nada. Mira el catálogo y arma tu pedido: te
            vamos guardando la lista en este teléfono.
          </p>
          {/* `size: 'lg'`: es el único botón de la pantalla y medía 36 px de
              alto. El carrito vacío es donde se decide si se sigue mirando o
              se cierra la pestaña. */}
          <Link to="/productos" className={buttonVariants({ size: 'lg', className: 'mt-8' })}>
            Ver los productos
          </Link>
        </Section>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-dvh pt-32 md:pt-24">
      <Seo ruta="/carrito" meta={META} />
      <Section>
        <h1 className="font-display text-3xl font-bold md:text-4xl">Tu carrito</h1>

        <ul className="mt-8 list-none space-y-4 p-0">
          {lineas.map((l) => {
            const v = l.variante;
            const agotado = v?.disponibilidad === 'agotado';
            return (
              <li
                key={l.codigo}
                className="rounded-lg border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 font-bold" translate="no">
                      {v === undefined ? l.codigo : v.nombre}
                      {v?.talla === null || v === undefined ? '' : ` · ${v.talla}`}
                    </p>
                    {v === undefined ? (
                      // Honesto en vez de silencioso: el código estaba en el
                      // carrito pero ya no está en el catálogo (se descontinuó,
                      // o cambió de código). Decirlo es mejor que borrarlo solo.
                      <p className="m-0 mt-1 text-xs text-muted">
                        Este producto ya no aparece en el catálogo. Quítalo o
                        pregúntanos por él.
                      </p>
                    ) : (
                      <p className="m-0 mt-1 text-xs text-muted">
                        {v.unidadesPorCaja > 1 ? `${v.unidadesPorCaja} unidades · ` : ''}
                        {dolares(v.precioCents)} cada uno
                        {agotado ? ' · sin existencias ahora' : ''}
                      </p>
                    )}
                  </div>

                  {v === undefined ? null : (
                    <p className="m-0 shrink-0 text-right font-bold tabular-nums">
                      {dolares(v.precioCents * l.cantidad)}
                    </p>
                  )}
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <Paso
                    etiqueta={`Quitar uno de ${v?.nombre ?? l.codigo}`}
                    onClick={() => poner(l.codigo, l.cantidad - 1)}
                  >
                    −
                  </Paso>
                  <span className="min-w-8 text-center text-base font-bold tabular-nums">
                    {l.cantidad}
                  </span>
                  <Paso
                    etiqueta={`Agregar uno de ${v?.nombre ?? l.codigo}`}
                    onClick={() => poner(l.codigo, l.cantidad + 1)}
                    disabled={l.cantidad >= MAXIMO_POR_LINEA}
                  >
                    +
                  </Paso>
                  <button
                    type="button"
                    onClick={() => quitar(l.codigo)}
                    className="h-11 rounded-full px-4 text-sm font-bold text-muted underline transition-colors hover:text-fg focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    Quitar
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-8 rounded-lg border border-line p-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-bold">Subtotal de los productos</span>
            <span className="text-xl font-bold tabular-nums">{dolares(subtotalCents)}</span>
          </div>
          {/* Dice lo que es. Un «Total» aquí sería mentira: le falta el envío
              por zona y el ITBMS por línea, y los dos los calcula el servidor. */}
          <p className="m-0 mt-2 text-xs text-muted">
            Es una referencia. El envío se cotiza por tu zona y se suma aparte,
            y el total final te lo confirmamos al cerrar el pedido.
          </p>
        </div>

        {hayAgotados ? (
          <p className="mt-4 text-sm text-muted">
            Hay algo en tu lista sin existencias ahora mismo. Puedes mandarnos el
            pedido igual y te decimos cuándo entra.
          </p>
        ) : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href={whatsappCon(mensaje)}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: 'lg' })}
          >
            Enviar mi pedido por WhatsApp
          </a>
          <Button variant="ghost" onClick={vaciar} className="sm:ml-auto">
            Vaciar el carrito
          </Button>
        </div>

        {/* Aire al final: la burbuja del chat es fija abajo a la derecha y sin
            esto se sienta encima del botón de enviar el pedido. */}
        <p className="mt-6 pb-20 text-xs text-muted">
          Tu lista se guarda en este teléfono, no en nuestros servidores. Si abres
          la página en otro dispositivo, tendrás que armarla de nuevo.
        </p>
      </Section>
    </main>
  );
}
