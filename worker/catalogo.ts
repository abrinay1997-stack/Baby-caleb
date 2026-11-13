import respaldo from "../src/data/catalogo.respaldo.json";
import type { VarianteParaFicha } from "../src/seo/producto";

/**
 * `/api/catalogo`: el precio y la disponibilidad, desde el sistema (F3.5).
 *
 * Hasta hoy los precios vivían en `content.json`, dentro del paquete del
 * sitio. Eso quería decir que cambiar un precio era editar un archivo,
 * construir y desplegar — y que mientras tanto la web decía una cosa y el bot
 * otra. Ahora hay un solo dueño del dato: la D1 del sistema.
 *
 * Tres capas, en este orden:
 *
 *  1. **La caché del borde, 60 segundos.** Un precio recién cambiado tarda
 *     como mucho un minuto en verse. A cambio, mil visitas en ese minuto son
 *     UNA consulta a la base.
 *  2. **El sistema**, por el service binding. No sale a internet: es una
 *     llamada dentro de la cuenta, sin token y sin red pública.
 *  3. **La copia de respaldo del build**, si el sistema no contesta. La web
 *     sigue enseñando el catálogo y el sitio no se cae por una base caída
 *     (08-operacion.md §Qué hacer cuando). La respuesta dice `desdeRespaldo`
 *     para que la pantalla pueda avisar de que confirma con una persona.
 *
 * Lo que NUNCA sale por aquí es lo mismo que no sale por el RPC: el costo y la
 * cantidad exacta. Eso lo decide `SistemaWeb`, no esta función, y así hay un
 * solo sitio donde equivocarse.
 *
 * Lo que SÍ sale desde hoy, además del precio: la FOTO de cada artículo, la que
 * la dueña sube desde su panel, como ruta relativa (`/foto/<clave>`) que sirve
 * `worker/imagenes.ts` en este mismo dominio. Pasa por aquí sin tocarse —esta
 * función no mira los campos, los reenvía— y qué forma puede tener lo decide
 * `fotoPublica` del lado del sistema, por el mismo motivo que el costo: un
 * filtro repetido en dos sitios acaba discrepando.
 */

/** 60 s: el compromiso entre «el precio nuevo ya se ve» y «no una consulta por visita». */
const SEGUNDOS = 60;

export interface SistemaWebBinding {
  catalogo(): Promise<
    | {
        ok: true;
        datos: {
          version: number;
          generadoEn: number;
          variantes: unknown[];
          /**
           * El celular al que van los pedidos por WhatsApp, del ajuste
           * `whatsapp_numero`. `null` = no hay ninguno y el botón no sale.
           *
           * Pasa tal cual al navegador: es el celular del NEGOCIO, el mismo
           * que ya está en `content.json` y en el botón de la barra de
           * navegación. Nada de ninguna clienta sale por aquí.
           */
          whatsapp?: { numero: string | null };
        };
      }
    | { ok: false; codigo: string; mensaje: string }
  >;
  /**
   * Una imagen del catálogo. `datos: null` significa «no existe o no se sirve
   * en abierto» — y son el mismo caso a propósito: distinguirlos le contaría a
   * quien prueba claves al azar cuáles existen.
   */
  archivo(
    clave: string,
  ): Promise<
    | { ok: true; datos: { bytes: ArrayBuffer; mime: string } | null }
    | { ok: false; codigo: string; mensaje: string }
  >;
  /**
   * ¿Contesta el sistema, y está sano?
   *
   * Estaba en el entrypoint de allá desde el principio y aquí no se declaraba,
   * así que `/api/salud` de la web no podía llamarlo ni aunque quisiera — y de
   * hecho no lo llamaba: miraba si el binding existía. El binding existe
   * siempre, está escrito en `wrangler.jsonc`, así que esa comprobación no
   * podía ser falsa y decía «del sistema» con la base caída.
   *
   * No lleva datos del negocio: una señal y la versión desplegada.
   */
  salud(): Promise<
    | { ok: true; datos: { sano: boolean; version: string } }
    | { ok: false; codigo: string; mensaje: string }
  >;
}

function respuesta(cuerpo: unknown, desdeRespaldo: boolean): Response {
  return new Response(JSON.stringify({ ...(cuerpo as object), desdeRespaldo }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // `s-maxage` es para el borde; `max-age` para el navegador. El navegador
      // guarda menos porque una pestaña abierta toda la tarde no debería
      // quedarse con el precio de la mañana.
      "cache-control": `public, max-age=30, s-maxage=${SEGUNDOS}`,
      // Que se note de un vistazo en las herramientas del navegador si lo que
      // se está viendo salió del sistema o de la copia de emergencia.
      "x-catalogo-origen": desdeRespaldo ? "respaldo" : "sistema",
    },
  });
}

/**
 * La llave de la caché, SIEMPRE la misma.
 *
 * El catálogo lo piden dos sitios: `/api/catalogo` y el reescritor del `<head>`
 * cuando sirve una ficha de producto. Si cada uno guardara con la URL de SU
 * petición, cada ficha sería una consulta aparte y la caché no serviría para
 * nada justo donde más visitas hay. Con una llave fija, los dos comparten la
 * misma entrada y un minuto de tráfico sigue siendo UNA consulta.
 */
const llave = (peticion: Request) => new Request(new URL("/api/catalogo", peticion.url));

export async function catalogo(peticion: Request, sistema?: SistemaWebBinding): Promise<Response> {
  const cache = caches.default;
  const guardada = await cache.match(llave(peticion));
  if (guardada) return guardada;

  let salida: Response;

  if (sistema === undefined) {
    // Sin binding no hay sistema al que preguntar. Pasa en las vistas previas
    // y pasaría si alguien despliega la web sin el binding puesto: la web
    // tiene que seguir en pie, y decir de dónde salió lo que enseña.
    salida = respuesta(respaldo, true);
  } else {
    try {
      const r = await sistema.catalogo();
      salida = r.ok ? respuesta(r.datos, false) : respuesta(respaldo, true);
      if (!r.ok) {
        console.warn(JSON.stringify({ evento: "catalogo_sistema_fallo", codigo: r.codigo }));
      }
    } catch (error) {
      console.warn(
        JSON.stringify({ evento: "catalogo_sistema_caido", error: String(error) }),
      );
      salida = respuesta(respaldo, true);
    }
  }

  // La copia de respaldo NO se guarda en la caché del borde: si se guardara,
  // un minuto de base caída dejaría a la web enseñando el respaldo durante ese
  // minuto aunque el sistema volviera al segundo siguiente.
  if (salida.headers.get("x-catalogo-origen") === "sistema") {
    await cache.put(llave(peticion), salida.clone());
  }

  return salida;
}

/**
 * Las variantes, para quien no quiere una respuesta HTTP sino los datos.
 *
 * Lo usa el reescritor del `<head>` para armar la ficha de un producto. Pasa
 * por `catalogo()` a propósito y no por el binding directo: así comparte la
 * caché del borde, el repliegue a la copia del build y la decisión de no
 * guardar esa copia. Un segundo camino hacia los mismos datos es un segundo
 * sitio donde las reglas se olvidan.
 */
export async function variantesDelCatalogo(
  peticion: Request,
  sistema?: SistemaWebBinding,
): Promise<VarianteParaFicha[]> {
  const r = await catalogo(peticion, sistema);
  const d = (await r.json()) as { variantes?: VarianteParaFicha[] };
  return d.variantes ?? [];
}
