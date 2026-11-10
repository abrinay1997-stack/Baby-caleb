import { describe, expect, it } from "vitest";
import {
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
  usuarioDeCorreo,
} from "./roles";

// Esta prueba es la tabla de docs/plan/07-seguridad.md §1 escrita otra vez a
// mano, a propósito: si alguien cambia la matriz sin cambiar el plan, o al
// revés, aquí se nota. No se importa nada de la matriz para construirla.

describe("la dueña puede todo", () => {
  it("ve cada permiso", () => {
    for (const p of PERMISOS) expect(puedeVer("duena", p), p).toBe(true);
  });

  it("y cambia todo lo que se puede cambiar", () => {
    // `costo_y_margen` es de solo lectura por naturaleza: es un número que sale
    // de `valor_inventario` y de las líneas entregadas, no algo que alguien
    // teclee. Su nivel máximo es «ver», también para la dueña.
    for (const p of PERMISOS) {
      if (p === "costo_y_margen") {
        expect(nivelDe("duena", p)).toBe("ver");
        continue;
      }
      expect(puedeEditar("duena", p), p).toBe(true);
    }
  });
});

describe("la asistente", () => {
  it("lleva pedidos y gastos, y nada más", () => {
    expect(puedeEditar("asistente", "pedidos")).toBe(true);
    expect(puedeEditar("asistente", "gastos")).toBe(true);
    for (const p of [
      "cobros",
      "costo_y_margen",
      "precios_y_stock",
      "compras",
      "contabilidad",
      "cierre_de_mes",
      "ajustes",
    ] as const) {
      expect(puedeVer("asistente", p), p).toBe(false);
    }
  });

  it("no ve el costo ni el margen", () => {
    expect(nivelDe("asistente", "costo_y_margen")).toBe("no");
  });

  it("no confirma cobros: eso es de la dueña", () => {
    expect(puedeVer("asistente", "cobros")).toBe(false);
  });

  it("puede gastos pero NO compras", () => {
    // La celda «Compras y gastos» del plan dice «gastos» para la asistente, y
    // por eso el permiso está partido en dos.
    expect(puedeEditar("asistente", "gastos")).toBe(true);
    expect(puedeVer("asistente", "compras")).toBe(false);
  });
});

describe("la contadora", () => {
  it("lleva la contabilidad pero NO cierra el mes", () => {
    expect(puedeEditar("contadora", "contabilidad")).toBe(true);
    expect(puedeVer("contadora", "cierre_de_mes")).toBe(false);
  });

  it("ve el costo y el margen", () => {
    expect(puedeVer("contadora", "costo_y_margen")).toBe(true);
  });

  it("ve pedidos, compras y gastos, sin cambiarlos", () => {
    for (const p of ["pedidos", "compras", "gastos"] as const) {
      expect(nivelDe("contadora", p), p).toBe("ver");
    }
  });

  it("no toca precios, stock, cobros ni ajustes", () => {
    for (const p of ["precios_y_stock", "cobros", "ajustes"] as const) {
      expect(puedeVer("contadora", p), p).toBe(false);
    }
  });
});

describe("el motorizado", () => {
  it("no entra al panel: su superficie es ruta.babycaleb.com", () => {
    for (const p of PERMISOS) expect(puedeVer("motorizado", p), p).toBe(false);
  });

  it("no puede tener fila en usuarios", () => {
    expect(esRolDePanel("motorizado")).toBe(false);
    expect(esRol("motorizado")).toBe(true);
  });
});

describe("solo la dueña cambia precios, stock y ajustes", () => {
  it("y nadie más", () => {
    for (const permiso of ["precios_y_stock", "ajustes", "cierre_de_mes"] as const) {
      const quienes = ROLES.filter((r) => puedeEditar(r, permiso));
      expect(quienes, permiso).toEqual(["duena"]);
    }
  });
});

describe("coherencia", () => {
  it("todo rol tiene etiqueta", () => {
    expect(Object.keys(ETIQUETAS_ROL).sort()).toEqual([...ROLES].sort());
  });

  it("los roles de panel son los tres de usuarios.rol", () => {
    expect([...ROLES_DE_PANEL]).toEqual(["duena", "asistente", "contadora"]);
  });

  it("permisosDe devuelve una copia, no la matriz viva", () => {
    const copia = permisosDe("asistente");
    copia.ajustes = "editar";
    expect(nivelDe("asistente", "ajustes")).toBe("no");
  });

  it("los reconocedores rechazan lo que no es", () => {
    expect(esRol("gerente")).toBe(false);
    expect(esRol("")).toBe(false);
    expect(esRolDePanel("DUENA")).toBe(false);
  });
});

describe("usuarioDeCorreo", () => {
  const fila = (cambios: Partial<Parameters<typeof usuarioDeCorreo>[1]> = {}) => ({
    id: "u-1",
    correo: "duena@babycaleb.com",
    nombre: "La dueña",
    rol: "duena",
    activo: 1,
    ...cambios,
  });

  it("pasar Access no es entrar: también hay que estar en usuarios", () => {
    expect(usuarioDeCorreo("cualquiera@gmail.com", null)).toEqual({
      ok: false,
      motivo: "no_esta_en_usuarios",
    });
  });

  it("una fila desactivada no entra", () => {
    // Quitar a alguien es desactivar su fila, y eso tiene efecto en la
    // siguiente petición sin tocar la configuración de Cloudflare.
    expect(usuarioDeCorreo("duena@babycaleb.com", fila({ activo: 0 }))).toEqual({
      ok: false,
      motivo: "desactivado",
    });
  });

  it("un rol que no reconoce no entra, en vez de entrar sin permisos", () => {
    expect(usuarioDeCorreo("x@y.com", fila({ rol: "gerente" }))).toEqual({
      ok: false,
      motivo: "rol_desconocido",
    });
    expect(usuarioDeCorreo("x@y.com", fila({ rol: "motorizado" }))).toEqual({
      ok: false,
      motivo: "rol_desconocido",
    });
  });

  it("con la fila buena devuelve el usuario y normaliza el correo", () => {
    const r = usuarioDeCorreo("  DUENA@BabyCaleb.com ", fila());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usuario).toEqual({
        id: "u-1",
        correo: "duena@babycaleb.com",
        nombre: "La dueña",
        rol: "duena",
        activo: true,
      });
    }
  });
});
