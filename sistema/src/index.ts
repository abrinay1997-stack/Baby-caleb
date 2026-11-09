import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { type Resultado, pendienteDeFase } from "./contrato/resultado";
import { MANEJADORES, atrasados, consumir, publicarPendientes } from "./eventos";
import {
  conCabecerasDeSeguridad,
  encendido,
  permisosDe,
  revisarPeticion,
  superficieDe,
  usuarioDeCorreo,
} from "./seguridad";

/** Se reemplaza en el build por el SHA del commit (sistema.yml, F2.11). */
const VERSION = "0.1.0-dev";

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
      version: VERSION,
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
 * Quién soy y qué puedo.
 *
 * Es la primera ruta detrás de la puerta, y es la que el panel llama al abrir
 * para saber qué pestañas mostrar. Vale además como prueba de vida de toda la
 * cadena: Access firma, el Worker verifica, el correo se cruza con `usuarios` y
 * sale el rol con sus permisos.
 *
 * Los dos pasos son distintos y los dos pueden fallar: Access dice que esa
 * persona es quien dice ser, y `usuarios` dice si además trabaja aquí. El
 * motivo se devuelve a propósito —«sin token», «vencido», «audiencia», «no está
 * en usuarios»— porque sin él un 403 en el panel es un callejón sin salida;
 * es la lección del incidente 4 de D'Casa.
 */
app.get("/api/yo", async (c) => {
  const puerta = await revisarPeticion(c.req.raw, c.env);
  if (!("identidad" in puerta)) {
    return c.json(
      { ok: false, codigo: "no_autorizado", mensaje: `Access: ${puerta.rechazo.motivo}` },
      403,
    );
  }

  const fila = await c.env.DB.prepare(
    "SELECT id, correo, nombre, rol, activo FROM usuarios WHERE correo = ?",
  )
    .bind(puerta.identidad.correo)
    .first<{ id: string; correo: string; nombre: string; rol: string; activo: number }>();

  const usuario = usuarioDeCorreo(puerta.identidad.correo, fila);
  if (!usuario.ok) {
    return c.json({ ok: false, codigo: "no_autorizado", mensaje: usuario.motivo }, 403);
  }

  return c.json({
    ok: true,
    usuario: usuario.usuario,
    permisos: permisosDe(usuario.usuario.rol),
  });
});

app.all("*", (c) => c.json({ ok: false, codigo: "no_encontrado", mensaje: "ruta desconocida" }, 404));

// ---------------------------------------------------------------------------
// RPC · lo que la web puede pedirle al sistema
// ---------------------------------------------------------------------------
export class SistemaWeb extends WorkerEntrypoint<Env> {
  async catalogo(): Promise<Resultado<{ items: never[] }>> {
    return pendienteDeFase("El catálogo para la web", "F3.5");
  }
  async zonasEnvio(): Promise<Resultado<{ zonas: never[] }>> {
    return pendienteDeFase("Las zonas de envío", "F3.2");
  }
}

// ---------------------------------------------------------------------------
// RPC · lo que el CRM puede pedirle al sistema
// ---------------------------------------------------------------------------
export class SistemaCRM extends WorkerEntrypoint<Env> {
  async catalogo(): Promise<Resultado<{ items: never[] }>> {
    return pendienteDeFase("El catálogo para el bot", "F3.2");
  }
  async stock(): Promise<Resultado<{ existencias: never[] }>> {
    return pendienteDeFase("La consulta de existencias", "F3.2");
  }
}

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
   * Crons. Por ahora uno: republicar lo que el outbox dejó sin publicar, cada
   * 5 minutos (01-arquitectura.md §4). Los demás llegan con su fase
   * (08-operacion §6: vencer reservas, conciliar pagos, cuadrar inventario).
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
  },
} satisfies ExportedHandler<Env, unknown>;
