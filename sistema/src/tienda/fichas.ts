/**
 * ¿Sale esta presentación en la tienda, y si no, por qué?
 *
 * EL PROBLEMA QUE CONTESTA
 *
 * La dueña publica algo en el panel y abre babycaleb.com a ver si está. Si no
 * está, nadie le dice por qué: ni la tienda, ni el panel, ni un error. El
 * dueño preguntó cuatro días seguidos por un caso de estos.
 *
 * LO QUE CAMBIÓ, Y POR QUÉ ESTE ARCHIVO ES AHORA LA MITAD DE LARGO
 *
 * Hasta la migración 0019 la respuesta no salía de la base: salía de leer
 * `content.json`, el archivo de fichas del repositorio de la web, porque la
 * lista de la tienda se armaba de ahí. Un producto recién creado no tenía
 * ficha, así que tenía precio, existencia, foto y página propia — y no entraba
 * en la lista hasta que un programador editara ese archivo y desplegara.
 *
 * Eso se acabó: la lista sale del catálogo del sistema. Publicado y activo
 * quiere decir que se ve, y no hay un tercer requisito escondido en otro
 * repositorio. Por eso aquí ya no se importa `content.json` — importarlo sería
 * dejar un segundo dueño de la misma pregunta, que es justo lo que este cambio
 * viene a terminar.
 *
 * Lo que queda es un aviso, no un impedimento: una tarjeta sin texto de venta
 * sale igual, pero sale peor, y la dueña puede arreglarlo desde el panel o por
 * MCP sin pedirle nada a nadie.
 */

export interface EstadoEnLaTienda {
  /** Si una clienta puede verla hoy en babycaleb.com. */
  readonly sale: boolean;
  /**
   * Por qué NO sale, en palabras que la dueña pueda leer. `null` si sale.
   *
   * No es un código de error: es la frase que se le enseña tal cual.
   */
  readonly motivo: string | null;
  /**
   * Sale, pero algo le falta para verse bien. `null` si no falta nada.
   *
   * Está separado del motivo a propósito. Mezclarlos haría que «le falta el
   * texto» se leyera como «por eso no sale», que es exactamente la confusión
   * que había antes — y la dueña dejaría de publicar esperando a escribirlo.
   */
  readonly aviso: string | null;
}

/** Lo mínimo que hace falta saber de una variante para contestar. */
export interface VarianteParaLaTienda {
  readonly codigo: string;
  /** 1 si la dueña la tiene publicada. */
  readonly publicado: number;
  /** 0 si está retirada del catálogo. */
  readonly activo?: number;
  /**
   * El texto de venta de SU PRODUCTO, o `null` si todavía no se ha escrito.
   *
   * Es del producto y no de la variante porque las seis cajas de Nateen
   * comparten un párrafo. Llega ya leído de la base: este módulo no consulta
   * nada, para que se pueda probar entero sin una D1 delante.
   */
  readonly descripcionDelProducto?: string | null;
}

/** Que haya texto de verdad, no una cadena en blanco. */
function hayTexto(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * El orden de las razones importa: se dice la que la dueña puede arreglar
 * primero. De nada sirve contarle que le falta el texto si además la tiene
 * despublicada — arreglaría una cosa y seguiría sin salir.
 */
export function estadoEnLaTienda(v: VarianteParaLaTienda): EstadoEnLaTienda {
  if (v.activo === 0) {
    return { sale: false, motivo: "Está retirada del catálogo.", aviso: null };
  }
  if (v.publicado !== 1) {
    return {
      sale: false,
      motivo: "No está publicada. Publíquela para que la tienda pueda enseñarla.",
      aviso: null,
    };
  }
  return {
    sale: true,
    motivo: null,
    aviso: hayTexto(v.descripcionDelProducto)
      ? null
      : "Su tarjeta sale sin texto de venta. Escríbalo en el producto para que se vea mejor.",
  };
}
