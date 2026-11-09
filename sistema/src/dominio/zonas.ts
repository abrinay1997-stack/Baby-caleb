import { type Resultado, fallo } from "../contrato/resultado";
import type { Centavos } from "./dinero";

/**
 * Zonas de envío: búsqueda por nombre y alias, y la cotización.
 *
 * Esto NO viene de Nébula, y es a propósito. Nébula cobra el envío por polígono
 * (`findZoneForPoint`); el tarifario de Baby Caleb es **por nombre de zona**
 * (01-arquitectura.md §6): la clienta elige «Tocumen» de una lista con búsqueda,
 * y el pin del mapa es para que el motorizado encuentre la puerta, no para
 * decidir el precio. Las tarifas salen de `member/zonas-envio.ts` del CRM, que a
 * su vez sale del documento de la dueña.
 *
 * Por eso lo que hace falta aquí es buscar texto bien —«tocumen», «Tocúmen»,
 * «24 de diciembre» escrito de seis maneras— y no geometría.
 */

export interface Zona {
  id: string;
  nombre: string;
  /** Otras formas de escribirla, de `zonas_envio.alias_json`. */
  alias: readonly string[];
  region: "ciudad" | "interior";
  metodo: "motorizado" | "ferguson" | "otro";
  /** null = se cotiza a mano. No es gratis: es que todavía no se sabe. */
  tarifa_cents: Centavos | null;
  requiere_pago_total: boolean;
  activa: boolean;
}

/**
 * Deja un texto comparable: sin tildes, sin mayúsculas, sin puntuación y con
 * los espacios colapsados. «Tocúmen », «TOCUMEN» y «tocumen» son la misma zona,
 * y quien escribe por WhatsApp no pone tildes.
 *
 * La ñ también se pliega a n, y es a propósito: quien escribe deprisa tampoco
 * pone la ñ, así que «pena blanca» tiene que encontrar «Peña Blanca». Se pierde
 * la distinción entre dos zonas que solo difieran en la ñ; ninguna del
 * tarifario lo hace, y si algún día la hubiera, `buscarZona` devuelve null ante
 * dos coincidencias en vez de elegir a la suerte.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const nombresDe = (z: Zona): string[] => [z.nombre, ...z.alias];

/**
 * Palabras con peso de un texto ya normalizado. Se dejan fuera las de tres
 * letras o menos («de», «la», «24»), que aparecen en todas partes y no
 * distinguen nada.
 */
const palabrasConPeso = (plano: string): string[] =>
  plano.split(" ").filter((p) => p.length >= 4);

/**
 * La zona que corresponde exactamente a lo que se escribió, por nombre o por
 * alias. Devuelve null si no hay una sola respuesta clara: adivinar la zona es
 * adivinar la tarifa.
 */
export function buscarZona(texto: string, zonas: readonly Zona[]): Zona | null {
  const buscado = normalizar(texto);
  if (!buscado) return null;

  const activas = zonas.filter((z) => z.activa);
  const exactas = activas.filter((z) => nombresDe(z).some((n) => normalizar(n) === buscado));

  // Si dos zonas activas responden al mismo texto, el dato está mal y hay que
  // arreglarlo, no elegir una.
  return exactas.length === 1 ? exactas[0]! : null;
}

/**
 * Candidatas para la lista con búsqueda del checkout.
 *
 * Ordena: primero lo que empieza por lo escrito, después lo que lo contiene, y
 * dentro de cada grupo por nombre. Así escribir «pan» pone «Panamá» antes que
 * «Juan Díaz, frente al Panadería».
 */
export function sugerirZonas(texto: string, zonas: readonly Zona[], maximo = 8): Zona[] {
  const buscado = normalizar(texto);
  const activas = zonas.filter((z) => z.activa);
  if (!buscado) {
    return [...activas].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).slice(0, maximo);
  }

  // Las dos últimas reglas existen porque esto no solo lo usa una caja de
  // búsqueda donde se escribe de a poco, sino también `sugerirZonaDeEnvio` con
  // lo que devuelve el geocodificador, que son nombres largos y con variantes:
  // «Diciembre Alto» tiene que proponer «24 de Diciembre». Puntúan lo más bajo
  // y solo cuentan palabras de cuatro letras o más, para que «de» o «la» no
  // hagan coincidir media ciudad.
  const palabrasBuscadas = new Set(palabrasConPeso(buscado));

  const puntaje = (z: Zona): number => {
    let mejor = 0;
    for (const n of nombresDe(z)) {
      const plano = normalizar(n);
      if (plano === buscado) mejor = Math.max(mejor, 5);
      else if (plano.startsWith(buscado)) mejor = Math.max(mejor, 4);
      else if (plano.includes(buscado)) mejor = Math.max(mejor, 3);
      // Al revés: que el texto contenga el nombre entero de la zona.
      else if (plano.length >= 4 && buscado.includes(plano)) mejor = Math.max(mejor, 2);
      // O que compartan alguna palabra con peso.
      else if (palabrasConPeso(plano).some((p) => palabrasBuscadas.has(p))) {
        mejor = Math.max(mejor, 1);
      }
    }
    return mejor;
  };

  return activas
    .map((z) => ({ z, p: puntaje(z) }))
    .filter((c) => c.p > 0)
    .sort((a, b) => b.p - a.p || a.z.nombre.localeCompare(b.z.nombre, "es"))
    .slice(0, maximo)
    .map((c) => c.z);
}

export interface Cotizacion {
  zona_id: string;
  zona: string;
  tarifa_cents: Centavos;
  metodo: Zona["metodo"];
  requiere_pago_total: boolean;
}

/**
 * Cuánto cuesta el envío a esta zona.
 *
 * Una zona con `tarifa_cents = null` NO vale cero: es del interior y se cotiza a
 * mano. Devolver cero ahí sería regalar el envío, así que se devuelve un fallo
 * con un código que la web y el bot pueden traducir a «le cotizamos el envío y
 * le confirmamos» en vez de a un precio inventado.
 *
 * Ferguson exige pago total (`requiere_pago_total`), y eso viaja con la
 * cotización porque es lo que decide si el pedido admite abono.
 */
export function cotizarEnvio(zona: Zona): Resultado<Cotizacion> {
  if (!zona.activa) {
    return fallo("no_encontrado", `Ahora mismo no estamos entregando en ${zona.nombre}.`);
  }
  if (zona.tarifa_cents === null) {
    return fallo(
      "entrada_invalida",
      `El envío a ${zona.nombre} se cotiza a mano: le confirmamos el costo antes de cerrar el pedido.`,
    );
  }
  return {
    ok: true,
    zona_id: zona.id,
    zona: zona.nombre,
    tarifa_cents: zona.tarifa_cents,
    metodo: zona.metodo,
    requiere_pago_total: zona.requiere_pago_total,
  };
}

/** ¿Este pedido admite abono, o hay que cobrarlo entero? */
export function exigePagoTotal(zona: Zona): boolean {
  return zona.requiere_pago_total || zona.metodo === "ferguson";
}
