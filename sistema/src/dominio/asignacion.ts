import type { Punto } from "./geo";
import { type EstadoMotorizado, puedeRecibirEntregas } from "./motorizado";
import { distanciaKm } from "./rutas";

/**
 * A quién conviene darle esta entrega.
 *
 * Portado de `packages/domain/src/asignacion.ts` de Nébula, con una adaptación
 * de fondo: allí la señal de zona sale de los polígonos que cubre cada
 * motorizado (`zoneIds` + `findZoneForPoint`). La tabla `motorizados` de Baby
 * Caleb no guarda zonas cubiertas y su tarifario no es por polígono, así que la
 * misma idea se obtiene del dato que SÍ existe: **si ya lleva una entrega en
 * esta zona**. Un motorizado con tres paradas en Tocumen es el candidato natural
 * para la cuarta en Tocumen.
 *
 * PROPONE, NO ASIGNA
 *
 * Devuelve candidatos ordenados **con el motivo de cada uno**, y no elige. Quien
 * despacha sabe cosas que esto no: que a fulano se le dañó la moto, que ese
 * barrio no lo agarra nadie después de las seis, que la clienta pidió el mismo
 * de la vez pasada. Una pantalla que asigna sola y sin explicarse es una
 * pantalla que se ignora a la tercera vez que se equivoca.
 *
 * Por eso salen todos los candidatos, incluso los saturados: saber **por qué** no
 * se propone a alguien vale tanto como la propuesta.
 *
 * LAS TRES SEÑALES, Y CÓMO SE COMPARAN
 *
 * El plan pide ordenar por zona, carga y cercanía. El problema de mezclar tres
 * cosas es que el peso de cada una acaba siendo un número mágico que nadie
 * recuerda haber elegido. Aquí:
 *
 *  - **La zona manda y no se negocia.** Quien ya está en la zona va primero,
 *    siempre: la cercanía en línea recta no debería poder tumbar el hecho de que
 *    alguien ya va para allá.
 *  - **La carga y la cercanía se comparan en kilómetros.** Cada entrega que ya
 *    lleva encima cuenta como `KM_POR_ENTREGA_PENDIENTE`, así que las dos hablan
 *    la misma unidad y el peso deja de ser mágico: es «prefiero mandar a alguien
 *    dos kilómetros más lejos antes que ponerle una cuarta entrega a quien ya
 *    lleva tres».
 */

/**
 * Cuánto «cuesta» cada entrega que alguien ya lleva encima, en kilómetros.
 *
 * Dos kilómetros es una postura, no una medida: dice que repartir la carga
 * importa, pero no tanto como para mandar a alguien al otro lado de la ciudad.
 * Se discutirá con datos el día que los haya; mientras tanto está aquí arriba,
 * con nombre, en vez de escondido dentro de una fórmula.
 */
export const KM_POR_ENTREGA_PENDIENTE = 2;

/** Por encima de esto no se propone a nadie, aunque sea el más cercano. */
export const MAX_ENTREGAS_POR_MOTORIZADO = 12;

export interface EntregaEncima {
  /** La zona del pedido. Es la señal de afinidad. */
  zona_id: string;
  /** Puede faltar: no toda dirección tiene punto en el mapa. */
  punto: Punto | null;
}

export interface MotorizadoDisponible {
  id: string;
  nombre: string;
  estado: EstadoMotorizado;
  /** Las entregas que ya lleva encima hoy. */
  entregas: readonly EntregaEncima[];
}

export interface Candidato {
  motorizado_id: string;
  nombre: string;
  /** ¿Se le puede proponer? Los que no, salen igual con su motivo. */
  proponible: boolean;
  /** Ya lleva al menos una entrega en esta misma zona. */
  yaVaALaZona: boolean;
  carga: number;
  /** Kilómetros a su entrega más cercana, o null si va vacío o sin puntos. */
  km_al_grupo: number | null;
  /** Lo que se compara. Menos es mejor. En kilómetros. */
  coste: number;
  motivo: string;
}

function costeDe(e: { km_al_grupo: number | null; carga: number }): number {
  // Quien va vacío no tiene grupo al que estar cerca, y eso no debe
  // penalizarle: es justo a quien conviene darle la primera entrega de una zona
  // nueva. Se le cuenta cero de distancia, así que compite solo por carga — que
  // tiene cero.
  return (e.km_al_grupo ?? 0) + e.carga * KM_POR_ENTREGA_PENDIENTE;
}

function motivoDe(c: Omit<Candidato, "motivo">): string {
  if (c.carga >= MAX_ENTREGAS_POR_MOTORIZADO) {
    return `Ya lleva ${c.carga} entregas: no se le asignan más.`;
  }
  if (!c.proponible) {
    return "No está activo, así que no recibe entregas nuevas.";
  }

  const partes = [c.yaVaALaZona ? "Ya va a esta zona" : "No lleva nada en esta zona"];
  partes.push(
    c.km_al_grupo === null
      ? "va vacío"
      : `su entrega más cercana está a ${c.km_al_grupo.toFixed(1)} km`,
  );
  if (c.carga > 0) partes.push(`lleva ${c.carga}`);

  return `${partes.join(" · ")}.`;
}

/**
 * Ordena a los motorizados por lo bien que les viene esta entrega.
 *
 * `destino` puede ser null: un envío sin punto en el mapa no se puede acercar a
 * nadie, así que la cercanía deja de contar y queda la zona y la carga. Es poco,
 * y es lo honesto: sin coordenada no hay más información que dar.
 */
export function sugerirMotorizado(
  entrega: { zona_id: string; destino: Punto | null },
  motorizados: readonly MotorizadoDisponible[],
): Candidato[] {
  const candidatos: Candidato[] = motorizados.map((m) => {
    const carga = m.entregas.length;

    const puntos = m.entregas
      .map((e) => e.punto)
      .filter((p): p is Punto => p !== null);

    const km_al_grupo =
      entrega.destino && puntos.length > 0
        ? Math.min(...puntos.map((p) => distanciaKm(entrega.destino!, p)))
        : null;

    const yaVaALaZona = m.entregas.some((e) => e.zona_id === entrega.zona_id);

    const proponible = puedeRecibirEntregas(m.estado) && carga < MAX_ENTREGAS_POR_MOTORIZADO;

    const base = {
      motorizado_id: m.id,
      nombre: m.nombre,
      proponible,
      yaVaALaZona,
      carga,
      km_al_grupo,
      coste: costeDe({ km_al_grupo, carga }),
    };

    return { ...base, motivo: motivoDe(base) };
  });

  return candidatos.sort((a, b) => {
    // Los que no se pueden proponer, al final, pase lo que pase.
    if (a.proponible !== b.proponible) return a.proponible ? -1 : 1;
    // La zona manda sobre la distancia.
    if (a.yaVaALaZona !== b.yaVaALaZona) return a.yaVaALaZona ? -1 : 1;
    if (a.coste !== b.coste) return a.coste - b.coste;
    // Empate real: por nombre, para que el orden no baile entre recargas.
    return a.nombre.localeCompare(b.nombre, "es");
  });
}

/** El que se propondría, o null si no hay ninguno al que se le pueda dar. */
export function mejorCandidato(candidatos: readonly Candidato[]): Candidato | null {
  return candidatos.find((c) => c.proponible) ?? null;
}
