import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El número de trampas que anuncia `CLAUDE.md` es el que hay.
 *
 * `CLAUDE.md` abre con «Son N reglas» y es lo primero que lee cualquiera —
 * persona o modelo— antes de tocar el repositorio. Ese número se escribió a
 * mano y se quedó en «doce» habiendo trece: nadie se acuerda de subirlo al
 * añadir una entrada, porque el número vive en otro archivo.
 *
 * Es exactamente la trampa §8: una lista de configuración que alguien tiene
 * que acordarse de tocar. La diferencia es que ésta se puede contar.
 */

const repo = join(import.meta.dirname, "..", "..", "..");

const NUMEROS: Record<string, number> = {
  una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciséis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20,
};

describe("la cuenta de las trampas", () => {
  it("CLAUDE.md anuncia tantas reglas como entradas tiene TRAMPAS.md", () => {
    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    const trampas = readFileSync(join(repo, "docs", "TRAMPAS.md"), "utf8");

    const hay = [...trampas.matchAll(/^## \d+\. /gm)].length;
    expect(hay, "no se leyó ninguna entrada `## N.` de TRAMPAS.md").toBeGreaterThan(5);

    const dicho = claude.match(/\bSon\s+([a-zñáéíóú]+)\s+reglas\b/i)?.[1]?.toLowerCase();
    expect(dicho, "CLAUDE.md ya no dice «Son N reglas»: ajuste esta prueba").toBeDefined();

    expect(
      NUMEROS[dicho as string],
      `CLAUDE.md dice «Son ${dicho} reglas» y docs/TRAMPAS.md tiene ${hay}. ` +
        `Quien lea el número de menos va a creer que ya leyó todas.`,
    ).toBe(hay);
  });
});
