/**
 * Forma de toda respuesta que cruza un service binding.
 *
 * Una excepción que cruza un binding de RPC llega al otro lado sin su tipo, así
 * que los métodos de los entrypoints NO lanzan errores de negocio: los
 * devuelven. Ver docs/plan/01-arquitectura.md §4 y 03-contratos.md §5.
 */
export type Ok<T> = { ok: true } & T;
export type Fallo = { ok: false; codigo: CodigoError; mensaje: string };
export type Resultado<T> = Ok<T> | Fallo;

/** Códigos estables: el otro lado decide qué hacer según el código, no según el texto. */
export type CodigoError =
  | "no_implementado"
  | "no_encontrado"
  | "entrada_invalida"
  | "conflicto_de_version"
  | "sin_existencias"
  | "limite_excedido"
  | "no_autorizado"
  | "error_interno";

export const fallo = (codigo: CodigoError, mensaje: string): Fallo => ({ ok: false, codigo, mensaje });

/** Lo que todavía no existe se dice, no se finge. */
export const pendienteDeFase = (que: string, fase: string): Fallo =>
  fallo("no_implementado", `${que} llega en ${fase}`);
