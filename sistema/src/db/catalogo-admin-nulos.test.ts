import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { editarVariante } from "./catalogo-admin";

/**
 * Guardar una variante con una columna VACÍA.
 *
 * Esto no es un caso raro: fue el estado de los DOCE productos de producción
 * el día que la dueña entró por primera vez. Ninguno tenía tasa de ITBMS
 * —la pone la contadora y todavía no estaba—, y el formulario manda esa
 * casilla vacía como `null`.
 *
 * El resultado era que NINGÚN guardado del catálogo funcionaba, para ningún
 * producto, y el panel contestaba «alguien cambió esta variante mientras la
 * editaba» cuando no había nadie más. La fila de control comprobaba sus
 * columnas con `=`, y en SQL `tasa_itbms_bp = NULL` no es falso: es
 * DESCONOCIDO. El control daba cero, el CHECK tumbaba el batch, y el error
 * señalaba a un culpable que no existía.
 *
 * Lo peor no fue el fallo sino el mensaje: mandaba a la dueña a cerrar y
 * volver a abrir una pantalla que iba a fallar otra vez igual.
 */

const T = 1_800_000_000_000;
const ctx = { db: real.DB, actor: "usr-duena", ahora: T };

async function variante(): Promise<{ publicado: number; version: number; tasa: number | null }> {
  const f = await real.DB.prepare(
    "SELECT publicado, version, tasa_itbms_bp AS tasa FROM variantes WHERE codigo = 'NUL-1'",
  ).first<{ publicado: number; version: number; tasa: number | null }>();
  if (f === null) throw new Error("la siembra no dejó la variante");
  return f;
}

beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p-nul','portabebe','Producto sin ITBMS','producto-sin-itbms',?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en) VALUES ('NUL-1','p-nul','Producto sin ITBMS','Unitalla',1,6500,NULL,0,?)",
    ).bind(T),
    // Al estado de partida, sea cual sea el de la prueba anterior.
    real.DB.prepare(
      "UPDATE variantes SET publicado = 0, talla = 'Unitalla', tasa_itbms_bp = NULL WHERE codigo = 'NUL-1'",
    ),
  ]);
});

describe("editar una variante con columnas vacías", () => {
  it("publica un producto que no tiene tasa de ITBMS", async () => {
    const antes = await variante();

    // Lo que manda la pantalla al marcar «mostrar en la web»: TODOS los
    // campos, incluido el ITBMS vacío. La pantalla no sabe cuáles cambiaron.
    const r = await editarVariante(
      ctx,
      "NUL-1",
      {
        nombre: "Producto sin ITBMS",
        talla: "Unitalla",
        unidadesPorCaja: 1,
        precioCents: 6500,
        tasaItbmsBp: null,
        publicado: true,
      },
      antes.version,
    );

    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);
    const despues = await variante();
    expect(despues.publicado).toBe(1);
    expect(despues.version).toBe(antes.version + 1);
    expect(despues.tasa).toBeNull();
  });

  it("también cuando la columna vacía es la talla", async () => {
    const antes = await variante();
    const r = await editarVariante(
      ctx,
      "NUL-1",
      { talla: null, publicado: true, tasaItbmsBp: null },
      antes.version,
    );
    expect(r.ok, r.ok ? "" : r.mensaje).toBe(true);
    expect((await variante()).publicado).toBe(1);
  });

  /**
   * Y la defensa de verdad sigue en pie: con una versión vieja no se guarda.
   *
   * Importa decirlo aquí. El arreglo cambió `=` por `IS` en el control, y un
   * `IS` es más permisivo que un `=`; si al aflojar la comparación se hubiera
   * aflojado también la defensa contra la actualización perdida, el arreglo
   * habría costado más de lo que resolvió.
   */
  it("sigue sin dejar guardar con una versión vieja", async () => {
    const antes = await variante();
    const primera = await editarVariante(ctx, "NUL-1", { publicado: true }, antes.version);
    expect(primera.ok).toBe(true);

    // Alguien más ya guardó: esta pantalla trae la versión de antes.
    const tarde = await editarVariante(
      ctx,
      "NUL-1",
      { publicado: false, tasaItbmsBp: null },
      antes.version,
    );
    expect(tarde.ok).toBe(false);
    if (tarde.ok) return;
    expect(tarde.codigo).toBe("conflicto_version");
    // Y no escribió: sigue publicado.
    expect((await variante()).publicado).toBe(1);
  });
});
