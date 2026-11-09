/**
 * Los permisos, tal cual los define el servidor.
 *
 * Se reexportan de `src/seguridad/roles.ts` en vez de copiarlos. Ese módulo es
 * TypeScript puro —no importa nada de Workers ni de D1— así que el navegador lo
 * puede traer sin arrastrar el Worker entero, y así la matriz de quién puede
 * qué existe UNA vez. Dos copias de una tabla de permisos acaban discrepando, y
 * la que se equivoca del lado flojo es la que nadie revisa.
 *
 * Que la pantalla sepa los permisos NO es la seguridad: el servidor comprueba
 * cada llamada. Sirve para no ofrecer un botón que va a responder 403, que es
 * una cortesía, no una defensa.
 */

export {
  ETIQUETAS_ROL,
  PERMISOS,
  ROLES,
  ROLES_DE_PANEL,
  esRol,
  esRolDePanel,
  nivelDe,
  permisosDe,
  puedeEditar,
  puedeVer,
} from "../../src/seguridad/roles";

export type { Nivel, Permiso, Rol, RolDePanel, Usuario } from "../../src/seguridad/roles";
