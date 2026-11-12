/**
 * El asistente del negocio (docs/plan/06-asistente.md).
 *
 * Conversa en español con el EQUIPO —no con las clientas, eso sigue siendo el
 * bot del CRM— y consulta o hace cosas dentro de reglas claras. Un solo
 * catálogo de herramientas y tres puertas: el chat del panel, Telegram y MCP.
 *
 *  - `registro.ts`     qué es una herramienta y cuáles hay, en orden fijo.
 *  - `politica.ts`     qué se ejecuta, qué se pregunta y qué no pasa.
 *  - `referencias.ts`  lo que el modelo puede saber de una clienta: una referencia.
 *  - `proveedor.ts`    el cerebro, detrás de una interfaz (guion fijo y Meta).
 *  - `herramientas/`   las herramientas de verdad: `catalogo.ts` es lo que se
 *                      le puede contestar a una clienta (precio, talla, peso y
 *                      la etiqueta de si hay) e `inventario.ts` es para ir a la
 *                      bodega (el número exacto, por bodega). `maestros.ts`
 *                      administra bodegas, zonas de envío y la ficha de una
 *                      clienta, y `ajustes.ts` cuenta quién cambió una cifra.
 *
 * Lo que el asistente NUNCA hace no se comprueba: no existe. No hay forma de
 * declarar una herramienta que borre un asiento, cambie un permiso, lea un
 * secreto o ejecute SQL (06-asistente §3).
 */

export * from "./registro";
export * from "./politica";
export * from "./referencias";
export * from "./proveedor";

import { HERRAMIENTAS_DE_AJUSTES } from "./herramientas/ajustes";
import { HERRAMIENTAS_DE_CATALOGO } from "./herramientas/catalogo";
import { HERRAMIENTAS_DE_INVENTARIO } from "./herramientas/inventario";
import { HERRAMIENTAS_DE_MAESTROS } from "./herramientas/maestros";
import { HERRAMIENTAS_DE_PRECIOS_Y_STOCK } from "./herramientas/precios-y-stock";
import { Registro } from "./registro";

/**
 * El catálogo de herramientas del sistema.
 *
 * Una herramienta nueva solo entra con su prueba y con su fila en la tabla de
 * 06-asistente §5. Aquí se registra, y desde aquí la ven las tres puertas.
 */
export function catalogo(): Registro {
  const r = new Registro();
  for (const h of [
    ...HERRAMIENTAS_DE_AJUSTES,
    ...HERRAMIENTAS_DE_CATALOGO,
    ...HERRAMIENTAS_DE_INVENTARIO,
    ...HERRAMIENTAS_DE_MAESTROS,
    ...HERRAMIENTAS_DE_PRECIOS_Y_STOCK,
  ]) {
    r.registrar(h as never);
  }
  return r;
}

export * from "./ejecutar";
export * from "./conversar";
export {
  HERRAMIENTAS_DE_AJUSTES,
  HERRAMIENTAS_DE_CATALOGO,
  HERRAMIENTAS_DE_INVENTARIO,
  HERRAMIENTAS_DE_MAESTROS,
  HERRAMIENTAS_DE_PRECIOS_Y_STOCK,
};
