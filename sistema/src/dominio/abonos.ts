import { type Centavos, aplicarPuntosBasicos, formatear } from "./dinero";
import type { EstadoPago } from "./estado-pedido";

/**
 * Abonos: cobrar un pedido por partes, y decidir cuándo puede salir.
 *
 * Portado de `packages/domain/src/abonos.ts` de Nébula. La pregunta es la misma
 * que hizo la dueña de aquel negocio —«¿puedo recibir abonos y despachar cuando
 * se complete el pago?»— y tiene dos mitades: una es aritmética, cuánto lleva
 * pagado, y vive en la base; la otra es una decisión de negocio, cuánto hace
 * falta para despachar, y vive aquí.
 *
 * Dos diferencias con Nébula:
 *
 *  1. Todo en centavos enteros, así que desaparece el baile de redondeos. En
 *     Nébula había que redondear antes de comparar porque un pedido de 100
 *     pagado con 33.34 + 33.33 + 33.33 daba 99.99999999 y se quedaba sin poder
 *     salir por una milésima que no existe en ninguna caja. Aquí 10000 =
 *     3334 + 3333 + 3333 y no hay nada que redondear.
 *  2. Baby Caleb tiene además una regla propia para AGENDAR, anterior a la de
 *     despachar: el abono mínimo (docs/plan/02-datos.md §6). Está en
 *     `puedeAgendar`.
 */

/**
 * Cuándo se deja salir un pedido que todavía debe dinero.
 *
 * Las tres son razonables y cuál conviene depende del monto, de la clienta y de
 * la confianza. Se elige en `ajustes`, no en el código: el día que la dueña
 * quiera cambiarla no debería hacer falta un despliegue.
 */
export const POLITICAS = ["estricta", "umbral", "contra_entrega"] as const;

export type Politica = (typeof POLITICAS)[number];

export const esPolitica = (v: string): v is Politica =>
  (POLITICAS as readonly string[]).includes(v);

export const ETIQUETAS_POLITICA: Record<Politica, string> = {
  estricta: "No despachar hasta que el saldo esté en cero",
  umbral: "Despachar al alcanzar un porcentaje del total",
  contra_entrega: "Despachar con saldo, y cobrar el resto al entregar",
};

export interface Regla {
  politica: Politica;
  /** Solo con la política de umbral. Puntos básicos del total (5000 = 50 %). */
  umbral_bp: number;
}

/**
 * La regla por defecto, y por qué es la estricta.
 *
 * Es la única de las tres que no puede acabar en pérdida: si el pedido no sale
 * hasta que el dinero está, no hay mercancía en la calle contra una promesa.
 * Las otras dos son decisiones que alguien tiene que tomar a sabiendas, y por
 * eso ninguna es el valor por defecto — que nadie las active sin querer.
 *
 * El plan dice que Baby Caleb usa `contra_entrega` para el paso
 * `agendado → en_ruta` (el motorizado cobra el saldo al entregar), salvo cuando
 * el pedido lleva `requiere_pago_total`. Eso se configura en `ajustes`; este
 * valor es solo el piso seguro si no hay nada configurado.
 */
export const REGLA_POR_DEFECTO: Regla = { politica: "estricta", umbral_bp: 5000 };

export interface Decision {
  puede: boolean;
  /** Lo que falta por cobrar. Cero si ya no falta nada. */
  falta_cents: Centavos;
  motivo: string;
}

const acotarBp = (bp: number): number =>
  Number.isFinite(bp) ? Math.min(Math.max(Math.round(bp), 0), 10_000) : 0;

const comoPorcentaje = (bp: number): string => String(acotarBp(bp) / 100);

/**
 * Montos imposibles: se bloquea, no se deja pasar.
 *
 * Nébula hacía lo contrario —un total NaN acababa en `puede: true`— porque su
 * redondeo convertía lo no finito en 0 y un pedido de 0 no bloquea a nadie. Con
 * mercancía de por medio el error seguro es el otro: si el total no es un
 * número entero de centavos, algo está roto aguas arriba y nada sale de la
 * bodega hasta que se sepa qué.
 */
function montosImposibles(total: number, pagado: number): Decision | null {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(pagado)) {
    return {
      puede: false,
      falta_cents: 0,
      motivo: "Los montos del pedido no son válidos: no sale nada hasta corregirlo.",
    };
  }
  return null;
}

/**
 * ¿Puede salir este pedido? Es la regla de `agendado → en_ruta`.
 */
export function decidirDespacho(entrada: {
  total_cents: Centavos;
  pagado_cents: Centavos;
  regla: Regla;
}): Decision {
  const roto = montosImposibles(entrada.total_cents, entrada.pagado_cents);
  if (roto) return roto;

  const total = entrada.total_cents;
  const pagado = Math.max(entrada.pagado_cents, 0);
  const saldo = Math.max(total - pagado, 0);

  // Un pedido sin importe no tiene nada que cobrar, y bloquearlo sería absurdo.
  if (total <= 0) {
    return { puede: true, falta_cents: 0, motivo: "El pedido no tiene importe pendiente." };
  }

  if (saldo <= 0) {
    return { puede: true, falta_cents: 0, motivo: "El pedido está pagado por completo." };
  }

  switch (entrada.regla.politica) {
    case "contra_entrega":
      return {
        puede: true,
        falta_cents: saldo,
        motivo: `Sale con saldo: hay que cobrar ${formatear(saldo)} al entregar.`,
      };

    case "umbral": {
      const bp = acotarBp(entrada.regla.umbral_bp);
      const minimo = aplicarPuntosBasicos(total, bp);
      if (pagado >= minimo) {
        return {
          puede: true,
          falta_cents: saldo,
          motivo: `Superó el ${comoPorcentaje(bp)} % exigido para despachar.`,
        };
      }
      const falta = minimo - pagado;
      return {
        puede: false,
        falta_cents: falta,
        motivo: `Faltan ${formatear(falta)} para alcanzar el ${comoPorcentaje(bp)} % que hace falta para despachar.`,
      };
    }

    case "estricta":
      return {
        puede: false,
        falta_cents: saldo,
        motivo: `Faltan ${formatear(saldo)} por cobrar antes de despachar.`,
      };
  }
}

/**
 * ¿Se puede agendar? Es la regla de `por_abonar → agendado`, propia de Baby
 * Caleb (docs/plan/02-datos.md §6):
 *
 *   exige `pagado_cents >= abono_minimo_cents`, o `= total_cents` si
 *   `requiere_pago_total = 1` (Ferguson, y todo pedido pagado con tarjeta o
 *   PayPal, porque esas dos no admiten abono).
 *
 * El abono mínimo se copia al pedido cuando se crea y se pasa aquí: la regla no
 * cambia a mitad del pedido porque la dueña la cambie en los ajustes.
 */
export function puedeAgendar(entrada: {
  total_cents: Centavos;
  pagado_cents: Centavos;
  abono_minimo_cents: Centavos;
  requiere_pago_total: boolean;
}): Decision {
  const roto = montosImposibles(entrada.total_cents, entrada.pagado_cents);
  if (roto) return roto;

  const total = entrada.total_cents;
  const pagado = Math.max(entrada.pagado_cents, 0);
  const saldo = Math.max(total - pagado, 0);

  if (total <= 0) {
    return { puede: true, falta_cents: 0, motivo: "El pedido no tiene importe pendiente." };
  }

  if (entrada.requiere_pago_total) {
    if (saldo <= 0) {
      return { puede: true, falta_cents: 0, motivo: "Está pagado por completo." };
    }
    return {
      puede: false,
      falta_cents: saldo,
      motivo: `Este pedido se agenda solo con el pago completo: faltan ${formatear(saldo)}.`,
    };
  }

  // El mínimo nunca puede ser más que el total: un pedido de $3 con abono
  // mínimo de $5 se agenda pagándolo entero, no se vuelve imposible.
  const minimo = Math.min(Math.max(entrada.abono_minimo_cents, 0), total);

  if (pagado >= minimo) {
    return {
      puede: true,
      falta_cents: saldo,
      motivo:
        saldo > 0
          ? `Abono suficiente. Queda un saldo de ${formatear(saldo)}.`
          : "Está pagado por completo.",
    };
  }

  const falta = minimo - pagado;
  return {
    puede: false,
    falta_cents: falta,
    motivo: `Para agendarlo hace falta un abono de ${formatear(minimo)}: faltan ${formatear(falta)}.`,
  };
}

/**
 * En qué estado de pago queda un pedido según lo que lleva cobrado.
 *
 * Se deriva y no se escribe a mano en ningún sitio: dos formas de decidir el
 * mismo estado acaban discrepando, y quien mire el pedido no sabrá cuál creer.
 * Los estados de reembolso no salen de aquí: los pone el reembolso, que sabe si
 * fue parcial o total.
 */
export function estadoDePagoSegunSaldo(
  total_cents: Centavos,
  pagado_cents: Centavos,
): Extract<EstadoPago, "sin_pago" | "abonado" | "pagado"> {
  const pagado = Math.max(pagado_cents, 0);
  if (pagado <= 0) return "sin_pago";
  if (pagado >= total_cents) return "pagado";
  return "abonado";
}

/** Lo que el motorizado tiene que cobrar al entregar. */
export function saldoPorCobrar(total_cents: Centavos, pagado_cents: Centavos): Centavos {
  return Math.max(total_cents - Math.max(pagado_cents, 0), 0);
}
