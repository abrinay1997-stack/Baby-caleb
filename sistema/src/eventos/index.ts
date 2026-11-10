/**
 * Eventos: el outbox y los consumidores de cola.
 *
 * El reparto es: `outbox.ts` garantiza que ningún evento se pierda al salir, y
 * `consumidor.ts` garantiza que ninguno se haga dos veces al llegar. Las dos
 * mitades existen porque las colas entregan al menos una vez y porque entre
 * escribir en D1 y publicar en una cola siempre hay un instante en el que algo
 * puede fallar.
 *
 * Los tipos de evento NO están aquí: viven en `../contrato/eventos.ts`, porque
 * `bc-avisos` lo consume el CRM y eso los hace contrato.
 */

export * from "./outbox";
export * from "./consumidor";
