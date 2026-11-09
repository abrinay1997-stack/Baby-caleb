import { type Zona, buscarZona, sugerirZonas } from "./zonas";

/**
 * De lo que devuelve un geocodificador a los campos del formulario.
 *
 * Portado de `packages/domain/src/direccion.ts` de Nébula, con los campos de
 * Baby Caleb: aquí una dirección es `texto` (calle, casa o edificio, piso),
 * `referencia` y una `zona_id` elegida de una lista — no «ciudad» y «provincia»
 * sueltas. Lo que el geocodificador llama ciudad sirve para SUGERIR la zona,
 * que es quien manda la tarifa.
 *
 * POR QUÉ HACE FALTA TRADUCIR
 *
 * Nominatim —y cualquier otro— devuelve la jerarquía administrativa completa de
 * OpenStreetMap: `state`, `county`, `city`, `suburb`, `neighbourhood`, `road`,
 * `house_number` y unas cuantas más. El formulario tiene tres cosas. Nadie más
 * que esta función debería saber cómo se pasa de lo uno a lo otro.
 *
 * LA JERARQUÍA PANAMEÑA NO ES LA DE OSM
 *
 * En Panamá el orden real es provincia → distrito → corregimiento. En OSM eso
 * cae, casi siempre, en `state` → `county` → `city`/`town`/`village`. Pero no
 * siempre: en Ciudad de Panamá el corregimiento aparece unas veces como `city`
 * y otras como `suburb`, y en zonas rurales el distrito puede faltar. Por eso
 * cada campo se resuelve con una lista de candidatos en orden de preferencia y
 * no con una sola clave.
 *
 * ES PURA A PROPÓSITO
 *
 * La decisión de qué texto acaba sugiriendo qué zona es la que más se va a
 * corregir cuando lleguen direcciones reales, y tiene que poder corregirse
 * contra una batería de ejemplos guardados, sin red y sin mapa.
 */

/** La parte de una respuesta de geocodificación que sí interesa. */
export interface PartesDeDireccion {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  residential?: string;
  neighbourhood?: string;
  quarter?: string;
  suburb?: string;
  city_district?: string;
  village?: string;
  town?: string;
  city?: string;
  county?: string;
  municipality?: string;
  state?: string;
  region?: string;
  postcode?: string;
  country_code?: string;
}

export interface DireccionAproximada {
  /** Calle y número, o lo más parecido que haya. Va a `direcciones.texto`. */
  texto: string;
  /** Corregimiento o distrito: con esto se busca la zona de envío. */
  ciudad: string;
  /** Provincia, sin el «Provincia de» delante. */
  provincia: string;
  /** El texto completo tal cual, para enseñarlo como confirmación. */
  etiqueta: string;
}

/** Las nueve provincias más las tres comarcas, escritas como se escriben. */
const PROVINCIAS = [
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

function primeroConTexto(...candidatos: (string | undefined)[]): string {
  for (const c of candidatos) {
    const limpio = c?.trim();
    if (limpio) return limpio;
  }
  return "";
}

/**
 * Quita los prefijos administrativos que OSM arrastra y el formulario no quiere.
 * «Distrito de Panamá» y «Provincia de Panamá» son correctos en un mapa y
 * ruidosos en una etiqueta de envío: quien la lee quiere leer «Panamá».
 */
function sinPrefijoAdministrativo(valor: string): string {
  return valor
    .replace(/^(provincia|distrito|corregimiento|comarca|municipio)\s+de\s+/i, "")
    .replace(/^(provincia|distrito|corregimiento|comarca|municipio)\s+/i, "")
    .trim();
}

const aplanar = (t: string): string =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Normaliza la provincia contra la lista real del país.
 *
 * Si lo que llega se parece a una provincia conocida se devuelve escrita como
 * toca —con sus tildes— y si no, se devuelve tal cual: una comarca nueva o un
 * cambio administrativo no debe vaciar el campo.
 */
export function normalizarProvincia(valor: string): string {
  const limpio = sinPrefijoAdministrativo(valor);
  if (!limpio) return "";
  return PROVINCIAS.find((p) => aplanar(p) === aplanar(limpio)) ?? limpio;
}

/**
 * Reparte una dirección geocodificada en los campos del formulario.
 *
 * Lo que no se pueda resolver se devuelve vacío, nunca inventado: un campo en
 * blanco lo rellena la clienta en dos segundos, y una calle equivocada la
 * descubre el motorizado en la puerta de otra casa.
 */
export function repartirDireccion(
  partes: PartesDeDireccion | undefined,
  etiqueta: string,
): DireccionAproximada {
  const p = partes ?? {};

  const via = primeroConTexto(p.road, p.pedestrian, p.residential);
  const barrio = primeroConTexto(p.neighbourhood, p.quarter, p.suburb, p.city_district);

  // La calle con su número si lo hay; si no hay calle, el barrio hace de
  // dirección, que es exactamente lo que escribiría a mano quien vive ahí.
  const texto = via ? [via, p.house_number?.trim()].filter(Boolean).join(" ") : barrio;

  // Si el barrio ya se gastó como dirección no se repite en «ciudad»: dos veces
  // el mismo texto en la etiqueta de envío parece un error de la tienda.
  const ciudadCruda = primeroConTexto(
    p.city,
    p.town,
    p.village,
    via ? barrio : undefined,
    p.county,
    p.municipality,
  );

  return {
    texto,
    ciudad: sinPrefijoAdministrativo(ciudadCruda),
    provincia: normalizarProvincia(primeroConTexto(p.state, p.region)),
    etiqueta: etiqueta.trim(),
  };
}

/** ¿Trae algo que merezca la pena volcar en el formulario? */
export function tieneAlgoQueRellenar(d: DireccionAproximada): boolean {
  return Boolean(d.texto || d.ciudad || d.provincia);
}

export interface ZonaSugerida {
  /** La zona, si el texto dio una respuesta inequívoca. */
  zona: Zona | null;
  /** Candidatas para que la clienta elija, cuando no hay una sola clara. */
  candidatas: Zona[];
}

/**
 * Propone la zona de envío a partir de una dirección geocodificada.
 *
 * Propone; no decide. La zona fija la tarifa, así que acertarla por casualidad
 * es tan malo como fallarla: si no hay una coincidencia exacta de nombre o
 * alias, se devuelven candidatas y elige la clienta. Se prueba primero con el
 * barrio o corregimiento y después con el distrito, que es el orden en que se
 * parecen a los nombres del tarifario.
 */
export function sugerirZonaDeEnvio(
  d: DireccionAproximada,
  zonas: readonly Zona[],
): ZonaSugerida {
  for (const texto of [d.ciudad, d.provincia]) {
    if (!texto) continue;
    const exacta = buscarZona(texto, zonas);
    if (exacta) return { zona: exacta, candidatas: [exacta] };
  }

  const candidatas = d.ciudad ? sugerirZonas(d.ciudad, zonas) : [];
  return { zona: null, candidatas };
}
