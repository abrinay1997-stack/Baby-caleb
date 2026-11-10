import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmar, ejecutar, resumir, vencerPendientes } from "./ejecutar";
import type { PeticionDeHerramienta } from "./ejecutar";
import { catalogo } from "./index";
import { TOPES, TURNO_LIMPIO } from "./politica";
import type { Contexto } from "./registro";

/**
 * El ejecutor: lo que hace que «sensible» signifique algo.
 *
 * Declarar una herramienta como sensible es escribir una palabra en un objeto.
 * Lo que de verdad la para es este camino, y estas pruebas comprueban que lo
 * hace: que no se ejecute, que quede esperando, que solo la confirme quien la
 * pidió, que no se pueda confirmar dos veces y que lo que se ejecuta sea
 * EXACTAMENTE lo que la persona leyó.
 */

const ahora = () => Date.now();
let n = 0;

const registro = catalogo();

const duena: Contexto["usuario"] = { id: "u-duena", correo: "duena@babycaleb.com", rol: "duena" };
const asistente: Contexto["usuario"] = { id: "u-asis", correo: "a@b.com", rol: "asistente" };

const quien = (usuario = duena) => ({ db: real.DB, usuario, ahora: ahora() });

const pedir = (nombre: string, argumentos: unknown, extra: Partial<PeticionDeHerramienta> = {}): PeticionDeHerramienta => ({
  nombre,
  argumentos,
  canal: "panel",
  conversacionId: null,
  conAdjuntos: false,
  textoExterno: false,
  ...extra,
});

beforeEach(async () => {
  n += 1;
  // Los usuarios NO se borran entre pruebas: `acciones.usuario_id` los
  // referencia y la bitácora no se puede borrar —el trigger lo prohíbe, que es
  // justo lo que se quiere—. Así que se insertan con OR IGNORE y se quedan.
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-duena','duena@babycaleb.com','Yarielis','duena',1,?)",
    ).bind(ahora()),
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-asis','a@b.com','Asistente','asistente',1,?)",
    ).bind(ahora()),
    real.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    real.DB.prepare(
      "UPDATE existencias SET fisico = 30 WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ),
    real.DB.prepare("UPDATE variantes SET precio_cents = 5000 WHERE codigo = 'NAT-M'"),
  ]);
});

const fisicoDeNatM = async (): Promise<number | undefined> =>
  (
    await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>()
  )?.fisico;

describe("lo de lectura va directo", () => {
  it("se ejecuta y queda anotado como hecha", async () => {
    const r = await ejecutar(quien(), registro, pedir("ver_stock", { codigo: "NAT-M" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("hecha");

    const a = await real.DB.prepare("SELECT estado, herramienta FROM acciones WHERE id = ?")
      .bind(r.datos.accionId)
      .first<{ estado: string; herramienta: string }>();
    expect(a).toMatchObject({ estado: "hecha", herramienta: "ver_stock" });
  });
});

describe("lo sensible NO se ejecuta: se propone", () => {
  it("queda esperando y el inventario no se mueve", async () => {
    const antes = await fisicoDeNatM();
    const r = await ejecutar(
      quien(),
      registro,
      pedir("ajustar_stock", {
        codigo: "NAT-M",
        bodega: "Bodega Ciudad de Panamá",
        modo: "fijar",
        cantidad: 5,
        motivo: "conteo del lunes",
      }),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("por_confirmar");
    expect(await fisicoDeNatM()).toBe(antes);
  });

  it("el resumen dice QUÉ va a pasar, con los números", async () => {
    // «¿Permite cambiar_precio?» no es una pregunta que nadie pueda contestar
    // bien. «Cambiar el precio de NAT-M a $55.00» sí.
    const r = await ejecutar(
      quien(),
      registro,
      pedir("cambiar_precio", { codigo: "NAT-M", precio_cents: 5500, motivo: "subida de octubre" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;

    expect(r.datos.resumen).toContain("NAT-M");
    // Los centavos se leen en dólares: nadie confirma «5500» a ojo.
    expect(r.datos.resumen).toContain("$55.00");
    expect(r.datos.resumen).not.toContain("5500");
  });

  it("y el asistente no puede ni proponerlas", async () => {
    const r = await ejecutar(
      quien(asistente),
      registro,
      pedir("cambiar_precio", { codigo: "NAT-M", precio_cents: 1, motivo: "lo que sea" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // `no_autorizado` y no `entrada_invalida`: el rol se mira ANTES que el
    // esquema. Al revés se le enseña a quien no puede el esquema de algo que
    // no le corresponde, y encima parece que arreglando los argumentos entra.
    expect(r.codigo).toBe("no_autorizado");
  });

  it("y a quien no puede se le dice eso aunque los argumentos estén mal", async () => {
    const r = await ejecutar(
      quien(asistente),
      registro,
      pedir("cambiar_precio", { esto: "no es el esquema" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_autorizado");
  });
});

describe("confirmar", () => {
  async function proponer(): Promise<string> {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("ajustar_stock", {
        codigo: "NAT-M",
        bodega: "Bodega Ciudad de Panamá",
        modo: "fijar",
        cantidad: 12,
        motivo: `conteo ${n}`,
      }),
    );
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("no quedó esperando");
    return r.datos.accionId;
  }

  it("permitir la ejecuta", async () => {
    const id = await proponer();
    const r = await confirmar(quien(), registro, id, "permitir");
    expect(r.ok).toBe(true);
    expect(await fisicoDeNatM()).toBe(12);
  });

  it("rechazar NO la ejecuta y la cierra", async () => {
    const id = await proponer();
    const r = await confirmar(quien(), registro, id, "rechazar");
    expect(r.ok).toBe(true);
    expect(await fisicoDeNatM()).toBe(30);

    const a = await real.DB.prepare("SELECT estado FROM acciones WHERE id = ?")
      .bind(id)
      .first<{ estado: string }>();
    expect(a?.estado).toBe("rechazada");
  });

  it("solo la confirma quien la pidió", async () => {
    // En Telegram los botones viven en un chat: sin esto, cualquiera con
    // acceso a ese chat confirmaría algo que pidió otra persona.
    const id = await proponer();
    const r = await confirmar(quien(asistente), registro, id, "permitir");
    expect(r.ok).toBe(false);
    expect(await fisicoDeNatM()).toBe(30);
  });

  it("confirmarla DOS VECES no la ejecuta dos veces", async () => {
    // Lo hace cumplir la base, no este código: la acción se cierra ANTES de
    // ejecutar, y el trigger aborta el segundo cierre.
    const id = await proponer();
    const uno = await confirmar(quien(), registro, id, "permitir");
    const dos = await confirmar(quien(), registro, id, "permitir");

    expect(uno.ok).toBe(true);
    expect(dos.ok).toBe(false);
    expect(await fisicoDeNatM()).toBe(12);
  });

  it("una que venció no se ejecuta", async () => {
    const id = await proponer();
    // Lo que se enseñó pudo dejar de ser verdad; confirmar a ciegas algo de
    // ayer es peor que volver a pedirlo.
    const r = await confirmar(
      { db: real.DB, usuario: duena, ahora: ahora() + (TOPES.minutosParaConfirmar + 1) * 60_000 },
      registro,
      id,
      "permitir",
    );
    expect(r.ok).toBe(false);
    expect(await fisicoDeNatM()).toBe(30);
  });

  it("se ejecuta lo que la persona LEYÓ, no lo que diga quien confirma", async () => {
    // Los argumentos salen de la base. Si alguien pudiera mandarlos al
    // confirmar, se enseñaría «fijar en 12» y se ejecutaría otra cosa.
    const id = await proponer();
    await confirmar(quien(), registro, id, "permitir");

    const a = await real.DB.prepare("SELECT argumentos_json FROM acciones WHERE id = ?")
      .bind(id)
      .first<{ argumentos_json: string }>();
    expect(JSON.parse(a!.argumentos_json)).toMatchObject({ cantidad: 12 });
    expect(await fisicoDeNatM()).toBe(12);
  });

  it("una acción que no existe no hace nada", async () => {
    const r = await confirmar(quien(), registro, "no-existe", "permitir");
    expect(r.ok).toBe(false);
  });
});

describe("vencer lo que nadie confirmó", () => {
  it("el cron las cierra", async () => {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("registrar_merma", {
        codigo: "NAT-M",
        bodega: "Bodega Ciudad de Panamá",
        cantidad: 1,
        motivo: "se dañó",
      }),
    );
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("no quedó esperando");

    const cuantas = await vencerPendientes(real.DB, ahora() + 31 * 60_000);
    expect(cuantas).toBeGreaterThan(0);

    const a = await real.DB.prepare("SELECT estado, cerrada_en FROM acciones WHERE id = ?")
      .bind(r.datos.accionId)
      .first<{ estado: string; cerrada_en: number }>();
    expect(a?.estado).toBe("vencida");
    expect(a?.cerrada_en).toBeGreaterThan(0);
    // Y no se ejecutó.
    expect(await fisicoDeNatM()).toBe(30);
  });
});

describe("lo que no pasa de la puerta", () => {
  it("una herramienta que no existe", async () => {
    const r = await ejecutar(quien(), registro, pedir("borrar_todo", {}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");

    // Y NO se anota: la bitácora es de lo que el sistema hizo, y guardar el
    // nombre de algo que no existe la ensucia sin decir nada.
    const n = await real.DB.prepare(
      "SELECT COUNT(*) n FROM acciones WHERE herramienta = 'borrar_todo'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("argumentos enormes se paran ANTES de guardarlos", async () => {
    // Si no, medio megabyte entra entero en la bitácora y el tope no sirve de
    // nada porque el daño ya está guardado.
    const r = await ejecutar(
      quien(),
      registro,
      pedir("ajustar_stock", {
        codigo: "NAT-M",
        bodega: "Bodega Ciudad de Panamá",
        modo: "fijar",
        cantidad: 1,
        motivo: "x".repeat(TOPES.letrasPorArgumento + 1),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("limite");

    const n = await real.DB.prepare(
      "SELECT COUNT(*) n FROM acciones WHERE length(argumentos_json) > ?",
    )
      .bind(TOPES.letrasPorArgumento)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("argumentos inválidos quedan anotados como bloqueada", async () => {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("ajustar_stock", { codigo: "NAT-M", bodega: "x", modo: "inventado", cantidad: 1, motivo: "y" }),
    );
    expect(r.ok).toBe(false);

    const a = await real.DB.prepare(
      "SELECT estado FROM acciones WHERE herramienta = 'ajustar_stock' AND estado = 'bloqueada' ORDER BY creado_en DESC LIMIT 1",
    ).first<{ estado: string }>();
    expect(a?.estado).toBe("bloqueada");
  });

  it("el tope de pasos corta el turno", async () => {
    const r = await ejecutar(quien(), registro, pedir("ver_stock", {}), {
      ...TURNO_LIMPIO,
      pasosDados: TOPES.pasosPorTurno,
    });
    expect(r.ok).toBe(false);
  });
});

describe("el traslado mueve las dos bodegas o ninguna", () => {
  it("sale de una y entra en la otra, en el mismo batch", async () => {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("trasladar_stock", {
        codigo: "NAT-M",
        desde: "Bodega Ciudad de Panamá",
        hacia: "Bodega Panamá Oeste",
        cantidad: 10,
        motivo: "reparto de la semana",
      }),
    );
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("no quedó esperando");
    await confirmar(quien(), registro, r.datos.accionId, "permitir");

    const { results } = await real.DB.prepare(
      "SELECT bodega_id, fisico FROM existencias WHERE codigo = 'NAT-M' ORDER BY bodega_id",
    ).all<{ bodega_id: string; fisico: number }>();

    expect(results.find((e) => e.bodega_id === "bod-1")?.fisico).toBe(20);
    expect(results.find((e) => e.bodega_id === "bod-2")?.fisico).toBe(10);
  });

  it("si no alcanza, no se mueve NADA", async () => {
    // Sin el mismo batch, un fallo en medio dejaría la mercancía existiendo en
    // ninguna parte.
    const r = await ejecutar(
      quien(),
      registro,
      pedir("trasladar_stock", {
        codigo: "NAT-M",
        desde: "Bodega Ciudad de Panamá",
        hacia: "Bodega Panamá Oeste",
        cantidad: 999,
        motivo: "reparto",
      }),
    );
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("no quedó esperando");
    const c = await confirmar(quien(), registro, r.datos.accionId, "permitir");

    expect(c.ok).toBe(false);
    expect(await fisicoDeNatM()).toBe(30);
    const oeste = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-2'",
    ).first<{ fisico: number }>();
    expect(oeste?.fisico).toBe(0);
  });
});

describe("cambiar un precio", () => {
  it("deja el precio nuevo y su fila en el historial", async () => {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("cambiar_precio", { codigo: "NAT-M", precio_cents: 5500, motivo: "subida de octubre" }),
    );
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("no quedó esperando");
    const c = await confirmar(quien(), registro, r.datos.accionId, "permitir");
    expect(c.ok).toBe(true);

    const v = await real.DB.prepare("SELECT precio_cents, version FROM variantes WHERE codigo = 'NAT-M'")
      .first<{ precio_cents: number; version: number }>();
    expect(v?.precio_cents).toBe(5500);

    // La versión sube: es lo que la web usa para saber si su copia sirve.
    expect(v?.version).toBeGreaterThan(1);

    const h = await real.DB.prepare(
      "SELECT precio_cents, motivo, cambiado_por FROM precios_historial WHERE codigo = 'NAT-M' ORDER BY vigente_desde DESC LIMIT 1",
    ).first<{ precio_cents: number; motivo: string; cambiado_por: string }>();
    expect(h).toMatchObject({ precio_cents: 5500, motivo: "subida de octubre", cambiado_por: "u-duena" });
  });

  it("ponerle el precio que ya tiene se dice", async () => {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("cambiar_precio", { codigo: "NAT-M", precio_cents: 5000, motivo: "sin cambio" }),
    );
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("no quedó esperando");
    const c = await confirmar(quien(), registro, r.datos.accionId, "permitir");
    expect(c.ok).toBe(false);
  });
});

describe("el resumen", () => {
  it("lee los centavos en dólares", () => {
    expect(resumir("cambiar_precio", "sensible", { codigo: "NAT-M", precio_cents: 1500 }, "x")).toContain(
      "$15.00",
    );
  });

  it("y nombra la herramienta en palabras", () => {
    expect(resumir("ajustar_stock", "sensible", { cantidad: 3 }, "x")).toContain("ajustar stock");
  });
});
