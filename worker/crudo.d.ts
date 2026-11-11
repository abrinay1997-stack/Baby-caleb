/**
 * Importar un archivo como texto: `import x from "./algo.jsonc?raw"`.
 *
 * Vite mete el contenido en el bundle. Hace falta para leer configuración de
 * verdad —no una copia, que se quedaría vieja— desde pruebas que corren dentro
 * de workerd, donde no hay disco.
 */
declare module "*?raw" {
  const contenido: string;
  export default contenido;
}
