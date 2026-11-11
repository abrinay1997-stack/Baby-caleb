import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

/**
 * Las pruebas del Worker de la web corren DENTRO de workerd.
 *
 * No es una preferencia: `HTMLRewriter` —que es con lo que `worker/head.ts`
 * reescribe el <head> de cada página— y la caché del borde solo existen ahí.
 * Probarlo con una imitación en Node sería probar la imitación.
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
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // `wrangler.jsonc` declara el binding SISTEMA, y workerd se NIEGA A
        // ARRANCAR si un binding apunta a un servicio que no existe — se caía
        // la suite entera, no solo las pruebas del catálogo.
        //
        // Este doble solo existe para que el binding resuelva. Contesta que no
        // está disponible a propósito: así, una prueba que se olvide de
        // inyectar su propio doble recorre el camino de la copia de respaldo
        // en vez de recibir datos inventados que parezcan del sistema.
        workers: [
          {
            // El nombre tiene que ser EL MISMO que el binding de
            // `wrangler.jsonc`. Cuando la web pasó de staging a producción,
            // cambiar solo el binding tumbó la suite entera: workerd se niega
            // a arrancar si un binding apunta a un servicio que no existe, y
            // el error no dice «falta el doble», dice «runtime failure».
            name: "babycaleb-sistema",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export class SistemaWeb extends WorkerEntrypoint {
                async catalogo() {
                  return { ok: false, codigo: "no_disponible", mensaje: "doble de pruebas" };
                }
                async zonasEnvio() {
                  return { ok: false, codigo: "no_disponible", mensaje: "doble de pruebas" };
                }
                async salud() {
                  return { ok: true, datos: { sano: false, version: "doble" } };
                }
              }
              export default { fetch: () => new Response("doble de pruebas", { status: 501 }) };
            `,
          },
        ],
      },
    }),
  ],
});
