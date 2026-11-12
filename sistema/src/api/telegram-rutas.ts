import { Hono, type Context } from "hono";
import { conversar, type Final } from "../asistente/conversar";
import { confirmar } from "../asistente/ejecutar";
import { catalogo as catalogoDeHerramientas } from "../asistente/index";
import { revisarMensaje } from "../asistente/politica";
import { promptDeCaleb } from "../asistente/prompt";
import { MAX_TOKENS_POR_OMISION, type Proveedor } from "../asistente/proveedor";
import { ponerLosNombres } from "../asistente/referencias";
import { anotarUso } from "../asistente/uso";
import {
  ACTUALIZACION,
  CABECERA_SECRETO,
  type Bot,
  type Botones,
  type Entrada,
  type HacerBot,
  botonesDe,
  leerBoton,
  loQueLlega,
  porTelegram,
  secretoCoincide,
  trozos,
} from "../canales/telegram";
import { canjearCodigo, normalizarCodigo, usuarioDelChat } from "../db/telegram";
import { fechaContable } from "../dominio/contabilidad";
import { type HacerProveedor, porMeta } from "./asistente-rutas";
import type { Rol } from "../seguridad/roles";

/**
 * La puerta de Telegram de Caleb.
 *
 * El motor ya existía —`conversar` piensa, `ejecutar` aplica la política y
 * escribe la bitácora, `anotarUso` cuenta el gasto— y tenía una sola puerta:
 * el chat del panel. Esta es la segunda, y la que la dueña va a usar de
 * verdad, porque es la aplicación que ya tiene abierta en el teléfono.
 *
 * ## Por qué vive FUERA de `/api`
 *
 * Todo lo de `/api` está detrás de Cloudflare Access, y Access es una puerta
 * para personas con navegador: mira una cookie o un JWT firmado al iniciar
 * sesión. Telegram no inicia sesión en nada. Si este webhook estuviera detrás
 * de Access, Cloudflare le contestaría a Telegram con la pantalla de login y
 * el bot quedaría mudo sin que nadie viera un error.
 *
 * Así que la autenticación es otra, y son dos capas distintas:
 *
 *  1. **El transporte**: la cabecera `X-Telegram-Bot-Api-Secret-Token` tiene
 *     que coincidir con `TELEGRAM_WEBHOOK_SECRET`, comparada en tiempo
 *     constante. Sin eso, la ruta es pública y cualquiera le escribe a Caleb
 *     haciéndose pasar por Telegram.
 *  2. **La persona**: el `chat_id` cruzado con `usuarios.telegram_chat_id` y
 *     `activo = 1`, en CADA mensaje. De cualquier otro chat no sale ninguna
 *     respuesta — ni un error.
 *
 * ## El silencio no es descortesía
 *
 * A un chat que no está vinculado no se le contesta NADA: ni «no autorizado»,
 * ni «no entendí». Contestar cualquier cosa confirma que detrás de ese número
 * hay un sistema del negocio, y eso es justo lo que no se quiere regalar. La
 * única excepción es un código de vinculación que resulte bueno, porque quien
 * lo tiene ya está autorizado por quien lo generó.
 *
 * El precio de esa regla es real y hay que decirlo donde se note: un código
 * mal copiado se contesta con el mismo silencio que un desconocido, así que la
 * pantalla que entrega el código tiene que avisar de que si no pasa nada hay
 * que generar otro. No hay forma de tener las dos cosas.
 *
 * ## Siempre 200
 *
 * Una respuesta que no sea 2xx hace que Telegram reintente la misma entrega, y
 * reintentar un turno del asistente es pagarlo dos veces y volver a proponer
 * la misma acción. Así que todo —un cuerpo raro, un chat desconocido, un fallo
 * nuestro— se contesta 200 y lo que haya que contar va a los registros. Lo
 * único que no es 200 es la falta del secreto, y eso contesta 404 con el mismo
 * cuerpo que cualquier ruta inexistente: desde fuera, esta ruta no existe.
 */

type Entorno = { Bindings: Env };

/** Ms que vive la marca de una entrega ya atendida. */
const DIA = 24 * 60 * 60 * 1000;

/** La ruta, como se guarda en `idempotencia.ruta`. */
const RUTA = "telegram/webhook";

/** Lo mismo que contesta el `app.all("*")` de `src/index.ts`. */
const DESCONOCIDA = { ok: false, codigo: "no_encontrado", mensaje: "ruta desconocida" } as const;

const SALUDO = [
  "Soy Caleb, el asistente de Baby Caleb.",
  "",
  "Pregúnteme por ventas, pedidos, existencias o precios. Lo que cambie dinero,",
  "precios o existencias se lo pregunto antes con un botón, y no se hace hasta",
  "que usted lo toque.",
].join("\n");

const YA_VINCULADO = "Este chat ya está vinculado a su cuenta. No hace falta ningún código.";

const SOLO_TEXTO = "Por ahora solo entiendo texto: las fotos y las notas de voz todavía no.";

const SIN_LLAVE = [
  "No puedo contestarle: el asistente todavía no tiene su llave de inteligencia",
  "artificial puesta. La pone quien administra el sistema, con el secreto",
  "META_API_KEY.",
].join(" ");

const NO_PUDE = "No pude contestarle ahora mismo. Inténtelo en un momento.";

/** El modelo contestó sin palabras: Telegram no acepta un mensaje vacío. */
const SIN_PALABRAS = "No tengo nada que decirle de eso.";

/**
 * Lo que de verdad le pasa a quien manda un código.
 *
 * Se arma la puerta en una fábrica, no como un objeto suelto, por lo mismo que
 * `crearPanel`: las pruebas tienen que poder entrar sin hablar con Telegram ni
 * con el modelo. Los valores por OMISIÓN son los de verdad, así que para
 * saltárselos hay que pasar otra cosa a propósito.
 */
export function crearPuertaDeTelegram(
  hacerProveedor: HacerProveedor = porMeta,
  hacerBot: HacerBot = porTelegram,
) {
  const puerta = new Hono<Entorno>();

  puerta.post("/webhook", async (c) => {
    // 1. ¿Lo manda Telegram? Si no hay secreto configurado, esto falla
    //    cerrado y la ruta se comporta como si no existiera.
    if (!secretoCoincide(c.req.header(CABECERA_SECRETO), c.env.TELEGRAM_WEBHOOK_SECRET)) {
      return c.json(DESCONOCIDA, 404);
    }

    const crudo: unknown = await c.req.json().catch(() => null);
    const leido = ACTUALIZACION.safeParse(crudo);
    // Un cuerpo que no se entiende se calla: si no, Telegram reintentaría para
    // siempre algo que nunca vamos a saber leer.
    if (!leido.success) return callado(c);

    const entrada = loQueLlega(leido.data);
    if (entrada === null) return callado(c);

    const bot = hacerBot(c.env);
    const ahora = Date.now();

    // 2. ¿De quién es este chat? Se pregunta en cada mensaje: quitarle el
    //    acceso a alguien tiene efecto en su siguiente mensaje.
    const usuario = await usuarioDelChat(c.env.DB, entrada.chatId);

    if (usuario === null) {
      // Un desconocido. Silencio, salvo que traiga un código bueno.
      if (bot !== null && entrada.clase === "texto") {
        await intentarVincular(c, bot, entrada.chatId, entrada.texto, ahora);
      }
      return callado(c);
    }

    if (bot === null) {
      // Sin token no hay forma de contestar. No se puede avisar por Telegram
      // —justo es lo que falta—, así que se avisa donde se puede ver.
      console.warn(JSON.stringify({ evento: "telegram_sin_token" }));
      return callado(c);
    }

    // Una entrega repetida no se atiende dos veces: pagar dos veces el mismo
    // turno y volver a proponer la misma acción sensible es peor que no
    // contestar. Se reclama DESPUÉS de saber quién es, para que un desconocido
    // no pueda escribir filas en `idempotencia` escribiéndole al bot.
    if (!(await reclamar(c.env.DB, leido.data.update_id, ahora))) return callado(c);

    try {
      if (entrada.clase === "boton") {
        await decidirAccion(c, bot, usuario, entrada, ahora);
        return callado(c);
      }
      if (entrada.clase === "sin_texto") {
        await decir(bot, entrada.chatId, SOLO_TEXTO);
        return callado(c);
      }
      await atenderTexto(c, bot, usuario, entrada.chatId, entrada.texto, ahora, hacerProveedor);
    } catch (e) {
      // El detalle va al registro y no al chat: el cuerpo de un error del
      // proveedor puede traer de vuelta lo que se le mandó, y ahí va el prompt.
      console.warn(
        JSON.stringify({
          evento: "telegram_fallo",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      await decir(bot, entrada.chatId, NO_PUDE).catch(() => undefined);
    }

    return callado(c);
  });

  return puerta;
}

/** La puerta lista para montar, con el bot y el cerebro de verdad. */
export const puertaDeTelegram = crearPuertaDeTelegram();

const callado = (c: Context<Entorno>) => c.body(null, 200);

type Quien = { id: string; correo: string; nombre: string; rol: Rol };

// ---------------------------------------------------------------------------
// Un turno
// ---------------------------------------------------------------------------

/**
 * Lo que pasa cuando una persona vinculada escribe algo.
 *
 * **Cada mensaje es un turno suelto.** No hay memoria de la conversación: el
 * chat del panel devuelve el historial por el navegador y aquí no hay quien lo
 * devuelva. Las tablas `asistente_conversaciones` y `asistente_mensajes`
 * existen desde la migración 0002 y siguen sin que nadie las escriba; darles
 * uso es otro trabajo, con su decisión de retención, y hacerlo a medias aquí
 * dejaría la mitad de una memoria, que es peor que ninguna.
 */
async function atenderTexto(
  c: Context<Entorno>,
  bot: Bot,
  usuario: Quien,
  chatId: string,
  texto: string,
  ahora: number,
  hacerProveedor: HacerProveedor,
): Promise<void> {
  const comando = quePidio(texto);
  if (comando === "saludo") {
    await decir(bot, chatId, SALUDO);
    return;
  }
  if (comando === "vincular") {
    await decir(bot, chatId, YA_VINCULADO);
    return;
  }

  // El tope de 8.000 letras de 06-asistente §7, comprobado ANTES de llamar al
  // modelo: después ya se pagó. Telegram corta en 4.096, así que esto solo
  // salta con un mensaje armado a mano — y para eso está.
  const cabe = revisarMensaje(texto);
  if (!cabe.ok) {
    await decir(bot, chatId, `Ese mensaje es muy largo: ${cabe.explicacion}.`);
    return;
  }

  const proveedor = hacerProveedor(c.env);
  if (proveedor === null) {
    await decir(bot, chatId, SIN_LLAVE);
    return;
  }

  const final = await conversar(
    {
      db: c.env.DB,
      usuario: { id: usuario.id, correo: usuario.correo, rol: usuario.rol },
      ahora,
    },
    catalogoDeHerramientas(),
    proveedor,
    {
      sistema: promptDeCaleb({ nombre: usuario.nombre, rol: usuario.rol }, fechaContable(ahora)),
      mensajes: [{ rol: "user", contenido: texto }],
      canal: "telegram",
      conversacionId: null,
      // Por aquí no entra ningún archivo: un mensaje que no es texto se
      // rechaza antes de llegar a un turno. Así que la sospecha de
      // 06-asistente §3 —«hubo un archivo hace poco»— no aplica, y decirlo
      // explícito evita que mañana alguien lo dé por supuesto.
      huboArchivoReciente: false,
      maxTokens: MAX_TOKENS_POR_OMISION,
    },
  );

  // Se anota el gasto ANTES de hablar: si el envío falla, el turno ya se pagó
  // igual y la cuenta tiene que decirlo.
  //
  // La TARIFA no existe todavía (hueco `tarifa_del_modelo`): se anotan las
  // fichas, que son un hecho, y el costo queda en cero a la vista. El tope
  // mensual de 06-asistente §7 tampoco se puede aplicar aquí, porque
  // `ajustes.tope_ia_mensual_usd` está en PENDIENTE: un tope inventado sería
  // una cifra a ojo sobre el dinero de otra persona.
  await anotarUso(c.env.DB, {
    usuarioId: usuario.id,
    canal: "telegram",
    modelo: proveedor.modelo,
    uso: final.uso,
    ahora,
    tarifa: null,
  });

  await contestar(c, bot, chatId, final);
}

/**
 * Lo que ve la persona.
 *
 * Aquí se vuelven a poner los nombres de las clientas. Hacia el modelo una
 * clienta es «C-0042» (D-20, 06-asistente §7) y el nombre se pone DESPUÉS, al
 * mostrar — `ponerLosNombres` estaba escrito y probado desde la migración 0002
 * y no lo llamaba nadie, porque mientras no hubo puerta no había nada que
 * mostrar.
 */
async function contestar(
  c: Context<Entorno>,
  bot: Bot,
  chatId: string,
  final: Final,
): Promise<void> {
  if (final.clase === "dijo") {
    await decir(bot, chatId, await ponerLosNombres(c.env.DB, final.texto));
    return;
  }

  const partes = [final.texto.trim(), final.resumen.trim(), "¿Lo hago?"].filter((p) => p !== "");
  await decir(
    bot,
    chatId,
    await ponerLosNombres(c.env.DB, partes.join("\n\n")),
    botonesDe(final.accionId),
  );
}

/**
 * Manda un texto, partido si hace falta.
 *
 * Los botones van en el ÚLTIMO trozo: en el primero quedarían arriba de la
 * conversación, pidiendo permiso para algo que la persona todavía no ha
 * terminado de leer.
 */
async function decir(bot: Bot, chatId: string, texto: string, botones?: Botones): Promise<void> {
  const partes = trozos(texto);
  if (partes.length === 0) {
    await bot.decir(chatId, SIN_PALABRAS, botones);
    return;
  }
  for (const [i, parte] of partes.entries()) {
    const ultima = i === partes.length - 1;
    await bot.decir(chatId, parte, ultima ? botones : undefined);
  }
}

// ---------------------------------------------------------------------------
// Los botones de una acción sensible
// ---------------------------------------------------------------------------

/**
 * Permitir o rechazar lo que Caleb propuso.
 *
 * Quién puede confirmar NO se decide aquí: lo decide `confirmar()`, que exige
 * que la pida la misma persona, que no haya vencido y —con el trigger de la
 * base— que no se ejecute dos veces. Repetir esa comprobación aquí sería
 * tener dos reglas donde hay una, y el día que cambie una de las dos nadie
 * sabría cuál manda.
 */
async function decidirAccion(
  c: Context<Entorno>,
  bot: Bot,
  usuario: Quien,
  entrada: Extract<Entrada, { clase: "boton" }>,
  ahora: number,
): Promise<void> {
  const boton = leerBoton(entrada.datos);
  if (boton === null) {
    await bot.responderBoton(entrada.callbackId, "Ese botón ya no vale.");
    return;
  }

  const r = await confirmar(
    {
      db: c.env.DB,
      usuario: { id: usuario.id, correo: usuario.correo, rol: usuario.rol },
      ahora,
    },
    catalogoDeHerramientas(),
    boton.accionId,
    boton.decision,
  );

  // El aviso flotante primero, que es lo que para el botón de girar.
  await bot.responderBoton(
    entrada.callbackId,
    r.ok ? (boton.decision === "permitir" ? "Hecho." : "No se hizo.") : r.mensaje,
  );

  // Que no se pueda tocar otra vez. Es cosmético —la base ya impide ejecutarlo
  // dos veces— así que un fallo aquí no se propaga: si el mensaje ya no tenía
  // botones, Telegram dice que no hay nada que cambiar, y tiene razón.
  await bot.quitarBotones(entrada.chatId, entrada.mensajeId).catch(() => undefined);

  if (!r.ok) {
    await decir(bot, entrada.chatId, r.mensaje);
    return;
  }

  if (boton.decision === "rechazar") {
    await decir(bot, entrada.chatId, "Listo, no lo hice.");
    return;
  }

  // Qué se hizo, con las mismas palabras que la persona leyó antes de
  // permitirlo. El resultado crudo de la herramienta no se enseña: es JSON, y
  // el resumen dice lo mismo en español.
  const fila = await c.env.DB.prepare("SELECT resumen FROM acciones WHERE id = ?")
    .bind(boton.accionId)
    .first<{ resumen: string | null }>();

  await decir(
    bot,
    entrada.chatId,
    fila?.resumen === null || fila?.resumen === undefined
      ? "Hecho."
      : `Hecho: ${await ponerLosNombres(c.env.DB, fila.resumen)}`,
  );
}

// ---------------------------------------------------------------------------
// Vincular
// ---------------------------------------------------------------------------

/** Qué pidió, si pidió algo que no es una pregunta para el modelo. */
export function quePidio(texto: string): "saludo" | "vincular" | null {
  const limpio = texto.trim().toLowerCase();
  if (/^\/start(@\S+)?$/.test(limpio)) return "saludo";
  if (/^\/vincular(@\S+)?\b/.test(limpio) || /^\/start(@\S+)?\s+\S/.test(limpio)) {
    return "vincular";
  }
  return null;
}

/**
 * El código que alguien pegó, si lo que escribió puede ser un código.
 *
 * De un chat desconocido se acepta de las tres formas en que una persona lo va
 * a mandar: `/vincular ABCD-EFGH-JKMN`, el enlace profundo de Telegram —que
 * llega como `/start ABCD-EFGH-JKMN`— o el código pelado, pegado tal cual. En
 * un chat desconocido eso no choca con nada, porque lo único que se le acepta
 * es esto.
 */
export function codigoPegado(texto: string): string | null {
  const sinComando = texto.trim().replace(/^\/(vincular|start)(@\S+)?\s*/i, "");
  return normalizarCodigo(sinComando) === null ? null : sinComando.trim();
}

/**
 * Un desconocido con un código.
 *
 * Si el código no vale, SILENCIO: no se dice «ese código venció» ni «ese
 * código no existe», porque las dos cosas le confirman a quien prueba códigos
 * que hay algo detrás. Lo que sí queda es un aviso en los registros, para que
 * un intento de fuerza bruta se pueda ver.
 */
async function intentarVincular(
  c: Context<Entorno>,
  bot: Bot,
  chatId: string,
  texto: string,
  ahora: number,
): Promise<void> {
  const codigo = codigoPegado(texto);
  if (codigo === null) return;

  const r = await canjearCodigo({ db: c.env.DB, ahora }, codigo, chatId);
  if (!r.ok) {
    // El código NO va al registro: es un secreto mientras vive.
    console.warn(JSON.stringify({ evento: "telegram_vinculo_rechazado", codigo: r.codigo }));
    return;
  }

  console.log(JSON.stringify({ evento: "telegram_vinculado", usuario: r.datos.usuarioId }));
  await decir(
    bot,
    chatId,
    [
      `Listo, ${r.datos.nombre}. Este chat quedó vinculado a su cuenta del panel.`,
      "",
      SALUDO,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Una entrega, una vez
// ---------------------------------------------------------------------------

/**
 * Reclama una entrega de Telegram. `false` si ya se había atendido.
 *
 * El `update_id` de un bot no se repite nunca, así que no hay que preguntarse
 * si una marca vieja podría chocar con una nueva: un choque de llave primaria
 * significa exactamente «esto ya nos lo entregaron».
 *
 * Si el INSERT falla por otra cosa —la base caída, por ejemplo— se atiende
 * igual y se avisa. Perder un mensaje de la dueña es peor que contestarle dos
 * veces, y un error que no es un choque hay que verlo, no interpretarlo.
 */
async function reclamar(db: D1Database, updateId: number, ahora: number): Promise<boolean> {
  const clave = `telegram:${updateId}`;
  try {
    await db
      .prepare(
        `INSERT INTO idempotencia (clave, ruta, huella_entrada, respuesta_json, creado_en, vence_en)
         VALUES (?,?,?,NULL,?,?)`,
      )
      .bind(clave, RUTA, String(updateId), ahora, ahora + DIA)
      .run();
    return true;
  } catch (e) {
    const ya = await db
      .prepare("SELECT clave FROM idempotencia WHERE clave = ? AND ruta = ?")
      .bind(clave, RUTA)
      .first<{ clave: string }>()
      .catch(() => null);
    if (ya !== null) return false;

    console.warn(
      JSON.stringify({
        evento: "telegram_sin_reclamar",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return true;
  }
}
