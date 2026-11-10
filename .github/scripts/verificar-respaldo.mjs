/**
 * Comprueba que un respaldo restaurado sirve.
 *
 *   node --experimental-sqlite .github/scripts/verificar-respaldo.mjs <archivo.sql>
 *
 * No basta con que el archivo se descifre y se importe sin error: un volcado
 * puede importarse entero y estar mal. Lo que se comprueba es que los números
 * del negocio cuadren, que es lo mismo que se querría comprobar el día que
 * haya que restaurar de verdad.
 *
 * Las verificaciones de contabilidad (que el balance cuadre, que todo asiento
 * sume cero) llegan con F5, cuando existan esas tablas. Las que hay aquí son
 * las que se pueden hacer hoy.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const archivo = process.argv[2];
if (!archivo) {
  console.error("falta el archivo .sql");
  process.exit(2);
}

const sql = readFileSync(archivo, "utf8");
const db = new DatabaseSync(":memory:");

// Las llaves foráneas se dejan apagadas durante la importación: un volcado no
// viene necesariamente en orden de dependencias. Se encienden después.
db.exec("PRAGMA foreign_keys = OFF;");
try {
  db.exec(sql);
} catch (e) {
  console.error(`✗ el respaldo no se pudo importar: ${e.message}`);
  process.exit(1);
}
db.exec("PRAGMA foreign_keys = ON;");

const fallos = [];
const avisos = [];

const una = (consulta) => db.prepare(consulta).get();
const todas = (consulta) => db.prepare(consulta).all();

// --- 1. El esquema está completo -------------------------------------------
const tablas = new Set(
  todas("SELECT name FROM sqlite_master WHERE type='table'").map((f) => f.name),
);
const imprescindibles = [
  "productos",
  "variantes",
  "bodegas",
  "existencias",
  "movimientos_inventario",
  "clientes",
  "zonas_envio",
  "usuarios",
  "ajustes",
  "eventos_salida",
];
const faltan = imprescindibles.filter((t) => !tablas.has(t));
if (faltan.length > 0) fallos.push(`faltan tablas: ${faltan.join(", ")}`);

// --- 2. Las existencias cuadran con sus movimientos ------------------------
// Es la verificación que de verdad dice si el respaldo es coherente: `fisico`
// es un número guardado, y los movimientos son el libro. Si no coinciden, o el
// respaldo se tomó a mitad de un batch o algo escribió `fisico` sin dejar su
// movimiento, que es la clase de error que hay que descubrir ahora.
if (tablas.has("existencias") && tablas.has("movimientos_inventario")) {
  const descuadres = todas(`
    SELECT e.codigo, e.bodega_id, e.fisico,
           COALESCE((SELECT SUM(m.delta) FROM movimientos_inventario m
                     WHERE m.codigo = e.codigo AND m.bodega_id = e.bodega_id), 0) AS suma
    FROM existencias e
    WHERE e.fisico <> COALESCE((SELECT SUM(m.delta) FROM movimientos_inventario m
                                WHERE m.codigo = e.codigo AND m.bodega_id = e.bodega_id), 0)
  `);
  if (descuadres.length > 0) {
    for (const d of descuadres.slice(0, 10)) {
      fallos.push(
        `existencias descuadradas: ${d.codigo} en ${d.bodega_id} dice ${d.fisico} y sus movimientos suman ${d.suma}`,
      );
    }
    if (descuadres.length > 10) fallos.push(`…y ${descuadres.length - 10} más`);
  }
}

// --- 3. Nada reservado por encima de lo físico -----------------------------
if (tablas.has("existencias")) {
  const malas = todas("SELECT codigo, bodega_id FROM existencias WHERE reservado > fisico");
  for (const m of malas) {
    fallos.push(`reservado > fisico en ${m.codigo} / ${m.bodega_id}`);
  }
}

// --- 4. Los libros no están vacíos si hay existencias ----------------------
if (tablas.has("existencias") && tablas.has("movimientos_inventario")) {
  const conStock = una("SELECT COUNT(*) AS n FROM existencias WHERE fisico > 0")?.n ?? 0;
  const movs = una("SELECT COUNT(*) AS n FROM movimientos_inventario")?.n ?? 0;
  if (conStock > 0 && movs === 0) {
    fallos.push(`hay ${conStock} existencias con stock y ningún movimiento: el libro está vacío`);
  }
}

// --- 5. Señales de vida ----------------------------------------------------
const cuenta = (t) => (tablas.has(t) ? (una(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0) : 0);
const resumen = {
  variantes: cuenta("variantes"),
  bodegas: cuenta("bodegas"),
  existencias: cuenta("existencias"),
  movimientos: cuenta("movimientos_inventario"),
  clientes: cuenta("clientes"),
  zonas: cuenta("zonas_envio"),
  usuarios: cuenta("usuarios"),
};

// Una base de producción sin una sola variante es casi seguro un respaldo
// tomado antes de la carga inicial, o del entorno equivocado. No es un fallo
// —al principio del proyecto es lo normal— pero se dice.
if (resumen.variantes === 0) avisos.push("no hay ninguna variante: ¿es el respaldo correcto?");

// --- Informe ---------------------------------------------------------------
console.log("Contenido del respaldo:");
for (const [k, v] of Object.entries(resumen)) console.log(`  ${k.padEnd(14)} ${v}`);

if (avisos.length > 0) {
  console.log("");
  for (const a of avisos) console.log(`⚠ ${a}`);
}

if (fallos.length > 0) {
  console.log("");
  for (const f of fallos) console.error(`✗ ${f}`);
  console.error(`\nEl simulacro falló: ${fallos.length} problema(s).`);
  process.exit(1);
}

console.log("\n✓ el respaldo se importa y los números cuadran");
