import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { configurarCredencial, estado } from "../../db/pasarelas";
import { confirmarPago, registrarComprobante } from "../../db/pagos";
import { crearPedido, type ContextoPedido } from "../../db/pedidos";
import { revisar } from "../referencias";
import { confirmar, ejecutar } from "../ejecutar";
import { catalogo } from "../index";
import type { Contexto } from "../registro";
import {
  apagarPasarela,
  cambiarModoDePasarela,
  contracargo,
  encenderPasarela,
  reembolso,
  verPasarelas,
} from "./dinero";

/**
 * El dinero y las pasarelas por MCP.
 *
 * Lo que se vigila, por orden de lo que dolería más:
 *
 *  1. **Que no salga una credencial.** Es lo único de este archivo que no se
 *     puede deshacer: una clave de cobro que viaja hacia un modelo ya viajó.
 *  2. **Que nada mueva dinero sin que una persona lo permita.** Se prueba por
 *     la puerta de verdad (`ejecutar`), no llamando a la herramienta a mano:
 *     «sensible» es una palabra en un objeto hasta que el ejecutor la para.
 *  3. **Que los libros no se editen.** Un reembolso es un asiento NUEVO; el
 *     asiento del cobro sigue donde estaba.
 *  4. **Que sea la misma regla que el panel.** No se puede cambiar el modo de
 *     una pasarela encendida, por ninguna de las dos puertas.
 *  5. **Que estén enchufadas** (TRAMPAS §12): si no salen en el catálogo, no
 *     existen, y sus pruebas pasarían igual.
 *
 * Cada prueba se validó rompiendo a propósito lo que dice vigilar; la mutación
 * que se dejó anotada está en «la guarda de las credenciales», que es la que
 * más caro sale.
 */

// Obviamente falsa: ninguna credencial de verdad entra en este repositorio. Es
// el centinela — si aparece en lo que sale hacia el modelo, se la ve.
const LLAVE_MAESTRA = "TExBVkUtRkFMU0EtREUtUFJVRUJBLTMyLUJZVEVTISE=";
const CREDENCIAL_CENTINELA = "ID-COMERCIO-FALSO-CENTINELA-0001";
const CLAVE_CENTINELA = "CLAVE-SECRETA-FALSA-CENTINELA-01";

/** El correo con el que se firma, que es lo que el panel manda como `actor`. */
const CORREO = "duena@babycaleb.com";

let n = 0;
const ahora = () => Date.now();
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const duena: Contexto["usuario"] = { id: "u-dinero-duena", correo: CORREO, rol: "duena" };

const ctx = (): Contexto => ({
  db: env.DB,
  usuario: duena,
  canal: "mcp",
  conversacionId: null,
  ahora: ahora(),
});

const quien = () => ({ db: env.DB, usuario: duena, ahora: ahora() });

const registro = catalogo();

const pedir = (nombre: string, argumentos: unknown) =>
  ejecutar(quien(), registro, {
    nombre,
    argumentos,
    canal: "mcp",
    conversacionId: null,
    conAdjuntos: false,
    textoExterno: false,
  });

beforeEach(async () => {
  await env.DB.batch([
    // La bitácora de pasarelas y la de acciones NO se borran —son libros, y los
    // triggers lo impiden—, así que lo que se limpia es solo la configuración.
    env.DB.prepare("DELETE FROM pasarela_credenciales"),
    env.DB.prepare("DELETE FROM ajustes WHERE clave = 'pasarelas_activas'"),
    env.DB.prepare(
      "UPDATE pasarelas SET modo = 'prueba', modo_cambiado_por = NULL, modo_cambiado_en = NULL",
    ),
    // `acciones.usuario_id` referencia `usuarios`, y la bitácora no se puede
    // borrar: el usuario se queda puesto entre pruebas.
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES (?,?,'Yarielis','duena',1,?)",
    ).bind(duena.id, CORREO, ahora()),
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-asis-dinero','a@b.com','Asistente','asistente',1,?)",
    ).bind(ahora()),
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 40 WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ),
  ]);
});

/** Las dos credenciales de Yappy en el modo que toque, con el centinela dentro. */
async function conCredencialesDeYappy(modo: "prueba" | "real" = "prueba"): Promise<void> {
  const contexto = { db: env.DB, ahora: ahora(), actor: CORREO, llaveMaestra: LLAVE_MAESTRA };
  for (const [credencial, valor] of [
    ["id_comercio", CREDENCIAL_CENTINELA],
    ["clave_secreta", CLAVE_CENTINELA],
  ] as const) {
    const r = await configurarCredencial(contexto, {
      pasarela: "yappy",
      modo,
      credencial,
      valor,
      motivo: "pruebas de la herramienta de MCP",
    });
    if (!r.ok) throw new Error(r.mensaje);
  }
}

const laDeYappy = async () => {
  const r = await verPasarelas.ejecutar(ctx(), {});
  const p = r.pasarelas.find((x) => x.pasarela === "yappy");
  if (p === undefined) throw new Error("yappy no salió en el estado");
  return p;
};

const encendidas = async (): Promise<unknown> => {
  const fila = await env.DB.prepare(
    "SELECT valor_json FROM ajustes WHERE clave = 'pasarelas_activas' ORDER BY version DESC LIMIT 1",
  ).first<{ valor_json: string }>();
  return fila === null ? [] : JSON.parse(fila.valor_json);
};

// ---------------------------------------------------------------------------
// 1 · Ninguna credencial sale por aquí
// ---------------------------------------------------------------------------

describe("ver_pasarelas no deja salir una credencial", () => {
  it("ni el valor, ni la ficha, ni el correo de quien la puso", async () => {
    await conCredencialesDeYappy("prueba");

    const salida = await verPasarelas.ejecutar(ctx(), {});
    const comoViaja = JSON.stringify(salida);

    // El valor, que es lo único irreparable.
    expect(comoViaja, "salió el valor de una credencial").not.toContain(CREDENCIAL_CENTINELA);
    expect(comoViaja).not.toContain(CLAVE_CENTINELA);
    expect(comoViaja).not.toContain(LLAVE_MAESTRA);

    // Y la ficha entera: el correo de quien la puso y el identificador de la
    // llave con la que se cifró tampoco tienen nada que hacer en un resultado
    // que va hacia un modelo.
    for (const prohibido of [
      // «secreto» a secas no sirve de centinela: una credencial se puede llamar
      // «Clave secreta» y ese título SÍ puede salir cuando falta.
      "secreto_cifrado",
      "llave_id",
      "puesta_por",
      "puesta_en",
      "llave_maestra",
      CORREO,
    ]) {
      expect(comoViaja, `salió «${prohibido}»`).not.toContain(prohibido);
    }
    // El libro y el historial de encendidas, que van llenos de correos.
    expect(Object.keys(salida)).toEqual(["pasarelas", "encendidas", "aviso"]);
  });

  it("y el recorte es MÍO: la ruta del panel sí enseña esas cosas", async () => {
    // El contrapeso. Sin esto, las comprobaciones de arriba podrían estar
    // pasando porque `estado` no devuelve nada de eso, y entonces no vigilarían
    // mi recorte sino una casualidad.
    await conCredencialesDeYappy("prueba");

    const crudo = await estado({ db: env.DB, ahora: ahora(), llaveMaestra: LLAVE_MAESTRA });
    if (!crudo.ok) throw new Error(crudo.mensaje);
    const comoLoVeElPanel = JSON.stringify(crudo.datos);

    expect(comoLoVeElPanel, "el panel ya no enseña quién puso la credencial").toContain(
      "puesta_por",
    );
    expect(comoLoVeElPanel).toContain("llave_id");
    expect(comoLoVeElPanel, "el panel ya no enseña el libro con sus correos").toContain(CORREO);
  });

  it("y la frontera de MCP no tiene nada que cortar en lo que devuelvo", async () => {
    // La misma guarda que corre `src/mcp/servidor.ts` antes de contestar. Si mi
    // recorte se quedara corto, aquí saldría la lista de filtraciones y el
    // servidor devolvería un error en vez del estado: no es solo una fuga, es
    // una herramienta que no funciona.
    await conCredencialesDeYappy("real");
    const salida = await verPasarelas.ejecutar(ctx(), {});
    expect(revisar(salida)).toEqual([]);

    const crudo = await estado({ db: env.DB, ahora: ahora(), llaveMaestra: LLAVE_MAESTRA });
    if (!crudo.ok) throw new Error(crudo.mensaje);
    // Y el contrapeso de la guarda: lo que devuelve el panel SÍ se corta.
    expect(revisar(crudo.datos).map((f) => f.que)).toContain("correo");
  });
});

// ---------------------------------------------------------------------------
// 2 · El estado dice lo que hay que creer
// ---------------------------------------------------------------------------

describe("ver_pasarelas", () => {
  it("dice qué le falta a la que no se puede encender, por su nombre", async () => {
    const yappy = await laDeYappy();
    expect(yappy.puede_encenderse).toBe(false);
    expect(yappy.le_falta).toEqual(["ID de comercio", "Clave secreta"]);
    expect(yappy.por_que_no).toMatch(/Clave secreta/);
  });

  it("no confunde «en modo real» con «cobrando de verdad»", async () => {
    // Son los dos datos que hay que mirar juntos. Una pasarela en real y
    // apagada no le cobra a nadie, y decir que sí es la peor forma de
    // equivocarse: lleva a apagar lo que ya estaba apagado y a creer que el
    // cobro de la clienta entró.
    await conCredencialesDeYappy("real");
    const cambio = await cambiarModoDePasarela.ejecutar(ctx(), {
      pasarela: "yappy",
      modo: "real",
      motivo: "ya están las credenciales de producción",
    });
    expect(cambio.modo).toBe("real");

    const apagada = await laDeYappy();
    expect(apagada.modo).toBe("real");
    expect(apagada.encendida).toBe(false);
    expect(apagada.cobrando_de_verdad).toBe(false);

    await encenderPasarela.ejecutar(ctx(), {
      pasarela: "yappy",
      motivo: "ya se hizo el cobro de prueba y su reembolso",
    });
    const viva = await laDeYappy();
    expect(viva.cobrando_de_verdad).toBe(true);
  });

  it("siempre explica lo que no contesta, y nunca se calla el silencio", async () => {
    // El `aviso` de esta herramienta no explica una lista vacía —las pasarelas
    // son tres y están siempre— sino que la respuesta es un recorte. Un modelo
    // que no ve las credenciales y no sabe por qué concluye que no hay ninguna.
    const sinNada = await verPasarelas.ejecutar(ctx(), {});
    expect(sinNada.aviso).toMatch(/credenciales/);
    expect(sinNada.aviso, "no dice que no hay ninguna encendida").toMatch(/ninguna pasarela/);

    await conCredencialesDeYappy("prueba");
    await encenderPasarela.ejecutar(ctx(), { pasarela: "yappy", motivo: "prueba del aviso" });
    const conUna = await verPasarelas.ejecutar(ctx(), {});
    expect(conUna.aviso).toMatch(/credenciales/);
    expect(conUna.aviso, "sigue diciendo que no hay ninguna encendida").not.toMatch(
      /ninguna pasarela/,
    );
    expect(conUna.encendidas).toEqual(["yappy"]);
  });
});

// ---------------------------------------------------------------------------
// 3 · El interruptor, con las reglas del panel
// ---------------------------------------------------------------------------

describe("encender y apagar", () => {
  it("se niega a encender lo que le falta una credencial, y no escribe nada", async () => {
    await expect(
      encenderPasarela.ejecutar(ctx(), { pasarela: "yappy", motivo: "a ver si cuela" }),
    ).rejects.toThrow(/falta/);
    expect(await encendidas(), "quedó encendida sin credenciales").toEqual([]);
  });

  it("enciende por el mismo ajuste que el panel, y dice en qué modo quedó", async () => {
    await conCredencialesDeYappy("prueba");
    const r = await encenderPasarela.ejecutar(ctx(), {
      pasarela: "yappy",
      motivo: "cobro de prueba de un dólar hecho y reembolsado",
    });

    expect(r).toMatchObject({ encendida: true, modo: "prueba", cobrando_de_verdad: false, cambio: true });
    // Lo que importa: se escribió en `ajustes.pasarelas_activas`, que es el
    // único dueño de «qué está encendido». Si esta herramienta se hubiera
    // inventado su propia columna, el checkout no se enteraría.
    expect(await encendidas()).toEqual(["yappy"]);
  });

  it("encender dos veces no miente: la segunda dice que no hubo cambio", async () => {
    await conCredencialesDeYappy("prueba");
    await encenderPasarela.ejecutar(ctx(), { pasarela: "yappy", motivo: "la primera" });
    const otra = await encenderPasarela.ejecutar(ctx(), { pasarela: "yappy", motivo: "la segunda" });
    expect(otra.cambio).toBe(false);
  });

  it("apagar siempre se puede, incluso a medio configurar", async () => {
    // Es el interruptor de emergencia de 04-pagos §10: sin condiciones.
    const r = await apagarPasarela.ejecutar(ctx(), {
      pasarela: "tilopay",
      motivo: "no se ha afiliado todavía",
    });
    expect(r).toMatchObject({ encendida: false, cambio: false });

    await conCredencialesDeYappy("prueba");
    await encenderPasarela.ejecutar(ctx(), { pasarela: "yappy", motivo: "para luego apagarla" });
    const yappy = await apagarPasarela.ejecutar(ctx(), {
      pasarela: "yappy",
      motivo: "están rechazando todos los cobros",
    });
    expect(yappy.cambio).toBe(true);
    expect(await encendidas()).toEqual([]);
  });
});

describe("cambiar el modo", () => {
  it("no se puede con la pasarela encendida: es la regla que evita cobrar con las claves de prueba", async () => {
    await conCredencialesDeYappy("prueba");
    await encenderPasarela.ejecutar(ctx(), { pasarela: "yappy", motivo: "encendida en prueba" });

    await expect(
      cambiarModoDePasarela.ejecutar(ctx(), {
        pasarela: "yappy",
        modo: "real",
        motivo: "a ver si cuela",
      }),
    ).rejects.toThrow(/está encendida/);

    const yappy = await laDeYappy();
    expect(yappy.modo, "el modo cambió con la pasarela encendida").toBe("prueba");
  });

  it("y cambiarlo no enciende nada", async () => {
    await conCredencialesDeYappy("real");
    const r = await cambiarModoDePasarela.ejecutar(ctx(), {
      pasarela: "yappy",
      modo: "real",
      motivo: "ya están las credenciales de producción",
    });
    expect(r).toMatchObject({ modo: "real", cambio: true, sigue_apagada: true });
    expect(await encendidas()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 · El dinero que vuelve
// ---------------------------------------------------------------------------

const ctxP = (): ContextoPedido => ({
  db: env.DB,
  ahora: ahora(),
  actor: CORREO,
  abonoMinimoCents: 500,
  minutosParaAbonar: 120,
});

/** Un pedido con un abono ya confirmado, por las funciones de verdad. */
async function conAbonoConfirmado(montoCents: number) {
  const clienteId = id("cli");
  await env.DB.prepare(
    "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,'Ana',?,?)",
  )
    .bind(clienteId, ahora(), ahora())
    .run();

  const pedido = await crearPedido(ctxP(), {
    idempotencia: id("idem"),
    clienteId,
    origen: "web",
    lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  });
  if (!pedido.ok) throw new Error(pedido.mensaje);

  const comprobante = await registrarComprobante(
    { db: env.DB, ahora: ahora(), actor: CORREO },
    {
      idempotencia: id("comp"),
      pedidoId: pedido.datos.id,
      montoCents,
      metodo: "yappy",
      tipo: "abono",
    },
  );
  if (!comprobante.ok) throw new Error(comprobante.mensaje);

  const confirmado = await confirmarPago(
    { db: env.DB, ahora: ahora(), actor: CORREO },
    comprobante.datos.pagoId,
  );
  if (!confirmado.ok) throw new Error(confirmado.mensaje);

  return { pedidoId: pedido.datos.id, pagoId: comprobante.datos.pagoId };
}

const elPedido = (pedidoId: string) =>
  env.DB.prepare("SELECT pagado_cents, estado_pago FROM pedidos WHERE id = ?")
    .bind(pedidoId)
    .first<{ pagado_cents: number; estado_pago: string }>();

const asientosDelPago = async (pagoId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT hecho FROM asientos WHERE referencia_tipo = 'pago' AND referencia_id = ? ORDER BY hecho",
  )
    .bind(pagoId)
    .all<{ hecho: string }>();
  return results.map((f) => f.hecho);
};

describe("registrar_reembolso", () => {
  it("saca el dinero del pedido y deja un asiento NUEVO, sin tocar el del cobro", async () => {
    const { pedidoId, pagoId } = await conAbonoConfirmado(3000);
    const antes = await asientosDelPago(pagoId);
    expect(antes.length, "el cobro tenía que haber dejado su asiento").toBeGreaterThan(0);

    const r = await reembolso.ejecutar(ctx(), {
      pago_id: pagoId,
      monto_cents: 3000,
      motivo: "se arrepintió y el pedido no había salido",
      proveedor_ref: "YAPPY-DEVUELTO-7",
    });

    expect(r).toMatchObject({ devuelto_cents: 3000, pagado_cents: 0, estado_del_pago: "reembolsado" });
    expect((await elPedido(pedidoId))?.pagado_cents).toBe(0);

    // Los libros no se editan ni se borran: el asiento del cobro sigue ahí y el
    // 14 se le suma. Si esto llegara a ser un reemplazo, el mes cuadraría pero
    // la historia del pedido no se podría reconstruir.
    const despues = await asientosDelPago(pagoId);
    expect(despues).toContain("14");
    for (const hecho of antes) expect(despues, `desapareció el asiento ${hecho}`).toContain(hecho);
    expect(despues.length).toBe(antes.length + 1);
  });

  it("no deja volver más dinero del que entró, y lo dice con las cifras", async () => {
    const { pedidoId, pagoId } = await conAbonoConfirmado(2000);
    await expect(
      reembolso.ejecutar(ctx(), {
        pago_id: pagoId,
        monto_cents: 5000,
        motivo: "a ver si cuela",
      }),
    ).rejects.toThrow(/no pueden volver/);
    expect((await elPedido(pedidoId))?.pagado_cents, "salió dinero que no entró").toBe(2000);
  });

  it("un pago que no existe se dice así, no como un fallo interno", async () => {
    await expect(
      reembolso.ejecutar(ctx(), {
        pago_id: "no-existe-este-pago",
        monto_cents: 100,
        motivo: "equivocación",
      }),
    ).rejects.toThrow(/no existe ese pago/);
  });
});

describe("registrar_contracargo", () => {
  it("escribe el asiento 15, que no es el del reembolso", async () => {
    // Son dos hechos distintos y es lo que los separa: un reembolso lo decide
    // la dueña y va contra anticipos o contra la venta; un contracargo lo decide
    // el banco de la clienta y siempre deshace una venta que ya entró.
    const { pedidoId, pagoId } = await conAbonoConfirmado(2500);

    const r = await contracargo.ejecutar(ctx(), {
      pago_id: pagoId,
      monto_cents: 2500,
      motivo: "la clienta desconoció el cargo, disputa abierta",
      proveedor_ref: "DISPUTA-9",
    });

    expect(r).toMatchObject({ se_llevaron_cents: 2500, pagado_cents: 0 });
    expect(await asientosDelPago(pagoId)).toContain("15");
    expect((await elPedido(pedidoId))?.pagado_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5 · Por la puerta de verdad: nada de esto se hace sin que una persona lo
//     permita, y todo esto existe en el catálogo
// ---------------------------------------------------------------------------

describe("lo que mueve dinero pasa por «Permitir»", () => {
  it("las cinco que escriben están en el catálogo, son sensibles y solo de la dueña", async () => {
    // TRAMPAS §12: una pieza terminada que nadie llama. Si no salen de
    // `catalogo()`, el servidor de MCP no las enseña y estas pruebas pasarían
    // igual, vigilando un archivo que nadie importa.
    const nombres = [
      "ver_pasarelas",
      "encender_pasarela",
      "apagar_pasarela",
      "cambiar_modo_de_pasarela",
      "registrar_reembolso",
      "registrar_contracargo",
    ];
    for (const nombre of nombres) {
      const h = registro.buscar(nombre);
      expect(h, `«${nombre}» no está en el catálogo: por MCP no existe`).toBeDefined();
      expect(h?.roles).toEqual(["duena"]);
      expect(h?.nivel, nombre).toBe(nombre === "ver_pasarelas" ? "lectura" : "sensible");
    }
    // Y se enseñan de verdad a la dueña, que es lo que ve el cliente de MCP.
    const definidas = registro.definicionesPara("duena").map((d) => d.name);
    for (const nombre of nombres) expect(definidas).toContain(nombre);
  });

  it("un reembolso pedido por MCP queda esperando, y el dinero no se mueve", async () => {
    const { pedidoId, pagoId } = await conAbonoConfirmado(3000);

    const r = await pedir("registrar_reembolso", {
      pago_id: pagoId,
      monto_cents: 3000,
      motivo: "la clienta lo pidió por el chat",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("por_confirmar");
    // El resumen es lo que la persona lee antes de decir sí: los centavos van
    // en dólares porque nadie confirma «3000» a ojo.
    if (r.datos.clase === "por_confirmar") expect(r.datos.resumen).toContain("$30.00");

    expect((await elPedido(pedidoId))?.pagado_cents, "el dinero se movió sin permiso").toBe(3000);
    expect(await asientosDelPago(pagoId), "se escribió el asiento 14 sin permiso").not.toContain(
      "14",
    );

    // Y al permitirlo, ocurre: es la otra mitad de la prueba. Sin esta parte,
    // una herramienta que no funcionara en absoluto pasaría por «segura».
    const hecho = await confirmar(quien(), registro, r.datos.accionId, "permitir");
    expect(hecho.ok, hecho.ok ? "" : hecho.mensaje).toBe(true);
    expect((await elPedido(pedidoId))?.pagado_cents).toBe(0);
    expect(await asientosDelPago(pagoId)).toContain("14");
  });

  it("encender una pasarela por MCP también espera, y el checkout no se enciende", async () => {
    await conCredencialesDeYappy("prueba");

    const r = await pedir("encender_pasarela", {
      pasarela: "yappy",
      motivo: "ya se hizo el cobro de prueba",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("se ejecutó sin permiso");
    expect(await encendidas(), "se encendió sin permiso").toEqual([]);

    const hecho = await confirmar(quien(), registro, r.datos.accionId, "permitir");
    expect(hecho.ok, hecho.ok ? "" : hecho.mensaje).toBe(true);
    expect(await encendidas()).toEqual(["yappy"]);
  });

  it("y rechazar deja la pasarela apagada y la acción cerrada", async () => {
    await conCredencialesDeYappy("prueba");
    const r = await pedir("encender_pasarela", { pasarela: "yappy", motivo: "mejor no" });
    if (!r.ok || r.datos.clase !== "por_confirmar") throw new Error("se ejecutó sin permiso");

    const no = await confirmar(quien(), registro, r.datos.accionId, "rechazar");
    expect(no.ok).toBe(true);
    expect(await encendidas()).toEqual([]);

    const fila = await env.DB.prepare("SELECT estado FROM acciones WHERE id = ?")
      .bind(r.datos.accionId)
      .first<{ estado: string }>();
    expect(fila?.estado).toBe("rechazada");
  });

  it("ver_pasarelas, en cambio, contesta directo: mirar no cambia nada", async () => {
    const r = await pedir("ver_pasarelas", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("hecha");
  });

  it("y quien despacha no puede ni mirar las pasarelas", async () => {
    // `ajustes` y `cobros` están en «no» para la asistente en la matriz de
    // roles. La herramienta no decide esto: lo decide la lista de `roles`, que
    // es la misma tabla que usa la ruta del panel.
    const r = await ejecutar(
      { db: env.DB, usuario: { id: "u-asis-dinero", correo: "a@b.com", rol: "asistente" }, ahora: ahora() },
      registro,
      {
        nombre: "ver_pasarelas",
        argumentos: {},
        canal: "mcp",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");
  });
});
