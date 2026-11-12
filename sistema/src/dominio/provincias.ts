/**
 * Las provincias de Panamá, con el código que pide la pasarela.
 *
 * POR QUÉ ESTÁ APARTE DE `direccion.ts`
 *
 * La lista de nombres vivía dentro de `direccion.ts`, que existe para traducir
 * lo que devuelve un geocodificador. Ahora la lista tiene un segundo lector —la
 * ficha de la clienta, en el panel, donde se elige la provincia para poder
 * cobrar con tarjeta— y el panel no debería arrastrar el geocodificador entero
 * para pintar un desplegable. Así que la lista se mudó aquí y `direccion.ts` la
 * importa: sigue habiendo UNA lista, que es lo que importa.
 *
 * EL CÓDIGO ISO NO ES UN ADORNO
 *
 * `billToState` de Tilopay se manda en ISO 3166-2 —«PA-8» por Panamá—, no con
 * el nombre escrito. Escribirlo mal no da un error bonito: da un cobro
 * rechazado con una clienta esperando en el teléfono.
 *
 * PENDIENTE, y se dice en vez de rellenarse: el único código confirmado contra
 * un requisito de la pasarela es `PA-8`. Los demás salen de ISO 3166-2:PA y
 * NADIE ha comprobado todavía que Tilopay acepte exactamente esos —su
 * documentación en docs/plan/04-pagos.md §4.2 no los lista—. Antes del primer
 * cobro con tarjeta hay que pedirles la lista que aceptan y corregir aquí lo
 * que no case. Por eso la columna `direcciones.provincia_iso` no lleva CHECK:
 * corregir un código es cambiar una línea, no recrear una tabla.
 */

/** Las diez provincias más las tres comarcas, escritas como se escriben. */
export const PROVINCIAS = [
  "Bocas del Toro",
  "Coclé",
  "Colón",
  "Chiriquí",
  "Darién",
  "Herrera",
  "Los Santos",
  "Panamá",
  "Panamá Oeste",
  "Veraguas",
  "Emberá-Wounaan",
  "Guna Yala",
  "Ngäbe-Buglé",
] as const;

export type Provincia = (typeof PROVINCIAS)[number];

/**
 * El código ISO de cada una.
 *
 * El tipo es `Record<Provincia, string>` a propósito: añadir una provincia a la
 * lista de arriba sin darle su código deja de compilar. Una lista que se
 * desincroniza en silencio de otra es exactamente lo que se evita escribiéndolas
 * juntas.
 */
export const ISO_DE_PROVINCIA: Record<Provincia, string> = {
  "Bocas del Toro": "PA-1",
  Coclé: "PA-2",
  Colón: "PA-3",
  Chiriquí: "PA-4",
  Darién: "PA-5",
  Herrera: "PA-6",
  "Los Santos": "PA-7",
  Panamá: "PA-8",
  Veraguas: "PA-9",
  "Panamá Oeste": "PA-10",
  "Emberá-Wounaan": "PA-EM",
  "Guna Yala": "PA-KY",
  "Ngäbe-Buglé": "PA-NB",
};

/** Panamá en ISO 3166-1, que es lo que va en `billToCountry`. */
export const PAIS_PANAMA = "PA";
