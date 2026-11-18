import { quienLlama } from "./limites";

/**
 * Arrancar un pago de Yappy desde el carrito.
 *
 * Esta ruta es pública y **crea pedidos, que apartan inventario**. Esa frase es
 * todo lo que hay que tener en la cabeza para entender por qué está escrita
 * así.
 *
 * Igual que la ruta del aviso, aquí no se decide nada: se enruta. El pedido se
 * crea, los precios se calculan y el cobro se arranca del lado del sistema,
 * que es donde están los datos y la clave secreta de Yappy. Si esto viviera en
 * la web, la clave tendría que viajar al Worker que está expuesto a internet.
 */

/** Lo que esta ruta necesita del sistema. */
export interface SistemaDelCobro {
  cobrarCarrito?(carrito: unknown): Promise<
    | { ok: true; datos: unknown }
    | { ok: false; codigo: string; mensaje: string }
  >;
}

/** El límite por IP, con la misma forma que el del chat. */
export interface LimitePorIp {
  limit(opciones: { key: string }): Promise<{ success: boolean }>;
}

/**
 * EL TOPE DEL CUERPO.
 *
 * Un carrito son unas pocas líneas de texto. Sin tope, alguien manda diez
 * megas y el Worker los parsea antes de poder negarse — gratis para quien lo
 * manda y caro para nosotros. 16 KB sobra para cuarenta artículos.
 */
const TOPE_BYTES = 16 * 1024;

const json = (cuerpo: unknown, status: number): Response =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function iniciarPagoYappy(
  peticion: Request,
  sistema: SistemaDelCobro | undefined,
  limite: LimitePorIp | undefined,
): Promise<Response> {
  if (peticion.method !== "POST") {
    return new Response("solo POST", { status: 405, headers: { allow: "POST" } });
  }

  /**
   * EL LÍMITE VA ANTES DE TODO, Y NO ES OPCIONAL EN PRODUCCIÓN.
   *
   * Crear un pedido aparta cajas de la bodega. Sin límite, un guion puede
   * crear mil pedidos en un minuto y dejar el inventario reservado entero sin
   * pagar un centavo: la tienda diría «agotado» a las clientas de verdad.
   *
   * Las reservas vencen solas y el cron las suelta, así que el daño dura un
   * rato y no para siempre — pero «un rato» en una tienda que vende por
   * WhatsApp es una mañana de ventas perdidas.
   *
   * Si el binding no está, se sigue adelante y se dice en `/api/salud`: una
   * tienda que no puede cobrar es peor que una tienda sin límite, y el
   * despliegue tiene que poder arrancar antes de que exista el binding.
   */
  if (limite !== undefined) {
    const { success } = await limite.limit({ key: quienLlama(peticion) });
    if (!success) {
      return json(
        {
          ok: false,
          codigo: "limite",
          mensaje:
            "Estás intentando pagar muchas veces seguidas. Espera un momento y vuelve a intentarlo.",
        },
        429,
      );
    }
  }

  const largo = Number(peticion.headers.get("content-length") ?? "0");
  if (Number.isFinite(largo) && largo > TOPE_BYTES) {
    return json({ ok: false, codigo: "entrada_invalida", mensaje: "El carrito es demasiado grande." }, 413);
  }

  let carrito: unknown;
  try {
    const texto = await peticion.text();
    if (texto.length > TOPE_BYTES) {
      return json({ ok: false, codigo: "entrada_invalida", mensaje: "El carrito es demasiado grande." }, 413);
    }
    carrito = JSON.parse(texto);
  } catch {
    return json({ ok: false, codigo: "entrada_invalida", mensaje: "No se entendió el carrito." }, 400);
  }

  if (sistema?.cobrarCarrito === undefined) {
    /**
     * Sin sistema al otro lado no se puede cobrar, y se dice con palabras que
     * sirvan: la clienta no tiene que saber qué es un binding, pero sí que su
     * pedido NO se hizo y que puede escribir por WhatsApp.
     */
    return json(
      {
        ok: false,
        codigo: "pasarela_no_disponible",
        mensaje:
          "Ahora mismo no podemos procesar el pago. Tu pedido no se creó. Escríbenos por WhatsApp y lo hacemos contigo.",
      },
      503,
    );
  }

  let r: Awaited<ReturnType<NonNullable<SistemaDelCobro["cobrarCarrito"]>>>;
  try {
    r = await sistema.cobrarCarrito(carrito);
  } catch {
    return json(
      {
        ok: false,
        codigo: "interno",
        mensaje:
          "Algo falló al crear tu pedido. Si te cobraron, escríbenos por WhatsApp con tu número de teléfono y lo revisamos.",
      },
      500,
    );
  }

  /**
   * El mensaje del sistema pasa TAL CUAL.
   *
   * Están escritos para que los lea una clienta —«ese pedido ya está pagado»,
   * «no hay suficientes cajas de NAT-M»— y reescribirlos aquí sería tener dos
   * versiones del mismo texto, que es como acaban discrepando.
   *
   * El código HTTP sí se traduce, porque el navegador lo usa: 409 para lo que
   * depende del estado de las cosas (sin stock, pedido ya pagado) y 400 para
   * lo que depende de lo que se mandó.
   */
  if (!r.ok) {
    const porEstado = new Set([
      "sin_stock",
      "transicion_invalida",
      "monto_no_coincide",
      "repetido",
      "conflicto_version",
    ]);
    const status = r.codigo === "pasarela_no_disponible" ? 503 : porEstado.has(r.codigo) ? 409 : 400;
    return json({ ok: false, codigo: r.codigo, mensaje: r.mensaje }, status);
  }

  return json({ ok: true, datos: r.datos }, 200);
}
