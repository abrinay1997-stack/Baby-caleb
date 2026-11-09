import { describe, expect, it } from "vitest";
import { cabecerasDeSeguridad, conCabecerasDeSeguridad, superficieDe } from "./cabeceras";

describe("cabecerasDeSeguridad", () => {
  it("pone las del plan en todas las superficies", () => {
    for (const superficie of ["panel", "ruta", "api"] as const) {
      const c = cabecerasDeSeguridad({ superficie });
      expect(c["X-Frame-Options"], superficie).toBe("DENY");
      expect(c["X-Content-Type-Options"], superficie).toBe("nosniff");
      expect(c["Referrer-Policy"], superficie).toBe("strict-origin-when-cross-origin");
      expect(c["X-Robots-Tag"], superficie).toContain("noindex");
      expect(c["Content-Security-Policy"], superficie).toBeTruthy();
    }
  });

  it("HSTS está apagado por defecto", () => {
    // El plan lo condiciona a que todo subdominio sirva HTTPS. Encenderlo antes
    // con includeSubDomains deja inaccesible durante un año al que no lo tenga.
    expect(cabecerasDeSeguridad({ superficie: "panel" })["Strict-Transport-Security"]).toBeUndefined();
  });

  it("y se enciende a mano, con un año e incluyendo subdominios", () => {
    expect(
      cabecerasDeSeguridad({ superficie: "panel", hsts: true })["Strict-Transport-Security"],
    ).toBe("max-age=31536000; includeSubDomains");
  });

  it("la cámara solo está permitida en la ruta del motorizado", () => {
    // La necesita para la foto de entrega. En el panel nada la usa, y un
    // permiso que no se usa es superficie regalada.
    expect(cabecerasDeSeguridad({ superficie: "ruta" })["Permissions-Policy"]).toContain(
      "camera=(self)",
    );
    expect(cabecerasDeSeguridad({ superficie: "panel" })["Permissions-Policy"]).toContain(
      "camera=()",
    );
    expect(cabecerasDeSeguridad({ superficie: "api" })["Permissions-Policy"]).toContain("camera=()");
  });

  it("la geolocalización solo en la ruta", () => {
    expect(cabecerasDeSeguridad({ superficie: "ruta" })["Permissions-Policy"]).toContain(
      "geolocation=(self)",
    );
    expect(cabecerasDeSeguridad({ superficie: "panel" })["Permissions-Policy"]).toContain(
      "geolocation=()",
    );
  });

  it("el micrófono está apagado en todas", () => {
    for (const superficie of ["panel", "ruta", "api"] as const) {
      expect(cabecerasDeSeguridad({ superficie })["Permissions-Policy"], superficie).toContain(
        "microphone=()",
      );
    }
  });

  it("la CSP del panel no permite scripts de fuera ni en línea", () => {
    const csp = cabecerasDeSeguridad({ superficie: "panel" })["Content-Security-Policy"]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("la CSP deja ver las teselas del mapa, que viven en su propio dominio", () => {
    const csp = cabecerasDeSeguridad({ superficie: "ruta" })["Content-Security-Policy"]!;
    expect(csp).toContain("mapas.babycaleb.com");
  });
});

describe("conCabecerasDeSeguridad", () => {
  it("no pisa una cabecera que la respuesta ya traía", () => {
    const original = new Response("hola", {
      headers: { "X-Robots-Tag": "noindex, noarchive", "Content-Type": "text/plain" },
    });
    const r = conCabecerasDeSeguridad(original, { superficie: "panel" });
    expect(r.headers.get("X-Robots-Tag")).toBe("noindex, noarchive");
    expect(r.headers.get("Content-Type")).toBe("text/plain");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("conserva el cuerpo y el estado", async () => {
    const r = conCabecerasDeSeguridad(new Response("cuerpo", { status: 403 }), {
      superficie: "api",
    });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("cuerpo");
  });
});

describe("superficieDe", () => {
  it("reconoce los dos dominios del sistema", () => {
    expect(superficieDe("panel.babycaleb.com")).toBe("panel");
    expect(superficieDe("ruta.babycaleb.com")).toBe("ruta");
    expect(superficieDe("PANEL.babycaleb.com")).toBe("panel");
  });

  it("cualquier otra cosa se trata como API, que es lo más restrictivo", () => {
    for (const host of [
      "babycaleb.com",
      "babycaleb-sistema.workers.dev",
      "localhost",
      "panelfalso.com",
    ]) {
      expect(superficieDe(host), host).toBe("api");
    }
  });
});
