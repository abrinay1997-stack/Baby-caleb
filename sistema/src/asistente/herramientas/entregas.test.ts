import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { entregasDelDia, fechaDePanama } from "../../db/entregas";
import { crearPedido } from "../../db/pedidos";
import { agendar } from "../../db/transiciones";
import { ROLES_DE_PANEL, puedeEditar, puedeVer } from "../../seguridad/roles";
import { PATRON_REFERENCIA, revisar } from "../referencias";
import type { Contexto } from "../registro";
import {
  armarRutaDelDia,
  despacharLaRuta,
  marcarEntregadaLaParada,
  marcarFallidaLaParada,
  programarEntrega,
  sugerirMotorizado,
  verBodegas,
  verEntregas,
  verZonas,
} from "./entregas";

/**
 * Las entregas por la puerta del asistente, contra una D1 de verdad.
 *
 * Lo que se vigila aquí NO es que el SQL corra: para eso están las pruebas de
 * `src/db/entregas.test.ts`, y estas herramientas llaman a esas mismas
 * funciones. Lo que se vigila es lo propio de esta capa, que son tres cosas:
 *
 *  1. **Que los datos de la clienta no salgan** (D-20). Es la razón de ser del
 *     archivo y la prueba se escribió con un contrapeso: primero se comprueba
 *     que la dirección SÍ está en lo que devuelve `entregasDelDia`, y después
 *     que NO está en lo que devuelve la herramienta. Sin el contrapeso, la
 *     prueba pasaría igual si la siembra se hubiera quedado sin dirección.
 *  2. **Que los roles sean los del permiso de su ruta en el panel**, y se
 *     comprueba contra la matriz de `seguridad/roles.ts`, no contra una copia
 *     escrita a mano aquí: una copia pasa a estar mal el día que la matriz
 *     cambie y nadie se enteraría.
 *  3. **Que lo que devuelve pase `revisar()` limpio**, que es el filtro que
 *     descarta el resultado ENTERO si algo se cuela. Una herramienta que no lo
 *     pase no da un error: deja de servir, en silencio.
 *
 * Este runner no limpia la base entre pruebas del mismo archivo, así que cada
 * prueba siembra lo suyo con un identificador propio.
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

/** Los nombres que hay en `clientes` ahora: es lo que mira la guarda de D-20. */
async function nombresDeClientas(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT nombre, apellido FROM clientes WHERE nombre IS NOT NULL OR apellido IS NOT NULL",
  ).all<{ nombre: string | null; apellido: string | null }>();
  return results
    .flatMap((c) => [c.nombre, c.apellido])
    .filter((x): x is string => typeof x === "string" && x.trim().length >= 3);
}

/** Pasa la guarda de D-20 por un resultado, con los nombres de verdad. */
async function filtraciones(salida: unknown): Promise<unknown[]> {
  return revisar(salida, await nombresDeClientas());
}

let productoId: string;
let bodegaId: string;
let bodega: string;
let zonaId: string;
let zona: string;

beforeEach(async () => {
  // Sin filas de `ajustes`, cada prueba arranca en los valores de fábrica de
  // reglas.json, que es el estado de un sistema recién instalado: las ventanas
  // de entrega en PENDIENTE.
  await env.DB.prepare("DELETE FROM ajustes").run();

  productoId = id("prod");
  bodegaId = id("bod");
  bodega = `Bodega ${bodegaId}`;
  zonaId = id("zon");
  zona = `Zona ${zonaId}`;

  await env.DB.batch([
    env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
      productoId,
      "panal",
      "Para entregas",
      id("slug"),
      ahora(),
    ),
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(bodegaId, bodega),
    env.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,region,metodo,tarifa_cents,actualizado_en)
       VALUES (?,?,'interior','motorizado',500,?)`,
    ).bind(zonaId, zona, ahora()),
  ]);
});

/** Lo que una clienta tiene y el modelo no puede ver. NADA de esto debe salir. */
const LO_DE_LA_CLIENTA = {
  nombre: "Marisol",
  apellido: "Quintero",
  celular: `5076${String(ahora()).slice(-7)}`,
  direccion: "Calle Trece, casa de porton verde",
  referencia: "al lado del abarrotero Milagro",
  lat: 8.98765,
  lng: -79.51234,
};

async function motorizadoNuevo(estado = "activo"): Promise<{ id: string; nombre: string }> {
  const mid = id("mot");
  const nombre = `Repartidor ${mid}`;
  await env.DB.prepare(
    "INSERT INTO motorizados (id,nombre,celular_e164,estado,vehiculo,pin_fallos,creado_en) VALUES (?,?,?,?,'moto',0,?)",
  )
    .bind(mid, nombre, `507${String(ahora()).slice(-7)}${n++}`, estado, ahora())
    .run();
  return { id: mid, nombre };
}

async function variante(fisico: number, precio = 5000): Promise<string> {
  const codigo = id("EN").toUpperCase();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         tasa_itbms_bp,publicado,activo,version,actualizado_en) VALUES (?,?,?,1,?,0,1,1,1,?)`,
    ).bind(codigo, productoId, `pieza ${codigo}`, precio, ahora()),
    env.DB.prepare("INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)").bind(
      codigo,
      bodegaId,
      fisico,
    ),
    // Con promedio cargado, la entrega sabe lo que costó la mercancía y escribe
    // su asiento. Sin esto, `costoDesconocido` sale en true — que también es un
    // camino correcto, pero es otro.
    env.DB.prepare("INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,?,?)").bind(
      codigo,
      fisico,
      fisico * 3000,
    ),
  ]);
  return codigo;
}

interface Escenario {
  pedidoId: string;
  numero: string;
  codigo: string;
  clienteId: string;
  totalCents: number;
}

/** Un pedido agendado de una clienta con nombre, celular, dirección y punto. */
async function pedidoAgendado(opts: { pagar?: "abono" | "todo" } = {}): Promise<Escenario> {
  const codigo = await variante(50);
  const clienteId = id("cli");
  const direccionId = id("dir");

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO clientes (id,nombre,apellido,celular_e164,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)",
    ).bind(
      clienteId,
      LO_DE_LA_CLIENTA.nombre,
      LO_DE_LA_CLIENTA.apellido,
      `${LO_DE_LA_CLIENTA.celular}${n++}`,
      ahora(),
      ahora(),
    ),
    env.DB.prepare(
      `INSERT INTO direcciones (id,cliente_id,zona_id,texto,referencia,lat,lng,precision,creado_en)
       VALUES (?,?,?,?,?,?,?,'pin',?)`,
    ).bind(
      direccionId,
      clienteId,
      zonaId,
      LO_DE_LA_CLIENTA.direccion,
      LO_DE_LA_CLIENTA.referencia,
      LO_DE_LA_CLIENTA.lat,
      LO_DE_LA_CLIENTA.lng,
      ahora(),
    ),
  ]);

  const r = await crearPedido(
    {
      db: env.DB,
      ahora: ahora(),
      actor: "prueba",
      abonoMinimoCents: 500,
      minutosParaAbonar: null,
    },
    {
      idempotencia: id("idem"),
      clienteId,
      origen: "web",
      lineas: [{ codigo, cantidad: 2, bodega }],
      zona,
      direccionId,
    },
  );
  if (!r.ok) throw new Error(`no se pudo crear el pedido: ${r.mensaje}`);

  const pagado = opts.pagar === "todo" ? r.datos.totalCents : 500;
  await env.DB.prepare("UPDATE pedidos SET pagado_cents = ?, estado_pago = ? WHERE id = ?")
    .bind(pagado, opts.pagar === "todo" ? "pagado" : "abonado", r.datos.id)
    .run();

  const a = await agendar({ db: env.DB, ahora: ahora(), actor: "prueba" }, r.datos.id);
  if (!a.ok) throw new Error(`no se pudo agendar: ${a.mensaje}`);

  return {
    pedidoId: r.datos.id,
    numero: r.datos.numero,
    codigo,
    clienteId,
    totalCents: r.datos.totalCents,
  };
}

/** Un pedido con su entrega preparada, por el camino de la herramienta. */
async function conEnvio(opts: { pagar?: "abono" | "todo" } = {}) {
  const e = await pedidoAgendado(opts);
  const r = await programarEntrega.ejecutar(ctx(), { pedidoId: e.pedidoId });
  return { ...e, envioId: r.envioId };
}

/** El camino entero hasta tener una parada en la calle. */
async function enLaCalle(opts: { pagar?: "abono" | "todo" } = {}) {
  const e = await conEnvio(opts);
  const m = await motorizadoNuevo();
  const ruta = await armarRutaDelDia.ejecutar(ctx(), {
    motorizadoId: m.id,
    bodegaId,
    envioIds: [e.envioId],
  });
  await despacharLaRuta.ejecutar(ctx(), { rutaId: ruta.rutaId });
  return { ...e, motorizado: m, rutaId: ruta.rutaId };
}

// ---------------------------------------------------------------------------
// D-20: lo que no sale
// ---------------------------------------------------------------------------

describe("ver_entregas y los datos de la clienta (D-20)", () => {
  it("la dirección, el teléfono, el nombre y el punto NO salen, y sí estaban", async () => {
    const e = await enLaCalle();

    // EL CONTRAPESO, y va primero. Sin él esta prueba pasaría también si la
    // siembra se hubiera quedado sin dirección: estaría comprobando que no sale
    // algo que no existe, que es el fallo del §6 de TRAMPAS.
    const crudo = await entregasDelDia(env.DB, fechaDePanama(ahora()), ahora());
    expect(crudo.ok).toBe(true);
    const comoLoVeLaPantalla = JSON.stringify(crudo);
    expect(comoLoVeLaPantalla).toContain(LO_DE_LA_CLIENTA.direccion);
    expect(comoLoVeLaPantalla).toContain(LO_DE_LA_CLIENTA.referencia);
    expect(comoLoVeLaPantalla).toContain(LO_DE_LA_CLIENTA.nombre);
    expect(comoLoVeLaPantalla).toContain(String(LO_DE_LA_CLIENTA.lat));

    const salida = await verEntregas.ejecutar(ctx(), {});
    const comoLoVeElModelo = JSON.stringify(salida);

    expect(comoLoVeElModelo).not.toContain(LO_DE_LA_CLIENTA.direccion);
    expect(comoLoVeElModelo).not.toContain(LO_DE_LA_CLIENTA.referencia);
    expect(comoLoVeElModelo).not.toContain(LO_DE_LA_CLIENTA.nombre);
    expect(comoLoVeElModelo).not.toContain(LO_DE_LA_CLIENTA.apellido);
    expect(comoLoVeElModelo).not.toContain(LO_DE_LA_CLIENTA.celular);
    expect(comoLoVeElModelo).not.toContain(String(LO_DE_LA_CLIENTA.lat));
    expect(comoLoVeElModelo).not.toContain(String(LO_DE_LA_CLIENTA.lng));

    // Y la parada de verdad está ahí: no es que no salga nada.
    const parada = salida.rutas.flatMap((r) => r.paradas).find((p) => p.pedido === e.numero);
    expect(parada?.estado).toBe("en_ruta");
    // Que HAY punto sí se dice; cuál es, no. Es lo que deja saber que esa
    // parada se puede ordenar sin decir dónde vive nadie.
    expect(parada?.conUbicacion).toBe(true);
  });

  it("la clienta va como su referencia, y es la misma cada vez", async () => {
    const e = await enLaCalle();
    const primera = await verEntregas.ejecutar(ctx(), {});
    const segunda = await verEntregas.ejecutar(ctx(), {});

    const de = (s: typeof primera) =>
      s.rutas.flatMap((r) => r.paradas).find((p) => p.pedido === e.numero)?.clienta;

    expect(de(primera)).toMatch(PATRON_REFERENCIA);
    expect(de(segunda)).toBe(de(primera));
  });

  it("y lo que devuelve pasa la guarda limpio", async () => {
    await enLaCalle();
    expect(await filtraciones(await verEntregas.ejecutar(ctx(), {}))).toEqual([]);
  });

  it("la guarda sabría reconocerlo si la dirección saliera", async () => {
    // El contrapeso de la prueba anterior. Sin esto, `filtraciones` podría
    // estar devolviendo siempre la lista vacía y las dos pasarían vigilando
    // nada; de eso hay precedente en este repositorio.
    await pedidoAgendado();
    expect(await filtraciones({ paradas: [{ direccion: LO_DE_LA_CLIENTA.direccion }] })).not.toEqual(
      [],
    );
    expect(await filtraciones({ nota: `llamar al ${LO_DE_LA_CLIENTA.celular}` })).not.toEqual([]);
    expect(
      await filtraciones({ donde: `${LO_DE_LA_CLIENTA.lat}, ${LO_DE_LA_CLIENTA.lng}` }),
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mirar
// ---------------------------------------------------------------------------

describe("ver_entregas", () => {
  it("un día sin nada se explica en vez de contestar una lista vacía", async () => {
    const salida = await verEntregas.ejecutar(ctx(), { fecha: "2019-03-04" });
    expect(salida.rutas).toEqual([]);
    expect(salida.sinRuta).toEqual([]);
    expect(salida.aviso).toEqual(expect.any(String));
    // Y dice de qué día habla: un resumen sin fecha se lee como «hoy».
    expect(salida.aviso).toContain("2019-03-04");
  });

  it("dice que la dirección no sale, en vez de callarlo", async () => {
    // Un hueco que no se ve es un hueco que nadie llena: si la herramienta
    // calla que se guarda la dirección, el modelo contesta «no la tengo» y la
    // persona cree que el sistema no la sabe.
    const salida = await verEntregas.ejecutar(ctx(), {});
    expect(salida.aviso).toContain("dirección");
  });

  it("separa lo que está en ruta de lo que todavía no tiene entrega preparada", async () => {
    const agendado = await pedidoAgendado();
    const preparado = await conEnvio();

    const salida = await verEntregas.ejecutar(ctx(), {});
    expect(salida.porPreparar.map((p) => p.numero)).toContain(agendado.numero);
    expect(salida.porPreparar.map((p) => p.numero)).not.toContain(preparado.numero);
    expect(salida.sinRuta.map((p) => p.pedido)).toContain(preparado.numero);
  });

  it("una fecha mal escrita se rechaza antes de consultar nada", () => {
    expect(verEntregas.parametros.safeParse({ fecha: "12/11/2026" }).success).toBe(false);
    expect(verEntregas.parametros.safeParse({ fecha: "2026-11-12" }).success).toBe(true);
  });
});

describe("sugerir_motorizado", () => {
  it("propone a todos con su motivo, también a los que no se pueden proponer", async () => {
    const e = await conEnvio();
    const activo = await motorizadoNuevo("activo");
    const inactivo = await motorizadoNuevo("pausa");

    const salida = await sugerirMotorizado.ejecutar(ctx(), { envioId: e.envioId });
    const ids = salida.candidatos.map((c) => c.motorizado_id);
    expect(ids).toContain(activo.id);
    expect(ids).toContain(inactivo.id);
    expect(salida.candidatos.find((c) => c.motorizado_id === activo.id)?.proponible).toBe(true);
    expect(salida.candidatos.find((c) => c.motorizado_id === inactivo.id)?.proponible).toBe(false);
    // Saber POR QUÉ no se propone a alguien vale tanto como la propuesta.
    expect(salida.candidatos.find((c) => c.motorizado_id === inactivo.id)?.motivo).toEqual(
      expect.any(String),
    );
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("sin envioId dice qué falta, no contesta una lista vacía a secas", async () => {
    const salida = await sugerirMotorizado.ejecutar(ctx(), {});
    expect(salida.candidatos).toEqual([]);
    expect(salida.aviso).toContain("envioId");
  });

  it("con un envioId que no está, nombra el id y de dónde sale", async () => {
    // Un error que no nombra su causa manda a buscar al sitio equivocado
    // (TRAMPAS §10).
    const salida = await sugerirMotorizado.ejecutar(ctx(), { envioId: "env-que-no-esta" });
    expect(salida.candidatos).toEqual([]);
    expect(salida.aviso).toContain("env-que-no-esta");
    expect(salida.aviso).toContain("ver_entregas");
  });
});

describe("ver_zonas", () => {
  it("trae la tarifa y distingue la que se cotiza a mano de la de cero", async () => {
    const aMano = id("zon");
    await env.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,region,metodo,tarifa_cents,actualizado_en)
       VALUES (?,?,'interior','otro',NULL,?)`,
    )
      .bind(aMano, `Zona ${aMano}`, ahora())
      .run();

    const salida = await verZonas.ejecutar(ctx(), { region: "interior" });
    const puesta = salida.zonas.find((z) => z.id === zonaId);
    const sinTarifa = salida.zonas.find((z) => z.id === aMano);

    expect(puesta?.tarifaCents).toBe(500);
    expect(puesta?.seCotizaAMano).toBe(false);
    // Un cero diría que llevar allá es gratis. Lo que hay es que no se sabe.
    expect(sinTarifa?.tarifaCents).toBeNull();
    expect(sinTarifa?.seCotizaAMano).toBe(true);
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("el filtro de región hace algo: sin él salen más zonas que con él", async () => {
    // Un parámetro que se ignora en silencio no da error ni 400: devuelve lo
    // mismo que sin pasarlo, y ninguna prueba lo nota si todas preguntan sin
    // pasarlo (TRAMPAS §9).
    const todas = await verZonas.ejecutar(ctx(), {});
    const mias = await verZonas.ejecutar(ctx(), { region: "interior" });

    expect(mias.cuantas).toBeGreaterThan(0);
    expect(todas.cuantas).toBeGreaterThan(mias.cuantas);
    expect(mias.zonas.every((z) => z.region === "interior")).toBe(true);
  });

  it("una región sin zonas lo dice nombrándola", async () => {
    const salida = await verZonas.ejecutar(ctx(), { region: "la-luna" });
    expect(salida.zonas).toEqual([]);
    expect(salida.aviso).toContain("la-luna");
  });
});

describe("ver_bodegas", () => {
  it("trae la bodega con lo que guarda, y avisa de que es lo físico", async () => {
    await variante(14);
    const salida = await verBodegas.ejecutar(ctx(), {});
    const mia = salida.bodegas.find((b) => b.id === bodegaId);

    expect(mia?.nombre).toBe(bodega);
    expect(mia?.activa).toBe(true);
    expect(mia?.unidades).toBe(14);
    // Lo físico incluye lo ya apartado para un pedido: prometerlo es prometer
    // mercancía que ya es de otra clienta.
    expect(salida.aviso).toContain("ver_stock");
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("pasa la guarda aunque haya una clienta llamada como una palabra de dentro", async () => {
    // Esta es la prueba del fallo que encontró este trabajo: las bodegas de
    // fábrica se llaman «Bodega Ciudad de Panamá» y una clienta llamada Ana
    // hacía que la guarda viera «p-ana-má» y descartara el resultado ENTERO.
    // No daba un error: el asistente contestaba «no pude averiguarlo» para
    // siempre. Se arregló en `revisar()` mirando palabras y no trozos.
    const salida = await verBodegas.ejecutar(ctx(), {});
    expect(revisar(salida, ["Ana", "Mar", "Juan"])).toEqual([]);
    // Y el contrapeso: a esa misma Ana, nombrada de verdad, se la sigue cazando.
    expect(revisar({ resumen: "Ana pidió dos mantas" }, ["Ana"])).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mover
// ---------------------------------------------------------------------------

describe("programar_entrega", () => {
  it("prepara la entrega de un pedido agendado y dice lo que hay que cobrar", async () => {
    const e = await pedidoAgendado();
    const salida = await programarEntrega.ejecutar(ctx(), { pedidoId: e.pedidoId });

    expect(salida.envioId).toEqual(expect.any(String));
    expect(salida.bodegaId).toBe(bodegaId);
    expect(salida.porCobrarCents).toBe(e.totalCents - 500);
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("no prepara la entrega de un pedido que todavía no está agendado", async () => {
    const codigo = await variante(10);
    const clienteId = id("cli");
    await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
      .bind(clienteId, `Clienta ${clienteId}`, ahora(), ahora())
      .run();
    const r = await crearPedido(
      { db: env.DB, ahora: ahora(), actor: "prueba", abonoMinimoCents: 500, minutosParaAbonar: null },
      { idempotencia: id("idem"), clienteId, origen: "web", lineas: [{ codigo, cantidad: 1, bodega }], zona },
    );
    if (!r.ok) throw new Error(r.mensaje);

    // Una parada de un pedido que no pagó es una caja que sale de la bodega
    // contra una promesa.
    await expect(programarEntrega.ejecutar(ctx(), { pedidoId: r.datos.id })).rejects.toThrow(
      /no se despacha|agendado/,
    );
  });

  it("no acepta una ventana de entrega mientras la dueña no las haya decidido", async () => {
    const e = await pedidoAgendado();
    await expect(
      programarEntrega.ejecutar(ctx(), { pedidoId: e.pedidoId, ventana: "en la mañana" }),
    ).rejects.toThrow(/ventanas/);
  });
});

describe("armar_ruta y despachar_ruta", () => {
  it("arma la tanda y la saca a la calle", async () => {
    const e = await conEnvio();
    const m = await motorizadoNuevo();

    const ruta = await armarRutaDelDia.ejecutar(ctx(), {
      motorizadoId: m.id,
      bodegaId,
      envioIds: [e.envioId],
    });
    expect(ruta.paradas).toEqual([{ envioId: e.envioId, orden: 1 }]);
    expect(await filtraciones(ruta)).toEqual([]);

    const salida = await despacharLaRuta.ejecutar(ctx(), { rutaId: ruta.rutaId });
    expect(salida.paradas).toBe(1);
    expect(salida.pedidos).toBe(1);

    const envio = await env.DB.prepare("SELECT estado FROM envios WHERE id = ?")
      .bind(e.envioId)
      .first<{ estado: string }>();
    expect(envio?.estado).toBe("en_ruta");
  });

  it("una ruta repetida o vacía se rechaza antes de escribir nada", async () => {
    const e = await conEnvio();
    const m = await motorizadoNuevo();

    expect(armarRutaDelDia.parametros.safeParse({ motorizadoId: m.id, bodegaId, envioIds: [] }).success).toBe(
      false,
    );
    await expect(
      armarRutaDelDia.ejecutar(ctx(), {
        motorizadoId: m.id,
        bodegaId,
        envioIds: [e.envioId, e.envioId],
      }),
    ).rejects.toThrow(/repetida/);
  });

  it("no se despacha dos veces la misma ruta", async () => {
    const e = await enLaCalle();
    await expect(despacharLaRuta.ejecutar(ctx(), { rutaId: e.rutaId })).rejects.toThrow(/en_curso/);
  });
});

describe("marcar_entregada", () => {
  it("cierra la parada, saca el inventario y cobra el saldo", async () => {
    const e = await enLaCalle();
    const antes = await existencias(e.codigo);

    const salida = await marcarEntregadaLaParada.ejecutar(ctx(), {
      envioId: e.envioId,
      metodoCobro: "yappy",
      motivo: "entregado en la puerta",
    });

    expect(salida.pedidoEntregado).toBe(true);
    expect(salida.cobradoCents).toBe(e.totalCents - 500);
    // Hasta aquí estaba apartado; ahora sale de verdad.
    expect((await existencias(e.codigo))?.fisico).toBe((antes?.fisico ?? 0) - 2);
    expect(salida.costoDesconocido).toBe(false);
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("escribe el asiento de la venta, no solo baja el stock", async () => {
    // Los veinte constructores de asientos estuvieron escritos y probados sin
    // que nadie los llamara, y una entrega descontaba inventario dejando los
    // libros vacíos (TRAMPAS §12). Esto comprueba que esta puerta sí los llama.
    const e = await enLaCalle();
    await marcarEntregadaLaParada.ejecutar(ctx(), { envioId: e.envioId, metodoCobro: "yappy" });

    const asiento = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM asientos WHERE referencia_tipo = 'pedido' AND referencia_id = ? AND hecho = '3'",
    )
      .bind(e.pedidoId)
      .first<{ n: number }>();
    expect(asiento?.n).toBe(1);
  });

  it("el segundo toque del mismo botón no cobra dos veces", async () => {
    // El motorizado está en la calle con mala señal y va a tocar dos veces. La
    // clave del intento la deriva la herramienta del envío, justo para que el
    // candado cierre: si la pidiera al modelo, cada reintento traería una clave
    // nueva y no cerraría nunca.
    const e = await enLaCalle();
    const una = await marcarEntregadaLaParada.ejecutar(ctx(), {
      envioId: e.envioId,
      metodoCobro: "yappy",
    });
    const otra = await marcarEntregadaLaParada.ejecutar(ctx(), {
      envioId: e.envioId,
      metodoCobro: "yappy",
    });

    expect(una.yaEstaba).toBe(false);
    expect(otra.yaEstaba).toBe(true);
    expect(otra.cobradoCents).toBe(una.cobradoCents);

    const pagos = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(monto_cents),0) AS suma FROM pagos WHERE pedido_id = ?",
    )
      .bind(e.pedidoId)
      .first<{ n: number; suma: number }>();
    expect(pagos?.n).toBe(1);
    expect(pagos?.suma).toBe(e.totalCents - 500);
  });

  it("el mismo envío con otro cobro dice SU causa, no «clave repetida»", async () => {
    // «esa clave ya se usó para otra cosa» no dice nada a quien no puso ninguna
    // clave, y manda a buscar un duplicado que no existe (TRAMPAS §10).
    const e = await enLaCalle();
    await marcarEntregadaLaParada.ejecutar(ctx(), { envioId: e.envioId, metodoCobro: "yappy" });
    await expect(
      marcarEntregadaLaParada.ejecutar(ctx(), { envioId: e.envioId, metodoCobro: "efectivo" }),
    ).rejects.toThrow(/ya se cerró con otra forma de cobro/);
  });

  it("el monto no lo decide quien llama", async () => {
    // El teléfono dice CÓMO cobró; CUÁNTO lo calcula el servidor del pedido.
    const e = await enLaCalle();
    await expect(
      marcarEntregadaLaParada.ejecutar(ctx(), {
        envioId: e.envioId,
        metodoCobro: "efectivo",
        montoCents: 1,
      }),
    ).rejects.toThrow(/no se puede cobrar otra cantidad/);

    const envio = await env.DB.prepare("SELECT estado, cobrado_cents FROM envios WHERE id = ?")
      .bind(e.envioId)
      .first<{ estado: string; cobrado_cents: number }>();
    // Y no se escribió NADA: la parada sigue en la calle.
    expect(envio?.estado).toBe("en_ruta");
    expect(envio?.cobrado_cents).toBe(0);
  });
});

describe("marcar_fallida", () => {
  it("deja el pedido listo para reintentar y NO libera la mercancía", async () => {
    const e = await enLaCalle();
    const antes = await existencias(e.codigo);

    const salida = await marcarFallidaLaParada.ejecutar(ctx(), {
      envioId: e.envioId,
      motivo: "no había nadie en la casa",
    });

    expect(salida.pedidoReprogramado).toBe(true);
    // Liberar lo apartado pondría a la venta la mercancía de esa clienta y el
    // reintento de mañana se quedaría sin con qué.
    expect(await existencias(e.codigo)).toEqual(antes);
    expect(await filtraciones(salida)).toEqual([]);
  });

  it("sin motivo no se puede ni pedir", () => {
    // Sin motivo, mañana nadie sabe si hay que volver, llamar o devolver.
    expect(marcarFallidaLaParada.parametros.safeParse({ envioId: "x" }).success).toBe(false);
    expect(marcarFallidaLaParada.parametros.safeParse({ envioId: "x", motivo: "no" }).success).toBe(
      false,
    );
  });
});

const existencias = (codigo: string) =>
  env.DB.prepare("SELECT fisico, reservado FROM existencias WHERE codigo = ? AND bodega_id = ?")
    .bind(codigo, bodegaId)
    .first<{ fisico: number; reservado: number }>();

// ---------------------------------------------------------------------------
// Los permisos, contra la matriz y no contra una copia
// ---------------------------------------------------------------------------

describe("los roles son los del permiso de su ruta en el panel", () => {
  it("las de leer son de quien puede VER pedidos", () => {
    for (const h of [verEntregas, sugerirMotorizado, verZonas, verBodegas]) {
      for (const rol of ROLES_DE_PANEL) {
        expect(h.roles.includes(rol), `${h.nombre} y ${rol}`).toBe(puedeVer(rol, "pedidos"));
      }
    }
  });

  it("las de anotar son de quien puede EDITAR pedidos", () => {
    for (const h of [programarEntrega, armarRutaDelDia, despacharLaRuta, marcarFallidaLaParada]) {
      for (const rol of ROLES_DE_PANEL) {
        expect(h.roles.includes(rol), `${h.nombre} y ${rol}`).toBe(puedeEditar(rol, "pedidos"));
      }
    }
  });

  it("marcar_entregada es solo de la dueña, que es MENOS de lo que da el panel", () => {
    // La ruta del panel es `exigeEditar("pedidos")`, así que ahí la asistente
    // también cierra entregas. Aquí no, y es a propósito: en este catálogo lo
    // sensible es de la dueña. Se estrecha, no se ensancha — y se deja escrito
    // que la diferencia existe, para que nadie la «arregle» al revés.
    expect(marcarEntregadaLaParada.nivel).toBe("sensible");
    expect(marcarEntregadaLaParada.roles).toEqual(["duena"]);
    expect(puedeEditar("asistente", "pedidos")).toBe(true);
  });

  it("y el nivel de cada una dice si toca dinero o existencias", () => {
    // Marcar entregada descuenta inventario y escribe el asiento de la venta:
    // sensible. Las demás anotan estados y bitácoras.
    expect(verEntregas.nivel).toBe("lectura");
    expect(verZonas.nivel).toBe("lectura");
    expect(verBodegas.nivel).toBe("lectura");
    expect(sugerirMotorizado.nivel).toBe("lectura");
    expect(programarEntrega.nivel).toBe("construccion");
    expect(armarRutaDelDia.nivel).toBe("construccion");
    expect(despacharLaRuta.nivel).toBe("construccion");
    expect(marcarFallidaLaParada.nivel).toBe("construccion");
  });

  it("ninguna se declara con texto escrito por una clienta, porque no lo devuelve", () => {
    // `textoExterno` endurece el resto del turno cuando una herramienta trae
    // texto de una clienta. Aquí está en false porque D-20 ya sacó de la
    // respuesta la referencia de la dirección y la nota de la entrega, que es
    // justo ese texto. Si algún día vuelve a salir, la marca entra con él y
    // esta prueba se pone roja.
    for (const h of [
      verEntregas,
      sugerirMotorizado,
      verZonas,
      verBodegas,
      programarEntrega,
      armarRutaDelDia,
      despacharLaRuta,
      marcarEntregadaLaParada,
      marcarFallidaLaParada,
    ]) {
      expect(h.textoExterno ?? false, `${h.nombre}`).toBe(false);
    }
  });
});
