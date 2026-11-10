import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

/**
 * Las pruebas del Worker de la web corren DENTRO de workerd.
 *
 * No es una preferencia: `HTMLRewriter` —que es con lo que `worker/head.ts`
 * reescribe el `<head>` de cada página— solo existe ahí. Probarlo con una
 * imitación en Node sería probar la imitación.
 *
 * Solo se recogen las pruebas de `worker/`. El código de la SPA (`src/`) es
 * React y se mira con `npm run lint` y con la auditoría de contraste; cuando
 * tenga pruebas propias, irán en su propio proyecto de vitest.
 */
export default defineConfig({
  test: {
    name: "worker",
    include: ["worker/**/*.test.ts"],
  },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
