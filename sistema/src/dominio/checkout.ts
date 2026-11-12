/**
 * ¿Puede la web cobrar hoy? Un solo sitio que lo conteste.
 *
 * ## Por qué existe este archivo
 *
 * `ajustes.checkout_activo` valía `true` en producción y **ningún código lo
 * consultaba**. Ni la web ni el Worker ni el panel: aparecía solo en
 * comentarios. O sea que la dueña podía encender ese interruptor y no pasaba
 * nada, y podía apagarlo y tampoco. El carrito terminaba en un mensaje de
 * WhatsApp en los dos casos.
 *
 * Eso no es un hueco de funcionalidad: es un ajuste que **dice controlar algo
 * que no controla**, que es peor que no tener el ajuste. Si la dueña lo
 * enciende creyendo que abrió el cobro en línea, deja de mirar por qué no
 * entran pagos. Está escrito en docs/TRAMPAS.md §13.
 *
 * ## Las dos salidas honestas, y cuál se tomó
 *
 * (a) **Conectarlo**: que la web lo consulte y que el carrito cambie de
 *     comportamiento. Para eso hace falta un cobro al que mandar a la clienta,
 *     y hoy hay **tres pasarelas y cero credenciales** —la afiliación de
 *     Tilopay se envió el 2026-11-11 y está en revisión; Yappy y PayPal
 *     esperan trámites de la dueña (docs/plan/04-pagos.md §9)—. Un botón
 *     «Pagar» que lleve a una pasarela sin credenciales es una mentira más
 *     grande que la de ahora, porque esta la descubre la clienta.
 *
 * (b) **Que el ajuste diga la verdad**: que se vea que está encendido y
 *     todavía inerte, y POR QUÉ. Es la que se tomó.
 *
 * Y se tomó de forma que no haya que acordarse de deshacerla: el veredicto NO
 * es un texto escrito a mano que mañana nadie actualice. Se **calcula de los
 * datos** —el interruptor, qué pasarelas están encendidas, cuáles tienen sus
 * credenciales completas y en qué modo están—, así que el día que una pasarela
 * esté lista, la pantalla deja de decir «inerte» sin que nadie toque una línea
 * de este archivo.
 *
 * ## Puro: ni D1, ni red, ni `env`
 *
 * Lo cargan el servidor (la ruta `GET /checkout` y la herramienta
 * `ver_checkout` del asistente) y el panel, que corre en un teléfono. Quien lee
 * la base es `src/db/pasarelas.ts` y `src/db/ajustes.ts`; aquí solo se decide.
 *
 * ## Aquí NO hay cifras del negocio
 *
 * Ni comisiones, ni montos, ni plazos. Este módulo no sabe cuánto cuesta nada:
 * solo si hay con qué cobrar.
 */

/**
 * Si el carrito de la web sabe, HOY, mandar a una clienta a pagar.
 *
 * No es una preferencia ni un interruptor: es un hecho sobre el código que hay
 * desplegado. Hoy `src/pages/Carrito.tsx` termina en un mensaje de WhatsApp y
 * no llama a ninguna ruta que cree un pedido, así que aunque mañana una
 * pasarela estuviera lista, la web seguiría sin cobrar.
 *
 * Está declarado aquí —y no dado por supuesto en un texto de la pantalla—
 * porque el veredicto de abajo tiene que poder decirlo. Y está **vigilado por
 * una máquina**: `test/node/checkout-de-la-web.test.ts` lee el carrito de
 * verdad y se pone rojo si esta constante y ese archivo dejan de coincidir, en
 * cualquiera de las dos direcciones. Sin esa prueba sería justo la clase de
 * lista que alguien tiene que acordarse de tocar (docs/TRAMPAS.md §8).
 */
export const LA_WEB_TIENE_CHECKOUT = false;

/** Los dos modos de una pasarela. Copiados de `dominio/pasarelas.ts`. */
export type ModoDePasarela = "prueba" | "real";

/** Lo que hay que saber de una pasarela para decidir si se puede cobrar. */
export interface PasarelaParaCobrar {
  readonly pasarela: string;
  /** Como se lee en pantalla: «Yappy · Botón de Pago». */
  readonly titulo: string;
  /** De `ajustes.pasarelas_activas`, su único dueño. */
  readonly encendida: boolean;
  /** Si el juego de credenciales DEL MODO EN QUE ESTÁ está completo. */
  readonly completa: boolean;
  readonly modo: ModoDePasarela;
  /** Los títulos de las credenciales que le faltan en su modo. */
  readonly faltan: readonly string[];
}

export interface EstadoDelCheckout {
  /** Lo que vale `ajustes.checkout_activo`: la intención de la dueña. */
  readonly interruptor: boolean;
  /** Si la web puede cobrar de verdad ahora mismo. */
  readonly cobra: boolean;
  /**
   * Encendido y sin efecto.
   *
   * Es el estado que este módulo existe para hacer visible. `inerte` es
   * `interruptor && !cobra`: apagado no es inerte, es apagado.
   */
  readonly inerte: boolean;
  /** Las pasarelas que podrían cobrar dinero de verdad hoy. */
  readonly listas: readonly string[];
  /**
   * Las que están encendidas y completas pero EN PRUEBA.
   *
   * Van aparte y no cuentan como listas: un cobro hecho con credenciales de
   * prueba deja a la clienta con un pedido que nadie pagó
   * (`dominio/pasarelas.ts`, «prueba y real son DOS JUEGOS»).
   */
  readonly enPrueba: readonly string[];
  /** Qué falta, en español, en el orden en que hay que resolverlo. */
  readonly impedimentos: readonly string[];
  /** Una frase para la pantalla. Siempre dice qué está pasando de verdad. */
  readonly resumen: string;
}

/**
 * El veredicto.
 *
 * `cobra` exige las tres cosas a la vez, y ninguna se puede dar por supuesta:
 *
 *  1. que la dueña lo haya encendido (`interruptor`);
 *  2. que haya al menos una pasarela encendida, completa y **en modo real**;
 *  3. que el carrito de la web sepa mandar a pagar (`LA_WEB_TIENE_CHECKOUT`).
 *
 * Falla hacia el lado que no mueve dinero: cualquier duda da `false`.
 */
export function estadoDelCheckout(entrada: {
  readonly interruptor: boolean;
  readonly pasarelas: readonly PasarelaParaCobrar[];
  /** Se pasa para poder probarlo en los dos estados; por defecto, el de hoy. */
  readonly webTieneCheckout?: boolean;
}): EstadoDelCheckout {
  const webTieneCheckout = entrada.webTieneCheckout ?? LA_WEB_TIENE_CHECKOUT;

  const listas = entrada.pasarelas
    .filter((p) => p.encendida && p.completa && p.modo === "real")
    .map((p) => p.titulo);
  const enPrueba = entrada.pasarelas
    .filter((p) => p.encendida && p.completa && p.modo === "prueba")
    .map((p) => p.titulo);

  const impedimentos: string[] = [];

  if (!entrada.interruptor) {
    impedimentos.push(
      "El interruptor «Pagar desde la web» está apagado. Mientras lo esté, la web no va a cobrar aunque todo lo demás esté listo.",
    );
  }

  if (listas.length === 0) {
    // Primero el porqué general, y después CUÁL falta y QUÉ le falta. Decir
    // «configuración incompleta» a secas deja a la dueña abriendo pasarelas
    // una por una a ver cuál es.
    const encendidas = entrada.pasarelas.filter((p) => p.encendida);
    if (encendidas.length === 0) {
      impedimentos.push(
        "Ninguna pasarela está encendida, así que no hay con qué cobrar. Se encienden una por una en Pasarelas de cobro, después de un cobro real de prueba y su reembolso.",
      );
    }
    for (const p of encendidas) {
      if (!p.completa) {
        impedimentos.push(
          p.faltan.length === 0
            ? `${p.titulo} está encendida pero su configuración no está completa.`
            : `A ${p.titulo} le falta ${p.faltan.map((f) => `«${f}»`).join(" y ")}.`,
        );
      } else if (p.modo === "prueba") {
        impedimentos.push(
          `${p.titulo} está en modo de prueba: cobraría con credenciales de prueba, o sea que la clienta quedaría con un pedido que nadie pagó.`,
        );
      }
    }
    // Y las que no están encendidas pero tampoco se podrían encender: es lo
    // que de verdad hay que resolver primero, y nombra el trámite.
    const sinCredenciales = entrada.pasarelas.filter((p) => !p.encendida && !p.completa);
    if (encendidas.length === 0 && sinCredenciales.length > 0) {
      impedimentos.push(
        `A ninguna de las ${sinCredenciales.length} pasarelas se le han puesto todavía sus credenciales: ${sinCredenciales
          .map((p) => p.titulo)
          .join(", ")}. Las da cada pasarela cuando aprueba el comercio.`,
      );
    }
  }

  if (!webTieneCheckout) {
    impedimentos.push(
      "El carrito de la web todavía no sabe mandar a pagar: termina en un mensaje de WhatsApp con el pedido ya escrito. Eso se programa cuando haya una pasarela con la que probarlo.",
    );
  }

  const cobra = entrada.interruptor && listas.length > 0 && webTieneCheckout;
  const inerte = entrada.interruptor && !cobra;

  return {
    interruptor: entrada.interruptor,
    cobra,
    inerte,
    listas,
    enPrueba,
    impedimentos,
    resumen: resumirlo(entrada.interruptor, cobra, inerte, listas),
  };
}

function resumirlo(
  interruptor: boolean,
  cobra: boolean,
  inerte: boolean,
  listas: readonly string[],
): string {
  if (cobra) {
    return `La web cobra con ${listas.join(" y ")}.`;
  }
  if (inerte) {
    // La frase que faltaba. Antes la pantalla decía «Encendido» y punto, que
    // es verdad sobre el valor guardado y mentira sobre lo que pasa.
    return "Encendido, pero todavía sin efecto: la web no cobra. Abajo está lo que falta.";
  }
  if (interruptor) {
    // No debería llegar aquí —si está encendido y no cobra, es inerte— pero un
    // «—» en una pantalla de dinero no es una respuesta.
    return "Encendido. La web no cobra.";
  }
  return "Apagado. La web enseña el catálogo y el pedido se cierra por WhatsApp.";
}
