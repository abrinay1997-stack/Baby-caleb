/**
 * La URL absoluta del sitio, para el canónico y Open Graph.
 *
 * `SITE_URL` manda sobre el `Host` de la petición: con el Host, el canónico de
 * una vista previa apuntaría a la vista previa y Google indexaría esa.
 *
 * Mientras no exista el dominio, la variable está VACÍA y lo correcto es usar
 * el origen de la petición. Eso es lo que decía el comentario de
 * `wrangler.jsonc` desde el principio — y lo que el código NO hacía: estaba
 * escrito `env.SITE_URL ?? url.origin`, y `??` solo cae cuando el valor es
 * nulo o no existe. Una cadena vacía no es ninguna de las dos, así que el
 * sitio quedaba en "" y todas las URLs salían RELATIVAS.
 *
 * El síntoma no se ve mirando la página: un canónico relativo es válido y el
 * navegador lo resuelve. Lo que se rompe es `og:url`, que es lo que lee
 * WhatsApp al pegar un enlace — o sea, exactamente lo que la mudanza a un
 * Worker existía para arreglar.
 */
export function urlDelSitio(configurado: string | undefined, origen: string): string {
  const limpio = (configurado ?? "").trim().replace(/\/+$/, "");
  return limpio === "" ? origen.replace(/\/+$/, "") : limpio;
}
