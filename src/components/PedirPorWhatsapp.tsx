import { buttonVariants } from './ui/Button';
import { whatsappDePedidos, type VariantePublica } from '../hooks/useCatalogo';

/**
 * El botón «Pedir por WhatsApp» de una ficha de producto.
 *
 * ## Quién decide si sale
 *
 * No esta pantalla. La decisión llega ya tomada en `variante.pedirPorWhatsapp`,
 * y el sistema la calcula juntando tres cosas: el ajuste global
 * `whatsapp_pedidos_activo`, el celular de `whatsapp_numero` y la columna
 * `pedir_por_whatsapp` de esa variante. Aquí solo se obedece.
 *
 * Es a propósito: si el navegador combinara las tres, cambiar la regla exigiría
 * volver a desplegar la web, y una pestaña abierta desde ayer la combinaría con
 * la versión vieja. Y el administrador apaga el botón desde Ajustes esperando
 * que desaparezca YA.
 *
 * ## EL MENSAJE NO LLEVA PRECIO. Nunca.
 *
 * Lleva el código y el nombre. Un precio en ese mensaje es una promesa, y el
 * precio lo pone el catálogo en el momento de cerrar, no el navegador hace
 * media hora — el razonamiento largo está en `src/pages/Carrito.tsx`, y el
 * mensaje del carrito ya se escribió así desde el principio.
 *
 * Esta ficha NO lo hacía: el mensaje decía «quiero pedir: Pañal Nateen Talla M
 * ($50)», con el precio dentro, y el enlace iba a un número escrito a mano en
 * el archivo. Las dos cosas quedan arregladas aquí.
 *
 * El código va primero entre paréntesis porque es lo que se busca en el panel;
 * el nombre va para que la clienta reconozca lo que pidió al releer su propio
 * mensaje. Es el mismo formato del carrito, y eso también importa: dos
 * mensajes distintos del mismo negocio se leen como de dos negocios.
 */
export function PedirPorWhatsapp({
  variante,
  agotado,
}: {
  variante: VariantePublica;
  /** Agotado cambia el texto, no el canal: se escribe para que avisen. */
  agotado: boolean;
}) {
  const numero = whatsappDePedidos();

  // Dos motivos para no salir, y los dos son del sistema: el administrador lo
  // apagó, o no hay celular puesto. Un botón que escribe a un número que nadie
  // lee es peor que no tener botón.
  if (variante.pedirPorWhatsapp !== true || numero === null) return null;

  // La plantilla vive en `mensajeDePedido`, abajo, y aquí se llama. Escrita
  // dos veces, la prueba vigilaría una copia y la clienta recibiría la otra.
  const mensaje = mensajeDePedido(variante, agotado);

  return (
    <a
      href={`https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`}
      target="_blank"
      rel="noopener noreferrer"
      // El nombre accesible EMPIEZA por el texto que se ve en el botón. Decía
      // «Pedir <nombre> por WhatsApp» mientras el botón decía «Pedir por
      // WhatsApp»: el texto visible no estaba dentro del nombre, así que quien
      // maneja el teléfono por voz pedía un botón que el sistema no encontraba.
      // WCAG 2.5.3, Nivel A.
      aria-label={
        agotado
          ? `Avísenme cuando entre: ${variante.nombre}`
          : `Pedir por WhatsApp: ${variante.nombre}`
      }
      className={buttonVariants({ variant: agotado ? 'outline' : 'accent' })}
    >
      {agotado ? 'Avísenme cuando entre' : 'Pedir por WhatsApp'}
    </a>
  );
}

/**
 * El texto del mensaje: UN dueño, y es esta función.
 *
 * Está aparte del JSX para poder probarlo.
 *
 * Lo que de verdad hay que vigilar de este botón es que el mensaje no lleve un
 * precio, y eso se comprueba sobre el texto. Con la plantilla dentro del JSX
 * haría falta un navegador para leerla, y las pruebas de la web corren en
 * Node: la regla se quedaría sin vigilar justo donde más cuesta un error.
 */
export const mensajeDePedido = (
  variante: Pick<VariantePublica, 'codigo' | 'nombre'>,
  agotado = false,
): string =>
  agotado
    ? `Hola Baby Caleb, avísenme cuando entre: ${variante.nombre} (${variante.codigo})`
    : `Hola Baby Caleb, quiero pedir: ${variante.nombre} (${variante.codigo})`;
