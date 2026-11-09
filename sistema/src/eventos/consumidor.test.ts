import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Evento } from "../contrato/eventos";
import { reiniciarUlid, ulid } from "../ids";
import { type Manejadores, consumir, consumirColaMuerta, consumirTareas, esColaMuerta } from "./consumidor";

const T = 1_800_000_000_000;

/** Una cola que anota lo que recibe. */
function colaFalsa() {
  const recibidos: Evento[] = [];
  const cola = {
    async send() {},
    async sendBatch(mensajes: { body: unknown }[]) {
      recibidos.push(...(mensajes.map((m) => m.body) as Evento[]));
    },
  } as unknown as Queue;
  return { cola, recibidos };
}

function entorno() {
  const avisos = colaFalsa();
  const tareas = colaFalsa();
  return {
    env: { DB: real.DB, AVISOS: avisos.cola, TAREAS: tareas.cola } as unknown as Env,
    avisos,
    tareas,
  };
}

/** Un lote de cola, con el ack y el retry contados. */
function loteFalso(queue: string, cuerpos: unknown[]) {
  const acks: number[] = [];
  const retries: number[] = [];
  const messages = cuerpos.map((body, i) => ({
    id: String(i),
    timestamp: new Date(T),
    attempts: 1,
    body,
    ack: () => void acks.push(i),
    retry: () => void retries.push(i),
  }));
  return {
    lote: {
      queue,
      messages,
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>,
    acks,
    retries,
  };
}

const sobre = (tipo: string, datos: unknown, id = ulid(T)): unknown => ({
  id,
  tipo,
  version: 1,
  ocurridoEn: T,
  datos,
});

const tareaBuena = (id?: string) => sobre("pago.consultar", { pagoId: "p-1" }, id);

beforeEach(async () => {
  reiniciarUlid();
  await real.DB.batch([
    real.DB.prepare("DELETE FROM eventos_salida"),
    real.DB.prepare("DELETE FROM eventos_recibidos"),
  ]);
});

const contarRecibidos = async () =>
  (await real.DB.prepare("SELECT COUNT(*) c FROM eventos_recibidos").first<{ c: number }>())?.c ?? 0;

describe("consumirTareas · el camino bueno", () => {
  it("llama al manejador, marca recibido y hace ack", async () => {
    const { env } = entorno();
    const vistos: string[] = [];
    const manejadores: Manejadores = {
      "pago.consultar": async (e) => void vistos.push(e.id),
    };

    const { lote, acks, retries } = loteFalso("bc-tareas", [tareaBuena()]);
    const r = await consumirTareas(lote, env, T, manejadores);

    expect(vistos).toHaveLength(1);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(r).toMatchObject({ hechos: 1, repetidos: 0, descartados: 0, reintentos: 0 });
    expect(await contarRecibidos()).toBe(1);
  });
});

describe("consumirTareas · las colas entregan al menos una vez", () => {
  it("el mismo evento dos veces se hace una sola vez", async () => {
    const { env } = entorno();
    let veces = 0;
    const manejadores: Manejadores = { "pago.consultar": async () => void (veces += 1) };
    const id = ulid(T);

    const primera = loteFalso("bc-tareas", [tareaBuena(id)]);
    await consumirTareas(primera.lote, env, T, manejadores);

    const segunda = loteFalso("bc-tareas", [tareaBuena(id)]);
    const r = await consumirTareas(segunda.lote, env, T + 1, manejadores);

    expect(veces).toBe(1);
    expect(r).toMatchObject({ hechos: 0, repetidos: 1 });
    expect(segunda.acks).toEqual([0]);
  });

  it("dos eventos distintos sí se hacen los dos", async () => {
    const { env } = entorno();
    let veces = 0;
    const manejadores: Manejadores = { "pago.consultar": async () => void (veces += 1) };
    const { lote } = loteFalso("bc-tareas", [tareaBuena(ulid(T)), tareaBuena(ulid(T + 1))]);
    await consumirTareas(lote, env, T, manejadores);
    expect(veces).toBe(2);
    expect(await contarRecibidos()).toBe(2);
  });
});

describe("consumirTareas · cuándo se marca recibido", () => {
  it("si el manejador falla, NO se marca recibido y se reintenta", async () => {
    // Marcar antes de trabajar dejaría el evento como hecho sin haberse hecho,
    // y la cola no lo reintentaría nunca: el peor de los dos mundos.
    const { env } = entorno();
    const manejadores: Manejadores = {
      "pago.consultar": async () => {
        throw new Error("la pasarela no contesta");
      },
    };

    const { lote, acks, retries } = loteFalso("bc-tareas", [tareaBuena()]);
    const r = await consumirTareas(lote, env, T, manejadores);

    expect(retries).toEqual([0]);
    expect(acks).toEqual([]);
    expect(r).toMatchObject({ reintentos: 1, hechos: 0 });
    expect(await contarRecibidos()).toBe(0);
  });

  it("al reintentar después de un fallo, el trabajo sí se hace", async () => {
    const { env } = entorno();
    let intentos = 0;
    const manejadores: Manejadores = {
      "pago.consultar": async () => {
        intentos += 1;
        if (intentos === 1) throw new Error("falla la primera");
      },
    };
    const id = ulid(T);

    const primera = loteFalso("bc-tareas", [tareaBuena(id)]);
    await consumirTareas(primera.lote, env, T, manejadores);
    expect(primera.retries).toEqual([0]);

    const segunda = loteFalso("bc-tareas", [tareaBuena(id)]);
    const r = await consumirTareas(segunda.lote, env, T + 1, manejadores);

    expect(intentos).toBe(2);
    expect(r).toMatchObject({ hechos: 1 });
    expect(segunda.acks).toEqual([0]);
  });

  it("un fallo no impide que el resto del lote se procese", async () => {
    const { env } = entorno();
    const hechos: string[] = [];
    const manejadores: Manejadores = {
      "pago.consultar": async (e) => {
        if ((e.datos as { pagoId: string }).pagoId === "malo") throw new Error("no");
        hechos.push(e.id);
      },
    };
    const { lote, acks, retries } = loteFalso("bc-tareas", [
      sobre("pago.consultar", { pagoId: "malo" }, ulid(T)),
      sobre("pago.consultar", { pagoId: "bueno" }, ulid(T + 1)),
    ]);
    await consumirTareas(lote, env, T, manejadores);

    expect(hechos).toHaveLength(1);
    expect(retries).toEqual([0]);
    expect(acks).toEqual([1]);
  });
});

describe("consumirTareas · lo que NO se reintenta", () => {
  it("un mensaje mal formado se descarta y avisa, en vez de dar cinco vueltas", async () => {
    const { env, avisos } = entorno();
    const { lote, acks, retries } = loteFalso("bc-tareas", [
      { esto: "no es un evento" },
      sobre("pago.consultar", { falta: "el pagoId" }),
      sobre("tipo.inventado", {}),
    ]);
    const r = await consumirTareas(lote, env, T, {});

    expect(acks).toEqual([0, 1, 2]);
    expect(retries).toEqual([]);
    expect(r.descartados).toBe(3);
    // Y cada uno deja su alerta, que es lo que de verdad hace falta.
    expect(avisos.recibidos.filter((e) => e.tipo === "sistema.alerta")).toHaveLength(3);
  });

  it("un tipo válido sin manejador se descarta con alerta", async () => {
    // Reintentar no hace aparecer un manejador que todavía no se ha programado.
    const { env, avisos } = entorno();
    const { lote, acks, retries } = loteFalso("bc-tareas", [tareaBuena()]);
    const r = await consumirTareas(lote, env, T, {});

    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
    expect(r.descartados).toBe(1);
    const alerta = avisos.recibidos.find((e) => e.tipo === "sistema.alerta");
    expect((alerta?.datos as { mensaje: string }).mensaje).toContain("pago.consultar");
    // No se marca recibido: si mañana existe el manejador, el evento se podrá
    // volver a publicar y esta vez sí se hará.
    expect(await contarRecibidos()).toBe(0);
  });
});

describe("la cola muerta", () => {
  it("no reintenta nada y avisa de cada mensaje", async () => {
    // Lo que llega aquí ya se intentó cinco veces. Si se reintentara, un
    // mensaje imposible daría vueltas para siempre y nadie se enteraría.
    const { env, avisos } = entorno();
    const { lote, acks, retries } = loteFalso("bc-tareas-muertos", [
      tareaBuena(),
      { ilegible: true },
    ]);
    const r = await consumirColaMuerta(lote, env, T);

    expect(acks).toEqual([0, 1]);
    expect(retries).toEqual([]);
    expect(r.descartados).toBe(2);

    const alertas = avisos.recibidos.filter((e) => e.tipo === "sistema.alerta");
    expect(alertas).toHaveLength(2);
    for (const a of alertas) {
      expect((a.datos as { nivel: string }).nivel).toBe("critico");
    }
  });

  it("la alerta queda en el outbox aunque la cola esté caída", async () => {
    // Una alerta que no sale sería justo el peor momento para perder un aviso.
    const avisoCaido = {
      async send() {},
      async sendBatch() {
        throw new Error("la cola no contesta");
      },
    } as unknown as Queue;
    const env = { DB: real.DB, AVISOS: avisoCaido, TAREAS: avisoCaido } as unknown as Env;

    const { lote } = loteFalso("bc-tareas-muertos", [tareaBuena()]);
    await consumirColaMuerta(lote, env, T);

    const fila = await real.DB.prepare(
      "SELECT tipo, publicado_en FROM eventos_salida WHERE tipo = 'sistema.alerta'",
    ).first<{ tipo: string; publicado_en: number | null }>();
    expect(fila?.tipo).toBe("sistema.alerta");
    expect(fila?.publicado_en).toBeNull(); // el cron la republica
  });
});

describe("esColaMuerta", () => {
  it("reconoce las de producción y las de staging", () => {
    expect(esColaMuerta("bc-tareas-muertos")).toBe(true);
    expect(esColaMuerta("bc-avisos-muertos")).toBe(true);
    expect(esColaMuerta("bc-tareas-staging-muertos")).toBe(true);
  });

  it("y no confunde las normales", () => {
    expect(esColaMuerta("bc-tareas")).toBe(false);
    expect(esColaMuerta("bc-avisos")).toBe(false);
    expect(esColaMuerta("bc-tareas-staging")).toBe(false);
  });
});

describe("consumir · reparte según la cola", () => {
  it("una cola normal va al manejador", async () => {
    const { env } = entorno();
    let veces = 0;
    const { lote } = loteFalso("bc-tareas", [tareaBuena()]);
    await consumir(lote, env, T, { "pago.consultar": async () => void (veces += 1) });
    expect(veces).toBe(1);
  });

  it("una cola muerta NO va al manejador, aunque exista", async () => {
    const { env } = entorno();
    let veces = 0;
    const { lote } = loteFalso("bc-tareas-muertos", [tareaBuena()]);
    await consumir(lote, env, T, { "pago.consultar": async () => void (veces += 1) });
    expect(veces).toBe(0);
  });
});
