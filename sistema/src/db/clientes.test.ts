import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { buscar, encontrarOCrear, normalizarCelular } from "./clientes";

const T = 1_800_000_000_000;
const ctx = { db: real.DB, ahora: T, actor: "duena@babycaleb.com" };

beforeEach(async () => {
  await real.DB.prepare("DELETE FROM clientes WHERE id LIKE 'cl-prueba%' OR celular_e164 LIKE '5079%'").run();
});

describe("normalizarCelular", () => {
  /**
   * Tres formas de teclear el mismo número tienen que llegar a la misma fila.
   * Si no, el formato de tecleo crea clientas nuevas, que es exactamente el
   * duplicado que este módulo existe para evitar — entrando por detrás.
   */
  it("lleva las formas de teclear un celular panameño al mismo número", () => {
    for (const crudo of ["60000001", "6000-0001", "6000 0001", "+507 6000-0001", "50760000001"]) {
      expect(normalizarCelular(crudo), crudo).toBe("50760000001");
    }
  });

  it("rechaza lo que no es un número de teléfono", () => {
    for (const malo of ["", "   ", "abc", "12", "1234567890123456789"]) {
      expect(normalizarCelular(malo), malo).toBeNull();
    }
  });
});

describe("encontrarOCrear: la defensa contra los duplicados", () => {
  it("la segunda vez devuelve la MISMA clienta, no una nueva", async () => {
    const a = await encontrarOCrear(ctx, { nombre: "Rosa Sánchez", celular: "6999-0001" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.datos.nuevo).toBe(true);

    // La misma persona, apuntada distinto y escrita distinta: pasa a menudo
    // cuando quien atiende no se acuerda de si ya la tenía.
    const b = await encontrarOCrear(ctx, { nombre: "rosa e.", celular: "+507 6999 0001" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.datos.nuevo).toBe(false);
    expect(b.datos.clienteId).toBe(a.datos.clienteId);

    const cuantas = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM clientes WHERE celular_e164 = '50769990001'",
    ).first<{ n: number }>();
    expect(cuantas?.n).toBe(1);
  });

  it("no pisa el nombre que ya estaba", async () => {
    const a = await encontrarOCrear(ctx, { nombre: "Rosa Sánchez", celular: "6999-0002" });
    expect(a.ok).toBe(true);
    await encontrarOCrear(ctx, { nombre: "rosa", celular: "6999-0002" });

    const f = await real.DB.prepare(
      "SELECT nombre FROM clientes WHERE celular_e164 = '50769990002'",
    ).first<{ nombre: string }>();
    // El nombre completo vale más que el apunte rápido de la segunda vez.
    expect(f?.nombre).toBe("Rosa Sánchez");
  });

  it("una clienta fusionada devuelve la ficha que quedó viva", async () => {
    const vieja = await encontrarOCrear(ctx, { nombre: "Rosa vieja", celular: "6999-0003" });
    const nueva = await encontrarOCrear(ctx, { nombre: "Rosa buena", celular: "6999-0004" });
    expect(vieja.ok && nueva.ok).toBe(true);
    if (!vieja.ok || !nueva.ok) return;

    await real.DB.prepare("UPDATE clientes SET fusionado_en_id = ? WHERE id = ?")
      .bind(nueva.datos.clienteId, vieja.datos.clienteId)
      .run();

    // Quien marque el celular viejo tiene que llegar a la persona, no a una
    // ficha muerta sin historial.
    const otra = await encontrarOCrear(ctx, { nombre: "Rosa", celular: "6999-0003" });
    expect(otra.ok).toBe(true);
    if (!otra.ok) return;
    expect(otra.datos.clienteId).toBe(nueva.datos.clienteId);
  });

  it("exige nombre y un celular que se entienda", async () => {
    expect((await encontrarOCrear(ctx, { nombre: "  ", celular: "6999-0005" })).ok).toBe(false);
    expect((await encontrarOCrear(ctx, { nombre: "Rosa", celular: "no" })).ok).toBe(false);
  });
});

describe("buscar", () => {
  it("sin nada escrito no devuelve a nadie", async () => {
    const r = await buscar(real.DB, "   ");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clientas).toEqual([]);
  });

  it("encuentra por nombre y por celular tecleado de cualquier forma", async () => {
    await encontrarOCrear(ctx, { nombre: "Yarielis Concepción", celular: "6999-0009" });

    const porNombre = await buscar(real.DB, "yarielis");
    expect(porNombre.ok).toBe(true);
    if (!porNombre.ok) return;
    expect(porNombre.datos.clientas.some((c) => c.celular_e164 === "50769990009")).toBe(true);

    const porCelular = await buscar(real.DB, "6999 0009");
    expect(porCelular.ok).toBe(true);
    if (!porCelular.ok) return;
    expect(porCelular.datos.clientas).toHaveLength(1);
  });

  it("no enseña a las fusionadas: apuntan a otra ficha", async () => {
    const v = await encontrarOCrear(ctx, { nombre: "Fusionada Pérez", celular: "6999-0010" });
    const q = await encontrarOCrear(ctx, { nombre: "Quedó Viva", celular: "6999-0011" });
    if (!v.ok || !q.ok) return;
    await real.DB.prepare("UPDATE clientes SET fusionado_en_id = ? WHERE id = ?")
      .bind(q.datos.clienteId, v.datos.clienteId)
      .run();

    const r = await buscar(real.DB, "Fusionada");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clientas).toEqual([]);
  });
});
