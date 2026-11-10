import { defineConfig } from 'vitest/config';

/**
 * Las pruebas que miran ARCHIVOS del repositorio, en Node.
 *
 * No pueden correr en el otro proyecto: dentro de workerd no existe el disco
 * del repositorio, y una prueba que no puede leer lo que vigila no falla —se
 * salta en verde, que es peor que no tenerla.
 */
export default defineConfig({
  test: {
    name: 'repo',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
