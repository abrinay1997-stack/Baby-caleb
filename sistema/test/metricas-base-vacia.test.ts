import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resumenDelNegocio } from "../src/db/metricas";

/**
 * El resumen con la base COMO ESTÁ HOY: 0 clientas, 0 pedidos, inventario en
 * cero.
 *
 * Está en su propio archivo a propósito. Las migraciones se aplican una vez por
 * archivo de prueba, y los libros del sistema —`movimientos_inventario`,
 * `pedido_eventos`— tienen triggers que abortan el DELETE, así que una vez que
 * otra prueba carga inventario, en ese archivo ya no se puede volver al estado
 * de hoy. Y el estado de hoy es justo el que no puede salir mal: es lo primero
 * que la dueña va a ver.
 *
 * Lo que vigila es una sola idea con tres caras: **un cero de la base no es un
 * cero del negocio.**
 */

/** Miércoles 11 de noviembre de 2026, 9:00 a.m. en Panamá. */
const AHORA = Date.parse("2026-11-11T14:00:00Z");

async function resumen(periodo?: "hoy" | "semana") {
  const r = await resumenDelNegocio({ db: env.DB, ahora: AHORA, rol: "duena" }, periodo);
  if (!r.ok) throw new Error(`el resumen falló: ${r.mensaje}`);
  return r.datos;
}

describe("la base casi vacía de hoy", () => {
  it("arranca de verdad vacía: es el supuesto de todo lo demás", async () => {
    // Si esto cambia (una migración que siembre pedidos, por ejemplo), las
    // pruebas de abajo dejarían de comprobar lo que dicen comprobar.
    const cuenta = async (tabla: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) n FROM ${tabla}`).first<{ n: number }>())?.n;
    expect(await cuenta("clientes")).toBe(0);
    expect(await cuenta("pedidos")).toBe(0);
    expect(await cuenta("pagos")).toBe(0);
    expect(await cuenta("movimientos_inventario")).toBe(0);
    // Y sin embargo las existencias YA existen: doce variantes por tres
    // bodegas, todas en cero. Son las que creó la carga inicial porque
    // `movimientos_inventario` lleva llave foránea a (codigo, bodega_id).
    expect(await cuenta("existencias")).toBe(36);
    expect(
      (await env.DB.prepare("SELECT SUM(fisico) s FROM existencias").first<{ s: number }>())?.s,
    ).toBe(0);
  });

  it("no da por agotado lo que nunca entró", async () => {
    const inv = (await resumen()).inventario!;
    // 36 filas en cero NO son 36 artículos agotados: son 36 filas que la
    // migración creó para que se pueda registrar la primera entrada. Decir
    // «agotado» aquí haría salir a alguien a comprar lo que nadie ha contado.
    expect(inv.cargado).toBe(false);
    expect(inv.filas).toBe(36);
    // Ni agotadas ni lista existen en esta forma: no hay cifra que enseñar.
    expect(inv).not.toHaveProperty("agotadas");
    expect(inv).not.toHaveProperty("porAcabarse");
    expect(inv).not.toHaveProperty("lista");
    // Lo que sí se dice es lo que falta configurar: ninguna fila tiene mínimo,
    // así que hoy la alarma de «se está acabando» no puede avisar de nada.
    expect(inv.sinMinimo).toBe(36);
  });

  it("distingue «nada pendiente» de «todavía no hay nada»", async () => {
    const a = (await resumen()).atencion!;
    // Con los contadores en cero y sin este número, la pantalla diría «todo
    // atendido» a un negocio que aún no ha recibido su primer pedido. Son dos
    // mensajes distintos y llevan a dos cosas distintas.
    expect(a.pedidosEnTotal).toBe(0);
    expect(a.porAbonar).toBe(0);
    expect(a.porAbonarVencidos).toBe(0);
    expect(a.agendadosSinDespachar).toBe(0);
    expect(a.pagosPorRevisar).toBe(0);
    expect(a.pagosEsperandoClienta).toBe(0);
    expect(a.entregasAtrasadas).toBe(0);
    expect(a.entregasFallidas).toBe(0);
    expect(a.paradasDeHoySinAsignar).toBe(0);
    expect(a.rutasDeHoySinSalir).toBe(0);
    expect((await resumen()).actividad).toEqual({
      pedidosNuevos: 0,
      pedidosNuevosAnterior: 0,
      clientasNuevas: 0,
      clientasNuevasAnterior: 0,
      clientasEnTotal: 0,
    });
  });

  it("no dibuja catorce días de nada", async () => {
    const d = (await resumen()).dinero!;
    // Sin un solo pedido no hay desde cuándo medir, y catorce barras en cero
    // dirían que el negocio lleva dos semanas sin vender.
    expect(d.serie).toEqual([]);
    expect(d.entro).toBe(0);
    expect(d.entroAnterior).toBe(0);
    expect(d.pagosSinFecha).toBe(0);
    expect(d.entregado).toEqual({ total: 0, pedidos: 0 });
    expect(d.porCobrar).toEqual({ total: 0, pedidos: 0 });
  });

  it("y dice de qué día y de qué ventana está hablando", async () => {
    const d = await resumen();
    expect(d.hoy).toBe("2026-11-11");
    expect(d.periodo.nombre).toBe("hoy");
    expect(d.periodo.desde).toBe(Date.parse("2026-11-11T05:00:00Z"));
    expect(d.periodo.hasta).toBe(AHORA);
    // La ventana con la que se compara dura exactamente lo mismo.
    expect(d.anterior.hasta - d.anterior.desde).toBe(d.periodo.hasta - d.periodo.desde);
    expect(d.anterior.desdeFecha).toBe("2026-11-10");

    const semana = await resumen("semana");
    expect(semana.periodo.desdeFecha).toBe("2026-11-09");
    expect(semana.anterior.desdeFecha).toBe("2026-11-02");
    expect(semana.periodo.dias).toBe(3);
  });

  it("y los avisos a las clientas van al día", async () => {
    expect((await resumen()).avisos).toEqual({ sinPublicar: 0, masViejo: null });
  });
});

describe("quién ve qué, con la base vacía", () => {
  const para = async (rol: "duena" | "asistente" | "contadora" | "motorizado") => {
    const r = await resumenDelNegocio({ db: env.DB, ahora: AHORA, rol });
    if (!r.ok) throw new Error(r.mensaje);
    return r.datos;
  };

  it("la asistente lleva pedidos y NO ve lo que entró", async () => {
    const d = await para("asistente");
    // No viene en cero ni escondido en la pantalla: NO VIENE. Lo que no sale
    // del servidor no se puede filtrar por error.
    expect(d.dinero).toBeNull();
    expect(d.atencion).not.toBeNull();
    expect(d.inventario).not.toBeNull();
  });

  it("la dueña y la contadora sí ven dinero", async () => {
    expect((await para("duena")).dinero).not.toBeNull();
    // La contadora no tiene «cobros» en la matriz, pero sí «contabilidad»: el
    // dinero es su oficio y esconderle el total de la semana no protegería nada.
    expect((await para("contadora")).dinero).not.toBeNull();
  });

  it("el motorizado no entra al panel: no se le consulta nada", async () => {
    const d = await para("motorizado");
    expect(d.atencion).toBeNull();
    expect(d.actividad).toBeNull();
    expect(d.inventario).toBeNull();
    expect(d.dinero).toBeNull();
  });
});
