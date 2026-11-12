import type { Decision } from "./consentimiento";

/**
 * El píxel de Meta, detrás de un interruptor y de un consentimiento.
 *
 * ## Las DOS llaves, y las dos tienen que estar
 *
 *  1. **El interruptor del despliegue.** El identificador del píxel llega en
 *     una variable de configuración (`META_PIXEL_ID` en `wrangler.jsonc`), que
 *     el Worker escribe en el `<head>` como `<meta name="meta-pixel-id">`.
 *     Vacía o ausente, no hay identificador y aquí no se carga nada. Así la
 *     web se puede desplegar con todo esto dentro y el píxel apagado.
 *  2. **El sí de la persona.** Sin decisión, o con «rechazado», no se carga.
 *
 *  Las dos son necesarias y ninguna es suficiente. Eso se comprueba en
 *  `test/consentimiento.test.ts`, y la prueba que importa es la del NO.
 *
 * ## Por qué el identificador llega por el `<head>` y no compilado
 *
 * Porque así encenderlo no exige volver a construir el sitio: se cambia la
 * variable, se despliega el Worker y ya. Y porque un identificador compilado
 * dentro del JavaScript estaría ahí —legible— aunque el píxel esté apagado,
 * que es justo lo que no se quiere mientras no haya consentimiento de nadie.
 *
 * ## Por qué `entorno` entra por parámetro
 *
 * Para poder probar esta función de verdad. Las pruebas de la web corren en
 * Node, donde no hay `document`: si esto leyera el DOM por su cuenta, la única
 * prueba posible sería de una capa de abajo, y la trampa §6 de
 * `docs/TRAMPAS.md` es exactamente esa —una prueba que no cruza la guarda no
 * vigila la guarda—. Con el entorno por parámetro, la prueba llama a ESTA
 * función, la misma que llama el banner, y mira si colgó algo o no.
 */

/** El identificador de este `<script>`, para no colgarlo dos veces. */
export const ID_DEL_SCRIPT = "meta-pixel";

/** De dónde sale el píxel. Es de Meta: por eso hace falta el permiso. */
export const FUENTE = "https://connect.facebook.net/en_US/fbevents.js";

/** El nombre de la `<meta>` por la que el Worker pasa el identificador. */
export const META_DEL_PIXEL = "meta-pixel-id";

/**
 * Un identificador de píxel es un número largo, y nada más.
 *
 * Se valida ANTES de usarlo por la misma razón que el token de la analítica en
 * `worker/head.ts`: este valor viene de la configuración y acaba dentro de una
 * URL y de una llamada a una biblioteca de terceros. Que hoy lo escriba una
 * persona de confianza no cambia lo que pasa si un día se pega mal.
 *
 * El rango de 10 a 20 cifras es una baranda contra el dedo gordo, no una
 * especificación de Meta: los identificadores que se ven tienen 15 o 16. No se
 * ajusta más porque Meta no publica el formato y adivinarlo rechazaría un
 * píxel de verdad.
 */
const ID_VALIDO = /^\d{10,20}$/;

export const esIdDePixel = (v: string): boolean => ID_VALIDO.test(v.trim());

// ---------------------------------------------------------------------------
// El entorno: lo MÍNIMO del navegador que hace falta
// ---------------------------------------------------------------------------

/** Lo que `fbevents.js` espera encontrar ya puesto en la ventana. */
type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[];
  push?: unknown;
  loaded?: boolean;
  version?: string;
};

export interface VentanaDelPixel {
  fbq?: Fbq;
  _fbq?: Fbq;
}

export interface ScriptDelPixel {
  id: string;
  async: boolean;
  src: string;
}

export interface DocumentoDelPixel {
  getElementById(id: string): unknown;
  querySelector(selector: string): { getAttribute(nombre: string): string | null } | null;
  createElement(etiqueta: "script"): ScriptDelPixel;
  head: { appendChild(nodo: ScriptDelPixel): void };
}

export interface EntornoDelPixel {
  readonly ventana: VentanaDelPixel;
  readonly documento: DocumentoDelPixel;
}

/** El entorno de verdad. Solo existe en el navegador. */
export const entornoDelNavegador = (): EntornoDelPixel => ({
  ventana: window as unknown as VentanaDelPixel,
  documento: document as unknown as DocumentoDelPixel,
});

// ---------------------------------------------------------------------------
// La decisión, en un sitio y explicada
// ---------------------------------------------------------------------------

export interface Resultado {
  /** `true` solo si se colgó el `<script>` de Meta. */
  readonly cargado: boolean;
  /** Por qué. Se devuelve siempre, también cuando sí se cargó. */
  readonly motivo:
    | "cargado"
    | "ya_estaba"
    | "sin_decision"
    | "rechazado"
    | "sin_id"
    | "id_invalido";
}

/**
 * El identificador que el Worker dejó en el `<head>`, o `null`.
 *
 * Que la etiqueta no exista es el caso NORMAL mientras el píxel esté apagado:
 * `worker/head.ts` no la escribe si la variable está vacía.
 */
export function idDelPixelDe(documento: DocumentoDelPixel): string | null {
  const etiqueta = documento.querySelector(`meta[name="${META_DEL_PIXEL}"]`);
  const valor = (etiqueta?.getAttribute("content") ?? "").trim();
  return valor === "" ? null : valor;
}

/**
 * Si el píxel ya está colgado en ESTA página.
 *
 * Hace falta para que retirar el permiso signifique algo de verdad. El caso:
 * alguien aceptó, el `fbevents.js` de Meta ya está cargado y corriendo, y
 * entonces abre «Cookies y rastreo» y elige «No permitir». Guardar el «no»
 * impide que vuelva a cargar mañana, pero NO descarga lo que ya está en la
 * página: un `<script>` no se puede desejecutar quitando su etiqueta, y `fbq`
 * sigue definido con su cola dentro.
 *
 * O sea que sin esto, «rechazar» no empezaría a valer hasta la siguiente
 * recarga, y durante el resto de la visita Meta seguiría recibiendo. Quien lo
 * acaba de rechazar no tiene por qué saber que hay que recargar.
 *
 * Lo que se hace con esto está en `BannerConsentimiento`: recargar la página.
 * Es brusco y es lo único que de verdad lo apaga.
 */
export const pixelYaCargado = (documento: DocumentoDelPixel): boolean =>
  documento.getElementById(ID_DEL_SCRIPT) !== null;

/**
 * Carga el píxel de Meta, si y solo si se puede.
 *
 * Esta es la guarda. Todo lo que decide si Meta se entera de que alguien pasó
 * por la página está en estas líneas, a propósito: una decisión repartida en
 * tres archivos es una decisión que nadie puede leer de un golpe.
 *
 * No lanza nunca. Un fallo al cargar una herramienta de medición no puede
 * tumbar una tienda.
 */
export function activarPixel(decision: Decision | null, entorno: EntornoDelPixel): Resultado {
  // --- La guarda del consentimiento ---------------------------------------
  // Va PRIMERO y antes de mirar la configuración: sin un sí, lo que diga la
  // configuración no importa.
  if (decision === null) return { cargado: false, motivo: "sin_decision" };
  if (decision === "rechazado") return { cargado: false, motivo: "rechazado" };

  // --- La guarda del interruptor ------------------------------------------
  const id = idDelPixelDe(entorno.documento);
  if (id === null) return { cargado: false, motivo: "sin_id" };
  if (!esIdDePixel(id)) {
    // Un identificador mal pegado no se usa. Una medición que no cuenta es un
    // problema pequeño; mandarle a Meta llamadas con basura dentro, no.
    console.warn(
      JSON.stringify({
        evento: "pixel_id_invalido",
        detalle: "el identificador del píxel no es un número de 10 a 20 cifras; no se carga",
      }),
    );
    return { cargado: false, motivo: "id_invalido" };
  }

  // Colgarlo dos veces contaría dos visitas por una. Pasa al aceptar en la
  // misma pestaña en la que ya se había aceptado antes de recargar.
  if (pixelYaCargado(entorno.documento)) {
    return { cargado: false, motivo: "ya_estaba" };
  }

  // --- A partir de aquí sí se carga ---------------------------------------
  const ventana = entorno.ventana;

  // El «stub» de `fbq`: la cola donde se apuntan las llamadas hechas antes de
  // que el archivo de Meta acabe de bajar. Es lo que hace el fragmento oficial
  // de Meta, escrito aquí de forma legible en vez de pegado minificado — un
  // bloque ilegible dentro de un archivo es un bloque que nadie revisa.
  if (ventana.fbq === undefined) {
    const cola: unknown[] = [];
    const fbq: Fbq = (...args: unknown[]): void => {
      if (fbq.callMethod !== undefined) fbq.callMethod(...args);
      else cola.push(args);
    };
    fbq.queue = cola;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    ventana.fbq = fbq;
    ventana._fbq ??= fbq;
  }

  const script = entorno.documento.createElement("script");
  script.id = ID_DEL_SCRIPT;
  script.async = true;
  script.src = FUENTE;
  entorno.documento.head.appendChild(script);

  ventana.fbq?.("init", id);
  ventana.fbq?.("track", "PageView");

  return { cargado: true, motivo: "cargado" };
}
