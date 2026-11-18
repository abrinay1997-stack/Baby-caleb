import { Link, useParams } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { buttonVariants } from '../components/ui/Button';
import { WHATSAPP_URL } from '../data/contacto';
import { ESTAMOS_CONFIRMANDO, esNumeroDePedido } from './pago';

/**
 * La página de resultado: `/pago/resultado/:numero`.
 *
 * ## ESTA PÁGINA NO DICE «PAGADO», Y ES SU RAZÓN DE SER
 *
 * Aquí se llega cuando el botón de Yappy emite `eventSuccess`. Ese evento NO
 * significa que el pedido esté pagado:
 *
 *  · en el código del componente se emite para tres estados internos
 *    (`COMPLETED`, `C` y `EXECUTED`);
 *  · y hay estados —`REJECTED` es el ejemplo— que **no disparan ni éxito ni
 *    error**, así que la pantalla se queda sin noticias de ninguna clase.
 *
 * Quien marca un pedido como pagado es el aviso firmado que Yappy manda al
 * servidor por detrás: entra por `/api/pago/yappy`, el Worker lo enruta y el
 * sistema verifica la firma antes de tocar nada
 * (`sistema/src/pagos/recibir-aviso.ts`). Este navegador no participa de esa
 * decisión y no puede.
 *
 * Por eso el título es «{@link ESTAMOS_CONFIRMANDO}» y no «¡Pagado!». Si
 * alguien lo cambia por una frase que afirme el cobro, un día alguien va a
 * recibir mercancía sin haber pagado — y la clienta tendrá un papel en la mano
 * que lo dice. Es la regla del `CLAUDE.md`: «el navegador no decide un pago».
 * Lo vigila `test/el-navegador-no-decide-un-pago.test.ts`.
 *
 * ## NO CONSULTA NADA, Y LO DICE
 *
 * El número de pedido llega por la URL, así que es entrada no confiable y lo
 * único que se comprueba es su forma. Esta pantalla **no** pregunta por el
 * estado del pedido: no hay ruta pública para eso, y no se inventa una
 * afirmación sobre un dato que no se tiene. Lo que hace es decir qué va a
 * pasar y por dónde llega la respuesta.
 */

const META = {
  title: 'Estamos confirmando tu pago | Baby Caleb Panamá',
  description: 'Tu pedido quedó registrado y estamos confirmando el pago con Yappy.',
};

export default function ResultadoDelPago() {
  const { numero } = useParams<{ numero?: string }>();
  const valido = typeof numero === 'string' && esNumeroDePedido(numero);

  return (
    <main id="main-content" className="min-h-dvh pt-32 md:pt-24">
      <Seo ruta="/pago/resultado" meta={META} />
      <Section>
        <h1 className="font-display text-3xl font-bold md:text-4xl">{ESTAMOS_CONFIRMANDO}</h1>

        {valido ? (
          <p className="mt-4 max-w-[60ch] text-lg">
            Tu pedido quedó registrado con el número{' '}
            <strong translate="no">{numero}</strong>. Guárdalo: es con lo que te
            encontramos si nos escribes.
          </p>
        ) : (
          <p className="mt-4 max-w-[60ch] text-lg">
            Tu pedido quedó registrado. No tenemos su número a mano en esta
            pantalla, y eso no cambia nada de lo de abajo: lo buscamos por tu
            celular cuando nos escribas.
          </p>
        )}

        <h2 className="mt-10 font-display text-xl font-bold">Qué pasa ahora</h2>
        <ul className="mt-4 max-w-[60ch] list-disc space-y-3 pl-6 text-muted">
          <li>
            Yappy le avisa a nuestro servidor si el pago entró. Ese aviso es el
            que confirma el pedido —no esta pantalla—, y puede tardar unos
            minutos.
          </li>
          <li>
            En cuanto lo tengamos, te escribimos por WhatsApp al celular que
            dejaste, con el total y la coordinación de la entrega.
          </li>
          <li>
            Si el pago <strong>no</strong> entró, también te avisamos, y tu
            pedido se queda sin cobrar. No se te cobra dos veces por volver a
            intentarlo.
          </li>
        </ul>

        <p className="mt-8 max-w-[60ch] text-sm text-muted">
          ¿Pagaste y no te hemos escrito? Mándanos un mensaje con tu número de
          pedido y lo revisamos de una vez.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: 'lg' })}
          >
            Escribirnos por WhatsApp
          </a>
          <Link
            to="/productos"
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            Seguir viendo productos
          </Link>
        </div>

        {/* Aire al final: la burbuja del chat es fija abajo a la derecha y sin
            esto se sienta encima del último botón. */}
        <p className="mt-10 pb-20 text-xs text-muted">
          Tu carrito se vació porque el pedido ya está registrado en nuestro
          sistema. Si quieres agregar algo más, es un pedido nuevo.
        </p>
      </Section>
    </main>
  );
}
