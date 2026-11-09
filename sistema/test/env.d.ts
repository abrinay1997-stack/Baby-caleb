import type { D1Migration } from "@cloudflare/vitest-plugin";

// En @cloudflare/vitest-plugin 0.23 `env` ya no es `ProvidedEnv`: es
// `Cloudflare.Env`, el namespace que genera `wrangler types`. Los bindings que
// solo existen en pruebas se agregan ampliándolo.
declare global {
  namespace Cloudflare {
    interface Env {
      /** Las migraciones de migrations/, inyectadas por vitest.config.ts. */
      MIGRACIONES: D1Migration[];
    }
  }
}
