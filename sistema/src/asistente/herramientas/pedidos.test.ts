import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmar, ejecutar } from "../ejecutar";
import { catalogo } from "../index";
import { decidir } from "../politica";
import { referenciaDe, revisar } from "../referencias";
import type { Contexto } from "../registro";
import { ROLES_DE_PANEL, puedeEditar, puedeVer, type Rol } from "../../seguridad/roles";
import {
  agendarPedido,
  anularPedido,
  buscarCliente,
  buscarPedido,
  crearPedidoDeLaClienta,
  darDeAltaClienta,
  historialDeCliente,
  quienMira,
  verPedido,
} from "./pedidos";

/**
 * Pedidos y clientas por la puerta del asistente, contra una D1 de verdad.
 *
 * Lo que se vigila aquí, en este orden de importancia:
 *
 *  1. **Que no salga nada de una clienta** (D-20). Cada herramienta se ejecuta
 *     y su resultado pasa por `revisar()` con los nombres que hay en la base,
 *     que es la guarda de verdad: si se cuela un nombre o un celular,
 *     `conversar.ts` y el servidor MCP descartan el resultado entero y la
 *     herramienta deja de servir para nada.
 *  2. **Que los roles sean los de la ruta del panel**, calculados desde
 *     `roles.ts` y no copiados a mano: así, el día que la matriz cambie, esto
 *     se pone rojo en vez de quedarse mintiendo.
 *  3. **Que lo sensible no se ejecute solo.** `crear_pedido` aparta mercancía,
 *     y la prueba que importa es la que entra por donde entra la persona
 *     —`ejecutar` y `confirmar`— y no por `.ejecutar()` a pelo.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

/**
 * Un nombre que no es subcadena de ninguna palabra corriente.
 *
 * No es coquetería: `revisar()` caza los nombres por subcadena, así que con una
 * clienta llamada «Ana» cualquier resultado que dijera «mañana» o «Panamá»
 * daría positivo y estas pruebas se pondrían rojas por el nombre de la prueba y
 * no por un fallo. Con uno distintivo, un positivo es un positivo de verdad.
 */
const NOMBRE = "Yaritza Esquivel";
const CELULAR = "6000-1234";

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
  // Los usuarios NO se borran: `acciones.usuario_id` los referencia y la
  // bitácora no se puede borrar —el trigger lo prohíbe—.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-duena','duena@babycaleb.com','Yarielis','duena',1,?)",
    ).bind(ahora()),
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 40 WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ),
  ]);

  clienteId = id("cli");
  await env.DB.prepare(
    "INSERT INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
  )
    .bind(clienteId, NOMBRE, `507${String(60001234 + n)}`, ahora(), ahora())
    .run();
  referencia = await referenciaDe(env.DB, clienteId);
});

/** Un pedido hecho por la puerta del asistente, ya confirmado. */
async function unPedido(cantidad = 1) {
  const r = (await crearPedidoDeLaClienta.ejecutar(ctx(), {
    clienta: referencia,
    lineas: [{ codigo: "NAT-M", cantidad }],
    motivo: "prueba",
  })) as { pedidoId: string; numero: string; totalCents: number };
  return r;
}

const estadoDe = (pedidoId: string) =>
  env.DB.prepare("SELECT estado, estado_pago, pagado_cents FROM pedidos WHERE id = ?")
    .bind(pedidoId)
    .first<{ estado: string; estado_pago: string; pagado_cents: number }>();

const reservadoDeNatM = async (): Promise<number | undefined> =>
  (
    await env.DB.prepare(
      "SELECT reservado FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ reservado: number }>()
  )?.reservado;

// ---------------------------------------------------------------------------
// D-20: nada de una clienta sale hacia el modelo
// ---------------------------------------------------------------------------

describe("ningún resultado lleva datos de una clienta (D-20)", () => {
  /** Los nombres que hay en la base ahora mismo, que es lo que mira la guarda. */
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

  it("las ocho, una por una, con una clienta de verdad delante", async () => {
    // Una clienta con nombre y celular, un pedido suyo con nota, y las ocho
    // herramientas ejecutadas de verdad. Es la prueba que pide el encargo: una
    // por herramienta, no una genérica.
    const p = await unPedido();
    await env.DB.prepare("UPDATE pedidos SET notas_cliente = ? WHERE id = ?")
      .bind("dejarlo con el portero", p.pedidoId)
      .run();

    await limpio("buscar_pedido", await buscarPedido.ejecutar(ctx(), { cuantos: 20 }));
    await limpio(
      "buscar_pedido (por clienta)",
      await buscarPedido.ejecutar(ctx(), { clienta: referencia, cuantos: 20 }),
    );
    await limpio("ver_pedido", await verPedido.ejecutar(ctx(), { pedido: p.numero }));
    await limpio("buscar_cliente", await buscarCliente.ejecutar(ctx(), { texto: NOMBRE, cuantos: 10 }));
    await limpio(
      "historial_de_cliente",
      await historialDeCliente.ejecutar(ctx(), { clienta: referencia }),
    );
    await limpio(
      "dar_de_alta_clienta",
      await darDeAltaClienta.ejecutar(ctx(), {
        nombre: "Zoraida Pimentel",
        celular: "6000-9876",
        motivo: "prueba",
      }),
    );
    await limpio(
      "crear_pedido",
      await crearPedidoDeLaClienta.ejecutar(ctx(), {
        clienta: referencia,
        lineas: [{ codigo: "NAT-M", cantidad: 3 }],
        motivo: "prueba",
      }),
    );
    await limpio("agendar_pedido (el error también)", await seQueja(() => agendarPedido.ejecutar(ctx(), { pedido: p.numero, motivo: "prueba" })));
    await limpio(
      "anular_pedido",
      await anularPedido.ejecutar(ctx(), { pedido: p.numero, motivo: "la clienta ya no lo quiere" }),
    );
  });

  it("y la guarda sabría reconocerlo si un día saliera", async () => {
    // El contrapeso. Sin esto, `revisar()` podría estar devolviendo siempre la
    // lista vacía y la prueba de arriba pasaría vigilando nada.
    expect(revisar({ clienta: NOMBRE }, [NOMBRE])).not.toEqual([]);
    expect(revisar({ pedidos: [{ cliente: "Yaritza Esquivel" }] }, [NOMBRE])).not.toEqual([]);
    expect(revisar({ celular: "50760001234" })).not.toEqual([]);
    // Y no se queja de lo que sí puede ir.
    expect(revisar({ clienta: referencia, totalCents: 5000, estado: "por_abonar" }, [NOMBRE])).toEqual(
      [],
    );
  });

  it("el nombre de la clienta NO está en lo que devuelve buscar_pedido", async () => {
    // La prueba directa de la regla, sin pasar por la guarda: el campo que
    // `listarPedidos` llama `cliente` —y que lleva el nombre— no se copia.
    await unPedido();
    const r = (await buscarPedido.ejecutar(ctx(), { cuantos: 20 })) as {
      pedidos: Record<string, unknown>[];
    };
    const mio = r.pedidos.find((p) => p["clienta"] === referencia);
    expect(mio).toBeDefined();
    expect(mio?.["clienta"]).toBe(referencia);
    expect(Object.keys(mio ?? {})).not.toContain("cliente");
    expect(JSON.stringify(r)).not.toContain(NOMBRE);
  });
});

/** Ejecuta algo que puede lanzar y devuelve lo que salió, para poder revisarlo. */
async function seQueja(f: () => Promise<unknown>): Promise<unknown> {
  try {
    return await f();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Los roles son los de la ruta del panel
// ---------------------------------------------------------------------------

describe("los roles son los del permiso de su ruta, sin ensanchar", () => {
  const conPermiso = (puede: (rol: Rol) => boolean) => ROLES_DE_PANEL.filter(puede).sort();

  it("las de leer pedidos y clientas las puede quien PUEDE VER pedidos", () => {
    // Calculado desde la matriz, no copiado: si mañana la contadora deja de
    // ver pedidos, esto se pone rojo y hay que venir a decidir.
    const esperado = conPermiso((r) => puedeVer(r, "pedidos"));
    for (const h of [buscarPedido, verPedido, buscarCliente, historialDeCliente]) {
      expect([...h.roles].sort(), h.nombre).toEqual(esperado);
    }
  });

  it("agendar y dar de alta las puede quien PUEDE EDITAR pedidos", () => {
    const esperado = conPermiso((r) => puedeEditar(r, "pedidos"));
    for (const h of [agendarPedido, darDeAltaClienta]) {
      expect([...h.roles].sort(), h.nombre).toEqual(esperado);
    }
  });

  it("y lo sensible es solo de la dueña, aunque la ruta deje a más gente", () => {
    // `POST /pedidos` lo puede la asistente desde el panel. Por el asistente
    // no, y es deliberado: una acción sensible la confirma la dueña, y hay una
    // prueba en `registro.test.ts` que se cae si se le da a alguien más. Es un
    // recorte, nunca un ensanche.
    expect(crearPedidoDeLaClienta.roles).toEqual(["duena"]);
    expect(anularPedido.roles).toEqual(["duena"]);
    expect(puedeEditar("asistente", "pedidos")).toBe(true);
  });

  it("la política le dice no a quien no le toca", () => {
    // El rol declarado no basta: lo que de verdad corta es `decidir`.
    expect(decidir(crearPedidoDeLaClienta, "asistente").clase).toBe("bloquear");
    expect(decidir(buscarPedido, "contadora").clase).toBe("ejecutar");
    expect(decidir(agendarPedido, "contadora").clase).toBe("bloquear");
  });

  it("lo sensible se PROPONE, no se ejecuta", () => {
    expect(decidir(crearPedidoDeLaClienta, "duena")).toMatchObject({
      clase: "confirmar",
      porque: "nivel_sensible",
    });
    expect(decidir(anularPedido, "duena").clase).toBe("confirmar");
    // Y agendar, que no toca dinero ni existencias, sí es directo.
    expect(decidir(agendarPedido, "duena").clase).toBe("ejecutar");
  });
});

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

describe("buscar_pedido", () => {
  it("devuelve la referencia de la clienta y el saldo", async () => {
    const p = await unPedido();
    const r = (await buscarPedido.ejecutar(ctx(), { clienta: referencia, cuantos: 20 })) as {
      pedidos: { numero: string; clienta: string | null; saldoCents: number | null; saldo: string | null }[];
      cuantos: number;
    };

    expect(r.cuantos).toBe(1);
    expect(r.pedidos[0]?.numero).toBe(p.numero);
    expect(r.pedidos[0]?.clienta).toBe(referencia);
    expect(r.pedidos[0]?.saldoCents).toBe(p.totalCents);
    // El monto también en palabras: el modelo tiene que escribir «$50.00» y
    // dividir entre 100 es una cuenta que a veces sale «$500.00».
    expect(r.pedidos[0]?.saldo).toMatch(/^\$\d/);
  });

  it("a quien no ve dinero le van los montos en blanco, y se le dice", async () => {
    await unPedido();
    const r = (await buscarPedido.ejecutar(ctx("asistente"), { cuantos: 20 })) as {
      pedidos: { totalCents: number | null; total: string | null }[];
      veElDinero: boolean;
      aviso: string | null;
    };

    expect(r.veElDinero).toBe(false);
    expect(r.pedidos[0]?.totalCents).toBeNull();
    // Y en palabras TAMBIÉN null: un `formatear(null)` habría escrito «$0.00»,
    // que es la mentira más cómoda que hay — «no le corresponde verlo» dicho
    // como «no debe nada».
    expect(r.pedidos[0]?.total).toBeNull();
    expect(r.aviso).toMatch(/no ve el dinero/);
  });

  it("un estado mal escrito se explica, no revienta", async () => {
    const r = (await buscarPedido.ejecutar(ctx(), { estado: "entregadoo", cuantos: 20 })) as {
      pedidos: unknown[];
      aviso: string | null;
    };
    expect(r.pedidos).toEqual([]);
    expect(r.aviso).toContain("entregadoo");
  });

  it("una referencia que no es de nadie no devuelve la lista entera", async () => {
    // Sin esta guarda, filtrar por una clienta que no existe devolvería TODOS
    // los pedidos y el modelo los leería como «estos son los de ella».
    await unPedido();
    const r = (await buscarPedido.ejecutar(ctx(), { clienta: "C-9999999", cuantos: 20 })) as {
      pedidos: unknown[];
      aviso: string | null;
    };
    expect(r.pedidos).toEqual([]);
    expect(r.aviso).toMatch(/referencia/);
  });

  it("y cada caso de lista vacía dice el suyo", async () => {
    const porTexto = (await buscarPedido.ejecutar(ctx(), { busca: "ZZZZ", cuantos: 20 })) as {
      aviso: string;
    };
    const porEstado = (await buscarPedido.ejecutar(ctx(), { estado: "devuelto", cuantos: 20 })) as {
      aviso: string;
    };
    expect(porTexto.aviso).toContain("ZZZZ");
    expect(porEstado.aviso).toContain("devuelto");
    expect(porTexto.aviso).not.toBe(porEstado.aviso);
  });

  it("el límite se respeta de verdad", async () => {
    // El parámetro que se ignoraba en silencio en tres rutas del panel
    // (TRAMPAS §9) se prueba PASÁNDOLO.
    await unPedido();
    await unPedido(2);
    const r = (await buscarPedido.ejecutar(ctx(), { clienta: referencia, cuantos: 1 })) as {
      cuantos: number;
      hayMas: boolean;
    };
    expect(r.cuantos).toBe(1);
    expect(r.hayMas).toBe(true);
  });
});

describe("ver_pedido", () => {
  it("lo encuentra por su número y por su id", async () => {
    const p = await unPedido(2);
    const porNumero = (await verPedido.ejecutar(ctx(), { pedido: p.numero })) as {
      existe: boolean;
      items: { codigo: string; cantidad: number }[];
    };
    const porId = (await verPedido.ejecutar(ctx(), { pedido: p.pedidoId })) as { existe: boolean };

    expect(porNumero.existe).toBe(true);
    expect(porId.existe).toBe(true);
    expect(porNumero.items[0]).toMatchObject({ codigo: "NAT-M", cantidad: 2 });
  });

  it("no trae el costo ni con la dueña, que sí tiene ese permiso", async () => {
    // `leerPedido` sabe traerlo con `costo_y_margen`, y la dueña lo tiene. Aquí
    // se le pide SIEMPRE que no: una herramienta que a veces trae costo y a
    // veces no es una forma difícil de equivocarse.
    expect(puedeVer("duena", "costo_y_margen")).toBe(true);
    const p = await unPedido();
    const r = await verPedido.ejecutar(ctx(), { pedido: p.numero });
    expect(JSON.stringify(r)).not.toMatch(/costo/i);
  });

  it("y tampoco se lo PIDE a la base, para ningún rol", () => {
    // Las dos capas, y las dos vigiladas. La de arriba comprueba que el costo
    // no sale; esta, que ni se pide. Hacen falta las dos porque la de arriba
    // sobrevive a neutralizar esta —se midió— y entonces esta no estaría
    // vigilada por nadie (TRAMPAS §1).
    for (const rol of ROLES_DE_PANEL) {
      expect(quienMira(rol).veCosto, rol).toBe(false);
    }
    // Y no es que ningún rol tenga el permiso: la dueña lo tiene.
    expect(ROLES_DE_PANEL.some((r) => puedeVer(r, "costo_y_margen"))).toBe(true);
    // El dinero sí sigue el permiso del panel, que es otra cosa.
    expect(quienMira("duena").veDinero).toBe(true);
    expect(quienMira("asistente").veDinero).toBe(false);
  });

  it("devuelve la nota de la clienta y está marcada como texto de fuera", async () => {
    const p = await unPedido();
    await env.DB.prepare("UPDATE pedidos SET notas_cliente = ? WHERE id = ?")
      .bind("tocar el timbre dos veces", p.pedidoId)
      .run();

    const r = (await verPedido.ejecutar(ctx(), { pedido: p.numero })) as {
      notaDeLaClienta: string | null;
    };
    expect(r.notaDeLaClienta).toBe("tocar el timbre dos veces");
    // Es lo que enciende la sospecha para el resto del turno (06-asistente §7).
    expect(verPedido.textoExterno).toBe(true);
  });

  it("ni la zona ni la bodega salen: solo si tiene zona", async () => {
    const p = await unPedido();
    const r = (await verPedido.ejecutar(ctx(), { pedido: p.numero })) as Record<string, unknown>;
    expect(r).toHaveProperty("tieneZona");
    expect(Object.keys(r)).not.toContain("zona");
    expect(JSON.stringify(r)).not.toContain("bod-1");
    expect(JSON.stringify(r)).not.toContain("Bodega");
  });

  it("un pedido que no está se explica sin decir que no existe un artículo", async () => {
    const r = (await verPedido.ejecutar(ctx(), { pedido: "BC-999999" })) as {
      existe: boolean;
      aviso: string;
    };
    expect(r.existe).toBe(false);
    expect(r.aviso).toContain("BC-999999");
    expect(r.aviso).toContain("buscar_pedido");
  });
});

// ---------------------------------------------------------------------------
// Escribir
// ---------------------------------------------------------------------------

describe("crear_pedido", () => {
  it("aparta la mercancía y el precio lo pone el servidor", async () => {
    const antes = (await reservadoDeNatM()) ?? 0;
    const r = (await crearPedidoDeLaClienta.ejecutar(ctx(), {
      clienta: referencia,
      lineas: [{ codigo: "NAT-M", cantidad: 3 }],
      motivo: "lo pidió por WhatsApp",
    })) as { totalCents: number; numero: string };

    // No hay dónde escribir un precio en el esquema de la herramienta, y el
    // total sale del catálogo.
    expect(r.totalCents).toBeGreaterThan(0);
    expect(r.numero).toMatch(/^BC-/);
    expect(await reservadoDeNatM()).toBe(antes + 3);
  });

  it("el enlace de seguimiento NO sale hacia el modelo", async () => {
    // `crearPedido` devuelve un `token` de 256 bits que abre el pedido sin
    // pedir nada más. Es un secreto, y los secretos no salen por una
    // herramienta (06-asistente §3, punto 3).
    const r = (await unPedido()) as Record<string, unknown>;
    expect(Object.keys(r)).not.toContain("token");

    const guardado = await env.DB.prepare("SELECT token FROM pedidos WHERE id = ?")
      .bind(r["pedidoId"])
      .first<{ token: string }>();
    expect(guardado?.token).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(guardado?.token);
  });

  it("la llave de idempotencia se deriva del contenido, no se inventa al azar", async () => {
    // Y hace falta decir lo que esta prueba NO demuestra, porque es lo
    // sorprendente: `crearPedido` recibe la llave y solo la ESCRIBE en el
    // evento del pedido. No la busca en la tabla `idempotencia` ni hay un
    // UNIQUE que la cubra, así que pedir dos veces lo mismo crea DOS pedidos
    // —por esta puerta y por la del panel igual, pese a lo que dice el
    // comentario de `POST /pedidos`—. Lo que de verdad impide el doble pedido
    // por el asistente es el candado de `acciones`, y eso se prueba abajo, en
    // «por la puerta de verdad».
    //
    // Lo que sí se comprueba aquí: que la llave es la MISMA para la misma
    // petición. Si se generara al azar, el día que alguien la compruebe no
    // cerraría nada, y mientras tanto dos pedidos gemelos no se reconocerían
    // en el evento.
    const args = {
      clienta: referencia,
      lineas: [{ codigo: "NAT-M", cantidad: 2 }],
      motivo: "mismo pedido",
    };
    const primero = (await crearPedidoDeLaClienta.ejecutar(ctx(), args)) as { pedidoId: string };
    const segundo = (await crearPedidoDeLaClienta.ejecutar(ctx(), args)) as { pedidoId: string };

    const llaveDe = async (pedidoId: string) => {
      const f = await env.DB.prepare(
        "SELECT datos_json FROM pedido_eventos WHERE pedido_id = ? AND tipo = 'creado'",
      )
        .bind(pedidoId)
        .first<{ datos_json: string }>();
      return (JSON.parse(f?.datos_json ?? "{}") as { idempotencia?: string }).idempotencia;
    };

    const llave = await llaveDe(primero.pedidoId);
    expect(llave).toBeTruthy();
    expect(await llaveDe(segundo.pedidoId)).toBe(llave);
    // Lleva dentro quién, cuándo y qué: nada de azar.
    expect(llave).toContain("NAT-Mx2");
    expect(llave).toContain(clienteId);
  });

  it("una referencia que no es de nadie no crea nada", async () => {
    await expect(
      crearPedidoDeLaClienta.ejecutar(ctx(), {
        clienta: "C-9999999",
        lineas: [{ codigo: "NAT-M", cantidad: 1 }],
        motivo: "prueba",
      }),
    ).rejects.toThrow(/referencia/);
  });

  it("sin stock no aparta nada y lo dice", async () => {
    await env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0").run();
    await expect(
      crearPedidoDeLaClienta.ejecutar(ctx(), {
        clienta: referencia,
        lineas: [{ codigo: "NAT-M", cantidad: 1 }],
        motivo: "prueba",
      }),
    ).rejects.toThrow();
  });

  it("el esquema no deja pasar un pedido sin líneas ni sin motivo", () => {
    expect(
      crearPedidoDeLaClienta.parametros.safeParse({ clienta: referencia, lineas: [], motivo: "x" })
        .success,
    ).toBe(false);
    expect(
      crearPedidoDeLaClienta.parametros.safeParse({
        clienta: referencia,
        lineas: [{ codigo: "NAT-M", cantidad: 1 }],
      }).success,
    ).toBe(false);
    // Y una cantidad de cero o negativa tampoco.
    expect(
      crearPedidoDeLaClienta.parametros.safeParse({
        clienta: referencia,
        lineas: [{ codigo: "NAT-M", cantidad: 0 }],
        motivo: "x",
      }).success,
    ).toBe(false);
  });
});

describe("agendar_pedido", () => {
  it("no agenda lo que no alcanza el abono", async () => {
    const p = await unPedido();
    await expect(
      agendarPedido.ejecutar(ctx(), { pedido: p.numero, motivo: "a ver" }),
    ).rejects.toThrow();
    expect((await estadoDe(p.pedidoId))?.estado).toBe("por_abonar");
  });

  it("y agenda cuando ya está pagado", async () => {
    const p = await unPedido();
    // El pago se da por hecho a mano: lo que se prueba aquí es agendar, y
    // cobrar tiene sus propias pruebas en `dinero.test.ts`.
    await env.DB.prepare("UPDATE pedidos SET pagado_cents = total_cents WHERE id = ?")
      .bind(p.pedidoId)
      .run();

    const r = (await agendarPedido.ejecutar(ctx(), {
      pedido: p.numero,
      motivo: "ya mandó el comprobante",
    })) as { agendado: boolean };
    expect(r.agendado).toBe(true);
    expect((await estadoDe(p.pedidoId))?.estado).toBe("agendado");
  });

  it("un pedido que no está no se agenda", async () => {
    await expect(
      agendarPedido.ejecutar(ctx(), { pedido: "BC-999999", motivo: "prueba" }),
    ).rejects.toThrow(/BC-999999/);
  });
});

describe("anular_pedido", () => {
  it("devuelve al inventario lo que tenía apartado", async () => {
    const p = await unPedido(4);
    const reservado = (await reservadoDeNatM()) ?? 0;

    const r = (await anularPedido.ejecutar(ctx(), {
      pedido: p.numero,
      motivo: "la clienta ya no lo quiere",
    })) as { anulado: boolean; liberadas: number };

    expect(r.anulado).toBe(true);
    expect(r.liberadas).toBeGreaterThan(0);
    expect(await reservadoDeNatM()).toBe(reservado - 4);
    expect((await estadoDe(p.pedidoId))?.estado).toBe("cancelado");
  });

  it("el motivo es obligatorio y queda escrito en el pedido", async () => {
    expect(anularPedido.parametros.safeParse({ pedido: "BC-1" }).success).toBe(false);
    expect(anularPedido.parametros.safeParse({ pedido: "BC-1", motivo: "x" }).success).toBe(false);

    const p = await unPedido();
    await anularPedido.ejecutar(ctx(), { pedido: p.numero, motivo: "se arrepintió" });
    const evento = await env.DB.prepare(
      "SELECT datos_json FROM pedido_eventos WHERE pedido_id = ? AND a = 'cancelado'",
    )
      .bind(p.pedidoId)
      .first<{ datos_json: string | null }>();
    expect(evento?.datos_json).toContain("se arrepintió");
  });
});

describe("clientas", () => {
  it("buscar_cliente encuentra por celular y devuelve solo la referencia", async () => {
    const alta = (await darDeAltaClienta.ejecutar(ctx(), {
      nombre: "Zoraida Pimentel",
      celular: CELULAR,
      motivo: "escribió por WhatsApp",
    })) as { clienta: string; nueva: boolean };
    expect(alta.nueva).toBe(true);

    const r = (await buscarCliente.ejecutar(ctx(), { texto: CELULAR, cuantos: 10 })) as {
      clientas: Record<string, unknown>[];
    };
    expect(r.clientas.map((c) => c["clienta"])).toContain(alta.clienta);
    // Ni nombre ni celular: la referencia, los pedidos y la fecha.
    expect(Object.keys(r.clientas[0] ?? {}).sort()).toEqual(["clienta", "pedidos", "ultimoPedido"]);
    expect(JSON.stringify(r)).not.toContain("Zoraida");
  });

  it("dar_de_alta_clienta con el mismo celular devuelve a la MISMA persona", async () => {
    // La defensa contra la misma señora con tres fichas y el historial
    // repartido entre las tres.
    const primera = (await darDeAltaClienta.ejecutar(ctx(), {
      nombre: "Zoraida Pimentel",
      celular: "6000-5555",
      motivo: "prueba",
    })) as { clienta: string; nueva: boolean };
    const otra = (await darDeAltaClienta.ejecutar(ctx(), {
      nombre: "Zoraida P.",
      celular: "6000 5555",
      motivo: "prueba",
    })) as { clienta: string; nueva: boolean };

    expect(otra.nueva).toBe(false);
    expect(otra.clienta).toBe(primera.clienta);
  });

  it("un celular que no se entiende no abre ninguna ficha", async () => {
    await expect(
      darDeAltaClienta.ejecutar(ctx(), { nombre: "Zoraida", celular: "12345", motivo: "prueba" }),
    ).rejects.toThrow();
  });

  it("historial_de_cliente trae sus pedidos y qué datos le faltan", async () => {
    const p = await unPedido();
    const r = (await historialDeCliente.ejecutar(ctx(), { clienta: referencia })) as {
      existe: boolean;
      clienta: string;
      cuantosPedidos: number;
      pedidos: { numero: string }[];
      faltaParaTarjeta: string[];
      cuantasDirecciones: number;
    };

    expect(r.existe).toBe(true);
    expect(r.clienta).toBe(referencia);
    expect(r.cuantosPedidos).toBe(1);
    expect(r.pedidos[0]?.numero).toBe(p.numero);
    // `falta` son NOMBRES de campos, no valores: dice qué hay que ir a poner.
    expect(r.faltaParaTarjeta).toContain("el correo");
    expect(r.cuantasDirecciones).toBe(0);
  });

  it("de sus direcciones sale la cuenta, nunca la calle ni la zona", async () => {
    const direccion = id("dir");
    await env.DB.prepare(
      `INSERT INTO direcciones (id,cliente_id,zona_id,texto,ciudad,activa,creado_en)
       VALUES (?,?,(SELECT id FROM zonas_envio LIMIT 1),?,?,1,?)`,
    )
      .bind(direccion, clienteId, "Calle 50, casa 3, al lado del parque", "Panamá", ahora())
      .run();

    const r = (await historialDeCliente.ejecutar(ctx(), { clienta: referencia })) as Record<
      string,
      unknown
    >;
    expect(r["cuantasDirecciones"]).toBe(1);
    expect(r["tieneDireccionActiva"]).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Calle 50");
    expect(Object.keys(r)).not.toContain("direcciones");
  });

  it("las notas no salen, y se dice que hay", async () => {
    await env.DB.prepare("UPDATE clientes SET notas = ? WHERE id = ?")
      .bind("vive en la calle 50, preguntar por el portero", clienteId)
      .run();

    const r = (await historialDeCliente.ejecutar(ctx(), { clienta: referencia })) as {
      tieneNotas: boolean;
    };
    expect(r.tieneNotas).toBe(true);
    expect(JSON.stringify(r)).not.toContain("calle 50");
  });

  it("una referencia mal escrita se explica en vez de fallar", async () => {
    const r = (await historialDeCliente.ejecutar(ctx(), { clienta: "Yaritza" })) as {
      existe: boolean;
      aviso: string;
    };
    expect(r.existe).toBe(false);
    expect(r.aviso).toContain("C-0042");
  });
});

// ---------------------------------------------------------------------------
// Por donde entra la persona
// ---------------------------------------------------------------------------

describe("por la puerta de verdad (ejecutar + confirmar)", () => {
  it("crear_pedido no aparta nada hasta que una persona lo permite", async () => {
    // TRAMPAS §12: una pieza no está terminada porque sus pruebas pasen, sino
    // cuando algo la llama POR DONDE la va a llamar el usuario. Esto es ese
    // camino: el ejecutor, la bitácora y la confirmación.
    const registro = catalogo();
    const quien = { db: env.DB, usuario: ctx().usuario, ahora: ahora() };
    const reservadoAntes = (await reservadoDeNatM()) ?? 0;

    const propuesta = await ejecutar(quien, registro, {
      nombre: "crear_pedido",
      argumentos: {
        clienta: referencia,
        lineas: [{ codigo: "NAT-M", cantidad: 2 }],
        motivo: "lo pidió por WhatsApp",
      },
      canal: "mcp",
      conversacionId: null,
      conAdjuntos: false,
      textoExterno: false,
    });

    expect(propuesta.ok).toBe(true);
    if (!propuesta.ok) return;
    expect(propuesta.datos.clase).toBe("por_confirmar");
    if (propuesta.datos.clase !== "por_confirmar") return;

    // Nada se movió todavía, y el resumen dice QUÉ va a pasar.
    expect(await reservadoDeNatM()).toBe(reservadoAntes);
    expect(propuesta.datos.resumen).toContain("crear pedido");
    expect(propuesta.datos.resumen).toContain(referencia);

    const hecho = await confirmar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      registro,
      propuesta.datos.accionId,
      "permitir",
    );
    expect(hecho.ok).toBe(true);
    expect(await reservadoDeNatM()).toBe(reservadoAntes + 2);

    // Y queda en la bitácora, con el canal por el que entró.
    const fila = await env.DB.prepare(
      "SELECT herramienta, nivel, canal, estado FROM acciones WHERE id = ?",
    )
      .bind(propuesta.datos.accionId)
      .first<{ herramienta: string; nivel: string; canal: string; estado: string }>();
    expect(fila).toMatchObject({
      herramienta: "crear_pedido",
      nivel: "sensible",
      canal: "mcp",
      estado: "hecha",
    });
  });

  it("confirmar la misma acción dos veces no aparta la mercancía dos veces", async () => {
    // Esta es la idempotencia de verdad del asistente (06-asistente §3): el id
    // de la acción. Lo hace cumplir la BASE —el trigger
    // `acciones_solo_se_cierran_una_vez`— y no este código, que es justo por lo
    // que vale: dos toques del botón «Permitir» con mala señal apartarían la
    // mercancía dos veces, y eso solo se descubre contando cajas.
    const registro = catalogo();
    const reservadoAntes = (await reservadoDeNatM()) ?? 0;

    const propuesta = await ejecutar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      registro,
      {
        nombre: "crear_pedido",
        argumentos: {
          clienta: referencia,
          lineas: [{ codigo: "NAT-M", cantidad: 3 }],
          motivo: "doble toque",
        },
        canal: "panel",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );
    expect(propuesta.ok && propuesta.datos.clase === "por_confirmar").toBe(true);
    if (!propuesta.ok || propuesta.datos.clase !== "por_confirmar") return;

    const permitir = () =>
      confirmar(
        { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
        registro,
        propuesta.datos.clase === "por_confirmar" ? propuesta.datos.accionId : "",
        "permitir",
      );

    expect((await permitir()).ok).toBe(true);
    const segunda = await permitir();
    expect(segunda.ok).toBe(false);
    if (!segunda.ok) expect(segunda.codigo).toBe("repetido");

    expect(await reservadoDeNatM()).toBe(reservadoAntes + 3);
  });

  it("y rechazarla no aparta nada", async () => {
    const registro = catalogo();
    const quien = { db: env.DB, usuario: ctx().usuario, ahora: ahora() };
    const reservadoAntes = (await reservadoDeNatM()) ?? 0;

    const propuesta = await ejecutar(quien, registro, {
      nombre: "crear_pedido",
      argumentos: {
        clienta: referencia,
        lineas: [{ codigo: "NAT-M", cantidad: 5 }],
        motivo: "a ver si se rechaza",
      },
      canal: "panel",
      conversacionId: null,
      conAdjuntos: false,
      textoExterno: false,
    });
    expect(propuesta.ok && propuesta.datos.clase === "por_confirmar").toBe(true);
    if (!propuesta.ok || propuesta.datos.clase !== "por_confirmar") return;

    await confirmar(
      { db: env.DB, usuario: ctx().usuario, ahora: ahora() },
      registro,
      propuesta.datos.accionId,
      "rechazar",
    );
    expect(await reservadoDeNatM()).toBe(reservadoAntes);
  });

  it("todas están registradas en el catálogo", () => {
    // Una herramienta que no esté aquí no existe para ninguna de las tres
    // puertas: es una pieza terminada que nadie llama (TRAMPAS §12 y §13).
    const nombres = catalogo()
      .todas()
      .map((h) => h.nombre);
    for (const h of [
      buscarPedido,
      verPedido,
      crearPedidoDeLaClienta,
      agendarPedido,
      anularPedido,
      buscarCliente,
      historialDeCliente,
      darDeAltaClienta,
    ]) {
      expect(nombres, h.nombre).toContain(h.nombre);
    }
  });
});
