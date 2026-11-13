import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El §7 que está escrito y el §7 que se mide son el mismo §7.
 *
 * `docs/design-system.md` es el contrato del panel y `scripts/medir-el-panel.mjs`
 * es quien lo hace cumplir. Son dos archivos, los escriben personas distintas en
 * ratos distintos, y ya se habían separado por los dos lados:
 *
 *   · la burbuja de Caleb y la cifra clave se **medían** desde hacía semanas sin
 *     estar escritas en ningún contrato, así que nadie sabía que existían como
 *     regla: se leían como una rareza del auditor;
 *   · y al revés es peor —una regla escrita que nadie mide es una promesa—,
 *     porque quien la lee la da por vigilada y deja de mirarla.
 *
 * Esta prueba compara las dos listas por el apartado (`7a`, `7b`, …). No juzga
 * la prosa: solo que no haya ninguno suelto a un lado.
 *
 * Vive en `test/node/` porque lee archivos, y dentro de workerd `node:fs` no
 * existe: ahí se saltaría en verde.
 */

const sistema = join(import.meta.dirname, "..", "..");
const repo = join(sistema, "..");

/** Los apartados escritos en el contrato: `### 7a · …` */
function delContrato(): string[] {
  const doc = readFileSync(join(repo, "docs", "design-system.md"), "utf8");
  return [...doc.matchAll(/^### (7[a-z]) · /gm)].map((m) => m[1]);
}

/** Los apartados que alguna regla dice hacer cumplir: `seccion: "7a"` */
function delAuditor(): string[] {
  const medidor = readFileSync(join(sistema, "scripts", "medir-el-panel.mjs"), "utf8");
  return [...medidor.matchAll(/^    seccion: "(7[a-z])",$/gm)].map((m) => m[1]);
}

describe("el §7 escrito y el §7 medido son el mismo", () => {
  const contrato = delContrato();
  const auditor = delAuditor();

  it("las dos listas se leyeron de verdad", () => {
    // Si un `matchAll` se queda a cero, el que falla es esta prueba, y sin esto
    // compararía dos listas vacías y diría que todo cuadra. Es la trampa §1 del
    // repositorio: un control que comprueba algo que ya era cierto.
    expect(contrato.length, "no se leyó ningún `### 7x ·` del contrato").toBeGreaterThan(5);
    expect(auditor.length, "no se leyó ningún `seccion:` del medidor").toBeGreaterThan(5);
  });

  it("todo lo que el contrato promete, alguien lo mide", () => {
    const sinVigilar = contrato.filter((s) => !auditor.includes(s));
    expect(
      sinVigilar,
      `estos apartados del §7 están escritos en docs/design-system.md y ninguna ` +
        `regla de scripts/medir-el-panel.mjs los mide. Una regla que nadie mide ` +
        `es una promesa: quien la lee la da por vigilada y deja de mirarla. ` +
        `Escriba su regla con su par de muestras, o quite el apartado. ` +
        `Sueltos: ${sinVigilar.join(", ")}`,
    ).toEqual([]);
  });

  it("todo lo que se mide está escrito en el contrato", () => {
    const sinEscribir = [...new Set(auditor)].filter((s) => !contrato.includes(s));
    expect(
      sinEscribir,
      `estas reglas se miden en scripts/medir-el-panel.mjs y no hay ningún ` +
        `apartado que las explique en docs/design-system.md. Quien se encuentre ` +
        `el rojo no va a saber qué le piden ni por qué, y la va a borrar por ` +
        `molesta. Sueltas: ${sinEscribir.join(", ")}`,
    ).toEqual([]);
  });

  it("cada regla del medidor trae su par de muestras", () => {
    // `seccion` sin `rompe`/`cumple` sería una regla que dice a qué apartado
    // sirve y no demuestra que mide nada. El auditor corre las muestras al
    // arrancar; esto comprueba que existen antes de llegar al navegador.
    const medidor = readFileSync(join(sistema, "scripts", "medir-el-panel.mjs"), "utf8");
    // Solo la lista de muestras. Partir el archivo entero por `  {` partía
    // también los bloques de `medir()` —que abren llave en su propia línea—
    // y cada trozo traía un `regla:` de un `fallas.push` sin muestras al
    // lado: la prueba acusaba a dos reglas que sí las tenían.
    const desde = medidor.indexOf("export const PRUEBAS = [");
    expect(desde, "ya no hay una lista PRUEBAS que leer").toBeGreaterThan(0);
    const lista = medidor.slice(desde, medidor.indexOf("\n];", desde));
    const entradas = lista.split(/^  \{$/m).slice(1);
    const cojas: string[] = [];
    for (const entrada of entradas) {
      const regla = entrada.match(/regla: "([^"]+)"/)?.[1];
      if (!regla) continue;
      if (!/\brompe:/.test(entrada) || !/\bcumple:/.test(entrada)) cojas.push(regla);
    }
    expect(
      cojas,
      `estas reglas no tienen las dos muestras (una que tiene que suspender y ` +
        `otra que tiene que aprobar): ${cojas.join(", ")}`,
    ).toEqual([]);
  });
});
