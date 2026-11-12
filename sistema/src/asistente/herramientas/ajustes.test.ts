import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cambiarAjuste, verAjustes } from "./ajustes";
import { cambiarBotonWhatsapp } from "./precios-y-stock";
import type { Contexto } from "../registro";
import { revisar } from "../referencias";

/**
 * Las cifras del negocio por la puerta de MCP.
 *
 * La regla la puso el dueño del proyecto: un ajuste nuevo no está terminado
 * hasta que se puede usar también por MCP, en el mismo cambio (§13 de
 * `docs/TRAMPAS.md`). Esto comprueba que esa puerta existe y que hace lo mismo
 * que la del panel, no algo parecido.
 */

const AHORA = 1_800_000_000_000;

const ctx = (): Contexto => ({
  db: env.DB,
  usuario: { id: "u-duena", correo: "duena@babycaleb.com", rol: "duena" },
  canal: "mcp",
  conversacionId: null,
  ahora: AHORA,
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ajustes"),
    env.DB.prepare("UPDATE variantes SET pedir_por_whatsapp = NULL"),
  ]);
});

describe("ver_ajustes", () => {
  it("trae todas las reglas y dice cuáles están sin decidir", async () => {
    const r = (await verAjustes.ejecutar(ctx(), {})) as {
      ajustes: { clave: string; sinDecidir: boolean }[];
      sinDecidir: string[];
      aviso: string | null;
    };

    expect(r.ajustes.map((a) => a.clave)).toContain("whatsapp_pedidos_activo");
    expect(r.ajustes.map((a) => a.clave)).toContain("whatsapp_numero");
    // Lo que falta decidir se dice, y no vale cero. Un modelo que lea un 0
    // contesta como si el dato estuviera resuelto (trampa §7).
    expect(r.sinDecidir.length).toBeGreaterThan(0);
    expect(r.aviso).toContain("sin decidir");
  });

  it("el celular del negocio sale enmascarado hacia el modelo", async () => {
    const r = (await verAjustes.ejecutar(ctx(), {})) as {
      ajustes: { clave: string; valor: unknown }[];
    };
    const numero = r.ajustes.find((a) => a.clave === "whatsapp_numero");
    expect(numero?.valor).toBe("•••• 5065");
  });

  it("y nada de lo que devuelve tiene forma de dato de una persona", async () => {
    // La misma guarda de D-20 que barre todas las herramientas, aplicada aquí
    // con el caso concreto que la puso roja al escribir esta herramienta: el
    // celular de los pedidos.
    const r = await verAjustes.ejecutar(ctx(), {});
    expect(revisar(r)).toEqual([]);
  });

  it("tampoco DESPUÉS de que alguien cambie un ajuste, que es cuando se rompía", async () => {
    // Esta es la prueba que faltaba, y el hueco por el que se coló el fallo:
    // `ajustes.cambiado_por` solo tiene valor en los ajustes que alguien tocó,
    // y en local y en las pruebas la tabla arranca vacía. Así que la guarda de
    // arriba barría un resultado donde ese campo era null en todas las filas y
    // pasaba siempre — mientras en producción, con la dueña habiendo cambiado
    // una sola cifra, `ver_ajustes` devolvía su correo entero, el servidor de
    // MCP tumbaba el resultado COMPLETO y la herramienta estaba muerta.
    //
    // Se descubrió pidiéndola en vivo, no aquí. Ahora se descubre aquí.
    await cambiarAjuste.ejecutar(ctx(), {
      clave: "whatsapp_pedidos_activo",
      valor: false,
      motivo: "para que quede quién lo cambió",
    });

    const r = (await verAjustes.ejecutar(ctx(), {})) as {
      ajustes: { clave: string; origen: string }[];
    };
    expect(revisar(r), "ver_ajustes vuelve a filtrar un dato de contacto").toEqual([]);
    expect(JSON.stringify(r)).not.toContain("@babycaleb.com");

    // El contrapeso: que no salga el correo no puede significar que no salga
    // NADA. La lista sigue diciendo que esa regla la puso alguien, que es lo
    // que de verdad hace falta aquí; el quién se pide con
    // ver_historial_de_ajuste, que es la herramienta de esa pregunta.
    const tocado = r.ajustes.find((a) => a.clave === "whatsapp_pedidos_activo");
    expect(tocado?.origen).toBe("guardado");
  });
});

describe("cambiar_ajuste", () => {
  it("cambia una regla y deja el antes y el después", async () => {
    const r = (await cambiarAjuste.ejecutar(ctx(), {
      clave: "whatsapp_pedidos_activo",
      valor: false,
      motivo: "se perdió el celular",
    })) as { antes: unknown; ahora: unknown; version: number };

    expect(r.antes).toBe(true);
    expect(r.ahora).toBe(false);
    expect(r.version).toBe(1);

    // Y se puede volver a leer por la misma puerta.
    const leido = (await verAjustes.ejecutar(ctx(), {})) as {
      ajustes: { clave: string; valor: unknown; origen: string }[];
    };
    const puesto = leido.ajustes.find((a) => a.clave === "whatsapp_pedidos_activo");
    expect(puesto?.valor).toBe(false);
    expect(puesto?.origen).toBe("guardado");
  });

  it("firma el cambio con quien lo pidió, no con lo que diga el modelo", async () => {
    await cambiarAjuste.ejecutar(ctx(), {
      clave: "stock_bajo",
      valor: 3,
      motivo: "quedan menos cajas de las de antes",
    });
    const fila = await env.DB.prepare(
      "SELECT cambiado_por, motivo FROM ajustes WHERE clave = 'stock_bajo'",
    ).first<{ cambiado_por: string; motivo: string }>();
    expect(fila?.cambiado_por).toBe("duena@babycaleb.com");
    expect(fila?.motivo).toBe("quedan menos cajas de las de antes");
  });

  it("un número de celular mal escrito se rechaza explicando qué se esperaba", async () => {
    await expect(
      cambiarAjuste.ejecutar(ctx(), {
        clave: "whatsapp_numero",
        valor: "6757-5065 (el de la casa)",
        motivo: "cambio de celular",
      }),
    ).rejects.toThrow(/código del país|solo números/i);
  });

  it("y uno bien escrito se guarda sin los adornos", async () => {
    // Lo que la dueña va a pegar de su propio teléfono.
    await cambiarAjuste.ejecutar(ctx(), {
      clave: "whatsapp_numero",
      valor: "+507 6757-5065",
      motivo: "el celular nuevo del negocio",
    });
    const fila = await env.DB.prepare(
      "SELECT valor_json FROM ajustes WHERE clave = 'whatsapp_numero'",
    ).first<{ valor_json: string }>();
    expect(JSON.parse(fila!.valor_json)).toBe("50767575065");
  });

  it("no acepta una regla que no existe", async () => {
    // El esquema la rechaza antes de ejecutar; esto comprueba que la lista de
    // claves de la herramienta es la de verdad y no una copia que envejeció.
    expect(cambiarAjuste.parametros.safeParse({
      clave: "whatsapp_inventado",
      valor: true,
      motivo: "nada",
    }).success).toBe(false);
  });
});

describe("cambiar_boton_whatsapp", () => {
  it("apaga el botón en un artículo y lo deja dicho", async () => {
    const r = (await cambiarBotonWhatsapp.ejecutar(ctx(), {
      codigo: "NAT-M",
      mostrar: "no",
      motivo: "este solo se vende en combo",
    })) as { antes: string; ahora: string; aviso: string };

    expect(r.antes).toBe("heredar");
    expect(r.ahora).toBe("no");
    // Dice que lo que se ve depende TAMBIÉN del ajuste global: quien lo pidió
    // tiene que saberlo ahora y no cuando mire la web.
    expect(r.aviso).toContain("whatsapp_pedidos_activo");

    const fila = await env.DB.prepare(
      "SELECT pedir_por_whatsapp FROM variantes WHERE codigo = 'NAT-M'",
    ).first<{ pedir_por_whatsapp: number | null }>();
    expect(fila?.pedir_por_whatsapp).toBe(0);
  });

  it("«heredar» vuelve a dejar la columna nula, que no es lo mismo que un 0", async () => {
    await cambiarBotonWhatsapp.ejecutar(ctx(), {
      codigo: "NAT-L",
      mostrar: "si",
      motivo: "se vende mucho por mensaje",
    });
    await cambiarBotonWhatsapp.ejecutar(ctx(), {
      codigo: "NAT-L",
      mostrar: "heredar",
      motivo: "mejor como el resto",
    });
    const fila = await env.DB.prepare(
      "SELECT pedir_por_whatsapp FROM variantes WHERE codigo = 'NAT-L'",
    ).first<{ pedir_por_whatsapp: number | null }>();
    expect(fila?.pedir_por_whatsapp).toBeNull();
  });

  it("no hace nada si ya estaba así, y lo dice", async () => {
    // Un guardado que no cambia nada ensuciaría la versión de la variante y el
    // historial sin que hubiera pasado nada.
    await expect(
      cambiarBotonWhatsapp.ejecutar(ctx(), {
        codigo: "NAT-M",
        mostrar: "heredar",
        motivo: "por si acaso",
      }),
    ).rejects.toThrow(/ya estaba/);
  });

  it("un artículo que no existe se dice con su nombre", async () => {
    await expect(
      cambiarBotonWhatsapp.ejecutar(ctx(), {
        codigo: "NO-EXISTE",
        mostrar: "no",
        motivo: "nada",
      }),
    ).rejects.toThrow(/no existe el artículo NO-EXISTE/);
  });

  it("las dos son sensibles: el asistente las PROPONE, no las ejecuta", () => {
    // 06-asistente §3: nada que cambie una regla del negocio se ejecuta sin
    // que una persona toque «Permitir».
    expect(cambiarAjuste.nivel).toBe("sensible");
    expect(cambiarBotonWhatsapp.nivel).toBe("sensible");
    expect(verAjustes.nivel).toBe("lectura");
  });
});
