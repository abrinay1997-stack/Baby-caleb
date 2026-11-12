import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `/api/salud` tiene que PREGUNTARLE al sistema, no mirar si el cable existe.
 *
 * Decía `env.SISTEMA ? "del sistema" : "falta el binding"`. El binding se
 * declara en `wrangler.jsonc`, así que está ahí siempre y esa comprobación no
 * podía ser falsa: con la base caída seguía diciendo «del sistema» mientras
 * cada petición servía la copia del build con los precios del día del
 * despliegue. La pantalla que se mira para saber si algo va mal afirmaba justo
 * lo que había dejado de ser verdad.
 *
 * Es la trampa §1 —un control que no puede fallar— en el peor sitio posible.
 *
 * El doble de `vitest.config.ts` contesta `sano: false` a propósito, así que
 * esta prueba corre por el camino que antes era invisible.
 */
describe("la salud de la web dice de dónde salen los precios", () => {
  const salud = async (): Promise<Record<string, unknown>> => {
    const r = await SELF.fetch("https://babycaleb.com/api/salud");
    expect(r.status).toBe(200);
    return (await r.json()) as Record<string, unknown>;
  };

  it("si el sistema contesta pero NO está sano, lo dice", async () => {
    const d = await salud();
    const catalogo = String(d.catalogo);
    // Lo que importa no es la frase exacta: es que NO afirme que los precios
    // vienen del sistema cuando no vienen.
    expect(catalogo).not.toBe("del sistema");
    expect(catalogo.toLowerCase()).toContain("copia del build");
  });

  it("y se entiende sin leer el código", async () => {
    // Quien abre esto a las once de la noche porque una clienta avisó de un
    // precio raro no debería tener que interpretar una palabra clave.
    const catalogo = String((await salud()).catalogo);
    expect(catalogo).toMatch(/sistema/i);
    expect(catalogo.length).toBeGreaterThan(20);
  });

  it("el resto de la salud sigue contestando", async () => {
    // El cambio no puede haberse llevado por delante lo que ya avisaba.
    const d = await salud();
    expect(d.ok).toBe(true);
    expect(d).toHaveProperty("buscadores");
    expect(d).toHaveProperty("chat");
    expect(d).toHaveProperty("chat_limite");
    expect(d).toHaveProperty("version");
  });
});
