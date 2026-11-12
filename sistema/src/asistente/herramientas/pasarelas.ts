import { z } from "zod";
import { registrarContracargo, registrarReembolso } from "../../db/pagos";
import { apagar, cambiarModo, encender, estado } from "../../db/pasarelas";
import { MODOS, PASARELAS, type Modo, type Pasarela } from "../../dominio/pasarelas";
import { definir, type Contexto } from "../registro";

/**
 * Las pasarelas de cobro, por la tercera puerta (TRAMPAS §13).
 *
 * Archivo aparte de `dinero.ts` —donde viven la bandeja de comprobantes y el
 * cobro— por cómo llegaron: `dinero.ts` ya existía con esas herramientas y
 * estas seis se escribieron en paralelo, así que fundirlas en un archivo de
 * ochocientas líneas no habría dejado nada más claro. Lo que las une es el
 * dinero; lo que las separa es que estas tocan la CONFIGURACIÓN del cobro y
 * aquellas el cobro mismo.
 *
 * El panel ya sabía hacer todo esto: ver cómo están las tres pasarelas,
 * encenderlas, apagarlas, cambiarles el modo y anotar un reembolso o un
 * contracargo. Lo que no se podía era hacerlo sin navegador, y eso es
 * exactamente la trampa de la regla 13: una capacidad que solo se alcanza
 * desde una pantalla depende de que esa pantalla exista, se despliegue y esté
 * bien escrita, y en este repositorio las tres cosas ya han fallado por
 * separado.
 *
 * ## Las tres reglas de este archivo
 *
 *  1. **La misma función que llama el panel.** Cada herramienta de aquí entra
 *     por `src/db/pasarelas.ts` o `src/db/pagos.ts`, por la misma puerta que
 *     usa `src/api/panel.ts`. No hay una segunda versión de «encender una
 *     pasarela» ni de «sacar dinero de un pago»: dos caminos hacia el mismo
 *     dato acaban discrepando, y el que se equivoca del lado flojo es el que
 *     nadie revisa.
 *  2. **Lo que mueve dinero se propone, no se hace.** Las cinco que escriben
 *     son `sensible`, así que `ejecutar.ts` las deja en `por_confirmar` y no
 *     las corre hasta que una persona toque «Permitir» (06-asistente §3).
 *  3. **Ninguna credencial sale por aquí.** Ni entera, ni recortada, ni su
 *     identificador de llave, ni quién la puso. Más abajo está qué se recorta
 *     respecto de lo que enseña el panel, y por qué cada cosa.
 *
 * ## Lo que un reembolso NO es
 *
 * No es borrar el cobro. Los libros no se editan ni se borran (CLAUDE.md), así
 * que un reembolso es un asiento NUEVO —el 14— que deshace el efecto del
 * anterior sin tocarlo, y un contracargo es el 15. Y ninguno de los dos ordena
 * nada a la pasarela: el sistema no mueve dinero, así que lo que esto hace es
 * ANOTAR lo que ya ocurrió (la transferencia de vuelta, el efectivo entregado,
 * la devolución hecha en el portal) junto con su asiento, en un solo batch.
 *
 * ## Aquí no hay ni una cifra
 *
 * Las comisiones de las pasarelas están PENDIENTES de la dueña (04-pagos §8 y
 * §9) y siguen estándolo: ninguna herramienta de este archivo estima, redondea
 * ni rellena una comisión. El monto que vuelve lo dice quien lo registra y lo
 * comprueba `src/db/pagos.ts` contra el pago de verdad.
 */

/**
 * El contexto que esperan las funciones de las pasarelas.
 *
 * `actor` va con el CORREO y no con el id, igual que en `panel.ts`: la bitácora
 * de pasarelas y el historial de `ajustes` ya están escritos con correos, y
 * mezclar las dos formas dejaría un libro en el que la mitad de las líneas no
 * se puede leer de un vistazo.
 *
 * **Sin `llaveMaestra`, y a propósito.** El contexto del asistente no trae
 * `env`, así que la llave maestra del Worker no está a mano — y no hace falta:
 * encender, apagar y cambiar de modo no descifran nada. Lo único que la usa es
 * el `llave_maestra_puesta` del estado, que por eso tampoco sale por aquí.
 */
const comoPasarelas = (ctx: Contexto) => ({
  db: ctx.db,
  ahora: ctx.ahora,
  actor: ctx.usuario.correo,
});

/** Lo mismo para el dinero: `src/db/pagos.ts` también firma con el correo. */
const comoPagos = (ctx: Contexto) => ({
  db: ctx.db,
  ahora: ctx.ahora,
  actor: ctx.usuario.correo,
});

/**
 * Las tres salen de `dominio/pasarelas.ts` en vez de escribirse a mano.
 *
 * Es la trampa §8: una lista repetida es otra lista que alguien tiene que
 * acordarse de tocar. Así, el día que entre una cuarta pasarela, el esquema que
 * ve el modelo la trae sin que nadie venga aquí.
 */
const pasarela = z
  .enum(PASARELAS)
  .describe("Cuál de las tres pasarelas de cobro: yappy, tilopay o paypal.");

const motivo = z
  .string()
  .min(3)
  .max(500)
  .describe(
    "Por qué se hace. Queda escrito en el libro y es lo que lo explica dentro de seis meses.",
  );

// ---------------------------------------------------------------------------
// Ver cómo están las pasarelas
// ---------------------------------------------------------------------------

/** Lo que de una pasarela se puede contar hacia fuera. */
interface ComoEsta {
  readonly pasarela: Pasarela;
  readonly titulo: string;
  readonly encendida: boolean;
  readonly modo: Modo;
  /**
   * Encendida Y en modo real. Son los dos datos que hay que mirar juntos para
   * contestar la única pregunta que importa —«¿esto le está cobrando de verdad
   * a alguien ahora mismo?»— y separados se contestan mal: «está en real» suena
   * a que cobra aunque esté apagada, y «está encendida» suena a que cobra aunque
   * esté en prueba.
   */
  readonly cobrando_de_verdad: boolean;
  readonly puede_encenderse: boolean;
  readonly por_que_no: string | null;
  /** Los TÍTULOS de las credenciales obligatorias que faltan. Nunca su valor. */
  readonly le_falta: readonly string[];
  readonly incoherente: boolean;
}

export const verPasarelas = definir({
  nombre: "ver_pasarelas",
  descripcion:
    "Cómo están las tres pasarelas de cobro: cuáles están encendidas, en qué modo está cada una (de prueba, que no cobra, o real, que cobra de verdad) y qué le falta a la que no se puede encender. Ejemplo: ver_pasarelas dice si el botón de Yappy les está cobrando a las clientas hoy. Las credenciales no salen por aquí ni se ponen por aquí.",
  parametros: z.object({}),
  nivel: "lectura",
  categoria: "ajustes",
  // El permiso de la ruta del panel es `ajustes`, y en la matriz de roles hoy
  // solo lo tiene la dueña. Se copia tal cual: una herramienta que decide por su
  // cuenta a quién deja mirar es la que acaba discrepando de la pantalla.
  roles: ["duena"],

  async ejecutar(ctx) {
    const r = await estado({ db: ctx.db, ahora: ctx.ahora });
    if (!r.ok) throw new Error(r.mensaje);

    const pasarelas = r.datos.pasarelas.map((p): ComoEsta => {
      const actual = p.modos.find((m) => m.esElActual);
      return {
        pasarela: p.pasarela,
        titulo: p.titulo,
        encendida: p.encendida,
        modo: p.modo,
        cobrando_de_verdad: p.encendida && p.modo === "real",
        puede_encenderse: p.puede_encenderse,
        por_que_no: p.por_que_no,
        le_falta: actual?.faltan ?? [],
        incoherente: p.incoherente,
      };
    });

    return {
      pasarelas,
      encendidas: pasarelas.filter((p) => p.encendida).map((p) => p.pasarela),
      aviso: queNoSaleDeAqui(pasarelas),
    };
  },
});

/**
 * Lo que esta herramienta NO contesta, dicho siempre.
 *
 * El `aviso` de las demás herramientas de lectura explica por qué una lista
 * volvió vacía. Aquí la lista nunca está vacía —las pasarelas son tres y están
 * siempre— y lo que hay que explicar es otra cosa: que esta respuesta es un
 * RECORTE deliberado de lo que enseña el panel. Un modelo que no ve las
 * credenciales y no sabe por qué concluye que no hay ninguna puesta, y es justo
 * al contrario: no se las dejamos ver.
 *
 * Qué se recorta respecto de `GET /pasarelas`, y por qué cada cosa:
 *
 *  - **El valor de cada credencial.** No se recorta: no se lee. La consulta de
 *    `estado` no nombra la columna `secreto_cifrado`, así que no hay nada que
 *    borrar antes de responder. Lo que no se lee no se puede devolver por error.
 *  - **La ficha de cada credencial** (`puesta`, `version`, `puesta_por`,
 *    `puesta_en`, `llave_id`). El panel la enseña para que la dueña sepa qué
 *    tiene guardado y desde cuándo; por MCP no sirve para nada que esta
 *    herramienta pueda hacer —poner una credencial es `solo_panel`— y trae dos
 *    cosas que no deben viajar: el correo de quien la puso y el identificador de
 *    la llave maestra con la que se cifró. De las obligatorias que faltan sale
 *    su TÍTULO, que es lo que hace falta para saber por qué una pasarela no se
 *    puede encender.
 *  - **El libro** (`pasarela_bitacora`) y **el historial de encendidas**. Son
 *    treinta líneas con el correo de quien hizo cada cambio y su motivo escrito
 *    a mano. Eso es la bitácora del negocio, se lee en el panel, y además el
 *    filtro de la frontera de MCP corta cualquier resultado que lleve un correo
 *    dentro: mandarlo no sería una fuga, sería un error.
 *  - **Si la llave maestra está puesta.** Esta herramienta no tiene la llave
 *    (arriba, `comoPasarelas`), así que lo que `estado` diría es «no está» —y
 *    «no la tengo a mano» no es lo mismo que «no está puesta». Afirmar lo
 *    segundo sabiendo lo primero es la trampa §7, así que no se dice: se remite
 *    al panel, que sí la tiene.
 */
function queNoSaleDeAqui(pasarelas: readonly ComoEsta[]): string {
  const partes = [
    "Por aquí sale el estado, nunca las credenciales: ni su valor, ni quién las puso, ni cuándo. " +
      "Ponerlas o cambiarlas se hace tecleándolas en la pantalla de Pasarelas del panel, que es " +
      "donde se ven. El libro de quién cambió qué, y si la llave maestra del Worker está puesta, " +
      "tampoco salen de aquí: que no aparezcan no significa que no estén.",
  ];

  const encendidas = pasarelas.filter((p) => p.encendida);
  if (encendidas.length === 0) {
    partes.push(
      "Hoy no hay ninguna pasarela encendida: el cobro en línea no está disponible y se cobra con " +
        "comprobante (Yappy Comercial, transferencia o efectivo), que siempre está.",
    );
  }

  const incoherentes = pasarelas.filter((p) => p.incoherente);
  if (incoherentes.length > 0) {
    // No debería poder pasar por estas funciones, pero la lista de encendidas
    // también se puede editar desde la pantalla de Ajustes, que no sabe nada de
    // credenciales. Si pasa, el checkout ofrece un botón que no cobra, y eso se
    // grita en vez de dejarlo dentro de un campo booleano.
    partes.push(
      `${incoherentes.map((p) => p.titulo).join(" y ")} está encendida y le falta algo para poder ` +
        "estarlo: el checkout ofrece un botón que no va a cobrar. Hay que apagarla o completarla.",
    );
  }

  return partes.join(" ");
}

// ---------------------------------------------------------------------------
// El interruptor
// ---------------------------------------------------------------------------

export const encenderPasarela = definir({
  nombre: "encender_pasarela",
  descripcion:
    "Enciende una pasarela de cobro: desde ese momento el checkout la ofrece a las clientas. Se niega si le falta una credencial obligatoria, y si está en modo real cobra dinero de verdad — mire ver_pasarelas antes. Ejemplo: encender_pasarela con pasarela «yappy» y motivo «ya se hizo el cobro de prueba de un dólar y su reembolso».",
  parametros: z.object({ pasarela, motivo }),
  nivel: "sensible",
  categoria: "ajustes",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // El modo se lee ANTES de encender, no después, y por dos razones. La
    // primera es que es la mitad de la noticia: «Yappy encendida» no dice si le
    // está cobrando a alguien de verdad. La segunda es el orden — leer después
    // de escribir obliga a decidir qué contestar si la lectura falla con el
    // cambio ya hecho, y «salió bien pero no sé cómo quedó» no es una respuesta
    // que un agente pueda usar.
    const antes = await estado({ db: ctx.db, ahora: ctx.ahora });
    if (!antes.ok) throw new Error(antes.mensaje);
    const suyo = antes.datos.pasarelas.find((p) => p.pasarela === args.pasarela);
    if (suyo === undefined) throw new Error(`no existe la configuración de ${args.pasarela}`);

    const r = await encender(comoPasarelas(ctx), {
      pasarela: args.pasarela,
      motivo: args.motivo,
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pasarela: r.datos.pasarela,
      encendida: true,
      modo: suyo.modo,
      cobrando_de_verdad: suyo.modo === "real",
      // `cambio: false` significa que ya estaba encendida. Se dice en vez de
      // contestar lo mismo que un cambio de verdad: quien lo repita tiene que
      // poder notar que la segunda vez no pasó nada.
      cambio: r.datos.cambio,
    };
  },
});

export const apagarPasarela = definir({
  nombre: "apagar_pasarela",
  descripcion:
    "Apaga una pasarela de cobro: el checkout deja de ofrecerla al instante. Siempre se puede, aunque esté a medio configurar o recién encendida. Ejemplo: apagar_pasarela con pasarela «paypal» y motivo «están rechazando todos los cobros».",
  parametros: z.object({ pasarela, motivo }),
  // Sensible como encender, y no es contradecir el interruptor de emergencia de
  // 04-pagos §10. Lo que ese interruptor no puede tener son CONDICIONES —algo
  // que falle y lo deje sin responder el día que hace falta—, y pedir que una
  // persona lo permita no es una condición: es la persona. Apagar sigue sin
  // comprobar credenciales, sin mirar el modo y sin exigir que esté coherente, y
  // el camino corto sigue existiendo: el botón del panel.
  nivel: "sensible",
  categoria: "ajustes",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await apagar(comoPasarelas(ctx), { pasarela: args.pasarela, motivo: args.motivo });
    if (!r.ok) throw new Error(r.mensaje);
    return { pasarela: r.datos.pasarela, encendida: false, cambio: r.datos.cambio };
  },
});

export const cambiarModoDePasarela = definir({
  nombre: "cambiar_modo_de_pasarela",
  descripcion:
    "Pasa una pasarela de modo de prueba a modo real, o al revés. En real cobra dinero de verdad, con el otro juego de credenciales. No se puede con la pasarela encendida: hay que apagarla, cambiarla, revisarla y volver a encenderla. Ejemplo: cambiar_modo_de_pasarela con pasarela «yappy», modo «real» y motivo «ya están puestas las credenciales de producción».",
  parametros: z.object({
    pasarela,
    modo: z
      .enum(MODOS)
      .describe("«prueba» no cobra; «real» cobra de verdad con las credenciales de producción."),
    motivo,
  }),
  nivel: "sensible",
  categoria: "ajustes",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // La negativa a cambiar el modo con la pasarela encendida la pone
    // `cambiarModo`, no esta herramienta: es la regla que impide el fallo caro
    // de esta pieza —cobrar de verdad con las claves de prueba— y tiene que
    // decidirse en un solo sitio para las dos puertas.
    const r = await cambiarModo(comoPasarelas(ctx), {
      pasarela: args.pasarela,
      modo: args.modo,
      motivo: args.motivo,
    });
    if (!r.ok) throw new Error(r.mensaje);
    return {
      pasarela: r.datos.pasarela,
      modo: r.datos.modo,
      cambio: r.datos.cambio,
      // Cambiar el modo NO enciende nada: son dos actos y quedan escritos por
      // separado. Antes de encender en producción, 04-pagos §10 pide además un
      // cobro real de un dólar y su reembolso.
      sigue_apagada: true,
    };
  },
});

// ---------------------------------------------------------------------------
// El dinero que vuelve
// ---------------------------------------------------------------------------

const pagoId = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "El identificador del pago, como aparece en la pantalla de Cobros del panel. Es de UN pago, no del pedido: un pedido tiene varios pagos y cada uno lleva lo suyo.",
  );

/**
 * El monto va suelto, sin tope propio.
 *
 * Un máximo aquí sería una segunda opinión sobre cuánto dinero puede volver, y
 * la primera ya existe y es mejor: `src/db/pagos.ts` lo compara con lo que ese
 * pago tiene y con lo que el pedido lleva cobrado, y lo dice con las cifras
 * («de ese pago de $30.00 ya volvieron $10.00…»). Un tope mío solo podría
 * contestar «es demasiado» sin saber de qué.
 */
const montoCents = z
  .number()
  .int()
  .positive()
  .describe("Cuánto volvió, en CENTAVOS: $30.00 son 3000. Puede ser una parte del pago.");

const proveedorRef = z
  .string()
  .min(1)
  .max(120)
  .optional()
  .describe(
    "La referencia de la pasarela o del comprobante del Yappy de vuelta, si la hay. Sirve para cuadrar con el extracto.",
  );

export const reembolso = definir({
  nombre: "registrar_reembolso",
  descripcion:
    "Anota un reembolso QUE YA SE HIZO —la transferencia de vuelta, el efectivo entregado o la devolución hecha en el portal de la pasarela— y escribe su asiento. No le ordena nada a la pasarela: el sistema no mueve dinero. Puede ser parcial. Ejemplo: registrar_reembolso con pago_id «01JD…», monto_cents 3000 y motivo «se arrepintió y el pedido no había salido».",
  parametros: z.object({
    pago_id: pagoId,
    monto_cents: montoCents,
    motivo,
    proveedor_ref: proveedorRef,
  }),
  nivel: "sensible",
  categoria: "dinero",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await registrarReembolso(comoPagos(ctx), {
      pagoId: args.pago_id,
      montoCents: args.monto_cents,
      motivo: args.motivo,
      // `exactOptionalPropertyTypes` no deja mandar `proveedorRef: undefined`
      // donde la propiedad es opcional: o va con valor, o no va.
      ...(args.proveedor_ref === undefined ? {} : { proveedorRef: args.proveedor_ref }),
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pago_id: r.datos.pagoId,
      devuelto_cents: r.datos.montoCents,
      pagado_cents: r.datos.pagadoCents,
      estado_del_pago: r.datos.estadoDelPago,
      // Se nombra el asiento porque es lo que hay que poder contestar cuando
      // alguien pregunte si «se deshizo» el cobro: no se deshizo nada, se anotó
      // lo contrario al lado. El asiento del cobro sigue donde estaba.
      asiento: "14 · Reembolso (nuevo; el asiento del cobro no se toca)",
    };
  },
});

export const contracargo = definir({
  nombre: "registrar_contracargo",
  descripcion:
    "Anota un contracargo o una disputa: la pasarela o el banco de la clienta se llevaron de vuelta un cobro que ya había entrado, y escribe su asiento. Lo decide el banco y no el negocio, así que se registra aunque la disputa siga abierta. Ejemplo: registrar_contracargo con pago_id «01JD…», monto_cents 2500 y motivo «la clienta desconoció el cargo, disputa abierta en el portal».",
  parametros: z.object({
    pago_id: pagoId,
    monto_cents: montoCents,
    motivo,
    proveedor_ref: proveedorRef,
  }),
  nivel: "sensible",
  categoria: "dinero",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await registrarContracargo(comoPagos(ctx), {
      pagoId: args.pago_id,
      montoCents: args.monto_cents,
      motivo: args.motivo,
      ...(args.proveedor_ref === undefined ? {} : { proveedorRef: args.proveedor_ref }),
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pago_id: r.datos.pagoId,
      se_llevaron_cents: r.datos.montoCents,
      pagado_cents: r.datos.pagadoCents,
      estado_del_pago: r.datos.estadoDelPago,
      asiento: "15 · Contracargo (nuevo; el asiento del cobro no se toca)",
    };
  },
});

export const HERRAMIENTAS_DE_PASARELAS = [
  verPasarelas,
  encenderPasarela,
  apagarPasarela,
  cambiarModoDePasarela,
  reembolso,
  contracargo,
] as const;
