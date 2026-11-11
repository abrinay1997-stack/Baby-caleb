import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type ContextoMetricas, DIAS_DE_SERIE, resumenDelNegocio } from "../src/db/metricas";
import type { Rol } from "../src/seguridad/roles";

/**
 * Las cifras del resumen contra una D1 de verdad.
 *
 * Corre dentro de workerd con las migraciones aplicadas desde cero, así que la
 * carga inicial está puesta: tres bodegas, doce variantes, treinta y seis filas
 * de existencias en cero y ningún pedido. El estado de hoy tal cual —el de la
 * base recién migrada— se prueba aparte, en `metricas-base-vacia.test.ts`, y
 * ahí se explica por qué tiene que ser otro archivo.
 *
 * ## Por qué hay un `limpiar()` y no un `DELETE FROM` de todo
 *
 * Los libros no se borran: `movimientos_inventario` y `pedido_eventos` tienen
 * triggers que abortan el DELETE, y un pedido con bitácora tampoco se puede
 * borrar porque su bitácora lo referencia. Así que entre pruebas se hace lo que
 * el sistema permitiría en la vida real: se borra lo borrable y los pedidos con
 * historia se RETIRAN a «cancelado», que es un estado que no entra en ninguna
 * de las cuentas sin ventana. Es más feo que un `TRUNCATE` y es la única forma
 * honesta de limpiar una base que, a propósito, no deja borrar sus libros.
 *
 * Lo que las pruebas vigilan, en orden de cuánto dolería:
 *
 *  1. Que una cifra de dinero no salga del servidor para quien no ve dinero.
 *  2. Que un periodo no se compare con otro de distinto largo.
 *  3. Que lo entregado lo diga la bitácora y no el estado de ahora.
 *  4. Que la hora de Panamá mande sobre la de UTC.
 */

/** Miércoles 11 de noviembre de 2026, 9:00 a.m. en Panamá. */
const AHORA = Date.parse("2026-11-11T14:00:00Z");
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

const ctx = (rol: Rol = "duena", ahora = AHORA): ContextoMetricas => ({ db: env.DB, ahora, rol });

let n = 0;
const id = (p: string) => `${p}-${++n}`;

let clienteId: string;
let bodegaId: string;
let codigo: string;

beforeEach(async () => {
  await limpiar();
  clienteId = id("cli");
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, "Ana", AHORA - 30 * DIA, AHORA - 30 * DIA)
    .run();
  bodegaId =
    (await env.DB.prepare("SELECT id FROM bodegas ORDER BY id LIMIT 1").first<{ id: string }>())
      ?.id ?? "";
  codigo =
    (
      await env.DB.prepare("SELECT codigo FROM variantes ORDER BY codigo LIMIT 1").first<{
        codigo: string;
      }>()
    )?.codigo ?? "";
  expect(bodegaId, "la carga inicial dejó bodegas").not.toBe("");
  expect(codigo, "la carga inicial dejó variantes").not.toBe("");
});

/**
 * Deja la base como para empezar. El orden importa: las referencias primero.
 *
 * NINGUNA prueba de este archivo escribe en `pedido_eventos`. Es a propósito:
 * un pedido con bitácora no se puede borrar —la bitácora lo referencia y no se
 * deja borrar, que es lo que se le pide a un libro— y entonces sus cifras sin
 * ventana se arrastrarían de una prueba a la siguiente. Lo que necesita
 * bitácora está en `metricas-entregado.test.ts`, con su propia forma de
 * aislarse. La comprobación de abajo es lo que mantiene la frontera: si alguien
 * añade aquí una prueba con bitácora, esto se pone rojo en vez de empezar a
 * contar de más en silencio.
 */
async function limpiar(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pagos"),
    env.DB.prepare("DELETE FROM envios"),
    env.DB.prepare("DELETE FROM rutas"),
    env.DB.prepare("DELETE FROM pedidos"),
    env.DB.prepare("DELETE FROM clientes"),
    env.DB.prepare("DELETE FROM motorizados"),
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0, minimo = NULL"),
    // Una prueba apaga bodegas y variantes para comprobar que no cuentan; aquí
    // se vuelven a encender, que es como las dejó la carga inicial.
    env.DB.prepare("UPDATE bodegas SET activa = 1"),
    env.DB.prepare("UPDATE variantes SET activo = 1"),
  ]);
  const quedan = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM pedidos) p, (SELECT COUNT(*) FROM pedido_eventos) e",
  ).first<{ p: number; e: number }>();
  expect(quedan, "este archivo no puede escribir en pedido_eventos").toEqual({ p: 0, e: 0 });
}

/** Un pedido válido. `sobre` cambia lo que cada prueba necesite. */
async function pedido(sobre: Record<string, unknown> = {}): Promise<string> {
  const p = {
    id: id("ped"),
    estado: "por_abonar",
    estado_pago: "sin_pago",
    total_cents: 5000,
    pagado_cents: 0,
    vence_en: null as number | null,
    creado_en: AHORA - HORA,
    ...sobre,
  };
  await env.DB.prepare(
    `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
       subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
       abono_minimo_cents,vence_en,creado_en,actualizado_en)
     VALUES (?,?,?,?,'web',?,?,?,0,0,0,?,?,500,?,?,?)`,
  )
    .bind(
      p.id,
      `BC-${String(n).padStart(6, "0")}`,
      id("tok"),
      clienteId,
      p.estado,
      p.estado_pago,
      p.total_cents,
      p.total_cents,
      p.pagado_cents,
      p.vence_en,
      p.creado_en,
      p.creado_en,
    )
    .run();
  return p.id as string;
}

async function pago(
  pedidoId: string,
  sobre: { estado?: string; monto?: number; confirmadoEn?: number | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,
       intento_ref,confirmado_en,creado_en,actualizado_en)
     VALUES (?,?,'manual','efectivo','abono',?,?,?,?,?,?)`,
  )
    .bind(
      id("pag"),
      pedidoId,
      sobre.estado ?? "aprobado",
      sobre.monto ?? 1000,
      id("int"),
      sobre.confirmadoEn === undefined ? AHORA - HORA : sobre.confirmadoEn,
      AHORA - 2 * HORA,
      AHORA - HORA,
    )
    .run();
}

async function envio(
  pedidoId: string,
  sobre: { estado?: string; programadoPara?: string } = {},
): Promise<void> {
  const estado = sobre.estado ?? "pendiente";
  await env.DB.prepare(
    `INSERT INTO envios (id,pedido_id,estado,metodo,bodega_id,guia_token,
       programado_para,cobro_cents,entregado_en,creado_en)
     VALUES (?,?,?,'motorizado',?,?,?,0,?,?)`,
  )
    .bind(
      id("env"),
      pedidoId,
      estado,
      bodegaId,
      id("guia"),
      sobre.programadoPara ?? "2026-11-11",
      estado === "entregado" ? AHORA - HORA : null,
      AHORA - 2 * HORA,
    )
    .run();
}

/** Carga inventario de verdad: la existencia y el movimiento que la explica. */
async function cargarInventario(
  unidades: number,
  sobre: { codigo?: string; minimo?: number | null; reservado?: number } = {},
): Promise<void> {
  const cod = sobre.codigo ?? codigo;
  await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE existencias SET fisico = ?, reservado = ?, minimo = ? WHERE codigo = ? AND bodega_id = ?",
      )
      .bind(unidades, sobre.reservado ?? 0, sobre.minimo ?? null, cod, bodegaId),
    env.DB
      .prepare(
        `INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en)
         VALUES (?,?,?,?,'apertura','prueba',?)`,
      )
      // El delta nunca es cero: el esquema lo prohíbe. Cargar cero unidades es
      // un movimiento de uno y una existencia en cero, que es lo que pasa
      // cuando se abre la bodega y lo que había ya se vendió.
      .bind(id("mov"), cod, bodegaId, unidades === 0 ? 1 : unidades, AHORA - DIA),
  ]);
}

/** Todas las filas con holgura y sin mínimo: ninguna estorba en la lista. */
async function todoConHolgura(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE existencias SET fisico = 50, reservado = 0, minimo = NULL"),
    env.DB
      .prepare(
        `INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,actor,creado_en)
         SELECT ?, e.codigo, e.bodega_id, 50, 'apertura', 'prueba', ? FROM existencias e LIMIT 1`,
      )
      .bind(id("mov"), AHORA - DIA),
  ]);
}

/** Desenvuelve el resultado o explica por qué falló, en vez de dar un `undefined`. */
async function resumen(...args: Parameters<typeof resumenDelNegocio>) {
  const r = await resumenDelNegocio(...args);
  if (!r.ok) throw new Error(`el resumen falló: ${r.mensaje}`);
  return r.datos;
}

// ---------------------------------------------------------------------------

describe("lo que necesita atención", () => {
  it("cuenta los pedidos por abonar y, aparte, los que ya vencieron", async () => {
    await pedido({ estado: "por_abonar", vence_en: AHORA - HORA }); // vencido
    await pedido({ estado: "por_abonar", vence_en: AHORA + 5 * HORA }); // todavía con tiempo
    await pedido({ estado: "por_abonar", vence_en: null }); // sin vencimiento
    await pedido({ estado: "agendado" });

    const a = (await resumen(ctx())).atencion!;
    expect(a.porAbonar).toBe(3);
    // Solo el que pasó su hora: los otros dos no son trabajo atrasado, y
    // mezclarlos haría que el aviso no bajara nunca.
    expect(a.porAbonarVencidos).toBe(1);
  });

  it("un pedido agendado con su entrega preparada no sale como pendiente", async () => {
    const conEntrega = await pedido({ estado: "agendado" });
    await envio(conEntrega, { estado: "asignado" });
    await pedido({ estado: "agendado" }); // este sí: nadie lo preparó

    expect((await resumen(ctx())).atencion?.agendadosSinDespachar).toBe(1);
  });

  it("pero si su única entrega se anuló, vuelve a estar sin despachar", async () => {
    const p = await pedido({ estado: "agendado" });
    // Los terminales no son una entrega viva, igual que en el índice único
    // `envios_uno_vivo_por_pedido` de la 0009.
    await envio(p, { estado: "anulado" });
    expect((await resumen(ctx())).atencion?.agendadosSinDespachar).toBe(1);
  });

  it("separa lo que espera a usted de lo que espera a la clienta", async () => {
    const p = await pedido();
    await pago(p, { estado: "confirmando" });
    await pago(p, { estado: "confirmando" });
    await pago(p, { estado: "esperando_cliente" });
    await pago(p, { estado: "rechazado" });

    const a = (await resumen(ctx())).atencion!;
    // Dos comprobantes que alguien de la casa tiene que mirar.
    expect(a.pagosPorRevisar).toBe(2);
    // Y uno que no depende de nadie de aquí: perseguirlo es otra conversación.
    expect(a.pagosEsperandoClienta).toBe(1);
  });

  it("ve las entregas que llevan días en la calle y las que fallaron", async () => {
    const viejo = await pedido({ estado: "en_ruta" });
    await envio(viejo, { estado: "en_ruta", programadoPara: "2026-11-10" });
    const deHoy = await pedido({ estado: "en_ruta" });
    // La de hoy va en camino, no atrasada: el día no ha terminado.
    await envio(deHoy, { estado: "en_ruta", programadoPara: "2026-11-11" });
    const fallida = await pedido({ estado: "agendado" });
    await envio(fallida, { estado: "fallido", programadoPara: "2026-11-05" });
    const sinAsignar = await pedido({ estado: "agendado" });
    await envio(sinAsignar, { estado: "pendiente", programadoPara: "2026-11-11" });
    const deMañana = await pedido({ estado: "agendado" });
    await envio(deMañana, { estado: "pendiente", programadoPara: "2026-11-12" });

    const a = (await resumen(ctx())).atencion!;
    expect(a.entregasAtrasadas).toBe(1);
    expect(a.entregasFallidas).toBe(1);
    // La de mañana no entra: todavía no es trabajo de hoy.
    expect(a.paradasDeHoySinAsignar).toBe(1);
  });

  it("y la ruta de hoy que no ha salido de la bodega", async () => {
    const motoId = id("moto");
    await env.DB.prepare(
      "INSERT INTO motorizados (id,nombre,celular_e164,estado,creado_en) VALUES (?,?,?,'activo',?)",
    )
      .bind(motoId, "Luis", id("507"), AHORA)
      .run();
    for (const fecha of ["2026-11-11", "2026-11-10"]) {
      await env.DB.prepare(
        `INSERT INTO rutas (id,fecha,motorizado_id,bodega_id,estado,creada_por,creada_en)
         VALUES (?,?,?,?,'borrador','prueba',?)`,
      )
        .bind(id("ruta"), fecha, motoId, bodegaId, AHORA)
        .run();
    }
    // La de ayer no se cuenta: para eso está la pantalla de entregas. Aquí la
    // pregunta es si la tanda de HOY ya salió.
    expect((await resumen(ctx())).atencion?.rutasDeHoySinSalir).toBe(1);
  });
});

describe("el inventario", () => {
  it("una vez cargado, separa lo agotado de lo que se está acabando", async () => {
    const codigos = (
      await env.DB.prepare("SELECT codigo FROM variantes ORDER BY codigo LIMIT 3").all<{
        codigo: string;
      }>()
    ).results.map((r) => r.codigo);

    await cargarInventario(0, { codigo: codigos[0]!, minimo: 3 }); // agotado
    await cargarInventario(2, { codigo: codigos[1]!, minimo: 6 }); // por acabarse
    await cargarInventario(50, { codigo: codigos[2]!, minimo: 6 }); // tranquilo

    const inv = (await resumen(ctx())).inventario!;
    if (!inv.cargado) throw new Error("con movimientos, el inventario está cargado");
    // Las 36 filas siguen ahí y las otras 33 están en cero: ahora sí cuentan
    // como agotadas, porque ya hay inventario del que hablar.
    expect(inv.agotadas).toBe(34);
    // Una fila agotada NO se cuenta además como «por acabarse»: los conjuntos
    // no se solapan, así que sumarlos no cuenta nada dos veces.
    expect(inv.porAcabarse).toBe(1);
    expect(inv.agotadas + inv.porAcabarse).toBeLessThanOrEqual(inv.filas);
    expect(inv.unidades).toBe(52);
  });

  it("lo que no tiene mínimo puesto no avisa nunca, y eso se dice con un número", async () => {
    await cargarInventario(4, { minimo: null });
    const inv = (await resumen(ctx())).inventario!;
    if (!inv.cargado) throw new Error("tenía que estar cargado");
    // Cuatro cajas libres sin mínimo no son «por acabarse»: nadie pidió que
    // avisara. Lo que se dice es que falta configurarlo.
    expect(inv.porAcabarse).toBe(0);
    expect(inv.sinMinimo).toBe(36);
  });

  it("descuenta lo reservado: lo comprometido no se puede vender otra vez", async () => {
    // Todas las demás con holgura, para que la lista traiga solo la de esta
    // prueba: viene ordenada por lo que queda, y treinta y cinco filas en cero
    // delante dejarían fuera justo la que se quiere mirar.
    await todoConHolgura();
    await cargarInventario(5, { minimo: 2, reservado: 4 });
    const inv = (await resumen(ctx())).inventario!;
    if (!inv.cargado) throw new Error("tenía que estar cargado");
    // Cinco físicas menos cuatro apartadas es UNA libre, por debajo del mínimo
    // de dos. Con el físico a secas, esta fila no avisaría.
    expect(inv.agotadas).toBe(0);
    expect(inv.porAcabarse).toBe(1);
    expect(inv.lista).toHaveLength(1);
    expect(inv.lista[0]).toMatchObject({ codigo, libres: 1, minimo: 2 });
    expect(inv.reservadas).toBe(4);
  });

  it("no cuenta una bodega apagada ni una talla retirada", async () => {
    await cargarInventario(1, { minimo: 5 });
    expect((await resumen(ctx())).inventario?.filas).toBe(36);

    await env.DB.prepare("UPDATE bodegas SET activa = 0 WHERE id <> ?").bind(bodegaId).run();
    await env.DB.prepare("UPDATE variantes SET activo = 0 WHERE codigo <> ?").bind(codigo).run();
    // Jubilar un producto no tiene que hacer crecer la alarma del día.
    expect((await resumen(ctx())).inventario?.filas).toBe(1);
  });

  it("corta la lista y lo dice en vez de darla por completa", async () => {
    const primero = (
      await env.DB.prepare("SELECT codigo FROM variantes ORDER BY codigo LIMIT 1").first<{
        codigo: string;
      }>()
    )?.codigo;
    await cargarInventario(0, { codigo: primero!, minimo: 1 });

    const inv = (await resumen(ctx())).inventario!;
    if (!inv.cargado) throw new Error("tenía que estar cargado");
    // Treinta y seis filas en cero no caben en una pantalla de teléfono.
    expect(inv.lista.length).toBe(12);
    expect(inv.listaTruncada).toBe(true);
    // Lo agotado primero: es lo que ya está costando ventas.
    expect(inv.lista[0]!.libres).toBe(0);
  });
});

describe("el dinero", () => {
  it("lo que entró se fecha por el día de Panamá, no por el de UTC", async () => {
    const p = await pedido();
    // Las 11 de la noche del 10 en Panamá son el 11 de madrugada en UTC. Con la
    // fecha de UTC, este pago de ayer se contaría como de hoy.
    await pago(p, { monto: 7000, confirmadoEn: Date.parse("2026-11-11T04:00:00Z") });
    // Este sí es de hoy: 8 de la mañana de Panamá.
    await pago(p, { monto: 2500, confirmadoEn: Date.parse("2026-11-11T13:00:00Z") });
    // Y este es de ayer a las 8 de la mañana, que es lo comparable con hoy.
    await pago(p, { monto: 1800, confirmadoEn: Date.parse("2026-11-10T13:00:00Z") });

    const hoy = await resumen(ctx());
    expect(hoy.dinero?.entro).toBe(2500);
    // 1800 y no 8800: el de las 11 de la noche de ayer queda FUERA de «ayer
    // hasta esta hora», que es el único trozo de ayer comparable con las nueve
    // de la mañana de hoy. Esta prueba se escribió esperando 8800 y el código
    // tenía razón: con la tarde de ayer dentro, cada mañana parecería una
    // caída que solo es que el día no ha pasado.
    expect(hoy.dinero?.entroAnterior).toBe(1800);

    // En la semana entran los tres: el lunes fue el 9.
    expect((await resumen(ctx(), "semana")).dinero?.entro).toBe(11_300);
  });

  it("solo cuenta los aprobados: un comprobante sin revisar no es dinero", async () => {
    const p = await pedido();
    await pago(p, { monto: 4000, estado: "aprobado" });
    await pago(p, { monto: 9000, estado: "confirmando" });
    await pago(p, { monto: 9000, estado: "rechazado" });
    expect((await resumen(ctx())).dinero?.entro).toBe(4000);
  });

  it("un aprobado sin hora de confirmación se cuenta aparte, no se mete en un día cualquiera", async () => {
    const p = await pedido();
    await pago(p, { monto: 3000, confirmadoEn: null });
    const dinero = (await resumen(ctx())).dinero!;
    // No se empuja a `creado_en`: eso sería inventarse la fecha. Se dice que
    // hay uno sin ubicar, que es un dato que alguien puede arreglar.
    expect(dinero.entro).toBe(0);
    expect(dinero.pagosSinFecha).toBe(1);
  });
});

describe("la serie del gráfico", () => {
  it("empieza en el primer pedido y no catorce días antes", async () => {
    const p = await pedido({ creado_en: Date.parse("2026-11-09T15:00:00Z") });
    await pago(p, { monto: 1200, confirmadoEn: Date.parse("2026-11-09T16:00:00Z") });

    const serie = (await resumen(ctx())).dinero!.serie;
    // Lunes, martes y miércoles: tres días, no catorce. Los once anteriores no
    // son días sin vender, son días en que el negocio no estaba en el sistema.
    expect(serie.map((d) => d.fecha)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(serie[0]!.centavos).toBe(1200);
    // Un día sin pagos sí es un cero de verdad: ese día no entró nada.
    expect(serie[1]!.centavos).toBe(0);
  });

  it("no mira más allá de los catorce días aunque el negocio sea viejo", async () => {
    const p = await pedido({ creado_en: AHORA - 300 * DIA });
    await pago(p, { monto: 500, confirmadoEn: AHORA - 300 * DIA });
    const serie = (await resumen(ctx())).dinero!.serie;
    expect(serie.length).toBe(DIAS_DE_SERIE);
    expect(serie[0]!.fecha).toBe("2026-10-29");
    expect(serie.at(-1)!.fecha).toBe("2026-11-11");
    // El pago de hace diez meses no se cuela en el primer día de la ventana.
    expect(serie.reduce((t, d) => t + d.centavos, 0)).toBe(0);
  });

  it("mete cada pago en su día de Panamá", async () => {
    const p = await pedido({ creado_en: Date.parse("2026-11-10T06:00:00Z") });
    // 11 de la noche del 10 en Panamá (ya el 11 en UTC) y 1 de la mañana del 11.
    await pago(p, { monto: 300, confirmadoEn: Date.parse("2026-11-11T04:00:00Z") });
    await pago(p, { monto: 700, confirmadoEn: Date.parse("2026-11-11T06:00:00Z") });

    expect((await resumen(ctx())).dinero?.serie).toEqual([
      { fecha: "2026-11-10", centavos: 300 },
      { fecha: "2026-11-11", centavos: 700 },
    ]);
  });
});

describe("lo que se mueve", () => {
  it("cuenta pedidos y clientas nuevas del periodo y del anterior", async () => {
    await pedido({ creado_en: AHORA - HORA });
    await pedido({ creado_en: AHORA - DIA - HORA });
    await env.DB.prepare(
      "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)",
    )
      .bind(id("cli"), "Nueva", AHORA - 2 * HORA, AHORA - 2 * HORA)
      .run();

    const a = (await resumen(ctx())).actividad!;
    expect(a.pedidosNuevos).toBe(1);
    expect(a.pedidosNuevosAnterior).toBe(1);
    expect(a.clientasNuevas).toBe(1);
    // Dos: la de `beforeEach` y la nueva.
    expect(a.clientasEnTotal).toBe(2);
  });

  it("no cuenta dos veces a una clienta fusionada ni a una anonimizada", async () => {
    await env.DB.prepare(
      "INSERT INTO clientes (id,nombre,fusionado_en_id,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
    )
      .bind(id("cli"), "Repetida", clienteId, AHORA - 2 * HORA, AHORA)
      .run();
    await env.DB.prepare(
      "INSERT INTO clientes (id,nombre,anonimizado_en,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
    )
      .bind(id("cli"), "Borrada", AHORA, AHORA - 2 * HORA, AHORA)
      .run();

    const a = (await resumen(ctx())).actividad!;
    // Las dos se crearon dentro del periodo y ninguna cuenta: una ya está
    // contada en la clienta con la que se fusionó, y la otra ejerció su
    // derecho a que se la borren (Ley 81).
    expect(a.clientasNuevas).toBe(0);
    // Solo la de `beforeEach`, que es de hace un mes.
    expect(a.clientasEnTotal).toBe(1);
  });
});

describe("quién ve qué", () => {
  it("con datos de verdad, la asistente sigue sin ver el dinero", async () => {
    const p = await pedido({ estado: "agendado", total_cents: 9000, pagado_cents: 9000 });
    await pago(p, { monto: 9000 });

    const suyo = await resumen(ctx("asistente"));
    expect(suyo.dinero).toBeNull();
    // Pero sí ve el trabajo: lo que no ve es cuánto entró.
    expect(suyo.atencion).not.toBeNull();

    const deLaDuena = await resumen(ctx("duena"));
    expect(deLaDuena.dinero?.entro).toBe(9000);
  });
});
