import { z } from "zod";
import { definir } from "../registro";

/**
 * «Ya pagué» — y el sistema dice que no.
 *
 * Esta herramienta existe para esa conversación, que va a pasar. Una clienta
 * paga por Yappy, le sale bien en su teléfono, y el pedido sigue diciendo que
 * no se ha pagado. La dueña necesita saber UNA cosa para contestarle: **¿llegó
 * el aviso de Yappy, y qué decía?**
 *
 * Sin esto, la única forma de averiguarlo es abrir los registros del Worker en
 * Cloudflare, que la dueña no usa, o adivinar. Y adivinar aquí tiene dos
 * finales malos: entregar algo que nadie pagó, o dejar a una clienta que sí
 * pagó esperando.
 *
 * Las tres respuestas posibles, y lo que significa cada una:
 *
 *  · **No llegó ningún aviso.** El pago no terminó en el teléfono de la
 *    clienta, o la solicitud venció. Que lo intente otra vez.
 *  · **Llegó y decía «rechazado», «cancelado» o «expirado».** El pago no se
 *    hizo, y ahora se sabe POR QUÉ: no confirmó a tiempo, lo canceló, o nunca
 *    lo empezó. Son tres respuestas distintas para la clienta.
 *  · **Llegó, decía «ejecutado», y el pedido sigue sin pagar.** Eso es un
 *    problema de verdad y hay que mirarlo: lo dice con todas las letras en vez
 *    de dejarlo pasar.
 *
 * Es de LECTURA: no mueve un centavo ni cambia el estado de nada.
 */

const numeroDePedido = z
  .string()
  .min(1)
  .describe("El número del pedido, como «BC-000104». También vale la referencia del cobro.");

interface FilaAviso {
  readonly evento_id: string;
  readonly proveedor: string;
  readonly resultado: string | null;
  readonly recibido_en: number;
  readonly firma_valida: number;
  readonly intento_ref: string | null;
  readonly estado_pago: string | null;
  readonly monto_cents: number | null;
  readonly numero: string | null;
  readonly pagado_cents: number | null;
  readonly total_cents: number | null;
}

/** Qué significa cada estado, en una frase que sirva para contestarle a alguien. */
const QUE_SIGNIFICA: Readonly<Record<string, string>> = {
  ejecutado: "la clienta confirmó el pago y Yappy lo dio por hecho",
  aprobado: "la pasarela aprobó el cobro",
  rechazado: "no se confirmó a tiempo: la solicitud de Yappy dura cinco minutos",
  cancelado: "la clienta canceló el pago en la app",
  expirado: "la solicitud venció sin que se empezara el pago",
  pendiente: "la pasarela todavía no ha dicho cómo terminó",
};

/**
 * SE LLAMA «de pago» Y NO «de cobro», Y NO ES CAPRICHO.
 *
 * `registro.test.ts` tiene un guardia que exige que toda herramienta cuyo
 * nombre contenga «cobro» sea de nivel `sensible` — o sea, que una persona la
 * permita antes de que corra. Es un control del dinero y está bien que sea
 * amplio: prefiere marcar de más.
 *
 * Ésta es de LECTURA y no mueve un centavo, así que marcarla es un falso
 * positivo del guardia. Pero aflojar un control del dinero para que quepa un
 * nombre es el peor cambio de los dos posibles: el guardia protege contra algo
 * que cuesta dinero, y el nombre no cuesta nada. Así que se renombra.
 *
 * Y de paso el nombre queda mejor: Yappy llama a esto «notificación de pago»
 * (IPN), no «aviso de cobro».
 */
export const verAvisosDePago = definir({
  nombre: "ver_avisos_de_pago",
  descripcion:
    "Qué avisos mandó la pasarela sobre los cobros de un pedido, y qué decían. Es para cuando una clienta dice que ya pagó y el pedido sigue sin pagar: contesta si el aviso llegó, qué estado traía y si se aplicó. Ejemplo: ver_avisos_de_pago con pedido «BC-000104». No cambia nada.",
  parametros: z.object({ pedido: numeroDePedido }),
  nivel: "lectura",
  categoria: "dinero",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const buscado = args.pedido.trim();

    /**
     * Se busca por el NÚMERO del pedido o por la referencia del cobro.
     *
     * La dueña tiene a mano el número del pedido; en el panel de Yappy lo que
     * se ve es la referencia. Aceptar las dos evita que tenga que traducir
     * entre pantallas, que es justo donde se cometen los errores cuando hay
     * una clienta esperando al otro lado.
     */
    const { results } = await ctx.db
      .prepare(
        `SELECT e.evento_id, e.proveedor, e.resultado, e.recibido_en, e.firma_valida,
                p.intento_ref, p.estado AS estado_pago, p.monto_cents,
                pe.numero, pe.pagado_cents, pe.total_cents
           FROM eventos_pasarela e
           LEFT JOIN pagos p   ON e.evento_id LIKE '%' || p.intento_ref || '%'
           LEFT JOIN pedidos pe ON pe.id = p.pedido_id
          WHERE pe.numero = ?1 OR p.intento_ref = ?1
          ORDER BY e.recibido_en DESC
          LIMIT 50`,
      )
      .bind(buscado)
      .all<FilaAviso>();

    if (results.length === 0) {
      /**
       * No encontrar nada NO es un error, y la diferencia importa.
       *
       * «No llegó ningún aviso» es una respuesta útil —significa que el pago
       * no terminó— y lanzar un error la convertiría en «algo falló», que
       * manda a la dueña a buscar un problema técnico que no existe.
       * (`docs/TRAMPAS.md` §7: cero no es «no se sabe».)
       */
      const hayPedido = await ctx.db
        .prepare("SELECT numero, pagado_cents FROM pedidos WHERE numero = ?")
        .bind(buscado)
        .first<{ numero: string; pagado_cents: number }>();

      return {
        pedido: buscado,
        avisos: 0,
        existe_el_pedido: hayPedido !== null,
        /**
         * El campo se llama `aviso` porque es el del contrato.
         *
         * `fronteras.test.ts` exige que TODA herramienta de lectura que vuelve
         * sin nada explique por qué, en un campo con ese nombre exacto. Lo
         * había escrito como `que_significa`, que dice lo mismo y no lo
         * cumple: el valor estaba, pero quien lo lee —la prueba, y el modelo—
         * busca `aviso`.
         */
        aviso:
          hayPedido === null
            ? "No existe ningún pedido ni cobro con esa referencia. Revise el número."
            : "No ha llegado ningún aviso de la pasarela para ese pedido. O el pago no se terminó en el teléfono de la clienta, o la solicitud venció. Lo que corresponde es que lo intente otra vez.",
      };
    }

    const avisos = results.map((f) => ({
      cuando: new Date(f.recibido_en).toISOString(),
      pasarela: f.proveedor,
      decia: f.resultado ?? "sin estado",
      que_significa: QUE_SIGNIFICA[f.resultado ?? ""] ?? "estado que el sistema no conoce",
      referencia_del_cobro: f.intento_ref,
      // Lo que importa de verdad: si el aviso se aplicó o no.
      el_cobro_quedo: f.estado_pago ?? "sin cobro asociado",
      monto_cents: f.monto_cents,
    }));

    const ultimo = results[0]!;
    const dijoQueSi = (ultimo.resultado ?? "") === "ejecutado" || (ultimo.resultado ?? "") === "aprobado";
    const elPedidoEstaPagado = (ultimo.pagado_cents ?? 0) >= (ultimo.total_cents ?? 1);

    return {
      pedido: ultimo.numero ?? buscado,
      avisos: avisos.length,
      avisos_recientes: avisos,
      pagado_cents: ultimo.pagado_cents,
      total_cents: ultimo.total_cents,
      /**
       * EL CASO QUE HAY QUE GRITAR.
       *
       * La pasarela dijo que cobró y el pedido sigue sin pagarse. Eso no se
       * arregla solo y no se puede dejar pasar en una lista de avisos: puede
       * ser que el monto no cuadrara —y entonces hay dinero cobrado que no se
       * aplicó a propósito, esperando que alguien lo mire— o un fallo al
       * escribir. Las dos cosas acaban con una clienta que pagó y no tiene
       * pedido.
       */
      hay_que_mirarlo: dijoQueSi && !elPedidoEstaPagado,
      /**
       * El veredicto se llama `aviso` en los DOS caminos.
       *
       * Lo había escrito como `que_significa` cuando hay resultados y como
       * `aviso` cuando no, y eso es peor que elegir mal uno de los dos: quien
       * lo lee —el modelo, y la prueba— tiene que saber en qué caso está para
       * saber qué campo mirar. El detalle por renglón sí se queda como
       * `que_significa`, que es otra cosa: explica UN aviso, no la situación.
       */
      aviso:
        dijoQueSi && !elPedidoEstaPagado
          ? "LA PASARELA DIJO QUE COBRÓ Y EL PEDIDO SIGUE SIN PAGARSE. Eso no se arregla solo: puede que el monto no cuadrara con el del pedido —y entonces el cobro se dejó sin aplicar a propósito, esperando que una persona lo mire— o que fallara al escribirse. Revíselo en el panel de la pasarela antes de entregar nada."
          : dijoQueSi
            ? "El aviso llegó, la pasarela dijo que cobró, y el pedido quedó pagado."
            : `El último aviso decía «${ultimo.resultado ?? "sin estado"}»: ${QUE_SIGNIFICA[ultimo.resultado ?? ""] ?? "estado que el sistema no conoce"}. El pago no se hizo.`,
    };
  },
});

export const HERRAMIENTAS_DE_AVISOS = [verAvisosDePago];
