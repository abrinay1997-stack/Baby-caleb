import type { Resultado } from "../contrato/resultado";

/**
 * La interfaz común de las pasarelas (04-pagos §4, F4.10).
 *
 * Es la `PaymentProvider` de Nébula con los nombres del plan —`createPayment`,
 * `verifyWebhook`, `refundPayment`— más `consultar`, que el conciliador
 * necesita (04-pagos §6). Solo lleva lo que las tres pasarelas tienen en común;
 * lo propio de cada una (los campos del botón de Yappy, la URL de Tilopay)
 * viaja en `datosBoton` / `redirectUrl`, que es justo lo que ya prevé
 * `IniciarPagoSalida` en el contrato.
 *
 * **Sin D1 y sin `env`.** Un adaptador habla con SU pasarela y nada más: recibe
 * las credenciales ya abiertas (de `abrirCredenciales`, el baúl) y un `fetch`.
 * Qué se escribe en la base con lo que conteste es de `src/db/`. Así el
 * adaptador se prueba con respuestas grabadas, sin red y sin base.
 */

/** Lo que el sistema le pide a una pasarela para cobrar. */
export interface OrdenDeCobro {
  /** NUESTRO número de orden hacia la pasarela (`pagos.intento_ref`). */
  readonly ordenId: string;
  /** Entero, en centavos. El adaptador lo pasa al formato de su pasarela. */
  readonly montoCents: number;
  /** A dónde manda la pasarela el aviso del resultado. */
  readonly urlAviso: string;
}

/** Lo que contesta una pasarela al crear el cobro. */
export type CobroCreado =
  | {
      readonly tipo: "creado";
      /** El id de la pasarela para este cobro (`pagos.proveedor_ref`). */
      readonly referencia: string;
      /** Lo que necesita el componente del navegador. Nunca lleva un secreto. */
      readonly datosBoton?: Readonly<Record<string, string>>;
      readonly redirectUrl?: string;
    }
  | {
      /**
       * La pasarela dice que ESA orden ya la tenía. Es lo que contesta un
       * reintento, y no es un fallo: la orden existe y el aviso de su resultado
       * llegará igual. Lo que no vuelve son los datos del botón.
       */
      readonly tipo: "ya_estaba";
    };

/** El resultado de un pago, como lo dice un aviso ya verificado. */
export interface AvisoVerificado<Estado extends string = string> {
  readonly ordenId: string;
  readonly estado: Estado;
  /** El id del aviso, para no aplicarlo dos veces (`eventos_pasarela`). */
  readonly eventoId: string;
  readonly referencia: string | null;
}

export interface PaymentProvider<Credenciales, Aviso, Estado extends string = string> {
  createPayment(cred: Credenciales, orden: OrdenDeCobro): Promise<Resultado<CobroCreado>>;
  /**
   * Comprueba que el aviso lo mandó la pasarela. Es lo ÚNICO que puede marcar
   * un pago como hecho: ni un evento del navegador ni un parámetro en la URL
   * de vuelta (CLAUDE.md, «el navegador no decide un pago»).
   */
  verifyWebhook(cred: Credenciales, aviso: Aviso): Promise<Resultado<AvisoVerificado<Estado>>>;
  /** Pregunta a la pasarela cómo quedó una orden, para el conciliador. */
  consultar(cred: Credenciales, ordenId: string): Promise<Resultado<{ estado: Estado }>>;
  refundPayment(cred: Credenciales, referencia: string, montoCents: number): Promise<Resultado<never>>;
}

/** El `fetch` que usa un adaptador. Se inyecta para poder probarlo sin red. */
export type Buscador = (url: string, init: RequestInit) => Promise<Response>;
