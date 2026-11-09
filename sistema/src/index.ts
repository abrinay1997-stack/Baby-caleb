import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { type Resultado, pendienteDeFase } from "./contrato/resultado";

/** Se reemplaza en el build por el SHA del commit (sistema.yml, F2.11). */
const VERSION = "0.1.0-dev";

/** Cuerpo de todo mensaje de bc-tareas. El `id` es el del outbox: con él se descarta un repetido. */
type MensajeTarea = { id: string; tipo: string };

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

  try {
    // wrangler d1 migrations guarda lo aplicado en d1_migrations.
    const fila = await c.env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
    ).first<{ name: string }>();
    migracion = fila?.name ?? null;
    const uno = await c.env.DB.prepare("SELECT 1 AS uno").first<{ uno: number }>();
    humo = uno?.uno === 1;
  } catch (e) {
    detalle = e instanceof Error ? e.message : String(e);
  }

  const sano = humo && migracion !== null;
  return c.json(
    {
      sano,
      version: VERSION,
      entorno: c.env.ENTORNO ?? "local",
      migracion,
      humo,
      ms: Date.now() - inicio,
      ...(detalle === null ? {} : { detalle }),
    },
    sano ? 200 : 503,
  );
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
  fetch: app.fetch,

  /**
   * Consumidor de bc-tareas. Las colas entregan AL MENOS UNA VEZ, así que lo
   * primero es la idempotencia: un evento ya procesado se reconoce y se
   * descarta. Esa parte ya es de verdad; el trabajo por tipo llega con cada fase.
   */
  async queue(lote: MessageBatch<MensajeTarea>, env: Env): Promise<void> {
    for (const mensaje of lote.messages) {
      const { id, tipo } = mensaje.body;
      try {
        const visto = await env.DB.prepare("SELECT 1 FROM eventos_recibidos WHERE id = ?")
          .bind(id)
          .first();
        if (visto) {
          mensaje.ack(); // repetido: ya se hizo
          continue;
        }
        await env.DB.prepare(
          "INSERT INTO eventos_recibidos (id, tipo, procesado_en) VALUES (?, ?, ?)",
        )
          .bind(id, tipo, Date.now())
          .run();
        mensaje.ack();
      } catch {
        // Que lo reintente la cola; a los 3 intentos cae en bc-tareas-muertos.
        mensaje.retry();
      }
    }
  },

  async scheduled(_evento: ScheduledController, _env: Env): Promise<void> {
    // Los crons se agregan en 08-operacion §6: republicar el outbox, vencer
    // reservas, conciliar pagos, cuadrar inventario.
  },
} satisfies ExportedHandler<Env, MensajeTarea>;
