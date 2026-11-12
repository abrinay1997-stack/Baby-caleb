import { z } from "zod";
import { leerVigentes } from "../../db/ajustes";
import { crearPedido } from "../../db/pedidos";
import { confirmarCotizacion } from "../../db/transiciones";
import { clienteDeReferencia, PATRON_REFERENCIA } from "../referencias";
import { definir } from "../registro";

/**
 * Las cotizaciones por MCP.
 *
 * ## Por qué están aquí y no «para después»
 *
 * La regla del dueño, en `CLAUDE.md` y en docs/TRAMPAS.md §13: una capacidad
 * nueva **no está terminada hasta que se puede usar también por MCP**, en el
 * mismo cambio. Las dos rutas de cotizaciones nacen con su herramienta; no
 * entran en `COBERTURA` como «PENDIENTE».
 *
 * ## Las clientas, hacia el modelo, son una referencia
 *
 * Decisión D-20: al modelo no le llegan datos personales de clientas. Por eso
 * `crear_cotizacion` recibe una referencia (`C-0042`) y no un nombre ni un
 * celular, y por eso lo que devuelve no lleva el nombre de nadie — el panel y
 * Telegram lo ponen después, con `ponerLosNombres`. Es lo que `revisar()`
 * comprueba sobre TODAS las herramientas registradas.
 *
 * ## Qué NO se puede hacer desde aquí
 *
 * Cambiar un precio de una cotización ya hecha. No es un olvido: los precios de
 * una cotización los puso el servidor desde el catálogo y volver a tocarlos
 * sería dejar de cotizar. Si el precio tiene que ser otro, se cambia en el
 * catálogo (`cambiar_precio`, que es sensible y la confirma una persona) y se
 * hace una cotización nueva.
 */

const referencia = z
  .string()
  .regex(PATRON_REFERENCIA, "la clienta se nombra con su referencia, como C-0042")
  .describe("La referencia de la clienta, como C-0042. Nunca su nombre ni su celular.");

const lineas = z
  .array(
    z.object({
      codigo: z.string().min(1).max(40).describe("El código del artículo, como NAT-M."),
      cantidad: z.number().int().positive().max(10_000).describe("Cuántas cajas."),
    }),
  )
  .min(1)
  .max(50)
  .describe("Qué lleva. Aquí NO van precios: los pone el servidor desde el catálogo.");

/**
 * El motivo, que el catálogo exige a todo lo que escribe.
 *
 * No es burocracia ni aquí: una cotización que nadie pidió, o una confirmación
 * que apartó mercancía sin explicación, es justo lo que nadie puede auditar
 * dentro de un mes. Queda en `pedido_eventos` y no se borra.
 */
const motivo = z
  .string()
  .min(3)
  .max(200)
  .describe("Por qué se hace. Queda escrito en la bitácora del documento.");

export const crearCotizacion = definir({
  nombre: "crear_cotizacion",
  descripcion:
    "Hace una cotización: un pedido que todavía NO aparta mercancía, con los precios del catálogo de hoy. Sirve para pasarle un total a una clienta sin quitarle el stock a nadie, y se puede cotizar incluso lo que está agotado. Ejemplo: crear_cotizacion con clienta «C-0042» y lineas [{codigo: «NAT-M», cantidad: 2}]. Al confirmarla con confirmar_cotizacion se convierte en pedido y es ENTONCES cuando se aparta el inventario.",
  parametros: z.object({
    clienta: referencia,
    lineas,
    zona: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("El nombre de la zona de envío, si ya se sabe. Sin zona, el envío se cotiza aparte."),
    notas: z.string().max(500).optional().describe("Lo que pidió la clienta, en sus palabras."),
    motivo,
  }),
  nivel: "construccion",
  categoria: "pedidos",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const clienta = await clienteDeReferencia(ctx.db, args.clienta);
    if (clienta === null) throw new Error(`no existe la clienta ${args.clienta}`);
    // Solo el id: el nombre viene en la misma fila y no se usa a propósito —
    // lo que sale de esta herramienta va al modelo.
    const clienteId = clienta.id;

    // Las reglas se LEEN de ajustes; aquí no se inventa ninguna, igual que en
    // la ruta del panel. `abono_minimo_cents` no admite PENDIENTE, así que
    // siempre hay número; los días de validez de una cotización sí, y sin
    // decidir la cotización no caduca.
    const vigentes = await leerVigentes({ db: ctx.db, ahora: ctx.ahora });
    if (!vigentes.ok) throw new Error(vigentes.mensaje);
    const de = (clave: string) => vigentes.datos.ajustes.find((a) => a.clave === clave);

    const abono = de("abono_minimo_cents");
    if (abono === undefined || abono.pendiente || typeof abono.valor !== "number") {
      throw new Error("falta decidir el abono mínimo en Configuración › Ajustes");
    }
    const dias = de("cotizacion_dias_validez");
    const minutosDeValidezCotizacion =
      dias === undefined || dias.pendiente || typeof dias.valor !== "number"
        ? null
        : dias.valor * 24 * 60;

    const r = await crearPedido(
      {
        db: ctx.db,
        ahora: ctx.ahora,
        actor: ctx.usuario.id,
        abonoMinimoCents: abono.valor,
        // Una cotización no usa este reloj, pero el contrato lo pide: lo que
        // vale aquí es `minutosDeValidezCotizacion`.
        minutosParaAbonar: null,
        minutosDeValidezCotizacion,
      },
      {
        // Una por llamada: el id de la acción del asistente no sirve porque
        // una lectura previa puede repetirse; la hora con el cliente sí
        // distingue dos cotizaciones seguidas a la misma clienta.
        idempotencia: `asistente-${ctx.canal}-${clienteId}-${ctx.ahora}`,
        clienteId,
        origen: ctx.canal === "telegram" ? "telegram" : "panel",
        cotizacion: true,
        lineas: args.lineas,
        motivo: args.motivo,
        ...(args.zona === undefined ? {} : { zona: args.zona }),
        ...(args.notas === undefined ? {} : { notasCliente: args.notas }),
      },
    );
    if (!r.ok) throw new Error(r.mensaje);

    // Sin el nombre de la clienta: lo que sale de aquí va al modelo.
    return {
      numero: r.datos.numero,
      clienta: args.clienta,
      total_cents: r.datos.totalCents,
      envio_cents: r.datos.envioCents,
      estado: r.datos.estado,
      aparto_inventario: r.datos.aparto,
      vence_en: r.datos.venceEn,
    };
  },
});

export const confirmarCotizacionHerramienta = definir({
  nombre: "confirmar_cotizacion",
  descripcion:
    "Confirma una cotización: se convierte en el pedido BC-xxxxxx que esperaba, con los MISMOS precios, y es aquí donde se aparta el inventario. Si ya no hay existencias lo dice nombrando el artículo y la cotización se queda como estaba, sin convertirse. Ejemplo: confirmar_cotizacion con numero «BC-000123».",
  parametros: z.object({
    numero: z
      .string()
      .min(3)
      .max(40)
      .describe("El número del documento, como BC-000123."),
    motivo,
  }),
  nivel: "construccion",
  categoria: "pedidos",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    // El asistente habla de números («BC-000123») y el motor de ids: esta es
    // la única traducción. Confirmar lo hace `confirmarCotizacion`, el mismo
    // que llama el panel — dos caminos hacia el inventario acabarían
    // discrepando.
    const fila = await ctx.db
      .prepare("SELECT id FROM pedidos WHERE numero = ?")
      .bind(args.numero.trim().toUpperCase())
      .first<{ id: string }>();
    if (fila === null) throw new Error(`no existe el documento ${args.numero}`);

    const r = await confirmarCotizacion(
      { db: ctx.db, ahora: ctx.ahora, actor: ctx.usuario.id },
      fila.id,
      args.motivo,
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      numero: r.datos.numero,
      estado: "por_abonar",
      piezas_apartadas: r.datos.apartadas,
    };
  },
});

export const HERRAMIENTAS_DE_COTIZACIONES = [
  crearCotizacion,
  confirmarCotizacionHerramienta,
] as const;
