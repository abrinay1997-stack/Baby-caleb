import { type Punto, esPuntoValido } from "./geo";

/**
 * En qué orden conviene hacer las entregas.
 *
 * Portado de `packages/domain/src/rutas.ts` de Nébula, sin cambios de fondo: el
 * razonamiento es el mismo y la ciudad también es Panamá.
 *
 * QUÉ ES ESTO Y QUÉ NO ES
 *
 * Es distancia **en línea recta** entre puntos, no distancia de conducción. En
 * una ciudad con sentidos únicos, retornos cada kilómetro y un canal por el
 * medio, eso es una aproximación y hay que decirlo: **no es un servicio de
 * rutas**. Dos paradas a trescientos metros en línea recta pueden estar a
 * quince minutos si hay que cruzar un puente.
 *
 * Lo que sí es: mejor que «las voy haciendo según me quedan». Un motorizado con
 * ocho entregas no compara 40 320 órdenes posibles en la cabeza; sale y va
 * viendo. Esto propone un orden razonable en un milisegundo y quien reparte lo
 * cambia si conoce el barrio mejor — que suele conocerlo.
 *
 * Por eso la función se llama «proponer» y no «optimizar», y por eso devuelve el
 * ahorro estimado: para que quien decide vea si merece la pena hacerle caso.
 *
 * CUÁNDO CAMBIAR ESTO POR UN SERVICIO DE VERDAD
 *
 * Cuando el volumen lo justifique. La señal no es «tenemos muchas entregas»,
 * sino que quien reparte esté ignorando sistemáticamente el orden propuesto: eso
 * significa que la línea recta está mintiendo demasiado en esta ciudad.
 */

/** Radio medio de la Tierra, en kilómetros. */
const RADIO_TERRESTRE_KM = 6371;

const aRadianes = (grados: number): number => (grados * Math.PI) / 180;

/**
 * Distancia en línea recta entre dos puntos, en kilómetros.
 *
 * Haversine y no una aproximación plana. Panamá está cerca del ecuador, donde el
 * error de tratar la Tierra como un plano es pequeño, pero «pequeño» depende de
 * la latitud y esta función no debería tener una latitud favorita.
 */
export function distanciaKm(a: Punto, b: Punto): number {
  if (!esPuntoValido(a) || !esPuntoValido(b)) return Number.POSITIVE_INFINITY;

  const dLat = aRadianes(b.lat - a.lat);
  const dLng = aRadianes(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRadianes(a.lat)) * Math.cos(aRadianes(b.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * RADIO_TERRESTRE_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Parada {
  id: string;
  /** Sin coordenada no se puede ordenar. Ver `sinUbicar`. */
  punto: Punto | null;
}

export interface RutaPropuesta {
  /** Las paradas con coordenada, en el orden propuesto. */
  orden: Parada[];
  /**
   * Las que no tienen punto en el mapa.
   *
   * No se colocan «al final» como si fueran la última entrega: se devuelven
   * aparte, porque no son un problema de orden sino de datos. Quien reparte va a
   * tener que llamar por teléfono para encontrarlas, y eso se planifica distinto.
   */
  sinUbicar: Parada[];
  /** Kilómetros del recorrido propuesto, sin contar la vuelta al origen. */
  distanciaKm: number;
  /** Lo que medía el orden en que llegaron, para poder comparar. */
  distanciaOriginalKm: number;
}

function largoDeRuta(origen: Punto, paradas: readonly Parada[]): number {
  let total = 0;
  let actual = origen;
  for (const parada of paradas) {
    if (!parada.punto) continue;
    total += distanciaKm(actual, parada.punto);
    actual = parada.punto;
  }
  return total;
}

/**
 * Vecino más cercano: desde donde estés, ve a la parada más próxima.
 *
 * Su defecto es conocido: arrastra las decisiones tempranas, así que puede dejar
 * una parada olvidada lejos y obligar a un viaje largo al final. Por eso después
 * pasa por `mejorarCruces`.
 */
function vecinoMasCercano(origen: Punto, paradas: readonly Parada[]): Parada[] {
  const pendientes = [...paradas];
  const orden: Parada[] = [];
  let actual = origen;

  while (pendientes.length > 0) {
    let mejor = 0;
    let mejorDistancia = Number.POSITIVE_INFINITY;

    for (let i = 0; i < pendientes.length; i += 1) {
      const punto = pendientes[i]?.punto;
      if (!punto) continue;
      const d = distanciaKm(actual, punto);
      if (d < mejorDistancia) {
        mejorDistancia = d;
        mejor = i;
      }
    }

    const siguiente = pendientes.splice(mejor, 1)[0];
    if (!siguiente?.punto) continue;
    orden.push(siguiente);
    actual = siguiente.punto;
  }

  return orden;
}

/**
 * Deshace los cruces que deja el vecino más cercano (2-opt).
 *
 * Si la ruta se cruza consigo misma, invertir el tramo entre los dos cruces
 * siempre la acorta — es geometría, no heurística. Son veinte líneas y quita
 * buena parte de lo que el vecino más cercano hace mal.
 *
 * El tope de vueltas es un cortacircuitos: con las decenas de paradas de un día
 * de reparto converge en dos o tres, pero esto corre dentro de una petición y no
 * puede depender de que siempre converja.
 */
function mejorarCruces(origen: Punto, orden: Parada[], maxVueltas = 20): Parada[] {
  let actual = [...orden];

  for (let vuelta = 0; vuelta < maxVueltas; vuelta += 1) {
    let mejoro = false;

    for (let i = 0; i < actual.length - 1; i += 1) {
      for (let j = i + 1; j < actual.length; j += 1) {
        const candidato = [
          ...actual.slice(0, i),
          ...actual.slice(i, j + 1).reverse(),
          ...actual.slice(j + 1),
        ];
        if (largoDeRuta(origen, candidato) < largoDeRuta(origen, actual) - 1e-9) {
          actual = candidato;
          mejoro = true;
        }
      }
    }

    if (!mejoro) return actual;
  }

  return actual;
}

/**
 * Propone el orden de una ruta.
 *
 * `origen` es de donde sale quien reparte: la bodega, o dónde está ahora. No se
 * cierra el circuito de vuelta al origen a propósito — un motorizado no vuelve a
 * la bodega después de la última entrega, se va a su casa.
 */
export function proponerRuta(origen: Punto, paradas: readonly Parada[]): RutaPropuesta {
  const ubicadas = paradas.filter((p) => p.punto && esPuntoValido(p.punto));
  const sinUbicar = paradas.filter((p) => !ubicadas.includes(p));

  const orden = mejorarCruces(origen, vecinoMasCercano(origen, ubicadas));

  return {
    orden,
    sinUbicar,
    distanciaKm: largoDeRuta(origen, orden),
    distanciaOriginalKm: largoDeRuta(origen, ubicadas),
  };
}

/**
 * ¿Merece la pena reordenar?
 *
 * Devuelve el ahorro en kilómetros y en porcentaje. Por debajo de un ahorro
 * pequeño no se debería insistir: quien reparte conoce el barrio, y discutirle
 * el orden por doscientos metros es cómo se consigue que ignore la pantalla
 * entera.
 */
export function ahorroDeLaRuta(ruta: RutaPropuesta): { km: number; porcentaje: number } {
  const km = ruta.distanciaOriginalKm - ruta.distanciaKm;
  return {
    km,
    porcentaje: ruta.distanciaOriginalKm > 0 ? (km / ruta.distanciaOriginalKm) * 100 : 0,
  };
}
