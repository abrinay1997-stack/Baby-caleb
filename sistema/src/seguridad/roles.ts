/**
 * Quién puede hacer qué.
 *
 * Es la tabla de docs/plan/07-seguridad.md §1 «Roles», copiada aquí tal cual y
 * en un solo sitio. Si una pantalla, una herramienta del asistente y una ruta
 * deciden cada una por su cuenta, tarde o temprano discrepan — y la que se
 * equivoca del lado flojo es la que nadie revisa.
 *
 * Dos permisos están partidos a propósito respecto del documento, porque la
 * tabla tiene celdas que no son un sí o un no:
 *
 *  - «Compras y gastos» se parte en `compras` y `gastos`, porque la asistente
 *    puede gastos pero no compras.
 *  - «Contabilidad, conciliación, cierre» se parte en `contabilidad` y
 *    `cierre_de_mes`, porque la contadora lleva la contabilidad pero NO cierra
 *    el mes.
 */

/** Los de `usuarios.rol`, más el motorizado, que no entra al panel. */
export const ROLES = ["duena", "asistente", "contadora", "motorizado"] as const;

export type Rol = (typeof ROLES)[number];

/** Los que pueden tener una fila en `usuarios`. El motorizado vive en `motorizados`. */
export const ROLES_DE_PANEL = ["duena", "asistente", "contadora"] as const;

export type RolDePanel = (typeof ROLES_DE_PANEL)[number];

export const esRol = (v: string): v is Rol => (ROLES as readonly string[]).includes(v);
export const esRolDePanel = (v: string): v is RolDePanel =>
  (ROLES_DE_PANEL as readonly string[]).includes(v);

export const ETIQUETAS_ROL: Record<Rol, string> = {
  duena: "Dueña",
  asistente: "Asistente",
  contadora: "Contadora",
  motorizado: "Motorizado",
};

export const PERMISOS = [
  "pedidos",
  "cobros",
  "costo_y_margen",
  "precios_y_stock",
  "compras",
  "gastos",
  "contabilidad",
  "cierre_de_mes",
  "ajustes",
] as const;

export type Permiso = (typeof PERMISOS)[number];

/** `no` no lo ve; `ver` lo lee pero no lo cambia; `editar` lo cambia. */
export type Nivel = "no" | "ver" | "editar";

/**
 * La matriz. El motorizado tiene su propia superficie (`ruta.babycaleb.com`) y
 * lo que ve ahí no sale de esta tabla sino de sus entregas del día: aquí está
 * en `no` para todo salvo lo que la tabla del plan le concede, y aun eso está
 * acotado a lo suyo por la consulta, no por el rol.
 */
const MATRIZ: Record<Rol, Record<Permiso, Nivel>> = {
  duena: {
    pedidos: "editar",
    cobros: "editar",
    costo_y_margen: "ver",
    precios_y_stock: "editar",
    compras: "editar",
    gastos: "editar",
    contabilidad: "editar",
    cierre_de_mes: "editar",
    ajustes: "editar",
  },
  asistente: {
    pedidos: "editar",
    cobros: "no",
    costo_y_margen: "no",
    precios_y_stock: "no",
    compras: "no",
    gastos: "editar",
    contabilidad: "no",
    cierre_de_mes: "no",
    ajustes: "no",
  },
  contadora: {
    pedidos: "ver",
    cobros: "no",
    costo_y_margen: "ver",
    precios_y_stock: "no",
    compras: "ver",
    gastos: "ver",
    contabilidad: "editar",
    // La contadora no cierra el mes: cerrar es de la dueña.
    cierre_de_mes: "no",
    ajustes: "no",
  },
  motorizado: {
    // Solo sus entregas del día, y de un pedido ve el saldo a cobrar, no el
    // monto. Eso lo acota la consulta; el rol solo dice que no entra al panel.
    pedidos: "no",
    cobros: "no",
    costo_y_margen: "no",
    precios_y_stock: "no",
    compras: "no",
    gastos: "no",
    contabilidad: "no",
    cierre_de_mes: "no",
    ajustes: "no",
  },
};

export function nivelDe(rol: Rol, permiso: Permiso): Nivel {
  return MATRIZ[rol][permiso];
}

export function puedeVer(rol: Rol, permiso: Permiso): boolean {
  return nivelDe(rol, permiso) !== "no";
}

export function puedeEditar(rol: Rol, permiso: Permiso): boolean {
  return nivelDe(rol, permiso) === "editar";
}

/** Lo que la pantalla necesita para no ofrecer botones que no se pueden pulsar. */
export function permisosDe(rol: Rol): Record<Permiso, Nivel> {
  return { ...MATRIZ[rol] };
}

// ---------------------------------------------------------------------------
// Del correo de Access a un usuario del sistema
// ---------------------------------------------------------------------------

export interface Usuario {
  id: string;
  correo: string;
  nombre: string;
  rol: RolDePanel;
  activo: boolean;
}

export type ResultadoUsuario =
  | { ok: true; usuario: Usuario }
  | { ok: false; motivo: "no_esta_en_usuarios" | "desactivado" | "rol_desconocido" };

/**
 * Cruza el correo del JWT con la fila de `usuarios`.
 *
 * Pasar Access NO es entrar: Access dice que esa persona es quien dice ser, y
 * esta función dice si además trabaja aquí (07-seguridad.md §2: «el correo del
 * JWT se cruza con `usuarios.correo` y `activo = 1`; si no está, 403»).
 *
 * Importa que sean dos pasos: quitar a alguien del sistema es desactivar su
 * fila, y eso tiene efecto en la siguiente petición sin esperar a que caduque
 * su sesión de Access ni tocar la configuración de Cloudflare.
 */
export function usuarioDeCorreo(
  correo: string,
  fila: { id: string; correo: string; nombre: string; rol: string; activo: number } | null,
): ResultadoUsuario {
  if (!fila) return { ok: false, motivo: "no_esta_en_usuarios" };
  if (fila.activo !== 1) return { ok: false, motivo: "desactivado" };
  if (!esRolDePanel(fila.rol)) return { ok: false, motivo: "rol_desconocido" };
  return {
    ok: true,
    usuario: {
      id: fila.id,
      correo: correo.trim().toLowerCase(),
      nombre: fila.nombre,
      rol: fila.rol,
      activo: true,
    },
  };
}
