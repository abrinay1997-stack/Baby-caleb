import { z } from "zod";
import { cambiarUso, crear as crearBodegaEnLaBase, renombrar } from "../../db/bodegas";
import { editar as editarClientaEnLaBase } from "../../db/clientes";
import type { CambiosEnClienta } from "../../db/clientes";
import { crear as crearZonaEnLaBase, editar as editarZonaEnLaBase } from "../../db/zonas-admin";
import type { CambiosEnZona } from "../../db/zonas-admin";
import { METODOS, REGIONES } from "../../dominio/zonas";
import { PATRON_REFERENCIA, clienteDeReferencia } from "../referencias";
import { definir } from "../registro";

/**
 * Los maestros por MCP: bodegas, zonas de envío y la ficha de una clienta.
 *
 * Son las tres cosas que el panel sabía administrar y el asistente no, o sea
 * tres capacidades que dependían de que una pantalla existiera, se desplegara
 * y estuviera bien escrita — las tres han fallado por separado en este
 * repositorio (docs/TRAMPAS.md §13).
 *
 * ## Ninguna reimplementa nada
 *
 * Cada herramienta llama a la MISMA función de `src/db/` que llama su ruta del
 * panel: `crear`/`renombrar`/`cambiarUso` de `db/bodegas.ts`, `crear`/`editar`
 * de `db/zonas-admin.ts` y `editar` de `db/clientes.ts`. Ahí viven las filas de
 * control que comprueban lo que el batch acaba de escribir, el `IS` que sabe
 * comparar nulos y la respuesta que distingue «no existe» de «ya hay otra con
 * ese nombre». Un segundo camino hacia las mismas tablas acabaría discrepando
 * del primero, y el que se equivoca del lado flojo es el que nadie revisa.
 *
 * Lo único que esta capa añade es la traducción: el asistente habla de bodegas
 * y zonas por su NOMBRE y de clientas por su REFERENCIA; el motor habla de ids.
 *
 * ## Por qué cada nivel es el que es
 *
 *  - **Las zonas son dinero.** La tarifa de una zona es lo que paga la clienta
 *    por que le lleven el pedido, así que crear o cambiar una zona es
 *    `sensible`: se propone con el detalle exacto y lo permite una persona
 *    (06-asistente §3). Y la tarifa no se adivina nunca: quien no la sepa pone
 *    `null`, que significa «se cotiza a mano» y no «gratis».
 *  - **Dejar de usar una bodega** también es `sensible`: desde ese momento
 *    ningún pedido se surte de ahí. Crearla o renombrarla no mueve ni una caja,
 *    así que son de construcción.
 *  - **La ficha de una clienta** es de construcción, con los mismos roles que
 *    la ruta (`pedidos` en nivel editar: dueña y asistente).
 *
 * ## D-20: se puede CAMBIAR un dato sin DEVOLVERLO
 *
 * `corregir_ficha_de_clienta` existe para corregir lo que hace falta para
 * cobrar con tarjeta y para facturar, y no devuelve ni uno de esos datos: su
 * resultado dice la referencia, QUÉ CAMPOS cambiaron y nada más. Los valores
 * viajan en una sola dirección —de la persona al servidor, dictados por ella—
 * y nunca de vuelta hacia el modelo. Lo mismo hacia el cliente de MCP, donde
 * al otro lado hay otro modelo de otra empresa.
 *
 * Queda un borde dicho en voz alta: lo que la persona dicta («su cédula es la
 * 8-123-456») viaja en los argumentos de la llamada, y esa llamada vuelve al
 * modelo en los turnos siguientes de la misma conversación. No es un dato que
 * el sistema revele —es la frase que la persona acaba de escribir—, pero quien
 * crea que D-20 también tapa eso se equivoca: lo que tapa es que el SISTEMA
 * entregue datos de clientas que nadie le pidió.
 *
 * Cada herramienta que escribe pide además un `motivo`. Las tablas de bodegas
 * y zonas no tienen columna para guardarlo, pero la bitácora `acciones` sí: ahí
 * queda, junto con quién lo pidió y por qué canal, y eso es lo que contesta
 * dentro de tres meses «¿quién pausó Tocumen?».
 */

const motivo = z
  .string()
  .min(3)
  .max(200)
  .describe("Por qué se hace. Queda escrito en la bitácora y es lo que lo explica después.");

const nombreDeBodega = z
  .string()
  .min(1)
  .max(60)
  .describe("El nombre de la bodega, tal como aparece en el panel.");

const nombreDeZona = z
  .string()
  .min(1)
  .max(80)
  .describe("El nombre de la zona de envío, como «Tocumen».");

/**
 * La bodega que se llama así, esté en uso o no.
 *
 * NO se usa `bodegaPorNombre` de `db/inventario.ts` a propósito: esa filtra por
 * `activa = 1` porque sirve para SURTIR, y con ella «vuelva a usar la bodega
 * Oeste» sería imposible —la bodega que hay que encender es justo la que esa
 * consulta no devuelve—. Aquí se administra la bodega, no se saca mercancía de
 * ella.
 */
async function bodegaQueSeLlama(
  db: D1Database,
  nombre: string,
): Promise<{ id: string; nombre: string; activa: number } | null> {
  return await db
    .prepare("SELECT id, nombre, activa FROM bodegas WHERE nombre = ?")
    .bind(nombre)
    .first<{ id: string; nombre: string; activa: number }>();
}

const noHayBodega = (nombre: string): Error =>
  new Error(
    `no existe ninguna bodega que se llame «${nombre}». Pida la lista de bodegas antes de cambiarla.`,
  );

async function zonaQueSeLlama(
  db: D1Database,
  nombre: string,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare("SELECT id, nombre FROM zonas_envio WHERE nombre = ?")
    .bind(nombre)
    .first<{ id: string; nombre: string }>();
}

// ---------------------------------------------------------------------------
// Bodegas
// ---------------------------------------------------------------------------

export const crearBodega = definir({
  nombre: "crear_bodega",
  descripcion:
    "Da de alta una bodega nueva, con su casillero para cada artículo. Nace vacía y en uso. Ejemplo: crear_bodega con nombre «Bodega Panamá Oeste» y motivo «abrimos el local de La Chorrera».",
  parametros: z.object({ nombre: nombreDeBodega, motivo }),
  nivel: "construccion",
  categoria: "inventario",
  // `precios_y_stock` en nivel editar, igual que la ruta del panel: una bodega
  // es donde vive el inventario, y quien decide dónde se guarda es quien puede
  // moverlo. Hoy eso es solo la dueña.
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await crearBodegaEnLaBase({ db: ctx.db, ahora: ctx.ahora }, args.nombre);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      bodega: r.datos.nombre,
      en_uso: true,
      // Este cero sí es un cero y no un «no sé»: la bodega acaba de nacer con
      // un casillero en cada artículo y todos están en cero de verdad
      // (docs/TRAMPAS.md §7). Decirlo evita que el modelo conteste «no hay
      // stock» como si fuera un problema.
      unidades: 0,
      aviso:
        `«${r.datos.nombre}» queda creada y vacía. La mercancía llega ahí con un traslado ` +
        "desde otra bodega o recibiendo una compra; hasta entonces no surte ningún pedido.",
    };
  },
});

export const renombrarBodega = definir({
  nombre: "renombrar_bodega",
  descripcion:
    "Le cambia el nombre a una bodega sin tocar su mercancía. Ejemplo: renombrar_bodega con bodega «Bodega Oeste», nombre_nuevo «Bodega Panamá Oeste» y motivo «se confundía con la de la ciudad».",
  parametros: z.object({
    bodega: nombreDeBodega,
    nombre_nuevo: z.string().min(1).max(60).describe("Cómo se va a llamar a partir de ahora."),
    motivo,
  }),
  nivel: "construccion",
  categoria: "inventario",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const bodega = await bodegaQueSeLlama(ctx.db, args.bodega);
    if (bodega === null) throw noHayBodega(args.bodega);

    const r = await renombrar({ db: ctx.db, ahora: ctx.ahora }, bodega.id, args.nombre_nuevo);
    if (!r.ok) throw new Error(r.mensaje);

    return { antes: bodega.nombre, ahora: r.datos.nombre };
  },
});

export const cambiarUsoDeBodega = definir({
  nombre: "cambiar_uso_de_bodega",
  descripcion:
    "Pone una bodega en uso o deja de usarla. Una bodega NO se borra: aparece en cada movimiento de inventario que pasó por ella. Ejemplo: cambiar_uso_de_bodega con bodega «Bodega Oeste», en_uso false y motivo «cerramos el local».",
  parametros: z.object({
    bodega: nombreDeBodega,
    en_uso: z
      .boolean()
      .describe("true la pone en uso; false deja de usarla y ningún pedido se surte de ahí."),
    motivo,
  }),
  // Sensible: desde que se apaga, ningún pedido se surte de esa bodega y
  // ningún traslado le mete mercancía. Eso lo mira una persona antes.
  nivel: "sensible",
  categoria: "inventario",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const bodega = await bodegaQueSeLlama(ctx.db, args.bodega);
    if (bodega === null) throw noHayBodega(args.bodega);

    const r = await cambiarUso({ db: ctx.db, ahora: ctx.ahora }, bodega.id, args.en_uso);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      bodega: bodega.nombre,
      en_uso: r.datos.activa,
      // La parte que sorprende, y está escrita en `db/bodegas.ts`: lo que YA
      // está adentro sigue contando como disponible para la web y para el bot.
      // Un modelo que no lo sepa contestaría «esa mercancía ya no se ofrece»,
      // que es falso.
      aviso: args.en_uso
        ? null
        : `«${bodega.nombre}» deja de surtir pedidos y de recibir traslados, pero lo que ya está ` +
          "adentro sigue contando como disponible. Para vaciarla hay que trasladar su mercancía.",
    };
  },
});

// ---------------------------------------------------------------------------
// Zonas de envío
// ---------------------------------------------------------------------------

/**
 * La tarifa, que es dinero y por eso no tiene valor por omisión.
 *
 * Tres estados y los tres significan cosas distintas: un número son los
 * centavos que se cobran, `0` es que el envío no se cobra y `null` es que se
 * cotiza a mano. El campo es OBLIGATORIO al crear para que el modelo no pueda
 * elegir por omisión: si la dueña no ha dicho la tarifa, lo que corresponde es
 * `null` —que sale en la tarjeta de confirmación como «se cotiza a mano»— y
 * nunca una cifra inventada.
 */
const tarifa = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .nullable()
  .describe(
    "La tarifa en CENTAVOS: $3.50 son 350. `0` es que el envío no se cobra. `null` es que se " +
      "cotiza a mano. Si la dueña no ha dicho cuánto se cobra, ponga null: no invente una cifra.",
  );

const alias = z
  .array(z.string().min(1).max(60))
  .max(24)
  .describe("Otras formas en que la clienta escribe la zona: «24 de diciembre», «Tocúmen».");

const region = z
  .enum(REGIONES)
  .describe("«ciudad» o «interior». El interior va por encomienda y se cotiza casi siempre.");

const metodo = z.enum(METODOS).describe("Cómo llega el pedido: motorizado, ferguson u otro.");

const requierePagoTotal = z
  .boolean()
  .describe("true si en esa zona el pedido se paga completo antes de salir (no basta el abono).");

const bodegaPreferida = z
  .string()
  .min(1)
  .max(60)
  .describe("Nombre de la bodega desde la que se surte esa zona.");

export const crearZona = definir({
  nombre: "crear_zona",
  descripcion:
    "Crea una zona de envío con su tarifa. Ejemplo: crear_zona con nombre «Tocumen», region «ciudad», metodo «motorizado», tarifa_cents 350, requiere_pago_total false y motivo «empezamos a entregar ahí».",
  parametros: z.object({
    nombre: nombreDeZona,
    region,
    metodo,
    tarifa_cents: tarifa,
    requiere_pago_total: requierePagoTotal,
    alias: alias.optional(),
    bodega_preferida: bodegaPreferida.optional(),
    en_uso: z
      .boolean()
      .optional()
      .describe("Si falta, la zona nace en uso: se crea una zona para entregar en ella."),
    motivo,
  }),
  // Dinero: la tarifa es lo que paga la clienta. Se propone y lo permite una
  // persona.
  nivel: "sensible",
  categoria: "entregas",
  // `ajustes` en nivel editar, igual que la ruta: una zona no es mercancía, es
  // una regla con cifras del negocio.
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const bodega =
      args.bodega_preferida === undefined
        ? null
        : await bodegaQueSeLlama(ctx.db, args.bodega_preferida);
    if (args.bodega_preferida !== undefined && bodega === null) {
      throw noHayBodega(args.bodega_preferida);
    }

    const r = await crearZonaEnLaBase(
      { db: ctx.db, ahora: ctx.ahora },
      {
        nombre: args.nombre,
        region: args.region,
        metodo: args.metodo,
        tarifaCents: args.tarifa_cents,
        requierePagoTotal: args.requiere_pago_total,
        bodegaPreferidaId: bodega === null ? null : bodega.id,
        ...(args.alias === undefined ? {} : { alias: args.alias }),
        ...(args.en_uso === undefined ? {} : { activa: args.en_uso }),
      },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      zona: r.datos.nombre,
      region: args.region,
      metodo: args.metodo,
      // Se devuelve la tarifa tal como quedó, con las dos cosas separadas: el
      // número y «se cotiza a mano». Un null a secas se lee como cero.
      tarifa_cents: args.tarifa_cents,
      se_cotiza_a_mano: args.tarifa_cents === null,
      requiere_pago_total: args.requiere_pago_total,
      en_uso: args.en_uso !== false,
    };
  },
});

export const cambiarZona = definir({
  nombre: "cambiar_zona",
  descripcion:
    "Cambia una zona de envío: su tarifa, su método, sus alias, la bodega que la surte o si se entrega ahí. Solo cambia lo que se le pase. Ejemplo: cambiar_zona con zona «Tocumen», tarifa_cents 400 y motivo «subió la gasolina».",
  parametros: z.object({
    zona: nombreDeZona,
    nombre_nuevo: z.string().min(1).max(80).optional().describe("Para corregirle el nombre."),
    region: region.optional(),
    metodo: metodo.optional(),
    tarifa_cents: tarifa.optional(),
    requiere_pago_total: requierePagoTotal.optional(),
    alias: alias.optional(),
    bodega_preferida: bodegaPreferida
      .nullable()
      .optional()
      .describe("Nombre de la bodega que surte la zona, o null para quitarla."),
    en_uso: z.boolean().optional().describe("false pausa la zona: el checkout deja de ofrecerla."),
    motivo,
  }),
  nivel: "sensible",
  categoria: "entregas",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const zona = await zonaQueSeLlama(ctx.db, args.zona);
    if (zona === null) {
      throw new Error(
        `no existe ninguna zona de envío que se llame «${args.zona}». Pida la lista de zonas antes de cambiarla.`,
      );
    }

    // Se construye con las claves PRESENTES, no con `?? loQueHabia`. En
    // `db/zonas-admin.ts` el campo ausente y el campo en `null` son dos cosas
    // distintas —«déjala como estaba» y «ponla en se cotiza a mano»— y `??`
    // convertiría la segunda en la primera: el cambio no pasaría y nada
    // fallaría.
    const cambios: { -readonly [K in keyof CambiosEnZona]: CambiosEnZona[K] } = {};
    const cambiados: string[] = [];

    if (args.nombre_nuevo !== undefined) {
      cambios.nombre = args.nombre_nuevo;
      cambiados.push("nombre");
    }
    if (args.region !== undefined) {
      cambios.region = args.region;
      cambiados.push("region");
    }
    if (args.metodo !== undefined) {
      cambios.metodo = args.metodo;
      cambiados.push("metodo");
    }
    if (args.tarifa_cents !== undefined) {
      cambios.tarifaCents = args.tarifa_cents;
      cambiados.push("tarifa");
    }
    if (args.requiere_pago_total !== undefined) {
      cambios.requierePagoTotal = args.requiere_pago_total;
      cambiados.push("requiere_pago_total");
    }
    if (args.alias !== undefined) {
      cambios.alias = args.alias;
      cambiados.push("alias");
    }
    if (args.bodega_preferida !== undefined) {
      if (args.bodega_preferida === null) {
        cambios.bodegaPreferidaId = null;
      } else {
        const bodega = await bodegaQueSeLlama(ctx.db, args.bodega_preferida);
        if (bodega === null) throw noHayBodega(args.bodega_preferida);
        cambios.bodegaPreferidaId = bodega.id;
      }
      cambiados.push("bodega_preferida");
    }
    if (args.en_uso !== undefined) {
      cambios.activa = args.en_uso;
      cambiados.push("en_uso");
    }

    const r = await editarZonaEnLaBase({ db: ctx.db, ahora: ctx.ahora }, zona.id, cambios);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      zona: args.nombre_nuevo ?? zona.nombre,
      cambiados,
      ...(args.tarifa_cents === undefined
        ? {}
        : { tarifa_cents: args.tarifa_cents, se_cotiza_a_mano: args.tarifa_cents === null }),
    };
  },
});

// ---------------------------------------------------------------------------
// La ficha de una clienta
// ---------------------------------------------------------------------------

/**
 * Los campos que se pueden corregir, y por qué son estos.
 *
 * Son los que hacen falta para COBRAR CON TARJETA y para FACTURAR: el apellido
 * aparte del nombre, la cédula o el RUC con su tipo, el correo del recibo. Nada
 * de eso llega solo —la pasarela no devuelve la cédula y el chat no la
 * pregunta—, así que si no se puede teclear, la factura se queda sin hacer.
 *
 * Lo que NO está aquí: la dirección. Sus datos de facturación se corrigen en el
 * panel y solo ahí, porque para tocar una dirección hay que decir CUÁL, y su id
 * se conoce abriendo la ficha de la clienta... que es justo lo que D-20 no deja
 * salir hacia el modelo. Una herramienta que tuviera que devolver la ficha para
 * poder cambiarla no sería una excepción razonada: sería la regla rota.
 */
const vacioBorra = (quePasa: string) =>
  z
    .string()
    .max(200)
    .nullable()
    .describe(`${quePasa} Vacío o null lo deja en blanco.`);

export const corregirFichaDeClienta = definir({
  nombre: "corregir_ficha_de_clienta",
  descripcion:
    "Corrige los datos de una clienta que hacen falta para cobrar con tarjeta y para facturar: apellido, cédula o RUC, correo, celular y notas. Se la nombra por su referencia. Ejemplo: corregir_ficha_de_clienta con clienta «C-0042», identificacion «8-123-456», identificacion_tipo «cedula» y motivo «nos dio la cédula para la factura».",
  parametros: z.object({
    clienta: z
      .string()
      .regex(PATRON_REFERENCIA)
      .describe("La referencia de la clienta, como C-0042. Nunca su nombre ni su celular."),
    nombre: z.string().min(1).max(200).optional().describe("Su nombre, si está mal escrito."),
    apellido: vacioBorra("El apellido, aparte del nombre.").optional(),
    celular: z
      .string()
      .min(7)
      .max(20)
      .optional()
      .describe("Su celular, como 6000-0001. No se puede dejar en blanco."),
    correo: vacioBorra("El correo al que va el recibo.").optional(),
    identificacion: vacioBorra("El número de cédula o de RUC.").optional(),
    identificacion_tipo: z
      .enum(["cedula", "ruc"])
      .nullable()
      .optional()
      .describe("Si ese número es cédula o RUC. En la factura no es lo mismo."),
    notas: vacioBorra("Lo que haya que recordar de ella.").optional(),
    motivo,
  }),
  nivel: "construccion",
  categoria: "clientes",
  // Los mismos que la ruta: `pedidos` en nivel editar. Quien toma pedidos es
  // quien tiene delante a la clienta cuando le dicta la cédula.
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const clienta = await clienteDeReferencia(ctx.db, args.clienta);
    if (clienta === null) {
      throw new Error(
        `no hay ninguna clienta con la referencia ${args.clienta}. Búsquela primero para que el sistema le dé una.`,
      );
    }

    const cambios: { -readonly [K in keyof CambiosEnClienta]: CambiosEnClienta[K] } = {};
    const campos: string[] = [];
    const poner = <K extends keyof CambiosEnClienta>(
      clave: K,
      valor: CambiosEnClienta[K] | undefined,
      comoSeLlama: string,
    ): void => {
      if (valor === undefined) return;
      cambios[clave] = valor;
      campos.push(comoSeLlama);
    };

    poner("nombre", args.nombre, "nombre");
    poner("apellido", args.apellido, "apellido");
    poner("celular", args.celular, "celular");
    poner("correo", args.correo, "correo");
    poner("identificacion", args.identificacion, "identificacion");
    poner("identificacionTipo", args.identificacion_tipo, "identificacion_tipo");
    poner("notas", args.notas, "notas");

    if (campos.length === 0) {
      throw new Error("no se dijo qué corregir de la ficha: pase al menos un dato.");
    }

    const r = await editarClientaEnLaBase(
      { db: ctx.db, ahora: ctx.ahora, actor: ctx.usuario.correo },
      clienta.id,
      cambios,
    );
    if (!r.ok) throw new Error(r.mensaje);

    // Lo que sale hacia el modelo: la referencia y los NOMBRES de los campos
    // que cambiaron. Ni el valor nuevo ni el que había, ni el nombre de la
    // clienta, ni su id (D-20). Se puede cambiar un dato sin devolverlo, y
    // devolverlo «para confirmar» sería entregar al modelo justo lo que esta
    // regla existe para no entregarle: quien pidió el cambio ya sabe lo que
    // dictó, y quien lo quiera ver abre la ficha en el panel.
    //
    // `guardado` es lo que dijo la base, no lo que esta capa supone. Y dice
    // «se escribió», no «el valor era distinto»: guardar el mismo apellido
    // otra vez es un guardado. Comparar el antes y el después pediría leer la
    // ficha para restar, o sea un segundo camino sobre la misma tabla —el
    // primer sitio donde dos lecturas de lo mismo empiezan a discrepar— y la
    // respuesta no cambiaría nada de lo que se guardó.
    return { clienta: args.clienta, campos, guardado: r.datos.cambiado };
  },
});

export const HERRAMIENTAS_DE_MAESTROS = [
  crearBodega,
  renombrarBodega,
  cambiarUsoDeBodega,
  crearZona,
  cambiarZona,
  corregirFichaDeClienta,
] as const;
