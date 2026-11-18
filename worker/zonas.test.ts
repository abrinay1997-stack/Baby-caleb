import { describe, expect, it } from "vitest";

import { zonas, type SistemaWebZonas } from "./zonas";

/**
 * La ruta de las zonas de envío.
 *
 * Lo que se prueba aquí es SOLO el enrutado y lo que pasa cuando el sistema no
 * contesta. Qué zona es pública y qué campos lleva lo decide y lo prueba el
 * sistema (`sistema/src/rpc/zonas.ts`), que es donde está el tarifario.
 *
 * ## Romper a propósito
 *
 * Devuelva una lista vacía en vez del 503 cuando el binding revienta, o quite
 * el `no-store` de las respuestas de error. Las dos ponen roja su casilla.
 */

const sistemaQue = (
  r: { ok: true; datos: unknown[] } | { ok: false; codigo: string; mensaje: string } | "revienta",
): SistemaWebZonas => ({
  async zonasEnvio() {
    if (r === "revienta") throw new Error("el binding no contestó");
    return r;
  },
});

const GET = () => new Request("https://babycaleb.com/api/zonas");

const ZONA = {
  id: "z1",
  nombre: "12 de Octubre",
  alias: [],
  region: "ciudad",
  tarifaCents: 400,
  requierePagoTotal: false,
};

describe("/api/zonas", () => {
  it("devuelve lo que publica el sistema, sin tocarlo", async () => {
    // No se filtra ni se renombra nada aquí: quién decide qué es público es el
    // sistema, en un solo sitio. Dos filtros acaban discrepando.
    const r = await zonas(GET(), sistemaQue({ ok: true, datos: [ZONA] }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ zonas: [ZONA] });
  });

  it("y se puede guardar un rato: el tarifario casi nunca cambia", async () => {
    const r = await zonas(GET(), sistemaQue({ ok: true, datos: [ZONA] }));
    expect(r.headers.get("cache-control")).toContain("max-age=");
  });

  it("sin binding contesta 503, NO una lista vacía", async () => {
    // Cero zonas y «no pude preguntar» son cosas distintas, y la pantalla las
    // dice distinto (`docs/TRAMPAS.md` §7). Con una lista vacía, el
    // desplegable saldría sin opciones como si el negocio no enviara a ningún
    // sitio.
    const r = await zonas(GET(), undefined);
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("con el sistema de una versión anterior al método, también 503", async () => {
    const r = await zonas(GET(), {});
    expect(r.status).toBe(503);
  });

  it("si el sistema dice que no, 503 y su motivo", async () => {
    const r = await zonas(GET(), sistemaQue({ ok: false, codigo: "interno", mensaje: "la base no contestó" }));
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("la base no contestó");
  });

  it("si el binding revienta, 503 y no se cae la ruta", async () => {
    const r = await zonas(GET(), sistemaQue("revienta"));
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("un error nunca se queda guardado en la caché del borde", async () => {
    // Un 503 cacheado cinco minutos deja la tienda sin zonas cinco minutos
    // DESPUÉS de que el sistema haya vuelto.
    for (const sistema of [undefined, {}, sistemaQue("revienta")]) {
      const r = await zonas(GET(), sistema);
      expect(r.headers.get("cache-control"), `estado ${r.status}`).toBe("no-store");
    }
  });

  it("no se puede escribir por aquí", async () => {
    const r = await zonas(
      new Request("https://babycaleb.com/api/zonas", { method: "POST" }),
      sistemaQue({ ok: true, datos: [ZONA] }),
    );
    expect(r.status).toBe(405);
  });
});
