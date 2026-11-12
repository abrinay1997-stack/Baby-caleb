import { catalogo } from "../asistente/index";
import { ejecutar } from "../asistente/ejecutar";
import { revisar } from "../asistente/referencias";
import { TURNO_LIMPIO } from "../asistente/politica";
import { quienEs } from "./llaves";

/**
 * El servidor MCP de Baby Caleb: `/mcp`.
 *
 * Es la tercera puerta del asistente (06-asistente §4). Las otras dos son el
 * chat del panel y Telegram, y las tres comparten UN catálogo de herramientas,
 * UNA política y UNA bitácora. Eso es lo importante: una puerta nueva no trae
 * permisos nuevos.
 *
 * ## Por qué esto y no el SDK
 *
 * El SDK oficial da por hecho un servidor de Node con sockets. Aquí vive un
 * Worker, y el protocolo que hace falta cabe en un archivo: JSON-RPC 2.0 por
 * POST, cinco métodos. La forma de cada mensaje está sacada de los esquemas
 * del paquete oficial `@modelcontextprotocol/sdk`, no de la memoria.
 *
 * ## Lo que NO hace, a propósito
 *
 * - **No ejecuta una acción sensible sin una persona.** Si una herramienta
 *   cambia dinero, precios o existencias, `ejecutar()` la deja esperando y
 *   aquí se devuelve `isError: true` diciendo que NO se hizo y dónde se
 *   permite. Devolverlo como éxito haría que un agente creyera que ya está.
 *   Que MCP confirme sus propias acciones sensibles vaciaría la garantía
 *   entera: el punto de la confirmación es que la mire un humano.
 * - **No manda datos de clientas al cliente de MCP.** El mismo filtro que
 *   protege al modelo (D-20) se aplica aquí: al otro lado de MCP hay otro
 *   modelo, de otra empresa, y las clientas siguen sin haber acordado nada.
 * - **No transmite por SSE.** El transporte permite contestar con JSON plano
 *   cuando no hay nada que transmitir, y aquí no lo hay: una herramienta
 *   contesta de una vez.
 */

/** Las que sabemos hablar. La primera es la que preferimos. */
const VERSIONES = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Los códigos de JSON-RPC 2.0, tal como los define el protocolo. */
const ERROR = {
  parse: -32700,
  peticionInvalida: -32600,
  metodoDesconocido: -32601,
  parametrosInvalidos: -32602,
  interno: -32603,
} as const;

interface Mensaje {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const json = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const resultado = (id: unknown, result: unknown): unknown => ({ jsonrpc: "2.0", id, result });

const error = (id: unknown, code: number, message: string): unknown => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Un bloque de texto, que es lo único que este servidor devuelve. */
const texto = (t: string): unknown => ({ type: "text", text: t });

export async function mcp(peticion: Request, env: Env): Promise<Response> {
  // Sin llave no se dice nada útil. El `WWW-Authenticate` es lo que le dice a
  // un cliente de MCP que hace falta una credencial, en vez de dejarlo
  // adivinando por qué le cierran la puerta.
  const ahora = Date.now();
  const quien = await quienEs(env.DB, peticion.headers.get("authorization"), ahora);
  if (quien === null) {
    return new Response(JSON.stringify({ error: "falta una llave de MCP válida" }), {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": 'Bearer realm="Baby Caleb MCP"',
      },
    });
  }

  if (peticion.method !== "POST") {
    // GET es para abrir un canal SSE, que este servidor no usa. Se dice con
    // 405 y no con un error de JSON-RPC: todavía no hay mensaje que responder.
    return json({ error: "este servidor solo habla por POST" }, 405);
  }

  let cuerpo: unknown;
  try {
    cuerpo = await peticion.json();
  } catch {
    return json(error(null, ERROR.parse, "el cuerpo no es JSON"), 400);
  }

  // Un lote (array) es válido en JSON-RPC pero ningún cliente de MCP lo usa
  // hoy. Se rechaza claramente en vez de hacer como que se entendió.
  if (Array.isArray(cuerpo)) {
    return json(error(null, ERROR.peticionInvalida, "este servidor no acepta lotes"), 400);
  }

  const m = (cuerpo ?? {}) as Mensaje;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return json(error(m.id ?? null, ERROR.peticionInvalida, "eso no es un mensaje JSON-RPC 2.0"), 400);
  }

  // Una NOTIFICACIÓN no lleva `id` y no se contesta. `notifications/initialized`
  // es la más común: contestarla rompe a los clientes estrictos.
  const esNotificacion = m.id === undefined || m.id === null;

  switch (m.method) {
    case "initialize": {
      const pedida = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      // Se devuelve la del cliente si la sabemos hablar; si no, la nuestra, y
      // es el cliente quien decide si sigue. Eso lo manda el protocolo.
      const version =
        typeof pedida === "string" && (VERSIONES as readonly string[]).includes(pedida)
          ? pedida
          : VERSIONES[0];

      return json(
        resultado(m.id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "babycaleb-sistema", title: "Baby Caleb", version: env.VERSION ?? "dev" },
          instructions:
            "El sistema de Baby Caleb: catálogo, existencias y movimientos. Los precios y las " +
            "cantidades salen de la base, nunca de la memoria. Las clientas se nombran por su " +
            "referencia (C-0042), nunca por su nombre o su teléfono. Lo que cambia dinero, " +
            "precios o existencias necesita que una persona lo permita en el panel.",
        }),
      );
    }

    case "ping":
      return esNotificacion ? new Response(null, { status: 202 }) : json(resultado(m.id, {}));

    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });

    case "tools/list": {
      // Solo las del ROL de quien llama. No es cortesía: una herramienta que
      // no se enseña es una que no se puede pedir por equivocación.
      const definiciones = catalogo().definicionesPara(quien.rol);
      return json(
        resultado(m.id, {
          tools: definiciones.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.input_schema,
          })),
        }),
      );
    }

    case "tools/call": {
      const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return json(error(m.id, ERROR.parametrosInvalidos, "falta el nombre de la herramienta"));
      }

      const registro = catalogo();
      const herramienta = registro.buscar(params.name);

      const hecho = await ejecutar(
        { db: env.DB, usuario: { id: quien.usuarioId, correo: quien.correo, rol: quien.rol }, ahora },
        registro,
        {
          nombre: params.name,
          argumentos: params.arguments ?? {},
          canal: "mcp",
          conversacionId: null,
          conAdjuntos: false,
          textoExterno: herramienta?.textoExterno ?? false,
        },
        TURNO_LIMPIO,
      );

      if (!hecho.ok) {
        // Un fallo de la herramienta va DENTRO del resultado con `isError`, no
        // como error de JSON-RPC: así el modelo del otro lado lo lee y se
        // corrige, en vez de ver un error de transporte que no entiende.
        //
        // La excepción es no encontrarla: eso sí es un error de protocolo,
        // porque el cliente pidió algo que no existe en la lista que le dimos.
        if (hecho.codigo === "no_encontrado") {
          return json(error(m.id, ERROR.metodoDesconocido, hecho.mensaje));
        }
        return json(resultado(m.id, { content: [texto(hecho.mensaje)], isError: true }));
      }

      if (hecho.datos.clase === "por_confirmar") {
        // NO se hizo. Decirlo como éxito haría que un agente siguiera adelante
        // creyendo que ya está.
        return json(
          resultado(m.id, {
            content: [
              texto(
                `No se hizo: esto necesita que una persona lo permita.\n\n${hecho.datos.resumen}\n\n` +
                  `Está esperando en el panel de Baby Caleb, en el chat de Caleb (acción ${hecho.datos.accionId}). ` +
                  `Caduca en 30 minutos.`,
              ),
            ],
            isError: true,
          }),
        );
      }

      // El mismo filtro que protege al modelo del asistente (D-20). Al otro
      // lado de MCP hay otro modelo, de otra empresa, y las clientas siguen
      // sin haber acordado nada.
      const nombres = await nombresDeClientas(env.DB);
      const filtraciones = revisar(hecho.datos.datos, nombres);
      if (filtraciones.length > 0) {
        const clases = [...new Set(filtraciones.map((f) => f.que))];
        console.warn(
          JSON.stringify({ evento: "mcp_dato_de_clienta", herramienta: params.name, que: clases }),
        );
        return json(
          resultado(m.id, {
            content: [
              texto(
                `Ese resultado traía datos de una clienta (${clases.join(", ")}) y no salen por aquí. ` +
                  `Pida la referencia (C-0042) en vez del dato.`,
              ),
            ],
            isError: true,
          }),
        );
      }

      return json(
        resultado(m.id, {
          content: [texto(JSON.stringify(hecho.datos.datos, null, 2))],
          isError: false,
        }),
      );
    }

    default:
      return esNotificacion
        ? new Response(null, { status: 202 })
        : json(error(m.id, ERROR.metodoDesconocido, `este servidor no conoce «${m.method}»`));
  }
}

async function nombresDeClientas(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT nombre, apellido FROM clientes WHERE anonimizado_en IS NULL AND (nombre IS NOT NULL OR apellido IS NOT NULL)",
    )
    .all<{ nombre: string | null; apellido: string | null }>();
  return results
    .flatMap((r) => [r.nombre, r.apellido])
    .filter((n): n is string => typeof n === "string" && n.trim().length >= 3);
}
