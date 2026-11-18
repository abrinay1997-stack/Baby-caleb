/**
 * El aviso de pago de Yappy, que entra POR AQUÍ.
 *
 * Tiene que entrar por la web y no por el sistema, y el motivo es de
 * infraestructura, no de gusto: el Worker del sistema está entero detrás de
 * Cloudflare Access, que contesta un 302 de login **antes de que el Worker
 * corra**. Yappy recibiría ese 302, no entendería nada, y el pago de la
 * clienta no se aplicaría nunca. La web sí es pública.
 *
 * Aquí NO se decide nada sobre el pago. Esto enruta: coge la cadena de
 * consulta tal cual y se la pasa al sistema por el service binding —que no
 * sale a internet—. Quien abre la clave secreta del baúl, comprueba el
 * dominio, verifica la firma en tiempo constante y aplica el cobro es
 * `recibirAvisoDeYappy`, del lado del sistema, que es donde están los datos.
 *
 * Esa separación importa: si la verificación viviera aquí, la clave secreta
 * tendría que viajar al Worker de la web, que es el que está expuesto a
 * internet. Así no sale del sistema.
 */

/** Lo que esta ruta necesita del sistema, y nada más. */
export interface SistemaDelAviso {
  avisoDeYappy?(consulta: string): Promise<
    | { ok: true; datos: { estado: string; mensaje: string } }
    | { ok: false; codigo: string; mensaje: string }
  >;
}

/**
 * SIEMPRE 200, SALVO CUANDO EL FALLO ES NUESTRO.
 *
 * Yappy reintenta lo que no recibe un 200. Un aviso con firma inválida no se
 * vuelve válido por reintentarlo: contestar un error solo consigue que lo
 * manden otras cinco veces y que la bitácora se llene de lo mismo. Pero si la
 * que falló fue nuestra base o el binding, un reintento SÍ puede salir bien, y
 * ahí el 500 es lo correcto — es la diferencia entre «esto no era válido» y
 * «no pude mirarlo».
 */
const NUESTROS = new Set(["interno", "pasarela_no_disponible"]);

export async function avisoDeYappy(
  peticion: Request,
  sistema: SistemaDelAviso | undefined,
): Promise<Response> {
  const url = new URL(peticion.url);

  /**
   * Es un GET. Su documentación lo dice y se comprueba: aceptar un POST aquí
   * sería abrir una puerta más de las que Yappy usa, y una puerta que nadie
   * usa es una que nadie mira.
   */
  if (peticion.method !== "GET") {
    return new Response("solo GET", { status: 405, headers: { allow: "GET" } });
  }

  /**
   * Sin sistema al otro lado, 500 y no 200.
   *
   * Un 200 aquí le diría a Yappy «recibido y aplicado» sobre un pago que no se
   * miró siquiera: el cobro se perdería en silencio y la clienta tendría el
   * dinero fuera y el pedido sin pagar. El 500 hace que Yappy vuelva a
   * intentarlo, que es justo lo que hace falta mientras el sistema se recupera.
   */
  if (sistema?.avisoDeYappy === undefined) {
    return new Response("reintentar", { status: 500 });
  }

  let r: Awaited<ReturnType<NonNullable<SistemaDelAviso["avisoDeYappy"]>>>;
  try {
    r = await sistema.avisoDeYappy(url.search);
  } catch {
    // El binding no contestó. Es nuestro: que Yappy lo reintente.
    return new Response("reintentar", { status: 500 });
  }

  if (r.ok) return new Response("OK", { status: 200 });
  return NUESTROS.has(r.codigo)
    ? new Response("reintentar", { status: 500 })
    : new Response("OK", { status: 200 });
}
