import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { cambiarEstado, crear, editar, listar } from "./motorizados";

const T = 1_800_000_000_000;
const ctx = { db: real.DB, ahora: T };

/**
 * Se limpia por celular y no por id: los ids son ULID y cambian en cada
 * corrida, así que un `LIKE 'mt-prueba%'` no borraría nada y las pruebas se
 * irían contaminando entre sí hasta que el UNIQUE del celular tumbe una.
 */
beforeEach(async () => {
  await real.DB.prepare("DELETE FROM rutas WHERE motorizado_id IN (SELECT id FROM motorizados WHERE celular_e164 LIKE '5079%')").run();
  await real.DB.prepare("DELETE FROM motorizados WHERE celular_e164 LIKE '5079%'").run();
});

describe("dar de alta a un motorizado", () => {
  /**
   * El eslabón que faltaba. Esto es lo que antes solo se podía hacer con SQL a
   * mano, y sin esta fila `armarRuta` no tiene a quién asignarle nada.
   */
  it("lo crea activo y con el celular normalizado", async () => {
    const r = await crear(ctx, { nombre: "  Luis   Pérez ", celular: "7900-0001", vehiculo: "moto" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos.nombre).toBe("Luis Pérez");
    expect(r.datos.celular_e164).toBe("50779000001");

    const fila = await real.DB.prepare(
      "SELECT nombre, estado, vehiculo, pin_hash, creado_en FROM motorizados WHERE id = ?",
    )
      .bind(r.datos.id)
      .first<{ nombre: string; estado: string; vehiculo: string | null; pin_hash: string | null; creado_en: number }>();

    expect(fila?.estado).toBe("activo");
    expect(fila?.vehiculo).toBe("moto");
    // El PIN se queda en NULL a propósito: la puerta del motorizado no existe
    // todavía y un PIN guardado sin puerta es una credencial sin uso.
    expect(fila?.pin_hash).toBeNull();
    expect(fila?.creado_en).toBe(T);
  });

  it("acepta que no se sepa en qué anda", async () => {
    const r = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0002" });
    expect(r.ok).toBe(true);
  });

  /**
   * El mismo número dos veces es la MISMA persona apuntada dos veces, y en la
   * lista de a quién asignar se vería como dos. El mensaje dice con quién
   * choca, porque «constraint failed» obliga a venir a leer el código.
   */
  it("no deja dos con el mismo celular, y dice de quién es", async () => {
    await crear(ctx, { nombre: "Luis Pérez", celular: "7900-0003" });
    const otra = await crear(ctx, { nombre: "Luis P.", celular: "+507 7900 0003" });

    expect(otra.ok).toBe(false);
    if (otra.ok) return;
    expect(otra.codigo).toBe("repetido");
    expect(otra.mensaje).toContain("Luis Pérez");
  });

  it("pide un nombre y un celular que se entiendan", async () => {
    for (const malo of [
      { nombre: "", celular: "7900-0004" },
      { nombre: "   ", celular: "7900-0004" },
      { nombre: "x".repeat(61), celular: "7900-0004" },
      { nombre: "Luis", celular: "12" },
      { nombre: "Luis", celular: "abc" },
      { nombre: "Luis", celular: "7900-0004", vehiculo: "avioneta" },
    ]) {
      const r = await crear(ctx, malo);
      expect(r.ok, JSON.stringify(malo)).toBe(false);
    }
  });
});

describe("corregirlo", () => {
  it("cambia solo lo que se pide", async () => {
    const alta = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0010", vehiculo: "moto" });
    if (!alta.ok) throw new Error("no se pudo dar de alta");

    const r = await editar(ctx, alta.datos.id, { celular: "7900-0011" });
    expect(r.ok).toBe(true);

    const fila = await real.DB.prepare(
      "SELECT nombre, celular_e164, vehiculo FROM motorizados WHERE id = ?",
    )
      .bind(alta.datos.id)
      .first<{ nombre: string; celular_e164: string; vehiculo: string | null }>();

    expect(fila?.celular_e164).toBe("50779000011");
    expect(fila?.nombre).toBe("Ana Gómez");
    expect(fila?.vehiculo).toBe("moto");
  });

  /**
   * Un UPDATE que no casa con ninguna fila NO falla en D1: afecta cero filas y
   * la petición saldría con un «listo» sobre alguien que no existe. Es la
   * trampa nº 1 del repositorio y aquí está la prueba que la vigila.
   */
  it("un id que no existe NO contesta que se hizo", async () => {
    const r = await editar(ctx, "no-existe-este-id", { nombre: "Nadie" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });

  it("no deja robarle el celular a otro", async () => {
    const a = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0020" });
    const b = await crear(ctx, { nombre: "Luis Pérez", celular: "7900-0021" });
    if (!a.ok || !b.ok) throw new Error("no se pudo dar de alta");

    const r = await editar(ctx, b.datos.id, { celular: "7900-0020" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensaje).toContain("Ana Gómez");
  });

  it("pide que se diga qué cambiar", async () => {
    const a = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0030" });
    if (!a.ok) throw new Error("no se pudo dar de alta");
    const r = await editar(ctx, a.datos.id, {});
    expect(r.ok).toBe(false);
  });
});

describe("activo, en pausa o fuera", () => {
  it("lo pausa y lo vuelve a activar", async () => {
    const a = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0040" });
    if (!a.ok) throw new Error("no se pudo dar de alta");

    const pausa = await cambiarEstado(ctx, a.datos.id, "pausa");
    expect(pausa.ok).toBe(true);
    if (!pausa.ok) return;
    expect(pausa.datos.estado).toBe("pausa");

    const fila = await real.DB.prepare("SELECT estado FROM motorizados WHERE id = ?")
      .bind(a.datos.id)
      .first<{ estado: string }>();
    expect(fila?.estado).toBe("pausa");

    expect((await cambiarEstado(ctx, a.datos.id, "activo")).ok).toBe(true);
  });

  it("solo acepta los tres estados que existen", async () => {
    const a = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0050" });
    if (!a.ok) throw new Error("no se pudo dar de alta");

    for (const malo of ["despedido", "ACTIVO", "", 1, null]) {
      const r = await cambiarEstado(ctx, a.datos.id, malo);
      expect(r.ok, String(malo)).toBe(false);
    }
  });

  it("un id que no existe no contesta que se hizo", async () => {
    const r = await cambiarEstado(ctx, "no-existe-este-id", "pausa");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });

  /**
   * Pausar a alguien con la ruta a medias SE PERMITE —si se accidentó, hay que
   * poder— pero la respuesta tiene que decir cuántas entregas quedan en la
   * calle. Si no lo dijera, se descubriría al día siguiente.
   */
  it("avisa cuántas rutas sin cerrar tiene encima", async () => {
    const a = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0060" });
    if (!a.ok) throw new Error("no se pudo dar de alta");

    const bodega = await real.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
    await real.DB.prepare(
      `INSERT INTO rutas (id, fecha, motorizado_id, bodega_id, estado, creada_por, creada_en)
       VALUES (?,?,?,?,'borrador',?,?)`,
    )
      .bind(
        `rt-prueba-${a.datos.id}`,
        "2026-11-12",
        a.datos.id,
        bodega?.id ?? "bod-1",
        "duena@babycaleb.com",
        T,
      )
      .run();

    const r = await cambiarEstado(ctx, a.datos.id, "pausa");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.rutasAbiertas).toBe(1);
  });
});

describe("la lista", () => {
  it("esconde a los inactivos salvo que se pidan, y pone a los activos primero", async () => {
    const fuera = await crear(ctx, { nombre: "Zoe Fuera", celular: "7900-0070" });
    const dentro = await crear(ctx, { nombre: "Ana Dentro", celular: "7900-0071" });
    if (!fuera.ok || !dentro.ok) throw new Error("no se pudo dar de alta");
    await cambiarEstado(ctx, fuera.datos.id, "inactivo");

    const normal = await listar(real.DB);
    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    const ids = normal.datos.motorizados.map((m) => m.id);
    expect(ids).toContain(dentro.datos.id);
    expect(ids).not.toContain(fuera.datos.id);

    const todos = await listar(real.DB, { incluirInactivos: true });
    if (!todos.ok) return;
    expect(todos.datos.motorizados.map((m) => m.id)).toContain(fuera.datos.id);
  });

  /**
   * `tiene_pin` sale como un sí o un no, nunca el hash. Es el mismo criterio
   * de todo el repositorio: un secreto no se devuelve ni recortado.
   */
  it("dice si tiene PIN pero no lo devuelve", async () => {
    const a = await crear(ctx, { nombre: "Ana Gómez", celular: "7900-0080" });
    if (!a.ok) throw new Error("no se pudo dar de alta");

    const r = await listar(real.DB);
    if (!r.ok) return;
    const suyo = r.datos.motorizados.find((m) => m.id === a.datos.id);
    expect(suyo?.tiene_pin).toBe(false);
    expect(JSON.stringify(r.datos)).not.toContain("pbkdf2");
    expect(Object.keys(suyo ?? {})).not.toContain("pin_hash");
  });
});
