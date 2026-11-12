/**
 * ¿Qué se puede hacer por el panel y NO por MCP?
 *
 * La regla la puso el dueño del proyecto y está en `CLAUDE.md`: un ajuste
 * nuevo, un campo nuevo o una capacidad nueva no están terminados hasta que se
 * pueden usar también por MCP, en el MISMO cambio. El porqué está en
 * `docs/TRAMPAS.md` §13.
 *
 * Una regla que nadie comprueba es una intención. Esto la comprueba.
 *
 * Cómo funciona: lee las rutas del panel del código de verdad y las cruza con
 * el mapa de abajo. Si aparece una ruta que no está en el mapa, FALLA — así,
 * añadir una ruta obliga a decidir si MCP la cubre, en vez de que la decisión
 * se olvide. Las que están en el mapa como «PENDIENTE» son deuda conocida y
 * salen contadas, no escondidas.
 *
 *   node scripts/sin-mcp.mjs            el resumen
 *   node scripts/sin-mcp.mjs --lista    además, qué falta exactamente
 */
import { readFileSync } from "node:fs";

/**
 * Qué cubre qué.
 *
 * - un nombre de herramienta → ya se puede por MCP
 * - "solo_panel: <motivo>"   → no tiene sentido por MCP, y se dice por qué
 * - "PENDIENTE"              → el panel puede y MCP no. Deuda, no excepción.
 */
const COBERTURA = {
  "DELETE /catalogo/variantes/:codigo": "PENDIENTE",
  "GET /ajustes": "PENDIENTE",
  "GET /ajustes/:clave/historial": "PENDIENTE",
  "GET /bodegas": "PENDIENTE",
  "GET /catalogo": "buscar_articulo",
  "GET /catalogo/variantes/:codigo/borrado": "PENDIENTE",
  "GET /catalogo/variantes/:codigo/receta": "ver_combo",
  "GET /clientes": "PENDIENTE",
  "GET /clientes/:id": "PENDIENTE",
  "GET /cobros": "PENDIENTE",
  "GET /cobros/:pagoId/comprobante": "solo_panel: devuelve una imagen, no datos",
  "GET /contabilidad": "PENDIENTE",
  "GET /contabilidad/cierre": "PENDIENTE",
  "GET /contabilidad/cuentas/:codigo": "PENDIENTE",
  "GET /contabilidad/diario": "PENDIENTE",
  "GET /contabilidad/por-cobrar": "PENDIENTE",
  "GET /entregas": "PENDIENTE",
  "GET /entregas/:envioId/candidatos": "PENDIENTE",
  "GET /entregas/:envioId/prueba": "solo_panel: devuelve una imagen, no datos",
  "GET /existencias": "ver_stock",
  "GET /mcp/llaves": "solo_panel: una llave de MCP que puede listar llaves se convierte en un llavero",
  "POST /mcp/llaves": "solo_panel: una llave que crea más llaves nunca se revoca de verdad — se haría otra a sí misma",
  "POST /mcp/llaves/:id/revocar": "solo_panel: quien se queda una llave robada la usaría para revocar las demás",
  "GET /pasarelas": "PENDIENTE",
  "GET /pedidos": "PENDIENTE",
  "GET /pedidos/:id": "PENDIENTE",
  "GET /resumen": "PENDIENTE",
  "GET /usuarios": "PENDIENTE",
  "GET /yo": "solo_panel: quién soy lo decide Access, no una herramienta",
  "GET /zonas": "PENDIENTE",
  "PATCH /bodegas/:id": "PENDIENTE",
  "PATCH /catalogo/variantes/:codigo": "cambiar_precio (solo el precio; el resto PENDIENTE)",
  "PATCH /clientes/:id": "PENDIENTE",
  "PATCH /usuarios/:id": "PENDIENTE",
  "PATCH /zonas/:id": "PENDIENTE",
  "POST /ajustes/:clave": "PENDIENTE",
  "POST /asistente": "solo_panel: es la puerta del propio asistente",
  "POST /asistente/acciones/:id": "solo_panel: es la puerta del propio asistente",
  "POST /bodegas": "PENDIENTE",
  "POST /bodegas/traslados": "trasladar_stock",
  "POST /catalogo/altas": "PENDIENTE",
  "POST /catalogo/productos": "PENDIENTE",
  "POST /catalogo/variantes": "PENDIENTE",
  "POST /clientes": "PENDIENTE",
  "POST /cobros": "PENDIENTE",
  "POST /cobros/:pagoId/confirmar": "PENDIENTE",
  "POST /cobros/:pagoId/contracargo": "PENDIENTE",
  "POST /cobros/:pagoId/rechazar": "PENDIENTE",
  "POST /cobros/:pagoId/reembolso": "PENDIENTE",
  "POST /contabilidad/asientos": "PENDIENTE",
  "POST /contabilidad/asientos/:id/reverso": "PENDIENTE",
  "POST /contabilidad/cierre": "PENDIENTE",
  "POST /contabilidad/cierre/reabrir": "PENDIENTE",
  "POST /contabilidad/redondeos": "PENDIENTE",
  "POST /entregas/:envioId/devolucion": "devolver_parada",
  "POST /entregas/:envioId/entregada": "PENDIENTE",
  "POST /entregas/:envioId/fallida": "PENDIENTE",
  "POST /entregas/pedidos/:pedidoId": "PENDIENTE",
  "POST /entregas/rutas": "PENDIENTE",
  "POST /entregas/rutas/:rutaId/cancelar": "cancelar_ruta",
  "POST /entregas/rutas/:rutaId/cerrar": "cerrar_ruta",
  "POST /entregas/rutas/:rutaId/despachar": "PENDIENTE",
  "POST /existencias/movimientos": "ajustar_stock + registrar_merma",
  "POST /pasarelas/:pasarela/credenciales/:credencial": "solo_panel: un secreto se teclea donde se ve, no por una herramienta",
  "POST /pasarelas/:pasarela/encendida": "PENDIENTE",
  "POST /pasarelas/:pasarela/modo": "PENDIENTE",
  "POST /pedidos": "PENDIENTE",
  "POST /pedidos/:id/agendar": "PENDIENTE",
  "POST /pedidos/:id/cancelar": "PENDIENTE",
  "POST /pedidos/:id/devolucion": "devolver_pedido",
  "POST /usuarios": "PENDIENTE",
  "POST /zonas": "PENDIENTE"
};

const fuentes = ["src/api/panel.ts", "src/api/asistente-rutas.ts"];
const rutas = new Set();
for (const f of fuentes) {
  const texto = readFileSync(f, "utf8");
  for (const m of texto.matchAll(/panel\.(get|post|patch|delete)\("([^"]+)"/g)) {
    rutas.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
}

const sinDecidir = [...rutas].filter((r) => !Object.hasOwn(COBERTURA, r)).sort();
const pendientes = [...rutas].filter((r) => COBERTURA[r] === "PENDIENTE").sort();
const soloPanel = [...rutas].filter((r) => String(COBERTURA[r] ?? "").startsWith("solo_panel"));
const cubiertas = rutas.size - sinDecidir.length - pendientes.length - soloPanel.length;

console.log(`Rutas del panel: ${rutas.size}`);
console.log(`  ya se pueden por MCP: ${cubiertas}`);
console.log(`  solo panel, con motivo: ${soloPanel.length}`);
console.log(`  PENDIENTE de MCP: ${pendientes.length}`);

if (process.argv.includes("--lista") && pendientes.length > 0) {
  console.log("\nLo que el panel puede y MCP todavía no:\n");
  for (const r of pendientes) console.log("  " + r);
}

if (sinDecidir.length > 0) {
  console.error(`\n${sinDecidir.length} ruta(s) sin decidir si MCP las cubre:\n`);
  for (const r of sinDecidir) console.error("  " + r);
  console.error(
    "\nAñádalas a COBERTURA en este archivo, con el nombre de la herramienta que\n" +
      "las cubre, «PENDIENTE» si todavía no, o «solo_panel: <motivo>» si no tiene\n" +
      "sentido por MCP. Decidirlo es el punto: que no se olvide.",
  );
  process.exit(1);
}

process.exit(0);
