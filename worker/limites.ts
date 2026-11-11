/**
 * Los topes del chat de la web.
 *
 * El chat está abierto a internet sin cuenta ni contraseña: cualquiera puede
 * escribirle, y cada mensaje que pasa de aquí cuesta dinero en el proveedor
 * del modelo. Sin topes, un script mete un mensaje de un megabyte mil veces y
 * la factura la paga el negocio. Eso no es una hipótesis: es lo primero que
 * encuentra un rastreador cuando un formulario queda abierto.
 *
 * Esto NO defiende contra inyecciones de SQL, y conviene decirlo porque suena
 * a que debería: el chat no escribe ninguna consulta. Lo que la clienta teclea
 * llega al modelo como texto y vuelve como texto; los precios y las
 * existencias salen del sistema por su propio camino, con consultas
 * preparadas. El riesgo real aquí es otro y son tres:
 *
 *   1. **Gasto.** Alguien dispara el chat en bucle.
 *   2. **Inyección de PROMPT.** Un mensaje que dice «olvida tus
 *      instrucciones» para sacarle al bot algo que no debe decir.
 *   3. **Promesas falsas.** El modelo inventa un precio, un plazo o una
 *      existencia que nadie puede cumplir.
 *
 * Este archivo cubre el primero. El segundo y el tercero viven en el prompt y
 * en que los precios vengan del sistema, no del texto.
 */

export const TOPES = {
  /** Mensajes de historial que se aceptan. La pantalla manda muchos menos. */
  mensajes: 20,
  /** Caracteres por mensaje. Una pregunta de verdad no pasa de 300. */
  porMensaje: 1_000,
  /** Caracteres de toda la conversación junta. */
  total: 6_000,
} as const;

export interface MensajeLimpio {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export type Veredicto =
  | { readonly ok: true; readonly mensajes: readonly MensajeLimpio[] }
  | { readonly ok: false; readonly motivo: string; readonly estado: 400 | 413 };

/**
 * Revisa y limpia lo que llegó por el cable.
 *
 * Devuelve los mensajes ya normalizados —solo `user` y `assistant`, solo
 * texto— para que quien llame no tenga que volver a mirarlos. Un papel, una
 * función: si la revisión y la limpieza vivieran separadas, se podría usar la
 * segunda sin la primera.
 */
export function revisarConversacion(crudo: unknown): Veredicto {
  if (!Array.isArray(crudo)) {
    return { ok: false, motivo: "Falta la conversación.", estado: 400 };
  }
  if (crudo.length === 0) {
    return { ok: false, motivo: "No hay ningún mensaje.", estado: 400 };
  }
  if (crudo.length > TOPES.mensajes) {
    return {
      ok: false,
      motivo: `La conversación es muy larga. Empiece una nueva.`,
      estado: 413,
    };
  }

  const mensajes: MensajeLimpio[] = [];
  let total = 0;

  for (const m of crudo as unknown[]) {
    if (typeof m !== "object" || m === null) {
      return { ok: false, motivo: "Hay un mensaje con una forma rara.", estado: 400 };
    }
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof content !== "string") {
      return { ok: false, motivo: "Hay un mensaje sin texto.", estado: 400 };
    }
    // Los caracteres de control no aportan nada a una pregunta y sí sirven
    // para esconder instrucciones de los ojos de quien lee la conversación.
    // Se quitan en vez de rechazar: un copiar y pegar los trae sin querer.
    const limpio = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

    if (limpio === "") continue;
    if (limpio.length > TOPES.porMensaje) {
      return {
        ok: false,
        motivo: "Ese mensaje es muy largo. Resúmalo o escríbanos por WhatsApp.",
        estado: 413,
      };
    }
    total += limpio.length;
    if (total > TOPES.total) {
      return {
        ok: false,
        motivo: "La conversación es muy larga. Empiece una nueva.",
        estado: 413,
      };
    }

    mensajes.push({ role: role === "assistant" ? "assistant" : "user", content: limpio });
  }

  if (mensajes.length === 0) {
    return { ok: false, motivo: "No hay ningún mensaje con texto.", estado: 400 };
  }
  // El último tiene que ser de la clienta: si no, no hay nada que contestar y
  // lo que llegó es un historial suelto, no una pregunta.
  if (mensajes[mensajes.length - 1]?.role !== "user") {
    return { ok: false, motivo: "El último mensaje no es una pregunta.", estado: 400 };
  }

  return { ok: true, mensajes };
}

/**
 * Quién está escribiendo, para contarle las llamadas.
 *
 * `CF-Connecting-IP` la pone Cloudflare en el borde y no se puede falsificar
 * desde fuera: una cabecera que mande el navegador se ignora. Sin ella —solo
 * pasa en pruebas locales— se devuelve una llave fija, y entonces el límite se
 * aplica a todos juntos, que falla del lado seguro.
 */
export const quienLlama = (peticion: Request): string =>
  peticion.headers.get("CF-Connecting-IP") ?? "sin-ip";
