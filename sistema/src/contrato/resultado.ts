/**
 * Forma de toda respuesta que cruza un service binding.
 *
 * **Esto es contrato, no estilo.** Está copiado de docs/plan/03-contratos.md §5
 * y el CRM tiene una copia con la misma huella (`src/sistema/contrato.ts`): una
 * prueba en cada repo falla si las dos no coinciden. Así que la forma y los
 * nombres de los códigos no se cambian por gusto — se cambian en el plan
 * primero, y después en los dos lados.
 *
 * Una excepción que cruza un binding de RPC llega al otro lado sin su tipo, así
 * que los métodos de los entrypoints NO lanzan errores de negocio: los
 * devuelven.
 */

export type Ok<T> = { ok: true; datos: T };

export interface Fallo {
  ok: false;
  codigo: CodigoError;
  /** En español, para mostrarlo o para que el modelo corrija. */
  mensaje: string;
  detalle?: Record<string, unknown>;
}

export type Resultado<T> = Ok<T> | Fallo;

/**
 * Los doce códigos del contrato. El otro lado decide qué hacer según el
 * código, no según el texto, así que el texto puede cambiar y el código no.
 */
export const CODIGOS_ERROR = [
  "entrada_invalida",
  "no_encontrado",
  "no_autorizado",
  "sin_stock",
  "transicion_invalida",
  "conflicto_version",
  "monto_no_coincide",
  "pasarela_no_disponible",
  "periodo_cerrado",
  "repetido",
  "limite",
  "interno",
] as const;

export type CodigoError = (typeof CODIGOS_ERROR)[number];

export const esCodigoError = (v: string): v is CodigoError =>
  (CODIGOS_ERROR as readonly string[]).includes(v);

export const ok = <T>(datos: T): Ok<T> => ({ ok: true, datos });

export function fallo(
  codigo: CodigoError,
  mensaje: string,
  detalle?: Record<string, unknown>,
): Fallo {
  return { ok: false, codigo, mensaje, ...(detalle === undefined ? {} : { detalle }) };
}

/**
 * Para los métodos que todavía no existen.
 *
 * Usa `interno` y no un código propio a propósito: la lista de códigos es
 * contrato con el CRM, y agregarle uno para andamios de construcción obliga al
 * otro lado a conocer algo que va a desaparecer. El mensaje dice en qué fase
 * llega, que es lo que de verdad hace falta saber.
 */
export const pendienteDeFase = (que: string, fase: string): Fallo =>
  fallo("interno", `${que} llega en ${fase}; todavía no está implementado`);
