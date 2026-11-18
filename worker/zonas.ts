/**
 * `/api/zonas`: el tarifario de envío, para el desplegable del paso de pago.
 *
 * ## Por qué nace aparte y no dentro del catálogo
 *
 * El dato ya estaba publicado: `SistemaWeb.zonasEnvio()` existe desde F3.2 y el
 * binding está puesto en `wrangler.jsonc`. Lo que faltaba era la puerta — el
 * Worker no enrutaba `/api/zonas`, así que el navegador pedía y caía en el 404
 * genérico. Una pieza terminada que nadie llama es la trampa §13 del
 * repositorio, y se vio al construir la pantalla de pago: el desplegable de
 * zonas salía siempre vacío y nada fallaba en ninguna parte.
 *
 * ## Si el sistema no contesta, NO hay respaldo
 *
 * El catálogo sí tiene copia de respaldo en el paquete del sitio, porque una
 * tienda sin precios no es una tienda. El tarifario de envío no la tiene, y es
 * a propósito: escribirlo aquí a mano le daría un SEGUNDO DUEÑO al precio del
 * envío, que es exactamente lo que el repositorio no permite («un dato, un solo
 * dueño»). El día que las dos copias discrepen, la clienta tendría razón en
 * quejarse y nosotros dos números que defender.
 *
 * Así que sin sistema se contesta 503 y la pantalla de pago sigue SIN zona: el
 * contrato del inicio de pago la declara opcional, el envío lo cotiza el
 * servidor al crear el pedido y vuelve en `envioCents`. Se puede pagar igual.
 *
 * ## Lo que sale y lo que no
 *
 * Sale lo que `zonasPublicas` decide del lado del sistema, sin tocarlo: esta
 * función no mira los campos, los reenvía. Quién decide qué es público es el
 * sistema y un solo sitio, por el mismo motivo que el costo del catálogo.
 */

/** Lo justo que esta ruta necesita del binding. */
export interface SistemaWebZonas {
  zonasEnvio?(): Promise<
    { ok: true; datos: unknown[] } | { ok: false; codigo: string; mensaje: string }
  >;
}

/**
 * Cinco minutos. Las zonas cambian cuando la dueña toca el tarifario, que son
 * unas pocas veces al año; el catálogo se cachea 60 s porque ahí cambia el
 * precio y la existencia. Lo que se gana es que una clienta que vuelve atrás y
 * entra otra vez al pago no vuelva a consultar la base.
 */
const SEGUNDOS = 300;

export async function zonas(
  peticion: Request,
  sistema: SistemaWebZonas | undefined,
): Promise<Response> {
  if (peticion.method !== "GET" && peticion.method !== "HEAD") {
    return respuesta(405, { ok: false, mensaje: "esta ruta solo se lee" }, 0);
  }

  if (sistema?.zonasEnvio === undefined) {
    return respuesta(503, { ok: false, mensaje: "el sistema no está disponible" }, 0);
  }

  try {
    const r = await sistema.zonasEnvio();
    if (!r.ok) return respuesta(503, { ok: false, mensaje: r.mensaje }, 0);
    return respuesta(200, { zonas: r.datos }, SEGUNDOS);
  } catch {
    // Un binding caído lanza. No se devuelve una lista vacía: cero zonas y
    // «no pude preguntar» son cosas distintas, y la pantalla las dice distinto
    // (`docs/TRAMPAS.md` §7).
    return respuesta(503, { ok: false, mensaje: "el sistema no contestó" }, 0);
  }
}

const respuesta = (estado: number, cuerpo: unknown, segundos: number): Response =>
  new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": segundos === 0 ? "no-store" : `public, max-age=${segundos}`,
    },
  });
