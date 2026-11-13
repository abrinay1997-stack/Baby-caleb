import { z } from "zod";
import {
  METODOS_DE_COBRO,
  armarRuta,
  crearEnvio,
  despacharRuta,
  entregasDelDia,
  fechaDePanama,
  marcarEntregada,
  marcarFallida,
  sugerirParaEnvio,
  reintentarEnvio,} from "../../db/entregas";
import type { ContextoEntrega, ParadaDelDia } from "../../db/entregas";
import { comoSeEscribe, referenciaDe } from "../referencias";
import { definir } from "../registro";
import type { Contexto } from "../registro";

/**
 * Las entregas por la puerta del asistente, y por tanto por MCP.
 *
 * Hasta aquí el tramo final —preparar la entrega, armar la ruta, despacharla,
 * cerrarla— solo se podía hacer desde la pantalla de Entregas del panel. Eso es
 * exactamente lo que `docs/TRAMPAS.md` §13 prohíbe: una capacidad que solo se
 * alcanza desde una pantalla depende de que esa pantalla exista, se despliegue
 * y esté bien escrita, y en este repositorio ya se han visto las tres cosas
 * fallar por separado.
 *
 * Ninguna de estas herramientas trae lógica propia: todas llaman a las MISMAS
 * funciones de `src/db/entregas.ts` que llama `src/api/panel.ts`. Un segundo
 * camino hacia el inventario o hacia los libros sería un segundo sitio donde
 * olvidarse de la fila de control.
 *
 * ## LO QUE NO SALE DE AQUÍ: la dirección de una clienta (D-20)
 *
 * Una parada lleva, en la base, nombre, dirección, referencia de la dirección,
 * teléfono y coordenadas. **Nada de eso sale.** De cada parada sale el número
 * del pedido, su zona, su ventana, su estado y lo que hay que cobrar; la
 * clienta va como su referencia (`C-0042`) y el nombre lo pone el panel
 * DESPUÉS, al mostrar la respuesta (06-asistente §7).
 *
 * No es prudencia de más: el modelo del asistente es un Contributor y Meta
 * entrena con lo que recibe. Las cifras del negocio van —el dueño del proyecto
 * lo aceptó— pero la casa de una clienta no es una cifra del negocio.
 *
 * **Y eso tiene una consecuencia que hay que decir en voz alta: con estas
 * herramientas no se puede repartir.** Un motorizado necesita saber a qué
 * puerta va, y a qué puerta va es justo lo único que no puede salir. Esa
 * pantalla se sirve con sesión, desde el panel o desde la superficie del
 * motorizado. Levantar la restricción es una decisión del dueño del proyecto,
 * no de quien escribe estas herramientas.
 *
 * ## Por qué ninguna lleva `textoExterno`
 *
 * `textoExterno` marca las herramientas que devuelven texto escrito por una
 * clienta, para que el resto del turno se endurezca (06-asistente §7). Las
 * entregas son donde más de ese texto hay —la referencia de la dirección («la
 * casa verde al lado del abarrotero») y la nota de la entrega—, y precisamente
 * por D-20 ninguna de las dos sale. Así que la marca está en `false` porque no
 * queda texto de fuera que marcar, no por descuido: el día que una de estas
 * herramientas devuelva una nota o una referencia de dirección, la marca entra
 * con ella.
 *
 * ## Niveles y roles
 *
 * `marcar_entregada` es la única `sensible` del archivo, y lo es por las dos
 * razones a la vez: descuenta el inventario de verdad (hasta ahí estaba
 * apartado) y escribe el asiento de la venta, el de su costo y el cobro del
 * saldo. Las demás anotan estados y bitácoras: ni dinero ni existencias.
 *
 * Los roles son los del permiso de su ruta en el panel, con una diferencia que
 * va en la dirección segura: `marcar_entregada` es solo de la dueña, aunque la
 * ruta del panel la deje usar también a la asistente. No es un descuido ni una
 * ampliación — es que en este catálogo lo sensible es de la dueña y hay una
 * prueba que lo vigila (`registro.test.ts`). La asistente sigue cerrando
 * entregas desde el panel.
 */

// ---------------------------------------------------------------------------
// Lo que el modelo puede saber de una clienta
// ---------------------------------------------------------------------------

/**
 * De un pedido a la referencia de su clienta, en bloque.
 *
 * Vive aquí y no en `referencias.ts` porque hoy es de este par de archivos: lo
 * usan `ver_entregas` y `quien_me_debe`, que son los dos sitios donde una lista
 * de filas del negocio tiene una clienta colgando de cada fila. En cuanto lo
 * necesite un tercero, su sitio es `referencias.ts`.
 *
 * Tres cosas que no son casuales:
 *
 *  - **Una sola consulta por tanda para leer lo que ya hay.** Una por fila haría
 *    que el costo de `ver_entregas` creciera con el número de paradas
 *    (02-datos §11), y la tanda evita un `IN` que un día deje de caber.
 *  - **A quien no tiene referencia se le da una.** `referenciaDe` estaba
 *    escrita y probada desde su migración y NO LA LLAMABA NADIE: es el caso de
 *    TRAMPAS §12, la pieza terminada que nadie enchufa. Sin esto el campo
 *    `clienta` saldría `null` para todas y `ponerLosNombres` no tendría nada que
 *    resolver, o sea que la herramienta no serviría para lo que existe.
 *  - **Se escribe por clienta, no por fila**, y solo la primera vez: en cuanto
 *    una clienta tiene su número, esta función no escribe nada más.
 *
 * `null` en el mapa significa «ese pedido no tiene clienta», que no es lo mismo
 * que faltar la referencia (TRAMPAS §7: un hueco se dice, no se rellena).
 */
export async function referenciasPorPedido(
  db: D1Database,
  columna: "id" | "numero",
  pedidos: readonly string[],
): Promise<Map<string, string | null>> {
  const salida = new Map<string, string | null>();
  const unicos = [...new Set(pedidos)];
  if (unicos.length === 0) return salida;

  const porDar = new Map<string, string[]>();
  for (let i = 0; i < unicos.length; i += 50) {
    const tanda = unicos.slice(i, i + 50);
    const huecos = tanda.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT p.${columna} AS llave, p.cliente_id, c.referencia
           FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id
          WHERE p.${columna} IN (${huecos})`,
      )
      .bind(...tanda)
      .all<{ llave: string; cliente_id: string | null; referencia: number | null }>();

    for (const f of results) {
      if (f.cliente_id === null) {
        salida.set(f.llave, null);
        continue;
      }
      if (f.referencia !== null) {
        salida.set(f.llave, comoSeEscribe(f.referencia));
        continue;
      }
      const ya = porDar.get(f.cliente_id) ?? [];
      ya.push(f.llave);
      porDar.set(f.cliente_id, ya);
    }
  }

  for (const [clienteId, llaves] of porDar) {
    const ref = await referenciaDe(db, clienteId);
    for (const llave of llaves) salida.set(llave, ref);
  }
  return salida;
}

/** El contexto que piden las funciones de entregas, con el actor de verdad. */
const contextoDeEntrega = (ctx: Contexto): ContextoEntrega => ({
  db: ctx.db,
  ahora: ctx.ahora,
  actor: ctx.usuario.correo,
});

/**
 * El motivo de una acción del asistente.
 *
 * Donde la función de abajo tiene dónde guardarlo, se guarda ahí y se dice
 * cuál: la nota de la entrega, el motivo del mes reabierto. Donde no lo tiene
 * —preparar una entrega, armar una ruta, despacharla— el motivo NO se pierde:
 * los argumentos de toda llamada quedan en `acciones`, la bitácora del
 * asistente, con quién, por dónde y a qué hora, y esa tabla no se edita ni se
 * borra. Lo que no se hace es prometer que aparecerá en la bitácora de la
 * entrega, porque no aparece.
 */
const motivoEnLaBitacora = z
  .string()
  .min(3)
  .max(300)
  .optional()
  .describe(
    "Por qué se hace. Queda en la bitácora del asistente (acciones), no en la de la entrega.",
  );

// ---------------------------------------------------------------------------
// Mirar el día
// ---------------------------------------------------------------------------

/** La parada, sin nada de la clienta salvo su referencia. */
interface ParadaQueSaleAlModelo {
  readonly envioId: string;
  readonly estado: string;
  readonly orden: number | null;
  readonly pedido: string;
  readonly clienta: string | null;
  readonly bodega: string;
  readonly bodegaId: string;
  readonly zona: string | null;
  readonly ventana: string | null;
  readonly porCobrarCents: number;
  readonly cobradoCents: number;
  readonly cobroMetodo: string | null;
  readonly entregadoEn: number | null;
  readonly conPrueba: boolean;
  /** Si la dirección tiene punto en el mapa. El punto NO sale; que exista, sí. */
  readonly conUbicacion: boolean;
}

/**
 * De la parada de la pantalla a la parada del modelo.
 *
 * Está escrita como una lista blanca —se nombra campo por campo lo que sale— y
 * no como «la parada menos estos cuatro». Con una lista negra, el día que
 * `ParadaDelDia` gane un campo con un teléfono dentro, ese campo saldría solo.
 */
const comoLaVeElModelo = (p: ParadaDelDia, clienta: string | null): ParadaQueSaleAlModelo => ({
  envioId: p.envioId,
  estado: p.estado,
  orden: p.orden,
  pedido: p.pedido,
  clienta,
  bodega: p.bodega,
  bodegaId: p.bodegaId,
  zona: p.zona,
  ventana: p.ventana,
  // `cobro_cents` es el saldo que se le pidió cobrar al motorizado. Se nombra
  // «porCobrar» porque «cobro» a secas se lee como lo ya cobrado.
  porCobrarCents: p.cobroCents,
  cobradoCents: p.cobradoCents,
  cobroMetodo: p.cobroMetodo,
  entregadoEn: p.entregadoEn,
  conPrueba: p.conPrueba,
  conUbicacion: p.lat !== null && p.lng !== null,
});

const AVISO_DE_LA_DIRECCION =
  "La dirección, el teléfono y el punto en el mapa de cada clienta no salen por aquí (D-20): " +
  "para llegar a la puerta hace falta el panel o la pantalla del motorizado.";

export const verEntregas = definir({
  nombre: "ver_entregas",
  descripcion:
    "La ruta de un día: lo que falta por entregar, lo que ya salió, lo cobrado y los pedidos agendados a los que todavía no se les preparó la entrega. Sin fecha, el día de hoy en hora de Panamá. Ejemplo: ver_entregas con fecha «2026-11-12» dice cuántas paradas lleva cada motorizado y cuánto se cobró.",
  parametros: z.object({
    fecha: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "la fecha se escribe así: 2026-11-12")
      .optional()
      .describe("El día, en hora de Panamá. Si falta, hoy."),
  }),
  nivel: "lectura",
  categoria: "entregas",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const fecha = args.fecha ?? fechaDePanama(ctx.ahora);
    const r = await entregasDelDia(ctx.db, fecha, ctx.ahora);
    if (!r.ok) {
      return {
        fecha: null,
        rutas: [],
        sinRuta: [],
        porPreparar: [],
        motorizados: [],
        resumen: null,
        ajustes: null,
        aviso: r.mensaje,
      };
    }

    const todas = [...r.datos.sinRuta, ...r.datos.rutas.flatMap((ru) => ru.paradas)];
    const refs = await referenciasPorPedido(
      ctx.db,
      "numero",
      todas.map((p) => p.pedido),
    );
    const refsPorPreparar = await referenciasPorPedido(
      ctx.db,
      "id",
      r.datos.porPreparar.map((p) => p.pedidoId),
    );
    const ref = (numero: string) => refs.get(numero) ?? null;

    // Los motorizados los añade la ruta del panel porque la pantalla necesita a
    // quién asignarle la tanda; aquí hacen la misma falta, porque `armar_ruta`
    // pide un `motorizadoId` y sin esta lista el modelo no tiene de dónde
    // sacarlo. El celular NO sale: está en la tabla y no se consulta.
    const { results: motorizados } = await ctx.db
      .prepare(
        "SELECT id, nombre, estado FROM motorizados WHERE estado <> 'inactivo' ORDER BY nombre",
      )
      .all<{ id: string; nombre: string; estado: string }>();

    return {
      fecha: r.datos.fecha,
      rutas: r.datos.rutas.map((ru) => ({
        rutaId: ru.rutaId,
        motorizado: ru.motorizado,
        motorizadoId: ru.motorizadoId,
        bodega: ru.bodega,
        estado: ru.estado,
        salioEn: ru.salioEn,
        cerradaEn: ru.cerradaEn,
        kmPropuestos: ru.kmPropuestos,
        paradas: ru.paradas.map((p) => comoLaVeElModelo(p, ref(p.pedido))),
      })),
      sinRuta: r.datos.sinRuta.map((p) => comoLaVeElModelo(p, ref(p.pedido))),
      porPreparar: r.datos.porPreparar.map((p) => ({
        pedidoId: p.pedidoId,
        numero: p.numero,
        clienta: refsPorPreparar.get(p.pedidoId) ?? null,
        zona: p.zona,
        saldoCents: p.saldoCents,
      })),
      motorizados,
      resumen: r.datos.resumen,
      // Las ventanas de entrega y las comisiones las pone la dueña y hoy valen
      // PENDIENTE. Salen tal cual para que el asistente no prometa un horario
      // que el negocio no ofrece.
      ajustes: r.datos.ajustes,
      aviso:
        `Es el día ${r.datos.fecha} en hora de Panamá. ` +
        `${r.datos.resumen.porEntregar} paradas abiertas, ${r.datos.resumen.entregadas} entregadas, ` +
        `${r.datos.resumen.fallidas} fallidas y ${r.datos.porPreparar.length} pedidos agendados sin entrega preparada. ` +
        AVISO_DE_LA_DIRECCION,
    };
  },
});

export const sugerirMotorizado = definir({
  nombre: "sugerir_motorizado",
  descripcion:
    "A quién le queda mejor una entrega: los motorizados ordenados con el motivo de cada uno, contando la zona, lo que ya lleva encima y la cercanía. PROPONE, no asigna. Ejemplo: sugerir_motorizado con el envioId de una parada dice quién ya va a esa zona.",
  parametros: z.object({
    envioId: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("El id de la entrega, tal como lo da ver_entregas en «envioId»."),
  }),
  nivel: "lectura",
  categoria: "entregas",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    if (args.envioId === undefined) {
      return {
        candidatos: [],
        aviso: "Falta decir de qué entrega: pase el «envioId» de una parada. ver_entregas los lista.",
      };
    }

    const r = await sugerirParaEnvio(ctx.db, args.envioId);
    if (!r.ok) {
      return {
        candidatos: [],
        // La función dice «no existe esa entrega»; aquí se nombra el id y de
        // dónde sale, que es lo que hace falta para corregirlo (TRAMPAS §10).
        aviso:
          r.codigo === "no_encontrado"
            ? `«${args.envioId}» no aparece entre las entregas: el envioId sale de ver_entregas.`
            : r.mensaje,
      };
    }

    const proponibles = r.datos.candidatos.filter((c) => c.proponible);
    return {
      // Los saturados y los que no están activos salen igual, con su motivo:
      // saber por qué no se propone a alguien vale tanto como la propuesta.
      candidatos: r.datos.candidatos,
      aviso:
        `${proponibles.length} de ${r.datos.candidatos.length} se pueden proponer. ` +
        "El orden se mide en línea recta y la zona manda sobre la cercanía; quien reparte sabe cosas " +
        "que esto no, así que es una propuesta. Asignar es armar_ruta.",
    };
  },
});

export const verZonas = definir({
  nombre: "ver_zonas",
  descripcion:
    "Las zonas de envío con su región, su método y su tarifa. Ejemplo: ver_zonas dice cuánto se cobra por llevar a cada zona y cuáles piden el pago completo antes de salir.",
  parametros: z.object({
    region: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Solo las de una región: «ciudad» o «interior». Si falta, todas."),
  }),
  nivel: "lectura",
  categoria: "entregas",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const { results } = await ctx.db
      .prepare(
        `SELECT z.id, z.nombre, z.alias_json, z.region, z.metodo, z.tarifa_cents,
                z.requiere_pago_total, z.activa, b.nombre AS bodega_preferida
           FROM zonas_envio z
           LEFT JOIN bodegas b ON b.id = z.bodega_preferida_id
          ${args.region === undefined ? "" : "WHERE z.region = ?"}
          ORDER BY z.region, z.nombre`,
      )
      .bind(...(args.region === undefined ? [] : [args.region]))
      .all<{
        id: string;
        nombre: string;
        alias_json: string;
        region: string;
        metodo: string;
        tarifa_cents: number | null;
        requiere_pago_total: number;
        activa: number;
        bodega_preferida: string | null;
      }>();

    const zonas = results.map((z) => ({
      id: z.id,
      nombre: z.nombre,
      alias: aliasDe(z.alias_json),
      region: z.region,
      metodo: z.metodo,
      // `null` aquí NO es cero: es que esa zona se cotiza a mano. Un cero diría
      // que llevar allá es gratis (TRAMPAS §7).
      tarifaCents: z.tarifa_cents,
      seCotizaAMano: z.tarifa_cents === null,
      pideElPagoCompleto: z.requiere_pago_total === 1,
      activa: z.activa === 1,
      bodegaPreferida: z.bodega_preferida,
    }));

    const activas = zonas.filter((z) => z.activa).length;
    const aMano = zonas.filter((z) => z.seCotizaAMano).length;
    return {
      zonas,
      cuantas: zonas.length,
      aviso:
        zonas.length === 0
          ? args.region === undefined
            ? "Todavía no hay ninguna zona de envío cargada."
            : `No hay ninguna zona cargada en la región «${args.region}».`
          : `${activas} de ${zonas.length} están activas y ${aMano} se cotizan a mano (tarifa en null, que no es cero). ` +
            "La tarifa la pone la dueña desde los ajustes del panel.",
    };
  },
});

/** El alias viaja como texto JSON; uno ilegible no tumba la respuesta. */
function aliasDe(json: string): string[] {
  try {
    const leido: unknown = JSON.parse(json);
    return Array.isArray(leido) ? leido.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

export const verBodegas = definir({
  nombre: "ver_bodegas",
  descripcion:
    "Las bodegas con cuántas variantes y cuántas unidades guarda cada una, y si están en uso. Ejemplo: ver_bodegas dice si la Bodega Panamá Oeste está activa y cuánta mercancía tiene.",
  parametros: z.object({}),
  nivel: "lectura",
  categoria: "entregas",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx) {
    const { results } = await ctx.db
      .prepare(
        `SELECT b.id, b.nombre, b.activa,
                (SELECT COUNT(*) FROM existencias e WHERE e.bodega_id = b.id) AS variantes,
                (SELECT COALESCE(SUM(e.fisico), 0) FROM existencias e WHERE e.bodega_id = b.id) AS unidades
           FROM bodegas b ORDER BY b.nombre`,
      )
      .all<{ id: string; nombre: string; activa: number; variantes: number; unidades: number }>();

    const bodegas = results.map((b) => ({
      id: b.id,
      nombre: b.nombre,
      activa: b.activa === 1,
      variantes: b.variantes,
      unidades: b.unidades,
    }));

    return {
      bodegas,
      cuantas: bodegas.length,
      aviso:
        bodegas.length === 0
          ? "Todavía no hay ninguna bodega cargada."
          : `${bodegas.filter((b) => b.activa).length} de ${bodegas.length} están en uso. ` +
            "«unidades» es lo físico, con lo ya apartado para un pedido dentro: para prometer mercancía " +
            "use ver_stock, que descuenta lo comprometido.",
    };
  },
});

// ---------------------------------------------------------------------------
// Mover el día
// ---------------------------------------------------------------------------

export const programarEntrega = definir({
  nombre: "programar_entrega",
  descripcion:
    "Prepara la entrega de un pedido ya agendado: le da su guía y su sitio en la lista del día. No aparta mercancía, eso lo hizo el pedido. Ejemplo: programar_entrega con el pedidoId de un pedido agendado y programadoPara «2026-11-13».",
  parametros: z.object({
    pedidoId: z
      .string()
      .min(1)
      .max(40)
      .describe("El id del pedido, tal como lo da ver_entregas en «porPreparar»."),
    programadoPara: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "la fecha se escribe así: 2026-11-13")
      .optional()
      .describe("Para qué día. Si falta, hoy en hora de Panamá."),
    ventana: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe(
        "Una de las ventanas de ajustes.ventanas_entrega. Mientras la dueña no las decida, no se acepta ninguna.",
      ),
    motivo: motivoEnLaBitacora,
  }),
  // Anota una entrega y su guía: ni dinero ni existencias.
  nivel: "construccion",
  categoria: "entregas",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const r = await crearEnvio(contextoDeEntrega(ctx), {
      pedidoId: args.pedidoId,
      ...(args.programadoPara === undefined ? {} : { programadoPara: args.programadoPara }),
      ...(args.ventana === undefined ? {} : { ventana: args.ventana }),
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      envioId: r.datos.envioId,
      pedidoId: args.pedidoId,
      bodegaId: r.datos.bodegaId,
      metodo: r.datos.metodo,
      porCobrarCents: r.datos.cobroCents,
      // El token de la guía es lo que va impreso en el papel del QR. No le hace
      // falta al modelo para nada, así que no sale.
    };
  },
});

export const armarRutaDelDia = definir({
  nombre: "armar_ruta",
  descripcion:
    "Arma la tanda del día de un motorizado: una ruta, sus paradas y su orden. Todas las paradas tienen que estar apartadas en la misma bodega. Ejemplo: armar_ruta con motorizadoId, bodegaId y la lista de envioIds que lleva.",
  parametros: z.object({
    motorizadoId: z
      .string()
      .min(1)
      .max(40)
      .describe("El id del motorizado. Sale de ver_entregas o de sugerir_motorizado."),
    bodegaId: z
      .string()
      .min(1)
      .max(40)
      .describe("El id de la bodega de donde carga. Sale de ver_bodegas o de la propia parada."),
    envioIds: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(30)
      .describe("Los envioId de las paradas, sin repetir. Una ruta sin paradas es un paseo."),
    fecha: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "la fecha se escribe así: 2026-11-13")
      .optional()
      .describe("El día de la ruta. Si falta, hoy en hora de Panamá."),
    motivo: motivoEnLaBitacora,
  }),
  nivel: "construccion",
  categoria: "entregas",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    // `origen` NO es un parámetro, y por eso esta ruta no propone orden: el
    // origen es el punto desde el que se mide, dejar que el modelo lo invente
    // daría un orden que parece pensado sin estarlo, y la coordenada de la
    // bodega tampoco tiene por qué viajar hasta el modelo para volver.
    const r = await armarRuta(contextoDeEntrega(ctx), {
      motorizadoId: args.motorizadoId,
      bodegaId: args.bodegaId,
      envioIds: args.envioIds,
      ...(args.fecha === undefined ? {} : { fecha: args.fecha }),
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      rutaId: r.datos.rutaId,
      paradas: r.datos.paradas,
      sinUbicar: r.datos.sinUbicar,
      kmPropuestos: r.datos.kmPropuestos,
      ahorroKm: r.datos.ahorroKm,
      aviso:
        "Las paradas quedan en el orden en que se mandaron: desde aquí no se mide el recorrido, " +
        "porque medirlo pide el punto de salida de la bodega. Para el orden propuesto, el panel.",
    };
  },
});

export const despacharLaRuta = definir({
  nombre: "despachar_ruta",
  descripcion:
    "La ruta sale a la calle: sus paradas pasan a recogido y a en ruta, y sus pedidos a en_ruta, todo en el mismo movimiento. Después de esto la ruta ya no se puede deshacer. Ejemplo: despachar_ruta con el rutaId que devolvió armar_ruta.",
  parametros: z.object({
    rutaId: z
      .string()
      .min(1)
      .max(40)
      .describe("El id de la ruta. Sale de armar_ruta o de ver_entregas."),
    motivo: motivoEnLaBitacora,
  }),
  // No mueve inventario ni dinero: la mercancía sale del inventario al
  // entregar, no al cargar. Lo que escribe son estados y su bitácora.
  nivel: "construccion",
  categoria: "entregas",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const r = await despacharRuta(contextoDeEntrega(ctx), args.rutaId);
    if (!r.ok) throw new Error(r.mensaje);
    return {
      rutaId: args.rutaId,
      paradas: r.datos.paradas,
      pedidos: r.datos.pedidos,
      aviso: "Ya no se puede cancelar: una ruta solo se deshace mientras está en borrador.",
    };
  },
});

/**
 * La clave del intento, derivada del envío y no pedida al modelo.
 *
 * `marcarEntregada` exige una clave de idempotencia porque el motorizado está
 * en la calle con mala señal y va a tocar el botón dos veces. Si la clave fuera
 * un parámetro, un modelo que reintenta generaría una clave NUEVA en cada
 * intento y el candado no cerraría nunca: justo lo contrario de aquello para lo
 * que la clave existe.
 *
 * Derivada del envío, el segundo intento con los mismos datos devuelve la
 * respuesta del primero (`yaEstaba: true`) y el segundo intento con datos
 * distintos se rechaza, que es lo correcto: esa entrega ya se cerró de otra
 * manera.
 */
const claveDelIntento = (que: string, envioId: string) => `asistente:${que}:${envioId}`;

export const marcarEntregadaLaParada = definir({
  nombre: "marcar_entregada",
  descripcion:
    "Cierra una parada como entregada: saca la mercancía del inventario, fija el costo de lo vendido, cobra el saldo si se cobró en la puerta y pasa el pedido a entregado. El monto lo calcula el servidor: si usted dice otro, no se escribe nada. Ejemplo: marcar_entregada con envioId y metodoCobro «efectivo».",
  parametros: z.object({
    envioId: z.string().min(1).max(40).describe("El id de la parada. Sale de ver_entregas."),
    metodoCobro: z
      .enum(METODOS_DE_COBRO)
      .optional()
      .describe("Cómo se cobró el saldo en la puerta. Si falta, no se cobró nada."),
    montoCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional()
      .describe(
        "Lo que se dice haber cobrado, en centavos. No decide: se compara con el saldo del pedido y si no coincide no se escribe nada.",
      ),
    motivo: z
      .string()
      .min(3)
      .max(500)
      .optional()
      .describe("Qué pasó en la puerta. Esto sí queda en la bitácora de la entrega, como su nota."),
  }),
  // Dinero Y existencias a la vez: el inventario sale de verdad y entran tres
  // asientos (la venta, su costo y el cobro del saldo).
  nivel: "sensible",
  categoria: "entregas",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // La ruta del panel comprueba aquí una cosa más: si queda saldo por cobrar
    // en la puerta hace falta además poder editar `cobros`, porque entonces
    // marcar entregado ya no es mover un pedido, es cobrar. Esa comprobación NO
    // se copia, y no por descuido: esta herramienta es solo de la dueña, que es
    // quien tiene `cobros`, así que la condición nunca podría fallar. Un control
    // que comprueba algo que ya era cierto no protege nada y hace creer que algo
    // está vigilado (TRAMPAS §1).
    const r = await marcarEntregada(contextoDeEntrega(ctx), {
      idempotencia: claveDelIntento("entregar", args.envioId),
      envioId: args.envioId,
      ...(args.metodoCobro === undefined ? {} : { metodoCobro: args.metodoCobro }),
      ...(args.montoCents === undefined ? {} : { montoCents: args.montoCents }),
      ...(args.motivo === undefined ? {} : { nota: args.motivo }),
    });

    if (!r.ok) {
      // «esa clave ya se usó para otra cosa» no nombra su causa cuando la clave
      // no la puso quien llama (TRAMPAS §10): aquí la causa es que esa entrega
      // ya se cerró con otro cobro.
      if (r.codigo === "repetido") {
        throw new Error(
          `la entrega ${args.envioId} ya se cerró con otra forma de cobro o otro monto; mírela con ver_entregas`,
        );
      }
      throw new Error(r.mensaje);
    }

    return {
      envioId: r.datos.envioId,
      cobradoCents: r.datos.cobradoCents,
      entregadoEn: r.datos.entregadoEn,
      pedidoEntregado: r.datos.pedidoEntregado,
      yaEstaba: r.datos.yaEstaba,
      // `true` cuando no se sabe lo que costó la mercancía que salió. No se
      // pone un cero: un cero diría que no costó nada y pondría el margen en
      // 100 % (TRAMPAS §7). El pedido cae en «entregados sin costo» del cierre.
      costoDesconocido: r.datos.costoDesconocido,
      aviso: r.datos.costoDesconocido
        ? "Salió sin saber lo que costó la mercancía: el asiento del costo no se escribió y este pedido bloquea el cierre del mes hasta que se cargue el promedio."
        : null,
    };
  },
});

export const marcarFallidaLaParada = definir({
  nombre: "marcar_fallida",
  descripcion:
    "No se pudo entregar: la parada queda fallida y el pedido vuelve a agendado para reintentarlo. La mercancía sigue apartada, porque sigue siendo de esa clienta. Ejemplo: marcar_fallida con envioId y motivo «no había nadie en la casa».",
  parametros: z.object({
    envioId: z.string().min(1).max(40).describe("El id de la parada. Sale de ver_entregas."),
    motivo: z
      .string()
      .min(3)
      .max(300)
      .describe(
        "Por qué no se pudo. Queda en la bitácora de la entrega: sin esto, mañana nadie sabe si hay que volver, llamar o devolver.",
      ),
  }),
  // Ni dinero ni existencias: lo apartado NO se libera, porque una fallida se
  // reintenta y liberarlo pondría a la venta la mercancía de esa clienta. Lo
  // que libera es devolver la parada, que no se expone por aquí.
  nivel: "construccion",
  categoria: "entregas",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const r = await marcarFallida(contextoDeEntrega(ctx), {
      idempotencia: claveDelIntento("fallar", args.envioId),
      envioId: args.envioId,
      motivo: args.motivo,
    });
    if (!r.ok) {
      if (r.codigo === "repetido") {
        throw new Error(
          `la entrega ${args.envioId} ya se marcó fallida con otro motivo; mírela con ver_entregas`,
        );
      }
      throw new Error(r.mensaje);
    }

    return {
      envioId: r.datos.envioId,
      pedidoReprogramado: r.datos.pedidoReprogramado,
      yaEstaba: r.datos.yaEstaba,
      aviso:
        "La mercancía sigue apartada para esa clienta. Para devolverla a la venta hace falta la pantalla de Entregas del panel.",
    };
  },
});

export const reintentarLaParada = definir({
  nombre: "reintentar_entrega",
  descripcion:
    "Una entrega que falló vuelve a la cola para intentarla otra vez: sale de la ruta de ayer y se queda sin motorizado, lista para la próxima. La mercancía sigue apartada, porque sigue siendo de esa clienta. Ejemplo: reintentar_entrega con envioId tras una fallida de «no había nadie».",
  parametros: z.object({
    envioId: z.string().min(1).max(40).describe("El id de la parada fallida. Sale de ver_entregas."),
    motivo: z
      .string()
      .min(3)
      .max(300)
      .optional()
      .describe("Opcional: por qué se vuelve a intentar. Queda en la bitácora."),
  }),
  // Ni dinero ni existencias: lo apartado no se toca. Solo devuelve la parada
  // a la cola, que es la transición que la máquina de estados ya permitía y
  // que no podía hacer nadie.
  nivel: "construccion",
  categoria: "entregas",
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const r = await reintentarEnvio(contextoDeEntrega(ctx), {
      idempotencia: claveDelIntento("reintentar", args.envioId),
      envioId: args.envioId,
      motivo: args.motivo,
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      envioId: r.datos.envioId,
      yaEstaba: r.datos.yaEstaba,
      aviso:
        "Volvió a la cola, sin ruta y sin motorizado. Métala en la próxima ruta con armar_ruta.",
    };
  },
});

export const HERRAMIENTAS_DE_ENTREGAS = [
  verEntregas,
  sugerirMotorizado,
  verZonas,
  verBodegas,
  programarEntrega,
  armarRutaDelDia,
  despacharLaRuta,
  marcarEntregadaLaParada,
  marcarFallidaLaParada,
  reintentarLaParada,
] as const;
