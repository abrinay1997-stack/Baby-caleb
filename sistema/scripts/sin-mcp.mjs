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
  "DELETE /catalogo/variantes/:codigo": "retirar_variante",
  "GET /ajustes": "ver_ajustes",
  "GET /ajustes/:clave/historial": "ver_historial_de_ajuste",
  "GET /bodegas": "ver_bodegas",
  "GET /catalogo": "buscar_articulo",
  "GET /catalogo/variantes/:codigo/borrado": "ver_retiro_variante",
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
  "GET /pasarelas": "ver_pasarelas (el estado; la ficha de cada credencial y el libro NO salen por MCP)",
  "GET /pedidos": "buscar_pedido",
  "GET /pedidos/:id": "ver_pedido",
  "GET /resumen": "resumen_del_dia",
  // Los tres de usuarios son la ÚNICA excepción de fondo a «todo lleva MCP», y
  // está decidida en 06-asistente §3: lo que el asistente nunca hace no se
  // comprueba, no existe — y cambiar un permiso es lo primero de esa lista.
  //
  // El motivo es el mismo que ya se aceptó para las llaves de MCP: una llave
  // que puede dar de alta a un usuario con permisos es una llave que se
  // amplía a sí misma, y entonces revocarla no revoca nada. Darle esto a MCP
  // no sería una capacidad más, sería quitarle el techo a todas las demás.
  //
  // Leer la lista va con ellos a propósito: enseñar quién tiene qué permiso
  // es el mapa de por dónde entrar.
  "GET /usuarios": "solo_panel: quién entra y con qué permiso se decide donde se ve a la persona, no por una herramienta (06-asistente §3)",
  "GET /yo": "solo_panel: quién soy lo decide Access, no una herramienta",
  "GET /zonas": "ver_zonas",
  "PATCH /bodegas/:id": "renombrar_bodega + cambiar_uso_de_bodega",
  "PATCH /catalogo/variantes/:codigo": "cambiar_precio (el precio) + editar_variante (el resto)",
  // La ficha de una clienta SÍ se corrige por MCP, menos la facturación de
  // una dirección: para tocarla hay que decir CUÁL, y el id de una dirección
  // solo se conoce abriendo la ficha, que es justo lo que D-20 no deja salir
  // hacia el modelo. Una excepción razonada vale; una silenciosa no.
  "PATCH /clientes/:id": "corregir_ficha_de_clienta (la dirección se toca solo en el panel)",
  "PATCH /motorizados/:id": "corregir_motorizado",
  "PATCH /usuarios/:id": "solo_panel: una llave que cambia permisos se amplía a sí misma, y entonces revocarla no revoca nada",
  "PATCH /zonas/:id": "cambiar_zona",
  "POST /ajustes/:clave": "cambiar_ajuste",
  "POST /asistente": "solo_panel: es la puerta del propio asistente",
  "POST /asistente/acciones/:id": "solo_panel: es la puerta del propio asistente",
  "POST /bodegas": "crear_bodega",
  "POST /bodegas/traslados": "trasladar_stock",
  "POST /catalogo/altas": "dar_de_alta_producto",
  "POST /catalogo/productos": "crear_producto",
  "POST /catalogo/variantes": "crear_variante",
  "POST /clientes": "dar_de_alta_clienta",
  "POST /cobros": "registrar_cobro",
  "POST /cobros/:pagoId/confirmar": "confirmar_abono",
  "POST /cobros/:pagoId/contracargo": "registrar_contracargo",
  "POST /cobros/:pagoId/rechazar": "rechazar_cobro",
  "POST /cobros/:pagoId/reembolso": "registrar_reembolso",
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
  "POST /entregas/:envioId/devolucion": "devolver_parada",
  "POST /entregas/:envioId/entregada": "marcar_entregada",
  "POST /entregas/:envioId/fallida": "marcar_fallida",
  "POST /entregas/pedidos/:pedidoId": "programar_entrega",
  "POST /entregas/rutas": "armar_ruta",
  "POST /entregas/rutas/:rutaId/cancelar": "cancelar_ruta",
  "POST /entregas/rutas/:rutaId/cerrar": "cerrar_ruta",
  "POST /entregas/rutas/:rutaId/despachar": "despachar_ruta",
  "POST /existencias/movimientos": "ajustar_stock (que ya acepta el costo al entrar) + registrar_merma",
  "POST /motorizados": "dar_de_alta_motorizado",
  "POST /motorizados/:id/estado": "cambiar_estado_motorizado",
  "POST /pasarelas/:pasarela/credenciales/:credencial/quitar":
    "solo_panel: quitar un secreto se hace donde se ve, igual que ponerlo",
  "POST /pasarelas/:pasarela/credenciales/:credencial": "solo_panel: un secreto se teclea donde se ve, no por una herramienta",
  "POST /pasarelas/:pasarela/encendida": "encender_pasarela + apagar_pasarela",
  "POST /pasarelas/:pasarela/modo": "cambiar_modo_de_pasarela",
  "POST /pedidos": "crear_pedido",
  "POST /pedidos/:id/agendar": "agendar_pedido",
  "POST /pedidos/:id/cancelar": "anular_pedido",
  "POST /pedidos/:id/devolucion": "devolver_pedido",
  "POST /usuarios": "solo_panel: una llave que da de alta usuarios se hace otra a sí misma; es el mismo motivo que las llaves de MCP",
  "POST /usuarios/:id/telegram":
    "solo_panel: entrega un código de un solo uso que se lee en pantalla. Por una\n     herramienta pasaría por el modelo, y el modelo es un Contributor con el que Meta\n     entrena (D-20): una llave no se le enseña ni una vez",
  "POST /zonas": "crear_zona",
  "PUT /catalogo/variantes/:codigo/foto":
    "solo_panel: se sube una imagen, no datos. Una herramienta tendría que recibir el archivo por el modelo",
  "PUT /catalogo/variantes/:codigo/receta": "poner_receta_de_combo",
  "PUT /entregas/:envioId/prueba":
    "solo_panel: se sube la foto de la entrega desde el teléfono del motorizado, no datos"
};

const fuentes = ["src/api/panel.ts", "src/api/asistente-rutas.ts"];
const rutas = new Set();
for (const f of fuentes) {
  const texto = readFileSync(f, "utf8");
  // `put` estaba fuera y el salto de línea tras el paréntesis también, así que
  // cuatro rutas de verdad no las contaba NADIE: las tres `PUT` (la foto y la
  // receta de una variante, la prueba de una entrega) y el `POST` de quitar
  // una credencial, que se declara con la ruta en la línea siguiente porque no
  // cabía en una. El guion existe para que ninguna ruta se escape sin decidir
  // si MCP la cubre, y se le escapaban cuatro — lo encontraron dos agentes
  // distintos el mismo día, cada uno con la suya.
  for (const m of texto.matchAll(/panel\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
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

/**
 * Y la excepción de fondo, vigilada.
 *
 * Las tres rutas de `usuarios` son solo_panel porque cambiar un permiso es lo
 * primero de la lista de lo que el asistente NUNCA hace (06-asistente §3), y
 * porque una llave de MCP que da de alta usuarios se amplía a sí misma: a
 * partir de ahí, revocarla no revoca nada.
 *
 * Eso estaba escrito en una nota de COBERTURA, y una nota no impide nada. Hay
 * además una prueba en `registro.test.ts`, pero mira los NOMBRES de las
 * herramientas, y el nombre no es la garantía: una herramienta llamada
 * `corregir_ficha_de_clienta` puede escribir en `usuarios` y pasar.
 *
 * Esto mira el código. Si algún archivo de herramientas toca la tabla
 * `usuarios` o importa `db/usuarios`, falla.
 */
const TOCAN_USUARIOS = [];
for (const archivo of readdirSync(DIRECTORIO)) {
  if (!archivo.endsWith(".ts") || archivo.endsWith(".test.ts")) continue;
  const texto = readFileSync(`${DIRECTORIO}/${archivo}`, "utf8");
  // Se mira el SQL y el import, que son las dos formas de llegar a la tabla.
  // `usuario` en singular queda fuera a propósito: `ctx.usuario` es quién
  // pregunta y lo usan casi todas.
  if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+usuarios\b/i.test(texto) ||
      /from\s+"\.\.\/\.\.\/db\/usuarios"/.test(texto)) {
    TOCAN_USUARIOS.push(archivo);
  }
}

if (TOCAN_USUARIOS.length > 0) {
  console.error(`\n${TOCAN_USUARIOS.length} archivo(s) de herramientas tocan la tabla «usuarios»:\n`);
  for (const a of TOCAN_USUARIOS) console.error(`  ${DIRECTORIO}/${a}`);
  console.error(
    "\nQuién entra y con qué permiso se decide en el panel, donde se ve a la\n" +
      "persona. Una llave de MCP que da de alta usuarios o les cambia el rol se\n" +
      "amplía a sí misma, y entonces revocarla no revoca nada (06-asistente §3).",
  );
  process.exit(1);
}

process.exit(0);
