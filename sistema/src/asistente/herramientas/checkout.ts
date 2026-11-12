import { z } from "zod";
import { verCheckout } from "../../db/checkout";
import { definir } from "../registro";

/**
 * «¿Se puede pagar en la página?», por MCP.
 *
 * Existe por la regla del dueño (`CLAUDE.md`, docs/TRAMPAS.md §13): una
 * capacidad nueva no está terminada hasta que se puede usar también por MCP,
 * en el mismo cambio. La ruta `GET /checkout` nació con esta herramienta al
 * lado, y las dos leen `verCheckout` — dos cálculos del mismo veredicto
 * acabarían discrepando, y el que se equivoca del lado flojo es el que nadie
 * revisa.
 *
 * Y existe por una segunda razón, más concreta: `ajustes.checkout_activo`
 * valía `true` en producción y ningún código lo consultaba. La pregunta que
 * nadie podía hacerle al sistema era justo esta.
 */
export const verCheckoutHerramienta = definir({
  nombre: "ver_checkout",
  descripcion:
    "Dice si la web puede cobrar en línea ahora mismo y, si no, qué falta exactamente. Contesta «¿se puede pagar en la página?» sin tener que abrir el panel. Distingue el interruptor de Ajustes de lo que ese interruptor está consiguiendo: puede estar encendido y no cobrar nada.",
  parametros: z.object({}),
  nivel: "lectura",
  categoria: "ajustes",
  roles: ["duena", "asistente"],

  async ejecutar(ctx) {
    // Sin la llave maestra: el asistente no tiene acceso a los secretos del
    // Worker. `verCheckout` devuelve `llave_maestra_puesta: null` —«no se
    // preguntó»— y aquí no se reenvía, porque un dato que no se comprobó no
    // tiene por qué viajar al modelo.
    const r = await verCheckout({ db: ctx.db, ahora: ctx.ahora });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      cobra_la_web: r.datos.cobra,
      interruptor_encendido: r.datos.interruptor,
      encendido_pero_sin_efecto: r.datos.inerte,
      pasarelas_listas: r.datos.listas,
      pasarelas_en_prueba: r.datos.enPrueba,
      que_falta: r.datos.impedimentos,
      /**
       * El veredicto en una línea, y se llama `aviso` a propósito.
       *
       * Es la convención del catálogo: `aviso` es lo que hay que decirle al
       * modelo aunque la respuesta parezca completa, y lo vigila
       * `fronteras.test.ts` —ninguna herramienta de lectura contesta sin
       * explicarse—. Aquí siempre hay algo que explicar, porque la pregunta
       * «¿cobra la web?» admite un «sí» y varios «no» distintos, y un `false`
       * a secas se lee como «está roto» cuando lo que pasa es que faltan
       * trámites.
       */
      aviso: r.datos.resumen,
    };
  },
});

export const HERRAMIENTAS_DE_CHECKOUT = [verCheckoutHerramienta] as const;
