import { type Resultado, fallo, ok } from "../contrato/resultado";
import { type Centavos, aplicarPuntosBasicos, multiplicar, prorratear, sumar } from "./dinero";

/**
 * Totales de un pedido.
 *
 * Portado de `packages/domain/src/pricing.ts` de Nébula, en centavos enteros y
 * con dos cambios que pide el modelo de datos de Baby Caleb:
 *
 *  1. El ITBMS es POR LÍNEA (`pedido_lineas.itbms_bp`), no una tasa única del
 *     pedido: un pañal y un portabebé no tributan igual. El descuento se
 *     prorratea entre las líneas por valor antes de calcular el impuesto de
 *     cada una, y el prorrateo cuadra al centavo.
 *  2. Una tasa sin confirmar (`tasa_itbms_bp = NULL`) NO se trata como 0: se
 *     devuelve un fallo. «Ninguna cifra a ojo» (docs/plan/README.md): un cero
 *     inventado es una declaración de impuestos mal hecha, y es la contadora
 *     quien pone ese número.
 *
 * La fórmula del total es exactamente la del CHECK de `pedidos`:
 *   total = subtotal + envio - descuento + itbms
 */

export type TipoDescuento = "porcentaje" | "monto_fijo" | "envio_gratis";

export interface LineaConPrecio {
  codigo: string;
  /** El precio del catálogo, nunca el que manda el navegador. */
  precio_unit_cents: Centavos;
  cantidad: number;
  /** Puntos básicos (700 = 7 %). null = PENDIENTE de la contadora. */
  itbms_bp: number | null;
}

export interface Descuento {
  tipo: TipoDescuento;
  /** Monto ya resuelto (un porcentaje se convierte a centavos antes de llegar aquí). */
  monto_cents: Centavos;
}

export interface Envio {
  tarifa_cents: Centavos;
  /** Umbral desde el que el envío no se cobra. null = nunca es gratis. */
  gratis_desde_cents: Centavos | null;
}

export interface TotalLinea {
  codigo: string;
  bruto_cents: Centavos;
  descuento_cents: Centavos;
  itbms_cents: Centavos;
}

export interface Totales {
  subtotal_cents: Centavos;
  descuento_cents: Centavos;
  envio_cents: Centavos;
  itbms_cents: Centavos;
  total_cents: Centavos;
  lineas: TotalLinea[];
}

export interface EntradaTotales {
  lineas: readonly LineaConPrecio[];
  descuento?: Descuento | null;
  envio?: Envio | null;
}

export function totalDeLinea(l: Pick<LineaConPrecio, "precio_unit_cents" | "cantidad">): Centavos {
  return multiplicar(l.precio_unit_cents, l.cantidad);
}

/**
 * El orden importa y por eso se fija aquí:
 *   1. subtotal de las líneas
 *   2. descuento sobre el subtotal (nunca lo deja negativo ni genera saldo a favor)
 *   3. envío, midiendo el umbral de envío gratis sobre el subtotal YA
 *      descontado — si se midiera antes, un cupón podría bajar el pedido por
 *      debajo del umbral y aun así regalar el envío
 *   4. ITBMS por línea, sobre su parte del subtotal ya descontado
 */
export function calcularTotales({
  lineas,
  descuento = null,
  envio = null,
}: EntradaTotales): Resultado<Totales> {
  for (const l of lineas) {
    if (!Number.isInteger(l.cantidad) || l.cantidad <= 0) {
      return fallo("entrada_invalida", `la cantidad de ${l.codigo} no es válida`);
    }
    if (l.precio_unit_cents < 0) {
      return fallo("entrada_invalida", `el precio de ${l.codigo} no puede ser negativo`);
    }
    if (l.itbms_bp === null) {
      return fallo(
        "entrada_invalida",
        `falta la tasa de ITBMS de ${l.codigo}: la pone la contadora, no se asume cero`,
      );
    }
  }

  const brutos = lineas.map(totalDeLinea);
  const subtotal_cents = sumar(brutos);

  // Un descuento nunca supera el subtotal, y uno negativo se ignora en vez de
  // sumarse al total.
  const pedido = descuento ? Math.max(descuento.monto_cents, 0) : 0;
  const descuento_cents = Math.min(pedido, subtotal_cents);
  const descontado = subtotal_cents - descuento_cents;

  let envio_cents: Centavos = 0;
  if (envio) {
    const esGratis =
      descuento?.tipo === "envio_gratis" ||
      (envio.gratis_desde_cents !== null && descontado >= envio.gratis_desde_cents);
    envio_cents = esGratis ? 0 : Math.max(envio.tarifa_cents, 0);
  }

  // El descuento se reparte por valor para que el impuesto de cada línea salga
  // sobre lo que de verdad se cobró por ella. Cuadra al centavo.
  const descuentoPorLinea = prorratear(descuento_cents, brutos);

  const detalle: TotalLinea[] = lineas.map((l, i) => {
    const bruto = brutos[i]!;
    const desc = descuentoPorLinea[i]!;
    return {
      codigo: l.codigo,
      bruto_cents: bruto,
      descuento_cents: desc,
      itbms_cents: aplicarPuntosBasicos(bruto - desc, l.itbms_bp ?? 0),
    };
  });

  const itbms_cents = sumar(detalle.map((d) => d.itbms_cents));
  const total_cents = subtotal_cents + envio_cents - descuento_cents + itbms_cents;

  return ok({
    subtotal_cents,
    descuento_cents,
    envio_cents,
    itbms_cents,
    total_cents,
    lineas: detalle,
  });
}

/** Convierte un porcentaje en puntos básicos a un descuento en centavos. */
export function descuentoPorPorcentaje(
  subtotal_cents: Centavos,
  puntosBasicos: number,
): Descuento {
  return {
    tipo: "porcentaje",
    monto_cents: aplicarPuntosBasicos(subtotal_cents, Math.max(puntosBasicos, 0)),
  };
}
