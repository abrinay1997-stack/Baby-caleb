#!/usr/bin/env node
/**
 * ¿Qué controles no vigilan nada?
 *
 * Cierra con una máquina la trampa nº 1 de `docs/TRAMPAS.md`, que es la que
 * más ha mordido en este proyecto: **tres veces**. Una fila de `controles`
 * solo protege si comprueba los valores que ESE batch acaba de escribir. Si
 * comprueba algo que ya era cierto antes —«¿el pago está aprobado?», o
 * «¿reservado >= 0?» cuando la tabla ya tiene ese CHECK— pasa siempre, no
 * detecta nada, y encima hace creer que algo está vigilado.
 *
 * ## Cómo lo decide, sin heurísticas
 *
 * No intenta leer el SQL y adivinar si la condición es tautológica: eso sería
 * un juicio, y un juicio equivocado aquí da falsa confianza — que es
 * exactamente el fallo que este guion persigue.
 *
 * Lo que hace es más tonto y más fiable: **rompe cada control a propósito**.
 * Sustituye su condición por un `1` fijo —o sea, lo deja pasando siempre— y
 * corre las pruebas. Si NINGUNA se pone roja, ese control no estaba
 * defendiendo nada que las pruebas sepan comprobar. O se arregla, o se quita
 * y se escribe por qué no hace falta.
 *
 * Es la misma validación por mutación que el proyecto hace a mano desde el
 * principio; esto solo la vuelve mecánica y completa.
 *
 * ## Uso
 *
 *     node scripts/controles-que-no-vigilan.mjs            # todos
 *     node scripts/controles-que-no-vigilan.mjs src/db/entregas.ts
 *
 * Tarda: corre la suite una vez por control. Con `--bail=1` los controles
 * sanos terminan en cuanto una prueba cae, así que los lentos son justo los
 * sospechosos.
 *
 * NO va en cada push por eso. Va cuando se toca un control, y de vez en
 * cuando entero.
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MARCA = "INSERT INTO controles";

/** Se niega a correr con cambios sin guardar: esto reescribe archivos. */
function exigeArbolLimpio() {
  const sucio = execSync("git status --porcelain -- src/", { encoding: "utf8" }).trim();
  if (sucio !== "") {
    console.error("Hay cambios sin guardar en src/. Este guion reescribe archivos");
    console.error("y restaura al terminar, pero si algo lo corta a medias la red");
    console.error("de seguridad es `git checkout`. Guarde o descarte primero:\n");
    console.error(sucio);
    process.exit(2);
  }
}

/**
 * Dónde empieza y acaba la condición de un control.
 *
 * La forma siempre es `VALUES (?, <regla>, <condición>, ?)`. Se recorre
 * contando paréntesis en vez de con una expresión regular, porque la
 * condición lleva paréntesis dentro —subconsultas, `CASE WHEN`— y una regla
 * que cuente mal cortaría el SQL por la mitad y rompería la compilación en
 * vez de dar una respuesta.
 */
function condicionDe(texto, desdeIdx) {
  const values = texto.indexOf("VALUES", desdeIdx);
  if (values === -1) return null;
  let i = texto.indexOf("(", values);
  if (i === -1) return null;

  let nivel = 0;
  let elemento = 0;
  let inicio = -1;

  for (; i < texto.length; i++) {
    const c = texto[i];
    if (c === "(") {
      nivel++;
      if (nivel === 1) {
        inicio = i + 1;
        continue;
      }
    } else if (c === ")") {
      nivel--;
      if (nivel === 0) return null; // se cerró VALUES sin llegar al tercero
    } else if (c === "," && nivel === 1) {
      elemento++;
      if (elemento === 2) inicio = i + 1;
      else if (elemento === 3) return { inicio, fin: i };
    }
  }
  return null;
}

/** Cada control del archivo: dónde está su condición y en qué línea vive. */
function controlesDe(ruta) {
  const texto = readFileSync(ruta, "utf8");
  const encontrados = [];
  let desde = 0;
  for (;;) {
    const m = texto.indexOf(MARCA, desde);
    if (m === -1) break;
    desde = m + MARCA.length;
    const c = condicionDe(texto, m);
    if (c === null) continue;
    const condicion = texto.slice(c.inicio, c.fin).trim();
    // Un `?` o un número ya es constante: no hay nada que neutralizar.
    if (!condicion.includes("SELECT")) continue;
    encontrados.push({
      linea: texto.slice(0, m).split("\n").length,
      inicio: c.inicio,
      fin: c.fin,
      condicion: condicion.replace(/\s+/g, " ").slice(0, 70),
    });
  }
  return { texto, encontrados };
}

function pruebasPasan(soloArchivo) {
  try {
    execFileSync(
      "npx",
      ["vitest", "run", "--reporter=dot", "--bail=1", ...(soloArchivo ? [soloArchivo] : [])],
      { stdio: "pipe", encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

exigeArbolLimpio();

const pedidos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const archivos =
  pedidos.length > 0
    ? pedidos
    : execSync(`grep -rl "${MARCA}" src --include=*.ts | grep -v "\\.test\\." | sort`, {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);

const mudos = [];
let revisados = 0;

for (const ruta of archivos) {
  const { texto, encontrados } = controlesDe(ruta);
  if (encontrados.length === 0) continue;

  // De atrás hacia delante no haría falta aquí —cada mutación parte del texto
  // original— pero se deja explícito que solo se toca UNO a la vez: dos
  // mutaciones juntas se tapan entre ellas.
  for (const c of encontrados) {
    const roto = texto.slice(0, c.inicio) + " 1 " + texto.slice(c.fin);
    process.stdout.write(`${ruta}:${c.linea}  `);
    try {
      writeFileSync(ruta, roto);
      revisados++;
      if (pruebasPasan()) {
        console.log("⚠️  NADIE SE ENTERA");
        mudos.push({ ruta, linea: c.linea, condicion: c.condicion });
      } else {
        console.log("✓ vigilado");
      }
    } finally {
      writeFileSync(ruta, texto);
    }
  }
}

console.log(`\n${revisados} controles probados.`);

if (mudos.length === 0) {
  console.log("Todos vigilan algo: romperlos pone roja alguna prueba.");
  process.exit(0);
}

console.log(`\n${mudos.length} que no vigilan nada:\n`);
for (const m of mudos) {
  console.log(`  ${m.ruta}:${m.linea}`);
  console.log(`    ${m.condicion}`);
}
console.log(`
Un control que se puede dejar pasando siempre sin que nada se queje no está
protegiendo nada. Las dos salidas honestas:

  1. Arreglarlo: que compruebe los valores que ESE batch escribió (la hora
     exacta, el actor, el monto), no un estado que ya era cierto antes.
  2. Quitarlo y escribir al lado por qué no hace falta — como ya se hace en
     \`src/db/entregas.ts\`, donde se explica que ahí la llave foránea es la
     que protege y un control sobraría.

Lo que no vale es dejarlo: hace creer que algo está vigilado.`);
process.exit(1);
