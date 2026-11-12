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
 *  - `herramientas/`   las herramientas de verdad: `ajustes.ts` son las cifras
 *                      del negocio (la otra puerta de la pantalla de Ajustes,
 *                      §13 de TRAMPAS), `catalogo.ts` es lo que se
 *                      le puede contestar a una clienta (precio, talla, peso y
 *                      la etiqueta de si hay), `inventario.ts` es para ir a la
 *                      bodega (el número exacto, por bodega),
 *                      `catalogo-escritura.ts` es administrar el catálogo
 *                      —crear, editar y retirar—, `entregas.ts` es el tramo
 *                      de la bodega a la puerta, `motorizados.ts` es quién
 *                      reparte, `pedidos.ts` son los pedidos y las clientas,
 *                      `dinero.ts` la bandeja de comprobantes, el cobro y la
 *                      portada del negocio, `pasarelas.ts` son las pasarelas de
 *                      cobro y el dinero que vuelve —un reembolso, un
 *                      contracargo— sin una sola credencial, y
 *                      `devoluciones.ts` deshace y cierra lo que ya pasó
 *                      en la calle, y `contabilidad.ts` son los libros.
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
import { HERRAMIENTAS_DE_CATALOGO_ESCRITURA } from "./herramientas/catalogo-escritura";
import { HERRAMIENTAS_DE_CONTABILIDAD } from "./herramientas/contabilidad";
import { HERRAMIENTAS_DE_DEVOLUCIONES } from "./herramientas/devoluciones";
import { HERRAMIENTAS_DE_DINERO } from "./herramientas/dinero";
import { HERRAMIENTAS_DE_ENTREGAS } from "./herramientas/entregas";
import { HERRAMIENTAS_DE_CHECKOUT } from "./herramientas/checkout";
import { HERRAMIENTAS_DE_COTIZACIONES } from "./herramientas/cotizaciones";
import { HERRAMIENTAS_DE_PASARELAS } from "./herramientas/pasarelas";
import { HERRAMIENTAS_DE_INVENTARIO } from "./herramientas/inventario";
import { HERRAMIENTAS_DE_MOTORIZADOS } from "./herramientas/motorizados";
import { HERRAMIENTAS_DE_PEDIDOS } from "./herramientas/pedidos";
import { HERRAMIENTAS_DE_PRECIOS_Y_STOCK } from "./herramientas/precios-y-stock";
import { Registro } from "./registro";

/**
 * El catálogo de herramientas del sistema.
 *
 * Una herramienta nueva solo entra con su prueba y con su fila en la tabla de
 * 06-asistente §5. Aquí se registra, y desde aquí la ven las tres puertas.
 *
 * Registrarla aquí es lo que la vuelve real: sin esta lista, un archivo de
 * `herramientas/` es una pieza terminada que nadie llama (TRAMPAS §12), y por
 * MCP no existe (TRAMPAS §13). `node scripts/sin-mcp.mjs` compara esta lista
 * con las rutas del panel y dice qué falta.
 */
export function catalogo(): Registro {
  const r = new Registro();
  for (const h of [
    ...HERRAMIENTAS_DE_CATALOGO,
    ...HERRAMIENTAS_DE_CATALOGO_ESCRITURA,
    ...HERRAMIENTAS_DE_DINERO,
    ...HERRAMIENTAS_DE_PASARELAS,
    ...HERRAMIENTAS_DE_CHECKOUT,
    ...HERRAMIENTAS_DE_COTIZACIONES,
    ...HERRAMIENTAS_DE_INVENTARIO,
    ...HERRAMIENTAS_DE_PEDIDOS,
    ...HERRAMIENTAS_DE_PRECIOS_Y_STOCK,
    ...HERRAMIENTAS_DE_AJUSTES,
    ...HERRAMIENTAS_DE_ENTREGAS,
    ...HERRAMIENTAS_DE_DEVOLUCIONES,
    ...HERRAMIENTAS_DE_MOTORIZADOS,
    ...HERRAMIENTAS_DE_CONTABILIDAD,
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
  HERRAMIENTAS_DE_CATALOGO_ESCRITURA,
  HERRAMIENTAS_DE_CONTABILIDAD,
  HERRAMIENTAS_DE_DEVOLUCIONES,
  HERRAMIENTAS_DE_DINERO,
  HERRAMIENTAS_DE_ENTREGAS,
  HERRAMIENTAS_DE_INVENTARIO,
  HERRAMIENTAS_DE_MOTORIZADOS,
  HERRAMIENTAS_DE_PASARELAS,
  HERRAMIENTAS_DE_PEDIDOS,
  HERRAMIENTAS_DE_CHECKOUT,
  HERRAMIENTAS_DE_COTIZACIONES,
  HERRAMIENTAS_DE_PRECIOS_Y_STOCK,
};
