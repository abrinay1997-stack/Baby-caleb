import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// El panel se construye aparte del Worker y sale a `panel/dist`, que es lo que
// `wrangler.jsonc` sirve como estáticos en staging y producción.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwind()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // El panel lo abre la dueña desde un teléfono, a veces con mala señal.
    // Un presupuesto apretado se vigila en CI; esto solo avisa al construir.
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5174,
    // En local, `vite dev` sirve la interfaz y manda la API al Worker de
    // `wrangler dev`, que es donde están D1 y las colas.
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/salud": "http://127.0.0.1:8787",
    },
  },
});
