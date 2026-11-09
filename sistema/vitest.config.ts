import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Las pruebas corren DENTRO de workerd con los bindings de verdad: la D1 es una
// D1 real, no un simulacro. Así una restricción STRICT, un trigger o una llave
// foránea que D1 no respete se ve aquí y no en producción.
//
// Las migraciones se leen de migrations/ y se aplican antes de cada archivo de
// prueba (test/aplicar-migraciones.ts), siempre desde cero.
export default defineConfig(async () => {
  const migraciones = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    test: {
      setupFiles: ["./test/aplicar-migraciones.ts"],
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { MIGRACIONES: migraciones },
        },
      }),
    ],
  };
});
