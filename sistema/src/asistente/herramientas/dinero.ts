import { z } from "zod";
import { type Inventario, resumenDelNegocio } from "../../db/metricas";
import {
  METODOS_MANUALES,
  comprobantesPorConfirmar,
  confirmarPago,
  rechazarPago,
  registrarComprobante,
} from "../../db/pagos";
import { formatear } from "../../dominio/dinero";
import { esNombrePeriodo } from "../../dominio/metricas";
import { definir, type Contexto } from "../registro";
import { referenciasPorPedido } from "./pedidos";

/**
 * El dinero: la bandeja de comprobantes, el cobro y la portada del negocio.
 *
 * Cinco rutas del panel que no se podían usar por MCP (trampa §13): la bandeja
 * de comprobantes, anotar uno, confirmarlo, rechazarlo y el resumen. Las
 * cuatro primeras son el módulo de cobros, que estuvo escrito y probado desde
 * F4.4 **sin una sola ruta** —un comprobante entraba en «confirmando» y se
 * quedaba ahí para siempre— y que ahora tampoco tenía puerta por MCP: la misma
 * trampa §12, un piso más arriba.
 *
 * LA REGLA QUE MANDA AQUÍ: EL NAVEGADOR NO DECIDE UN PAGO
 *
 * Y tampoco lo decide el modelo. Una captura que manda una clienta es una
 * AFIRMACIÓN, no un cobro: puede estar recortada, ser de otro pedido, ser de
 * ayer o ser de otra persona. Así que:
 *
 *  - `registrar_cobro` deja el pago en «confirmando» y NO suma nada. Eso no lo
 *    decide esta herramienta: lo hace `registrarComprobante`, el mismo que
 *    llama el panel.
 *  - `confirmar_abono` y `rechazar_cobro` son **sensibles**, así que el
 *    asistente no las ejecuta: las propone con el monto exacto y espera a que
 *    una persona toque «Permitir». Entre el modelo y el dinero hay siempre un
 *    dedo humano.
 *  - La CAPTURA no sale por ninguna. `GET /cobros/:pagoId/comprobante` se
 *    queda solo en el panel y está dicho en `scripts/sin-mcp.mjs`: es una
 *    imagen de una clienta, y quien confirma tiene que MIRARLA — por eso se
 *    confirma desde el panel y el asistente solo dice cuáles esperan.
 *
 * Y nada de una clienta sale hacia el modelo (D-20): en la bandeja, cada
 * comprobante dice de qué pedido es y de qué referencia (`C-0042`), nunca de
 * quién. El nombre lo pone el panel al mostrar la respuesta.
 *
 * El «motivo» de `registrar_cobro` y `confirmar_abono` no tiene columna propia
 * —`rechazarPago` sí lo escribe— y aun así se pide: queda en
 * `acciones.argumentos_json`, que un trigger impide editar y borrar, y es lo
 * que lee la persona en la tarjeta antes de permitir. Un cobro sin explicación
 * es un cobro que nadie puede auditar.
 */

const elPago = z
  .string()
  .min(1)
  .max(40)
  .describe("El id del pago. Sale de pagos_por_confirmar.");

const porQue = z
  .string()
  .min(3)
  .max(200)
  .describe("Por qué se hace. Queda en la bitácora de acciones, que no se edita ni se borra.");

/** El contexto que piden las funciones de `src/db/pagos.ts`, con QUIÉN lo hizo. */
const comoElUsuario = (ctx: Contexto) => ({
  db: ctx.db,
  ahora: ctx.ahora,
  // El correo, igual que el panel: es lo que contesta «quién confirmó este
  // pago». No se devuelve nunca.
  actor: ctx.usuario.correo,
});

// ---------------------------------------------------------------------------
// Leer · GET /cobros
// ---------------------------------------------------------------------------

export const pagosPorConfirmar = definir({
  nombre: "pagos_por_confirmar",
  descripcion:
    "Los comprobantes que esperan a que una persona los mire, del más viejo al más nuevo, con el monto, el método y el total del pedido para poder decidir. Ejemplo: pagos_por_confirmar dice que hay tres abonos de Yappy esperando y de qué pedidos son.",
  parametros: z.object({
    cuantos: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Cuántos comprobantes devolver como máximo."),
  }),
  nivel: "lectura",
  categoria: "dinero",
  /**
   * Solo la dueña, que es quien tiene `cobros` en la matriz de `roles.ts` —el
   * mismo permiso que `exige("cobros")` en el panel—. La asistente lleva
   * pedidos y gastos y no ve lo que entró; la contadora tampoco tiene `cobros`.
   */
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await comprobantesPorConfirmar(ctx.db, args.cuantos);
    if (!r.ok) return { comprobantes: [], cuantos: 0, hayMas: false, aviso: r.mensaje };

    // `comprobantesPorConfirmar` trae el NOMBRE de la clienta, porque es lo que
    // pinta el panel. Aquí se traduce a su referencia y el nombre se queda.
    const referencias = await referenciasPorPedido(
      ctx.db,
      r.datos.comprobantes.map((c) => c.pedidoId),
    );

    return {
      comprobantes: r.datos.comprobantes.map((c) => ({
        pago: c.pagoId,
        pedidoId: c.pedidoId,
        numero: c.numero,
        clienta: referencias.get(c.pedidoId) ?? null,
        montoCents: c.montoCents,
        monto: formatear(c.montoCents),
        metodo: c.metodo,
        tipo: c.tipo,
        /**
         * Si hay captura, no cuál es.
         *
         * La clave de R2 tampoco sale: apunta a una imagen de una clienta y lo
         * único que el modelo necesita saber es si quien confirme tendrá algo
         * que mirar. Mirarlo es trabajo del panel.
         */
        tieneCaptura: c.comprobanteR2 !== null,
        creadoEn: c.creadoEn,
        totalCents: c.totalCents,
        total: formatear(c.totalCents),
        pagadoCents: c.pagadoCents,
        pagado: formatear(c.pagadoCents),
        // El saldo se dice hecho y no se deja deducir: «¿este abono completa lo
        // que falta?» es la pregunta de la bandeja, y una resta que hace el
        // modelo es una resta que a veces sale mal.
        saldoCents: c.totalCents - c.pagadoCents,
        saldo: formatear(c.totalCents - c.pagadoCents),
        estadoPedido: c.estadoPedido,
      })),
      cuantos: r.datos.comprobantes.length,
      hayMas: r.datos.hayMas,
      aviso:
        r.datos.comprobantes.length === 0
          ? "no hay ningún comprobante esperando confirmación. La bandeja está al día."
          : "para confirmar hay que MIRAR la captura, y eso se hace en el panel: desde aquí se ve cuáles esperan y por cuánto.",
    };
  },
});

// ---------------------------------------------------------------------------
// Escribir · POST /cobros, /cobros/:pagoId/confirmar y /cobros/:pagoId/rechazar
// ---------------------------------------------------------------------------

export const registrarCobro = definir({
  nombre: "registrar_cobro",
  descripcion:
    "Anota que alguien dice haber pagado. El monto va en CENTAVOS: $30.00 son 3000. NO suma nada al pedido: el pago queda «confirmando» hasta que una persona lo confirme. Ejemplo: registrar_cobro con pedido «BC-000123», monto_cents 3000, metodo «yappy», tipo «abono» y motivo «mandó la captura por WhatsApp».",
  parametros: z.object({
    pedidoId: z
      .string()
      .min(1)
      .max(40)
      .describe("El id del pedido. Sale de buscar_pedido o de ver_pedido."),
    monto_cents: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .describe("Cuánto dice que pagó, en centavos. $30.00 son 3000."),
    // Los métodos salen de `METODOS_MANUALES`, que es quien los define. Si
    // mañana entra uno nuevo, esta herramienta lo acepta sin tocarla.
    metodo: z.enum(METODOS_MANUALES).describe("Cómo pagó."),
    tipo: z
      .enum(["abono", "total", "saldo"])
      .describe("«abono» es una parte, «total» es todo, «saldo» es lo que cobra el motorizado."),
    motivo: porQue,
  }),
  /**
   * Sensible. Anotar un comprobante no mueve el saldo —eso lo hace confirmar—
   * pero es el primer apunte del expediente de un cobro, y el expediente de un
   * cobro no se edita ni se borra: lo que entra se queda. Una persona lo lee
   * antes de que entre.
   */
  nivel: "sensible",
  categoria: "dinero",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await registrarComprobante(comoElUsuario(ctx), {
      // La llave de idempotencia la pone la PANTALLA en el panel. Aquí no hay
      // pantalla, así que se deriva del contenido exactamente igual que hace la
      // ruta `POST /cobros` cuando nadie le manda una: una llave inventada en
      // cada intento sería distinta siempre y el candado no cerraría nada. Con
      // esta, pedirle dos veces lo mismo al asistente escribe UN comprobante.
      idempotencia: `asistente:${args.pedidoId}:${args.monto_cents}:${args.metodo}`,
      pedidoId: args.pedidoId,
      montoCents: args.monto_cents,
      metodo: args.metodo,
      tipo: args.tipo,
      // `comprobanteR2` no se puede pasar desde aquí y es a propósito: subir
      // una imagen es del panel. Un comprobante sin captura es legítimo —el
      // efectivo no tiene captura— y la bandeja lo dice con `tieneCaptura`.
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pago: r.datos.pagoId,
      pedidoId: args.pedidoId,
      estado: r.datos.estado,
      montoCents: args.monto_cents,
      monto: formatear(args.monto_cents),
      // Dicho en voz alta para que el modelo no conteste «ya quedó pagado»: no
      // quedó. Falta que una persona lo mire.
      sumaAlPedido: false,
      loQueFalta: "una persona tiene que mirar la captura y confirmarlo. Hasta entonces el pedido no se mueve.",
    };
  },
});

export const confirmarAbono = definir({
  nombre: "confirmar_abono",
  descripcion:
    "Una persona miró el comprobante y dice que sí: el dinero entra, el pedido suma y, si ya alcanza el abono mínimo, se agenda solo. Ejemplo: confirmar_abono con pago «01K...» y motivo «la captura cuadra con el monto y la fecha».",
  parametros: z.object({ pago: elPago, motivo: porQue }),
  /**
   * Sensible, y de las que más: aquí ENTRA el dinero. El pedido suma, su estado
   * de pago se deriva y puede agendarse — todo en un batch de
   * `confirmarPago`, porque mercancía sin asiento es un descuadre que no se ve
   * hasta el cierre.
   *
   * Confirmar dos veces no cobra dos veces: lo impide el
   * `WHERE … AND estado = 'confirmando'` de allá, y además el trigger de
   * `acciones`, que no deja cerrar una acción dos veces.
   */
  nivel: "sensible",
  categoria: "dinero",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await confirmarPago(comoElUsuario(ctx), args.pago);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pago: args.pago,
      confirmado: true,
      pagadoCents: r.datos.pagadoCents,
      pagado: formatear(r.datos.pagadoCents),
      /** `true` si con esto ya alcanzaba y el pedido entró en la lista de entregas. */
      agendado: r.datos.agendado,
    };
  },
});

export const rechazarCobro = definir({
  nombre: "rechazar_cobro",
  descripcion:
    "Una persona miró el comprobante y dice que no. El pago NO se borra: queda marcado como rechazado con su motivo. Ejemplo: rechazar_cobro con pago «01K...» y motivo «la captura es de otro pedido».",
  parametros: z.object({ pago: elPago, motivo: porQue }),
  /**
   * Sensible aunque no mueva un centavo: es una decisión definitiva sobre el
   * dinero de una clienta. Un pago rechazado no vuelve a «confirmando», y la
   * clienta que insiste en que ya pagó se encuentra con esto. Por eso lo
   * permite una persona y por eso el motivo es obligatorio: sin él, quien lo
   * mire mañana no sabe por qué ella insiste.
   */
  nivel: "sensible",
  categoria: "dinero",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await rechazarPago(comoElUsuario(ctx), args.pago, args.motivo);
    if (!r.ok) throw new Error(r.mensaje);

    return { pago: args.pago, rechazado: true, seBorro: false };
  },
});

// ---------------------------------------------------------------------------
// La portada · GET /resumen
// ---------------------------------------------------------------------------

export const resumenDelDia = definir({
  nombre: "resumen_del_dia",
  descripcion:
    "La portada del negocio: qué espera a una persona hoy (pedidos por abonar, pagos por revisar, entregas), cuántos pedidos y clientas nuevas hay, cómo va el inventario y, con permiso de dinero, cuánto entró y cuánto falta por cobrar. Ejemplo: resumen_del_dia con periodo «hoy» dice qué hay pendiente ahora mismo.",
  parametros: z.object({
    periodo: z
      .string()
      .min(1)
      .max(20)
      .optional()
      .describe("«hoy» o «semana» (los últimos siete días, desde el lunes). Por omisión, hoy."),
  }),
  nivel: "lectura",
  categoria: "dinero",
  /**
   * Todos, igual que la ruta: `GET /resumen` no lleva `exige(...)` porque es lo
   * primero que se abre y un 403 ahí deja el panel sin portada. Los permisos se
   * aplican DENTRO — `resumenDelNegocio` recibe el rol y **no consulta** lo que
   * ese rol no puede ver, así que el bloque llega en `null` y no es que se
   * esconda: es que nunca se le pidió a la base.
   */
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const pedido = args.periodo ?? "hoy";
    // Un periodo que no se entiende cae en «hoy» en vez de fallar, igual que la
    // ruta: esta pantalla tiene que abrir siempre. Lo que no se hace es callar
    // el cambiazo — va en el aviso.
    const vale = esNombrePeriodo(pedido);
    const r = await resumenDelNegocio({ db: ctx.db, ahora: ctx.ahora, rol: ctx.usuario.rol }, vale ? pedido : "hoy");
    if (!r.ok) return { aviso: r.mensaje };

    const d = r.datos;
    return {
      hoy: d.hoy,
      /**
       * La ventana por FECHAS y no por su nombre.
       *
       * El nombre del periodo largo es «semana», y esa palabra lleva dentro
       * «ana». La guarda de D-20 caza los nombres de las clientas por
       * subcadena, así que en cuanto exista una clienta llamada Ana el
       * resultado entero se descartaría por el nombre del periodo. Las fechas
       * dicen lo mismo con más precisión y no pisan ningún nombre.
       */
      desde: d.periodo.desdeFecha,
      hasta: d.periodo.hastaFecha,
      dias: d.periodo.dias,
      comparadoCon: { desde: d.anterior.desdeFecha, hasta: d.anterior.hastaFecha },
      /** Eventos que todavía no salieron hacia el CRM: si se acumulan, algo está trabado. */
      eventosSinPublicar: d.avisos.sinPublicar,
      elMasViejoSinPublicar: d.avisos.masViejo,
      atencion: d.atencion,
      actividad: d.actividad,
      // Del inventario, las CUENTAS. La lista de lo que está por acabarse se
      // queda: trae el nombre de la bodega, y «Bodega Ciudad de Panamá» lleva
      // «ana» dentro —el mismo problema de arriba—. Para mirar artículo por
      // artículo está `ver_stock`, que es su herramienta.
      inventario: d.inventario === null ? null : sinLaLista(d.inventario),
      dinero: d.dinero,
      aviso: avisoDelResumen(d, vale ? null : pedido),
    };
  },
});

/** El inventario sin la lista de artículos: las cuentas, que es lo que resume. */
function sinLaLista(i: Inventario) {
  return i.cargado
    ? {
        cargado: true as const,
        filas: i.filas,
        sinMinimo: i.sinMinimo,
        unidades: i.unidades,
        reservadas: i.reservadas,
        agotadas: i.agotadas,
        porAcabarse: i.porAcabarse,
      }
    : { cargado: false as const, filas: i.filas, sinMinimo: i.sinMinimo };
}

/**
 * Qué hay que decir de una portada que salió bien.
 *
 * Un cero no es «no sé» y tampoco es siempre «nada pendiente»: con la base
 * recién estrenada, los ceros de esta pantalla son «nada todavía», y las dos
 * cosas se leen igual desde aquí. `metricas.ts` lo distingue con
 * `pedidosEnTotal` y con `inventario.cargado` justo para esto, así que se dice
 * en palabras en vez de dejar que el modelo adivine.
 *
 * Se exporta para poder probarla DIRECTAMENTE, con cada combinación. Por la
 * herramienta solo se alcanzan las ramas que la base de ese momento permita
 * —y las pruebas de un archivo comparten base, así que «todavía no hay ningún
 * pedido» deja de ser alcanzable en cuanto otra prueba crea uno—. Una rama que
 * no se puede alcanzar es una rama que nadie vigila.
 */
export function avisoDelResumen(
  d: {
    atencion: { pedidosEnTotal: number } | null;
    inventario: { cargado: boolean } | null;
    dinero: unknown | null;
  },
  periodoQueNoSeEntendio: string | null,
): string | null {
  const partes: string[] = [];

  if (periodoQueNoSeEntendio !== null) {
    partes.push(`«${periodoQueNoSeEntendio}» no es un periodo que yo entienda, así que esto es de hoy`);
  }
  if (d.atencion === null) {
    partes.push("su rol no ve la operación, así que los pedidos y las entregas van en blanco");
  } else if (d.atencion.pedidosEnTotal === 0) {
    partes.push(
      "todavía no hay ningún pedido anotado: los ceros de aquí son «nada todavía», no «nada pendiente»",
    );
  }
  if (d.inventario === null) {
    partes.push("su rol no ve el inventario");
  } else if (!d.inventario.cargado) {
    partes.push(
      "el inventario no tiene ningún movimiento registrado, así que no se puede hablar de agotados",
    );
  }
  if (d.dinero === null) {
    partes.push("su rol no ve el dinero, y por eso ese bloque no se consultó");
  }

  return partes.length === 0 ? null : `${partes.join("; ")}.`;
}

export const HERRAMIENTAS_DE_DINERO = [
  pagosPorConfirmar,
  registrarCobro,
  confirmarAbono,
  rechazarCobro,
  resumenDelDia,
] as const;
