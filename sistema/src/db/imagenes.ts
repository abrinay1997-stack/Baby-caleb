/**
 * Qué es un archivo DE VERDAD, mirándolo.
 *
 * El navegador manda un `Content-Type` y no hay ninguna razón para creérselo:
 * lo escribe quien hace la petición. Si se guardara ese tipo tal cual, alguien
 * podría subir un HTML diciendo que es `image/webp`, y después `leerPublico`
 * lo serviría como imagen porque la fila dice que lo es.
 *
 * Con `nosniff` el navegador no lo ejecutaría igual, pero eso es la segunda
 * red. La primera es esta: el tipo que se guarda sale de los BYTES, y un
 * archivo cuyos bytes no son una imagen conocida no se guarda.
 *
 * Los números mágicos son los del formato, no una heurística:
 *
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   WebP  "RIFF" …4 bytes de tamaño… "WEBP"
 *   AVIF  …4 bytes… "ftyp" + marca "avif"/"avis"
 */

export const TIPOS_DE_IMAGEN = ["image/png", "image/jpeg", "image/webp", "image/avif"] as const;
export type TipoDeImagen = (typeof TIPOS_DE_IMAGEN)[number];

const empiezaCon = (b: Uint8Array, bytes: readonly number[], desde = 0): boolean =>
  bytes.every((x, i) => b[desde + i] === x);

/** Las letras ASCII de `texto` en la posición `desde`. */
const dice = (b: Uint8Array, texto: string, desde: number): boolean =>
  empiezaCon(b, [...texto].map((c) => c.charCodeAt(0)), desde);

/** `null` si no son los bytes de ninguna imagen que publiquemos. */
export function tipoDeImagen(datos: ArrayBuffer): TipoDeImagen | null {
  const b = new Uint8Array(datos);
  // 12 bytes es lo que hace falta para distinguir WebP y AVIF. Menos que eso
  // no es un archivo, es un trozo.
  if (b.length < 12) return null;

  if (empiezaCon(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (empiezaCon(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (dice(b, "RIFF", 0) && dice(b, "WEBP", 8)) return "image/webp";
  // El tamaño de la caja va delante y varía, así que se busca «ftyp» en su
  // sitio fijo y la marca justo detrás.
  if (dice(b, "ftyp", 4) && (dice(b, "avif", 8) || dice(b, "avis", 8))) return "image/avif";

  return null;
}

/**
 * Lo más grande que se acepta: 5 MB.
 *
 * Una foto de teléfono moderno pesa entre 2 y 4 MB sin tocar, y pedirle a
 * Yarielis que la encoja antes de subirla es pedirle que no suba fotos. Cinco
 * deja margen sin que una sola imagen se coma el bucket.
 */
export const MAXIMO_BYTES = 5 * 1024 * 1024;

/** La extensión que le toca a cada tipo, para la clave en R2. */
export const EXTENSIONES: Record<TipoDeImagen, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};
