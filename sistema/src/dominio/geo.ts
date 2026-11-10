/**
 * Coordenadas, precisión del punto y enlaces de navegación.
 *
 * Portado de `packages/domain/src/geo.ts` de Nébula. Todo lo de aquí es puro, a
 * propósito: decidir si un punto es creíble afecta a si se manda a alguien a
 * una dirección, y eso tiene que poder probarse sin red y sin mapa.
 *
 * La convención de orden es la de GeoJSON —`[lng, lat]`— en los polígonos, y
 * `{ lat, lng }` con nombre en los puntos. Mezclar las dos sin darse cuenta es
 * el error clásico de todo código que toca mapas, y por eso los polígonos van
 * en posiciones y los puntos con nombre: no se pueden confundir.
 */

export interface Punto {
  lat: number;
  lng: number;
}

/**
 * De dónde salió el punto. Importa tanto como el punto.
 * Son los valores del CHECK de `direcciones.precision` (02-datos.md §4);
 * «geocodificado» se escribe así y no «geocoded» como en Nébula.
 */
export const PRECISIONES = ["gps", "pin", "geocodificado", "manual"] as const;

export type Precision = (typeof PRECISIONES)[number];

export const ETIQUETAS_PRECISION: Record<Precision, string> = {
  gps: "Ubicación del dispositivo",
  pin: "Marcada en el mapa",
  geocodificado: "Deducida de la búsqueda",
  manual: "Escrita a mano",
};

export const esPrecision = (v: string): v is Precision =>
  (PRECISIONES as readonly string[]).includes(v);

/**
 * Qué tan fiable es cada origen, de más a menos. Lo usa la guía del motorizado
 * para avisar cuando el punto es flojo (01-arquitectura.md §6).
 */
const CONFIANZA: Record<Precision, number> = { gps: 3, pin: 2, geocodificado: 1, manual: 0 };

export function esPuntoConfiable(p: Precision): boolean {
  return CONFIANZA[p] >= CONFIANZA.pin;
}

/**
 * Caja que envuelve Panamá, con margen.
 *
 * No se usa para prohibir: se usa para avisar. Un punto fuera de aquí casi
 * siempre es un error de captura —coordenadas invertidas, un cero de más— y
 * conviene decirlo antes de mandar a alguien.
 */
export const LIMITES_PANAMA = {
  latMin: 7.0,
  latMax: 9.8,
  lngMin: -83.2,
  lngMax: -77.0,
} as const;

/** Centro aproximado de Ciudad de Panamá: dónde abrir el mapa sin permiso. */
export const CENTRO_CIUDAD_PANAMA: Punto = { lat: 8.9824, lng: -79.5199 };

export function esPuntoValido(p: Punto): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

export function estaEnPanama(p: Punto): boolean {
  if (!esPuntoValido(p)) return false;
  return (
    p.lat >= LIMITES_PANAMA.latMin &&
    p.lat <= LIMITES_PANAMA.latMax &&
    p.lng >= LIMITES_PANAMA.lngMin &&
    p.lng <= LIMITES_PANAMA.lngMax
  );
}

/**
 * Redondea a siete decimales, que son unos 11 mm: más que suficiente para una
 * puerta y suficiente para que el valor que se muestra tras guardar sea igual
 * al que se envió, y no parezca que el mapa «movió» el punto solo.
 */
export function redondearCoordenada(valor: number): number {
  return Math.round(valor * 1e7) / 1e7;
}

/** Un anillo de polígono en orden GeoJSON: `[lng, lat]`. */
export type Anillo = readonly (readonly [number, number])[];

/**
 * ¿Cae el punto dentro del polígono? Algoritmo de cruce de rayos: se lanza un
 * rayo horizontal y se cuentan los lados que cruza — impar dentro, par fuera.
 *
 * Los puntos justo sobre el borde son ambiguos por naturaleza, así que no se
 * promete nada sobre ellos.
 *
 * **Baby Caleb no cobra por polígono**: su tarifario es por nombre de zona (ver
 * `zonas.ts`). Esto se conserva porque el plan lo dice explícitamente —«si en el
 * futuro se dibujan polígonos, la función ya existe» (01-arquitectura.md §6)— y
 * porque cuesta nada tenerlo probado.
 */
export function puntoEnPoligono(p: Punto, anillo: Anillo): boolean {
  if (anillo.length < 3) return false; // un polígono necesita tres vértices
  if (!esPuntoValido(p)) return false;

  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i, i += 1) {
    const actual = anillo[i];
    const anterior = anillo[j];
    if (!actual || !anterior) continue;

    const [xi, yi] = actual;
    const [xj, yj] = anterior;

    const cruzaLaHorizontal = yi > p.lat !== yj > p.lat;
    if (!cruzaLaHorizontal) continue;

    const corte = ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (p.lng < corte) dentro = !dentro;
  }
  return dentro;
}

/**
 * Lee un polígono tal y como venga de una columna de texto JSON.
 *
 * Un anillo a medio leer es peor que uno vacío: haría que `puntoEnPoligono`
 * respondiera que sí a puntos que no.
 */
export function leerPoligono(valor: unknown): Anillo {
  if (!Array.isArray(valor)) return [];
  const anillo: [number, number][] = [];
  for (const par of valor) {
    if (!Array.isArray(par) || par.length < 2) return [];
    const [lng, lat] = par;
    if (typeof lng !== "number" || typeof lat !== "number") return [];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [];
    anillo.push([lng, lat]);
  }
  return anillo.length >= 3 ? anillo : [];
}

/**
 * Enlaces de navegación para quien entrega.
 *
 * Se devuelven las dos apps y no una: en Panamá Waze es lo que usa la mayoría de
 * motorizados, pero no todos lo tienen. Quien entrega elige, y por eso la guía
 * lleva los dos botones y no un mapa concreto — un `geo:` crudo abre lo que
 * decida el teléfono, y en muchos no abre nada.
 */
export function enlacesDeNavegacion(p: Punto): { waze: string; googleMaps: string } | null {
  if (!esPuntoValido(p)) return null;
  const lat = redondearCoordenada(p.lat);
  const lng = redondearCoordenada(p.lng);
  return {
    waze: `https://waze.com/ul?ll=${lat}%2C${lng}&navigate=yes`,
    googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lng}`,
  };
}
