import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Prueba el Worker completo, no una función suelta: arranca el fetch, pasa por
// Hono y consulta la D1 de verdad. Si el esqueleto no se ensambla, falla aquí.
describe("/salud", () => {
  it("responde sano con versión, entorno y la última migración aplicada", async () => {
    const r = await SELF.fetch("https://panel.babycaleb.com/salud");
    expect(r.status).toBe(200);

    const cuerpo = (await r.json()) as {
      sano: boolean; version: string; entorno: string; migracion: string | null; humo: boolean;
    };
    expect(cuerpo.sano).toBe(true);
    expect(cuerpo.humo).toBe(true);
    expect(cuerpo.migracion).toBe("0001_base.sql");
    expect(cuerpo.version).toBeTruthy();
  });

  it("una ruta desconocida contesta 404 con el contrato de error", async () => {
    const r = await SELF.fetch("https://panel.babycaleb.com/no-existe");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, codigo: "no_encontrado" });
  });
});
