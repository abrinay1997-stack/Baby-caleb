/**
 * Turnstile: la comprobación de que al otro lado hay una persona.
 *
 * Protege «Hacer mi pedido» y «Mi cuenta» (docs/plan/07-seguridad.md §4). La
 * verificación es SIEMPRE en el servidor: lo que el navegador manda es un token
 * que solo Cloudflare puede confirmar. Confiar en que el widget se mostró es no
 * tener Turnstile.
 *
 * Falla cerrado, con una excepción documentada abajo.
 */

const URL_VERIFICAR = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOPE_MS = 5_000;

export interface EntornoTurnstile {
  TURNSTILE_SECRETO?: string;
}

export type MotivoTurnstileFallido =
  | "sin configurar"
  | "sin token"
  | "token invalido"
  | "token repetido"
  | "no se pudo verificar";

export type ResultadoTurnstile =
  | { ok: true }
  | { ok: false; motivo: MotivoTurnstileFallido; codigos?: string[] };

export interface DepsTurnstile {
  /** Se inyecta en las pruebas para no salir a la red. */
  verificar?: (cuerpo: FormData) => Promise<unknown>;
}

async function pedirACloudflare(cuerpo: FormData): Promise<unknown> {
  const respuesta = await fetch(URL_VERIFICAR, {
    method: "POST",
    body: cuerpo,
    signal: AbortSignal.timeout(TOPE_MS),
  });
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
  return respuesta.json();
}

/**
 * Comprueba el token.
 *
 * `ip` es opcional y se manda si se tiene (`CF-Connecting-IP`): Cloudflare la
 * usa para afinar, pero el token ya está atado al sitio.
 */
export async function revisarTurnstile(
  token: string | null | undefined,
  env: EntornoTurnstile,
  ip?: string | null,
  deps: DepsTurnstile = {},
): Promise<ResultadoTurnstile> {
  const secreto = (env.TURNSTILE_SECRETO ?? "").trim();
  if (!secreto) {
    // Sin secreto no se puede verificar nada. Se rechaza en vez de dejar pasar:
    // un checkout abierto a los robots cuesta más que un checkout cerrado un
    // rato, y el interruptor `checkout_activo` existe justo para eso.
    console.error(JSON.stringify({ evento: "turnstile_sin_configurar" }));
    return { ok: false, motivo: "sin configurar" };
  }

  const limpio = (token ?? "").trim();
  // El token de Turnstile ronda los 300-2000 caracteres; cualquier cosa fuera
  // de ahí no vale la pena mandarla a verificar.
  if (!limpio || limpio.length > 4_096) return { ok: false, motivo: "sin token" };

  const cuerpo = new FormData();
  cuerpo.set("secret", secreto);
  cuerpo.set("response", limpio);
  if (ip) cuerpo.set("remoteip", ip);

  let crudo: unknown;
  try {
    crudo = await (deps.verificar ?? pedirACloudflare)(cuerpo);
  } catch (error) {
    console.error(
      JSON.stringify({ evento: "turnstile_fallo", error: String(error).slice(0, 200) }),
    );
    return { ok: false, motivo: "no se pudo verificar" };
  }

  const respuesta = crudo as { success?: unknown; "error-codes"?: unknown };
  if (respuesta?.success === true) return { ok: true };

  const codigos = Array.isArray(respuesta?.["error-codes"])
    ? (respuesta["error-codes"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  // Un token ya usado merece su propio motivo: casi siempre es un doble clic,
  // no un ataque, y lo que hay que decirle a la clienta es distinto.
  const motivo: MotivoTurnstileFallido = codigos.includes("timeout-or-duplicate")
    ? "token repetido"
    : "token invalido";

  console.warn(JSON.stringify({ evento: "turnstile_rechazado", motivo, codigos }));
  return { ok: false, motivo, codigos };
}

/** Lo que se le dice a la clienta. Trato de usted, y sin jerga. */
export function mensajeDeTurnstile(r: ResultadoTurnstile): string {
  if (r.ok) return "";
  switch (r.motivo) {
    case "token repetido":
      return "Parece que el pedido se envió dos veces. Recargue la página y vuelva a intentar.";
    case "sin token":
    case "token invalido":
      return "No pudimos comprobar que no sea un robot. Recargue la página y vuelva a intentar.";
    case "sin configurar":
    case "no se pudo verificar":
      return "Tuvimos un problema al validar su pedido. Intente de nuevo en un momento, o escríbanos por WhatsApp.";
  }
}
