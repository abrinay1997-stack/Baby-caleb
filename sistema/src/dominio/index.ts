/**
 * El dominio: funciones puras, sin bindings, sin red y sin D1.
 *
 * Todo lo que decide una regla de negocio vive aquí y no dentro de una ruta,
 * para que se pueda probar sin levantar nada — y para que el panel, la web y el
 * bot calculen exactamente igual. Portado de `packages/domain` de Nébula
 * (docs/plan/09-fases.md, F2.3); cada archivo dice qué conservó y qué cambió.
 *
 * Nada de aquí lee la hora ni el reloj del sistema: el instante se pasa como
 * argumento. Así una prueba puede mirar el minuto 14 y el minuto 16 sin esperar,
 * y la hora de Panamá la decide quien llama, no una función escondida.
 */

export * from "./dinero";
export * from "./existencias";
export * from "./precios";
export * from "./estado-pedido";
export * from "./estado-envio";
export * from "./abonos";
export * from "./geo";
export * from "./zonas";
export * from "./provincias";
export * from "./direccion";
export * from "./rutas";
export * from "./motorizado";
export * from "./asignacion";
export * from "./csv";
