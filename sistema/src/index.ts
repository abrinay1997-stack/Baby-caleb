import { Hono } from "hono";
import { panel } from "./api/panel";
import { puertaDeTelegram } from "./api/telegram-rutas";
import { mcp } from "./mcp/servidor";
import { vencerPendientes } from "./asistente/ejecutar";
import { barrer, leerPublico } from "./db/archivos";
import { MANEJADORES, atrasados, consumir, publicarPendientes } from "./eventos";
import { conCabecerasDeSeguridad, encendido, superficieDe } from "./seguridad";

/**
 * Los entrypoints RPC (01-arquitectura §5). La web y el CRM los llaman por
 * service binding: no salen a internet y no hay forma de alcanzarlos desde
 * fuera de la cuenta, así que la puerta es el binding y lo que se vigila aquí
 * es QUÉ devuelve cada uno.
 */
export { SistemaWeb } from "./rpc/web";
export { SistemaCRM } from "./rpc/crm";


// ---------------------------------------------------------------------------
// Panel y app del motorizado
// ---------------------------------------------------------------------------
const app = new Hono<{ Bindings: Env }>();

/**
 * Salud: versión, última migración aplicada y una prueba de humo contra D1.
 * No lleva datos del negocio, así que no necesita Access.
 */
app.get("/salud", async (c) => {
  const inicio = Date.now();
  let migracion: string | null = null;
  let humo = false;
  let detalle: string | null = null;
  let outbox: { cuantos: number; masViejo: number | null } = { cuantos: 0, masViejo: null };

  try {
    // wrangler d1 migrations guarda lo aplicado en d1_migrations.
    const fila = await c.env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
    ).first<{ name: string }>();
    migracion = fila?.name ?? null;
    const uno = await c.env.DB.prepare("SELECT 1 AS uno").first<{ uno: number }>();
    humo = uno?.uno === 1;
    outbox = await atrasados(c.env.DB);
  } catch (e) {
    detalle = e instanceof Error ? e.message : String(e);
  }

  // El outbox atrasado no se considera «no sano»: el cron lo va a sacar. Pero
  // sale en la respuesta porque un número que no baja es la primera señal de
  // que los avisos no están llegando, y eso no se ve por ningún otro lado.
  const sano = humo && migracion !== null;
  return c.json(
    {
      sano,
      // La fija el despliegue al SHA del commit (`--var VERSION:...`).
      version: c.env.VERSION,
      entorno: c.env.ENTORNO ?? "local",
      migracion,
      humo,
      outbox_sin_publicar: outbox.cuantos,
      outbox_mas_viejo: outbox.masViejo,
      ms: Date.now() - inicio,
      ...(detalle === null ? {} : { detalle }),
    },
    sano ? 200 : 503,
  );
});

/**
 * Toda la API del panel, detrás de Cloudflare Access.
 *
 * Se monta entera en vez de ruta por ruta: así es imposible agregar una
 * pantalla nueva y olvidarse de ponerle la puerta — el middleware de
 * `api/panel.ts` corre antes que cualquiera de sus rutas.
 */
app.route("/api", panel);

/**
 * La tercera puerta del asistente: MCP.
 *
 * Va FUERA de Access a propósito: un cliente de MCP no tiene navegador y no
 * puede iniciar sesión con Google. Su puerta es una llave personal, y esa
 * llave dice quién es — la política del asistente decide por el ROL de la
 * persona, no por el canal. Ver `src/mcp/servidor.ts`.
 *
 * `/mcp` ya estaba en `run_worker_first` de los dos entornos desde hace meses,
 * apuntando a una ruta que no existía. Ahora existe.
 */
app.all("/mcp", async (c) => await mcp(c.req.raw, c.env));

/**
 * El webhook de Telegram, y va FUERA de `/api` a propósito.
 *
 * Access es una puerta para personas con navegador y Telegram no inicia sesión
 * en ninguna parte: detrás de Access, Cloudflare le contestaría a Telegram con
 * la pantalla de login y el bot quedaría mudo sin que nadie viera un error. Su
 * puerta es otra y está en `api/telegram-rutas.ts`: el `secret_token` del
 * webhook comparado en tiempo constante, y el `chat_id` cruzado con
 * `usuarios`. De cualquier chat que no esté ahí no sale ninguna respuesta.
 *
 * Esta ruta va además en `run_worker_first` de los dos entornos desplegados:
 * sin eso, el servidor de estáticos del panel podría contestar antes que el
 * Worker (trampa nº 8 — la lista de configuración que alguien tiene que
 * acordarse de tocar; `run_worker_first` ya mordió una vez).
 */
app.route("/telegram", puertaDeTelegram);

/**
 * Las fotos del catálogo, también por aquí.
 *
 * Ya las sirve la WEB en `babycaleb.com/foto/…`, para que las vea cualquiera
 * sin sesión. Pero el panel vive en `panel.babycaleb.com`, y lo que se guarda
 * en `variantes.imagen` es una ruta RELATIVA (`/foto/<clave>`): dentro del
 * panel ese `<img>` pedía `panel.babycaleb.com/foto/…`, que no era ninguna
 * ruta de este Worker, y el servidor de estáticos contestaba con el login de
 * Access. Resultado: la foto subía —201, y el archivo de verdad en R2— y no se
 * veía NUNCA. Quien la subió lo lee como «no se puede poner una foto», que es
 * lo único que se puede leer cuando no aparece nada.
 *
 * Apuntar el `<img>` a `babycaleb.com` NO era el arreglo: la CSP del panel es
 * `img-src 'self'` (seguridad/cabeceras.ts), así que el navegador lo habría
 * bloqueado igual. Eran dos muros independientes y los dos callados. Servirla
 * aquí arregla los dos de una vez y deja el valor guardado válido en los dos
 * dominios, que es la razón de que sea relativo.
 *
 * No pide permiso de panel, a propósito: un `<img>` no manda cabeceras ni
 * token, así que exigirlo sería volver a no ver la foto. Quién puede salir lo
 * decide `leerPublico`, la MISMA función que usa la web por RPC — `sensible =
 * 0`, sin marca de borrado y un mime de imagen. En ese bucket viven también
 * los comprobantes de pago de las clientas: el filtro tiene un solo dueño
 * justo para que no haya dos que puedan discrepar.
 *
 * Esta ruta va además en `run_worker_first` de los dos entornos desplegados.
 * Sin eso el servidor de estáticos contesta antes y volvemos al 302 — la
 * trampa nº 8, la lista de configuración que alguien tiene que acordarse de
 * tocar, que con `/mcp` ya mordió una vez.
 */
app.get("/foto/*", async (c) => {
  const prefijo = "/foto/";
  let clave: string;
  try {
    clave = decodeURIComponent(new URL(c.req.url).pathname.slice(prefijo.length));
  } catch {
    // Un `%` suelto en la URL. No es una clave, es basura.
    return noHayFoto();
  }
  if (clave === "" || clave.length > 512) return noHayFoto();

  const a = await leerPublico({ db: c.env.DB, r2: c.env.PRIVADO }, clave);
  if (a === null) return noHayFoto();

  return new Response(a.cuerpo, {
    headers: {
      // El mime sale de la FILA, no de R2: es el que se validó al subir.
      "content-type": a.mime,
      // Un año e inmutable: la clave lleva un ULID dentro, así que cambiar la
      // foto de un producto es OTRA clave. No hay caché que esperar.
      "cache-control": "public, max-age=31536000, immutable",
      // Que el navegador no adivine el tipo, igual que en la web.
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
});

/**
 * «No existe» y «no se sirve en abierto» contestan LO MISMO, a propósito.
 *
 * Distinguirlos le diría a quien prueba claves al azar cuáles existen, y lo
 * que hay en ese bucket además de fotos son comprobantes de pago.
 */
const noHayFoto = () =>
  new Response("No encontrado", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

app.all("*", (c) => c.json({ ok: false, codigo: "no_encontrado", mensaje: "ruta desconocida" }, 404));

// ---------------------------------------------------------------------------
// Worker: fetch, cola y crons
// ---------------------------------------------------------------------------
export default {
  /**
   * Las cabeceras de seguridad se ponen aquí, en un solo sitio, y no en cada
   * ruta: `public/_headers` no se aplica a lo que responde un Worker, así que
   * una ruta nueva que se olvide de ponerlas saldría desnuda. Así no puede.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const respuesta = await app.fetch(request, env, ctx);
    return conCabecerasDeSeguridad(respuesta, {
      superficie: superficieDe(new URL(request.url).hostname),
      // HSTS espera a que esté confirmado que todo subdominio sirve HTTPS
      // (07-seguridad.md §5). Se enciende cambiando la variable, sin tocar código.
      hsts: encendido(env.HSTS),
    });
  },

  /**
   * Consumidor de `bc-tareas` y de las colas muertas. Toda la lógica —validar
   * el sobre, descartar repetidos, despachar al manejador, avisar de lo que cae
   * en la cola muerta— está en `src/eventos/consumidor.ts`, que se puede probar
   * sin montar un Worker.
   */
  async queue(lote: MessageBatch<unknown>, env: Env): Promise<void> {
    await consumir(lote, env, Date.now(), MANEJADORES);
  },

  /**
   * Crons, cada 5 minutos (01-arquitectura.md §4). Los que faltan llegan con su
   * fase (08-operacion §6: vencer reservas, conciliar pagos, cuadrar
   * inventario).
   */
  async scheduled(_evento: ScheduledController, env: Env): Promise<void> {
    const ahora = Date.now();
    const r = await publicarPendientes(env, ahora);
    if (r.publicados.length > 0 || r.pendientes.length > 0) {
      console.log(
        JSON.stringify({
          evento: "cron_outbox",
          publicados: r.publicados.length,
          pendientes: r.pendientes.length,
        }),
      );
    }

    // Lo que el asistente propuso y nadie confirmó en 30 minutos se cierra.
    // Si no, una acción sensible se quedaría esperando para siempre y alguien
    // podría permitirla mañana creyendo que sigue siendo verdad lo que leyó.
    const vencidas = await vencerPendientes(env.DB, ahora);
    if (vencidas > 0) {
      console.log(JSON.stringify({ evento: "cron_acciones_vencidas", cuantas: vencidas }));
    }

    // Los archivos que cumplieron su margen se van de R2 de verdad. Esto es lo
    // único que borra multimedia en todo el sistema: ninguna pantalla lo hace
    // en el momento, justo para que un fallo a mitad no deje basura ni se lleve
    // una foto que todavía se podía recuperar.
    const b = await barrer({ db: env.DB, r2: env.PRIVADO, ahora, actor: "cron" });
    if (b.ok && (b.datos.borrados > 0 || b.datos.fallidos > 0)) {
      console.log(JSON.stringify({ evento: "cron_barrido_archivos", ...b.datos }));
    }
  },
} satisfies ExportedHandler<Env, unknown>;
