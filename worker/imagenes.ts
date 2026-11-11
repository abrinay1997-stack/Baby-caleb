import type { SistemaWebBinding } from "./catalogo";

/**
 * Las fotos del catálogo, servidas por la WEB.
 *
 * Por qué aquí y no en el sistema: el Worker del sistema está entero detrás de
 * Cloudflare Access. Una URL de imagen de allá no la puede abrir nadie sin
 * sesión, y una foto de producto tiene que verla cualquiera. Así que la pide
 * la web por el service binding y la sirve.
 *
 * **Quién decide si una clave sale NO es este archivo.** Lo decide
 * `leerPublico` en el sistema, que mira la fila de `archivos`: en ese bucket
 * viven también los comprobantes de pago de las clientas. Aquí no se
 * interpreta la clave, no se adivina el tipo y no se construye ninguna ruta de
 * R2 — se pasa lo que llegó y se sirve lo que conteste. Un filtro repetido en
 * dos sitios acaba discrepando, y el que se equivoca del lado flojo es el que
 * nadie revisa.
 */

/**
 * `/foto/` y NO `/img/`.
 *
 * `/img/` ya era de las imágenes del sitio —el logo, el hero, las 26 que
 * viven en `public/img/`— y ponerle el Worker delante dejó TODAS rotas: las
 * buscaba en R2, donde no están. El sitio entero se quedó sin imágenes en
 * producción.
 *
 * El error no fue del código sino de elegir un prefijo sin mirar quién lo
 * usaba ya. Un prefijo nuevo no se comparte con nadie, y una prueba de abajo
 * fija que `/img/` NO es este camino.
 */
export const PREFIJO = "/foto/";

export async function imagen(
  peticion: Request,
  sistema?: SistemaWebBinding,
): Promise<Response> {
  if (sistema === undefined) {
    // Sin binding no hay catálogo ni fotos. 503 y no 404: es una avería de
    // configuración, no una foto que no existe, y confundirlas manda al
    // siguiente que lo mire a buscar la foto en vez del binding.
    return new Response("Sin conexión con el sistema", { status: 503 });
  }

  const url = new URL(peticion.url);
  let clave: string;
  try {
    clave = decodeURIComponent(url.pathname.slice(PREFIJO.length));
  } catch {
    // Un `%` suelto en la URL. No es una clave: es basura.
    return noEncontrado();
  }
  if (clave === "") return noEncontrado();

  const r = await sistema.archivo(clave);
  if (!r.ok || r.datos === null) return noEncontrado();

  return new Response(r.datos.bytes, {
    headers: {
      "content-type": r.datos.mime,
      // Un año e inmutable: la clave lleva un ULID dentro, así que una foto
      // distinta es OTRA clave. Cambiar la foto de un producto no obliga a
      // esperar a que caduque ninguna caché.
      "cache-control": "public, max-age=31536000, immutable",
      // Que el navegador no adivine el tipo. Es la otra mitad de haber
      // validado el mime del lado de los datos: sin esto, un archivo que se
      // colara con el tipo equivocado podría ejecutarse igual.
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

/**
 * «No existe» y «no se sirve en abierto» contestan LO MISMO, a propósito.
 *
 * Distinguirlos le diría a quien prueba claves al azar cuáles existen, y lo
 * que hay en ese bucket además de fotos son comprobantes de pago.
 */
const noEncontrado = () =>
  new Response("No encontrado", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
