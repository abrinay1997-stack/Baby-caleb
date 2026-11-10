import { describe, expect, it } from "vitest";
import { DATOS_POR_TIPO, TIPOS_EVENTO } from "./eventos";
import { ESQUEMAS } from "./esquemas";
import { HUELLA_CONTRATO, calcularHuella, formaDelContrato, textoDelContrato } from "./huella";

describe("la huella del contrato", () => {
  it("coincide con la que declara el repo", async () => {
    const real = await calcularHuella();
    if (real !== HUELLA_CONTRATO) {
      // El mensaje lleva el valor nuevo para no tener que calcularlo a mano.
      throw new Error(
        [
          "El contrato cambió y la huella no.",
          "",
          `  declarada: ${HUELLA_CONTRATO}`,
          `  real:      ${real}`,
          "",
          "Si el cambio es a propósito: ponga la huella real en src/contrato/huella.ts",
          "y copie los esquemas al CRM (src/sistema/contrato.ts) con la MISMA huella.",
          "Los dos repos tienen una prueba como esta: si solo se arregla uno, el otro",
          "se pone rojo, y eso es justo lo que se quiere.",
        ].join("\n"),
      );
    }
    expect(real).toBe(HUELLA_CONTRATO);
  });

  it("es estable: dos cálculos seguidos dan lo mismo", async () => {
    expect(await calcularHuella()).toBe(await calcularHuella());
  });

  it("es SHA-256 en hexadecimal", async () => {
    expect(await calcularHuella()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("qué entra en la huella", () => {
  it("todos los esquemas registrados", () => {
    const forma = formaDelContrato();
    const esquemas = forma.esquemas as Record<string, unknown>;
    expect(Object.keys(esquemas).sort()).toEqual(Object.keys(ESQUEMAS).sort());
  });

  it("todos los tipos de evento", () => {
    const eventos = formaDelContrato().eventos as Record<string, unknown>;
    expect(Object.keys(eventos).sort()).toEqual([...TIPOS_EVENTO].sort());
    expect(Object.keys(eventos)).toHaveLength(Object.keys(DATOS_POR_TIPO).length);
  });

  it("y los códigos de error", () => {
    expect(formaDelContrato().codigosError).toContain("sin_stock");
    expect(formaDelContrato().codigosError).toContain("monto_no_coincide");
  });

  it("las claves salen ordenadas, para que el orden del código no cambie la huella", () => {
    const texto = textoDelContrato();
    const esquemas = (formaDelContrato().esquemas as Record<string, unknown>);
    const nombres = Object.keys(esquemas);
    expect(nombres).toEqual([...nombres].sort());
    // Y el texto es JSON válido y determinista.
    expect(() => JSON.parse(texto)).not.toThrow();
    expect(textoDelContrato()).toBe(texto);
  });
});

describe("lo que el contrato promete y conviene no romper sin darse cuenta", () => {
  it("VariantePublica no lleva costo, ni stock, ni bodega", () => {
    // Lo que no sale del sistema no se puede filtrar por error.
    const forma = (formaDelContrato().esquemas as Record<string, { properties?: object }>)
      .VariantePublica;
    const campos = Object.keys(forma?.properties ?? {});
    for (const prohibido of ["costo", "costoCents", "stock", "stockQty", "bodega", "fisico"]) {
      expect(campos, prohibido).not.toContain(prohibido);
    }
    expect(campos).toContain("disponibilidad");
  });

  it("CrearPedidoEntrada no acepta precios: los pone el sistema", () => {
    // El navegador no decide un cobro.
    expect(ESQUEMAS.CrearPedidoEntrada.safeParse({
      idempotencia: "12345678",
      lineas: [{ codigo: "NAT-M", cantidad: 1, precioCents: 1 }],
      cliente: { nombre: "A", celular: "5076", consentimientoMkt: false },
      entrega: { zonaId: "z", texto: "calle" },
    }).success).toBe(true);
    // El campo de más se descarta, no se usa.
    const r = ESQUEMAS.CrearPedidoEntrada.parse({
      idempotencia: "12345678",
      lineas: [{ codigo: "NAT-M", cantidad: 1, precioCents: 999 }],
      cliente: { nombre: "A", celular: "5076", consentimientoMkt: false },
      entrega: { zonaId: "z", texto: "calle" },
    });
    expect(Object.keys(r.lineas[0]!)).toEqual(["codigo", "cantidad"]);
  });

  it("EstadoPublicoPedido no lleva nombre, celular ni la calle", () => {
    // El token sale en un enlace, y un enlace se reenvía.
    const forma = (formaDelContrato().esquemas as Record<string, { properties?: object }>)
      .EstadoPublicoPedido;
    const campos = Object.keys(forma?.properties ?? {});
    for (const prohibido of ["nombre", "celular", "correo", "direccion", "texto", "lat", "lng"]) {
      expect(campos, prohibido).not.toContain(prohibido);
    }
    expect(campos).toContain("zona");
  });

  it("todo monto del contrato es un entero", () => {
    const esquemas = formaDelContrato().esquemas as Record<string, unknown>;
    const montos: string[] = [];
    const buscar = (nodo: unknown, camino: string) => {
      if (!nodo || typeof nodo !== "object") return;
      for (const [clave, valor] of Object.entries(nodo as Record<string, unknown>)) {
        if (/Cents$/.test(clave) && valor && typeof valor === "object") {
          const tipo = JSON.stringify(valor);
          montos.push(`${camino}.${clave}`);
          expect(tipo, `${camino}.${clave}`).toContain('"integer"');
        }
        buscar(valor, `${camino}.${clave}`);
      }
    };
    buscar(esquemas, "");
    expect(montos.length).toBeGreaterThan(5);
  });

  it("el ajuste de stock exige motivo, como el CHECK de la base", () => {
    const sinMotivo = ESQUEMAS.AjustarStockEntrada.safeParse({
      idempotencia: "12345678",
      codigo: "NAT-M",
      bodega: "bod",
      modo: "restar",
      cantidad: 1,
    });
    expect(sinMotivo.success).toBe(false);
  });
});
