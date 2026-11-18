import { Link } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { Button, buttonVariants } from '../components/ui/Button';
import { useCatalogo, dolares, type VariantePublica } from '../hooks/useCatalogo';
import { useCarrito } from '../carrito/useCarrito';
import { MAXIMO_POR_LINEA } from '../carrito/carrito';

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
 * QUÉ ES ESTA PANTALLA Y QUÉ NO ES
 *
 * Es el primer paso de cuatro: **carrito** → datos (`/pago`) → botón de Yappy
 * → resultado (`/pago/resultado/<numero>`). Aquí solo se revisa la lista y se
 * elige por dónde seguir.
 *
 * El camino de WhatsApp SE QUEDA, y no es un resto del pasado: es el que
 * funciona cuando Yappy está fuera de línea, cuando su botón no carga y cuando
 * la clienta prefiere que una persona le cotice. Quitarlo para que el carrito
 * «termine en el pago» cerraría la única puerta que no depende de un tercero.
 *
 * ## LO QUE QUEDA PENDIENTE EN `sistema/`, Y HAY QUE HACERLO
 *
 * `sistema/src/dominio/checkout.ts` declara a mano
 * `LA_WEB_TIENE_CHECKOUT = false`, y de ahí sale el «Encendido, pero todavía
 * sin efecto» que la dueña ve en Ajustes cuando enciende `checkout_activo`.
 * Desde este cambio **eso es falso**: la web ya sabe mandar a pagar.
 *
 * Dos cosas hay que tocar allá, y este trabajo no toca `sistema/`:
 *
 *  1. `LA_WEB_TIENE_CHECKOUT` pasa a `true`;
 *  2. `SENALES_DE_COBRO`, en `sistema/test/node/checkout-de-la-web.test.ts`,
 *     busca `/api/pedidos`, `/api/checkout`, `/api/pagos`, `iniciarPago` y
 *     `crearPedido` DENTRO DE ESTE ARCHIVO. La ruta de verdad es
 *     `/api/pago/yappy/iniciar` y la llamada vive en `src/carrito/pago.ts`, así
 *     que esa prueba **sigue en verde** mientras la constante miente. Es la
 *     trampa §8 con nombre y apellido: una lista que alguien tiene que
 *     acordarse de tocar, y que no avisa cuando no la tocan.
 *
 * Mientras la constante diga `false`, Ajustes enseñará «sin efecto» sobre un
 * cobro que funciona — que es el mismo fallo de `checkout_activo` al revés.
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
 * El total de verdad aparece una sola vez en toda la web: en `/pago`, cuando
 * el servidor ya creó el pedido y lo devolvió en `totalCents`. Ni un paso
 * antes.
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
          {/* El camino principal: datos y pago con Yappy. Es un `Link` y no un
              botón porque es una página, y así se puede abrir en otra pestaña
              y se comporta como un enlace para quien usa lector de pantalla. */}
          <Link to="/pago" className={buttonVariants({ size: 'lg' })}>
            Continuar al pago
          </Link>
          {/* Aquí estaba «O pedir por WhatsApp». Se fue por decisión del
              dueño el 18-nov-2026: el pago se hace en la web y WhatsApp deja
              de ser una salida que compite con el botón de al lado.

              Si Yappy está caído, lo que ve la clienta es el aviso de la
              pantalla de pago, que lo dice con nombre y apellido; y WhatsApp
              sigue a un toque en el pie y en el chat si lo pide. Lo que ya no
              hay es un botón que se la lleve de la tienda antes de intentarlo. */}
          <Button variant="ghost" onClick={vaciar} className="sm:ml-auto">
            Vaciar el carrito
          </Button>
        </div>
        <p className="m-0 mt-4 text-sm text-muted">
          En el siguiente paso te pedimos tu nombre, tu celular y tu zona, y el
          servidor calcula el envío y el total antes de cobrarte nada.
        </p>

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
