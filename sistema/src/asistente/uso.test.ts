import { env as real } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { anotarUso, costoMicroUsd, gastoDelMes } from "./uso";
import type { Uso } from "./proveedor";

/**
 * Lo que gasta el asistente.
 *
 * La tabla existía desde la migración 0002 y nadie escribía en ella. Esto es
 * lo que hace que el tope mensual pueda llegar a significar algo.
 */

const USUARIO = "u-uso-asistente";

const uso = (entrada: number, salida: number): Uso => ({
  entrada,
  salida,
  cacheLeida: 0,
  cacheEscrita: 0,
});

beforeAll(async () => {
  await real.DB.prepare(
    "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, 'Prueba de uso', 'duena', 1, ?)",
  )
    .bind(USUARIO, `uso-${USUARIO}@babycaleb.com`, Date.now())
    .run();
});

describe("costoMicroUsd", () => {
  it("devuelve null sin tarifa, que NO es lo mismo que cero", () => {
    // Cero es «no costó nada»; null es «no se puede saber». Si se parecieran,
    // un informe de gasto cero pasaría por bueno.
    expect(costoMicroUsd(uso(1000, 500), null)).toBeNull();
  });

  it("calcula por millón de fichas", () => {
    // 1.000.000 de entrada a 3.000.000 de microdólares el millón = 3.000.000.
    expect(costoMicroUsd(uso(1_000_000, 0), { entrada: 3_000_000, salida: 15_000_000 })).toBe(
      3_000_000,
    );
    expect(costoMicroUsd(uso(0, 100_000), { entrada: 3_000_000, salida: 15_000_000 })).toBe(
      1_500_000,
    );
  });
});

describe("anotarUso", () => {
  it("anota las fichas aunque no se sepa el costo", async () => {
    // Las fichas son un hecho medible. El costo es lo que falta. Anotar solo
    // cuando se sepan las dos cosas sería perder el hecho por culpa del hueco.
    const ahora = Date.now();
    const antes = await gastoDelMes(real.DB, ahora, USUARIO);

    await anotarUso(real.DB, {
      usuarioId: USUARIO,
      canal: "panel",
      modelo: "muse-spark-1.3-contributor",
      uso: uso(1200, 340),
      ahora,
      tarifa: null,
    });

    const despues = await gastoDelMes(real.DB, ahora, USUARIO);
    expect(despues.fichas - antes.fichas).toBe(1540);
    expect(despues.turnos - antes.turnos).toBe(1);
    expect(despues.microUsd - antes.microUsd).toBe(0);
  });

  it("con tarifa sí anota el costo", async () => {
    const ahora = Date.now();
    const antes = await gastoDelMes(real.DB, ahora, USUARIO);

    await anotarUso(real.DB, {
      usuarioId: USUARIO,
      canal: "panel",
      modelo: "muse-spark-1.3-contributor",
      uso: uso(1_000_000, 0),
      ahora,
      tarifa: { entrada: 3_000_000, salida: 15_000_000 },
    });

    const despues = await gastoDelMes(real.DB, ahora, USUARIO);
    expect(despues.microUsd - antes.microUsd).toBe(3_000_000);
  });

  it("si no se puede anotar, el asistente sigue contestando", async () => {
    // Dejar a la dueña sin asistente porque falló una fila de contabilidad
    // sería cambiar un problema pequeño por uno grande. Pero se queja en el
    // registro: un contador que deja de contar en silencio es peor que ninguno.
    await expect(
      anotarUso(real.DB, {
        usuarioId: "u-que-no-existe",
        canal: "panel",
        modelo: "x",
        uso: uso(1, 1),
        ahora: Date.now(),
        tarifa: null,
      }),
    ).resolves.toBeUndefined();
  });
});
