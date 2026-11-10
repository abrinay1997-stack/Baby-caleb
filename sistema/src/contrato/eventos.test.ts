import { describe, expect, it } from "vitest";
import {
  COLAS,
  TIPOS_AVISOS,
  TIPOS_EVENTO,
  TIPOS_TAREAS,
  colaDe,
  esTipoEvento,
  validarEvento,
} from "./eventos";

// Esta prueba es la tabla de docs/plan/03-contratos.md §4 escrita otra vez a
// mano. El CRM consume `bc-avisos`, así que un nombre cambiado aquí rompe el
// otro repo: si alguien lo cambia sin cambiar el plan, esto se pone rojo.

describe("los tipos son los del contrato", () => {
  it("bc-avisos lleva los ocho que consume el CRM", () => {
    expect([...TIPOS_AVISOS]).toEqual([
      "pedido.creado",
      "pago.confirmado",
      "pedido.agendado",
      "pedido.en_ruta",
      "pedido.entregado",
      "pedido.cancelado",
      "inventario.bajo",
      "sistema.alerta",
    ]);
  });

  it("bc-tareas lleva los cuatro que el sistema se manda a sí mismo", () => {
    expect([...TIPOS_TAREAS]).toEqual([
      "meta.purchase",
      "pago.consultar",
      "reporte.excel",
      "correo.enviar",
    ]);
  });

  it("son dos colas y ningún tipo está en las dos", () => {
    expect([...COLAS]).toEqual(["bc-avisos", "bc-tareas"]);
    const cruce = TIPOS_AVISOS.filter((t) => (TIPOS_TAREAS as readonly string[]).includes(t));
    expect(cruce).toEqual([]);
  });
});

describe("colaDe", () => {
  it("deriva la cola del tipo, para que no se pueda equivocar", () => {
    for (const t of TIPOS_AVISOS) expect(colaDe(t), t).toBe("bc-avisos");
    for (const t of TIPOS_TAREAS) expect(colaDe(t), t).toBe("bc-tareas");
  });

  it("esTipoEvento acepta los doce y rechaza el resto", () => {
    for (const t of TIPOS_EVENTO) expect(esTipoEvento(t)).toBe(true);
    for (const malo of ["", "pedido.inventado", "PEDIDO.CREADO", "pedido creado"]) {
      expect(esTipoEvento(malo), malo).toBe(false);
    }
  });
});

const sobre = (cambios: Record<string, unknown> = {}) => ({
  id: "01MCC5RRW85NVCEPXBCTY8QR5C",
  tipo: "pedido.creado",
  version: 1,
  ocurridoEn: 1_800_000_000_000,
  datos: {
    numero: "BC-000123",
    token: "tok",
    origen: "web",
    clienteRef: "cli-1",
    totalCents: 5000,
  },
  ...cambios,
});

describe("validarEvento · el sobre", () => {
  it("acepta uno bueno", () => {
    const r = validarEvento(sobre());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evento.tipo).toBe("pedido.creado");
  });

  it("rechaza lo que no es un sobre", () => {
    for (const malo of [null, undefined, 42, "texto", [], {}]) {
      const r = validarEvento(malo);
      expect(r.ok, JSON.stringify(malo)).toBe(false);
      if (!r.ok) expect(r.motivo).toContain("sobre inválido");
    }
  });

  it("rechaza un tipo que no conoce", () => {
    expect(validarEvento(sobre({ tipo: "pedido.inventado" })).ok).toBe(false);
  });

  it("rechaza una versión que no es 1", () => {
    // Un cambio de versión es un cambio de contrato: no se procesa a ciegas.
    expect(validarEvento(sobre({ version: 2 })).ok).toBe(false);
    expect(validarEvento(sobre({ version: "1" })).ok).toBe(false);
  });

  it("rechaza un sobre sin id o sin hora", () => {
    expect(validarEvento(sobre({ id: "" })).ok).toBe(false);
    expect(validarEvento(sobre({ ocurridoEn: "ayer" })).ok).toBe(false);
  });
});

describe("validarEvento · los datos de cada tipo", () => {
  it("dice qué campo falta y de qué tipo", () => {
    const r = validarEvento(sobre({ datos: { numero: "BC-1" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toContain("pedido.creado");
      expect(r.motivo).toContain("token");
    }
  });

  it("rechaza un origen que no existe", () => {
    const datos = { ...sobre().datos, origen: "fax" };
    expect(validarEvento(sobre({ datos })).ok).toBe(false);
  });

  it("rechaza centavos con decimales", () => {
    const datos = { ...sobre().datos, totalCents: 50.5 };
    expect(validarEvento(sobre({ datos })).ok).toBe(false);
  });

  it("inventario.bajo lleva la etiqueta, nunca la cantidad", () => {
    // El número exacto de existencias no sale del sistema.
    const bueno = validarEvento({
      ...sobre({ tipo: "inventario.bajo" }),
      datos: { codigo: "NAT-M", etiqueta: "pocas", bodega: "Bodega Ciudad de Panamá" },
    });
    expect(bueno.ok).toBe(true);

    const conCantidad = validarEvento({
      ...sobre({ tipo: "inventario.bajo" }),
      datos: { codigo: "NAT-M", etiqueta: 3, bodega: "x" },
    });
    expect(conCantidad.ok).toBe(false);
  });

  it("pedido.agendado acepta una ventana nula, porque todavía no están definidas", () => {
    const sinVentana = validarEvento({
      ...sobre({ tipo: "pedido.agendado" }),
      datos: { numero: "BC-1", token: "t", ventana: null, clienteRef: "c" },
    });
    expect(sinVentana.ok).toBe(true);
  });

  it("sistema.alerta solo admite los tres niveles", () => {
    for (const nivel of ["aviso", "error", "critico"]) {
      const r = validarEvento({
        ...sobre({ tipo: "sistema.alerta" }),
        datos: { nivel, mensaje: "algo pasó" },
      });
      expect(r.ok, nivel).toBe(true);
    }
    const malo = validarEvento({
      ...sobre({ tipo: "sistema.alerta" }),
      datos: { nivel: "urgente", mensaje: "x" },
    });
    expect(malo.ok).toBe(false);
  });

  it("los tipos que se completan en su fase dejan pasar campos de más", () => {
    // `reporte.excel` y `correo.enviar` se terminan en F5 y F7: hoy solo se
    // exige lo que ya se sabe, y lo demás pasa sin estorbar.
    const r = validarEvento({
      ...sobre({ tipo: "reporte.excel" }),
      datos: { clase: "ventas", mes: "2026-11", algoNuevo: true },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.evento.datos as { mes: string }).mes).toBe("2026-11");
  });

  it("pero siguen exigiendo lo que ya se sabe", () => {
    expect(validarEvento({ ...sobre({ tipo: "reporte.excel" }), datos: {} }).ok).toBe(false);
  });
});

describe("ningún evento lleva datos personales de clientas", () => {
  it("se habla de clienteRef, no de nombre ni celular", () => {
    // Decisión D-20, aplicada también a las colas: un evento se guarda, se
    // reintenta y se registra, así que cuantos menos datos personales pase,
    // mejor. El CRM resuelve a quién avisar con sus propios datos.
    const conCelular = validarEvento({
      ...sobre(),
      datos: { ...sobre().datos, celular: "50761234567" },
    });
    // Zod descarta el campo de más en los esquemas estrictos.
    expect(conCelular.ok).toBe(true);
    if (conCelular.ok) {
      expect(Object.keys(conCelular.evento.datos as object)).not.toContain("celular");
    }
  });
});
