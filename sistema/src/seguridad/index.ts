/**
 * La seguridad del sistema, en un solo sitio.
 *
 * Cada puerta y para quién (docs/plan/07-seguridad.md §1):
 *
 *  - `access.ts`    el equipo, en `panel.babycaleb.com`, por Cloudflare Access.
 *  - `roles.ts`     qué puede cada rol una vez dentro, y el cruce con `usuarios`.
 *  - `pin.ts`       el PIN del motorizado y los códigos de un solo uso de las clientas.
 *  - `sesion.ts`    las sesiones de quien no tiene cuenta en Access.
 *  - `turnstile.ts` la comprobación de que al otro lado hay una persona.
 *  - `cabeceras.ts` las cabeceras de seguridad de las respuestas del Worker.
 *
 * Todo falla cerrado: sin configuración no se abre, y cualquier duda es un no.
 */

export * from "./access";
export * from "./roles";
export * from "./pin";
export * from "./sesion";
export * from "./turnstile";
export * from "./cabeceras";
