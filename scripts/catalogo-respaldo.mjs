#!/usr/bin/env node
/**
 * Regenera `src/data/catalogo.respaldo.json` desde `/api/catalogo`.
 *
 *   node scripts/catalogo-respaldo.mjs <url-base>
 *
 * La copia existe para que la web siga enseñando el catálogo cuando el sistema
 * no contesta (08-operacion.md §Qué hacer cuando). Se descarga del sitio ya
 * desplegado en vez de consultarse a la base, para que lo que se guarde sea
 * EXACTAMENTE lo que la web recibe — la misma forma, los mismos campos, y sin
 * el costo ni la cantidad exacta, que `SistemaWeb` ya deja fuera.
 *
 * Escribirla a mano sería crear un segundo dueño del precio.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESTINO = resolve(RAIZ, "src/data/catalogo.respaldo.json");

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (base === "") {
  console.error("Uso: node scripts/catalogo-respaldo.mjs https://<sitio>");
  process.exit(1);
}

const r = await fetch(`${base}/api/catalogo`);
if (!r.ok) {
  console.error(`✗ ${base}/api/catalogo respondió ${r.status}`);
  process.exit(1);
}

const datos = await r.json();

// Si lo que contestó el sitio venía YA del respaldo, guardarlo sería
// congelar la copia vieja encima de sí misma y creer que se actualizó.
if (datos.desdeRespaldo === true) {
  console.error("✗ el sitio contestó con SU copia de respaldo, no con el sistema.");
  console.error("  Guardar eso sería copiar la copia. Revise el binding SISTEMA.");
  process.exit(1);
}

if (!Array.isArray(datos.variantes) || datos.variantes.length === 0) {
  console.error("✗ el catálogo vino vacío. No se sobrescribe una copia buena con nada.");
  process.exit(1);
}

const anterior = JSON.parse(readFileSync(DESTINO, "utf8"));
const salida = {
  _comentario: anterior._comentario,
  version: datos.version,
  generadoEn: datos.generadoEn,
  variantes: datos.variantes,
};

writeFileSync(DESTINO, `${JSON.stringify(salida, null, 2)}\n`);
console.log(`✓ ${datos.variantes.length} variantes guardadas (versión ${datos.version})`);
console.log(`  ${DESTINO}`);
