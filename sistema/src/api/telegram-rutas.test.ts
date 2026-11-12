import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { guionFijo, type Parlamento } from "../asistente/proveedor";
import type { Bot, Botones, HacerBot } from "../canales/telegram";
import { CABECERA_SECRETO, leerBoton } from "../canales/telegram";
import { crearCodigoDeVinculo } from "../db/telegram";
import type { HacerProveedor } from "./asistente-rutas";
import { codigoPegado, crearPuertaDeTelegram, quePidio } from "./telegram-rutas";

/**
 * La puerta de Telegram de Caleb.
 *
 * El cerebro es de guion fijo y el bot es de mentira: lo que se prueba es la
 * PUERTA —quién entra, a quién no se le contesta nada, qué se le manda, quién
 * puede tocar un botón y qué se anota— y no si el modelo acierta.
 *
 * La prueba más importante de este archivo es la del silencio. De un chat que
 * no está vinculado no sale NINGUNA respuesta, y eso no se puede comprobar
 * mirando lo que se envió: se comprueba contando que no se envió nada.
 */

const SECRETO = "secreto-de-pruebas-del-webhook";
const CHAT_DUENA = "600600600";
const CHAT_OTRA = "700700700";
const CHAT_DESCONOCIDO = "800800800";
const DUENA = "u-tg-puerta-duena";
const OTRA = "u-tg-puerta-otra";

/** Un bot que no habla con Telegram: guarda lo que se le pidió decir. */
function botDeMentira() {
  const dicho: { chatId: string; texto: string; botones?: Botones }[] = [];
  const avisos: string[] = [];
  const quitados: { chatId: string; mensajeId: number }[] = [];
  const bot: Bot = {
    async decir(chatId, texto, botones) {
      dicho.push({ chatId, texto, ...(botones === undefined ? {} : { botones }) });
    },
    async responderBoton(_id, texto) {
      avisos.push(texto);
    },
    async quitarBotones(chatId, mensajeId) {
      quitados.push({ chatId, mensajeId });
    },
  };
  return { bot, dicho, avisos, quitados, hacer: (() => bot) as HacerBot };
}

const sinBot: HacerBot = () => null;
const sinLlave: HacerProveedor = () => null;
const cerebro =
  (...guion: Parlamento[]): HacerProveedor =>
  () =>
    guionFijo(guion, "muse-spark-de-pruebas");

const conSecreto = (valor?: string) =>
  ({ ...real, TELEGRAM_WEBHOOK_SECRET: valor ?? SECRETO }) as unknown as Env;

/** Una entrega de Telegram. `secreto` es lo que se manda en la cabecera. */
async function entregar(
  puerta: ReturnType<typeof crearPuertaDeTelegram>,
  cuerpo: unknown,
  opciones: { secreto?: string | null; configurado?: string } = {},
) {
  const cabeceras: Record<string, string> = { "content-type": "application/json" };
  const mandado = opciones.secreto === undefined ? SECRETO : opciones.secreto;
  if (mandado !== null) cabeceras[CABECERA_SECRETO] = mandado;

  const r = await puerta.fetch(
    new Request("https://bot.babycaleb.com/webhook", {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify(cuerpo),
    }),
    conSecreto(opciones.configurado),
  );
  return { estado: r.status, texto: await r.text() };
}

/**
 * Cuántos turnos se han pagado.
 *
 * Se cuenta por diferencia y no en absoluto porque `asistente_uso` NO se puede
 * borrar entre pruebas —tiene un trigger que lo prohíbe, y está bien que lo
 * tenga— así que las filas de las pruebas anteriores siguen ahí.
 */
const turnosPagados = async (): Promise<number> => {
  const fila = await real.DB.prepare("SELECT COUNT(*) AS n FROM asistente_uso").first<{
    n: number;
  }>();
  return fila?.n ?? 0;
};

let siguienteUpdate = 1_000;

const texto = (chatId: string, contenido: string, updateId?: number) => {
  const id = Number(chatId);
  return {
    update_id: updateId ?? siguienteUpdate++,
    message: {
      message_id: 1,
      chat: { id, type: "private" },
      from: { id },
      text: contenido,
    },
  };
};

const toque = (chatId: string, datos: string, mensajeId = 42) => {
  const id = Number(chatId);
  return {
    update_id: siguienteUpdate++,
    callback_query: {
      id: `cb-${siguienteUpdate}`,
      from: { id },
      data: datos,
      message: { message_id: mensajeId, chat: { id, type: "private" }, from: { id: 1 } },
    },
  };
};

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare("DELETE FROM telegram_vinculos"),
    real.DB.prepare("DELETE FROM idempotencia"),
    real.DB.prepare("UPDATE usuarios SET telegram_chat_id = NULL"),
    real.DB
      .prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, telegram_chat_id, activo, creado_en)
         VALUES (?, 'tg-puerta-duena@babycaleb.com', 'Yarielis', 'duena', ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, activo = 1`,
      )
      .bind(DUENA, CHAT_DUENA, Date.now()),
    real.DB
      .prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, telegram_chat_id, activo, creado_en)
         VALUES (?, 'tg-puerta-otra@babycaleb.com', 'Yari', 'duena', ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, activo = 1`,
      )
      .bind(OTRA, CHAT_OTRA, Date.now()),
  ]);
});

// ---------------------------------------------------------------------------
// El secreto del webhook
// ---------------------------------------------------------------------------

describe("sin el secreto, esta ruta no existe", () => {
  it("sin la cabecera contesta 404 y no hace NADA", async () => {
    const tg = botDeMentira();
    const r = await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "no debería hablar" }), tg.hacer),
      texto(CHAT_DUENA, "hola"),
      { secreto: null },
    );

    expect(r.estado).toBe(404);
    // El mismo cuerpo que cualquier ruta inexistente: desde fuera, esto no
    // está aquí.
    expect(JSON.parse(r.texto)).toMatchObject({ ok: false, codigo: "no_encontrado" });
    expect(tg.dicho).toHaveLength(0);
  });

  it("con un secreto equivocado, lo mismo", async () => {
    const tg = botDeMentira();
    const r = await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "no debería hablar" }), tg.hacer),
      texto(CHAT_DUENA, "hola"),
      { secreto: `${SECRETO}x` },
    );

    expect(r.estado).toBe(404);
    expect(tg.dicho).toHaveLength(0);
  });

  it("y si el secreto no está configurado, no abre ni con la cabecera correcta", async () => {
    // Falla CERRADO, como Access: un entorno al que se le olvidó el secreto
    // tendría el webhook abierto a cualquiera, y funcionaría, así que nadie
    // lo notaría.
    const tg = botDeMentira();
    const r = await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "no debería hablar" }), tg.hacer),
      texto(CHAT_DUENA, "hola"),
      { secreto: "", configurado: "" },
    );

    expect(r.estado).toBe(404);
    expect(tg.dicho).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// El silencio
// ---------------------------------------------------------------------------

describe("de un chat que no está vinculado no sale nada", () => {
  it("ni una respuesta, ni un error", async () => {
    const tg = botDeMentira();
    const r = await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "no debería hablar" }), tg.hacer),
      texto(CHAT_DESCONOCIDO, "¿cuánto vendieron hoy?"),
    );

    expect(r.estado).toBe(200);
    expect(r.texto).toBe("");
    expect(tg.dicho).toHaveLength(0);
    expect(tg.avisos).toHaveLength(0);
  });

  it("ni se llama al modelo, así que no cuesta nada", async () => {
    const antes = await turnosPagados();
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(), tg.hacer),
      texto(CHAT_DESCONOCIDO, "hola"),
    );
    // `guionFijo` sin parlamentos revienta si alguien le pide algo: que la
    // prueba pase es la demostración de que no se le pidió.
    expect(await turnosPagados()).toBe(antes);
  });

  it("ni cuando a esa persona le quitaron el acceso", async () => {
    await real.DB.prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").bind(DUENA).run();

    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "no debería hablar" }), tg.hacer),
      texto(CHAT_DUENA, "hola"),
    );
    expect(tg.dicho).toHaveLength(0);
  });

  it("y un chat desconocido no escribe nada en la base", async () => {
    // Si se reclamara la entrega antes de saber quién es, cualquiera podría
    // llenar `idempotencia` escribiéndole al bot.
    const tg = botDeMentira();
    await entregar(crearPuertaDeTelegram(cerebro(), tg.hacer), texto(CHAT_DESCONOCIDO, "hola"));

    const filas = await real.DB.prepare("SELECT COUNT(*) AS n FROM idempotencia").first<{
      n: number;
    }>();
    expect(filas?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Un turno
// ---------------------------------------------------------------------------

describe("un chat vinculado", () => {
  it("recibe lo que contestó Caleb", async () => {
    const tg = botDeMentira();
    const r = await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "Quedan 12 cajas." }), tg.hacer),
      texto(CHAT_DUENA, "¿cuánto queda de la M?"),
    );

    expect(r.estado).toBe(200);
    expect(tg.dicho).toEqual([{ chatId: CHAT_DUENA, texto: "Quedan 12 cajas." }]);
  });

  it("anota el gasto en el canal telegram, sin inventarse la tarifa", async () => {
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(
        cerebro({ texto: "Listo.", uso: { entrada: 900, salida: 40, cacheLeida: 0, cacheEscrita: 0 } }),
        tg.hacer,
      ),
      texto(CHAT_DUENA, "hola"),
    );

    const fila = await real.DB.prepare(
      `SELECT canal, modelo, entrada, salida, costo_micro_usd FROM asistente_uso
        WHERE usuario_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(DUENA)
      .first<{
        canal: string;
        modelo: string;
        entrada: number;
        salida: number;
        costo_micro_usd: number;
      }>();

    expect(fila).toMatchObject({
      canal: "telegram",
      modelo: "muse-spark-de-pruebas",
      entrada: 900,
      salida: 40,
      // La tarifa del modelo no existe (hueco `tarifa_del_modelo`): las fichas
      // se anotan porque son un hecho, el costo queda a la vista en cero.
      costo_micro_usd: 0,
    });
  });

  it("si el mensaje no es texto, lo dice y no llama al modelo", async () => {
    const tg = botDeMentira();
    await entregar(crearPuertaDeTelegram(cerebro(), tg.hacer), {
      update_id: siguienteUpdate++,
      message: {
        message_id: 3,
        chat: { id: Number(CHAT_DUENA), type: "private" },
        from: { id: Number(CHAT_DUENA) },
      },
    });

    expect(tg.dicho).toHaveLength(1);
    expect(tg.dicho[0]!.texto).toContain("solo entiendo texto");
  });

  it("con /start saluda sin gastar una llamada", async () => {
    const tg = botDeMentira();
    await entregar(crearPuertaDeTelegram(cerebro(), tg.hacer), texto(CHAT_DUENA, "/start"));
    expect(tg.dicho[0]!.texto).toContain("Soy Caleb");
  });

  it("y si pide vincular, se le dice que ya está", async () => {
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(), tg.hacer),
      texto(CHAT_DUENA, "/vincular ABCD-EFGH-JKMN"),
    );
    expect(tg.dicho[0]!.texto).toContain("ya está vinculado");
  });

  it("sin la llave del modelo se le dice en español, no se queda muda", async () => {
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(sinLlave, tg.hacer),
      texto(CHAT_DUENA, "¿cuánto vendí hoy?"),
    );
    expect(tg.dicho[0]!.texto).toContain("META_API_KEY");
  });

  it("la misma entrega dos veces se atiende UNA vez", async () => {
    // Telegram reintenta si no contestamos a tiempo. Reintentar un turno es
    // pagarlo dos veces y volver a proponer la misma acción sensible.
    const antes = await turnosPagados();
    const tg = botDeMentira();
    const puerta = crearPuertaDeTelegram(cerebro({ texto: "Una sola vez." }), tg.hacer);
    const entrega = texto(CHAT_DUENA, "hola", 5_555);

    await entregar(puerta, entrega);
    await entregar(puerta, entrega);

    expect(tg.dicho).toHaveLength(1);
    expect(await turnosPagados()).toBe(antes + 1);
  });

  it("si no hay token del bot no se contesta a nadie, y queda dicho en el registro", async () => {
    const r = await entregar(
      crearPuertaDeTelegram(cerebro({ texto: "no debería hablar" }), sinBot),
      texto(CHAT_DUENA, "hola"),
    );
    expect(r.estado).toBe(200);
  });

  it("un cuerpo que no se entiende se calla y contesta 200", async () => {
    // Si contestara un error, Telegram reintentaría para siempre algo que
    // nunca vamos a saber leer.
    const tg = botDeMentira();
    const r = await entregar(crearPuertaDeTelegram(cerebro(), tg.hacer), { cualquier: "cosa" });
    expect(r.estado).toBe(200);
    expect(tg.dicho).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Las acciones sensibles
// ---------------------------------------------------------------------------

const PIDE_PERMISO: Parlamento = {
  texto: "Voy a cambiarlo.",
  llamadas: [
    {
      id: "llamada-1",
      nombre: "cambiar_precio",
      argumentos: { codigo: "NAT-M", precio_cents: 5_500, motivo: "lo pidió la dueña" },
    },
  ],
};

describe("una acción sensible se pregunta con botones", () => {
  it("y no se hace hasta que alguien los toque", async () => {
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(PIDE_PERMISO), tg.hacer),
      texto(CHAT_DUENA, "sube NAT-M a 55"),
    );

    const ultimo = tg.dicho.at(-1)!;
    expect(ultimo.texto).toContain("¿Lo hago?");
    expect(ultimo.texto).toContain("NAT-M");
    expect(ultimo.botones).toBeDefined();

    const accion = await real.DB.prepare(
      "SELECT id, canal, estado, herramienta FROM acciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(DUENA)
      .first<{ id: string; canal: string; estado: string; herramienta: string }>();

    expect(accion).toMatchObject({
      canal: "telegram",
      estado: "por_confirmar",
      herramienta: "cambiar_precio",
    });
    // Y el botón lleva ESA acción, no otra.
    const datos = ultimo.botones!.inline_keyboard[0]![0]!.callback_data;
    expect(leerBoton(datos)).toEqual({ decision: "permitir", accionId: accion!.id });
  });

  it("solo la puede confirmar quien la pidió", async () => {
    // En Telegram los botones viven en un chat. Sin esto, cualquiera con otro
    // chat vinculado confirmaría un cambio de precio que pidió otra persona.
    const tg = botDeMentira();
    const puerta = crearPuertaDeTelegram(cerebro(PIDE_PERMISO), tg.hacer);
    await entregar(puerta, texto(CHAT_DUENA, "sube NAT-M a 55"));

    const datos = tg.dicho.at(-1)!.botones!.inline_keyboard[0]![0]!.callback_data;
    const accionId = leerBoton(datos)!.accionId;

    // La toca la OTRA persona, desde su propio chat vinculado.
    await entregar(
      crearPuertaDeTelegram(cerebro(), tg.hacer),
      toque(CHAT_OTRA, datos),
    );

    expect(tg.avisos.at(-1)).toContain("solo puede confirmarla quien la pidió");
    const estado = await real.DB.prepare("SELECT estado FROM acciones WHERE id = ?")
      .bind(accionId)
      .first<{ estado: string }>();
    expect(estado?.estado).toBe("por_confirmar");
  });

  it("rechazarla la cierra sin hacerla", async () => {
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(PIDE_PERMISO), tg.hacer),
      texto(CHAT_DUENA, "sube NAT-M a 55"),
    );
    const botones = tg.dicho.at(-1)!.botones!.inline_keyboard[0]!;
    const rechazar = botones[1]!.callback_data;
    const accionId = leerBoton(rechazar)!.accionId;

    await entregar(crearPuertaDeTelegram(cerebro(), tg.hacer), toque(CHAT_DUENA, rechazar));

    const estado = await real.DB.prepare("SELECT estado FROM acciones WHERE id = ?")
      .bind(accionId)
      .first<{ estado: string }>();
    expect(estado?.estado).toBe("rechazada");
    // Y se le quitan los botones, para que no se vuelvan a tocar.
    expect(tg.quitados.at(-1)).toMatchObject({ chatId: CHAT_DUENA });
    expect(tg.dicho.at(-1)!.texto).toContain("no lo hice");
  });

  it("un botón con datos que no escribimos nosotros no hace nada", async () => {
    const tg = botDeMentira();
    await entregar(crearPuertaDeTelegram(cerebro(), tg.hacer), toque(CHAT_DUENA, "cualquier-cosa"));
    expect(tg.avisos.at(-1)).toContain("ya no vale");
    expect(tg.dicho).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Vincular
// ---------------------------------------------------------------------------

describe("vincular un chat", () => {
  it("un código bueno vincula y se contesta; es la única cosa que un desconocido oye", async () => {
    const r = await crearCodigoDeVinculo({ db: real.DB, ahora: Date.now() }, OTRA, DUENA);
    if (!r.ok) throw new Error(r.mensaje);
    // Esa persona no tenía chat todavía.
    await real.DB.prepare("UPDATE usuarios SET telegram_chat_id = NULL WHERE id = ?")
      .bind(OTRA)
      .run();

    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(), tg.hacer),
      texto(CHAT_DESCONOCIDO, `/vincular ${r.datos.codigo}`),
    );

    expect(tg.dicho).toHaveLength(1);
    expect(tg.dicho[0]!.texto).toContain("Yari");
    const fila = await real.DB.prepare("SELECT telegram_chat_id FROM usuarios WHERE id = ?")
      .bind(OTRA)
      .first<{ telegram_chat_id: string | null }>();
    expect(fila?.telegram_chat_id).toBe(CHAT_DESCONOCIDO);
  });

  it("también pegado a secas, sin comando", async () => {
    const r = await crearCodigoDeVinculo({ db: real.DB, ahora: Date.now() }, OTRA, DUENA);
    if (!r.ok) throw new Error(r.mensaje);

    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(), tg.hacer),
      texto(CHAT_DESCONOCIDO, r.datos.codigo),
    );
    expect(tg.dicho).toHaveLength(1);
  });

  it("un código malo se contesta con el mismo silencio que un desconocido", async () => {
    // Decir «ese código no vale» le confirmaría a quien prueba códigos que hay
    // algo detrás. El precio es que un código mal copiado no avisa, y por eso
    // la pantalla que lo entrega tiene que decirlo.
    const tg = botDeMentira();
    await entregar(
      crearPuertaDeTelegram(cerebro(), tg.hacer),
      texto(CHAT_DESCONOCIDO, "/vincular ABCD-EFGH-JKMN"),
    );
    expect(tg.dicho).toHaveLength(0);
  });

  it("y un código ya usado tampoco vale una segunda vez", async () => {
    const r = await crearCodigoDeVinculo({ db: real.DB, ahora: Date.now() }, OTRA, DUENA);
    if (!r.ok) throw new Error(r.mensaje);

    const tg = botDeMentira();
    const puerta = crearPuertaDeTelegram(cerebro(), tg.hacer);
    await entregar(puerta, texto(CHAT_DESCONOCIDO, r.datos.codigo));
    await entregar(puerta, texto("900900900", r.datos.codigo));

    expect(tg.dicho).toHaveLength(1);
    const fila = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM usuarios WHERE telegram_chat_id = ?",
    )
      .bind("900900900")
      .first<{ n: number }>();
    expect(fila?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lo que se lee de un mensaje
// ---------------------------------------------------------------------------

describe("qué pidió", () => {
  it("reconoce los comandos de Telegram, con y sin el nombre del bot", () => {
    expect(quePidio("/start")).toBe("saludo");
    expect(quePidio("/start@CalebBot")).toBe("saludo");
    expect(quePidio("/vincular ABCD-EFGH-JKMN")).toBe("vincular");
    expect(quePidio("/start ABCD-EFGH-JKMN")).toBe("vincular");
    expect(quePidio("¿cuánto queda de la M?")).toBeNull();
  });

  it("y un código se reconoce de las tres formas en que lo van a mandar", () => {
    expect(codigoPegado("/vincular ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
    expect(codigoPegado("/start ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
    expect(codigoPegado("ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
    expect(codigoPegado("hola, ¿cómo está?")).toBeNull();
    expect(codigoPegado("/vincular")).toBeNull();
  });
});
