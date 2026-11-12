/**
 * La foto se encoge y se convierte AQUÍ, en el teléfono, antes de subirla.
 *
 * Por qué en el navegador y no en el Worker: un Worker de Cloudflare no sabe
 * decodificar un JPEG. No tiene canvas ni biblioteca de imágenes, así que
 * convertir allá obligaría a meter un codificador en WebAssembly dentro del
 * Worker —megabytes de código y tiempo de CPU en cada subida— para hacer algo
 * que el teléfono ya sabe hacer y hace gratis, porque esa foto ya está
 * decodificada en su pantalla.
 *
 * Y hay una razón mejor: así lo que viaja por la red del teléfono de Yarielis
 * son 300 KB en vez de 4 MB. En un dato móvil flojo esa es la diferencia entre
 * subir una foto y rendirse a la mitad.
 *
 * ## Qué resuelve
 *
 * Una foto de teléfono moderno pesa entre 2 y 5 MB y mide 4 000 píxeles de
 * ancho. En la ficha de un producto se ve a 600. Subir el original es mandar
 * siete veces más imagen de la que nadie va a ver, cobrárselo a la clienta en
 * su propio dato móvil cada vez que abre la tienda, y rozar el tope de 5 MB
 * por algo que convertido pesa la décima parte.
 *
 * Después de esto, el tope de 5 MB deja de estorbar: la comprobación del
 * servidor se hace sobre los bytes CONVERTIDOS, así que un PNG de 12 MB entra
 * sin problema porque lo que se manda son 300 KB. El tope sigue puesto, y sigue
 * siendo la última palabra, pero ya no rechaza fotos de verdad.
 *
 * ## Lo que NO cambia
 *
 * El servidor sigue mirando los bytes y decidiendo él. Esto es una comodidad
 * del panel, no una defensa: una defensa que vive en el navegador no es una
 * defensa, porque quien manda la petición puede saltársela. Si la conversión
 * falla por lo que sea, se manda el archivo original y contesta el servidor,
 * con su mensaje. Nunca se bloquea una subida aquí.
 */

/** Lo más grande que necesita la ficha de un producto, con holgura para pantallas densas. */
export const LADO_MAXIMO = 1600;

/** Calidad de la conversión. 0.82 es donde deja de notarse y sigue pesando poco. */
export const CALIDAD = 0.82;

export interface FotoLista {
  /** Lo que se manda. Puede ser el archivo original si no se pudo convertir. */
  readonly cuerpo: Blob;
  /** Qué se hizo, para decírselo a quien la subió. `null` si no se tocó. */
  readonly nota: string | null;
}

/**
 * Las medidas de salida, sin deformar y **sin agrandar nunca**.
 *
 * Agrandar una foto pequeña no añade detalle: inventa píxeles, pesa más y se
 * ve peor. Una foto que ya cabe se deja como está.
 */
export function medidasDestino(
  ancho: number,
  alto: number,
  lado = LADO_MAXIMO,
): { ancho: number; alto: number } {
  const mayor = Math.max(ancho, alto);
  if (mayor <= lado || mayor === 0) return { ancho, alto };
  const factor = lado / mayor;
  // `round` y no `floor`: con `floor`, una foto de 4000×3000 sale 1600×1199 y
  // la proporción se corre lo justo para que se note en un borde.
  return { ancho: Math.max(1, Math.round(ancho * factor)), alto: Math.max(1, Math.round(alto * factor)) };
}

/**
 * El peso, como lo diría una persona.
 *
 * Se usa en la nota que lee quien subió la foto: «pesaba 3.8 MB y ahora pesa
 * 240 KB» explica de una vez por qué valió la pena esperar dos segundos.
 */
export function pesoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * ¿Vale la pena mandar lo convertido?
 *
 * Si la conversión salió MÁS pesada que el original, se manda el original. Pasa
 * de verdad: un PNG de pocos colores —una captura, un logo plano— comprime
 * mejor como PNG que como WebP, y convertirlo sería pagar calidad por nada.
 */
export function vaLeMejorConvertida(original: number, convertida: number): boolean {
  return convertida > 0 && convertida < original;
}

/** Los tipos que el servidor acepta. Si ya es uno de ellos y pesa poco, no hay nada que hacer. */
const YA_SIRVE = new Set(["image/webp", "image/avif"]);

/** Por debajo de esto no se gana nada convirtiendo, y se pierde un segundo. */
export const NO_VALE_LA_PENA_BYTES = 300 * 1024;

/**
 * Decide si hay que tocar la foto, mirando solo lo que se sabe sin decodificarla.
 *
 * Se separa de la conversión para poder probarla: lo de abajo necesita un
 * navegador de verdad y esto no.
 */
export function hayQueConvertir(tipo: string, bytes: number): boolean {
  if (YA_SIRVE.has(tipo) && bytes <= NO_VALE_LA_PENA_BYTES) return false;
  return true;
}

/** `true` si este navegador sabe guardar WebP desde un lienzo. */
async function sabeWebp(): Promise<boolean> {
  try {
    const lienzo = document.createElement("canvas");
    lienzo.width = 1;
    lienzo.height = 1;
    // `toDataURL` devuelve PNG cuando no reconoce el tipo pedido, así que la
    // respuesta se mira por el prefijo y no por si hubo error.
    return lienzo.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

/**
 * Prepara la foto para subirla: la encoge y la convierte a WebP.
 *
 * Nunca lanza. Si algo no se puede hacer —un navegador viejo, un archivo que
 * no se puede decodificar, un HEIC que este navegador no entiende— devuelve el
 * archivo tal cual y deja que conteste el servidor, que es quien decide de
 * verdad y quien tiene el mensaje bueno para cada caso.
 *
 * Y de paso arregla las fotos del iPhone en el propio iPhone: Safari sí sabe
 * decodificar HEIC, así que dibujarla y volver a guardarla como WebP convierte
 * sola la foto que el servidor rechazaría. En un Android o un escritorio que no
 * entienda HEIC, la decodificación falla, se manda el original y sale el
 * mensaje que explica cómo cambiar el formato en los ajustes de la cámara.
 */
export async function prepararFoto(archivo: File): Promise<FotoLista> {
  if (!hayQueConvertir(archivo.type, archivo.size)) {
    return { cuerpo: archivo, nota: null };
  }

  let mapa: ImageBitmap;
  try {
    mapa = await createImageBitmap(archivo);
  } catch {
    // No se pudo decodificar. Puede ser un HEIC en un navegador que no lo
    // entiende, o un archivo roto. El servidor sabe distinguirlos y lo dice.
    return { cuerpo: archivo, nota: null };
  }

  try {
    const { ancho, alto } = medidasDestino(mapa.width, mapa.height);
    const lienzo = document.createElement("canvas");
    lienzo.width = ancho;
    lienzo.height = alto;
    const pincel = lienzo.getContext("2d");
    if (pincel === null) return { cuerpo: archivo, nota: null };
    pincel.drawImage(mapa, 0, 0, ancho, alto);

    const tipo = (await sabeWebp()) ? "image/webp" : "image/jpeg";
    const convertida = await new Promise<Blob | null>((listo) => {
      lienzo.toBlob(listo, tipo, CALIDAD);
    });
    if (convertida === null) return { cuerpo: archivo, nota: null };

    if (!vaLeMejorConvertida(archivo.size, convertida.size)) {
      return { cuerpo: archivo, nota: null };
    }

    const encogida = ancho !== mapa.width || alto !== mapa.height;
    const nombre = tipo === "image/webp" ? "WebP" : "JPG";
    return {
      cuerpo: convertida,
      nota:
        `Se guardó como ${nombre}: pesaba ${pesoLegible(archivo.size)} y ahora pesa ` +
        `${pesoLegible(convertida.size)}` +
        (encogida ? `, a ${ancho} × ${alto} píxeles.` : "."),
    };
  } catch {
    return { cuerpo: archivo, nota: null };
  } finally {
    // Un ImageBitmap ocupa memoria de verdad hasta que se cierra, y en un
    // teléfono subiendo varias fotos seguidas eso se nota.
    mapa.close();
  }
}
