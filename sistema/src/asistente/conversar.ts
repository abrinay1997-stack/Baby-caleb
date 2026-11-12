import { ejecutar } from "./ejecutar";
import { revisar } from "./referencias";
import { TOPES, TURNO_LIMPIO, type Turno } from "./politica";
import {
  MAX_TOKENS_POR_OMISION,
  SIN_USO,
  type LlamadaAHerramienta,
  type Mensaje,
  type Proveedor,
  type Uso,
} from "./proveedor";
import type { Canal, Contexto, Registro } from "./registro";

/**
 * El turno de Caleb: preguntar, usar herramientas, contestar.
 *
 * Las piezas existían todas y ninguna se tocaba con otra. El proveedor sabe
 * pedir herramientas; el ejecutor sabe correrlas con su política y su
 * bitácora. Faltaba el hilo: pedirle al modelo, ejecutar lo que pida,
 * devolverle el resultado y repetir hasta que hable.
 *
 * Tres reglas que no son detalle:
 *
 *  1. **Una acción por confirmar PARA el turno.** No se sigue conversando como
 *     si ya hubiera pasado. El modelo no se entera de un resultado que todavía
 *     no existe, así que no puede contarlo ni encadenar nada encima.
 *  2. **Un error de herramienta vuelve al modelo, no revienta.** Que su rol no
 *     alcance, o que el código no exista, es información: con ella el modelo
 *     explica en español lo que pasó. Sin ella, Caleb se queda mudo y la
 *     persona no sabe por qué.
 *  3. **El turno termina siempre.** La política corta a los ocho pasos, pero
 *     eso solo bloquea llamadas: un modelo terco seguiría pidiendo. El tope de
 *     vueltas de aquí es el que garantiza que se sale.
 *
 * El historial vuelve al navegador y el navegador lo devuelve, igual que el
 * chat de la web. Lo que NO se confía a ese historial es nada que decida algo:
 * cada acción se vuelve a pasar por `ejecutar`, con su política y su rol, y lo
 * que quedó hecho vive en `acciones`, no en lo que diga el navegador.
 */

/** Quién habla, contra qué base y cuándo. */
export interface Quien {
  readonly db: D1Database;
  readonly usuario: Contexto["usuario"];
  readonly ahora: number;
}

/** Lo que se le manda a Caleb. */
export interface Conversacion {
  readonly sistema: string;
  /** El historial entero, con el mensaje nuevo de la persona al final. */
  readonly mensajes: readonly Mensaje[];
  readonly canal: Canal;
  readonly conversacionId: string | null;
  /** Alguno de los últimos mensajes traía un archivo (06-asistente §3). */
  readonly huboArchivoReciente?: boolean;
  readonly maxTokens?: number;
}

export type Final =
  | {
      readonly clase: "dijo";
      readonly texto: string;
      readonly historial: readonly Mensaje[];
      readonly pasos: number;
      readonly uso: Uso;
    }
  | {
      readonly clase: "pide_permiso";
      /** Lo que el modelo alcanzó a decir antes de pedir permiso. */
      readonly texto: string;
      readonly accionId: string;
      readonly resumen: string;
      readonly venceEn: number;
      readonly historial: readonly Mensaje[];
      readonly pasos: number;
      readonly uso: Uso;
    };

const sumar = (a: Uso, b: Uso): Uso => ({
  entrada: a.entrada + b.entrada,
  salida: a.salida + b.salida,
  cacheLeida: a.cacheLeida + b.cacheLeida,
  cacheEscrita: a.cacheEscrita + b.cacheEscrita,
});

/**
 * Lo que se le devuelve al modelo de una herramienta.
 *
 * Se recorta con el mismo tope que los argumentos: una consulta que devuelva
 * el catálogo entero no tiene por qué caber en la ventana, y un resultado a
 * medias con un aviso es más útil que un turno que falla por tamaño.
 */
function comoTexto(datos: unknown): string {
  let texto: string;
  try {
    texto = typeof datos === "string" ? datos : JSON.stringify(datos ?? null);
  } catch {
    // Una referencia circular no debe tumbar el turno.
    texto = '{"aviso":"el resultado no se pudo leer"}';
  }
  if (texto.length <= TOPES.letrasPorArgumento) return texto;
  return `${texto.slice(0, TOPES.letrasPorArgumento)}\n\n[recortado: el resultado era muy largo]`;
}

/** Un turno entero de Caleb. */
export async function conversar(
  quien: Quien,
  registro: Registro,
  proveedor: Proveedor,
  peticion: Conversacion,
): Promise<Final> {
  const historial: Mensaje[] = [...peticion.mensajes];
  const herramientas = registro.definicionesPara(quien.usuario.rol);

  let turno: Turno = {
    ...TURNO_LIMPIO,
    huboArchivoReciente: peticion.huboArchivoReciente ?? false,
  };

  // Los nombres de las clientas, para que el filtro pueda cazarlos. Un nombre
  // propio no tiene forma reconocible —«Ana» es una palabra como otra—, así
  // que la única manera honesta es preguntarle a la base quién existe.
  //
  // Se piden UNA vez por turno y solo si de verdad se usa una herramienta: una
  // conversación que no consulta nada no toca la tabla de clientas.
  let nombresCache: readonly string[] | null = null;
  const nombresDeClientas = async (): Promise<readonly string[]> => {
    if (nombresCache !== null) return nombresCache;
    const { results } = await quien.db
      .prepare(
        "SELECT nombre, apellido FROM clientes WHERE anonimizado_en IS NULL AND (nombre IS NOT NULL OR apellido IS NOT NULL)",
      )
      .all<{ nombre: string | null; apellido: string | null }>();
    nombresCache = results
      .flatMap((r) => [r.nombre, r.apellido])
      .filter((n): n is string => typeof n === "string" && n.trim().length >= 3);
    return nombresCache;
  };
  let uso: Uso = SIN_USO;

  // Una vuelta más que pasos permitidos: la última le deja al modelo contestar
  // en palabras después de que la política le cortara la última llamada.
  const MAX_VUELTAS = TOPES.pasosPorTurno + 1;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const respuesta = await proveedor.responder({
      sistema: peticion.sistema,
      mensajes: historial,
      herramientas,
      maxTokens: peticion.maxTokens ?? MAX_TOKENS_POR_OMISION,
    });
    uso = sumar(uso, respuesta.uso);

    if (respuesta.llamadas.length === 0) {
      historial.push({ rol: "assistant", contenido: respuesta.texto });
      return {
        clase: "dijo",
        texto: respuesta.texto,
        historial,
        pasos: turno.pasosDados,
        uso,
      };
    }

    // El turno del modelo se guarda CON lo que pidió. Sin los `tool_use`, los
    // resultados de abajo apuntan a ids que no existen y la siguiente vuelta
    // falla entera.
    historial.push({
      rol: "assistant",
      contenido: respuesta.texto,
      llamadas: respuesta.llamadas,
    });

    let pendiente: { accionId: string; resumen: string; venceEn: number } | null = null;

    for (const [indice, llamada] of respuesta.llamadas.entries()) {
      // Si ya hay algo esperando permiso, lo demás de este turno NO se
      // ejecuta. Pero sí se contesta: un `tool_use` sin su resultado al lado
      // deja el historial roto para cuando la persona vuelva.
      if (pendiente !== null) {
        historial.push(resultadoDe(llamada, { aviso: "no se ejecutó: hay una acción esperando permiso" }));
        continue;
      }

      // El presupuesto es del TURNO, no de la vuelta. Sin esto, una sola
      // respuesta con quinientas llamadas pasa las quinientas por el ejecutor
      // y escribe quinientas filas en la bitácora: la política las bloquearía
      // una a una, pero bloquear también escribe. Se corta antes de entrar.
      if (turno.pasosDados >= TOPES.pasosPorTurno) {
        historial.push(
          resultadoDe(llamada, {
            error: `ya se usaron ${TOPES.pasosPorTurno} herramientas en este turno`,
            codigo: "limite",
          }),
        );
        continue;
      }

      const herramienta = registro.buscar(llamada.nombre);
      const hecho = await ejecutar(
        quien,
        registro,
        {
          nombre: llamada.nombre,
          argumentos: llamada.argumentos,
          canal: peticion.canal,
          conversacionId: peticion.conversacionId,
          conAdjuntos: turno.huboArchivoReciente,
          textoExterno: herramienta?.textoExterno ?? false,
        },
        turno,
      );

      // Cuenta como paso aunque la política la bloquee: si no, un modelo
      // empeñado en una herramienta que no le toca no gastaría pasos nunca y
      // el tope del turno no serviría de nada.
      turno = { ...turno, pasosDados: turno.pasosDados + 1 };

      if (!hecho.ok) {
        historial.push(resultadoDe(llamada, { error: hecho.mensaje, codigo: hecho.codigo }));
        continue;
      }

      if (hecho.datos.clase === "por_confirmar") {
        pendiente = {
          accionId: hecho.datos.accionId,
          resumen: hecho.datos.resumen,
          venceEn: hecho.datos.venceEn,
        };
        historial.push(
          resultadoDe(llamada, { aviso: "esperando a que la persona lo permita", resumen: hecho.datos.resumen }),
        );
        continue;
      }

      // Leer texto de una clienta enciende la sospecha para lo que venga
      // DESPUÉS en este mismo turno: a partir de aquí, construir deja de ser
      // directo y pasa por la persona (06-asistente §3).
      if (herramienta?.textoExterno === true) {
        turno = { ...turno, seLeyoTextoDeFuera: true };
      }

      const revisado = resultadoRevisado(llamada, hecho.datos.datos, await nombresDeClientas());
      if (revisado.filtraciones.length > 0) {
        // La FORMA, nunca el dato: esto acaba en los registros de Cloudflare.
        console.warn(
          JSON.stringify({
            evento: "asistente_dato_de_clienta",
            herramienta: llamada.nombre,
            que: revisado.filtraciones,
          }),
        );
      }
      historial.push(revisado.mensaje);
      void indice;
    }

    if (pendiente !== null) {
      return {
        clase: "pide_permiso",
        texto: respuesta.texto,
        accionId: pendiente.accionId,
        resumen: pendiente.resumen,
        venceEn: pendiente.venceEn,
        historial,
        pasos: turno.pasosDados,
        uso,
      };
    }
  }

  // Se acabaron las vueltas y el modelo seguía pidiendo herramientas. Se dice
  // en español en vez de devolver una respuesta vacía: la persona tiene que
  // saber que la pregunta quedó sin contestar, no creer que no había nada.
  const seRindio = "No pude terminar de averiguarlo. ¿Me lo pregunta de otra forma?";
  historial.push({ rol: "assistant", contenido: seRindio });
  return { clase: "dijo", texto: seRindio, historial, pasos: turno.pasosDados, uso };
}

function resultadoDe(llamada: LlamadaAHerramienta, datos: unknown): Mensaje {
  return { rol: "tool", contenido: comoTexto(datos), llamadaId: llamada.id };
}

/**
 * Lo que sale hacia el modelo, revisado (D-20, 06-asistente §7).
 *
 * El modelo es un Contributor y Meta entrena con lo que recibe. Las cifras del
 * negocio van —el dueño lo aceptó—, pero las clientas son terceras personas
 * que no acordaron nada. `referencias.revisar()` estaba escrito y probado para
 * esto y NO LO LLAMABA NADIE: mientras el asistente no tuvo puerta, la regla
 * no costaba nada incumplirla porque nada salía. Abrir la puerta es lo que la
 * vuelve real, así que se engancha aquí, en el único sitio por donde pasa todo
 * resultado de herramienta.
 *
 * Cuando algo se cuela NO se recorta ni se tacha: se descarta entero y se le
 * dice al modelo QUÉ clase de dato era, nunca el dato. Tachar invita a afinar
 * el tachado hasta que algo pase; descartar obliga a arreglar la herramienta.
 */
function resultadoRevisado(
  llamada: LlamadaAHerramienta,
  datos: unknown,
  nombres: readonly string[],
): { mensaje: Mensaje; filtraciones: readonly string[] } {
  const encontradas = revisar(datos, nombres);
  if (encontradas.length === 0) {
    return { mensaje: resultadoDe(llamada, datos), filtraciones: [] };
  }
  const clases = [...new Set(encontradas.map((f) => f.que))];
  return {
    mensaje: resultadoDe(llamada, {
      error:
        "ese resultado traía datos de una clienta y no se le pueden enseñar al modelo; pida la referencia (C-0042) en vez del dato",
      que: clases,
    }),
    filtraciones: clases,
  };
}
