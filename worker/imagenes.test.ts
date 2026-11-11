import { describe, expect, it } from "vitest";
import type { SistemaWebBinding } from "./catalogo";
import { PREFIJO, imagen } from "./imagenes";

/**
 * La ruta pública de las fotos.
 *
 * Lo que se comprueba aquí NO es si una clave puede salir —eso lo decide el
 * sistema, mirando la fila— sino que esta capa no se invente ninguna decisión
 * por su cuenta y que no filtre qué existe.
 */

const pedir = (ruta: string) => new Request(`https://babycaleb.com${ruta}`);

const sistema = (respuesta: Awaited<ReturnType<SistemaWebBinding["archivo"]>>): SistemaWebBinding & {
  pedidas: string[];
} => {
  const pedidas: string[] = [];
  return {
    pedidas,
    async catalogo() {
      return { ok: false, codigo: "interno", mensaje: "no toca" };
    },
    async archivo(clave) {
      pedidas.push(clave);
      return respuesta;
    },
  };
};

const UNA_FOTO = {
  ok: true as const,
  datos: { bytes: new TextEncoder().encode("imagen").buffer as ArrayBuffer, mime: "image/webp" },
};

describe("sirve lo que el sistema autoriza", () => {
  it("devuelve la imagen con el tipo que dijo el sistema", async () => {
    const r = await imagen(pedir("/foto/catalogo/NAT-M/01H.webp"), sistema(UNA_FOTO));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(await r.text()).toBe("imagen");
  });

  it("pasa la clave TAL CUAL, sin interpretarla", async () => {
    const s = sistema(UNA_FOTO);
    await imagen(pedir("/foto/catalogo/NAT-M/01H.webp"), s);
    // Si esta capa recortara, normalizara o reconstruyera la clave, la
    // comprobación del sistema se haría sobre una clave distinta de la que se
    // lee de R2. Ese desajuste es exactamente cómo sale lo que no debe.
    expect(s.pedidas).toEqual(["catalogo/NAT-M/01H.webp"]);
  });

  it("descodifica el porcentaje de la URL", async () => {
    const s = sistema(UNA_FOTO);
    await imagen(pedir("/foto/catalogo/NAT%20M/a.webp"), s);
    expect(s.pedidas).toEqual(["catalogo/NAT M/a.webp"]);
  });

  it("no la guarda el navegador para siempre por error: la clave lleva el tiempo dentro", async () => {
    const r = await imagen(pedir("/foto/a/b.webp"), sistema(UNA_FOTO));
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("no cuenta lo que no debe", () => {
  it("una clave que el sistema no autoriza da 404", async () => {
    const r = await imagen(pedir("/foto/comprobantes/x.jpg"), sistema({ ok: true, datos: null }));
    expect(r.status).toBe(404);
  });

  it("un fallo del sistema da el MISMO 404, no un 500 que delate", async () => {
    const r = await imagen(
      pedir("/foto/a/b.webp"),
      sistema({ ok: false, codigo: "entrada_invalida", mensaje: "clave inválida" }),
    );
    // «No existe» y «no te lo puedo dar» contestan igual: distinguirlos le
    // diría a quien prueba claves al azar cuáles existen, y en ese bucket hay
    // comprobantes de pago.
    expect(r.status).toBe(404);
  });

  it("los dos casos dan exactamente el mismo cuerpo", async () => {
    const a = await imagen(pedir("/foto/a.webp"), sistema({ ok: true, datos: null }));
    const b = await imagen(
      pedir("/foto/a.webp"),
      sistema({ ok: false, codigo: "interno", mensaje: "se cayó la base" }),
    );
    expect(await a.text()).toBe(await b.text());
    expect(a.status).toBe(b.status);
  });
});

describe("lo que no es una petición normal", () => {
  it("sin binding es 503, no 404: es una avería, no una foto que falta", async () => {
    const r = await imagen(pedir("/foto/a.webp"), undefined);
    expect(r.status).toBe(503);
  });

  it("una clave vacía da 404 sin molestar al sistema", async () => {
    const s = sistema(UNA_FOTO);
    const r = await imagen(pedir("/foto/"), s);
    expect(r.status).toBe(404);
    expect(s.pedidas, "no se le pregunta por una clave vacía").toEqual([]);
  });

  it("un % suelto no revienta la petición", async () => {
    const s = sistema(UNA_FOTO);
    const r = await imagen(new Request("https://babycaleb.com/foto/a%zz.webp"), s);
    expect(r.status).toBe(404);
    expect(s.pedidas).toEqual([]);
  });
});

describe("no se pisa con las imágenes del sitio", () => {
  it("el prefijo NO es /img/", () => {
    // `/img/` es de las 26 imágenes de `public/img/` —el logo, el hero— y
    // ponerle el Worker delante las dejó TODAS rotas en producción: las
    // buscaba en R2, donde no están. Esta línea existe para que el día que
    // alguien quiera «simplificar» juntando las dos rutas, se caiga aquí y
    // no en el sitio en vivo.
    expect(PREFIJO).not.toBe("/img/");
    expect(PREFIJO).toBe("/foto/");
  });

});
