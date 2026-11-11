import { describe, expect, it, vi } from "vitest";
import { reescribirHead } from "./head";
import type { VarianteParaFicha } from "../src/seo/producto";

/**
 * El `<head>` que ve un robot, un buscador y WhatsApp.
 *
 * La SPA pinta su `<head>` con JavaScript, y un robot que no ejecuta
 * JavaScript se queda con el `index.html` de fábrica: mismo título y misma
 * descripción en las siete páginas. Por eso el Worker lo reescribe en el
 * borde — y por eso hay que probarlo aquí dentro, donde existe HTMLRewriter.
 */

const PAGINA = `<!DOCTYPE html><html lang="es"><head>
<title>Baby Caleb</title>
<meta name="description" content="">
<meta property="og:title" content="">
<meta property="og:description" content="">
<meta property="og:url" content="">
<meta name="twitter:title" content="">
<meta name="twitter:description" content="">
<meta name="robots" content="index, follow">
<link rel="canonical" href="">
</head><body><div id="root"></div></body></html>`;

const SITIO = "https://babycaleb.com";

const pedir = async (camino: string, token?: string) => {
  const r = new Response(PAGINA, { headers: { "content-type": "text/html; charset=utf-8" } });
  const salida = reescribirHead(r, new URL(`${SITIO}${camino}`), SITIO, token);
  return await salida.text();
};

describe("cada página pública lleva su propio head", () => {
  it("el canónico apunta a la página, no a la portada", async () => {
    const html = await pedir("/faq");
    expect(html).toContain(`<link rel="canonical" href="${SITIO}/faq">`);
    expect(html).toContain(`content="${SITIO}/faq"`);
  });

  it("el título y la descripción cambian por ruta", async () => {
    const portada = await pedir("/");
    const faq = await pedir("/faq");
    const tituloDe = (h: string) => h.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";

    expect(tituloDe(portada)).not.toBe("");
    expect(tituloDe(faq)).not.toBe("");
    expect(tituloDe(faq)).not.toBe(tituloDe(portada));
  });
});

describe("lo que no es de nadie no se indexa", () => {
  it("el seguimiento lleva un token en la URL y va con noindex", async () => {
    const html = await pedir("/seguimiento/abc123");
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("una página pública NO va con noindex", async () => {
    const html = await pedir("/faq");
    expect(html).not.toContain("noindex");
  });
});

describe("la analítica (F1.8)", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef"; // 32 hexadecimales, como los de Cloudflare

  it("sin token no se inyecta nada", async () => {
    const html = await pedir("/");
    expect(html).not.toContain("cloudflareinsights");
  });

  it("con el token puesto, el beacon entra en el head", async () => {
    const html = await pedir("/", TOKEN);
    expect(html).toContain("static.cloudflareinsights.com/beacon.min.js");
    expect(html).toContain(`{"token": "${TOKEN}"}`);
    // Dentro del <head>, no colgando del <body>.
    expect(html.indexOf("cloudflareinsights")).toBeLessThan(html.indexOf("</head>"));
  });

  it("un token con comillas NO se escribe: rompería el head entero", async () => {
    // No es paranoia de manual. Este valor sale de la configuración y acaba
    // dentro de un atributo HTML que además lleva JSON: una comilla cierra el
    // atributo y lo que siga se interpreta como marcado. Una analítica que no
    // cuenta es un problema pequeño; un <head> roto se lleva la página.
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const html = await pedir("/", `"></script><script>alert(1)</script><x y="`);
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("cloudflareinsights");
      expect(avisos).toHaveBeenCalledOnce();
      expect(String(avisos.mock.calls[0]?.[0])).toContain("analitica_token_invalido");
    } finally {
      avisos.mockRestore();
    }
  });

  it("y un token que simplemente está mal tampoco", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const malo of ["abc", "0123456789ABCDEF0123456789ABCDEF", "x".repeat(32)]) {
        const html = await pedir("/", malo);
        expect(html, malo).not.toContain("cloudflareinsights");
      }
    } finally {
      avisos.mockRestore();
    }
  });

  it("los espacios alrededor no cuentan como «sin token»", async () => {
    const html = await pedir("/", `  ${TOKEN}  `);
    expect(html).toContain("beacon.min.js");
  });
});

describe("la ficha de un producto (F3.7)", () => {
  const VARIANTE: VarianteParaFicha = {
    codigo: "NAT-M",
    slug: "panales-nateen-cierre-nat-m",
    nombre: "Pañal Nateen Talla M de cierre — caja de 144",
    talla: "M",
    pesoMinLb: 8,
    pesoMaxLb: 19,
    unidadesPorCaja: 144,
    precioCents: 5000,
    disponibilidad: "disponible",
  };

  const ficha = async (camino: string, vs = [VARIANTE]) => {
    const r = new Response(PAGINA, { headers: { "content-type": "text/html; charset=utf-8" } });
    return await reescribirHead(r, new URL(`${SITIO}${camino}`), SITIO, undefined, vs).text();
  };

  it("el título y el canónico son los de ESA variante", async () => {
    const html = await ficha("/productos/panales-nateen-cierre-nat-m");
    expect(html).toContain("Pañal Nateen Talla M de cierre");
    expect(html).toContain(`href="${SITIO}/productos/panales-nateen-cierre-nat-m"`);
  });

  it("la descripción lleva talla, peso, caja y precio", async () => {
    const html = await ficha("/productos/panales-nateen-cierre-nat-m");
    expect(html).toContain("Talla M");
    expect(html).toContain("de 8 a 19 lb");
    expect(html).toContain("caja de 144");
    expect(html).toContain("$50");
  });

  it("lleva el JSON-LD de producto con el precio del catálogo", async () => {
    const html = await ficha("/productos/panales-nateen-cierre-nat-m");
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"sku":"NAT-M"');
    expect(html).toContain('"price":"50.00"');
    expect(html).toContain("schema.org/InStock");
  });

  it("agotado se dice en el dato estructurado, sin la cantidad", async () => {
    const html = await ficha("/productos/panales-nateen-cierre-nat-m", [
      { ...VARIANTE, disponibilidad: "agotado" },
    ]);
    expect(html).toContain("schema.org/OutOfStock");
    expect(html).not.toMatch(/inventoryLevel|quantity/i);
  });

  it("un slug que no existe NO inventa una ficha y va con noindex", async () => {
    // Un enlace viejo, o un producto retirado. Lo que no puede pasar es que
    // Google guarde una página de algo que no se puede comprar.
    const html = await ficha("/productos/no-existe-esto");
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).not.toContain('"@type":"Product"');
  });

  it("sin catálogo (el sistema caído) tampoco se inventa", async () => {
    const html = await ficha("/productos/panales-nateen-cierre-nat-m", []);
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).not.toContain('"@type":"Product"');
  });

  it("el listado /productos sigue con su head de siempre", async () => {
    const html = await ficha("/productos");
    expect(html).not.toContain('"@type":"Product"');
    expect(html).not.toContain("noindex");
    expect(html).toContain("Catálogo");
  });
});
