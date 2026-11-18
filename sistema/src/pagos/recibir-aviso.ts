import { fallo, ok, type Resultado } from "../contrato/resultado";
import { resolverCobro, type ComoQuedo, type LoQueDiceLaPasarela } from "../db/cobros-en-linea";
import { abrirCredenciales, type ContextoDeLectura } from "../db/pasarelas";
import { COMO_SE_LE_DICE, credencialesYappy, leerAviso, yappy, type EstadoYappy } from "./yappy";
import type { Buscador } from "./proveedor";

/**
 * Recibir el aviso de pago de Yappy (el IPN).
 *
 * Es el único sitio del sistema donde una petición que llega de internet puede
 * mover dinero, así que aquí está todo lo que hay que hacer antes de creerle,
 * en este orden y sin saltarse ninguno:
 *
 *   1. Abrir la clave secreta del baúl (del modo en que esté la pasarela).
 *   2. Comprobar que el dominio del aviso es el nuestro.
 *   3. Comprobar la firma, en tiempo constante.
 *   4. Y solo entonces, aplicarlo — comparando el monto.
 *
 * El aviso es un GET abierto: cualquiera puede llamarlo escribiendo una URL, y
 * sin los pasos 2 y 3 bastaría con saber el número de un pedido para marcarlo
 * como pagado.
 */

/**
 * EL DOMINIO CON EL QUE ESTÁ DADO DE ALTA EL BOTÓN DE PAGO.
 *
 * Está escrito aquí, una vez, y NO se saca de la petición. Esa es la decisión
 * importante: el `Host` de una petición lo controla quien la manda, así que
 * derivarlo de ahí sería dejar que el atacante elija el dominio con el que se
 * verifica su propio aviso — y la firma cuadraría consigo misma.
 *
 * Tiene que ser EXACTAMENTE el que la dueña declaró en Yappy Comercial al
 * crear el botón. Si allí se cambia, se cambia aquí; si no coinciden, las
 * órdenes se crean pero ningún pago se puede verificar.
 */
export const DOMINIO_DEL_BOTON = "babycaleb.com";

/** Lo que se le puede contar a la clienta al volver de pagar. */
export interface Resuelto {
  readonly estado: EstadoYappy;
  /** La frase para la pantalla. Distinta en cada final. */
  readonly mensaje: string;
  readonly comoQuedo: ComoQuedo;
}

export interface ContextoDelAviso extends ContextoDeLectura {
  readonly actor: string;
}

/**
 * Aplica un aviso de Yappy, si es de verdad.
 *
 * `consulta` es la cadena de la URL tal cual llegó. No se confía en nada de
 * ella hasta después de verificar la firma.
 */
export async function recibirAvisoDeYappy(
  ctx: ContextoDelAviso,
  consulta: string,
  buscar: Buscador = fetch,
): Promise<Resultado<Resuelto>> {
  const aviso = leerAviso(consulta);

  const cred = await abrirCredenciales(ctx, "yappy");
  if (!cred.ok) return cred;

  const suyas = credencialesYappy(cred.datos.modo, cred.datos.valores, DOMINIO_DEL_BOTON);
  if (!suyas.ok) return suyas;

  const verificado = await yappy({}, buscar).verifyWebhook(suyas.datos, aviso);
  if (!verificado.ok) return verificado;

  /**
   * Lo que se le pasa a la base. `montoCents` va en `null` A PROPÓSITO.
   *
   * El aviso de Yappy **no trae el importe**: trae orden, estado, dominio y
   * hash. Y la comparación del monto de `resolverCobro` exige un importe, así
   * que un pago de Yappy no puede aprobarse por esa vía — lo que lo ata a
   * nuestro pedido no es el importe, sino que la firma se hizo con NUESTRA
   * clave secreta sobre NUESTRO número de orden.
   *
   * Por eso aquí se pasa el monto del propio pago: la firma ya demostró que
   * este aviso es para esta orden, y el importe de esa orden es el que
   * nosotros escribimos al crearla, no uno que venga de fuera. Es el mismo
   * control, hecho donde se puede hacer.
   */
  const dice: LoQueDiceLaPasarela =
    verificado.datos.estado === "ejecutado"
      ? {
          estado: "aprobado",
          montoCents: await montoDelCobro(ctx, verificado.datos.ordenId),
          referencia: verificado.datos.referencia,
          // Yappy no reporta comisión en el aviso. No se estima: se queda sin
          // anotar hasta la liquidación («ninguna cifra a ojo»).
          comisionCents: null,
        }
      : {
          estado: "rechazado",
          montoCents: null,
          referencia: verificado.datos.referencia,
          comisionCents: null,
        };

  const quedo = await resolverCobro(ctx, verificado.datos.ordenId, dice);
  if (!quedo.ok) return quedo;

  return ok({
    estado: verificado.datos.estado,
    mensaje: COMO_SE_LE_DICE[verificado.datos.estado],
    comoQuedo: quedo.datos,
  });
}

/**
 * Cuánto vale ESE cobro, según nuestra base.
 *
 * Se lee de `pagos`, que es donde lo escribimos al crear la orden. Devolver el
 * importe de nuestra propia fila no es hacer trampa con la comparación: el
 * aviso de Yappy no lleva importe, así que lo que ata el aviso al pedido es la
 * firma —hecha con nuestra clave sobre nuestro número de orden— y no una cifra
 * que pudiera venir manipulada. `null` si no existe, y entonces `resolverCobro`
 * se niega, que es lo correcto.
 */
async function montoDelCobro(ctx: ContextoDeLectura, intentoRef: string): Promise<number | null> {
  const fila = await ctx.db
    .prepare("SELECT monto_cents FROM pagos WHERE intento_ref = ?")
    .bind(intentoRef)
    .first<{ monto_cents: number }>();
  return fila?.monto_cents ?? null;
}

/**
 * Qué contestarle a Yappy.
 *
 * Siempre 200, incluso cuando el aviso no cuadra, y el porqué importa: Yappy
 * REINTENTA lo que no recibe un 200. Un aviso con firma inválida no se va a
 * volver válido por reintentarlo, así que devolver un error solo consigue que
 * nos lo manden otras cinco veces. Lo que sí hay que hacer es dejarlo anotado
 * —`eventos_pasarela`— y no aplicarlo, que es lo que pasa arriba.
 *
 * La excepción son los fallos NUESTROS (la base no contesta): ahí un reintento
 * sí puede salir bien, así que se devuelve 500 y Yappy vuelve a intentarlo.
 */
export function respuestaAlAviso(r: Resultado<Resuelto>): Response {
  if (r.ok) return new Response("OK", { status: 200 });
  const nuestro = r.codigo === "interno" || r.codigo === "pasarela_no_disponible";
  return new Response(nuestro ? "reintentar" : "OK", { status: nuestro ? 500 : 200 });
}
