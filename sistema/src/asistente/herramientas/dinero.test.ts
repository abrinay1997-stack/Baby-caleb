import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmar, ejecutar } from "../ejecutar";
import { catalogo } from "../index";
import { decidir } from "../politica";
import { referenciaDe, revisar } from "../referencias";
import type { Contexto } from "../registro";
import { ROLES_DE_PANEL, puedeEditar, puedeVer, type Rol } from "../../seguridad/roles";
import { crearPedidoDeLaClienta } from "./pedidos";
import {
  avisoDelResumen,
  confirmarAbono,
  pagosPorConfirmar,
  rechazarCobro,
  registrarCobro,
  resumenDelDia,
} from "./dinero";

/**
 * El dinero por la puerta del asistente, contra una D1 de verdad.
 *
 * La regla que se vigila por encima de todo es la del proyecto: **el navegador
 * no decide un pago**, y tampoco el modelo. Un comprobante anotado NO suma
 * nada; sumarlo es una acción sensible que una persona permite.
 *
 * Y la segunda: nada de una clienta sale hacia el modelo (D-20). En la bandeja
 * de comprobantes, cada uno dice de qué pedido es y de qué referencia, nunca de
 * quién.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

/** Distintivo a propósito: ver la nota de `pedidos.test.ts` sobre «Ana». */
const NOMBRE = "Yaritza Esquivel";

const ctx = (rol: Rol = "duena"): Contexto => ({
  db: env.DB,
  usuario: { id: "u-duena", correo: "duena@babycaleb.com", rol },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

let clienteId: string;
let referencia: string;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-duena','duena@babycaleb.com','Yarielis','duena',1,?)",
    ).bind(ahora()),
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 60 WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ),
    // Un movimiento de inventario, para que el resumen tenga inventario DEL
    // QUE HABLAR. Sin él, `leerInventario` contesta `cargado: false` y la rama
    // con la lista de artículos —la que trae el nombre de la bodega y no debe
    // salir— no se ejecuta nunca: la prueba que la vigila pasaría sin mirar
    // nada. Se midió, y así fue (TRAMPAS §6: la mutación sobrevivió porque
    // había otra capa delante).
    env.DB.prepare(
      `INSERT OR IGNORE INTO movimientos_inventario
         (id,codigo,bodega_id,delta,tipo,referencia_tipo,referencia_id,motivo,actor,creado_en)
       VALUES ('mv-dinero-test','NAT-M','bod-1',60,'compra','compra','co-1',NULL,'pruebas',?)`,
    ).bind(ahora()),
  ]);

  clienteId = id("cli");
  await env.DB.prepare(
    "INSERT INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
  )
    .bind(clienteId, NOMBRE, `507${String(60002000 + n)}`, ahora(), ahora())
    .run();
  referencia = await referenciaDe(env.DB, clienteId);
});

/** Un pedido con su total, tomado por la misma puerta. */
async function unPedido(cantidad = 1) {
  return (await crearPedidoDeLaClienta.ejecutar(ctx(), {
    clienta: referencia,
    lineas: [{ codigo: "NAT-M", cantidad }],
    motivo: "prueba",
  })) as { pedidoId: string; numero: string; totalCents: number };
}

/** Un comprobante anotado por la herramienta, esperando que alguien lo mire. */
async function unComprobante(pedidoId: string, montoCents: number) {
  return (await registrarCobro.ejecutar(ctx(), {
    pedidoId,
    monto_cents: montoCents,
    metodo: "yappy",
    tipo: "abono",
    motivo: "mandó la captura por WhatsApp",
  })) as { pago: string; estado: string; sumaAlPedido: boolean };
}

const estadoDe = (pedidoId: string) =>
  env.DB.prepare("SELECT estado, estado_pago, pagado_cents FROM pedidos WHERE id = ?")
    .bind(pedidoId)
    .first<{ estado: string; estado_pago: string; pagado_cents: number }>();

const pago = (pagoId: string) =>
  env.DB.prepare("SELECT estado, confirmado_por FROM pagos WHERE id = ?")
    .bind(pagoId)
    .first<{ estado: string; confirmado_por: string | null }>();

// ---------------------------------------------------------------------------
// D-20
// ---------------------------------------------------------------------------

describe("ningún resultado lleva datos de una clienta (D-20)", () => {
  async function nombres(): Promise<string[]> {
    const { results } = await env.DB.prepare(
      "SELECT nombre FROM clientes WHERE nombre IS NOT NULL",
    ).all<{ nombre: string }>();
    return results.map((c) => c.nombre);
  }

  const limpio = async (quien: string, salida: unknown) => {
    const fugas = revisar(salida, await nombres());
    expect(fugas, `«${quien}» filtra: ${JSON.stringify(fugas)}`).toEqual([]);
  };

  it("las cinco, una por una, con una clienta de verdad delante", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);

    await limpio("registrar_cobro", c);
    await limpio("pagos_por_confirmar", await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 25 }));
    await limpio("resumen_del_dia", await resumenDelDia.ejecutar(ctx(), {}));
    await limpio("resumen_del_dia (semana)", await resumenDelDia.ejecutar(ctx(), { periodo: "semana" }));
    await limpio(
      "confirmar_abono",
      await confirmarAbono.ejecutar(ctx(), { pago: c.pago, motivo: "la captura cuadra" }),
    );

    const otro = await unComprobante(p.pedidoId, 700);
    await limpio(
      "rechazar_cobro",
      await rechazarCobro.ejecutar(ctx(), { pago: otro.pago, motivo: "es de otro pedido" }),
    );
  });

  it("y la guarda sabría reconocerlo si un día saliera", () => {
    // El contrapeso: sin esto, lo de arriba pasaría aunque `revisar()` no
    // encontrara nunca nada.
    expect(revisar({ comprobantes: [{ cliente: NOMBRE }] }, [NOMBRE])).not.toEqual([]);
    expect(revisar({ comprobante_url: "r2://capturas/abc.jpg" })).not.toEqual([]);
    expect(revisar({ comprobantes: [{ clienta: "C-0042", montoCents: 500 }] }, [NOMBRE])).toEqual([]);
  });

  it("la bandeja dice la referencia y no el nombre, y de la captura solo si hay", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);
    await env.DB.prepare("UPDATE pagos SET comprobante_r2 = ? WHERE id = ?")
      .bind("capturas/2026/abc.jpg", c.pago)
      .run();

    const r = (await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 25 })) as {
      comprobantes: Record<string, unknown>[];
    };
    const mio = r.comprobantes.find((x) => x["pago"] === c.pago);
    expect(mio?.["clienta"]).toBe(referencia);
    expect(mio?.["tieneCaptura"]).toBe(true);
    // La clave de R2 apunta a una imagen de una clienta: no sale.
    expect(JSON.stringify(r)).not.toContain("capturas/2026");
    expect(JSON.stringify(r)).not.toContain(NOMBRE);
  });

  it("el resumen no dice «semana» ni nombra bodegas", async () => {
    // Las dos cosas son por lo mismo: `revisar()` caza los nombres de las
    // clientas por subcadena, y tanto «semana» como «Bodega Ciudad de Panamá»
    // llevan «ana» dentro. Con una clienta llamada Ana, cualquiera de las dos
    // haría que se descartara el resumen entero.
    const r = await resumenDelDia.ejecutar(ctx(), { periodo: "semana" });
    const texto = JSON.stringify(r);
    expect(texto).not.toContain("semana");
    expect(texto).not.toContain("Bodega");
    // Y la ventana se dice igual de clara, por fechas.
    expect(r).toMatchObject({ desde: expect.any(String), hasta: expect.any(String) });
    expect(revisar(r, ["Ana"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe("los roles son los del permiso de su ruta, sin ensanchar", () => {
  it("el dinero es de quien tiene «cobros», que hoy es solo la dueña", () => {
    const conCobros = ROLES_DE_PANEL.filter((r) => puedeVer(r, "cobros"));
    expect(conCobros).toEqual(["duena"]);
    for (const h of [pagosPorConfirmar, registrarCobro, confirmarAbono, rechazarCobro]) {
      expect([...h.roles], h.nombre).toEqual(["duena"]);
    }
    // La asistente lleva pedidos y gastos y NO ve lo que entró. Es el caso que
    // esto existe para cumplir.
    expect(puedeVer("asistente", "cobros")).toBe(false);
    expect(puedeEditar("contadora", "cobros")).toBe(false);
  });

  it("la portada la ve todo el mundo, igual que la ruta", () => {
    // `GET /resumen` no lleva `exige(...)`: es lo primero que se abre y un 403
    // ahí deja el panel sin portada. Los permisos se aplican DENTRO.
    expect([...resumenDelDia.roles].sort()).toEqual([...ROLES_DE_PANEL].sort());
  });

  it("todo lo que toca el dinero se PROPONE, no se ejecuta", () => {
    for (const h of [registrarCobro, confirmarAbono, rechazarCobro]) {
      expect(decidir(h, "duena"), h.nombre).toMatchObject({
        clase: "confirmar",
        porque: "nivel_sensible",
      });
    }
    // Y leer la bandeja es directo.
    expect(decidir(pagosPorConfirmar, "duena").clase).toBe("ejecutar");
    expect(decidir(pagosPorConfirmar, "asistente").clase).toBe("bloquear");
  });
});

// ---------------------------------------------------------------------------
// El navegador no decide un pago
// ---------------------------------------------------------------------------

describe("registrar_cobro", () => {
  it("deja el pago en «confirmando» y el pedido NO se mueve", async () => {
    const p = await unPedido();
    const r = await unComprobante(p.pedidoId, 500);

    expect(r.estado).toBe("confirmando");
    // Dicho en voz alta para que el modelo no conteste «ya quedó pagado».
    expect(r.sumaAlPedido).toBe(false);

    const e = await estadoDe(p.pedidoId);
    expect(e?.pagado_cents).toBe(0);
    expect(e?.estado).toBe("por_abonar");
  });

  it("anotar dos veces el mismo cobro escribe UN comprobante", async () => {
    // Aquí la llave de idempotencia SÍ cierra: `pagos.intento_ref` es UNIQUE.
    // Sin ella, dos clics del mismo botón escriben dos comprobantes por el
    // mismo dinero.
    const p = await unPedido();
    await unComprobante(p.pedidoId, 500);
    await expect(unComprobante(p.pedidoId, 500)).rejects.toThrow();

    const cuantos = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM pagos WHERE pedido_id = ?",
    )
      .bind(p.pedidoId)
      .first<{ c: number }>();
    expect(cuantos?.c).toBe(1);
  });

  /** Una petición válida, para cambiarle una cosa cada vez. */
  const bien = {
    pedidoId: "p1",
    monto_cents: 500,
    metodo: "yappy",
    tipo: "abono",
    motivo: "mandó la captura",
  };

  it("un monto que no es un entero positivo no entra", () => {
    // Y la base está de acuerdo: `monto_cents INTEGER NOT NULL CHECK (> 0)`.
    expect(registrarCobro.parametros.safeParse(bien).success).toBe(true);
    for (const monto_cents of [0, -500, 12.5]) {
      expect(
        registrarCobro.parametros.safeParse({ ...bien, monto_cents }).success,
        String(monto_cents),
      ).toBe(false);
    }
  });

  it("un método que no es manual no existe en el esquema", () => {
    // No se comprueba en el cuerpo: no se puede ni escribir. Los métodos salen
    // de `METODOS_MANUALES`, que es quien los define.
    expect(registrarCobro.parametros.safeParse({ ...bien, metodo: "tilopay" }).success).toBe(false);
    for (const metodo of ["yappy", "transferencia", "efectivo"]) {
      expect(registrarCobro.parametros.safeParse({ ...bien, metodo }).success, metodo).toBe(true);
    }
  });

  it("un tipo que no es abono, total o saldo tampoco", () => {
    expect(registrarCobro.parametros.safeParse({ ...bien, tipo: "adelanto" }).success).toBe(false);
    for (const tipo of ["abono", "total", "saldo"]) {
      expect(registrarCobro.parametros.safeParse({ ...bien, tipo }).success, tipo).toBe(true);
    }
  });

  it("sin motivo, o con un motivo de una letra, no entra", () => {
    const { motivo, ...sinMotivo } = bien;
    expect(motivo).toBeTruthy();
    expect(registrarCobro.parametros.safeParse(sinMotivo).success).toBe(false);
    expect(registrarCobro.parametros.safeParse({ ...bien, motivo: "x" }).success).toBe(false);
  });

  it("no se puede subir una captura desde aquí", () => {
    // Subir una imagen es del panel, y mirarla es lo que hace que confirmar
    // signifique algo. El esquema no tiene dónde escribirla, y
    // `additionalProperties: false` más el `safeParse` la dejan fuera: no llega
    // a `registrarComprobante` ni colándola en los argumentos.
    const conCaptura = registrarCobro.parametros.safeParse({
      ...bien,
      comprobanteR2: "capturas/abc.jpg",
    });
    expect(conCaptura.success).toBe(true);
    expect(conCaptura.success && Object.keys(conCaptura.data)).not.toContain("comprobanteR2");
  });
});

describe("confirmar_abono", () => {
  it("aquí entra el dinero, y agenda si ya alcanza", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, p.totalCents);

    const r = (await confirmarAbono.ejecutar(ctx(), {
      pago: c.pago,
      motivo: "la captura cuadra con el monto y la fecha",
    })) as { confirmado: boolean; pagadoCents: number; agendado: boolean };

    expect(r.confirmado).toBe(true);
    expect(r.pagadoCents).toBe(p.totalCents);
    expect(r.agendado).toBe(true);

    const e = await estadoDe(p.pedidoId);
    expect(e?.pagado_cents).toBe(p.totalCents);
    expect(e?.estado).toBe("agendado");
  });

  it("un abono que no alcanza suma pero no agenda", async () => {
    const p = await unPedido(4);
    const c = await unComprobante(p.pedidoId, 100);

    const r = (await confirmarAbono.ejecutar(ctx(), {
      pago: c.pago,
      motivo: "abonó una parte",
    })) as { agendado: boolean; pagadoCents: number };

    expect(r.pagadoCents).toBe(100);
    expect(r.agendado).toBe(false);
    expect((await estadoDe(p.pedidoId))?.estado).toBe("por_abonar");
  });

  it("confirmar dos veces no cobra dos veces", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);
    await confirmarAbono.ejecutar(ctx(), { pago: c.pago, motivo: "cuadra" });

    await expect(
      confirmarAbono.ejecutar(ctx(), { pago: c.pago, motivo: "otra vez" }),
    ).rejects.toThrow();
    expect((await estadoDe(p.pedidoId))?.pagado_cents).toBe(500);
  });

  it("un pago que no está se dice, no se inventa", async () => {
    await expect(
      confirmarAbono.ejecutar(ctx(), { pago: "01NOEXISTE", motivo: "prueba" }),
    ).rejects.toThrow();
  });
});

describe("rechazar_cobro", () => {
  it("marca el rechazo con su motivo y NO borra nada", async () => {
    // Un comprobante rechazado es parte de lo que pasó con ese pedido:
    // borrarlo deja a quien lo mire mañana sin saber por qué la clienta insiste
    // en que ya pagó.
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);

    const r = (await rechazarCobro.ejecutar(ctx(), {
      pago: c.pago,
      motivo: "la captura es de otro pedido",
    })) as { rechazado: boolean; seBorro: boolean };

    expect(r.rechazado).toBe(true);
    expect(r.seBorro).toBe(false);

    const fila = await pago(c.pago);
    expect(fila?.estado).toBe("rechazado");
    expect(fila?.confirmado_por).toBe("duena@babycaleb.com");
    expect((await estadoDe(p.pedidoId))?.pagado_cents).toBe(0);

    // Y el motivo queda escrito en el expediente del pedido, que es donde lo
    // va a buscar quien mañana atienda a la clienta que insiste.
    const evento = await env.DB.prepare(
      "SELECT datos_json FROM pedido_eventos WHERE pedido_id = ? AND tipo = 'pago_rechazado'",
    )
      .bind(p.pedidoId)
      .first<{ datos_json: string }>();
    expect(evento?.datos_json).toContain("la captura es de otro pedido");
  });

  it("sin motivo no se puede ni pedir", () => {
    expect(rechazarCobro.parametros.safeParse({ pago: "p1" }).success).toBe(false);
    // Tres letras es el mínimo del esquema; el de solo espacios lo corta
    // `rechazarPago`, que es quien escribe la fila.
    expect(rechazarCobro.parametros.safeParse({ pago: "p1", motivo: "no" }).success).toBe(false);
    expect(rechazarCobro.parametros.safeParse({ pago: "p1", motivo: "   " }).success).toBe(true);
  });

  it("y un motivo en blanco lo corta quien escribe la fila", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);
    await expect(rechazarCobro.ejecutar(ctx(), { pago: c.pago, motivo: "   " })).rejects.toThrow();
    expect((await pago(c.pago))?.estado).toBe("confirmando");
  });

  it("un pago ya confirmado no se rechaza", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);
    await confirmarAbono.ejecutar(ctx(), { pago: c.pago, motivo: "cuadra" });

    await expect(
      rechazarCobro.ejecutar(ctx(), { pago: c.pago, motivo: "me equivoqué" }),
    ).rejects.toThrow();
  });
});

describe("pagos_por_confirmar", () => {
  it("trae el saldo hecho, no para que el modelo lo reste", async () => {
    const p = await unPedido(2);
    const c = await unComprobante(p.pedidoId, 300);

    const r = (await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 25 })) as {
      comprobantes: Record<string, unknown>[];
      aviso: string | null;
    };
    const mio = r.comprobantes.find((x) => x["pago"] === c.pago);

    expect(mio?.["totalCents"]).toBe(p.totalCents);
    expect(mio?.["pagadoCents"]).toBe(0);
    expect(mio?.["saldoCents"]).toBe(p.totalCents);
    expect(mio?.["monto"]).toBe("$3.00");
    // Y recuerda que confirmar pide MIRAR la captura, que es del panel.
    expect(r.aviso).toMatch(/panel/);
  });

  it("solo salen los que esperan: lo confirmado se va de la bandeja", async () => {
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, 500);
    await confirmarAbono.ejecutar(ctx(), { pago: c.pago, motivo: "cuadra" });

    const r = (await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 25 })) as {
      comprobantes: { pago: string }[];
    };
    expect(r.comprobantes.map((x) => x.pago)).not.toContain(c.pago);
  });

  it("la bandeja vacía se explica", async () => {
    // Las pruebas de un archivo comparten base, así que para ver la bandeja
    // vacía hay que vaciarla — y se vacía POR LA PUERTA DE VERDAD, rechazando
    // uno a uno, no con un UPDATE: los libros no se editan.
    const pendientes = (await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 100 })) as {
      comprobantes: { pago: string }[];
    };
    for (const c of pendientes.comprobantes) {
      await rechazarCobro.ejecutar(ctx(), { pago: c.pago, motivo: "limpieza de la prueba" });
    }

    const r = (await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 25 })) as {
      cuantos: number;
      aviso: string;
    };
    expect(r.cuantos).toBe(0);
    expect(r.aviso).toMatch(/al día/);
  });

  it("el límite se respeta de verdad", async () => {
    // TRAMPAS §9: un parámetro se prueba PASÁNDOLO.
    const p = await unPedido(3);
    await unComprobante(p.pedidoId, 100);
    await unComprobante(p.pedidoId, 200);

    const r = (await pagosPorConfirmar.ejecutar(ctx(), { cuantos: 1 })) as {
      cuantos: number;
      hayMas: boolean;
    };
    expect(r.cuantos).toBe(1);
    expect(r.hayMas).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La portada
// ---------------------------------------------------------------------------

describe("resumen_del_dia", () => {
  it("cuenta lo que espera a una persona", async () => {
    // Se mide el ANTES y el DESPUÉS, no el valor absoluto: las pruebas de un
    // archivo comparten base, y un número fijo aquí se rompería solo en cuanto
    // alguien añadiera una prueba más arriba.
    const leer = async () =>
      (await resumenDelDia.ejecutar(ctx(), {})) as {
        atencion: { pedidosEnTotal: number; porAbonar: number; pagosPorRevisar: number } | null;
        dinero: unknown | null;
        aviso: string | null;
      };

    const antes = await leer();
    const p = await unPedido();
    await unComprobante(p.pedidoId, 500);
    const ahoraSi = await leer();

    expect(ahoraSi.atencion?.pedidosEnTotal).toBe((antes.atencion?.pedidosEnTotal ?? 0) + 1);
    expect(ahoraSi.atencion?.porAbonar).toBe((antes.atencion?.porAbonar ?? 0) + 1);
    expect(ahoraSi.atencion?.pagosPorRevisar).toBe((antes.atencion?.pagosPorRevisar ?? 0) + 1);
    expect(ahoraSi.dinero).not.toBeNull();

    // Con pedidos, inventario cargado y la dueña mirando, no hay nada que
    // avisar: el aviso se calla.
    expect(ahoraSi.aviso).toBeNull();
  });

  it("a quien no ve dinero no se le consulta el dinero, y se le dice", async () => {
    await unPedido();
    const r = (await resumenDelDia.ejecutar(ctx("asistente"), {})) as {
      dinero: unknown | null;
      aviso: string | null;
    };
    expect(r.dinero).toBeNull();
    expect(r.aviso).toMatch(/no ve el dinero/);
  });

  it("con la base recién estrenada dice «nada todavía», no «nada pendiente»", () => {
    // Un cero es una afirmación (TRAMPAS §7). Aquí los ceros significan que no
    // hay nada anotado, y las dos cosas se leen igual si nadie lo dice.
    //
    // Se prueba la función directamente: por la herramienta, esta rama solo
    // existe mientras no haya ningún pedido en la base, y las pruebas de este
    // archivo crean varios. Una rama que solo se puede alcanzar siendo la
    // primera prueba del archivo es una rama que mañana nadie vigila.
    const conNada = avisoDelResumen(
      { atencion: { pedidosEnTotal: 0 }, inventario: { cargado: true }, dinero: {} },
      null,
    );
    expect(conNada).toMatch(/nada todavía/);
    expect(conNada).not.toMatch(/nada pendiente"/);

    // Con pedidos y todo cargado, se calla: si avisara siempre, la prueba de
    // arriba pasaría vigilando nada.
    expect(
      avisoDelResumen(
        { atencion: { pedidosEnTotal: 3 }, inventario: { cargado: true }, dinero: {} },
        null,
      ),
    ).toBeNull();
  });

  it("y dice cada hueco por su nombre, no todos igual", () => {
    // Cuatro motivos distintos para un bloque en blanco, y los cuatro llevan a
    // cosas distintas: esperar, configurar, o pedirle a la dueña el permiso.
    const sinRol = avisoDelResumen({ atencion: null, inventario: null, dinero: null }, null);
    expect(sinRol).toMatch(/no ve la operación/);
    expect(sinRol).toMatch(/no ve el inventario/);
    expect(sinRol).toMatch(/no ve el dinero/);

    expect(
      avisoDelResumen(
        { atencion: { pedidosEnTotal: 1 }, inventario: { cargado: false }, dinero: {} },
        null,
      ),
    ).toMatch(/ningún movimiento registrado/);

    expect(
      avisoDelResumen(
        { atencion: { pedidosEnTotal: 1 }, inventario: { cargado: true }, dinero: {} },
        "trimestre",
      ),
    ).toMatch(/«trimestre»/);
  });

  it("un periodo que no se entiende cae en hoy y lo confiesa", async () => {
    // La ruta hace lo mismo —esta pantalla tiene que abrir siempre— pero
    // callándoselo. Callárselo a un modelo es dejarle contestar de la semana
    // con las cifras de hoy.
    const r = (await resumenDelDia.ejecutar(ctx(), { periodo: "trimestre" })) as {
      dias: number;
      aviso: string;
    };
    expect(r.dias).toBe(1);
    expect(r.aviso).toContain("trimestre");
  });

  it("del inventario salen las cuentas, no la lista de artículos", async () => {
    // Para mirar artículo por artículo está `ver_stock`, que es su
    // herramienta. Y la lista trae el nombre de la bodega, que no debe salir.
    const r = (await resumenDelDia.ejecutar(ctx(), {})) as {
      inventario: Record<string, unknown> | null;
    };
    // Lo primero: que el inventario esté CARGADO. Si no, `leerInventario`
    // devuelve la variante que ni tiene lista y esta prueba no vigilaría nada.
    expect(r.inventario?.["cargado"]).toBe(true);
    expect(Object.keys(r.inventario ?? {})).not.toContain("lista");
    expect(r.inventario).toHaveProperty("filas");
    expect(r.inventario).toHaveProperty("agotadas");
    // Y la lista existe de verdad del otro lado: lo que se comprueba es que se
    // dejó fuera, no que no hubiera nada que dejar.
    const { results } = await env.DB.prepare(
      "SELECT b.nombre FROM existencias e JOIN bodegas b ON b.id = e.bodega_id LIMIT 1",
    ).all<{ nombre: string }>();
    expect(results[0]?.nombre).toContain("Bodega");
  });
});

// ---------------------------------------------------------------------------
// Por donde entra la persona
// ---------------------------------------------------------------------------

describe("por la puerta de verdad (ejecutar + confirmar)", () => {
  it("el dinero no entra hasta que una persona lo permite", async () => {
    const registro = catalogo();
    const p = await unPedido();
    const c = await unComprobante(p.pedidoId, p.totalCents);

    const propuesta = await ejecutar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      registro,
      {
        nombre: "confirmar_abono",
        argumentos: { pago: c.pago, motivo: "la captura cuadra" },
        canal: "mcp",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );

    expect(propuesta.ok).toBe(true);
    if (!propuesta.ok || propuesta.datos.clase !== "por_confirmar") {
      throw new Error("confirmar_abono se ejecutó sin permiso de nadie");
    }

    // Nada ha entrado todavía.
    expect((await estadoDe(p.pedidoId))?.pagado_cents).toBe(0);
    expect(propuesta.datos.resumen).toContain("confirmar abono");

    const hecho = await confirmar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      registro,
      propuesta.datos.accionId,
      "permitir",
    );
    expect(hecho.ok).toBe(true);
    expect((await estadoDe(p.pedidoId))?.pagado_cents).toBe(p.totalCents);
  });

  it("el resumen que lee la persona lleva el monto en dólares", async () => {
    // «¿Permite registrar_cobro?» no es una pregunta que nadie pueda contestar
    // bien; «cobrar $30.00 del pedido tal» sí. Y nadie confirma «3000» a ojo.
    const registro = catalogo();
    const p = await unPedido();

    const propuesta = await ejecutar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      registro,
      {
        nombre: "registrar_cobro",
        argumentos: {
          pedidoId: p.pedidoId,
          monto_cents: 3000,
          metodo: "yappy",
          tipo: "abono",
          motivo: "mandó la captura",
        },
        canal: "panel",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );
    if (!propuesta.ok || propuesta.datos.clase !== "por_confirmar") {
      throw new Error("registrar_cobro se ejecutó sin permiso de nadie");
    }
    expect(propuesta.datos.resumen).toContain("$30.00");
    expect(propuesta.datos.resumen).toContain("mandó la captura");
  });

  it("todas están registradas en el catálogo", () => {
    const nombres = catalogo()
      .todas()
      .map((h) => h.nombre);
    for (const h of [pagosPorConfirmar, registrarCobro, confirmarAbono, rechazarCobro, resumenDelDia]) {
      expect(nombres, h.nombre).toContain(h.nombre);
    }
  });
});
