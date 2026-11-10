import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogo, type SistemaWebBinding } from "./catalogo";

/**
 * `/api/catalogo` (F3.5).
 *
 * Lo que se vigila aquí no es que la consulta funcione: es que la web SIGA EN
 * PIE cuando el sistema no contesta, y que se note de dónde salió lo que
 * enseña. Una web que se cae porque una base no respondió es una web que
 * deja de vender por algo que la clienta no causó ni puede arreglar.
 */

const CATALOGO = {
  version: 7,
  generadoEn: 1_794_000_000_000,
  variantes: [
    {
      codigo: "NAT-M",
      slug: "panales-nateen-cierre-nat-m",
      nombre: "Pañal Nateen Talla M — caja de 144",
      talla: "M",
      pesoMinLb: 8,
      pesoMaxLb: 19,
      unidadesPorCaja: 144,
      precioCents: 5000,
      disponibilidad: "disponible",
    },
  ],
};

const sistema = (sobre: Partial<SistemaWebBinding> = {}): SistemaWebBinding => ({
  async catalogo() {
    return { ok: true, datos: CATALOGO };
  },
  // El doble implementa el binding ENTERO. Si se dejara opcional, añadir un
  // método al contrato no rompería ninguna prueba y la web se enteraría en
  // producción, que es lo que este doble existe para evitar.
  async archivo() {
    return { ok: true, datos: null };
  },
  ...sobre,
});

// La caché del borde es DE VERDAD, y desde F3.7 la llave es fija —
// `/api/catalogo`, sin el query— para que `/api/catalogo` y el <head> de cada
// ficha de producto compartan la misma entrada. Eso es lo que se quiere en
// producción, y es exactamente lo que hace que dos pruebas se contaminen: la
// primera deja su respuesta guardada y la segunda la recibe sin tocar el
// binding que acaba de inyectar.
//
// Así que se borra a mano antes de cada prueba. Poner una URL distinta por
// prueba ya NO aísla: la llave las colapsa todas en una.
const LLAVE = new Request("https://babycaleb.com/api/catalogo");

beforeEach(async () => {
  await caches.default.delete(LLAVE);
});

const pedir = (s?: SistemaWebBinding) =>
  catalogo(new Request("https://babycaleb.com/api/catalogo"), s);

describe("el camino normal", () => {
  it("devuelve el catálogo del sistema y lo dice", async () => {
    const r = await pedir(sistema());
    expect(r.headers.get("x-catalogo-origen")).toBe("sistema");

    const d = (await r.json()) as { version: number; desdeRespaldo: boolean; variantes: unknown[] };
    expect(d.version).toBe(7);
    expect(d.desdeRespaldo).toBe(false);
    expect(d.variantes).toHaveLength(1);
  });

  it("se puede guardar en la caché del borde", async () => {
    const r = await pedir(sistema());
    expect(r.headers.get("cache-control")).toContain("s-maxage=60");
  });
});

describe("cuando el sistema no contesta, la web sigue en pie", () => {
  it("si revienta, sale la copia del build", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await pedir(
        sistema({
          async catalogo() {
            throw new Error("sin red");
          },
        }),
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("x-catalogo-origen")).toBe("respaldo");
      expect(((await r.json()) as { desdeRespaldo: boolean }).desdeRespaldo).toBe(true);
      expect(String(avisos.mock.calls[0]?.[0])).toContain("catalogo_sistema_caido");
    } finally {
      avisos.mockRestore();
    }
  });

  it("si contesta un error, también", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await pedir(
        sistema({
          async catalogo() {
            return { ok: false, codigo: "no_disponible", mensaje: "la base no responde" };
          },
        }),
      );
      expect(r.headers.get("x-catalogo-origen")).toBe("respaldo");
      expect(String(avisos.mock.calls[0]?.[0])).toContain("catalogo_sistema_fallo");
    } finally {
      avisos.mockRestore();
    }
  });

  it("y sin binding puesto, igual: la web no se cae por una configuración", async () => {
    const r = await pedir(undefined);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-catalogo-origen")).toBe("respaldo");
  });

  it("el respaldo NO se guarda en la caché del borde", async () => {
    // Si se guardara, un minuto de base caída dejaría a la web enseñando la
    // copia durante ese minuto aunque el sistema volviera al segundo
    // siguiente. El respaldo es para el momento malo, no para el minuto
    // siguiente al momento malo.
    const url = "https://babycaleb.com/api/catalogo";
    const caido = sistema({
      async catalogo() {
        throw new Error("sin red");
      },
    });

    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const primera = await catalogo(new Request(url), caido);
      expect(primera.headers.get("x-catalogo-origen")).toBe("respaldo");
    } finally {
      avisos.mockRestore();
    }

    // El sistema vuelve: la siguiente petición a la MISMA url tiene que traer
    // ya el catálogo de verdad, no la copia guardada.
    const segunda = await catalogo(new Request(url), sistema());
    expect(segunda.headers.get("x-catalogo-origen")).toBe("sistema");
  });
});

describe("lo que sale hacia un navegador", () => {
  it("ni el costo ni la cantidad exacta, venga de donde venga", async () => {
    for (const s of [sistema(), undefined]) {
      const texto = JSON.stringify(
        ((await (await pedir(s)).json()) as { variantes: unknown[] }).variantes,
      );
      expect(texto).not.toMatch(/costo|fisico|reservado|libres/i);
    }
  });
});
