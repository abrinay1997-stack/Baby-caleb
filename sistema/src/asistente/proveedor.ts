import type { DefinicionDeHerramienta } from "./registro";

/**
 * El cerebro del asistente, detrás de una interfaz.
 *
 * Igual que en el CRM (`src/llm/provider.ts`): el bucle no sabe con quién
 * habla, así que cambiar de modelo o de proveedor no lo toca. Aquí viven dos
 * proveedores —uno de guion fijo para las pruebas y el de Meta— y el envoltorio
 * que pasa al respaldo cuando el principal falla dos veces seguidas.
 *
 * SOBRE LO QUE NO SE PUDO VERIFICAR (léase antes de tocar `meta()`):
 *
 * El plan (06-asistente §6) justifica varias decisiones citando «lo que el CRM
 * ya aprendió en `src/llm/provider.ts`»: que Meta habla el formato de mensajes
 * de Anthropic en `/v1/messages`, que falla con `eager_input_streaming`, que
 * rechaza `max_tokens` menor de 16 y que hay una prueba que vigila que el token
 * de Messenger no viaje a `api.meta.ai`. En el CRM NO hay nada de eso: su
 * proveedor es Anthropic/OpenAI/xAI y no menciona a Meta en ninguna línea. Esas
 * afirmaciones no están comprobadas contra código que exista.
 *
 * Lo que sí está comprobado (noviembre 2026): el Model API de Meta vive en
 * `api.meta.ai/v1`, el nivel Contributor existe y cuesta ~$0.10/$0.20 por millón
 * a cambio de permiso para entrenar con lo que recibe, y el nivel se elige por
 * el id del modelo (`muse-spark-1.3` contra `muse-spark-1.3-contributor`).
 * Lo que NO está comprobado es la RUTA ni el formato exacto: unas fuentes dicen
 * formato de Anthropic, otras el de OpenAI.
 *
 * Por eso la ruta y la base son configuración y no están escritas en el código:
 * si el formato resulta ser el otro, es un ajuste, no un despliegue. Y por eso
 * `meta()` no se da por bueno hasta que una llamada de verdad funcione.
 */

// ---------------------------------------------------------------------------
// La interfaz
// ---------------------------------------------------------------------------

export interface Mensaje {
  readonly rol: "user" | "assistant" | "tool";
  readonly contenido: string;
  /** Si `rol` es "tool", a qué llamada responde. */
  readonly llamadaId?: string;
  /**
   * Si `rol` es "assistant", las herramientas que pidió en ese turno.
   *
   * Hay que guardarlas y devolverlas tal cual. En esta forma de API un
   * `tool_result` solo vale si el turno del asistente que va JUSTO antes trae
   * el `tool_use` con el mismo id; si el historial reconstruye ese turno como
   * texto pelado, el id no existe y la API rechaza la petición entera.
   *
   * Por eso no basta con recordar lo que el modelo DIJO: hay que recordar
   * también lo que PIDIÓ.
   */
  readonly llamadas?: readonly LlamadaAHerramienta[];
}

export interface LlamadaAHerramienta {
  readonly id: string;
  readonly nombre: string;
  readonly argumentos: unknown;
}

export interface Uso {
  readonly entrada: number;
  readonly salida: number;
  readonly cacheLeida: number;
  readonly cacheEscrita: number;
}

export const SIN_USO: Uso = { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 };

export interface Peticion {
  readonly sistema: string;
  readonly mensajes: readonly Mensaje[];
  readonly herramientas: readonly DefinicionDeHerramienta[];
  /** Meta rechaza menos de 16 (06-asistente §6). El proveedor lo hace cumplir. */
  readonly maxTokens?: number;
}

export interface Respuesta {
  readonly texto: string;
  readonly llamadas: readonly LlamadaAHerramienta[];
  readonly uso: Uso;
  readonly modelo: string;
}

export interface Proveedor {
  readonly nombre: string;
  readonly modelo: string;
  responder(p: Peticion): Promise<Respuesta>;
}

/** El mínimo que acepta Meta. */
export const MAX_TOKENS_MINIMO = 16;
export const MAX_TOKENS_POR_OMISION = 2048;

// ---------------------------------------------------------------------------
// Proveedor de guion fijo · para las pruebas
// ---------------------------------------------------------------------------

/** Un paso del guion: lo que el «modelo» contesta esta vez. */
export interface Parlamento {
  readonly texto?: string;
  readonly llamadas?: readonly LlamadaAHerramienta[];
  readonly uso?: Uso;
}

/**
 * Un proveedor que no toca la red.
 *
 * Es lo que pide 06-asistente §9 para poder probar el bucle, la política y la
 * bitácora sin depender de que Meta esté arriba, sin pagar y sin que la prueba
 * dé un resultado distinto cada vez. Guarda además lo que se le pidió, que es
 * como se comprueba que al modelo no le llegó lo que no debía llegarle.
 */
export function guionFijo(guion: readonly Parlamento[], modelo = "guion-fijo"): Proveedor & {
  readonly pedido: Peticion[];
  readonly quedan: () => number;
} {
  const pedido: Peticion[] = [];
  let i = 0;

  return {
    nombre: "guion-fijo",
    modelo,
    pedido,
    quedan: () => guion.length - i,
    async responder(p: Peticion): Promise<Respuesta> {
      pedido.push(p);
      const paso = guion[i];
      i += 1;
      if (paso === undefined) {
        // Se acabó el guion y el bucle sigue pidiendo: es un fallo de la
        // prueba, y decirlo claro ahorra media hora de depuración.
        throw new Error(
          `el guion fijo tenía ${guion.length} parlamento(s) y se pidió el ${i}: al bucle le falta una salida`,
        );
      }
      return {
        texto: paso.texto ?? "",
        llamadas: paso.llamadas ?? [],
        uso: paso.uso ?? SIN_USO,
        modelo,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Proveedor de Meta
// ---------------------------------------------------------------------------

export interface ConfiguracionDeMeta {
  readonly clave: string;
  readonly modelo: string;
  /** Por omisión `https://api.meta.ai/v1`. Es configuración: ver la nota de arriba. */
  readonly base?: string;
  /** Por omisión `/messages`. También configuración, y por lo mismo. */
  readonly ruta?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Los tokens de Graph (Messenger, Instagram, WhatsApp) empiezan por `EAA`.
 *
 * Esos NUNCA van a `api.meta.ai`: son de otra cosa, dan acceso a las páginas y
 * a los mensajes de las clientas, y mandarlos a una API de modelos es
 * entregarlos a un sitio que no los necesita. El plan dice que el CRM tiene una
 * prueba que lo vigila; no la tiene, así que la guarda vive aquí, en el código,
 * donde no depende de que alguien se acuerde.
 */
export const pareceTokenDeGraph = (clave: string): boolean => /^EAA[A-Za-z0-9]/.test(clave.trim());

export function meta(cfg: ConfiguracionDeMeta): Proveedor {
  const clave = cfg.clave.trim();
  if (clave === "") throw new Error("falta la llave del modelo (META_API_KEY)");
  if (pareceTokenDeGraph(clave)) {
    throw new Error(
      "esa llave parece un token de Graph (Messenger/Instagram/WhatsApp) y no la del Model API: no se manda a api.meta.ai",
    );
  }

  const base = (cfg.base ?? "https://api.meta.ai/v1").replace(/\/+$/, "");
  const ruta = cfg.ruta ?? "/messages";
  const pedir = cfg.fetch ?? fetch;

  return {
    nombre: "meta",
    modelo: cfg.modelo,

    async responder(p: Peticion): Promise<Respuesta> {
      const cuerpo = {
        model: cfg.modelo,
        // Nunca por debajo de 16: Meta lo rechaza.
        max_tokens: Math.max(p.maxTokens ?? MAX_TOKENS_POR_OMISION, MAX_TOKENS_MINIMO),
        system: p.sistema,
        messages: aMensajesDeLaApi(p.mensajes),
        // Sin `eager_input_streaming` y sin `cache_control`: lo primero hace
        // fallar cada mensaje y lo segundo no se sabe que Meta lo acepte, así
        // que el costo se calcula sin caché (06-asistente §6).
        tools: p.herramientas.map((h) => ({
          name: h.name,
          description: h.description,
          input_schema: h.input_schema,
        })),
        tool_choice: { type: "auto" },
      };

      const r = await pedir(`${base}${ruta}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${clave}`,
        },
        body: JSON.stringify(cuerpo),
      });

      if (!r.ok) {
        // El cuerpo del error se recorta: puede traer de vuelta lo que se mandó.
        const detalle = (await r.text().catch(() => "")).slice(0, 300);
        throw new Error(`el modelo contestó ${r.status}: ${detalle}`);
      }

      return leerRespuesta(await r.json(), cfg.modelo);
    },
  };
}

/**
 * El historial, en la forma que la API acepta.
 *
 * Mapear mensaje a mensaje NO sirve, y es un error que solo se ve cuando
 * alguien por fin encadena una herramienta con la API de verdad: el proveedor
 * se probó contra el guion fijo, que no valida nada de esto.
 *
 * Dos reglas que el mapeo uno a uno rompía:
 *
 *  1. **El `tool_use` tiene que volver.** El turno del asistente que pidió
 *     herramientas se manda con sus bloques `tool_use`, no como texto pelado.
 *     Sin ellos, el `tool_result` que viene detrás apunta a un id que no
 *     existe y la API rechaza la petición entera.
 *  2. **Los resultados de un mismo turno van JUNTOS.** Si el modelo pidió dos
 *     herramientas, las dos respuestas van en UN solo mensaje de usuario. Uno
 *     por mensaje deja mensajes de usuario seguidos y un `tool_use` sin su
 *     respuesta al lado.
 *
 * Un bloque de texto vacío tampoco se manda: la API los rechaza, y un turno en
 * el que el modelo solo pidió herramientas no tiene texto que mandar.
 */
export function aMensajesDeLaApi(mensajes: readonly Mensaje[]): Record<string, unknown>[] {
  const salida: Record<string, unknown>[] = [];
  let resultados: Record<string, unknown>[] = [];

  const cerrarResultados = (): void => {
    if (resultados.length === 0) return;
    salida.push({ role: "user", content: resultados });
    resultados = [];
  };

  for (const m of mensajes) {
    if (m.rol === "tool") {
      resultados.push({
        type: "tool_result",
        tool_use_id: m.llamadaId ?? "",
        content: m.contenido,
      });
      continue;
    }

    // Cualquier mensaje que no sea un resultado cierra el grupo que venía.
    cerrarResultados();

    if (m.rol === "assistant" && m.llamadas !== undefined && m.llamadas.length > 0) {
      const bloques: Record<string, unknown>[] = [];
      if (m.contenido.trim() !== "") bloques.push({ type: "text", text: m.contenido });
      for (const ll of m.llamadas) {
        bloques.push({ type: "tool_use", id: ll.id, name: ll.nombre, input: ll.argumentos });
      }
      salida.push({ role: "assistant", content: bloques });
      continue;
    }

    salida.push({ role: m.rol, content: m.contenido });
  }

  cerrarResultados();
  return salida;
}

/**
 * Lee la respuesta sin confiar en su forma.
 *
 * Si el formato no es el que se espera, se devuelve lo que se haya podido leer
 * en vez de reventar: un cambio de forma del proveedor no debe dejar a la dueña
 * sin asistente, y lo que no se entienda se verá como una respuesta vacía, que
 * es honesto.
 */
export function leerRespuesta(crudo: unknown, modelo: string): Respuesta {
  const cuerpo = (crudo ?? {}) as Record<string, unknown>;
  const bloques = Array.isArray(cuerpo["content"]) ? (cuerpo["content"] as unknown[]) : [];

  let texto = "";
  const llamadas: LlamadaAHerramienta[] = [];

  for (const b of bloques) {
    const bloque = (b ?? {}) as Record<string, unknown>;
    if (bloque["type"] === "text" && typeof bloque["text"] === "string") {
      texto += bloque["text"];
    } else if (bloque["type"] === "tool_use" && typeof bloque["name"] === "string") {
      llamadas.push({
        id: typeof bloque["id"] === "string" ? bloque["id"] : "",
        nombre: bloque["name"],
        argumentos: bloque["input"] ?? {},
      });
    }
  }

  const uso = (cuerpo["usage"] ?? {}) as Record<string, unknown>;
  const entero = (v: unknown): number => (typeof v === "number" && v >= 0 ? Math.trunc(v) : 0);

  return {
    texto,
    llamadas,
    uso: {
      entrada: entero(uso["input_tokens"]),
      salida: entero(uso["output_tokens"]),
      cacheLeida: entero(uso["cache_read_input_tokens"]),
      cacheEscrita: entero(uso["cache_creation_input_tokens"]),
    },
    modelo: typeof cuerpo["model"] === "string" ? cuerpo["model"] : modelo,
  };
}

// ---------------------------------------------------------------------------
// Respaldo
// ---------------------------------------------------------------------------

/**
 * Pasa al respaldo cuando el principal falla dos veces seguidas, y lo anota.
 *
 * Dos y no una: un corte de un segundo no debería cambiar de modelo, porque el
 * respaldo cuesta diez veces más (06-asistente §6). Y la cuenta se reinicia con
 * cada acierto, porque lo que importa es que esté caído, no que alguna vez
 * fallara.
 */
export function conRespaldo(
  principal: Proveedor,
  respaldo: Proveedor | null,
  anotar: (aviso: string) => void = () => {},
): Proveedor {
  let fallosSeguidos = 0;

  return {
    nombre: `${principal.nombre}+respaldo`,
    modelo: principal.modelo,

    async responder(p: Peticion): Promise<Respuesta> {
      if (fallosSeguidos >= 2 && respaldo !== null) {
        anotar(`usando el respaldo (${respaldo.modelo}): ${principal.modelo} falló dos veces`);
        return await respaldo.responder(p);
      }

      try {
        const r = await principal.responder(p);
        fallosSeguidos = 0;
        return r;
      } catch (e) {
        fallosSeguidos += 1;
        const porque = e instanceof Error ? e.message : String(e);

        if (fallosSeguidos >= 2 && respaldo !== null) {
          anotar(`usando el respaldo (${respaldo.modelo}): ${porque}`);
          return await respaldo.responder(p);
        }
        // Sin respaldo, el asistente dice que no puede contestar ahora: no se
        // inventa una respuesta (06-asistente §6).
        throw e;
      }
    },
  };
}
