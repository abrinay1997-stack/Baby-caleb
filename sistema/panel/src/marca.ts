/**
 * La marca del panel.
 *
 * Los colores y la tipografía son los de `brand.json` de la raíz, **copiados**
 * aquí a mano. El plan lo pide así (F2.6: «tokens de `brand.json`, copiados con
 * una prueba de que siguen iguales») y la razón es que el panel se construye
 * aparte de la web: si importara el archivo, el build del panel dependería de
 * la raíz y un cambio en la web podría romperlo. La prueba de `marca.test.ts`
 * compara las dos copias y falla si se separan.
 *
 * ---------------------------------------------------------------------------
 * LO QUE NO SE PUEDE COPIAR TAL CUAL: EL CONTRASTE
 * ---------------------------------------------------------------------------
 *
 * El §7i del sistema de diseño del CRM es contrato: «every text token must
 * clear AA (4.5:1) against both --bg and --panel», y «if you change a token,
 * recompute». La tabla de allí es de la paleta OSCURA del CRM; la de Baby Caleb
 * es clara, así que se recalculó. Resultado (medido, no estimado):
 *
 *   fg      #1B3246  sobre bg 12.21 · sobre surface 11.47   ✓ AA
 *   muted   rgba(…)  sobre bg  4.95 · sobre surface  4.80   ✓ AA, sin margen
 *   accent  #EE924A  sobre bg  2.20 · sobre surface  2.06   ✗ ni para texto grande
 *   sage    #91C9A2  sobre bg  1.75 · sobre surface  1.65   ✗
 *
 * Y el que más importa: **`accent-fg` (crema) sobre `accent` (naranja) da
 * 2.20.** `brand.json` propone ese par, y un botón naranja con texto crema es
 * ilegible según AA. El color correcto de texto sobre el naranja es el propio
 * `fg` navy, que da 5.56.
 *
 * De ahí las tres reglas de abajo. No cambian `brand.json` —la marca de la web
 * es la que es y no se toca— sino que dicen cómo usarla en el panel, que es
 * donde la dueña va a leer cifras en un teléfono, a veces con sol.
 */

/** Copiado de `brand.json`. La prueba falla si se separa del original. */
export const MARCA = {
  bg: "#F9F6ED",
  surface: "#F2EFE5",
  fg: "#1B3246",
  muted: "rgba(27, 50, 70, 0.7)",
  line: "rgba(27, 50, 70, 0.12)",
  accent: "#EE924A",
  accentFg: "#F9F6ED",
  sage: "#91C9A2",
} as const;

export const TIPOGRAFIA = {
  display: "Montserrat",
  body: "Montserrat",
  utility: "Montserrat",
  displayWeight: 700,
} as const;

/**
 * Tokens derivados, que existen solo por el contraste.
 *
 *  - `accentTexto`      el naranja de la marca, oscurecido hasta pasar AA sobre
 *                       los dos fondos (4.90 / 4.60). Mismo tono.
 *  - `accentTextoGrande` el mismo, menos oscuro, para texto de 24 px o de
 *                       18.7 px en negrita, donde AA pide 3.0 (3.20 / 3.01).
 *  - `sobreAccent`      lo que se escribe ENCIMA del naranja: el navy, no el
 *                       crema de `brand.json`.
 */
export const DERIVADOS = {
  accentTexto: "#985D2F",
  accentTextoGrande: "#C3783D",
  sobreAccent: MARCA.fg,
} as const;

/**
 * Para qué sirve cada color, que es lo que de verdad hace falta saber al
 * escribir una pantalla.
 */
export const USO = {
  /** Fondo de la página. */
  fondo: MARCA.bg,
  /** Fondo de tarjetas y filas. */
  tarjeta: MARCA.surface,
  /** Todo el texto que se lee. */
  texto: MARCA.fg,
  /** Texto de apoyo: fechas, pistas, etiquetas. Piso de 12 px. */
  apoyo: MARCA.muted,
  /** Bordes y separadores. Nunca texto. */
  linea: MARCA.line,
  /** Relleno de un botón, una barra o un punto de color. NUNCA texto. */
  relleno: MARCA.accent,
  /** Texto encima de `relleno`. */
  sobreRelleno: DERIVADOS.sobreAccent,
  /** Texto en color de marca, sobre el fondo. */
  textoMarca: DERIVADOS.accentTexto,
  /** Lo mismo para titulares grandes. */
  textoMarcaGrande: DERIVADOS.accentTextoGrande,
  /** Verde de la marca. Solo relleno (1.75 sobre el fondo). */
  rellenoBien: MARCA.sage,
} as const;

// ---------------------------------------------------------------------------
// Las medidas del §7 del sistema de diseño del CRM, que es contrato
// ---------------------------------------------------------------------------

/**
 * Un solo punto de quiebre. «Don't add a second one without a reason you can
 * write down — every extra breakpoint is a layout nobody tests.»
 */
export const TELEFONO_MAX_PX = 767;

export const TIPOS = {
  /** Título de página o de sección. 700. */
  titulo: 17,
  /** Lo que se lee: filas, párrafos. */
  cuerpo: 15,
  /** Apoyo: fechas, pistas, etiquetas de pestaña. **Piso, nunca menos.** */
  apoyo: 12,
  /** Cifras grandes. No 38: en un teléfono se parte. */
  cifra: 32,
  /**
   * Campos, áreas de texto y selectores. **Obligatorio.**
   *
   * Por debajo de 16 px, Safari de iPhone hace zoom a la página al enfocar y la
   * deja descuadrada. No es una preferencia: es la diferencia entre que la
   * dueña conteste un pedido y que pelee con el viewport.
   */
  campo: 16,
} as const;

/** Todo lo que se toca mide al menos esto. El relleno cuenta para la caja. */
export const TACTIL_MIN_PX = 44;

/** `<main>` en el teléfono. 26 px es el 13 % de una pantalla de 390 px. */
export const RELLENO_MAIN_TELEFONO_PX = 14;

// ---------------------------------------------------------------------------
// Contraste, para que la prueba lo pueda medir
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/** Resuelve un color de la paleta a RGB, aplanando el alfa sobre un fondo. */
export function aRgb(color: string, fondo: Rgb = [255, 255, 255]): Rgb {
  if (color.startsWith("#")) {
    const n = color.slice(1);
    const v = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16));
    return [v[0]!, v[1]!, v[2]!];
  }
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) throw new Error(`color que no se entiende: ${color}`);
  const p = m[1]!.split(",").map((x) => Number.parseFloat(x.trim()));
  const a = p[3] ?? 1;
  return [
    p[0]! * a + fondo[0] * (1 - a),
    p[1]! * a + fondo[1] * (1 - a),
    p[2]! * a + fondo[2] * (1 - a),
  ];
}

function luminancia(rgb: Rgb): number {
  const c = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** Contraste WCAG 2.1 de `frente` sobre `fondo`, los dos de la paleta. */
export function contraste(frente: string, fondo: string): number {
  const f = aRgb(fondo);
  const a = luminancia(aRgb(frente, f));
  const b = luminancia(f);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Los mínimos de AA: 4.5 para texto normal, 3.0 para texto grande. */
export const AA_TEXTO = 4.5;
export const AA_GRANDE = 3.0;
