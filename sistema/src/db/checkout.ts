import { ok, type Resultado } from "../contrato/resultado";
import { type EstadoDelCheckout, type PasarelaParaCobrar, estadoDelCheckout } from "../dominio/checkout";
import { leerVigentes } from "./ajustes";
import { type ContextoDeLectura, estado as estadoDePasarelas } from "./pasarelas";

/**
 * ¿Puede la web cobrar? Leído de la base, decidido por el dominio.
 *
 * Existe para que la respuesta tenga UN dueño. La misma pregunta la hacen tres
 * sitios —la pantalla de Ajustes, la ruta `GET /checkout` y la herramienta
 * `ver_checkout` del asistente— y si cada uno cruzara el interruptor con las
 * pasarelas por su cuenta, acabarían contestando distinto. El que se equivoca
 * del lado flojo es el que nadie revisa.
 *
 * Aquí solo se LEE y se traduce. Quién decide está en
 * `src/dominio/checkout.ts`, que es puro y se puede probar sin base.
 *
 * Esta función es la que hace que `ajustes.checkout_activo` deje de ser un
 * interruptor que nadie consulta: a partir de aquí hay código que lo lee y
 * pantallas que dicen qué está haciendo.
 */
export async function verCheckout(
  ctx: ContextoDeLectura,
): Promise<Resultado<EstadoDelCheckout & { readonly llave_maestra_puesta: boolean | null }>> {
  const ajustes = await leerVigentes({ db: ctx.db, ahora: ctx.ahora });
  if (!ajustes.ok) return ajustes;

  const fila = ajustes.datos.ajustes.find((a) => a.clave === "checkout_activo");
  // `checkout_activo` no admite PENDIENTE (su esquema lo dice), así que
  // siempre hay un booleano: el de la dueña o el de fábrica. Si llegara otra
  // cosa se trata como apagado, que es el lado que no mueve dinero.
  const interruptor = fila !== undefined && !fila.pendiente && fila.valor === true;

  const pasarelas = await estadoDePasarelas(ctx);
  if (!pasarelas.ok) return pasarelas;

  const paraCobrar: PasarelaParaCobrar[] = pasarelas.datos.pasarelas.map((p) => {
    // El juego de credenciales DEL MODO EN QUE ESTÁ. Mirar el otro daría una
    // pasarela «completa» con las credenciales que no va a usar.
    const suModo = p.modos.find((m) => m.esElActual);
    return {
      pasarela: p.pasarela,
      titulo: p.titulo,
      encendida: p.encendida,
      completa: suModo?.completo === true,
      modo: p.modo,
      faltan: suModo?.faltan ?? [],
    };
  });

  return ok({
    ...estadoDelCheckout({ interruptor, pasarelas: paraCobrar }),
    /**
     * Si el Worker puede descifrar las credenciales.
     *
     * Sale como dato aparte y NO como impedimento del dominio porque no es una
     * decisión del negocio: es que al Worker le falta un secreto, y eso se
     * arregla en Cloudflare, no en Ajustes. Además, una credencial no se puede
     * ni guardar sin la llave, así que «completa» ya implica que la llave
     * existía cuando se guardó; lo que esto detecta es una llave perdida o
     * rotada, y de eso informa con más detalle la pantalla de Pasarelas.
     *
     * **`null` significa «no se preguntó», no «no está puesta».** Quien llama
     * sin la llave —el asistente, que no tiene acceso a los secretos del
     * Worker— recibe `null`, y un `false` ahí sería afirmar algo que nadie
     * comprobó (docs/TRAMPAS.md §7: cero no es «no sé»).
     */
    llave_maestra_puesta:
      ctx.llaveMaestra === undefined ? null : pasarelas.datos.llave_maestra_puesta,
  });
}
