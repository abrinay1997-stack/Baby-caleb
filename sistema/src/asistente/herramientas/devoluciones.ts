import { z } from "zod";
import {
  type ContextoEntrega,
  cancelarRuta,
  cerrarRuta,
  devolverParada,
  devolverPedidoEntregado,
  fechaDePanama,
} from "../../db/entregas";
import { type Contexto, definir } from "../registro";

/**
 * Deshacer y cerrar, por MCP y no solo desde el panel.
 *
 * Archivo aparte de `entregas.ts` —donde viven preparar, armar, despachar y
 * marcar— por cómo llegaron: estas cuatro se escribieron en paralelo con el
 * resto y fundirlas habría dejado un archivo de mil doscientas líneas. Lo que
 * las une entre sí es que todas deshacen o cierran algo que YA PASÓ, que es
 * también lo que hace que las cuatro pidan confirmación.
 *
 * Las cuatro herramientas de aquí cubren las cuatro rutas del panel que
 * deshacen o cierran algo que YA PASÓ: una parada que salió y volvió, una ruta
 * armada por error, el día que termina, y el pedido que la clienta devuelve
 * después de recibirlo. Hasta ahora `scripts/sin-mcp.mjs` las contaba como
 * deuda: el panel podía y MCP no, que es justo lo que `docs/TRAMPAS.md` §13
 * prohíbe dejar para después.
 *
 * ## Tres cosas que este archivo hace a propósito
 *
 * **1. Llama a la MISMA función que la ruta del panel.** `devolverParada`,
 * `cancelarRuta`, `cerrarRuta` y `devolverPedidoEntregado` viven en
 * `src/db/entregas.ts` y son las que usa `src/api/panel.ts`. Aquí no se repite
 * ni una decisión suya: ni qué transición vale, ni cuándo falta decidir el
 * destino de un abono, ni qué cuenta recibe un reintegro. Dos caminos hacia el
 * mismo libro acabarían discrepando, y el que se equivoca del lado flojo es el
 * que nadie revisa — es la misma razón que ya está escrita en
 * `trasladar_stock`.
 *
 * **2. Las cuatro son `sensible`,** así que el asistente no las ejecuta: las
 * PROPONE con el detalle exacto y espera a que una persona toque «Permitir»
 * (06-asistente §3). Deshacer lo que ya pasó es la definición de lo que no se
 * hace solo, y cerrar el día es un número que después se cuadra con el efectivo
 * que hay en la mano.
 *
 * **3. Ninguna borra nada.** Una devolución es un movimiento NUEVO —la
 * mercancía vuelve con el costo con el que salió, el asiento 13 deshace la
 * venta con otro asiento— y una ruta cancelada queda `cancelada`, no borrada,
 * porque alguien la armó y eso pasó. Los libros no se editan (`CLAUDE.md`), y
 * eso no lo garantiza este archivo: lo garantizan las funciones de `db/` y los
 * triggers de la 0009, que es donde tiene que estar garantizado.
 *
 * ## Qué le llega al modelo, y qué no
 *
 * Al modelo del asistente no le llegan datos de clientas (D-20, 06-asistente
 * §7). Por eso una entrega se nombra por el NÚMERO DEL PEDIDO —`BC-000123`— y
 * nunca por su dirección, su punto en el mapa ni el nombre de quien la espera,
 * que es justo lo que `entregasDelDia` sí le da a la pantalla del panel porque
 * ahí lo mira una persona. Tampoco vuelve el nombre del motorizado en ninguna
 * respuesta: un nombre propio es un nombre propio, y si además coincide con el
 * de una clienta la guarda de `referencias.ts` lo frena —con razón— y la
 * respuesta se pierde entera. Quien preguntó ya sabe de quién es la ruta: la
 * acaba de nombrar.
 *
 * ## Por qué `devolver_pedido` está aquí y no en un archivo de pedidos
 *
 * Su ruta es `POST /pedidos/:id/devolucion`, pero la función que llama es
 * `devolverPedidoEntregado` de `db/entregas.ts`: devolver lo que ya se entregó
 * es el último tramo de una entrega, y las dos devoluciones —la de la parada
 * que no se pudo dejar y la del pedido que sí llegó— solo se entienden juntas,
 * porque la pregunta difícil es cuál de las dos toca. Su `categoria` sí es
 * `pedidos`, que es donde una persona la va a buscar en la bitácora.
 */

/**
 * El contexto que piden las funciones de `db/entregas.ts`.
 *
 * El actor es el CORREO y no el id, igual que `contextoEntrega` en
 * `src/api/panel.ts`. La bitácora de una parada la lee una persona preguntando
 * «¿quién devolvió esto?», y un ULID no contesta esa pregunta. Que las dos
 * puertas escriban el mismo actor es la diferencia entre tener una bitácora y
 * tener dos.
 */
const motorDeEntregas = (ctx: Contexto): ContextoEntrega => ({
  db: ctx.db,
  ahora: ctx.ahora,
  actor: ctx.usuario.correo,
});

const numeroDePedido = z
  .string()
  .min(3)
  .max(40)
  .describe("El número del pedido, como BC-000123.");

const motivo = z
  .string()
  .min(3)
  .max(200)
  .describe(
    "Por qué se hace. Queda escrito en la bitácora del pedido o de la ruta, y es lo que lo explica meses después.",
  );

const nombreDeMotorizado = z
  .string()
  .min(2)
  .max(80)
  .describe("El nombre del motorizado, como aparece en el panel. Ejemplo: «Luis Mora».");

const diaDeLaRuta = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "el día se escribe AAAA-MM-DD")
  .describe("El día de la ruta, AAAA-MM-DD. Si falta, hoy en Panamá.");

// ---------------------------------------------------------------------------
// De lo que la persona dice a lo que la base guarda
// ---------------------------------------------------------------------------

interface Pedido {
  id: string;
  numero: string;
  estado: string;
}

/**
 * El pedido por su número.
 *
 * El asistente habla de pedidos por el número que la clienta ve y el motor por
 * su ULID: esta es la única traducción, y es la misma que hace `bodegaPorNombre`
 * con las bodegas. Pedir el ULID sería pedir un dato que nadie dice en voz alta
 * y que ninguna herramienta de hoy devuelve.
 *
 * Se normaliza a mayúsculas porque el número se escribe `BC-000123` y quien lo
 * teclea —o el modelo que lo repite— lo escribe como le sale. Lo que NO se hace
 * es rellenarlo: «123» no se convierte en «BC-000123», porque eso sería
 * adivinar de qué pedido habla, y aquí se devuelve mercancía.
 */
async function elPedido(db: D1Database, numero: string): Promise<Pedido> {
  const limpio = numero.trim().toUpperCase();
  const p = await db
    .prepare("SELECT id, numero, estado FROM pedidos WHERE numero = ?")
    .bind(limpio)
    .first<Pedido>();
  if (p === null) {
    throw new Error(
      `no existe ningún pedido con el número «${limpio}»; el número es completo y va como BC-000123`,
    );
  }
  return p;
}

/**
 * La parada viva de un pedido: la que todavía se puede devolver.
 *
 * Hay como máximo UNA, y no es una suposición: el índice único
 * `envios_uno_vivo_por_pedido` de la 0009 lo impide, porque con dos envíos
 * vivos a la vez el inventario se descargaría dos veces.
 *
 * Cuando no hay ninguna, el motivo importa más que el hecho, y son cuatro
 * motivos distintos que desde un `null` se parecen todos (`TRAMPAS` §10: cada
 * error nombra SU causa). Sobre todo uno: un pedido ya entregado no se devuelve
 * por aquí, se devuelve con `devolver_pedido`, y si esta herramienta contestara
 * «no hay parada» el modelo se rendiría teniendo la herramienta correcta al
 * lado. La consulta extra solo se hace en ese camino: cuando ya se sabe que
 * algo va mal.
 */
async function laParadaQueSePuedeDevolver(db: D1Database, pedido: Pedido): Promise<string> {
  const viva = await db
    .prepare(
      `SELECT id FROM envios
        WHERE pedido_id = ? AND estado NOT IN ('entregado','devuelto','anulado')`,
    )
    .bind(pedido.id)
    .first<{ id: string }>();
  if (viva !== null) return viva.id;

  const ultima = await db
    .prepare("SELECT estado FROM envios WHERE pedido_id = ? ORDER BY creado_en DESC, id DESC LIMIT 1")
    .bind(pedido.id)
    .first<{ estado: string }>();

  if (ultima === null) {
    throw new Error(
      `el pedido ${pedido.numero} está ${pedido.estado} y no tiene ninguna entrega preparada: no hay parada que devolver`,
    );
  }
  if (ultima.estado === "entregado") {
    throw new Error(
      `el pedido ${pedido.numero} SÍ se entregó. Lo que la clienta devuelve después de recibirlo se registra con devolver_pedido, que deshace la venta; esta herramienta es para la parada que volvió sin entregarse`,
    );
  }
  if (ultima.estado === "devuelto") {
    throw new Error(`la entrega del pedido ${pedido.numero} ya está devuelta`);
  }
  throw new Error(
    `la entrega del pedido ${pedido.numero} está ${ultima.estado}: no hay ninguna parada viva que devolver`,
  );
}

/**
 * La ruta de un motorizado en un día.
 *
 * Es el único handle que una persona puede dar: una ruta no tiene número y su
 * id es un ULID que hoy no devuelve ninguna herramienta. Y alcanza, porque el
 * índice único `rutas_una_por_dia` garantiza como máximo UNA ruta no cancelada
 * por motorizado y por día — así que esto no elige entre varias, las encuentra.
 *
 * El nombre se compara sin distinguir mayúsculas y sin espacios de sobra: quien
 * dicta un nombre no lo teclea igual dos veces. Lo que NO se filtra es el
 * estado del motorizado: una ruta de alguien que después se dio de baja se
 * sigue pudiendo cancelar y cerrar, y el día que no se pudiera quedaría una
 * ruta abierta para siempre.
 *
 * Si dos motorizados se llaman igual Y los dos tienen ruta ese día, esto falla
 * en vez de quedarse con la primera: cerrar la ruta equivocada cuenta el
 * efectivo de otra persona.
 */
async function laRutaDelDia(
  db: D1Database,
  nombre: string,
  fecha: string,
): Promise<{ id: string; estado: string }> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.estado FROM rutas r
         JOIN motorizados m ON m.id = r.motorizado_id
        WHERE lower(trim(m.nombre)) = lower(trim(?)) AND r.fecha = ? AND r.estado <> 'cancelada'`,
    )
    .bind(nombre, fecha)
    .all<{ id: string; estado: string }>();

  if (results.length === 1) return results[0] as { id: string; estado: string };

  if (results.length > 1) {
    throw new Error(
      `hay ${results.length} motorizados con ese nombre y ruta el ${fecha}: no se puede saber de cuál habla. Hágalo desde el panel, que las distingue`,
    );
  }

  // Sin ruta: otra vez, el motivo importa más que el hecho.
  const existe = await db
    .prepare("SELECT COUNT(*) AS n FROM motorizados WHERE lower(trim(nombre)) = lower(trim(?))")
    .bind(nombre)
    .first<{ n: number }>();
  if ((existe?.n ?? 0) === 0) {
    throw new Error(`no hay ningún motorizado llamado «${nombre.trim()}»`);
  }
  throw new Error(
    `«${nombre.trim()}» no tiene ninguna ruta sin cancelar el ${fecha}. Si la ruta es de otro día, dígalo con fecha`,
  );
}

// ---------------------------------------------------------------------------
// Las herramientas
// ---------------------------------------------------------------------------

export const devolverLaParada = definir({
  nombre: "devolver_parada",
  descripcion:
    "Devuelve a la bodega una entrega que salió y no se pudo dejar: libera lo que estaba apartado y cancela el pedido. El intento tiene que estar marcado como fallido antes. Ejemplo: devolver_parada con pedido «BC-000123» y motivo «la clienta se mudó». Si el pedido SÍ se entregó y la clienta lo devuelve después, es devolver_pedido.",
  parametros: z.object({ pedido: numeroDePedido, motivo }),
  nivel: "sensible",
  categoria: "entregas",
  // Solo la dueña, que es MENOS de lo que da la ruta del panel.
  //
  // La ruta pide editar `pedidos`, y eso en la matriz lo tienen la dueña y la
  // asistente. Aquí no, porque el catálogo tiene una regla propia y más
  // estrecha —«lo sensible es SOLO de la dueña», con su prueba en
  // `registro.test.ts`— que es la que sigue la tabla de 06-asistente §5: todas
  // sus herramientas sensibles son de la dueña. Entre abrirle una puerta a la
  // asistente y respetar esa regla, se respeta la regla: quedarse corto se
  // nota el día que ella lo intente, y pasarse no se nota nunca.
  //
  // Queda dicho que es un hueco: la asistente devuelve una parada desde el
  // panel y no por MCP. Cerrarlo bien es que una herramienta declare el
  // `Permiso` que necesita y que los roles salgan de `seguridad/roles.ts`, que
  // es cambiar el contrato de `registro.ts` para todas.
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const pedido = await elPedido(ctx.db, args.pedido);
    const envioId = await laParadaQueSePuedeDevolver(ctx.db, pedido);

    const r = await devolverParada(motorDeEntregas(ctx), envioId, args.motivo);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pedido: pedido.numero,
      devuelta: r.datos.devuelta,
      // Cuántas filas de existencias volvieron a estar a la venta. El físico no
      // se movió: la mercancía estaba apartada, no había salido.
      liberadas: r.datos.liberadas,
      // El dinero no se mueve aquí. Lo que vuelve es lo que la clienta tenía
      // abonado y la decisión que había vigente ese día (reembolso o crédito),
      // que es lo que después ejecuta un reembolso o el asiento 16. Decirlo
      // importa: sin esto el asistente contestaría «ya está» y nadie se
      // acordaría de que hay dinero de otra persona esperando destino.
      abonoCents: r.datos.abonoCents,
      destinoDelAbono: r.datos.destinoDelAbono,
    };
  },
});

export const devolverElPedido = definir({
  nombre: "devolver_pedido",
  descripcion:
    "La clienta devuelve un pedido que YA se le entregó: la mercancía vuelve al inventario con el costo con el que salió y la venta se deshace con su asiento. Se devuelve el pedido entero. Ejemplo: devolver_pedido con pedido «BC-000123» y motivo «le quedó chica». Si la entrega no se llegó a hacer, es devolver_parada.",
  parametros: z.object({ pedido: numeroDePedido, motivo }),
  nivel: "sensible",
  categoria: "pedidos",
  // Solo la dueña. Su ruta pide editar `cobros` y no `pedidos`, porque esto
  // decide dinero —una venta menos y un saldo a favor de la clienta— y en la
  // matriz de hoy eso es solo ella.
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const pedido = await elPedido(ctx.db, args.pedido);

    const r = await devolverPedidoEntregado(motorDeEntregas(ctx), pedido.id, args.motivo);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pedido: pedido.numero,
      piezasDevueltas: r.datos.piezasDevueltas,
      reintegradoCents: r.datos.reintegradoCents,
      // 1201 descarga lo que la clienta debía; 2101 dice que ese dinero ya es
      // suyo y está aquí. Son dos conversaciones distintas con ella, así que
      // el asistente tiene que poder decir cuál de las dos es.
      cuentaReintegro: r.datos.cuentaReintegro,
      avisoContable: avisoDeLaDevolucion(r.datos.costoDesconocido),
    };
  },
});

/**
 * El hueco de la devolución, dicho en palabras.
 *
 * El dato que viene de `db/` es un `costoDesconocido: boolean`, y aquí no sale
 * con ese nombre a propósito: el costo tiene su propio permiso
 * (`costo_y_margen`) y ninguna herramienta del asistente lo trae, así que
 * tampoco se le manda al modelo una clave que se llame así. Lo que sí hace
 * falta es el aviso: una pieza que salió sin promedio cargado vuelve sin valor,
 * el inventario no recupera nada y el margen de ese pedido queda contado de
 * menos. Un cero ahí diría que la mercancía no costó nada (`TRAMPAS` §7), así
 * que se dice que falta.
 */
function avisoDeLaDevolucion(costoDesconocido: boolean): string | null {
  return costoDesconocido
    ? "Alguna pieza de este pedido había salido sin valor de entrada cargado, así que vuelve sin valor y el inventario no lo recupera. El asiento solo deshace lo que se sabía; revise el pedido en el cierre."
    : null;
}

export const cancelarLaRuta = definir({
  nombre: "cancelar_ruta",
  descripcion:
    "Deshace la ruta de un motorizado que todavía no salió de la bodega: sus paradas vuelven a quedar libres para otra ruta y la ruta queda cancelada, no borrada. Ejemplo: cancelar_ruta con motorizado «Luis Mora» y motivo «me equivoqué de motorizado». Una ruta que ya salió no se cancela.",
  parametros: z.object({
    motorizado: nombreDeMotorizado,
    fecha: diaDeLaRuta.optional(),
    motivo,
  }),
  nivel: "sensible",
  categoria: "entregas",
  // Solo la dueña, por lo mismo que `devolver_parada`: el catálogo no le da
  // nada sensible a nadie más.
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // El día de Panamá, no el de UTC: con la fecha en UTC, todo lo de después
    // de las siete de la noche buscaría la ruta de mañana y diría que no hay.
    const fecha = args.fecha ?? fechaDePanama(ctx.ahora);
    const ruta = await laRutaDelDia(ctx.db, args.motorizado, fecha);

    const r = await cancelarRuta(motorDeEntregas(ctx), ruta.id, args.motivo);
    if (!r.ok) throw new Error(r.mensaje);

    return { fecha, cancelada: r.datos.cancelada, paradasLiberadas: r.datos.paradas };
  },
});

export const cerrarLaRuta = definir({
  nombre: "cerrar_ruta",
  descripcion:
    "Cierra el día de un motorizado cuando volvió, y cuenta lo entregado y lo cobrado en la calle. No cierra si queda una parada sin marcar. Ejemplo: cerrar_ruta con motorizado «Luis Mora», o con fecha «2026-11-10» para cerrar la de otro día.",
  // La única que escribe y NO pide motivo, y es la única excepción de la regla
  // del catálogo (su prueba en `registro.test.ts` la nombra). Cerrar no
  // corrige nada ni mueve una cifra: cuenta lo que ya pasó y marca el día como
  // terminado. Lo que explica un cierre es su propio contenido —qué se entregó
  // y cuánto se cobró—, y `cerrarRuta` no tiene dónde guardar un motivo, así
  // que pedirlo sería pedir «porque volvió» cada tarde y quedaría un parámetro
  // que se ignora en silencio (`TRAMPAS` §9). Quién cerró y cuándo sí quedan:
  // en `acciones` y en `rutas.cerrada_en`.
  parametros: z.object({
    motorizado: nombreDeMotorizado,
    fecha: diaDeLaRuta.optional(),
  }),
  nivel: "sensible",
  categoria: "entregas",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const fecha = args.fecha ?? fechaDePanama(ctx.ahora);
    const ruta = await laRutaDelDia(ctx.db, args.motorizado, fecha);

    const r = await cerrarRuta(motorDeEntregas(ctx), ruta.id);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      fecha,
      cerrada: r.datos.cerrada,
      entregadas: r.datos.entregadas,
      // Lo que el motorizado tiene que entregar en efectivo o ya pasó por
      // Yappy. Es el número con el que se le cuenta la mano, así que sale
      // contado por la base y no por el asistente.
      cobradoCents: r.datos.cobradoCents,
    };
  },
});

export const HERRAMIENTAS_DE_DEVOLUCIONES = [
  devolverLaParada,
  devolverElPedido,
  cancelarLaRuta,
  cerrarLaRuta,
] as const;
