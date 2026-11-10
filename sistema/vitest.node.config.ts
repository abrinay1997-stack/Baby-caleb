import { defineConfig } from "vitest/config";

/**
 * Las pruebas que NO van dentro de workerd.
 *
 * Los guiones de `scripts/` corren en Node y tocan el disco, así que en el
 * pool de workerd un `node:fs` no existe y la prueba se salta en silencio
 * —pasando en verde sin comprobar nada, que es peor que no tenerla. Esto pasó
 * de verdad con la comprobación del panel de muestra.
 *
 * Aquí viven esas comprobaciones, con Node de verdad.
 */
export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    include: ["scripts/**/*.test.ts", "test/node/**/*.test.ts"],
  },
});
