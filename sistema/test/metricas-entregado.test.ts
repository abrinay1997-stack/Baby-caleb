import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resumenDelNegocio } from "../src/db/metricas";

/**
 * Lo entregado y lo que queda por cobrar, que salen de la BITÁCORA.
 *
 * Archivo aparte porque son las únicas cifras que necesitan `pedido_eventos`, y
 * un pedido con bitácora no se puede borrar: la bitácora lo referencia y no se
 * deja borrar, que es precisamente lo que se le pide a un libro (trigger de la
 * migración 0006). Así que aquí no hay un `limpiar()` que vacíe la base, y en su
 * lugar **cada prueba vive en su propia semana**: todas las cifras de este
 * archivo tienen ventana, así que con las semanas separadas los datos de una
 * prueba quedan fuera de la ventana de las otras. La única que no tiene ventana
 * —«por cobrar», que es un saldo al día de hoy— se aísla retirando a
 * «cancelado» los pedidos de las demás.
 *
 * Lo que vigila: **que una devolución de la semana que viene no cambie la cifra
 * de esta semana hacia atrás.** `pedidos.estado` dice dónde está un pedido
 * AHORA y no cuándo llegó ahí; la bitácora dice las dos cosas y no se edita.
 */

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

/** Tres miércoles a las 9:00 a.m. de Panamá, uno por prueba, con semanas de sobra entre ellos. */
const SEMANA_1 = Date.parse("2026-11-11T14:00:00Z");
const SEMANA_2 = Date.parse("2026-10-14T14:00:00Z");
const SEMANA_3 = Date.parse("2026-09-16T14:00:00Z");

let n = 0;
const id = (p: string) => `${p}-${++n}`;

async function cliente(): Promise<string> {
  const cli = id("cli");
  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,1,1)")
    .bind(cli, "Ana")
    .run();
  return cli;
}

async function pedido(sobre: {
  estado: string;
  total: number;
  pagado?: number;
  creadoEn: number;
}): Promise<string> {
  const pedidoId = id("ped");
  await env.DB.prepare(
    `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
       subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
       abono_minimo_cents,creado_en,actualizado_en)
     VALUES (?,?,?,?,'web',?,'sin_pago',?,0,0,0,?,?,500,?,?)`,
  )
    .bind(
      pedidoId,
      `BC-${String(n).padStart(6, "0")}`,
      id("tok"),
      await cliente(),
      sobre.estado,
      sobre.total,
      sobre.total,
      sobre.pagado ?? 0,
      sobre.creadoEn,
      sobre.creadoEn,
    )
    .run();
  return pedidoId;
}

async function evento(pedidoId: string, a: string, cuando: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pedido_eventos (id,pedido_id,tipo,de,a,actor,creado_en)
     VALUES (?,?,'transicion','en_ruta',?,'prueba',?)`,
  )
    .bind(id("ev"), pedidoId, a, cuando)
    .run();
}

/**
 * Retira de las cuentas sin ventana lo que dejaron las pruebas anteriores.
 *
 * «cancelado» no sale en por cobrar, ni en por abonar, ni en agendados sin
 * despachar. Es lo que se puede hacer sin tocar un libro.
 */
async function retirarLoAnterior(): Promise<void> {
  await env.DB.prepare(
    "UPDATE pedidos SET estado = 'cancelado', estado_pago = 'sin_pago', pagado_cents = 0",
  ).run();
}

async function resumen(ahora: number, periodo?: "hoy" | "semana") {
  const r = await resumenDelNegocio({ db: env.DB, ahora, rol: "duena" }, periodo);
  if (!r.ok) throw new Error(`el resumen falló: ${r.mensaje}`);
  return r.datos;
}

describe("lo entregado", () => {
  it("lo dice la bitácora, no el estado de ahora", async () => {
    await retirarLoAnterior();
    // Entregado hoy y DEVUELTO después. Con `pedidos.estado`, una devolución de
    // mañana borraría la cifra de hoy hacia atrás; la bitácora no se edita, así
    // que lo entregado el miércoles sigue siendo lo entregado el miércoles.
    const devuelto = await pedido({
      estado: "devuelto",
      total: 8000,
      creadoEn: SEMANA_1 - 4 * HORA,
    });
    await evento(devuelto, "entregado", SEMANA_1 - 3 * HORA);
    await evento(devuelto, "devuelto", SEMANA_1 - HORA);

    // Estado «entregado», pero entregado ANTEAYER: no es de hoy.
    const viejo = await pedido({ estado: "entregado", total: 9900, creadoEn: SEMANA_1 - 3 * DIA });
    await evento(viejo, "entregado", SEMANA_1 - 2 * DIA);

    // Y una devolución de anteayer, que tampoco es de hoy. Sin esta, quitarle
    // la ventana a la cuenta de devoluciones no rompía ninguna prueba: lo
    // destapó una mutación.
    const otroDevuelto = await pedido({
      estado: "devuelto",
      total: 1500,
      creadoEn: SEMANA_1 - 3 * DIA,
    });
    await evento(otroDevuelto, "entregado", SEMANA_1 - 2 * DIA);
    await evento(otroDevuelto, "devuelto", SEMANA_1 - 2 * DIA + HORA);

    const d = (await resumen(SEMANA_1)).dinero!;
    expect(d.entregado).toEqual({ total: 8000, pedidos: 1 });
    expect(d.devueltos).toBe(1);

    // Y en la semana entran los tres, porque el lunes fue el 9.
    const semana = (await resumen(SEMANA_1, "semana")).dinero!;
    expect(semana.entregado).toEqual({ total: 19_400, pedidos: 3 });
    expect(semana.devueltos).toBe(2);
  });

  it("se compara contra una ventana del mismo largo", async () => {
    await retirarLoAnterior();
    const hoy = await pedido({ estado: "entregado", total: 1000, creadoEn: SEMANA_2 - 2 * HORA });
    await evento(hoy, "entregado", SEMANA_2 - HORA); // 8 a.m. de hoy
    const ayerTemprano = await pedido({
      estado: "entregado",
      total: 2000,
      creadoEn: SEMANA_2 - DIA - 2 * HORA,
    });
    await evento(ayerTemprano, "entregado", SEMANA_2 - DIA - HORA); // 8 a.m. de ayer
    const ayerDeNoche = await pedido({
      estado: "entregado",
      total: 4000,
      creadoEn: SEMANA_2 - DIA,
    });
    await evento(ayerDeNoche, "entregado", SEMANA_2 - DIA + 8 * HORA); // 5 p.m. de ayer

    const d = (await resumen(SEMANA_2)).dinero!;
    expect(d.entregado.total).toBe(1000);
    // La tarde de ayer NO entra: a las nueve de la mañana, lo comparable es
    // ayer hasta las nueve. Si entrara, hoy parecería una caída que en realidad
    // es que el día todavía no ha pasado.
    expect(d.entregadoAnterior.total).toBe(2000);
  });

  it("y por cobrar es el saldo de lo ya entregado, al día de hoy y no del periodo", async () => {
    await retirarLoAnterior();
    const debe = await pedido({
      estado: "entregado",
      total: 5000,
      pagado: 2000,
      creadoEn: SEMANA_3 - 41 * DIA,
    });
    // De hace mes y medio, muy fuera de cualquier ventana: sigue debiendo.
    await evento(debe, "entregado", SEMANA_3 - 40 * DIA);
    await pedido({ estado: "entregado", total: 5000, pagado: 5000, creadoEn: SEMANA_3 }); // pagado
    await pedido({ estado: "agendado", total: 9000, pagado: 3000, creadoEn: SEMANA_3 }); // anticipo

    // El abono de un pedido sin entregar no es una deuda cobrable —es un
    // anticipo— y el pedido pagado no debe nada: queda el de hace mes y medio.
    expect((await resumen(SEMANA_3)).dinero?.porCobrar).toEqual({ total: 3000, pedidos: 1 });
    // Y no aparece en lo entregado de esta semana, que es otra pregunta.
    expect((await resumen(SEMANA_3, "semana")).dinero?.entregado).toEqual({
      total: 0,
      pedidos: 0,
    });
  });
});
