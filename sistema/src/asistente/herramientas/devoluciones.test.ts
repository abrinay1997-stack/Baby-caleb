import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { guardar as guardarAjuste } from "../../db/ajustes";
import {
  armarRuta,
  crearEnvio,
  despacharRuta,
  fechaDePanama,
  marcarEntregada,
  marcarFallida,
} from "../../db/entregas";
import { crearPedido } from "../../db/pedidos";
import { agendar } from "../../db/transiciones";
import { ejecutar } from "../ejecutar";
import { catalogo } from "../index";
import { revisar } from "../referencias";
import type { Contexto } from "../registro";
import type { Rol } from "../../seguridad/roles";
import {
  cancelarLaRuta,
  cerrarLaRuta,
  devolverElPedido,
  devolverLaParada,
} from "./devoluciones";

/**
 * Deshacer y cerrar por MCP, contra una D1 de verdad.
 *
 * Lo que se vigila aquí es la capa de la herramienta, no la de `db/`: que el
 * número del pedido y el nombre del motorizado lleven a la fila correcta, que
 * un handle que no se puede resolver lo diga en vez de tocar otra cosa, y que
 * lo que vuelve hacia el modelo no lleve nada de la clienta. Lo que la
 * devolución hace en los libros ya lo prueba `src/db/entregas.test.ts`: no se
 * vuelve a probar aquí, se comprueba que de verdad se llamó.
 *
 * Y se llama por donde la va a llamar el usuario. Las pruebas del grupo
 * «la puerta» no invocan `ejecutar()` de la herramienta: pasan por
 * `asistente/ejecutar.ts`, que es lo que corre MCP en `tools/call`. Una
 * herramienta que funciona pero que el catálogo no enseña es la trampa §12 de
 * `docs/TRAMPAS.md`, y esa no la caza ninguna prueba que importe el archivo
 * directo.
 *
 * El runner no aísla el almacenamiento entre pruebas del mismo archivo y los
 * libros no se pueden borrar —el trigger lo prohíbe—, así que todo lo que se
 * siembra lleva su propio identificador y ninguna prueba depende de lo que
 * dejó otra.
 */

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

/**
 * Quién pregunta.
 *
 * El id tiene que ser de una fila de `usuarios` de verdad: `acciones.usuario_id`
 * la referencia, así que un usuario inventado tumba la bitácora —y la bitácora
 * es lo que convierte «sensible» en algo más que una palabra—.
 */
const ctx = (rol: Rol = "duena"): Contexto => ({
  db: env.DB,
  usuario:
    rol === "duena"
      ? { id: "u-duena-entregas", correo: "duena@babycaleb.com", rol }
      : { id: "u-asis-entregas", correo: "asistente@babycaleb.com", rol },
  canal: "mcp",
  conversacionId: null,
  ahora: ahora(),
});

const motor = () => ({ db: env.DB, ahora: ahora(), actor: "duena@babycaleb.com" });

let productoId: string;
let bodegaId: string;
let bodega: string;
let zonaId: string;
let zona: string;

beforeEach(async () => {
  productoId = id("prod");
  bodegaId = id("bod");
  bodega = `Bodega ${bodegaId}`;
  zonaId = id("zon");
  zona = `Zona ${zonaId}`;

  await env.DB.batch([
    // Los usuarios no se borran entre pruebas: la bitácora los referencia y
    // una bitácora no se puede borrar, que es justo lo que se quiere.
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-duena-entregas','duena@babycaleb.com','Yarielis','duena',1,?)",
    ).bind(ahora()),
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-asis-entregas','asistente@babycaleb.com','Asistente','asistente',1,?)",
    ).bind(ahora()),
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
       VALUES (?,?,'ciudad','motorizado',500,?)`,
    ).bind(zonaId, zona, ahora()),
  ]);
});

/** Un motorizado por prueba: una ruta por día y por motorizado. */
async function motorizadoNuevo(nombre?: string): Promise<{ id: string; nombre: string }> {
  const mid = id("mot");
  const comoSeLlama = nombre ?? `Motorizado ${mid}`;
  await env.DB.prepare(
    "INSERT INTO motorizados (id,nombre,celular_e164,estado,vehiculo,pin_fallos,creado_en) VALUES (?,?,?,'activo','moto',0,?)",
  )
    .bind(mid, comoSeLlama, `507${String(ahora()).slice(-7)}${n++}`, ahora())
    .run();
  return { id: mid, nombre: comoSeLlama };
}

async function variante(fisico: number): Promise<string> {
  const codigo = id("PZ").toUpperCase();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en) VALUES (?,?,?,1,5000,1,1,1,?)`,
    ).bind(codigo, productoId, `pieza ${codigo}`, ahora()),
    env.DB.prepare("INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES (?,?,?,0)").bind(
      codigo,
      bodegaId,
      fisico,
    ),
  ]);
  return codigo;
}

/** Un pedido agendado con su mercancía apartada y una clienta con nombre. */
async function pedidoAgendado(opts: { cantidad: number; fisico: number; pagar: "abono" | "todo" | "nada" }) {
  const codigo = await variante(opts.fisico);
  const clienteId = id("cli");
  const nombreDeLaClienta = `Clienta ${clienteId}`;
  const direccionId = id("dir");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)").bind(
      clienteId,
      nombreDeLaClienta,
      ahora(),
      ahora(),
    ),
    env.DB.prepare(
      `INSERT INTO direcciones (id,cliente_id,zona_id,texto,lat,lng,precision,creado_en)
       VALUES (?,?,?,?,8.9824,-79.5199,'pin',?)`,
    ).bind(direccionId, clienteId, zonaId, `Casa de ${clienteId}`, ahora()),
  ]);

  const r = await crearPedido(
    {
      db: env.DB,
      ahora: ahora(),
      actor: "prueba",
      // Con cero se agenda sin abonar: así la devolución de una parada no
      // depende de que la dueña haya decidido el destino del abono.
      abonoMinimoCents: opts.pagar === "nada" ? 0 : 500,
      minutosParaAbonar: null,
    },
    {
      idempotencia: id("idem"),
      clienteId,
      origen: "web",
      lineas: [{ codigo, cantidad: opts.cantidad, bodega }],
      zona,
      direccionId,
    },
  );
  if (!r.ok) throw new Error(`no se pudo crear el pedido: ${r.mensaje}`);

  const pagado = opts.pagar === "todo" ? r.datos.totalCents : opts.pagar === "abono" ? 500 : 0;
  if (pagado > 0) {
    await env.DB.prepare("UPDATE pedidos SET pagado_cents = ?, estado_pago = ? WHERE id = ?")
      .bind(pagado, opts.pagar === "todo" ? "pagado" : "abonado", r.datos.id)
      .run();
  }

  const a = await agendar(motor(), r.datos.id);
  if (!a.ok) throw new Error(`no se pudo agendar: ${a.mensaje}`);

  return {
    pedidoId: r.datos.id,
    numero: r.datos.numero,
    codigo,
    clienteId,
    nombreDeLaClienta,
    cantidad: opts.cantidad,
  };
}

/** Una parada en la calle, con su ruta despachada. */
async function enLaCalle(
  opts: { cantidad?: number; fisico?: number; pagar?: "abono" | "todo" | "nada"; motorizado?: string } = {},
) {
  const e = await pedidoAgendado({
    cantidad: opts.cantidad ?? 2,
    fisico: opts.fisico ?? 10,
    pagar: opts.pagar ?? "nada",
  });
  const envio = await crearEnvio(motor(), { pedidoId: e.pedidoId });
  if (!envio.ok) throw new Error(`no se pudo crear el envío: ${envio.mensaje}`);

  const m = await motorizadoNuevo(opts.motorizado);
  const ruta = await armarRuta(motor(), {
    motorizadoId: m.id,
    bodegaId,
    envioIds: [envio.datos.envioId],
    origen: { lat: 8.98, lng: -79.52 },
  });
  if (!ruta.ok) throw new Error(`no se pudo armar la ruta: ${ruta.mensaje}`);

  return { ...e, envioId: envio.datos.envioId, motorizado: m, rutaId: ruta.datos.rutaId };
}

/** Lo mismo, pero con la ruta ya fuera de la bodega. */
async function despachada(opts: Parameters<typeof enLaCalle>[0] = {}) {
  const e = await enLaCalle(opts);
  const s = await despacharRuta(motor(), e.rutaId);
  if (!s.ok) throw new Error(`no salió la ruta: ${s.mensaje}`);
  return e;
}

const leerEnvio = (envioId: string) =>
  env.DB.prepare("SELECT estado, ruta_id, motorizado_id FROM envios WHERE id = ?")
    .bind(envioId)
    .first<{ estado: string; ruta_id: string | null; motorizado_id: string | null }>();

const leerPedido = (pedidoId: string) =>
  env.DB.prepare("SELECT estado FROM pedidos WHERE id = ?")
    .bind(pedidoId)
    .first<{ estado: string }>();

const leerRuta = (rutaId: string) =>
  env.DB.prepare("SELECT estado, cerrada_en FROM rutas WHERE id = ?")
    .bind(rutaId)
    .first<{ estado: string; cerrada_en: number | null }>();

const existencias = (codigo: string) =>
  env.DB.prepare("SELECT fisico, reservado FROM existencias WHERE codigo = ? AND bodega_id = ?")
    .bind(codigo, bodegaId)
    .first<{ fisico: number; reservado: number }>();

const decidirElAbono = async (valor: "reembolso" | "credito") => {
  const g = await guardarAjuste(
    { db: env.DB, ahora: ahora(), actor: "duena@babycaleb.com" },
    { clave: "cancelacion_con_abono", valor, motivo: "lo decidió la dueña" },
  );
  expect(g.ok, "no se pudo guardar la decisión del abono").toBe(true);
};

// ===========================================================================
// La puerta: que el catálogo las enseñe y que la política las pare
// ===========================================================================

const LAS_CUATRO = ["cancelar_ruta", "cerrar_ruta", "devolver_parada", "devolver_pedido"] as const;

describe("la puerta", () => {
  it("las cuatro están en el catálogo que ven el panel, Telegram y MCP", () => {
    // La trampa §12: una pieza terminada que nadie llama. Importar el archivo
    // en la prueba no la enchufa; esto mira el registro de verdad, que es de
    // donde MCP saca `tools/list`.
    const registro = catalogo();
    for (const nombre of LAS_CUATRO) {
      expect(registro.buscar(nombre), `«${nombre}» no está en el catálogo`).toBeDefined();
    }
  });

  it("y MCP se las enseña a la dueña con su esquema cerrado", () => {
    const definiciones = catalogo().definicionesPara("duena");
    for (const nombre of LAS_CUATRO) {
      const d = definiciones.find((x) => x.name === nombre);
      expect(d, `«${nombre}» no se le enseña a la dueña`).toBeDefined();
      expect(d?.input_schema["additionalProperties"]).toBe(false);
      // La descripción es lo que lee el modelo para elegir: sin ejemplo, elige
      // a ciegas entre las dos devoluciones.
      expect(d?.description).toMatch(/Ejemplo:/);
    }
  });

  it("ninguna se ejecuta sin que una persona la permita", async () => {
    // Deshacer lo que ya pasó es la definición de lo que no se hace solo. Por
    // MCP esto es lo que devuelve «No se hizo» con el resumen.
    const e = await despachada();
    const hecho = await ejecutar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      catalogo(),
      {
        nombre: "devolver_parada",
        argumentos: { pedido: e.numero, motivo: "la clienta se mudó" },
        canal: "mcp",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );

    expect(hecho.ok, JSON.stringify(hecho)).toBe(true);
    if (!hecho.ok) return;
    expect(hecho.datos.clase).toBe("por_confirmar");

    // Y no tocó nada: la parada sigue en la calle y la mercancía apartada.
    expect((await leerEnvio(e.envioId))?.estado).toBe("en_ruta");
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 2 });
  });

  it("a la asistente se le dice que no, y antes de mirar los argumentos", async () => {
    // Las cuatro son solo de la dueña: el catálogo no le da nada sensible a
    // nadie más, y deshacer una entrega o cerrar la caja del día es de las
    // cosas que no se delegan por una tubería sin pantalla.
    //
    // Y el rol se mira ANTES del esquema: el número del pedido de aquí no
    // existe, y aun así la respuesta es «no puede», no «ese pedido no está».
    // Corregirle los argumentos a quien no puede entrar le enseña el esquema de
    // algo que no le corresponde.
    const hecho = await ejecutar(
      { db: env.DB, usuario: ctx("asistente").usuario, ahora: ahora() },
      catalogo(),
      {
        nombre: "devolver_pedido",
        argumentos: { pedido: 7, motivo: "" },
        canal: "mcp",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );
    expect(hecho.ok).toBe(false);
    if (hecho.ok) return;
    expect(hecho.codigo).toBe("no_autorizado");

    for (const h of [devolverLaParada, devolverElPedido, cancelarLaRuta, cerrarLaRuta]) {
      expect(h.roles, `«${h.nombre}» se la da a alguien más`).toEqual(["duena"]);
    }
  });

  it("las cuatro son sensibles", () => {
    for (const h of [devolverLaParada, devolverElPedido, cancelarLaRuta, cerrarLaRuta]) {
      expect(h.nivel, `«${h.nombre}» no es sensible`).toBe("sensible");
    }
  });
});

// ===========================================================================
// devolver_parada
// ===========================================================================

describe("devolver_parada", () => {
  it("devuelve la parada del pedido que se le nombra y libera lo apartado", async () => {
    const e = await despachada({ cantidad: 4, fisico: 10 });
    expect(
      (await marcarFallida(motor(), { idempotencia: id("idem"), envioId: e.envioId, motivo: "se mudó" }))
        .ok,
    ).toBe(true);

    const r = await devolverLaParada.ejecutar(ctx(), {
      pedido: e.numero,
      motivo: "la clienta ya no la quiere",
    });

    expect(r.pedido).toBe(e.numero);
    expect(r.devuelta).toBe(true);
    expect(r.liberadas).toBe(1);
    // Que se llamó a `devolverParada` de verdad se ve en la base, no en lo que
    // la herramienta contesta.
    expect((await leerEnvio(e.envioId))?.estado).toBe("devuelto");
    expect((await leerPedido(e.pedidoId))?.estado).toBe("cancelado");
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 0 });
  });

  it("dice cuánto abonó la clienta y qué se hace con ese dinero", async () => {
    // El dinero no se mueve al devolver: queda esperando destino. Si la
    // herramienta se lo callara, el asistente contestaría «ya está» y nadie se
    // acordaría de que hay dinero de otra persona pendiente.
    await decidirElAbono("credito");
    const e = await despachada({ cantidad: 1, fisico: 5, pagar: "abono" });
    expect(
      (await marcarFallida(motor(), { idempotencia: id("idem"), envioId: e.envioId, motivo: "nadie" }))
        .ok,
    ).toBe(true);

    const r = await devolverLaParada.ejecutar(ctx(), { pedido: e.numero, motivo: "no estaba" });
    expect(r.abonoCents).toBe(500);
    expect(r.destinoDelAbono).toBe("credito");
  });

  it("un pedido que SÍ se entregó manda a devolver_pedido, no dice «no hay parada»", async () => {
    // Las dos devoluciones se parecen desde fuera y hacen cosas opuestas en los
    // libros. Si esta contestara «no hay nada que devolver», el modelo se
    // rendiría teniendo la herramienta correcta al lado.
    const e = await despachada({ cantidad: 1, fisico: 5, pagar: "todo" });
    expect(
      (await marcarEntregada(motor(), { idempotencia: id("idem"), envioId: e.envioId })).ok,
    ).toBe(true);

    await expect(
      devolverLaParada.ejecutar(ctx(), { pedido: e.numero, motivo: "le quedó chica" }),
    ).rejects.toThrow(/devolver_pedido/);
    expect((await leerPedido(e.pedidoId))?.estado).toBe("entregado");
  });

  it("un pedido sin entrega preparada lo dice, y no es lo mismo que no existir", async () => {
    const e = await pedidoAgendado({ cantidad: 1, fisico: 5, pagar: "nada" });
    await expect(
      devolverLaParada.ejecutar(ctx(), { pedido: e.numero, motivo: "ya no" }),
    ).rejects.toThrow(/no tiene ninguna entrega preparada/);
  });

  it("un número que no existe enseña cómo se escribe el número", async () => {
    // «123» no se convierte en «BC-000123»: adivinar de qué pedido habla es
    // devolver la mercancía de otra clienta.
    await expect(devolverLaParada.ejecutar(ctx(), { pedido: "123", motivo: "ya no" })).rejects.toThrow(
      /BC-000123/,
    );
  });

  it("el número vale escrito en minúsculas", async () => {
    const e = await despachada({ cantidad: 1, fisico: 5 });
    expect(
      (await marcarFallida(motor(), { idempotencia: id("idem"), envioId: e.envioId, motivo: "x" })).ok,
    ).toBe(true);

    const r = await devolverLaParada.ejecutar(ctx(), {
      pedido: e.numero.toLowerCase(),
      motivo: "nadie en la casa",
    });
    expect(r.pedido).toBe(e.numero);
  });

  it("no se devuelve una parada que nadie marcó fallida: el error es el de db/", async () => {
    // La herramienta no repite la máquina de estados. Si lo hiciera, el día que
    // el dominio cambiara habría dos respuestas distintas a la misma pregunta.
    const e = await despachada({ cantidad: 2, fisico: 10 });
    await expect(
      devolverLaParada.ejecutar(ctx(), { pedido: e.numero, motivo: "porque sí" }),
    ).rejects.toThrow(/fallido/i);
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 2 });
  });
});

// ===========================================================================
// devolver_pedido
// ===========================================================================

describe("devolver_pedido", () => {
  /** Un pedido entregado, pagado entero y con su costo de entrada conocido. */
  async function entregadoYPagado(cantidad: number, fisico: number, valorCents: number) {
    const e = await despachada({ cantidad, fisico, pagar: "todo" });
    await env.DB.prepare("INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,?,?)")
      .bind(e.codigo, fisico, valorCents)
      .run();
    const r = await marcarEntregada(motor(), { idempotencia: id("idem"), envioId: e.envioId });
    if (!r.ok) throw new Error(`no se pudo entregar: ${r.mensaje}`);
    return e;
  }

  it("deshace la venta del pedido que se le nombra", async () => {
    // 10 a $20.00 → $2.00 cada una. El asiento 13 y el costo de vuelta ya los
    // prueba db/entregas.test.ts; aquí se comprueba que la herramienta llamó a
    // esa función y no a otra.
    const e = await entregadoYPagado(3, 10, 2000);

    const r = await devolverElPedido.ejecutar(ctx(), {
      pedido: e.numero,
      motivo: "le quedó chica",
    });

    expect(r.pedido).toBe(e.numero);
    expect(r.piezasDevueltas).toBe(1);
    // Pagó todo, así que lo que se le devuelve pasa a ser dinero suyo que está
    // aquí: 2101. Es otra conversación con ella que descargarle una deuda.
    expect(r.cuentaReintegro).toBe("2101");
    expect(r.reintegradoCents).toBe(3 * 5000);
    expect(r.avisoContable).toBeNull();

    expect((await leerPedido(e.pedidoId))?.estado).toBe("devuelto");
    expect(await existencias(e.codigo)).toEqual({ fisico: 10, reservado: 0 });

    const asiento = await env.DB.prepare(
      "SELECT hecho FROM asientos WHERE referencia_tipo = 'pedido' AND referencia_id = ? AND hecho = '13'",
    )
      .bind(e.pedidoId)
      .first<{ hecho: string }>();
    expect(asiento, "la herramienta no dejó el asiento 13").not.toBeNull();
  });

  it("avisa cuando alguna pieza volvió sin valor de entrada, en vez de contarla en cero", async () => {
    // `TRAMPAS` §7: un cero diría que la mercancía no costó nada. El aviso no
    // lleva ninguna cifra de costo —eso tiene su propio permiso—, lleva el
    // hueco dicho en palabras.
    const e = await despachada({ cantidad: 2, fisico: 6, pagar: "todo" });
    const r = await marcarEntregada(motor(), { idempotencia: id("idem"), envioId: e.envioId });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const d = await devolverElPedido.ejecutar(ctx(), { pedido: e.numero, motivo: "no era" });
    expect(d.avisoContable).toMatch(/sin valor de entrada/i);
    expect(JSON.stringify(d)).not.toMatch(/costo/i);
  });

  it("un pedido que no se entregó manda a la otra devolución", async () => {
    const e = await despachada({ cantidad: 1, fisico: 5 });
    await expect(
      devolverElPedido.ejecutar(ctx(), { pedido: e.numero, motivo: "ya no" }),
    ).rejects.toThrow(/no se entregó/);
  });
});

// ===========================================================================
// cancelar_ruta y cerrar_ruta
// ===========================================================================

describe("cancelar_ruta", () => {
  it("deshace la ruta de hoy de ese motorizado y suelta sus paradas", async () => {
    const e = await enLaCalle({ cantidad: 2, fisico: 10, motorizado: `Luis ${id("x")}` });

    const r = await cancelarLaRuta.ejecutar(ctx(), {
      motorizado: e.motorizado.nombre,
      motivo: "me equivoqué de motorizado",
    });

    expect(r.cancelada).toBe(true);
    expect(r.paradasLiberadas).toBe(1);
    expect(r.fecha).toBe(fechaDePanama(ahora()));
    expect((await leerRuta(e.rutaId))?.estado).toBe("cancelada");

    // La parada vuelve a estar libre: sin ruta y sin motorizado, o sería
    // invisible en la lista de pendientes y mentiría sobre quién la lleva.
    const envio = await leerEnvio(e.envioId);
    expect(envio?.estado).toBe("pendiente");
    expect(envio?.ruta_id).toBeNull();
    expect(envio?.motorizado_id).toBeNull();
  });

  it("el nombre vale con otras mayúsculas y con espacios de sobra", async () => {
    // Quien dicta un nombre no lo teclea igual dos veces.
    const e = await enLaCalle({ motorizado: `Ana Mora ${id("y")}` });
    const r = await cancelarLaRuta.ejecutar(ctx(), {
      motorizado: `  ${e.motorizado.nombre.toUpperCase()} `,
      motivo: "se enfermó",
    });
    expect(r.cancelada).toBe(true);
  });

  it("una ruta que ya salió no se cancela, y lo dice db/", async () => {
    const e = await despachada();
    await expect(
      cancelarLaRuta.ejecutar(ctx(), { motorizado: e.motorizado.nombre, motivo: "ya no" }),
    ).rejects.toThrow(/en_curso|todavía no salió/);
    expect((await leerRuta(e.rutaId))?.estado).toBe("en_curso");
  });

  it("con dos motorizados del mismo nombre y ruta el mismo día, no adivina", async () => {
    // Cancelar la ruta equivocada le borra el día a otra persona. El panel los
    // distingue porque enseña la lista; una herramienta solo tiene el nombre.
    const mismoNombre = `Gemelo ${id("g")}`;
    await enLaCalle({ motorizado: mismoNombre });
    await enLaCalle({ motorizado: mismoNombre });

    await expect(
      cancelarLaRuta.ejecutar(ctx(), { motorizado: mismoNombre, motivo: "ya no" }),
    ).rejects.toThrow(/no se puede saber de cuál habla/);
  });

  it("un motorizado que no existe no es lo mismo que uno sin ruta", async () => {
    await expect(
      cancelarLaRuta.ejecutar(ctx(), { motorizado: "Nadie Nunca", motivo: "ya no" }),
    ).rejects.toThrow(/no hay ningún motorizado/);

    const m = await motorizadoNuevo();
    await expect(
      cancelarLaRuta.ejecutar(ctx(), { motorizado: m.nombre, motivo: "ya no" }),
    ).rejects.toThrow(/no tiene ninguna ruta sin cancelar/);
  });

  it("una ruta de otro día se alcanza con fecha", async () => {
    const e = await enLaCalle();
    // El día se calcula con la MISMA función que usa el código, no con
    // `toISOString()`.
    //
    // `toISOString()` da el día en UTC y el sistema trabaja en hora de Panamá,
    // cinco horas antes. Entre las 7 de la tarde y la medianoche de allá —o
    // sea, de 00:00 a 05:00 UTC— los dos días no coinciden, y el «ayer» que
    // calculaba la prueba ERA el «hoy» del código: la ruta sí se encontraba
    // sin fecha y la prueba se ponía roja.
    //
    // Cinco horas rojas cada noche, verde el resto del día. Nadie lo veía
    // porque nadie corre la suite de madrugada; lo destapó correrla a las
    // 23:28 de Panamá. Una prueba que calcula una fecha de otra manera que el
    // código no está probando el código: está probando otro sistema parecido.
    const ayer = fechaDePanama(ahora() - 24 * 60 * 60 * 1000);
    await env.DB.prepare("UPDATE rutas SET fecha = ? WHERE id = ?").bind(ayer, e.rutaId).run();

    // Sin fecha no la encuentra: busca la de hoy, que es lo que se espera.
    await expect(
      cancelarLaRuta.ejecutar(ctx(), { motorizado: e.motorizado.nombre, motivo: "ya no" }),
    ).rejects.toThrow(/no tiene ninguna ruta sin cancelar/);

    const r = await cancelarLaRuta.ejecutar(ctx(), {
      motorizado: e.motorizado.nombre,
      fecha: ayer,
      motivo: "quedó abierta de ayer",
    });
    expect(r.cancelada).toBe(true);
    expect(r.fecha).toBe(ayer);
  });
});

describe("cerrar_ruta", () => {
  it("cierra el día con lo entregado y lo cobrado", async () => {
    const e = await despachada({ cantidad: 1, fisico: 10, pagar: "nada" });
    const entrega = await marcarEntregada(motor(), {
      idempotencia: id("idem"),
      envioId: e.envioId,
      metodoCobro: "efectivo",
    });
    if (!entrega.ok) throw new Error(entrega.mensaje);

    const r = await cerrarLaRuta.ejecutar(ctx(), { motorizado: e.motorizado.nombre });

    expect(r.cerrada).toBe(true);
    expect(r.entregadas).toBe(1);
    expect(r.cobradoCents).toBe(entrega.datos.cobradoCents);
    expect(r.fecha).toBe(fechaDePanama(ahora()));

    const ruta = await leerRuta(e.rutaId);
    expect(ruta?.estado).toBe("cerrada");
    expect(ruta?.cerrada_en).not.toBeNull();
  });

  it("no cierra con una parada sin marcar", async () => {
    const e = await despachada();
    await expect(cerrarLaRuta.ejecutar(ctx(), { motorizado: e.motorizado.nombre })).rejects.toThrow(
      /sin marcar/,
    );
    expect((await leerRuta(e.rutaId))?.estado).toBe("en_curso");
  });

  it("una ruta que no salió todavía no se cierra", async () => {
    const e = await enLaCalle();
    await expect(cerrarLaRuta.ejecutar(ctx(), { motorizado: e.motorizado.nombre })).rejects.toThrow(
      /borrador|solo se cierra/,
    );
  });
});

// ===========================================================================
// D-20: nada de la clienta sale hacia el modelo
// ===========================================================================

describe("lo que vuelve hacia el modelo", () => {
  it("no lleva el nombre de la clienta, ni su dirección, ni su punto en el mapa", async () => {
    // La pantalla del panel sí recibe todo eso —ahí lo mira una persona— y es
    // justo por eso que esta prueba hace falta: las dos puertas salen de la
    // misma tabla. La guarda es la de `referencias.ts`, la misma que corre MCP
    // sobre todo resultado antes de contestar.
    await decidirElAbono("reembolso");
    const e = await despachada({ cantidad: 1, fisico: 5, pagar: "abono", motorizado: `Luis ${id("z")}` });
    expect(
      (await marcarFallida(motor(), { idempotencia: id("idem"), envioId: e.envioId, motivo: "nadie" }))
        .ok,
    ).toBe(true);

    const nombres = [e.nombreDeLaClienta];
    const devuelta = await devolverLaParada.ejecutar(ctx(), {
      pedido: e.numero,
      motivo: "no estaba en la casa",
    });
    expect(revisar(devuelta, nombres)).toEqual([]);
    // El número del pedido sí va: no es un dato de nadie, y sin él el
    // asistente no puede decir de qué está hablando.
    expect(devuelta.pedido).toBe(e.numero);

    const otra = await enLaCalle({ motorizado: `Luis ${id("w")}` });
    const cancelada = await cancelarLaRuta.ejecutar(ctx(), {
      motorizado: otra.motorizado.nombre,
      motivo: "se enfermó",
    });
    expect(revisar(cancelada, [otra.nombreDeLaClienta])).toEqual([]);
    // Tampoco vuelve el nombre del motorizado: un nombre propio que coincida
    // con el de una clienta tumbaría la respuesta entera en la guarda de MCP.
    expect(JSON.stringify(cancelada)).not.toContain(otra.motorizado.nombre);
  });

  it("y la guarda sabría reconocerlo si un día saliera", () => {
    // El contrapeso. Sin esto, `revisar` podría estar devolviendo siempre la
    // lista vacía y la prueba de arriba pasaría vigilando nada.
    expect(revisar({ pedido: "BC-000001", direccion: "Casa 3, San Miguelito" }, [])).not.toEqual([]);
    expect(revisar({ pedido: "BC-000001", quien: "Mariela Pérez" }, ["Mariela Pérez"])).not.toEqual([]);
  });
});
