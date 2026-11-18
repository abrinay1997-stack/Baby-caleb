import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { buttonVariants } from '../components/ui/Button';
import { dolares, useCatalogo } from '../hooks/useCatalogo';
import { WHATSAPP_URL } from '../data/contacto';
import { useCarrito } from './useCarrito';
import BotonDeYappy, { type EstadoDelBoton } from './BotonDeYappy';
import {
  DATOS_EN_BLANCO,
  type DatosDeLaClienta,
  type DatosDelBoton,
  type PedidoDelServidor,
  type Problemas,
  cuerpoDeInicio,
  hayProblemas,
  iniciarPagoConYappy,
  llaveDelCarrito,
  porqueNoSalio,
  primerProblema,
  revisarDatos,
  rutaDelResultado,
} from './pago';
import { type EstadoDeZonas, pedirZonasUnaVez } from './zonas';

/**
 * El paso de pago: `/pago`.
 *
 * Carrito → **datos** → botón de Yappy → página de resultado.
 *
 * ## LAS CIFRAS DE ESTA PANTALLA
 *
 * Hay dos clases de número aquí y no se mezclan:
 *
 *  · **El subtotal de los productos** sale del catálogo y es PARA ORIENTARSE.
 *    Lo dice con esas palabras, igual que en el carrito: le falta el envío y
 *    los impuestos, y los dos los calcula el servidor.
 *  · **El total y el envío del pedido** salen de la respuesta del servidor
 *    (`totalCents`, `envioCents`) y aparecen solo cuando el servidor los
 *    manda. Ni se calculan aquí ni se adelantan: antes de crear el pedido,
 *    nadie sabe cuánto es.
 *
 * Y una tercera que no existe: **ninguna tarifa de envío se escribe aquí.** El
 * tarifario vive en la D1 del sistema; lo que llega de `/api/zonas` trae
 * `tarifaCents` y esta pantalla no lo pinta, porque el precio del envío que
 * vale es el que devuelve el servidor al crear el pedido.
 *
 * ## LA VOZ
 *
 * Tutea, como el resto de la web («Escribe tu nombre», «te avisamos»). El
 * «usted» es del bot de atención, no de la tienda.
 */

const META = {
  title: 'Pagar tu pedido | Baby Caleb Panamá',
  description: 'Tus datos de entrega y el pago con Yappy.',
};

/** Un campo de texto del formulario, con su etiqueta de verdad y su error. */
function Campo({
  id,
  etiqueta,
  ayuda,
  error,
  children,
}: {
  id: string;
  etiqueta: string;
  ayuda?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* `<label for>` y no un texto al lado: un texto al lado no es una
          etiqueta, y el lector de pantalla lee el campo solo y dice «cuadro de
          edición», sin más (§7j del contrato de diseño). */}
      <label htmlFor={id} className="block text-sm font-bold">
        {etiqueta}
      </label>
      {ayuda === undefined ? null : (
        <p id={`${id}-ayuda`} className="m-0 mt-1 text-xs text-muted">
          {ayuda}
        </p>
      )}
      <div className="mt-2">{children}</div>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="m-0 mt-2 text-sm font-bold text-accent-strong">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Las clases de un campo.
 *
 * El borde va en `border-muted` y no en `border-line`: `--line` está hecho
 * para separar tarjetas (1.3:1 sobre el crema) y la WCAG 1.4.11 pide 3:1 para
 * el contorno de un control, que es lo único que dice dónde empieza el campo.
 * `--muted` da 4.95:1 sobre el fondo y 4.6:1 sobre la superficie. Es el mismo
 * fallo que el panel cerró partiendo `--line` en dos (§7m), y aquí se evita
 * usando el token que ya está medido en vez de inventar uno.
 *
 * `text-base` son 16 px, que es el mínimo de los campos (§7b): con menos, iOS
 * hace zoom al enfocar y la pantalla se descoloca sola justo cuando alguien
 * está escribiendo.
 */
const CAMPO =
  'w-full rounded-sm border border-muted bg-bg px-4 py-3 text-base text-fg ' +
  'focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2';

export default function PantallaDePago() {
  const catalogo = useCatalogo();
  const { carrito, vaciar } = useCarrito();
  const navegar = useNavigate();

  const [datos, setDatos] = useState<DatosDeLaClienta>(DATOS_EN_BLANCO);
  const [problemas, setProblemas] = useState<Problemas>({});
  /** El «no» del servidor, con SU mensaje, o el nuestro si no contestó nadie. */
  const [queDijoElServidor, setQueDijoElServidor] = useState<string | null>(null);
  /** Por qué no salió el pago, cuando Yappy avisa de que no salió. */
  const [queDijoYappy, setQueDijoYappy] = useState<string | null>(null);
  const [pedido, setPedido] = useState<PedidoDelServidor | null>(null);
  const [yappyEnLinea, setYappyEnLinea] = useState<boolean | null>(null);
  const [estadoDelBoton, setEstadoDelBoton] = useState<EstadoDelBoton>('cargando');
  const [zonas, setZonas] = useState<EstadoDeZonas>({ estado: 'cargando' });

  const nombreRef = useRef<HTMLInputElement | null>(null);
  const celularRef = useRef<HTMLInputElement | null>(null);
  const zonaRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    let vivo = true;
    void pedirZonasUnaVez().then((lista) => {
      if (!vivo) return;
      setZonas(lista === null ? { estado: 'sin_lista' } : { estado: 'listas', zonas: lista });
    });
    return () => {
      vivo = false;
    };
  }, []);

  const lineas = carrito.lineas.map((l) => ({ ...l, variante: catalogo.get(l.codigo) }));
  const subtotalCents = lineas.reduce(
    (n, l) => n + (l.variante?.precioCents ?? 0) * l.cantidad,
    0,
  );
  const hayQuePagar = carrito.lineas.length > 0;
  const zonaObligatoria = zonas.estado === 'listas';

  const ponerCampo = (campo: keyof DatosDeLaClienta, valor: string): void => {
    setDatos((d) => ({ ...d, [campo]: valor }));
    // El error de ESE campo se va en cuanto se toca: dejarlo puesto mientras
    // la clienta corrige es decirle que sigue mal cuando ya no lo sabe nadie.
    setProblemas((p) => {
      if (p[campo as keyof Problemas] === undefined) return p;
      const siguiente = { ...p };
      delete siguiente[campo as keyof Problemas];
      return siguiente;
    });
  };

  const llevarElFocoAlProblema = (encontrados: Problemas): void => {
    const campo = primerProblema(encontrados);
    if (campo === 'nombre') nombreRef.current?.focus();
    else if (campo === 'celular') celularRef.current?.focus();
    else if (campo === 'zona') zonaRef.current?.focus();
  };

  /**
   * Lo que pasa al pulsar el botón de Yappy.
   *
   * Devolver `null` significa «no se pudo»: el botón vuelve a su sitio y el
   * motivo ya está en pantalla. Nunca se lanza desde aquí — una excepción
   * dejaría el botón girando para siempre.
   */
  const alPulsar = async (): Promise<DatosDelBoton | null> => {
    setQueDijoElServidor(null);
    setQueDijoYappy(null);

    if (!hayQuePagar) {
      setQueDijoElServidor('Tu carrito está vacío: agrega algo antes de pagar.');
      return null;
    }

    const encontrados = revisarDatos(datos, { zonaObligatoria });
    if (hayProblemas(encontrados)) {
      setProblemas(encontrados);
      llevarElFocoAlProblema(encontrados);
      return null;
    }

    // LA MISMA LLAVE PARA EL MISMO CARRITO. Si la clienta toca pagar dos
    // veces, el servidor devuelve el pedido que ya existe en vez de crear otro
    // y apartar el inventario dos veces.
    const idempotencia = llaveDelCarrito(carrito.lineas);
    const respuesta = await iniciarPagoConYappy(
      cuerpoDeInicio(datos, carrito.lineas, idempotencia),
    );

    if (respuesta.estado === 'listo') {
      setPedido(respuesta.datos.pedido);
      return respuesta.datos.boton;
    }

    // El mensaje del servidor, TAL CUAL. Está escrito para que lo lea una
    // clienta y esta pantalla no sabe más que él.
    setQueDijoElServidor(respuesta.mensaje);
    return null;
  };

  /**
   * Yappy avisó de que terminó. **Esto no quiere decir que esté pagado.**
   *
   * Se manda a la página de resultado, que dice «estamos confirmando». El
   * carrito se vacía porque el pedido ya existe en el servidor: dejarlo
   * lleno invita a pagarlo otra vez.
   */
  const alConfirmar = (): void => {
    const numero = pedido?.numero;
    vaciar();
    navegar(numero === undefined ? '/pago/resultado' : rutaDelResultado(numero));
  };

  if (!hayQuePagar) {
    return (
      <main id="main-content" className="min-h-dvh pt-32 md:pt-24">
        <Seo ruta="/pago" meta={META} />
        <Section>
          <h1 className="font-display text-3xl font-bold md:text-4xl">Pagar tu pedido</h1>
          <p className="mt-4 text-muted">
            No hay nada en tu carrito todavía, así que no hay nada que pagar.
            Mira el catálogo y arma tu pedido: te vamos guardando la lista en
            este teléfono.
          </p>
          <Link to="/productos" className={buttonVariants({ size: 'lg', className: 'mt-8' })}>
            Ver los productos
          </Link>
          <p className="mt-6 pb-20 text-xs text-muted">
            Si ya habías armado tu carrito en otro teléfono, tendrás que armarlo
            de nuevo: la lista se guarda en el dispositivo, no en nuestros
            servidores.
          </p>
        </Section>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-dvh pt-32 md:pt-24">
      <Seo ruta="/pago" meta={META} />
      <Section>
        <h1 className="font-display text-3xl font-bold md:text-4xl">Pagar tu pedido</h1>
        <p className="mt-4 max-w-[60ch] text-muted">
          Déjanos tus datos de entrega y paga con Yappy. Nosotros calculamos el
          envío de tu zona y te confirmamos el total antes de cobrar.
        </p>

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          {/* ---- Los datos ------------------------------------------------ */}
          <div>
            <h2 className="font-display text-xl font-bold">Tus datos</h2>

            {/* Sin `onSubmit`: el pago lo arranca el botón de Yappy, que no es
                un `<button type=submit>` y no participa del formulario. Un
                `<form>` aquí prometería un envío que no existe. */}
            <div className="mt-6 flex flex-col gap-6">
              <Campo id="pago-nombre" etiqueta="Tu nombre" error={problemas.nombre}>
                <input
                  ref={nombreRef}
                  id="pago-nombre"
                  name="nombre"
                  type="text"
                  autoComplete="name"
                  value={datos.nombre}
                  onChange={(e) => ponerCampo('nombre', e.target.value)}
                  aria-invalid={problemas.nombre !== undefined}
                  aria-describedby={problemas.nombre === undefined ? undefined : 'pago-nombre-error'}
                  className={CAMPO}
                />
              </Campo>

              <Campo
                id="pago-celular"
                etiqueta="Tu celular"
                ayuda="Por aquí te confirmamos la entrega. Puedes escribirlo con guiones o sin ellos."
                error={problemas.celular}
              >
                <input
                  ref={celularRef}
                  id="pago-celular"
                  name="celular"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={datos.celular}
                  onChange={(e) => ponerCampo('celular', e.target.value)}
                  aria-invalid={problemas.celular !== undefined}
                  aria-describedby={
                    problemas.celular === undefined ? 'pago-celular-ayuda' : 'pago-celular-error'
                  }
                  className={CAMPO}
                />
              </Campo>

              {zonas.estado === 'listas' ? (
                <Campo
                  id="pago-zona"
                  etiqueta="Tu zona de envío"
                  ayuda="El costo del envío lo calculamos con tu zona y te lo confirmamos antes de cobrar."
                  error={problemas.zona}
                >
                  <select
                    ref={zonaRef}
                    id="pago-zona"
                    name="zona"
                    value={datos.zona}
                    onChange={(e) => ponerCampo('zona', e.target.value)}
                    aria-invalid={problemas.zona !== undefined}
                    aria-describedby={
                      problemas.zona === undefined ? 'pago-zona-ayuda' : 'pago-zona-error'
                    }
                    className={CAMPO}
                  >
                    <option value="">Elige tu zona</option>
                    {zonas.zonas.map((z) => (
                      <option key={z.id} value={z.nombre}>
                        {z.nombre}
                      </option>
                    ))}
                  </select>
                  {/* Lo único que se dice de `tarifaCents` es si NO hay tarifa
                      fija, porque eso cambia lo que va a pasar después. El
                      número no se pinta: lo pone el servidor. */}
                  {zonas.zonas.find((z) => z.nombre === datos.zona)?.tarifaCents === null &&
                  datos.zona !== '' ? (
                    <p className="m-0 mt-2 text-sm text-muted">
                      Esa zona la cotizamos con una persona: te escribimos con el
                      costo del envío antes de coordinar la entrega.
                    </p>
                  ) : null}
                </Campo>
              ) : zonas.estado === 'cargando' ? (
                <p className="m-0 text-sm text-muted" role="status">
                  Cargando las zonas de envío…
                </p>
              ) : (
                /* `sin_lista`: la ruta de las zonas no contestó. No se escribe
                   el tarifario a mano para tapar el hueco —eso le daría un
                   segundo dueño al precio del envío—: se dice lo que hay y se
                   sigue, porque el contrato declara la zona opcional y el envío
                   lo calcula el servidor igual. */
                <div className="rounded-lg border border-muted bg-surface p-4">
                  <p className="m-0 text-sm font-bold">
                    No pudimos cargar la lista de zonas de envío.
                  </p>
                  <p className="m-0 mt-2 text-sm text-muted">
                    Puedes seguir y pagar igual: calculamos el envío con tu
                    dirección y te lo confirmamos por WhatsApp antes de coordinar
                    la entrega. Si prefieres, escríbenos y lo vemos contigo.
                  </p>
                </div>
              )}

              <Campo
                id="pago-notas"
                etiqueta="Algo que debamos saber (opcional)"
                ayuda="La dirección exacta, un punto de referencia, el horario que te queda mejor."
              >
                <textarea
                  id="pago-notas"
                  name="notas"
                  rows={3}
                  value={datos.notas}
                  onChange={(e) => ponerCampo('notas', e.target.value)}
                  aria-describedby="pago-notas-ayuda"
                  className={CAMPO}
                />
              </Campo>
            </div>
          </div>

          {/* ---- Lo que lleva, y el pago ---------------------------------- */}
          <div>
            <h2 className="font-display text-xl font-bold">Lo que llevas</h2>

            <ul className="mt-4 list-none space-y-3 p-0">
              {lineas.map((l) => (
                <li key={l.codigo} className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="min-w-0" translate="no">
                    {l.cantidad} ×{' '}
                    {l.variante === undefined ? l.codigo : l.variante.nombre}
                    {l.variante?.talla === null || l.variante === undefined
                      ? ''
                      : ` · ${l.variante.talla}`}
                  </span>
                  {l.variante === undefined ? null : (
                    <span className="shrink-0 font-bold tabular-nums">
                      {dolares(l.variante.precioCents * l.cantidad)}
                    </span>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-4 rounded-lg border border-line p-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-bold">Subtotal de los productos</span>
                <span className="text-lg font-bold tabular-nums">{dolares(subtotalCents)}</span>
              </div>
              <p className="m-0 mt-2 text-xs text-muted">
                Es una referencia. El envío y los impuestos los calcula el
                servidor con tu zona, y el total que se cobra te lo decimos aquí
                mismo antes de pagar.
              </p>
            </div>

            {/* El total DEL SERVIDOR, cuando el servidor lo manda. No antes. */}
            {pedido === null ? null : (
              <div className="mt-4 rounded-lg border border-accent-edge bg-surface p-4">
                <p className="m-0 text-sm font-bold">Pedido {pedido.numero}</p>
                <dl className="m-0 mt-2 text-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="m-0 text-muted">Envío</dt>
                    <dd className="m-0 font-bold tabular-nums">{dolares(pedido.envioCents)}</dd>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-4">
                    <dt className="m-0 font-bold">Total a pagar</dt>
                    <dd className="m-0 text-lg font-bold tabular-nums">
                      {dolares(pedido.totalCents)}
                    </dd>
                  </div>
                </dl>
                <p className="m-0 mt-2 text-xs text-muted">
                  Lo calculó el servidor con los precios y el tarifario de hoy.
                </p>
              </div>
            )}

            <h2 className="mt-8 font-display text-xl font-bold">Pagar</h2>

            {/* Los dos avisos que la clienta tiene que poder oír sin mirar:
                `role="alert"` para lo que acaba de pasar al pulsar. */}
            <div aria-live="assertive" role="alert">
              {queDijoElServidor === null ? null : (
                <div className="mt-4 max-w-md rounded-lg border border-accent-edge bg-surface p-4">
                  <p className="m-0 text-sm font-bold">No pudimos empezar el pago</p>
                  {/* El mensaje del servidor, sin tocarlo. */}
                  <p className="m-0 mt-2 text-sm">{queDijoElServidor}</p>
                </div>
              )}
              {queDijoYappy === null ? null : (
                <div className="mt-4 max-w-md rounded-lg border border-accent-edge bg-surface p-4">
                  <p className="m-0 text-sm font-bold">El pago no se completó</p>
                  <p className="m-0 mt-2 text-sm">{queDijoYappy}</p>
                </div>
              )}
            </div>

            <div className="mt-4">
              <BotonDeYappy
                alPulsar={alPulsar}
                alConfirmar={alConfirmar}
                alFallar={(codigo) => setQueDijoYappy(porqueNoSalio(codigo))}
                alSaberSiYappyEstaEnLinea={setYappyEnLinea}
                alCambiarDeEstado={setEstadoDelBoton}
              />
            </div>

            {/* Yappy dijo que NO está en línea: el botón queda deshabilitado, y
                dejarlo muerto sin explicación es lo que hace que una clienta
                piense que la tienda está rota. */}
            {yappyEnLinea === false && estadoDelBoton === 'listo' ? (
              <div className="mt-4 max-w-md rounded-lg border border-accent-edge bg-surface p-4">
                <p className="m-0 text-sm font-bold">
                  Yappy no está disponible en este momento.
                </p>
                <p className="m-0 mt-2 text-sm text-muted">
                  No es tu teléfono ni tu cuenta: Yappy nos contestó que su
                  servicio está fuera de línea, así que el botón no se puede
                  pulsar. Tu carrito sigue guardado. Vuelve a intentarlo en un
                  rato, o escríbenos y cerramos el pedido contigo.
                </p>
                <a
                  href={WHATSAPP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-3' })}
                >
                  Escribirnos por WhatsApp
                </a>
              </div>
            ) : null}

            <p className="m-0 mt-4 max-w-md text-xs text-muted">
              Al pagar se abre Yappy con el monto que calculó el servidor.
              Nosotros confirmamos tu pedido cuando Yappy nos avisa de que el
              pago entró — nunca antes.
            </p>

            <p className="mt-6 pb-20 text-xs text-muted">
              <Link to="/carrito" className="font-bold underline">
                Volver al carrito
              </Link>{' '}
              para cambiar cantidades o quitar algo.
            </p>
          </div>
        </div>
      </Section>
    </main>
  );
}
