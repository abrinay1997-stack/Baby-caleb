import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Prueba el Worker entero, no los módulos sueltos: que la puerta esté cerrada
// de verdad y que ninguna respuesta salga sin sus cabeceras. Las pruebas de la
// firma del JWT están en src/seguridad/access.test.ts, que puede inyectar las
// llaves; aquí lo que importa es el comportamiento por defecto.

const panel = (ruta: string) => SELF.fetch(`https://panel.babycaleb.com${ruta}`);

describe("la puerta está cerrada por defecto", () => {
  it("/api/yo responde 403 porque Access no está configurado", async () => {
    // ACCESS_EQUIPO y ACCESS_AUD están vacíos en wrangler.jsonc hasta que
    // exista la aplicación de Access. Sin ellos NO se abre: el panel no tiene
    // otra puerta detrás, al revés que D'Casa, donde Odoo tenía su propio login.
    const r = await panel("/api/yo");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({
      ok: false,
      codigo: "no_autorizado",
      mensaje: "Access: sin configurar",
    });
  });

  it("un token inventado tampoco abre", async () => {
    const r = await panel("/api/yo");
    // Da igual lo que traiga: sin configuración ni se mira el token.
    const conToken = await SELF.fetch("https://panel.babycaleb.com/api/yo", {
      headers: { "Cf-Access-Jwt-Assertion": "a.b.c" },
    });
    expect(r.status).toBe(403);
    expect(conToken.status).toBe(403);
  });
});

describe("ninguna respuesta sale sin cabeceras de seguridad", () => {
  it("ni /salud, que es pública", async () => {
    const r = await panel("/salud");
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("ni un 404", async () => {
    const r = await panel("/no-existe");
    expect(r.status).toBe(404);
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("ni un 403", async () => {
    const r = await panel("/api/yo");
    expect(r.status).toBe(403);
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("las cabeceras cambian según la superficie", () => {
  it("la cámara solo se permite en la ruta del motorizado", async () => {
    const enPanel = await panel("/salud");
    const enRuta = await SELF.fetch("https://ruta.babycaleb.com/salud");

    expect(enPanel.headers.get("Permissions-Policy")).toContain("camera=()");
    // La necesita para la foto de entrega.
    expect(enRuta.headers.get("Permissions-Policy")).toContain("camera=(self)");
  });
});

describe("HSTS", () => {
  it("está apagado, como dice la variable", async () => {
    // Se enciende cambiando HSTS a «si» en wrangler.jsonc, cuando esté
    // confirmado que todo subdominio sirve HTTPS.
    const r = await panel("/salud");
    expect(r.headers.get("Strict-Transport-Security")).toBeNull();
  });
});
