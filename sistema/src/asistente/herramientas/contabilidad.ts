import { z } from "zod";
import {
  ajustarRedondeoDeInventario,
  cerrarMes,
  huecosAbiertos,
  libroDiario,
  mayorDeCuenta,
  porCobrar,
  reabrirMes,
  resumenContable,
  revisionDeCierre,
} from "../../db/contabilidad";
import type { ContextoContable, ContextoDeLectura } from "../../db/contabilidad";
import { ETIQUETAS_TRAMO, fechaContable } from "../../dominio/contabilidad";
import { definir } from "../registro";
import type { Contexto } from "../registro";
import { referenciasPorPedido } from "./entregas";

/**
 * La contabilidad por la puerta del asistente, y por tanto por MCP.
 *
 * Los libros se leían solo desde la pantalla de Contabilidad del panel, que es
 * el caso de `docs/TRAMPAS.md` §13: una capacidad que solo se alcanza desde un
 * sitio. Preguntar «¿cuánto dinero hay?», «¿quién me debe?» o «¿se puede cerrar
 * octubre?» no debería exigir un navegador.
 *
 * Todo lo de aquí llama a las MISMAS funciones de `src/db/contabilidad.ts` que
 * llama `src/api/panel.ts`. No hay una segunda forma de sumar un saldo: dos
 * sitios que suman por su cuenta acaban diciendo números distintos del mismo
 * mes, y el que se equivoque es el que nadie revisa.
 *
 * ## Lo que SÍ escribe en los libros, y lo que no
 *
 * Los libros no se editan ni se borran. De las cinco rutas del panel que
 * escriben, por aquí salen tres y se quedan dos, y las dos que se quedan están
 * marcadas en `scripts/sin-mcp.mjs` con su motivo escrito, no como pendientes:
 *
 *  - **Un asiento a mano** (`POST /contabilidad/asientos`) **no sale.** Dos
 *    razones. La primera es de este código: lo que la persona lee antes de
 *    tocar «Permitir» lo arma `resumir()` de `ejecutar.ts`, que escribe cada
 *    argumento con `String(valor)` — y las líneas de un asiento son una lista
 *    de objetos, así que la tarjeta diría «lineas: [object Object]». Permitir
 *    eso es un clic a ciegas sobre un libro que no se puede corregir salvo con
 *    otro asiento. La segunda es de contabilidad: todo asiento del sistema nace
 *    pegado a su hecho, en el mismo batch (05 §3); un asiento a mano es el
 *    único que nace sin hecho detrás, y esa es justo la escritura que no
 *    conviene poder pedir conversando.
 *  - **Revertir un asiento** (`POST /contabilidad/asientos/:id/reverso`)
 *    **tampoco.** Es la única forma de corregir y solo funciona UNA vez por
 *    asiento: `revierte_id` es único y un asiento ya corregido no se vuelve a
 *    corregir. Elegir cuál se revierte es leer el libro diario en pantalla; en
 *    una conversación lo que viaja es un ULID de 26 letras, y un carácter
 *    distinto corrige otro asiento — ese otro ya no se podrá corregir nunca.
 *  - **Cerrar y reabrir el mes** sí salen. Cerrar lo pide el plan como
 *    herramienta de la dueña (06-asistente §5), la lista de chequeo bloquea el
 *    cierre si falta algo, no se puede cerrar un mes que no ha terminado, lo
 *    que se lee en la tarjeta es un mes («mes: 2026-10»), y reabrir existe y
 *    pide motivo. Nada de eso toca un asiento.
 *  - **Los centavos de redondeo** también salen. No calculan nada nuevo: bajan
 *    a cero el valor del inventario que ya no tiene unidades y dejan el asiento
 *    que lo explica (asiento 18). La ruta existe «para poder dispararlo a mano
 *    mientras no haya un cron», y un cliente de MCP es exactamente esa mano.
 *
 * ## El costo de lo vendido no sale por aquí
 *
 * `GET /contabilidad` devuelve también el estado de resultados, que lleva el
 * costo de lo vendido y el margen. Eso NO sale: en este catálogo ninguna
 * herramienta devuelve costo ni margen —el costo tiene su propio permiso,
 * `costo_y_margen`, y hay una prueba que recorre todas las herramientas para
 * que siga así (`fronteras.test.ts`)—. Ampliar eso es una decisión del dueño
 * del proyecto, no de quien escribe estas herramientas; mientras no la tome, la
 * ganancia del periodo se mira en la pantalla de Contabilidad, y que no salga
 * queda DICHO en el aviso de `ver_contabilidad` en vez de escondido: un hueco
 * que no se ve es un hueco que nadie llena.
 *
 * Los apuntes de la cuenta 5101 sí salen en el libro diario y en su mayor,
 * porque ahí el costo es un apunte del libro y el libro es de quien tiene
 * `contabilidad` —la dueña y la contadora, que tienen las dos `costo_y_margen`
 * en «ver»—. Lo que no sale es el costo POR ARTÍCULO, que es el dato que la
 * regla protege.
 */

const contextoDeLectura = (ctx: Contexto): ContextoDeLectura => ({
  db: ctx.db,
  ahora: ctx.ahora,
});

/**
 * El contexto para escribir, con el actor de verdad.
 *
 * El actor es el correo de quien pide, como en el panel: es lo que queda en
 * `periodos.cerrado_por` cuando alguien pregunte quién cerró el mes, y «el
 * asistente» no contesta esa pregunta.
 */
const contextoDeEscritura = (ctx: Contexto): ContextoContable => ({
  db: ctx.db,
  ahora: ctx.ahora,
  actor: ctx.usuario.correo,
});

/**
 * El rango del periodo: del día 1 del mes en curso a hoy.
 *
 * Es el mismo valor de fábrica de la pantalla, con una diferencia a propósito:
 * el día lo da `fechaContable`, que es la fecha de PANAMÁ. La pantalla usa la
 * de UTC, y con la de UTC todo lo que pasa después de las siete de la noche
 * cuenta como del día siguiente — que es el mismo error que `fechaDePanama`
 * existe para no cometer en las entregas.
 */
function rangoDe(ctx: Contexto, desde?: string, hasta?: string): { desde: string; hasta: string } {
  const hoy = fechaContable(ctx.ahora);
  return { desde: desde ?? `${hoy.slice(0, 7)}-01`, hasta: hasta ?? hoy };
}

const fecha = (que: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "la fecha se escribe así: 2026-11-12")
    .optional()
    .describe(que);

const mesDe = (ctx: Contexto) => fechaContable(ctx.ahora).slice(0, 7);

const enDolares = (cents: number): string => {
  const signo = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${signo}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

export const verContabilidad = definir({
  nombre: "ver_contabilidad",
  descripcion:
    "Cuánto dinero hay en cada cuenta, cuánto le deben, cuánto debe, cuánto vale el inventario y si el balance cuadra. Los saldos son al día final; sin fechas, del día 1 del mes a hoy. Ejemplo: ver_contabilidad con desde «2026-10-01» y hasta «2026-10-31».",
  parametros: z.object({
    desde: fecha("Primer día del periodo. Si falta, el día 1 del mes en curso."),
    hasta: fecha("Último día. Los saldos son AL este día. Si falta, hoy en hora de Panamá."),
  }),
  nivel: "lectura",
  categoria: "contabilidad",
  roles: ["duena", "contadora"],

  async ejecutar(ctx, args) {
    const rango = rangoDe(ctx, args.desde, args.hasta);
    const [resumen, huecos] = await Promise.all([
      resumenContable(contextoDeLectura(ctx), rango),
      huecosAbiertos(contextoDeLectura(ctx)),
    ]);

    const abiertos = huecos.filter((h) => h.estado !== "resuelto");
    return {
      desde: resumen.desde,
      hasta: resumen.hasta,
      // Mezcla dos cosas de naturaleza distinta y por eso cada campo dice cuál
      // es: el dinero y lo que deben son SALDOS al día final (05 §5).
      dineroPorCuenta: resumen.dinero,
      dineroTotalCents: resumen.dineroTotalCents,
      teDebenCents: resumen.teDebenCents,
      debesAProveedoresCents: resumen.debesCents,
      inventarioCents: resumen.inventarioCents,
      balance: resumen.balance,
      asientosDelPeriodo: resumen.asientos,
      // Un asiento sin su fila de cuadre se escribió por fuera del camino
      // normal. No es una curiosidad: bloquea el cierre.
      asientosSinCuadre: resumen.asientosSinCuadre,
      // Una caja con saldo es efectivo que está en la calle. A fin de mes
      // tienen que estar todas en cero (05 §9).
      cajasConSaldo: resumen.cajasConSaldo,
      huecos: abiertos,
      aviso:
        `El dinero, lo que le deben y el inventario son saldos AL ${resumen.hasta}; ` +
        `los asientos contados son los del ${resumen.desde} al ${resumen.hasta}. ` +
        (resumen.balance.cuadra
          ? "El balance cuadra. "
          : `El balance NO cuadra: falta ${enDolares(resumen.balance.diferenciaCents)}. `) +
        `${abiertos.length} datos del negocio siguen sin decidir (están en «huecos»). ` +
        "Las ventas, el costo de lo vendido y la ganancia del periodo NO salen por ninguna " +
        "herramienta del asistente: el costo tiene su propio permiso y se mira en la pantalla de Contabilidad.",
    };
  },
});

export const verLibroDiario = definir({
  nombre: "ver_libro_diario",
  descripcion:
    "Los asientos de un periodo con sus líneas, del más nuevo al más viejo: qué pasó, a qué cuentas fue y cuánto. Ejemplo: ver_libro_diario con desde «2026-10-01», hasta «2026-10-31» y limite 20.",
  parametros: z.object({
    desde: fecha("Primer día. Si falta, el día 1 del mes en curso."),
    hasta: fecha("Último día. Si falta, hoy en hora de Panamá."),
    limite: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Cuántos asientos devolver, del más reciente hacia atrás. De fábrica, 50."),
  }),
  nivel: "lectura",
  categoria: "contabilidad",
  roles: ["duena", "contadora"],

  async ejecutar(ctx, args) {
    const rango = rangoDe(ctx, args.desde, args.hasta);
    const asientos = await libroDiario(contextoDeLectura(ctx), {
      ...rango,
      ...(args.limite === undefined ? {} : { limite: args.limite }),
    });

    const tope = args.limite ?? 50;
    return {
      desde: rango.desde,
      hasta: rango.hasta,
      asientos: asientos.map((a) => ({
        asientoId: a.id,
        fecha: a.fecha,
        descripcion: a.descripcion,
        // `hecho` dice de qué asiento de los 18 del plan se trata, y `origen`
        // si lo escribió el sistema o una persona.
        hecho: a.hecho,
        origen: a.origen,
        referenciaTipo: a.referenciaTipo,
        referenciaId: a.referenciaId,
        revierteId: a.revierteId,
        revertido: a.revertido,
        creadoEn: a.creadoEn,
        totalCents: a.totalCents,
        lineas: a.lineas,
        // `creadoPor` NO sale, y no es un olvido: es el correo de quien lo
        // escribió, y la guarda de D-20 descarta cualquier resultado con un
        // correo dentro —no distingue el de una clienta del de la contadora—.
        // Quién escribió un asiento se mira en el panel.
      })),
      cuantos: asientos.length,
      aviso:
        (asientos.length === 0
          ? `No hay ningún asiento entre el ${rango.desde} y el ${rango.hasta}. `
          : `${asientos.length} asientos entre el ${rango.desde} y el ${rango.hasta}` +
            (asientos.length === tope ? `, cortados en el tope de ${tope}: pida otro limite. ` : ". ")) +
        "Un asiento no se edita ni se borra: lo que está mal se corrige con su contrario, y eso se " +
        "hace desde el panel.",
    };
  },
});

export const verMayorDeCuenta = definir({
  nombre: "ver_mayor_de_cuenta",
  descripcion:
    "Los apuntes de UNA cuenta en el periodo, cada uno con el asiento del que viene: es con lo que se cuadra contra el banco. Ejemplo: ver_mayor_de_cuenta con codigo «1101» da los movimientos de la cuenta de Yappy Comercial.",
  parametros: z.object({
    codigo: z
      .string()
      .min(1)
      .max(10)
      .optional()
      .describe(
        "El código de la cuenta del plan: 1101 Yappy, 1103 efectivo, 1201 por cobrar, 1301 inventario, 2101 anticipos, 4101 ventas, 6101 publicidad.",
      ),
    desde: fecha("Primer día. Si falta, el día 1 del mes en curso."),
    hasta: fecha("Último día. Si falta, hoy en hora de Panamá."),
    limite: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Cuántos apuntes devolver. De fábrica, los que traiga la cuenta."),
  }),
  nivel: "lectura",
  categoria: "contabilidad",
  roles: ["duena", "contadora"],

  async ejecutar(ctx, args) {
    if (args.codigo === undefined) {
      return {
        codigo: null,
        nombre: null,
        apuntes: [],
        aviso:
          "Falta decir qué cuenta: pase el «codigo» del plan de cuentas (1101 Yappy, 1201 por cobrar, " +
          "4101 ventas, 5101 costo de lo vendido…). El resumen de todas es ver_contabilidad.",
      };
    }

    const rango = rangoDe(ctx, args.desde, args.hasta);
    const r = await mayorDeCuenta(contextoDeLectura(ctx), args.codigo, {
      ...rango,
      ...(args.limite === undefined ? {} : { limite: args.limite }),
    });
    if (!r.ok) {
      return { codigo: args.codigo, nombre: null, apuntes: [], aviso: r.mensaje };
    }

    return {
      codigo: r.datos.codigo,
      nombre: r.datos.nombre,
      desde: rango.desde,
      hasta: rango.hasta,
      // Cada apunte lleva el id de su asiento a propósito: es lo que permite
      // que una cifra diga de dónde sale. Una cifra que no puede decirlo invita
      // a creérsela.
      apuntes: r.datos.apuntes,
      cuantos: r.datos.apuntes.length,
      aviso:
        r.datos.apuntes.length === 0
          ? `La cuenta ${r.datos.codigo} (${r.datos.nombre}) no tiene ningún apunte entre el ${rango.desde} y el ${rango.hasta}.`
          : `${r.datos.apuntes.length} apuntes de ${r.datos.codigo} (${r.datos.nombre}) entre el ${rango.desde} y el ${rango.hasta}. ` +
            "Cada uno trae el id de su asiento, que es por donde se busca el resto de la operación.",
    };
  },
});

export const quienMeDebe = definir({
  nombre: "quien_me_debe",
  descripcion:
    "Lo que le deben, pedido por pedido entregado, con su antigüedad: hasta 7 días, de 8 a 30 y más de 30. Cada clienta va como su referencia. Ejemplo: quien_me_debe con al «2026-11-12» dice el total y las deudas más viejas.",
  parametros: z.object({
    al: fecha("El día al que se mira la deuda. Si falta, hoy en hora de Panamá."),
    cuantos: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Cuántas deudas listar, de la más vieja a la más nueva. De fábrica, 25."),
  }),
  nivel: "lectura",
  categoria: "contabilidad",
  roles: ["duena", "contadora"],

  async ejecutar(ctx, args) {
    const al = args.al ?? fechaContable(ctx.ahora);
    const cuantos = args.cuantos ?? 25;
    const r = await porCobrar(contextoDeLectura(ctx), al);

    // El total y los tramos salen de TODAS las deudas; la lista se corta. Al
    // revés —cortar antes de sumar— el total sería un recorte disfrazado de
    // total, que es la forma más fácil de que el asistente afirme una cifra
    // falsa.
    const mostradas = r.deudas.slice(0, cuantos);
    const refs = await referenciasPorPedido(
      ctx.db,
      "id",
      mostradas.map((d) => d.pedidoId),
    );

    return {
      al: r.al,
      totalCents: r.totalCents,
      porTramo: r.porTramo,
      deudas: mostradas.map((d) => ({
        pedidoId: d.pedidoId,
        numero: d.numero,
        // El nombre de la clienta NO sale: va su referencia, y el nombre lo
        // pone el panel DESPUÉS de que el modelo contestó (D-20).
        clienta: refs.get(d.pedidoId) ?? null,
        saldoCents: d.saldoCents,
        entregadoEl: d.entregadoEl,
        dias: d.dias,
        tramo: d.tramo,
        antiguedad: ETIQUETAS_TRAMO[d.tramo],
      })),
      cuantas: r.deudas.length,
      recortado: r.deudas.length > mostradas.length,
      aviso:
        (r.deudas.length === 0
          ? `Al ${r.al} no hay ningún pedido entregado con saldo pendiente. `
          : `${r.deudas.length} pedidos entregados con saldo al ${r.al}, ${enDolares(r.totalCents)} en total` +
            (r.deudas.length > mostradas.length
              ? `; se listan los ${mostradas.length} más viejos. `
              : ". ")) +
        "Cada clienta va como su referencia (C-0042); el nombre lo pone el panel al mostrar la respuesta.",
    };
  },
});

export const verCierre = definir({
  nombre: "ver_cierre",
  descripcion:
    "La lista de chequeo del cierre de un mes con datos de verdad: qué falta, qué conviene mirar y qué no se puede comprobar todavía. Ejemplo: ver_cierre con mes «2026-10» dice si se puede cerrar octubre y qué lo bloquea.",
  parametros: z.object({
    mes: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "el mes se escribe así: 2026-10")
      .optional()
      .describe("El mes, YYYY-MM. Si falta, el mes en curso."),
  }),
  nivel: "lectura",
  categoria: "contabilidad",
  roles: ["duena", "contadora"],

  async ejecutar(ctx, args) {
    const mes = args.mes ?? mesDe(ctx);
    const r = await revisionDeCierre(contextoDeLectura(ctx), mes);
    if (!r.ok) {
      return { mes, estadoDelMes: null, casillas: [], sePuedeCerrar: false, aviso: r.mensaje };
    }

    const faltan = r.datos.casillas.filter((c) => c.estado === "falta");
    const sinComprobar = r.datos.casillas.filter((c) => c.estado === "no_se_puede_comprobar");
    return {
      mes: r.datos.mes,
      estadoDelMes: r.datos.estadoDelMes,
      // Las casillas salen todas, también las que no se pueden comprobar
      // todavía: esconderlas haría que la lista pareciera completa.
      casillas: r.datos.casillas,
      sePuedeCerrar: r.datos.sePuedeCerrar,
      mesTerminado: r.datos.mesTerminado,
      aviso:
        `${mes} está ${r.datos.estadoDelMes}. ` +
        (r.datos.mesTerminado ? "" : "El mes todavía no ha terminado, así que no se puede cerrar. ") +
        (faltan.length === 0
          ? "Ninguna casilla bloquea el cierre. "
          : `${faltan.length} casillas bloquean el cierre: ${faltan.map((c) => c.titulo.toLowerCase()).join("; ")}. `) +
        `${sinComprobar.length} no se pueden comprobar todavía porque esa parte del sistema no está escrita.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Escribir
// ---------------------------------------------------------------------------

export const ajustarRedondeos = definir({
  nombre: "ajustar_redondeos",
  descripcion:
    "Limpia los centavos que deja el costo promedio: baja a cero el valor del inventario de las variantes que ya no tienen unidades y deja el asiento que lo explica. No calcula nada nuevo y si no hay residuo no escribe nada. Ejemplo: ajustar_redondeos con motivo «limpieza antes de cerrar octubre».",
  parametros: z.object({
    motivo: z
      .string()
      .min(3)
      .max(300)
      .describe("Por qué se hace ahora. Queda en la bitácora del asistente (acciones)."),
  }),
  // Toca el valor del inventario y escribe asientos: sensible, aunque no haya
  // ninguna cifra que elegir.
  nivel: "sensible",
  categoria: "contabilidad",
  roles: ["duena"],

  async ejecutar(ctx) {
    const r = await ajustarRedondeoDeInventario(contextoDeEscritura(ctx));
    if (!r.ok) throw new Error(r.mensaje);

    return {
      ajustes: r.datos.ajustes,
      cuantos: r.datos.ajustes.length,
      aviso:
        r.datos.ajustes.length === 0
          ? "No quedaba ningún centavo por ajustar: no se escribió ningún asiento. Un asiento de cero centavos no corrige nada y ensucia el libro."
          : `${r.datos.ajustes.length} variantes ajustadas, cada una con su asiento (el 18 del plan).`,
    };
  },
});

export const cerrarElMes = definir({
  nombre: "cerrar_mes",
  descripcion:
    "Cierra un mes: a partir de ahí ningún asiento puede llevar fecha de ese mes. Solo se cierra un mes terminado y solo si la lista de chequeo no tiene nada que bloquee; mire antes ver_cierre. Ejemplo: cerrar_mes con mes «2026-10» y motivo «revisado con la contadora».",
  parametros: z.object({
    mes: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "el mes se escribe así: 2026-10")
      .describe("El mes a cerrar, YYYY-MM."),
    motivo: z
      .string()
      .min(3)
      .max(300)
      .optional()
      .describe("Con quién se revisó. Queda en la bitácora del asistente (acciones)."),
  }),
  // No toca ningún asiento, pero cambia lo que el sistema aceptará a partir de
  // ahora, y eso es dinero: sensible.
  nivel: "sensible",
  categoria: "contabilidad",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await cerrarMes(contextoDeEscritura(ctx), args.mes);
    if (!r.ok) throw new Error(r.mensaje);
    return {
      mes: r.datos.mes,
      aviso:
        `${r.datos.mes} queda cerrado: ningún asiento nuevo puede llevar fecha de ese mes. ` +
        "Para volver a abrirlo hace falta un motivo, y queda registrado (reabrir_mes).",
    };
  },
});

export const reabrirElMes = definir({
  nombre: "reabrir_mes",
  descripcion:
    "Vuelve a abrir un mes cerrado para poder anotar en él. Pide motivo y el motivo queda registrado en el periodo. Ejemplo: reabrir_mes con mes «2026-10» y motivo «faltó el extracto del banco».",
  parametros: z.object({
    mes: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "el mes se escribe así: 2026-10")
      .describe("El mes a reabrir, YYYY-MM."),
    motivo: z
      .string()
      .min(3)
      .max(300)
      .describe("Por qué se reabre. Queda escrito en el periodo, no solo en la bitácora."),
  }),
  nivel: "sensible",
  categoria: "contabilidad",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await reabrirMes(contextoDeEscritura(ctx), args.mes, args.motivo);
    if (!r.ok) throw new Error(r.mensaje);
    return {
      mes: r.datos.mes,
      aviso: `${r.datos.mes} vuelve a estar abierto, con el motivo escrito en el periodo.`,
    };
  },
});

export const HERRAMIENTAS_DE_CONTABILIDAD = [
  verContabilidad,
  verLibroDiario,
  verMayorDeCuenta,
  quienMeDebe,
  verCierre,
  ajustarRedondeos,
  cerrarElMes,
  reabrirElMes,
] as const;
