import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * El correo de `usuarios` es la llave de entrada al panel.
 *
 * Access entrega el correo SIEMPRE en minúsculas —`src/seguridad/access.ts` lo
 * normaliza al leer el token—, pero las filas de `usuarios` se escriben a
 * mano: hoy por SQL, mañana desde la pestaña Usuarios. Y en SQLite
 * `WHERE correo = ?` distingue mayúsculas.
 *
 * Sin la migración 0005, un «Yarielis@Gmail.com» tecleado con mayúscula deja a
 * esa persona FUERA PARA SIEMPRE, y el síntoma es un «no autorizado» que no
 * explica nada. En un panel cuya dueña no usa la terminal, eso es un callejón
 * sin salida: la fila está ahí, se ve en la pantalla de Usuarios, y la persona
 * no entra.
 *
 * Estas pruebas corren contra una D1 de verdad: lo que se comprueba es que el
 * índice de la 0005 y el COLLATE NOCASE de la consulta hacen su trabajo.
 */

// La consulta tal como la hace el panel (src/api/panel.ts · porAccess).
const COMO_EL_PANEL =
  "SELECT id, correo, nombre, rol, activo FROM usuarios WHERE correo = ? COLLATE NOCASE";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM usuarios").run();
});

const alta = (id: string, correo: string) =>
  env.DB.prepare(
    "INSERT INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES (?,?,'Yarielis','duena',1,?)",
  )
    .bind(id, correo, Date.now())
    .run();

describe("entrar al panel no depende de cómo se tecleó el correo", () => {
  it("una fila guardada con mayúsculas SÍ casa con el correo que da Access", async () => {
    await alta("u-may", "Yarielis@Gmail.com");

    const fila = await env.DB.prepare(COMO_EL_PANEL)
      .bind("yarielis@gmail.com") // lo que entrega Access, ya en minúsculas
      .first<{ id: string }>();

    expect(fila?.id).toBe("u-may");
  });

  it("y sin COLLATE NOCASE no casaría: por eso está puesto", async () => {
    // Esta es la prueba de que el arreglo hace falta. Si algún día alguien
    // quita el COLLATE de la consulta «porque no hace nada», esto se queda en
    // verde y la de arriba se pone roja — que es exactamente el aviso.
    await alta("u-may", "Yarielis@Gmail.com");

    const fila = await env.DB.prepare(
      "SELECT id FROM usuarios WHERE correo = ?", // a propósito, sin NOCASE
    )
      .bind("yarielis@gmail.com")
      .first<{ id: string }>();

    expect(fila).toBeNull();
  });

  it("el caso normal, todo en minúsculas, sigue igual", async () => {
    await alta("u-min", "yarielis@gmail.com");
    const fila = await env.DB.prepare(COMO_EL_PANEL)
      .bind("yarielis@gmail.com")
      .first<{ id: string }>();
    expect(fila?.id).toBe("u-min");
  });

  it("quien NO está en usuarios sigue sin casar", async () => {
    await alta("u-min", "yarielis@gmail.com");
    const fila = await env.DB.prepare(COMO_EL_PANEL)
      .bind("otra@gmail.com")
      .first<{ id: string }>();
    expect(fila).toBeNull();
  });
});

describe("no pueden existir dos filas para la misma persona", () => {
  it("dos correos que solo se diferencian en mayúsculas se rechazan", async () => {
    // El UNIQUE de la columna distingue mayúsculas, así que SIN el índice de
    // la 0005 estas dos filas convivirían: dos «usuarios» para una persona, y
    // cuál de los dos manda dependería de cuál encuentre la consulta primero.
    await alta("u-1", "yarielis@gmail.com");
    await expect(alta("u-2", "Yarielis@Gmail.com")).rejects.toThrow();

    const { results } = await env.DB.prepare("SELECT id FROM usuarios").all();
    expect(results).toHaveLength(1);
  });
});
