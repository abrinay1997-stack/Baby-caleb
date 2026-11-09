/**
 * El contrato: todo lo que cruza un service binding o una cola.
 *
 * El CRM tiene una copia de esto (`src/sistema/contrato.ts`) con la MISMA
 * huella, y las dos se comparan en el CI de los dos repos. Así que esto no se
 * cambia por gusto: se cambia en docs/plan/03-contratos.md primero, después
 * aquí, y después allá.
 *
 * - `resultado.ts` — la forma de toda respuesta y los doce códigos de error.
 * - `esquemas.ts`  — las formas que viajan (catálogo, zonas, pedidos, pagos).
 * - `eventos.ts`   — los eventos de `bc-avisos` y `bc-tareas`.
 * - `huella.ts`    — la huella, y de dónde sale.
 */

export * from "./resultado";
export * from "./esquemas";
export * from "./eventos";
export * from "./huella";
