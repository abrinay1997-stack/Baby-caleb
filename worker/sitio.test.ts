import { describe, expect, it } from "vitest";
import { urlDelSitio } from "./sitio";

/**
 * El dominio con el que se arman el canónico y `og:url`.
 *
 * Esto estuvo roto y no se veía: `env.SITE_URL ?? url.origin` no cae cuando la
 * variable es una cadena VACÍA, que es como está configurada mientras no
 * exista el dominio. Resultado: el sitio quedaba en "" y todas las URLs salían
 * relativas.
 *
 * Mirando la página no se nota —un canónico relativo es válido y el navegador
 * lo resuelve—. Lo que se rompe es `og:url`, que es lo que lee WhatsApp al
 * pegar un enlace: justo lo que la mudanza a un Worker existía para arreglar.
 */

describe("sin dominio configurado se usa el de la petición", () => {
  it("la cadena vacía NO es un dominio", () => {
    expect(urlDelSitio("", "https://babycaleb-web.workers.dev")).toBe(
      "https://babycaleb-web.workers.dev",
    );
  });

  it("ni los espacios", () => {
    expect(urlDelSitio("   ", "https://x.dev")).toBe("https://x.dev");
  });

  it("ni la variable ausente", () => {
    expect(urlDelSitio(undefined, "https://x.dev")).toBe("https://x.dev");
  });
});

describe("con dominio configurado, manda ese", () => {
  it("aunque la petición venga por otro host", () => {
    // Es el caso que importa: una vista previa no puede quedarse con el
    // canónico de la vista previa, o Google indexa esa en vez del sitio.
    expect(urlDelSitio("https://babycaleb.com", "https://preview.workers.dev")).toBe(
      "https://babycaleb.com",
    );
  });

  it("y la barra final se quita, venga de donde venga", () => {
    expect(urlDelSitio("https://babycaleb.com/", "https://x.dev")).toBe("https://babycaleb.com");
    expect(urlDelSitio("https://babycaleb.com///", "https://x.dev")).toBe("https://babycaleb.com");
    expect(urlDelSitio("", "https://x.dev/")).toBe("https://x.dev");
  });
});
