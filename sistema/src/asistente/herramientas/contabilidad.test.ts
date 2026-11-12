import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { libroDiario, registrarAsiento, resumenContable } from "../../db/contabilidad";
import type { ContextoContable } from "../../db/contabilidad";
import { asientoManual } from "../../dominio/contabilidad";
import { ROLES_DE_PANEL, puedeEditar, puedeVer } from "../../seguridad/roles";
import { PATRON_REFERENCIA, revisar } from "../referencias";
import type { Contexto } from "../registro";
import {
  ajustarRedondeos,
  cerrarElMes,
  quienMeDebe,
  reabrirElMes,
  verCierre,
  verContabilidad,
  verLibroDiario,
  verMayorDeCuenta,
} from "./contabilidad";

/**
 * Los libros por la puerta del asistente, contra una D1 de verdad.
 *
 * Las funciones que leen y escriben los libros ya tienen sus pruebas en
 * `src/db/contabilidad.test.ts`, y estas herramientas llaman a esas mismas. Lo
 * que se vigila aquí es lo de esta capa:
 *
 *  - **Que el costo por artículo no salga.** Ninguna herramienta del asistente
 *    devuelve costo ni margen, y `GET /contabilidad` sí los trae: la prueba
 *    comprueba que el estado de resultados viene en lo que devuelve
 *    `resumenContable` y NO en lo que devuelve la herramienta.
 *  - **Que el correo de quien escribió un asiento no salga.** La guarda de D-20
 *    descarta cualquier resultado con un correo dentro y no distingue el de una
 *    clienta del de la contadora, así que un libro diario con `creadoPor` no
 *    habría funcionado NUNCA — y sin dar un error.
 *  - **Que el nombre de la clienta que debe no salga**, sino su referencia.
 *  - **Que los parámetros que aceptan hagan algo.** `limite` y `cuantos` no
 *    daban error cuando se ignoraban: devolvían lo mismo (TRAMPAS §9).
 *  - **Que los roles sean los del permiso de su ruta**, comprobado contra la
 *    matriz de `seguridad/roles.ts` y no contra una copia escrita aquí.
 *
 * Este runner no limpia la base entre pruebas del mismo archivo y los asientos
 * no se pueden borrar —el trigger lo prohíbe, que es justo lo que se quiere—,
 * así que **cada prueba trabaja en SU PROPIO AÑO**: las lecturas van por
 * ventana de fechas y dos pruebas nunca se ven. Y **no se siembra nada en
 * `existencias`**, porque la lista del cierre compara las existencias con sus
 * movimientos y una fila sembrada a mano la dejaría en rojo para siempre.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const ctx = (rol: "duena" | "asistente" | "contadora" = "duena"): Contexto => ({
  db: env.DB,
  usuario: { id: "u1", correo: `${rol}@babycaleb.com`, rol },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

const contable = (): ContextoContable => ({
  db: env.DB,
  ahora: ahora(),
  actor: "contadora@babycaleb.com",
});

async function nombresDeClientas(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT nombre, apellido FROM clientes WHERE nombre IS NOT NULL OR apellido IS NOT NULL",
  ).all<{ nombre: string | null; apellido: string | null }>();
  return results
    .flatMap((c) => [c.nombre, c.apellido])
    .filter((x): x is string => typeof x === "string" && x.trim().length >= 3);
}

async function filtraciones(salida: unknown): Promise<unknown[]> {
  return revisar(salida, await nombresDeClientas());
}

/** Un asiento que cuadra, en el año que diga la prueba. */
async function asiento(fecha: string, montoCents: number, descripcion = "Prueba"): Promise<string> {
  const armado = asientoManual({
    fecha,
    descripcion,
    // 1103 efectivo contra 4101 ventas: dos cuentas del plan que existen.
    lineas: [
      { cuenta: "1103", debeCents: montoCents, haberCents: 0, detalle: null },
      { cuenta: "4101", debeCents: 0, haberCents: montoCents, detalle: null },
    ],
    referencia: null,
  });
  if (!armado.ok) throw new Error(armado.mensaje);
  const r = await registrarAsiento(contable(), armado.datos);
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos.asientoId;
}

/**
 * Un pedido entregado con saldo, escrito directo.
 *
 * Sin pasar por `crearPedido` ni por la entrega: lo que se prueba aquí es cómo
 * LEEN los informes, y el camino entero obligaría a sembrar existencias.
 */
async function pedidoConDeuda(o: {
  totalCents: number;
  pagadoCents: number;
  entregadoEn?: number;
  nombre?: string;
}): Promise<{ pedidoId: string; numero: string; clienteId: string }> {
  const productoId = id("prod");
  const bodegaId = id("bod");
  const codigo = id("CB").toUpperCase();
  const pedidoId = id("ped");
  const clienteId = id("cli");
  const numero = `BC-${String(Date.now()).slice(-6)}-${n++}`;
  const t = o.entregadoEn ?? ahora();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
      productoId,
      "panal",
      "Para los libros",
      id("slug"),
      ahora(),
    ),
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(
      bodegaId,
      `Bodega ${bodegaId}`,
    ),
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         tasa_itbms_bp,publicado,activo,version,actualizado_en) VALUES (?,?,?,1,?,0,0,1,1,?)`,
    ).bind(codigo, productoId, `pieza ${codigo}`, o.totalCents, ahora()),
    env.DB.prepare(
      "INSERT INTO clientes (id,nombre,apellido,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
    ).bind(clienteId, o.nombre ?? "Yarielis", "Betancourt", ahora(), ahora()),
    env.DB.prepare(
      `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
         subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
         abono_minimo_cents,requiere_pago_total,version,creado_en,actualizado_en)
       VALUES (?,?,?,?,'panel','entregado','abonado',?,0,0,0,?,?,0,0,1,?,?)`,
    ).bind(
      pedidoId,
      numero,
      id("tok"),
      clienteId,
      o.totalCents,
      o.totalCents,
      o.pagadoCents,
      t,
      t,
    ),
    env.DB.prepare(
      `INSERT INTO envios (id,pedido_id,estado,metodo,bodega_id,guia_token,cobro_cents,
         cobrado_cents,version,creado_en,entregado_en)
       VALUES (?,?,'entregado','motorizado',?,?,0,0,1,?,?)`,
    ).bind(id("env"), pedidoId, bodegaId, id("guia"), t, t),
  ]);

  return { pedidoId, numero, clienteId };
}

// ---------------------------------------------------------------------------
// ver_contabilidad
// ---------------------------------------------------------------------------

describe("ver_contabilidad", () => {
  it("trae el dinero por cuenta y dice si el balance cuadra", async () => {
    await asiento("2031-04-10", 12_500, "Venta de prueba");

    const salida = await verContabilidad.ejecutar(ctx(), {
      desde: "2031-04-01",
      hasta: "2031-04-30",
    });

    const efectivo = salida.dineroPorCuenta.find((c) => c.codigo === "1103");
    expect(efectivo?.saldoCents).toBe(12_500);
    expect(salida.asientosDelPeriodo).toBe(1);
    // Un asiento sin su fila de cuadre se escribió por fuera del camino normal.
    expect(salida.asientosSinCuadre).toBe(0);
    expect(salida.aviso).toContain("2031-04-30");
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("el costo de lo vendido y el margen NO salen, y sí estaban", async () => {
    // EL CONTRAPESO, y va primero: `resumenContable` trae el estado de
    // resultados con el costo y el margen dentro. Sin comprobar eso, esta
    // prueba pasaría igual si un día la función dejara de traerlo.
    const rango = { desde: "2031-05-01", hasta: "2031-05-31" };
    const crudo = await resumenContable({ db: env.DB, ahora: ahora() }, rango);
    expect(Object.keys(crudo.resultados)).toContain("costoDeVentasCents");
    expect(Object.keys(crudo.resultados)).toContain("margenBrutoBp");

    const salida = await verContabilidad.ejecutar(ctx(), rango);
    const claves = JSON.stringify(salida).match(/"[a-zA-Z_]*([cC]osto|[mM]argen)[a-zA-Z_]*":/g);
    expect(claves, "una herramienta devolvió costo o margen").toBeNull();
    // Y no se calla: el aviso dice dónde se mira, porque un hueco que no se ve
    // es un hueco que nadie llena.
    expect(salida.aviso).toContain("costo de lo vendido");
  });

  it("los huecos de la contabilidad salen: lo que falta se ve", async () => {
    const salida = await verContabilidad.ejecutar(ctx(), {});
    expect(salida.huecos.length).toBeGreaterThan(0);
    for (const h of salida.huecos) {
      expect(h.estado).not.toBe("resuelto");
      expect(h.que).toEqual(expect.any(String));
    }
  });
});

// ---------------------------------------------------------------------------
// ver_libro_diario
// ---------------------------------------------------------------------------

describe("ver_libro_diario", () => {
  it("trae los asientos con sus líneas y sus cuentas", async () => {
    const asientoId = await asiento("2032-02-14", 7_700, "Asiento del libro");
    const salida = await verLibroDiario.ejecutar(ctx(), {
      desde: "2032-02-01",
      hasta: "2032-02-28",
    });

    const mio = salida.asientos.find((a) => a.asientoId === asientoId);
    expect(mio?.descripcion).toBe("Asiento del libro");
    expect(mio?.totalCents).toBe(7_700);
    expect(mio?.lineas.map((l) => l.codigo).sort()).toEqual(["1103", "4101"]);
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("el correo de quien escribió el asiento NO sale, y sí estaba", async () => {
    // El contrapeso primero: `libroDiario` trae `creadoPor`, que es un correo.
    // La guarda de D-20 descarta cualquier resultado con un correo dentro, así
    // que un libro diario que lo devolviera no fallaría: dejaría de servir.
    const rango = { desde: "2032-03-01", hasta: "2032-03-31" };
    await asiento("2032-03-05", 4_200);
    const crudo = await libroDiario({ db: env.DB, ahora: ahora() }, rango);
    expect(crudo[0]?.creadoPor).toContain("@");

    const salida = await verLibroDiario.ejecutar(ctx(), rango);
    expect(JSON.stringify(salida)).not.toContain("@");
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("el limite hace algo: con 1 vuelve uno, sin él vuelven los dos", async () => {
    // `?limite=` no funcionaba en tres rutas y no daba error: devolvía el valor
    // de siempre, y ninguna prueba lo notaba porque todas pedían sin límite
    // (TRAMPAS §9).
    const rango = { desde: "2033-06-01", hasta: "2033-06-30" };
    await asiento("2033-06-10", 1_000);
    await asiento("2033-06-20", 2_000);

    const todos = await verLibroDiario.ejecutar(ctx(), rango);
    const uno = await verLibroDiario.ejecutar(ctx(), { ...rango, limite: 1 });

    expect(todos.cuantos).toBe(2);
    expect(uno.cuantos).toBe(1);
    // Y dice que cortó: un total que en realidad era un recorte es la forma más
    // fácil de que el asistente afirme una cifra falsa.
    expect(uno.aviso).toContain("tope");
  });

  it("un periodo sin asientos se explica", async () => {
    const salida = await verLibroDiario.ejecutar(ctx(), {
      desde: "2034-01-01",
      hasta: "2034-01-31",
    });
    expect(salida.asientos).toEqual([]);
    expect(salida.aviso).toContain("2034-01-01");
  });
});

// ---------------------------------------------------------------------------
// ver_mayor_de_cuenta
// ---------------------------------------------------------------------------

describe("ver_mayor_de_cuenta", () => {
  it("trae los apuntes de la cuenta, cada uno con el asiento del que viene", async () => {
    const rango = { desde: "2035-07-01", hasta: "2035-07-31" };
    const asientoId = await asiento("2035-07-09", 3_300);

    const salida = await verMayorDeCuenta.ejecutar(ctx(), { codigo: "4101", ...rango });
    expect(salida.nombre).toEqual(expect.any(String));
    const apunte = salida.apuntes.find((a) => a.asientoId === asientoId);
    // El id del asiento es lo que permite que una cifra diga de dónde sale.
    expect(apunte?.haberCents).toBe(3_300);
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("sin código dice qué falta y da ejemplos del plan", async () => {
    const salida = await verMayorDeCuenta.ejecutar(ctx(), {});
    expect(salida.apuntes).toEqual([]);
    expect(salida.aviso).toContain("1101");
  });

  it("una cuenta que no está en el plan se dice sin inventar nada", async () => {
    const salida = await verMayorDeCuenta.ejecutar(ctx(), { codigo: "9999" });
    expect(salida.apuntes).toEqual([]);
    expect(salida.aviso).toContain("9999");
    expect(salida.aviso).toContain("plan de cuentas");
  });

  it("el limite hace algo", async () => {
    const rango = { desde: "2036-08-01", hasta: "2036-08-31" };
    await asiento("2036-08-02", 1_100);
    await asiento("2036-08-03", 2_200);

    const todos = await verMayorDeCuenta.ejecutar(ctx(), { codigo: "1103", ...rango });
    const uno = await verMayorDeCuenta.ejecutar(ctx(), { codigo: "1103", ...rango, limite: 1 });
    expect(todos.cuantos).toBe(2);
    expect(uno.cuantos).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// quien_me_debe
// ---------------------------------------------------------------------------

describe("quien_me_debe", () => {
  it("la clienta va como su referencia y su nombre NO sale, aunque esté en la base", async () => {
    const dia = 86_400_000;
    const deudora = await pedidoConDeuda({
      totalCents: 9_000,
      pagadoCents: 2_000,
      entregadoEn: ahora() - 3 * dia,
      nombre: "Zoraida",
    });

    const salida = await quienMeDebe.ejecutar(ctx(), {});
    const mia = salida.deudas.find((d) => d.pedidoId === deudora.pedidoId);

    expect(mia?.saldoCents).toBe(7_000);
    expect(mia?.tramo).toBe("0-7");
    expect(mia?.antiguedad).toEqual(expect.any(String));
    // El nombre lo pone el panel DESPUÉS de que el modelo contestó (D-20).
    expect(mia?.clienta).toMatch(PATRON_REFERENCIA);
    expect(JSON.stringify(salida)).not.toContain("Zoraida");
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("el total sale de TODAS las deudas aunque la lista se corte", async () => {
    // Cortar antes de sumar daría un total que es un recorte disfrazado de
    // total. Se comprueba con deltas: el por cobrar es un saldo acumulado y
    // otra prueba del archivo pudo dejar deuda.
    const antes = await quienMeDebe.ejecutar(ctx(), {});
    await pedidoConDeuda({ totalCents: 5_000, pagadoCents: 1_000 });
    await pedidoConDeuda({ totalCents: 5_000, pagadoCents: 1_000 });

    const conUna = await quienMeDebe.ejecutar(ctx(), { cuantos: 1 });
    expect(conUna.deudas).toHaveLength(1);
    expect(conUna.totalCents - antes.totalCents).toBe(8_000);
    expect(conUna.cuantas).toBe(antes.cuantas + 2);
    // Y dice que la lista está recortada.
    expect(conUna.recortado).toBe(true);
    expect(conUna.aviso).toContain("más viejos");
  });

  it("un día sin deuda se explica en vez de contestar cero a secas", async () => {
    const salida = await quienMeDebe.ejecutar(ctx(), { al: "2019-01-01" });
    expect(salida.deudas).toEqual([]);
    expect(salida.totalCents).toBe(0);
    expect(salida.aviso).toContain("2019-01-01");
  });
});

// ---------------------------------------------------------------------------
// ver_cierre
// ---------------------------------------------------------------------------

describe("ver_cierre", () => {
  it("trae la lista de chequeo entera, también lo que no se puede comprobar", async () => {
    const salida = await verCierre.ejecutar(ctx(), { mes: "2037-09" });

    expect(salida.estadoDelMes).toBe("abierto");
    expect(salida.casillas.length).toBeGreaterThan(0);
    // Esconder las que no se pueden comprobar haría que la lista pareciera
    // completa. Salen, diciendo por qué.
    expect(salida.casillas.some((c) => c.estado === "no_se_puede_comprobar")).toBe(true);
    expect(salida.aviso).toContain("no se pueden comprobar");
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("un mes mal escrito se rechaza en el esquema, no en la base", () => {
    expect(verCierre.parametros.safeParse({ mes: "2037-13" }).success).toBe(false);
    expect(verCierre.parametros.safeParse({ mes: "septiembre" }).success).toBe(false);
    expect(verCierre.parametros.safeParse({ mes: "2037-09" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Escribir en los libros
// ---------------------------------------------------------------------------

describe("ajustar_redondeos", () => {
  it("limpia el residuo, deja su asiento y la segunda vez no escribe nada", async () => {
    const codigo = id("RD").toUpperCase();
    const productoId = id("prod");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
        productoId,
        "panal",
        "Para redondeos",
        id("slug"),
        ahora(),
      ),
      env.DB.prepare(
        `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
           tasa_itbms_bp,publicado,activo,version,actualizado_en) VALUES (?,?,?,1,1000,0,0,1,1,?)`,
      ).bind(codigo, productoId, `pieza ${codigo}`, ahora()),
      // Inventario que ya no existe: cero unidades y tres centavos de valor.
      env.DB.prepare("INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,0,3)").bind(
        codigo,
      ),
    ]);

    const salida = await ajustarRedondeos.ejecutar(ctx(), { motivo: "limpieza de la prueba" });
    const mio = salida.ajustes.find((a) => a.codigo === codigo);
    expect(mio?.residuoCents).toBe(3);
    expect(mio?.asientoId).toEqual(expect.any(String));
    expect(await filtraciones(salida)).toEqual([]);

    const valor = await env.DB.prepare("SELECT valor_cents FROM valor_inventario WHERE codigo = ?")
      .bind(codigo)
      .first<{ valor_cents: number }>();
    expect(valor?.valor_cents).toBe(0);

    // Un asiento de cero centavos no corrige nada y ensucia el libro.
    const otra = await ajustarRedondeos.ejecutar(ctx(), { motivo: "otra vez" });
    expect(otra.ajustes.find((a) => a.codigo === codigo)).toBeUndefined();
  });

  it("pide motivo: sin él no se puede ni pedir", () => {
    expect(ajustarRedondeos.parametros.safeParse({}).success).toBe(false);
    expect(ajustarRedondeos.parametros.safeParse({ motivo: "no" }).success).toBe(false);
    expect(ajustarRedondeos.parametros.safeParse({ motivo: "antes del cierre" }).success).toBe(true);
  });
});

describe("cerrar_mes y reabrir_mes", () => {
  it("no cierra un mes que todavía no ha terminado", async () => {
    const enElFuturo = `${new Date(ahora()).getUTCFullYear() + 3}-05`;
    await expect(cerrarElMes.ejecutar(ctx(), { mes: enElFuturo })).rejects.toThrow(
      /no ha terminado/,
    );
  });

  it("cierra un mes terminado y después ningún asiento puede llevar su fecha", async () => {
    const mes = "2021-03";
    const salida = await cerrarElMes.ejecutar(ctx(), { mes, motivo: "revisado en la prueba" });
    expect(salida.mes).toBe(mes);

    // Esto es lo que hace que un cierre signifique algo: el trigger rechaza
    // cualquier asiento con fecha de ese mes.
    await expect(asiento("2021-03-15", 100)).rejects.toThrow();

    const periodo = await env.DB.prepare("SELECT estado, cerrado_por FROM periodos WHERE mes = ?")
      .bind(mes)
      .first<{ estado: string; cerrado_por: string }>();
    expect(periodo?.estado).toBe("cerrado");
    // El actor es el correo de quien pidió, no «el asistente».
    expect(periodo?.cerrado_por).toBe("duena@babycaleb.com");
  });

  it("no se cierra dos veces", async () => {
    const mes = "2021-06";
    await cerrarElMes.ejecutar(ctx(), { mes });
    await expect(cerrarElMes.ejecutar(ctx(), { mes })).rejects.toThrow(/ya estaba cerrado/);
  });

  it("reabrir pide motivo y el motivo queda escrito en el periodo", async () => {
    const mes = "2021-09";
    await cerrarElMes.ejecutar(ctx(), { mes });

    expect(reabrirElMes.parametros.safeParse({ mes }).success).toBe(false);

    await reabrirElMes.ejecutar(ctx(), { mes, motivo: "faltó el extracto del banco" });
    const periodo = await env.DB.prepare(
      "SELECT estado, reabierto_motivo FROM periodos WHERE mes = ?",
    )
      .bind(mes)
      .first<{ estado: string; reabierto_motivo: string | null }>();
    expect(periodo?.estado).toBe("abierto");
    // Un libro con un cambio sin explicación tiene el mismo agujero que uno
    // editado: se sabe que algo cambió y no por qué.
    expect(periodo?.reabierto_motivo).toBe("faltó el extracto del banco");
  });

  it("no reabre un mes que no estaba cerrado", async () => {
    await expect(
      reabrirElMes.ejecutar(ctx(), { mes: "2021-12", motivo: "a ver qué pasa" }),
    ).rejects.toThrow(/no estaba cerrado/);
  });
});

// ---------------------------------------------------------------------------
// Los permisos, contra la matriz y no contra una copia
// ---------------------------------------------------------------------------

describe("los roles son los del permiso de su ruta en el panel", () => {
  it("leer los libros es de quien puede VER contabilidad: la asistente no", () => {
    for (const h of [verContabilidad, verLibroDiario, verMayorDeCuenta, quienMeDebe, verCierre]) {
      for (const rol of ROLES_DE_PANEL) {
        expect(h.roles.includes(rol), `${h.nombre} y ${rol}`).toBe(puedeVer(rol, "contabilidad"));
      }
    }
    // La que importa: quien despacha no ve los libros.
    expect(verContabilidad.roles).not.toContain("asistente");
  });

  it("cerrar el mes es de la dueña, no de la contadora", () => {
    // «La contadora lleva la contabilidad pero NO cierra el mes»: el permiso es
    // `cierre_de_mes` y no `contabilidad`.
    for (const h of [cerrarElMes, reabrirElMes]) {
      for (const rol of ROLES_DE_PANEL) {
        expect(h.roles.includes(rol), `${h.nombre} y ${rol}`).toBe(puedeEditar(rol, "cierre_de_mes"));
      }
    }
    expect(cerrarElMes.roles).not.toContain("contadora");
  });

  it("ajustar_redondeos se estrecha a la dueña, que es MENOS de lo que da el panel", () => {
    // La ruta es `exigeEditar("contabilidad")`, así que ahí la contadora
    // también puede. Aquí no: en este catálogo lo sensible es de la dueña. Se
    // estrecha, no se ensancha, y queda escrito para que nadie lo «arregle» al
    // revés. La contadora lo sigue teniendo en el panel.
    expect(ajustarRedondeos.roles).toEqual(["duena"]);
    expect(puedeEditar("contadora", "contabilidad")).toBe(true);
  });

  it("todo lo que escribe en los libros es sensible, nunca de construcción", () => {
    // «Construcción» se ejecuta directo, sin que nadie lo permita. Nada que
    // toque los libros puede entrar por ahí.
    for (const h of [ajustarRedondeos, cerrarElMes, reabrirElMes]) {
      expect(h.nivel, h.nombre).toBe("sensible");
    }
    for (const h of [verContabilidad, verLibroDiario, verMayorDeCuenta, quienMeDebe, verCierre]) {
      expect(h.nivel, h.nombre).toBe("lectura");
    }
  });

  it("no existe ninguna herramienta para anotar ni para revertir un asiento", () => {
    // Las dos se quedaron en el panel con su motivo escrito en
    // `scripts/sin-mcp.mjs`. Lo que no se puede hacer no se bloquea: no existe.
    const nombres = [
      ajustarRedondeos,
      cerrarElMes,
      reabrirElMes,
      verContabilidad,
      verLibroDiario,
      verMayorDeCuenta,
      quienMeDebe,
      verCierre,
    ].map((h) => h.nombre);
    expect(nombres.filter((x) => /asiento|revers|revert/.test(x))).toEqual([]);
  });
});
