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
 * Lo que se decide aquí son CAPACIDADES, no puertas. El webhook de Telegram
 * (`src/api/telegram-rutas.ts`) no sale en esta lista porque no añade nada que
 * hacer: es otra puerta a las mismas herramientas, igual que MCP. Lo que sí
 * sale es la ruta del panel que fabrica el código para vincular un chat, porque
 * eso es una capacidad nueva.
 *
 *   node scripts/sin-mcp.mjs            el resumen
 *   node scripts/sin-mcp.mjs --lista    además, qué falta exactamente
 */
import { readFileSync, readdirSync } from "node:fs";

/**
 * Qué cubre qué.
 *
 * - un nombre de herramienta → ya se puede por MCP
 * - "solo_panel: <motivo>"   → no tiene sentido por MCP, y se dice por qué
 * - "PENDIENTE"              → el panel puede y MCP no. Deuda, no excepción.
 */
const COBERTURA = {
  "DELETE /catalogo/variantes/:codigo": "PENDIENTE",
  "GET /ajustes": "ver_ajustes",
  "GET /ajustes/:clave/historial": "PENDIENTE",
  "GET /bodegas": "ver_bodegas",
  "GET /catalogo": "buscar_articulo",
  "GET /catalogo/variantes/:codigo/borrado": "PENDIENTE",
  "GET /catalogo/variantes/:codigo/receta": "ver_combo",
  "GET /clientes": "buscar_cliente",
  "GET /clientes/:id": "historial_de_cliente",
  "GET /cobros": "pagos_por_confirmar",
  // El veredicto del checkout, que es lo que destapa si `checkout_activo` está
  // haciendo algo. Por MCP se pide con `ver_checkout`, que contesta lo mismo:
  // las dos puertas leen `verCheckout`, no dos cálculos distintos.
  "GET /checkout": "ver_checkout",
  "GET /cobros/:pagoId/comprobante": "solo_panel: devuelve una imagen, no datos",
  "GET /contabilidad": "ver_contabilidad (sin el estado de resultados: el costo tiene su propio permiso)",
  "GET /contabilidad/cierre": "ver_cierre",
  "GET /contabilidad/cuentas/:codigo": "ver_mayor_de_cuenta",
  "GET /contabilidad/diario": "ver_libro_diario",
  "GET /contabilidad/por-cobrar": "quien_me_debe",
  "GET /entregas": "ver_entregas",
  "GET /entregas/:envioId/candidatos": "sugerir_motorizado",
  "GET /entregas/:envioId/prueba": "solo_panel: devuelve una imagen, no datos",
  "GET /existencias": "ver_stock",
  "GET /mcp/llaves": "solo_panel: una llave de MCP que puede listar llaves se convierte en un llavero",
  "POST /mcp/llaves": "solo_panel: una llave que crea más llaves nunca se revoca de verdad — se haría otra a sí misma",
  "POST /mcp/llaves/:id/revocar": "solo_panel: quien se queda una llave robada la usaría para revocar las demás",
  "GET /motorizados": "ver_motorizados",
  "GET /pasarelas": "PENDIENTE",
  "GET /pedidos": "buscar_pedido",
  "GET /pedidos/:id": "ver_pedido",
  "GET /resumen": "resumen_del_dia",
  "GET /usuarios": "PENDIENTE",
  "GET /yo": "solo_panel: quién soy lo decide Access, no una herramienta",
  "GET /zonas": "ver_zonas",
  "PATCH /bodegas/:id": "PENDIENTE",
  "PATCH /catalogo/variantes/:codigo": "cambiar_precio (solo el precio; el resto PENDIENTE)",
  "PATCH /clientes/:id": "PENDIENTE",
  "PATCH /motorizados/:id": "corregir_motorizado",
  "PATCH /usuarios/:id": "PENDIENTE",
  "PATCH /zonas/:id": "PENDIENTE",
  "POST /ajustes/:clave": "cambiar_ajuste",
  "POST /asistente": "solo_panel: es la puerta del propio asistente",
  "POST /asistente/acciones/:id": "solo_panel: es la puerta del propio asistente",
  "POST /bodegas": "PENDIENTE",
  "POST /bodegas/traslados": "trasladar_stock",
  "POST /catalogo/altas": "PENDIENTE",
  "POST /catalogo/productos": "PENDIENTE",
  "POST /catalogo/variantes": "PENDIENTE",
  "POST /clientes": "dar_de_alta_clienta",
  "POST /cobros": "registrar_cobro",
  "POST /cobros/:pagoId/confirmar": "confirmar_abono",
  "POST /cobros/:pagoId/contracargo": "PENDIENTE",
  "POST /cobros/:pagoId/rechazar": "rechazar_cobro",
  "POST /cobros/:pagoId/reembolso": "PENDIENTE",
  "POST /contabilidad/asientos":
    "solo_panel: lo que la persona lee antes de permitir lo arma resumir() con String(valor), así que las líneas de un asiento saldrían como «[object Object]» y permitirlo sería un clic a ciegas sobre un libro que no se edita; y es el único asiento que nace sin un hecho detrás (05 §3)",
  "POST /contabilidad/asientos/:id/reverso":
    "solo_panel: es la única forma de corregir y funciona UNA vez por asiento (revierte_id es único); elegir cuál se revierte es leer el libro diario en pantalla, y en una conversación viaja un ULID de 26 letras — un carácter distinto corrige otro asiento, que ya no se podrá corregir",
  "POST /contabilidad/cierre": "cerrar_mes",
  "POST /contabilidad/cierre/reabrir": "reabrir_mes",
  "POST /contabilidad/redondeos": "ajustar_redondeos",
  // Las dos cotizaciones nacen con su herramienta, en el mismo cambio, que es
  // la regla del dueño (docs/TRAMPAS.md §13). Las dos pasan por la MISMA
  // función que el panel: `crearPedido` con la bandera, y
  // `confirmarCotizacion`.
  "POST /cotizaciones": "crear_cotizacion",
  "POST /cotizaciones/:id/confirmar": "confirmar_cotizacion",
  "POST /entregas/:envioId/devolucion": "PENDIENTE",
  "POST /entregas/:envioId/entregada": "marcar_entregada",
  "POST /entregas/:envioId/fallida": "marcar_fallida",
  "POST /entregas/pedidos/:pedidoId": "programar_entrega",
  "POST /entregas/rutas": "armar_ruta",
  "POST /entregas/rutas/:rutaId/cancelar": "PENDIENTE",
  "POST /entregas/rutas/:rutaId/cerrar": "PENDIENTE",
  "POST /entregas/rutas/:rutaId/despachar": "despachar_ruta",
  "POST /existencias/movimientos": "ajustar_stock (que ya acepta el costo al entrar) + registrar_merma",
  "POST /motorizados": "dar_de_alta_motorizado",
  "POST /motorizados/:id/estado": "cambiar_estado_motorizado",
  "POST /pasarelas/:pasarela/credenciales/:credencial": "solo_panel: un secreto se teclea donde se ve, no por una herramienta",
  "POST /pasarelas/:pasarela/encendida": "PENDIENTE",
  "POST /pasarelas/:pasarela/modo": "PENDIENTE",
  "POST /pedidos": "crear_pedido",
  "POST /pedidos/:id/agendar": "agendar_pedido",
  "POST /pedidos/:id/cancelar": "anular_pedido",
  "POST /pedidos/:id/devolucion": "PENDIENTE",
  "POST /usuarios": "PENDIENTE",
  "POST /usuarios/:id/telegram":
    "solo_panel: entrega un código de un solo uso que se lee en pantalla. Por una\n     herramienta pasaría por el modelo, y el modelo es un Contributor con el que Meta\n     entrena (D-20): una llave no se le enseña ni una vez",
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

/**
 * Las herramientas que EXISTEN de verdad.
 *
 * Se leen del código, no de una lista: `nombre: "..."` en
 * `src/asistente/herramientas/`. Hace falta porque el mapa de arriba se
 * escribe a mano, y una entrada que nombre una herramienta inexistente diría
 * «esto ya se puede por MCP» sin que se pueda — la misma clase de mentira que
 * `checkout_activo`, que decía controlar algo que no controlaba.
 */
const DIRECTORIO = "src/asistente/herramientas";
const existentes = new Set();
for (const archivo of readdirSync(DIRECTORIO)) {
  if (!archivo.endsWith(".ts") || archivo.includes(".test.")) continue;
  const texto = readFileSync(`${DIRECTORIO}/${archivo}`, "utf8");
  for (const m of texto.matchAll(/nombre:\s*"([a-z][a-z0-9_]*)"/g)) existentes.add(m[1]);
}

/**
 * Los nombres de herramienta que una nota del mapa menciona.
 *
 * Una nota puede nombrar varias («ajustar_stock + registrar_merma») o llevar
 * texto alrededor («cambiar_precio (solo el precio; el resto PENDIENTE)»), así
 * que se buscan las palabras en `snake_case`: el prefijo verbo_objeto que
 * exige `registro.ts`. La prosa en español no las usa, y si alguna vez
 * chocara, la salida dice cuál y se reescribe la nota.
 */
const herramientasNombradas = (nota) => [
  ...new Set([...String(nota).matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g)].map((m) => m[0])),
];

const inventadas = [];
for (const [ruta, nota] of Object.entries(COBERTURA)) {
  if (nota === "PENDIENTE" || String(nota).startsWith("solo_panel")) continue;
  for (const nombre of herramientasNombradas(nota)) {
    if (!existentes.has(nombre)) inventadas.push({ ruta, nombre });
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
console.log(`Herramientas del asistente que existen: ${existentes.size}`);

if (process.argv.includes("--lista") && pendientes.length > 0) {
  console.log("\nLo que el panel puede y MCP todavía no:\n");
  for (const r of pendientes) console.log("  " + r);
}

if (inventadas.length > 0) {
  console.error(`\n${inventadas.length} ruta(s) dicen estar cubiertas por una herramienta que no existe:\n`);
  for (const i of inventadas) console.error(`  ${i.ruta} → «${i.nombre}»`);
  console.error(
    "\nDecir que algo se puede por MCP sin que se pueda es peor que decir\n" +
      "«PENDIENTE»: nadie va a volver a mirarlo. O se escribe la herramienta en\n" +
      `${DIRECTORIO}/ y se registra en src/asistente/index.ts, o la\n` +
      "entrada vuelve a «PENDIENTE».",
  );
  process.exit(1);
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
