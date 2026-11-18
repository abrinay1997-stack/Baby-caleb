import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatosDelBoton } from './pago';

/**
 * El Botón de Pago de Yappy, envuelto para React.
 *
 * ## EL HOST DEL SCRIPT: ÉSTE Y NO OTRO
 *
 * La documentación de Yappy da DOS hosts distintos en la misma página, y el
 * que sale en su ejemplo (`bt-cdn.yappycloud.com`) **no responde**. Con ése, el
 * elemento `<btn-yappy>` se queda sin definir, el navegador lo pinta como una
 * etiqueta desconocida —o sea, nada— y no entra un solo pago. Sin error en la
 * consola que lo explique y sin nada roto que mirar.
 *
 * El que responde es `bt-cdn.yappy.cloud`. Comprobado contra el CDN: devuelve
 * el paquete y define el elemento.
 *
 * No se adivina y no se «arregla» cambiándolo por el otro: hay una prueba que
 * lee este archivo y se pone roja si el host cambia
 * (`test/el-navegador-no-decide-un-pago.test.ts`). Es la trampa §2 del
 * repositorio: no adivine la cadena de un tercero.
 *
 * ## EL SCRIPT SE CARGA SOLO EN ESTA PANTALLA
 *
 * Son 545 KB de un tercero que además cuelga sus propias fuentes de Google en
 * el `<head>`. En `index.html` lo pagarían las siete páginas públicas, y el
 * paso de pago lo ve una fracción de quien entra. Así que se carga al montar
 * este componente, una sola vez por sesión, y no se descarga: el elemento ya
 * definido no se puede «desdefinir», y volver a pedirlo al reentrar sería
 * pagar dos veces por lo mismo.
 *
 * ## EL TEMA: `dark`, Y ESTÁ MEDIDO
 *
 * `theme` acepta `blue`, `darkBlue`, `orange`, `dark`, `sky` y `light`. El
 * texto del botón es de 16 px en negrita, que para la WCAG es texto NORMAL
 * (grande empieza en 18.66 px en negrita), así que pide 4.5:1. Medidos los
 * seis pares del propio CSS del componente:
 *
 *     blue      blanco sobre #1eb2f5   2.40:1  ✗
 *     orange    blanco sobre #ff973c   2.17:1  ✗
 *     sky       #1677d8 sobre #f4faff  4.29:1  ✗
 *     light     #1677d8 sobre #ffffff  4.50:1  ✗ (4.5003 — pasa por 0.0003)
 *     darkBlue  blanco sobre #1677d8   4.50:1  ✗ (ídem)
 *     dark      blanco sobre #444c5e   8.60:1  ✓
 *
 * O sea: de los seis temas que Yappy ofrece, **uno solo** cumple AA con
 * margen. Los dos que dan 4.5003 no se eligen porque un control que pasa por
 * tres diezmilésimas no es un control: cualquier redondeo del medidor lo
 * cambia de lado, y `npm run auditar:web` mide el píxel que sale.
 *
 * `dark` (#444c5e) es además el que se parece al navy de la marca (#1B3246), y
 * `rounded` lo deja con la misma pastilla que el resto de los botones del
 * sitio. El logo de Yappy va dentro del botón en los seis temas, así que la
 * clienta reconoce con qué está pagando.
 *
 * ## QUÉ HACE ESTE ARCHIVO QUE LA DOCUMENTACIÓN NO DICE
 *
 * Tres cosas, y las tres salen de LEER el paquete, no de suponer:
 *
 *  1. **`isButtonLoading` se pone en `true` solo.** `btnClicked()` del
 *     componente emite `eventClick`, pone `isButtonLoading = true` y le añade
 *     al botón la clase `disable-btn` (`opacity:.4; pointer-events:none`). Esa
 *     clase se quita en UN solo sitio: al terminar la suscripción a Firestore,
 *     que solo existe si se llamó a `eventPayment`. Conclusión: si la llamada
 *     al servidor falla, poner `isButtonLoading = false` devuelve el texto
 *     pero el botón se queda al 40 % y sin pulsar. Por eso, cuando falla, este
 *     componente **vuelve a crear el elemento** en vez de confiar en una clase
 *     ajena: un botón nuevo nace limpio y la clienta puede reintentar.
 *  2. **`eventError` no solo trae los cinco códigos.** El componente también
 *     emite por ahí el error de la petición con que comprueba si Yappy está en
 *     línea. Quien reciba este evento tiene que aguantar un valor que no esté
 *     en la lista.
 *  3. **Mientras no contesta su comprobación de disponibilidad, el componente
 *     enseña su propio aviso rojo** («En este momento, Yappy no está
 *     disponible»), porque nace con `isAvailableButton = false`. No se tapa: es
 *     el mensaje de Yappy sobre Yappy. Lo que se añade al lado es el nuestro,
 *     que dice qué puede hacer la clienta mientras tanto.
 */

/** El único host que responde. Ver el bloque de arriba antes de tocarlo. */
export const SCRIPT_DE_YAPPY =
  'https://bt-cdn.yappy.cloud/v1/cdn/web-component-btn-yappy.js';

/** El nombre del elemento personalizado que define ese script. */
export const ELEMENTO_DE_YAPPY = 'btn-yappy';

/** El único tema que cumple 4.5:1 con margen. Los seis, medidos, arriba. */
export const TEMA_DE_YAPPY = 'dark';

/**
 * Cuánto se espera a que el elemento quede definido antes de rendirse.
 *
 * No es una cifra del negocio: es una espera. Y hace falta un techo porque un
 * `<script>` que no llega nunca no dispara `error` —se queda colgado— y la
 * clienta se quedaría mirando «Cargando el botón de Yappy» para siempre, sin
 * saber que puede escribir por WhatsApp.
 */
const ESPERA_MAXIMA_MS = 12_000;

/**
 * Lo que el elemento de Yappy expone, de lo que aquí se usa.
 *
 * Los dos campos van comentados con `//` y no con `/** *\/`: `soloCodigo`, que
 * es con lo que las pruebas de `test/` leen el código sin sus comentarios, no
 * es un analizador de JavaScript —lo dice en su propia cabecera— y un bloque
 * que abre con `{` y sigue con un docstring se lo lleva entero. Pasó en este
 * archivo: la prueba del paso de pago se puso roja comprobando cosas que SÍ
 * estaban, porque leía 1,6 KB de los 16 que tiene.
 */
interface ElementoDeYappy extends HTMLElement {
  // Lo pone el propio componente en `true` al pulsar. Nos toca bajarlo.
  isButtonLoading: boolean;
  // Se le pasan los tres valores del pedido para arrancar el cobro.
  eventPayment?: (datos: DatosDelBoton) => void;
}

/**
 * Carga el script una sola vez y dice si el elemento quedó definido.
 *
 * Se resuelve con `false` en vez de reventar: una pantalla de pago que lanza
 * una excepción deja a la clienta sin nada, y lo que hace falta es poder
 * decirle que use el otro camino.
 */
let cargaEnVuelo: Promise<boolean> | null = null;

function cargarElScriptDeYappy(): Promise<boolean> {
  cargaEnVuelo ??= new Promise<boolean>((resolver) => {
    if (window.customElements.get(ELEMENTO_DE_YAPPY) !== undefined) {
      resolver(true);
      return;
    }

    // El `load` del `<script>` NO garantiza que el elemento esté definido: es
    // un módulo y se define al ejecutarse. Lo que se espera es la definición.
    void window.customElements.whenDefined(ELEMENTO_DE_YAPPY).then(() => resolver(true));

    const etiqueta = document.createElement('script');
    etiqueta.type = 'module';
    etiqueta.src = SCRIPT_DE_YAPPY;
    etiqueta.addEventListener('error', () => resolver(false));
    document.head.appendChild(etiqueta);

    window.setTimeout(() => resolver(false), ESPERA_MAXIMA_MS);
  }).then((salio) => {
    // Un `false` no se guarda: puede haber sido un túnel de metro. Así, si la
    // clienta vuelve a entrar al paso de pago, se intenta otra vez. Un `true`
    // sí se guarda, porque el elemento ya está definido para siempre.
    if (!salio) cargaEnVuelo = null;
    return salio;
  });
  return cargaEnVuelo;
}

/** Para las pruebas: olvida que ya se intentó cargar. */
export function olvidarCargaDeYappy(): void {
  cargaEnVuelo = null;
}

export type EstadoDelBoton =
  /** Pidiendo el script del tercero. */
  | 'cargando'
  /** El botón está puesto y se puede pulsar. */
  | 'listo'
  /** El script no llegó: no hay botón y hay que decirlo. */
  | 'sin_script';

// Igual que `ElementoDeYappy`: comentarios de línea, para que `soloCodigo` no
// se lleve el archivo por delante.
interface Props {
  // Qué pasa al pulsar: crear el pedido y traer los tres valores.
  //
  // Devolver `null` significa «no se pudo»: el botón se devuelve a su estado
  // normal y quien llama ya habrá enseñado el motivo. Esta función NO debe
  // lanzar; si lanza, se trata igual que `null`.
  readonly alPulsar: () => Promise<DatosDelBoton | null>;
  // Yappy avisó de que terminó.
  //
  // NO QUIERE DECIR QUE ESTÉ PAGADO. Lo decide el aviso firmado que llega al
  // servidor por detrás. Quien recibe esto manda a «estamos confirmando».
  readonly alConfirmar: (transactionId: string) => void;
  // El pago no salió. El código puede no estar en la lista de los cinco.
  readonly alFallar: (codigo: unknown) => void;
  // Si Yappy está en línea. Llega al renderizar, con `true` o con `false`.
  readonly alSaberSiYappyEstaEnLinea: (enLinea: boolean) => void;
  // Para que la pantalla pueda contar lo que está pasando.
  readonly alCambiarDeEstado?: (estado: EstadoDelBoton) => void;
}

export default function BotonDeYappy({
  alPulsar,
  alConfirmar,
  alFallar,
  alSaberSiYappyEstaEnLinea,
  alCambiarDeEstado,
}: Props) {
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const [estado, setEstado] = useState<EstadoDelBoton>('cargando');
  /**
   * Si Yappy dijo que está en línea. `null` = todavía no lo ha dicho.
   *
   * Se guarda aquí además de avisar hacia fuera porque de esto depende que el
   * puente del teclado se ponga o no, y eso es asunto de este componente.
   */
  const [enLinea, setEnLinea] = useState<boolean | null>(null);
  /**
   * Sube de uno cada vez que hay que tirar el botón y poner otro nuevo.
   *
   * Es la forma de salir del `disable-btn` que el componente se pone solo al
   * pulsar y que solo él se quita (ver el punto 1 de la cabecera).
   */
  const [generacion, setGeneracion] = useState(0);

  /**
   * Las funciones de fuera, siempre las últimas.
   *
   * El elemento se crea una vez por generación y sus escuchas se quedan con lo
   * que hubiera en ese momento. Sin esto, el manejador del clic llamaría al
   * `alPulsar` del primer render —con el formulario vacío— por mucho que la
   * clienta hubiera escrito después.
   */
  const ultimas = useRef({ alPulsar, alConfirmar, alFallar, alSaberSiYappyEstaEnLinea });
  ultimas.current = { alPulsar, alConfirmar, alFallar, alSaberSiYappyEstaEnLinea };

  const avisar = useRef(alCambiarDeEstado);
  avisar.current = alCambiarDeEstado;
  useEffect(() => {
    avisar.current?.(estado);
  }, [estado]);

  const rehacer = useCallback(() => {
    setGeneracion((n) => n + 1);
  }, []);

  /**
   * Si de ESTE botón llegó a salir un pago.
   *
   * **Sin esto hay un bucle, y se vio en una captura.** El componente emite
   * `eventError` también cuando falla SU comprobación de disponibilidad, que
   * corre sola al renderizar. Como `eventError` rehace el botón —para que se
   * pueda reintentar tras un pago fallido—, un botón nuevo volvía a
   * comprobar, volvía a fallar y volvía a rehacerse: una rueda infinita
   * golpeando la API de Yappy, en la pantalla de una clienta.
   *
   * Y además mentía: la pantalla decía «el pago no se completó» sin que nadie
   * hubiera intentado pagar nada.
   *
   * Así que un `eventError` anterior al primer `eventPayment` no es un pago
   * fallido: es Yappy diciendo que no está. Se trata como lo que es.
   */
  const seMandoAPagar = useRef(false);

  useEffect(() => {
    const caja = cajaRef.current;
    if (caja === null) return;

    let vivo = true;
    setEstado('cargando');
    // El botón nuevo todavía no ha dicho si Yappy está en línea: arrastrar la
    // respuesta del anterior sería contestar por él.
    setEnLinea(null);
    seMandoAPagar.current = false;

    void cargarElScriptDeYappy().then((definido) => {
      if (!vivo) return;
      if (!definido) {
        setEstado('sin_script');
        return;
      }

      const boton = document.createElement(ELEMENTO_DE_YAPPY) as ElementoDeYappy;
      boton.setAttribute('theme', TEMA_DE_YAPPY);
      boton.setAttribute('rounded', 'true');

      boton.addEventListener('eventClick', () => {
        // El componente YA se puso en «cargando» y se deshabilitó al emitir
        // esto. Lo único que hay que garantizar es que no se quede así.
        void (async () => {
          let datos: DatosDelBoton | null = null;
          try {
            datos = await ultimas.current.alPulsar();
          } catch {
            datos = null;
          }
          if (datos === null) {
            // Las dos cosas: la propiedad documentada, y un botón nuevo,
            // porque la propiedad no quita la clase que lo apaga.
            boton.isButtonLoading = false;
            if (vivo) rehacer();
            return;
          }
          // `eventPayment` lo asigna el componente en su propio arranque. Si
          // no está, el pago no puede empezar y hay que decirlo en vez de
          // dejar el botón girando.
          if (typeof boton.eventPayment !== 'function') {
            boton.isButtonLoading = false;
            ultimas.current.alFallar('SIN_EVENTPAYMENT');
            if (vivo) rehacer();
            return;
          }
          seMandoAPagar.current = true;
          boton.eventPayment({
            transactionId: datos.transactionId,
            documentName: datos.documentName,
            token: datos.token,
          });
        })();
      });

      boton.addEventListener('eventSuccess', (e) => {
        const detalle = (e as CustomEvent<unknown>).detail;
        ultimas.current.alConfirmar(typeof detalle === 'string' ? detalle : '');
      });

      boton.addEventListener('eventError', (e) => {
        // Antes del primer pago, un `eventError` es su comprobación de
        // disponibilidad y no un cobro fallido. Ni se llama a `alFallar` —que
        // pondría «el pago no se completó» sin que nadie haya pagado— ni se
        // rehace el botón, que es lo que creaba el bucle.
        if (!seMandoAPagar.current) {
          setEnLinea(false);
          ultimas.current.alSaberSiYappyEstaEnLinea(false);
          return;
        }
        ultimas.current.alFallar((e as CustomEvent<unknown>).detail);
        // Un botón nuevo para poder reintentar: el que falló se quedó apagado.
        if (vivo) rehacer();
      });

      boton.addEventListener('isYappyOnline', (e) => {
        const detalle = (e as CustomEvent<unknown>).detail;
        setEnLinea(detalle === true);
        ultimas.current.alSaberSiYappyEstaEnLinea(detalle === true);
      });

      caja.appendChild(boton);
      setEstado('listo');
    });

    return () => {
      vivo = false;
      // El elemento se tira entero: así se van con él sus escuchas y su
      // suscripción, y la generación siguiente empieza de cero.
      caja.replaceChildren();
    };
  }, [generacion, rehacer]);

  /**
   * El puente del teclado.
   *
   * **El botón de Yappy no se puede usar con el teclado.** Lo que el paquete
   * dibuja es un `<div class="yappy-button ecommerce">` con un `(click)` de
   * Angular: no es un `<button>`, no tiene `role`, no tiene `tabindex` y no
   * escucha teclas. Quien navega con teclado o con lector de pantalla no
   * llega a él, y pagar es justo lo que no se puede dejar fuera.
   *
   * Así que la caja que lo contiene sí es un botón para la máquina —`role`,
   * `tabindex` y nombre— y al pulsar Enter o la barra espaciadora le reenvía
   * el clic al div de Yappy.
   *
   * Eso usa el nombre de una clase AJENA (`.yappy-button`), que es justo lo
   * que `docs/TRAMPAS.md` §2 dice que no se adivine. No se adivina: está leída
   * del paquete que sirve el CDN. Y falla hacia el lado seguro — si algún día
   * la renombran, `firstElementChild` sigue siendo ese mismo div, y si
   * tampoco, no pasa nada: el camino del ratón queda intacto y el del teclado
   * vuelve a no funcionar, que es donde estaba antes de esto.
   */
  const alTeclear = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const caja = cajaRef.current;
    if (caja === null) return;
    // Solo `.yappy-button`, sin plan B: el `<btn-yappy>` tiene además un div
    // de fondo para su modal, y un plan B que acertara con ése dispararía
    // algo que nadie pidió. Si la clase cambia, el teclado vuelve a no
    // funcionar —que es donde estaba— y no se rompe nada más.
    const dentro = caja.querySelector<HTMLElement>('.yappy-button');
    if (dentro === null) return;
    e.preventDefault();
    dentro.click();
  };

  /**
   * El puente del teclado se pone SOLO con el botón vivo.
   *
   * Con Yappy fuera de línea, el componente le pone al div
   * `pointer-events: none` — y eso frena el ratón, pero NO frena un `.click()`
   * por programa. Sin esta condición, quien llegara con el teclado podría
   * arrancar un cobro en un botón que para todos los demás está apagado.
   */
  const sePuedePulsar = estado === 'listo' && enLinea !== false;

  return (
    <div>
      {/* `max-w-md` y no un ancho fijo: el botón de Yappy es un bloque que
          llena su columna, y en una pantalla de 1440 px eso sería un botón de
          1280 px de ancho. Nada de `min-width` en píxeles (§7e). */}
      <div
        ref={cajaRef}
        className="max-w-md"
        {...(sePuedePulsar
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': 'Pagar con Yappy',
              onKeyDown: alTeclear,
            }
          : {})}
      />
      {estado === 'cargando' ? (
        <p className="m-0 mt-3 max-w-md text-sm text-muted" role="status">
          Cargando el botón de Yappy…
        </p>
      ) : null}
      {estado === 'sin_script' ? (
        <div className="mt-3 max-w-md rounded-lg border border-accent-edge bg-surface p-4">
          <p className="m-0 text-sm font-bold">No pudimos cargar el botón de Yappy.</p>
          <p className="m-0 mt-2 text-sm text-muted">
            Puede ser tu conexión o algo del lado de Yappy. Tu carrito sigue
            guardado: vuelve a intentarlo en un momento o mándanos el pedido por
            WhatsApp y lo cerramos contigo.
          </p>
          <button
            type="button"
            onClick={rehacer}
            className="mt-3 h-11 rounded-pill border border-accent-edge px-5 text-sm font-bold text-accent-strong transition-colors hover:bg-surface"
          >
            Volver a intentarlo
          </button>
        </div>
      ) : null}
    </div>
  );
}
