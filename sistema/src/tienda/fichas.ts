import contenido from "../../../content.json";

/**
 * Qué presentaciones tienen ficha en la tienda, y por qué una no sale.
 *
 * EL PROBLEMA QUE CONTESTA
 *
 * La dueña crea un producto en el panel, lo publica, y no aparece en la
 * tienda. No hay ningún error: la lista de la tienda se arma con las fichas de
 * `content.json` —la descripción, la foto, el texto de venta—, y un producto
 * recién creado no tiene ninguna. El sistema manda en el precio, en la
 * existencia y (desde hoy) en si una ficha se enseña o no; lo que el sistema
 * NO tiene todavía es el texto con el que se vende.
 *
 * El dueño preguntó cuatro días seguidos por qué pasaba eso. Nadie se lo decía:
 * ni la tienda, ni el panel, ni un error. El panel ahora lo dice.
 *
 * POR QUÉ SE LEE EL ARCHIVO Y NO SE COPIA LA LISTA
 *
 * `content.json` está en la raíz de este mismo repositorio, así que esto lo
 * **lee**, no lo duplica. Copiar los códigos a una constante de aquí sería la
 * trampa §8: una lista que alguien tiene que acordarse de tocar, y que el día
 * que no la toque hace que el panel mienta. Al leer el archivo de verdad, la
 * única forma de que esto se desactualice es que alguien despliegue el sistema
 * y la web por separado — y los dos salen del mismo `main`.
 */

interface VarianteDeFicha {
  readonly codigo?: string;
}

interface ProductoDeFicha {
  readonly name?: string;
  readonly descatalogado?: boolean;
  readonly variants?: readonly VarianteDeFicha[];
}

const PRODUCTOS = (contenido as { products?: readonly ProductoDeFicha[] }).products ?? [];

/**
 * Los códigos que la tienda sabe pintar, es decir los que tienen ficha y cuyo
 * producto no está marcado como descatalogado a mano.
 *
 * Se calcula una vez: el archivo entra en el paquete y no cambia en caliente.
 */
const CON_FICHA: ReadonlySet<string> = new Set(
  PRODUCTOS.filter((p) => p.descatalogado !== true)
    .flatMap((p) => p.variants ?? [])
    .map((v) => v.codigo)
    .filter((c): c is string => typeof c === "string" && c !== ""),
);

/** Los códigos cuya ficha existe pero está descatalogada a mano. */
const DESCATALOGADOS: ReadonlySet<string> = new Set(
  PRODUCTOS.filter((p) => p.descatalogado === true)
    .flatMap((p) => p.variants ?? [])
    .map((v) => v.codigo)
    .filter((c): c is string => typeof c === "string" && c !== ""),
);

export interface EstadoEnLaTienda {
  /** Si una clienta puede verla hoy en babycaleb.com. */
  readonly sale: boolean;
  /**
   * Por qué no sale, en palabras que la dueña pueda leer. `null` si sale.
   *
   * No es un código de error: es la frase que se le enseña tal cual.
   */
  readonly motivo: string | null;
}

/** Lo mínimo que hace falta saber de una variante para contestar. */
export interface VarianteParaLaTienda {
  readonly codigo: string;
  /** 1 si la dueña la tiene publicada. */
  readonly publicado: number;
  /** 0 si está retirada del catálogo. */
  readonly activo?: number;
}

/**
 * ¿Sale esta presentación en la tienda, y si no, por qué?
 *
 * El orden de las razones importa: se dice la que la dueña puede arreglar
 * primero. De nada sirve contarle que le falta la ficha si además la tiene
 * despublicada — arreglaría una cosa y seguiría sin salir.
 */
export function estadoEnLaTienda(v: VarianteParaLaTienda): EstadoEnLaTienda {
  if (v.activo === 0) {
    return { sale: false, motivo: "Está retirada del catálogo." };
  }
  if (v.publicado !== 1) {
    return { sale: false, motivo: "No está publicada. Publíquela para que la tienda pueda enseñarla." };
  }
  if (DESCATALOGADOS.has(v.codigo)) {
    return {
      sale: false,
      motivo: "Su ficha en la tienda está marcada como descatalogada.",
    };
  }
  if (!CON_FICHA.has(v.codigo)) {
    return {
      sale: false,
      motivo:
        "La tienda todavía no tiene su ficha: le falta la descripción, la foto y el texto de venta. " +
        "Está publicada y tiene precio, así que quien reciba su enlace directo sí la puede pedir.",
    };
  }
  return { sale: true, motivo: null };
}

/** Cuántas fichas conoce la tienda. Para que una prueba vea que el archivo se leyó. */
export function cuantasFichas(): number {
  return CON_FICHA.size;
}
