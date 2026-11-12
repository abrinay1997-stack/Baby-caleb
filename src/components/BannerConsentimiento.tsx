import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { buttonVariants } from './ui/Button';
import {
  EVENTO_ABRIR,
  EVENTO_DECIDIDO,
  guardarDecision,
  leerDecision,
  type Decision,
} from '../consentimiento/consentimiento';
import { activarPixel, entornoDelNavegador } from '../consentimiento/pixel';

/**
 * El banner del consentimiento: la única puerta por la que carga el píxel.
 *
 * ## Qué hace, en una línea
 *
 * Pregunta una vez, recuerda la respuesta en este navegador, y carga el píxel
 * de Meta **solo** si la respuesta fue sí.
 *
 * ## Tres opciones, no dos
 *
 * «Permitir», «No permitir» y «cambiar de opinión después». La tercera no es
 * un botón de aquí: es el enlace «Cookies y rastreo» del pie de página, que
 * vuelve a abrir esta tarjeta en cualquier momento (`EVENTO_ABRIR`). Un banner
 * que solo se puede contestar una vez y para siempre no deja retirar el
 * permiso, que es justo uno de los derechos que la Ley 81 reconoce.
 *
 * No hay botón de cerrar sin decidir, y es a propósito: una X equivale a «no
 * contestó», y entonces la tarjeta volvería a salir en la página siguiente.
 * Con «No permitir» a la vista y del mismo tamaño que el sí, no hace falta una
 * salida a medias.
 *
 * ## Por qué también corre al montar
 *
 * Quien ya dijo sí en una visita anterior tiene que seguir medido sin que le
 * vuelvan a preguntar. Así que al montar: si la decisión guardada es
 * «aceptado», se activa el píxel y la tarjeta no sale.
 *
 * ## Diseño
 *
 * No hay nada nuevo: `bg-surface`, `border-line`, `text-muted` y los mismos
 * botones (`buttonVariants`) del resto del sitio. El único detalle propio es
 * que mientras está abierto tapa el globo del chat, que vive en la misma
 * esquina de abajo. Se acepta a sabiendas: es un estado corto —se contesta una
 * vez— y la alternativa era mover el chat, que es diseño de la web y no se
 * toca sin pedido.
 */
export default function BannerConsentimiento() {
  const [abierto, setAbierto] = useState(false);

  useEffect(() => {
    const decision = leerDecision();

    // Ya dijo sí antes: se activa y no se le pregunta otra vez.
    if (decision === 'aceptado') activarPixel(decision, entornoDelNavegador());

    // `null` es «todavía no ha elegido». Un «rechazado» guardado NO vuelve a
    // preguntar: insistir hasta que alguien ceda no es pedir permiso.
    setAbierto(decision === null);

    const abrir = () => setAbierto(true);
    window.addEventListener(EVENTO_ABRIR, abrir);
    return () => window.removeEventListener(EVENTO_ABRIR, abrir);
  }, []);

  function decidir(decision: Decision) {
    guardarDecision(decision);
    // El píxel se activa AQUÍ y en ningún otro sitio de este archivo: la
    // guarda de `activarPixel` vuelve a mirar la decisión, así que un «no»
    // que llegue por error tampoco carga nada.
    activarPixel(decision, entornoDelNavegador());
    setAbierto(false);
    window.dispatchEvent(new CustomEvent(EVENTO_DECIDIDO, { detail: decision }));
  }

  if (!abierto) return null;

  return (
    <div
      // `role="dialog"` y no `alertdialog`: no es una alerta y no bloquea la
      // página. Se puede seguir leyendo la tienda sin contestar — lo que no
      // pasa mientras no se contesta es que cargue el píxel.
      role="dialog"
      aria-modal="false"
      aria-labelledby="consentimiento-titulo"
      className="fixed inset-x-0 bottom-0 z-[1001] px-4 pb-4 sm:px-6 sm:pb-6"
    >
      <div className="bg-surface border-line mx-auto max-w-3xl rounded-lg border p-5 sm:p-6">
        <h2 id="consentimiento-titulo" className="text-fg mb-2 text-base font-bold">
          ¿Nos deja medir con Meta?
        </h2>
        <p className="text-muted mb-4 text-sm">
          Queremos usar el píxel de Meta (Facebook e Instagram) para saber qué anuncios
          traen visitas y cuáles no. Es una herramienta de Meta: si usted acepta, Meta se
          entera de que pasó por esta página. No lo cargamos hasta que usted diga que sí,
          y si dice que no, no se carga — ni ahora ni después.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => decidir('aceptado')}
            className={buttonVariants({ variant: 'accent', size: 'sm' })}
          >
            Permitir
          </button>
          {/* El «no» tiene el mismo tamaño y está igual de a la vista que el
              «sí». Un rechazo escondido en letra chica no es una opción. */}
          <button
            type="button"
            onClick={() => decidir('rechazado')}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            No permitir
          </button>
          <Link
            to="/privacidad#cookies"
            onClick={() => setAbierto(false)}
            className="text-muted hover:text-fg focus-visible:outline-accent-edge inline-flex items-center justify-center rounded-md px-2 py-2 text-sm underline underline-offset-4 focus-visible:outline-2"
          >
            Leer la política de privacidad
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * El enlace para cambiar de opinión. Vive en el pie de todas las páginas.
 *
 * Es un `<button>` y no un `<Link>` porque no lleva a ninguna parte: vuelve a
 * abrir la tarjeta ahí mismo. Si llevara a una página aparte, retirar el
 * permiso costaría una navegación más que darlo, y eso ya es inclinar la
 * balanza.
 */
export function EnlaceDeConsentimiento({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(EVENTO_ABRIR))}
      className={className}
    >
      Cookies y rastreo
    </button>
  );
}
