import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Evento } from "../contrato/eventos";
import { reiniciarUlid } from "../ids";
import { atrasados, encolar, publicar, publicarPendientes } from "./outbox";

const T = 1_800_000_000_000;

/** Una cola que anota lo que se le manda, y que se puede hacer fallar. */
function colaFalsa(falla = false) {
  const lotes: unknown[][] = [];
  const cola = {
    async send() {
      throw new Error("usar sendBatch");
    },
    async sendBatch(mensajes: { body: unknown }[]) {
      if (falla) throw new Error("la cola no contesta");
      lotes.push(mensajes.map((m) => m.body));
    },
  } as unknown as Queue;
  return { cola, lotes, get enviados() { return lotes.flat() as Evento[]; } };
}

function entorno(avisos = colaFalsa(), tareas = colaFalsa()) {
  return { entorno: { DB: env.DB, AVISOS: avisos.cola, TAREAS: tareas.cola }, avisos, tareas };
}

const datosAviso = {
  numero: "BC-000123",
  token: "tok",
  origen: "web" as const,
  clienteRef: "cli-1",
  totalCents: 5000,
};

beforeEach(async () => {
  reiniciarUlid();
  // Este runner no aísla el almacenamiento entre pruebas del mismo archivo, y
  // estas dos tablas no tienen trigger de «no se borra», así que se limpian.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM eventos_salida"),
    env.DB.prepare("DELETE FROM eventos_recibidos"),
  ]);
});

describe("encolar", () => {
  it("no escribe ni publica: devuelve la sentencia para el batch de quien llama", async () => {
    const { sentencia } = encolar(env.DB, "pedido.creado", datosAviso, T);
    // Todavía no hay nada en la tabla.
    expect((await atrasados(env.DB)).cuantos).toBe(0);
    await sentencia.run();
    expect((await atrasados(env.DB)).cuantos).toBe(1);
  });

  it("deriva la cola del tipo, para que no se pueda equivocar", async () => {
    const aviso = encolar(env.DB, "pago.confirmado", {}, T);
    const tarea = encolar(env.DB, "pago.consultar", {}, T);
    await env.DB.batch([aviso.sentencia, tarea.sentencia]);

    const { results } = await env.DB.prepare(
      "SELECT tipo, cola FROM eventos_salida ORDER BY tipo",
    ).all<{ tipo: string; cola: string }>();
    expect(results).toEqual([
      { tipo: "pago.confirmado", cola: "bc-avisos" },
      { tipo: "pago.consultar", cola: "bc-tareas" },
    ]);
  });

  it("el evento nace con id ULID, versión 1 y la hora que se le pasó", () => {
    const { evento } = encolar(env.DB, "pedido.creado", datosAviso, T);
    expect(evento.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(evento.version).toBe(1);
    expect(evento.ocurridoEn).toBe(T);
    expect(evento.datos).toEqual(datosAviso);
  });

  it("si el batch falla, NO queda el evento: es todo o nada", async () => {
    // Esto es la razón de existir del patrón. Se mete el evento junto a una
    // sentencia que revienta y se comprueba que no quedó rastro.
    const { sentencia } = encolar(env.DB, "pedido.creado", datosAviso, T);
    await expect(
      env.DB.batch([
        sentencia,
        // Una fila de control que no se cumple: tumba el batch entero.
        env.DB.prepare("INSERT INTO controles (id, regla, ok, creado_en) VALUES (?,?,?,?)").bind(
          "c-malo",
          "prueba",
          0,
          T,
        ),
      ]),
    ).rejects.toThrow();
    expect((await atrasados(env.DB)).cuantos).toBe(0);
  });
});

describe("publicar", () => {
  it("manda cada evento a su cola y marca los que salieron", async () => {
    const { entorno: e, avisos, tareas } = entorno();
    const aviso = encolar(env.DB, "pedido.creado", datosAviso, T);
    const tarea = encolar(env.DB, "pago.consultar", { pagoId: "p-1" }, T + 1);
    await env.DB.batch([aviso.sentencia, tarea.sentencia]);

    const r = await publicar(e, [aviso.evento, tarea.evento], T + 10);

    expect(r.publicados).toHaveLength(2);
    expect(r.pendientes).toEqual([]);
    expect(avisos.enviados.map((x) => x.tipo)).toEqual(["pedido.creado"]);
    expect(tareas.enviados.map((x) => x.tipo)).toEqual(["pago.consultar"]);
    expect((await atrasados(env.DB)).cuantos).toBe(0);
  });

  it("usa una sola llamada por cola, no una por evento", async () => {
    const { entorno: e, avisos } = entorno();
    const tres = [
      encolar(env.DB, "pedido.creado", datosAviso, T),
      encolar(env.DB, "pedido.agendado", {}, T + 1),
      encolar(env.DB, "pedido.en_ruta", {}, T + 2),
    ];
    await env.DB.batch(tres.map((x) => x.sentencia));
    await publicar(e, tres.map((x) => x.evento), T + 10);
    expect(avisos.lotes).toHaveLength(1);
    expect(avisos.lotes[0]).toHaveLength(3);
  });

  it("si la cola falla, el evento se queda pendiente y suma un intento", async () => {
    const { entorno: e } = entorno(colaFalsa(true));
    const aviso = encolar(env.DB, "pedido.creado", datosAviso, T);
    await aviso.sentencia.run();

    const r = await publicar(e, [aviso.evento], T + 10);

    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([aviso.evento.id]);

    const fila = await env.DB.prepare(
      "SELECT publicado_en, intentos FROM eventos_salida WHERE id = ?",
    )
      .bind(aviso.evento.id)
      .first<{ publicado_en: number | null; intentos: number }>();
    expect(fila?.publicado_en).toBeNull();
    expect(fila?.intentos).toBe(1);
  });

  it("una cola caída no arrastra a la otra", async () => {
    const { entorno: e, tareas } = entorno(colaFalsa(true), colaFalsa(false));
    const aviso = encolar(env.DB, "pedido.creado", datosAviso, T);
    const tarea = encolar(env.DB, "pago.consultar", { pagoId: "p-1" }, T + 1);
    await env.DB.batch([aviso.sentencia, tarea.sentencia]);

    const r = await publicar(e, [aviso.evento, tarea.evento], T + 10);

    expect(r.publicados).toEqual([tarea.evento.id]);
    expect(r.pendientes).toEqual([aviso.evento.id]);
    expect(tareas.enviados).toHaveLength(1);
  });

  it("no lanza cuando la cola falla: el cambio de estado ya pasó", async () => {
    // Hacer fallar la respuesta de la clienta por un aviso que se reintenta en
    // cinco minutos sería peor que el aviso tardío.
    const { entorno: e } = entorno(colaFalsa(true));
    const aviso = encolar(env.DB, "pedido.creado", datosAviso, T);
    await aviso.sentencia.run();
    await expect(publicar(e, [aviso.evento], T + 10)).resolves.toBeDefined();
  });

  it("sin eventos no hace nada ni revienta", async () => {
    const { entorno: e } = entorno();
    expect(await publicar(e, [], T)).toEqual({ publicados: [], pendientes: [] });
  });
});

describe("publicarPendientes · el cron de cada 5 minutos", () => {
  it("saca lo que quedó sin publicar", async () => {
    // Primero una cola caída deja todo pendiente.
    const caida = entorno(colaFalsa(true));
    const uno = encolar(env.DB, "pedido.creado", datosAviso, T);
    const dos = encolar(env.DB, "pedido.agendado", {}, T + 1);
    await env.DB.batch([uno.sentencia, dos.sentencia]);
    await publicar(caida.entorno, [uno.evento, dos.evento], T + 10);
    expect((await atrasados(env.DB)).cuantos).toBe(2);

    // Después el cron, con la cola de vuelta.
    const sana = entorno();
    const r = await publicarPendientes(sana.entorno, T + 300_000);

    expect(r.publicados).toHaveLength(2);
    expect((await atrasados(env.DB)).cuantos).toBe(0);
    expect(sana.avisos.enviados).toHaveLength(2);
  });

  it("los saca en el orden en que pasaron las cosas", async () => {
    // A nadie le sirve recibir «va en camino» antes que «pedido agendado».
    const caida = entorno(colaFalsa(true));
    const creado = encolar(env.DB, "pedido.creado", datosAviso, T);
    const agendado = encolar(env.DB, "pedido.agendado", {}, T + 1_000);
    const enRuta = encolar(env.DB, "pedido.en_ruta", {}, T + 2_000);
    // Se insertan a propósito en desorden.
    await env.DB.batch([enRuta.sentencia, creado.sentencia, agendado.sentencia]);
    await publicar(caida.entorno, [enRuta.evento], T);

    const sana = entorno();
    await publicarPendientes(sana.entorno, T + 300_000);

    expect(sana.avisos.enviados.map((e) => e.tipo)).toEqual([
      "pedido.creado",
      "pedido.agendado",
      "pedido.en_ruta",
    ]);
  });

  it("no republica lo que ya salió", async () => {
    const sana = entorno();
    const uno = encolar(env.DB, "pedido.creado", datosAviso, T);
    await uno.sentencia.run();
    await publicar(sana.entorno, [uno.evento], T + 10);

    const otra = entorno();
    const r = await publicarPendientes(otra.entorno, T + 300_000);
    expect(r.publicados).toEqual([]);
    expect(otra.avisos.enviados).toEqual([]);
  });

  it("respeta el tope por vuelta", async () => {
    const caida = entorno(colaFalsa(true));
    const muchos = Array.from({ length: 7 }, (_, i) =>
      encolar(env.DB, "pedido.creado", datosAviso, T + i),
    );
    await env.DB.batch(muchos.map((x) => x.sentencia));

    const sana = entorno();
    const r = await publicarPendientes(sana.entorno, T + 300_000, 3);
    expect(r.publicados).toHaveLength(3);
    expect((await atrasados(env.DB)).cuantos).toBe(4);
    void caida;
  });

  it("una fila con JSON roto no se publica, pero tampoco se borra", async () => {
    // Si se descartara, el aviso desaparecería en silencio, que es exactamente
    // lo que este patrón existe para evitar.
    await env.DB.prepare(
      `INSERT INTO eventos_salida (id, cola, tipo, version, datos_json, creado_en)
       VALUES ('roto', 'bc-avisos', 'pedido.creado', 1, '{no es json', ?)`,
    )
      .bind(T)
      .run();

    const sana = entorno();
    const r = await publicarPendientes(sana.entorno, T + 300_000);
    expect(r.publicados).toEqual([]);
    expect((await atrasados(env.DB)).cuantos).toBe(1);
  });

  it("sin nada pendiente no toca la cola", async () => {
    const sana = entorno();
    expect(await publicarPendientes(sana.entorno, T)).toEqual({ publicados: [], pendientes: [] });
    expect(sana.avisos.lotes).toEqual([]);
  });
});

describe("atrasados", () => {
  it("cuenta lo pendiente y dice cuál es el más viejo", async () => {
    const caida = entorno(colaFalsa(true));
    const viejo = encolar(env.DB, "pedido.creado", datosAviso, T);
    const nuevo = encolar(env.DB, "pedido.agendado", {}, T + 60_000);
    await env.DB.batch([viejo.sentencia, nuevo.sentencia]);
    void caida;

    const a = await atrasados(env.DB);
    expect(a.cuantos).toBe(2);
    expect(a.masViejo).toBe(T);
  });

  it("con el outbox limpio devuelve cero y null", async () => {
    expect(await atrasados(env.DB)).toEqual({ cuantos: 0, masViejo: null });
  });
});
