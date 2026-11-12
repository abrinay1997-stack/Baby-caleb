/**
 * Máquina de estados de un pedido.
 *
 * Portado de `packages/domain/src/order-state.ts` de Nébula, con los estados de
 * Baby Caleb (docs/plan/02-datos.md §6) y un cambio de criterio contable
 * importante, explicado abajo en `cuentaComoVenta`.
 *
 * Sin esto, cualquier pantalla permite cualquier transición: pasar un pedido
 * «entregado» de vuelta a «por abonar», o resucitar uno cancelado. A escala eso
 * corrompe los reportes y deja pedidos en estados que ningún proceso sabe
 * resolver. Las transiciones válidas se declaran aquí una sola vez.
 */

export const ESTADOS_PEDIDO = [
  // Una cotización es este mismo documento antes de apartar nada. Va primera
  // porque es la primera del recorrido: confirmarla es pasar a `por_abonar`,
  // que es donde el inventario se aparta. Ver `esCotizacion` más abajo.
  "cotizacion",
  "por_abonar",
  "agendado",
  "en_ruta",
  "entregado",
  "cancelado",
  "devuelto",
] as const;

export type EstadoPedido = (typeof ESTADOS_PEDIDO)[number];

export const ESTADOS_PAGO = [
  "sin_pago",
  "abonado",
  "pagado",
  "reembolso_parcial",
  "reembolsado",
] as const;

export type EstadoPago = (typeof ESTADOS_PAGO)[number];

export const esEstadoPedido = (v: string): v is EstadoPedido =>
  (ESTADOS_PEDIDO as readonly string[]).includes(v);

export const esEstadoPago = (v: string): v is EstadoPago =>
  (ESTADOS_PAGO as readonly string[]).includes(v);

/** Lo que se lee en pantalla. El trato es de usted, siempre. */
export const ETIQUETAS_PEDIDO: Record<EstadoPedido, string> = {
  cotizacion: "Cotización",
  por_abonar: "Esperando su abono",
  agendado: "Agendado",
  en_ruta: "Va en camino",
  entregado: "Entregado",
  cancelado: "Cancelado",
  devuelto: "Devuelto",
};

export const ETIQUETAS_PAGO: Record<EstadoPago, string> = {
  sin_pago: "Sin pago",
  abonado: "Abonado",
  pagado: "Pagado",
  reembolso_parcial: "Reembolso parcial",
  reembolsado: "Reembolsado",
};

const TRANSICIONES_PEDIDO: Record<EstadoPedido, readonly EstadoPedido[]> = {
  // Confirmar una cotización es ESTA transición, y es la única puerta por la
  // que el inventario se aparta. De ahí que no haya ningún atajo a `agendado`:
  // un documento que no ha apartado nada no puede entrar en la lista de
  // entregas, por mucho que esté pagado.
  //
  // Y se cancela sin tocar los libros, porque no hubo venta: una cotización
  // que caduca o que la clienta descarta no deja ni un asiento ni una reserva
  // que devolver.
  cotizacion: ["por_abonar", "cancelado"],
  por_abonar: ["agendado", "cancelado"],
  agendado: ["en_ruta", "cancelado"],
  // De «en_ruta» se vuelve a «agendado» cuando la entrega falla y se
  // reprograma. No se cancela desde la calle: el paquete ya salió.
  en_ruta: ["entregado", "agendado"],
  // Terminal salvo una devolución aceptada.
  entregado: ["devuelto"],
  cancelado: [],
  devuelto: [],
};

/**
 * `estado_pago` se DERIVA de `pagado_cents` con `estadoDePagoSegunSaldo`: esta
 * tabla no decide el estado, lo vigila. Permite bajar de nivel porque un pago
 * mal registrado no se borra —los libros no se editan— sino que se corrige con
 * un movimiento contrario, y entonces el saldo baja y el estado se recalcula.
 * Lo que no permite es volver de «reembolsado»: si entra dinero otra vez, es un
 * pago nuevo.
 */
const TRANSICIONES_PAGO: Record<EstadoPago, readonly EstadoPago[]> = {
  sin_pago: ["abonado", "pagado"],
  abonado: ["sin_pago", "pagado", "reembolso_parcial", "reembolsado"],
  pagado: ["abonado", "reembolso_parcial", "reembolsado"],
  reembolso_parcial: ["reembolsado"],
  reembolsado: [],
};

export function puedeCambiarPedido(de: EstadoPedido, a: EstadoPedido): boolean {
  if (de === a) return true;
  return TRANSICIONES_PEDIDO[de].includes(a);
}

export function puedeCambiarPago(de: EstadoPago, a: EstadoPago): boolean {
  if (de === a) return true;
  return TRANSICIONES_PAGO[de].includes(a);
}

export function transicionesPedido(de: EstadoPedido): readonly EstadoPedido[] {
  return TRANSICIONES_PEDIDO[de];
}

export function transicionesPago(de: EstadoPago): readonly EstadoPago[] {
  return TRANSICIONES_PAGO[de];
}

export function esTerminalPedido(estado: EstadoPedido): boolean {
  return TRANSICIONES_PEDIDO[estado].length === 0;
}

/**
 * ¿Este documento todavía no ha apartado nada?
 *
 * Es la pregunta que de verdad distingue una cotización de un pedido, y por eso
 * se escribe así y no `estado === "cotizacion"` repartido por diez archivos.
 * Quien la lee necesita saber una sola cosa: si tocar este documento mueve
 * `existencias.reservado` o no.
 *
 * Lo que de aquí se sigue, y está probado en `estado-pedido.test.ts`:
 *
 *  - crearla NO resta nada de lo libre;
 *  - cancelarla o dejarla caducar no devuelve nada, porque no se quitó nada;
 *  - confirmarla —la transición a `por_abonar`— es el único momento en que se
 *    aparta, y es también el único que puede fallar por falta de existencias.
 */
export function esCotizacion(estado: EstadoPedido): boolean {
  return estado === "cotizacion";
}

/**
 * ¿Este documento aparta inventario mientras está en este estado?
 *
 * El complemento de `esCotizacion`, escrito en positivo porque es como se lee
 * en el sitio donde importa: `cancelar` pregunta «¿hay que devolver algo?».
 * Los estados terminales tampoco apartan —al entregar se consume, al cancelar
 * se libera— así que aquí solo están los tres del medio.
 */
export function apartaInventario(estado: EstadoPedido): boolean {
  return estado === "por_abonar" || estado === "agendado" || estado === "en_ruta";
}

/**
 * ¿Este pedido ya es una venta?
 *
 * **Aquí Baby Caleb NO hace lo que Nébula.** Allí `countsAsRevenue` mira el
 * estado del PAGO: si entró dinero, cuenta. Aquí la venta se reconoce AL
 * ENTREGAR (docs/plan/05-contabilidad.md): un abono de un pedido que todavía no
 * salió es un pasivo en «2101 Anticipos de clientas», no un ingreso. Cobrar no
 * es vender: si el pedido se cancela, ese dinero se devuelve o se acredita.
 *
 * Por eso esta función mira el estado del PEDIDO y no el del pago.
 *
 * Un pedido `devuelto` sí fue una venta en su momento: la devolución se
 * registra con un asiento contrario (05-contabilidad, asiento 13), no borrando
 * el original. Los reportes suman el libro mayor, no este indicador.
 *
 * El criterio de reconocer al entregar está marcado como pregunta abierta para
 * la dueña en 05-contabilidad §9: si lo cambia, se cambia aquí y en las vistas
 * a la vez.
 */
export function cuentaComoVenta(estado: EstadoPedido): boolean {
  return estado === "entregado";
}

/** Un abono cobrado antes de entregar es un anticipo, no un ingreso. */
export function esAnticipo(estado: EstadoPedido, estadoPago: EstadoPago): boolean {
  if (cuentaComoVenta(estado) || estado === "devuelto") return false;
  return estadoPago === "abonado" || estadoPago === "pagado";
}

export interface ErrorDeTransicion {
  campo: "estado" | "estado_pago";
  de: string;
  a: string;
  mensaje: string;
}

/** Valida un cambio de estado antes de tocar la base. */
export function validarTransicion(entrada: {
  estadoActual: EstadoPedido;
  estadoNuevo: EstadoPedido;
  pagoActual: EstadoPago;
  pagoNuevo: EstadoPago;
}): ErrorDeTransicion[] {
  const errores: ErrorDeTransicion[] = [];

  if (!puedeCambiarPedido(entrada.estadoActual, entrada.estadoNuevo)) {
    errores.push({
      campo: "estado",
      de: entrada.estadoActual,
      a: entrada.estadoNuevo,
      mensaje: `Un pedido «${ETIQUETAS_PEDIDO[entrada.estadoActual]}» no puede pasar a «${ETIQUETAS_PEDIDO[entrada.estadoNuevo]}».`,
    });
  }

  if (!puedeCambiarPago(entrada.pagoActual, entrada.pagoNuevo)) {
    errores.push({
      campo: "estado_pago",
      de: entrada.pagoActual,
      a: entrada.pagoNuevo,
      mensaje: `Un pago «${ETIQUETAS_PAGO[entrada.pagoActual]}» no puede pasar a «${ETIQUETAS_PAGO[entrada.pagoNuevo]}».`,
    });
  }

  return errores;
}
