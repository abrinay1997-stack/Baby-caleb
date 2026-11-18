import { env } from "cloudflare:workers";
import { guardar as guardarAjuste } from "../src/db/ajustes";
import { beforeEach, describe, expect, it } from "vitest";

import { cobrarCarrito } from "../src/pagos/cobrar-carrito";
import { configurarCredencial } from "../src/db/pasarelas";

/**
 * El carrito de la web, convertido en un pedido que se puede pagar.
 *
 * La prueba que justifica este archivo es una: **que los precios del navegador
 * no cuenten**. Cambiar un precio en las herramientas del navegador cuesta
 * diez segundos, y si llegaran hasta aquí, la tienda cobraría lo que la
 * clienta escribió. Lo que entra son códigos y cantidades; los precios los
 * pone el servidor.
 */

const LLAVE = "TExBVkUtRkFMU0EtREUtUFJVRUJBLTMyLUJZVEVTISE=";
const ID_FALSO = "ID-COMERCIO-FALSO-DE-PRUEBA-0001";
const CLAVE_FALSA = "Y2xhdmVkZXBydWViYS5zZWd1bmRvdHJvem8=";

let n = 0;
const ahora = () => Date.now();

/** Un Yappy de mentira que contesta lo que contestaría el suyo. */
function yappyQueContesta() {
  const pedidos: unknown[] = [];
  const buscar = async (url: string, init: RequestInit): Promise<Response> => {
    const crudo = typeof init.body === "string" ? init.body : "";
    pedidos.push(crudo === "" ? null : JSON.parse(crudo));
    return new Response(
      JSON.stringify({
        status: { code: "OK" },
        body: { epochTime: 1, token: "tok", transactionId: "TX-1", documentName: "doc-1" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { buscar, pedidos };
}

const ctx = () => ({
  db: env.DB,
  ahora: ahora(),
  llaveMaestra: LLAVE,
  urlDelAviso: "https://babycaleb.com/api/pago/yappy",
});

const carrito = (sobre: Record<string, unknown> = {}) => ({
  nombre: "Ana",
  celular: "6000-0001",
  lineas: [{ codigo: "NAT-M", cantidad: 1 }],
  idempotencia: `carrito-${Date.now()}-${n++}`,
  ...sobre,
});

/**
 * Encender la pasarela, que ahora hace falta de verdad.
 *
 * Antes estas pruebas montaban las credenciales y cobraban sin más, porque
 * `abrirCredenciales` no miraba `pasarelas_activas`. Ese era exactamente el
 * fallo: en producción, con el checkout apagado y Yappy apagada, la web seguía
 * creando pedidos y apartando mercancía — lo único que escondía el botón era
 * la pantalla, y la ruta pública seguía cobrando.
 *
 * Desde que el interruptor se comprueba, una prueba que cobre tiene que
 * encender la pasarela igual que la enciende la dueña. Si esto se borra, las
 * pruebas se ponen rojas: así es como tiene que ser.
 */
async function encenderYappy(): Promise<void> {
  for (const cambio of [
    {
      clave: "pasarelas_activas" as const,
      valor: ["yappy"],
      motivo: "montar el escenario: la dueña la tiene encendida",
    },
    {
      /**
       * EL PLAZO DE LA RESERVA, que ahora hace falta de verdad.
       *
       * Un pedido de la web no puede nacer sin reloj: si no vence, el cron no
       * lo suelta nunca —busca `vence_en IS NOT NULL`— y cada carrito
       * abandonado se queda con la caja para siempre. Estaba PENDIENTE en
       * producción y por eso pasaba.
       *
       * Si esto se borra, `cobrarCarrito` se niega y estas pruebas se ponen
       * rojas. Así es como tiene que ser.
       */
      clave: "reserva_minutos_pago_en_linea" as const,
      valor: 20,
      motivo: "montar el escenario: la dueña puso el plazo",
    },
  ]) {
    const r = await guardarAjuste(
      { db: env.DB, ahora: ahora(), actor: "yarielis@babycaleb.com" },
      cambio,
    );
    if (!r.ok) throw new Error(`${cambio.clave}: ${r.mensaje}`);
  }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pasarela_credenciales"),
    env.DB.prepare("UPDATE pasarelas SET modo = 'prueba'"),
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 50 WHERE codigo = 'NAT-M' AND bodega_id = (SELECT id FROM bodegas WHERE activa = 1 LIMIT 1)",
    ),
  ]);
  for (const [credencial, valor] of [
    ["id_comercio", ID_FALSO],
    ["clave_secreta", CLAVE_FALSA],
  ] as const) {
    const r = await configurarCredencial(
      { db: env.DB, ahora: ahora(), actor: "yarielis@babycaleb.com", llaveMaestra: LLAVE },
      { pasarela: "yappy", credencial, valor, modo: "prueba", motivo: "escenario de la prueba" },
    );
    if (!r.ok) throw new Error(`${credencial}: ${r.mensaje}`);
  }
  await encenderYappy();
});

const precioDe = async (codigo: string) =>
  (
    await env.DB.prepare("SELECT precio_cents FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ precio_cents: number }>()
  )!.precio_cents;

// ---------------------------------------------------------------------------
describe("el camino bueno", () => {
  it("crea el pedido, arranca el cobro y devuelve lo del botón", async () => {
    const y = yappyQueContesta();
    const r = await cobrarCarrito(ctx(), carrito(), y.buscar);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.boton).toEqual({
      transactionId: "TX-1",
      token: "tok",
      documentName: "doc-1",
    });
    expect(r.datos.pedido.numero).toMatch(/^BC-/);
    expect(r.datos.pedido.totalCents).toBeGreaterThan(0);
  });

  /**
   * LA CLAVE SECRETA NO SALE DE AQUÍ.
   *
   * Lo que devuelve esta función viaja entero al navegador. Si la clave se
   * colara —en un mensaje de error, en un campo de más— estaría en el código
   * fuente de la página de cualquiera que la abra.
   */
  it("la clave secreta no está en ninguna parte de lo que vuelve", async () => {
    const y = yappyQueContesta();
    const r = await cobrarCarrito(ctx(), carrito(), y.buscar);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(CLAVE_FALSA);
    expect(texto).not.toContain(ID_FALSO);
  });

  /**
   * Yappy quiere el celular SIN prefijo. Mandarlo con el 507 es uno de los
   * motivos por los que la solicitud no llega a ningún teléfono, y el error
   * que devuelve no lo dice.
   */
  it("el celular viaja a Yappy sin prefijo y sin guiones", async () => {
    for (const escrito of ["6000-0001", "+507 6000 0001", "507-6000-0001", "60000001"]) {
      const y = yappyQueContesta();
      await cobrarCarrito(ctx(), carrito({ celular: escrito }), y.buscar);
      const orden = y.pedidos[1] as Record<string, unknown>;
      expect(orden.aliasYappy, escrito).toBe("60000001");
    }
  });
});

// ---------------------------------------------------------------------------
describe("el navegador manda QUÉ, nunca CUÁNTO", () => {
  /**
   * ESTA ES LA PRUEBA QUE JUSTIFICA EL ARCHIVO.
   *
   * Cambiar un precio en las herramientas del navegador cuesta diez segundos.
   * Lo que entra aquí son códigos y cantidades; el total lo calcula
   * `crearPedido` leyendo la base. Si algún día alguien «mejora» esto para
   * aceptar un total del cliente, esta prueba se pone roja.
   */
  it("un precio inventado en el carrito no cambia lo que se cobra", async () => {
    const real = await precioDe("NAT-M");
    const y = yappyQueContesta();

    const r = await cobrarCarrito(
      ctx(),
      carrito({
        // Todo esto es basura que un navegador manipulado mandaría.
        lineas: [{ codigo: "NAT-M", cantidad: 1, precioCents: 1, precio: "0.01" }],
        totalCents: 1,
        total: "0.01",
        envioCents: 0,
      }),
      y.buscar,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // El total es el de la base, no el del navegador.
    expect(r.datos.pedido.totalCents).toBeGreaterThanOrEqual(real);
    expect(r.datos.pedido.totalCents).not.toBe(1);

    // Y lo que viajó a Yappy también.
    const orden = y.pedidos[1] as Record<string, unknown>;
    expect(orden.total).not.toBe("0.01");
    const enCentavos = Math.round(Number(orden.total) * 100);
    expect(enCentavos).toBe(r.datos.pedido.totalCents);
  });

  it("y el monto del pago guardado es el del servidor", async () => {
    const y = yappyQueContesta();
    const r = await cobrarCarrito(ctx(), carrito({ totalCents: 1 }), y.buscar);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const pago = await env.DB.prepare(
      "SELECT monto_cents FROM pagos WHERE intento_ref LIKE ? ORDER BY creado_en DESC LIMIT 1",
    )
      .bind(`${r.datos.pedido.numero.replace(/-/g, "")}%`)
      .first<{ monto_cents: number }>();

    expect(pago?.monto_cents).toBe(r.datos.pedido.totalCents);
  });
});

// ---------------------------------------------------------------------------
describe("el doble toque", () => {
  /**
   * LA MISMA REFERENCIA NO CREA DOS PEDIDOS.
   *
   * Sin esto, un doble toque aparta el inventario dos veces y la clienta
   * acaba con dos pedidos iguales — y si paga uno, el otro se queda
   * reservando cajas hasta que venza.
   */
  it("el mismo carrito dos veces es UN pedido", async () => {
    const c = carrito();
    const uno = await cobrarCarrito(ctx(), c, yappyQueContesta().buscar);
    const dos = await cobrarCarrito(ctx(), c, yappyQueContesta().buscar);

    expect(uno.ok && dos.ok).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect(dos.datos.pedido.numero).toBe(uno.datos.pedido.numero);

    const cuantos = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pedidos WHERE numero = ?",
    )
      .bind(uno.datos.pedido.numero)
      .first<{ n: number }>();
    expect(cuantos?.n).toBe(1);
  });

  /**
   * MISMA CLAVE CON OTRO CARRITO = `repetido`, NUNCA la respuesta anterior.
   *
   * Es la lección que `rpc/crm.ts` tiene escrita por haberla sufrido: allí,
   * dos ventas distintas con la misma clave devolvían la respuesta de la
   * primera con `ok: true` y no descontaban nada. **Una venta perdida
   * reportada como cumplida es peor que un error, porque nadie la va a
   * buscar.**
   */
  it("la misma referencia con OTRO carrito no devuelve el pedido viejo", async () => {
    const c = carrito();
    const uno = await cobrarCarrito(ctx(), c, yappyQueContesta().buscar);
    expect(uno.ok).toBe(true);

    const otro = await cobrarCarrito(
      ctx(),
      { ...c, lineas: [{ codigo: "NAT-M", cantidad: 3 }] },
      yappyQueContesta().buscar,
    );

    expect(otro.ok, "no se devuelve el pedido de una línea como si fuera el de tres").toBe(false);
    if (!otro.ok) expect(otro.codigo).toBe("repetido");
  });

  /**
   * Y el nombre NO entra en la huella: corregir una tilde no es otro carrito.
   * Lo que decide qué se cobra son las líneas, el celular y la zona.
   */
  it("corregir el nombre no cuenta como un carrito distinto", async () => {
    const c = carrito({ nombre: "ana" });
    const uno = await cobrarCarrito(ctx(), c, yappyQueContesta().buscar);
    const dos = await cobrarCarrito(ctx(), { ...c, nombre: "Ana María" }, yappyQueContesta().buscar);

    expect(uno.ok && dos.ok).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect(dos.datos.pedido.numero).toBe(uno.datos.pedido.numero);
  });
});

// ---------------------------------------------------------------------------
describe("lo que no se acepta", () => {
  it("un carrito vacío", async () => {
    const r = await cobrarCarrito(ctx(), carrito({ lineas: [] }), yappyQueContesta().buscar);
    expect(r.ok).toBe(false);
  });

  it("una cantidad que no es un entero positivo", async () => {
    for (const cantidad of [0, -1, 1.5, 1000, Number.NaN]) {
      const y = yappyQueContesta();
      const r = await cobrarCarrito(
        ctx(),
        carrito({ lineas: [{ codigo: "NAT-M", cantidad }] }),
        y.buscar,
      );
      expect(r.ok, String(cantidad)).toBe(false);
      // Y no se llamó a Yappy por algo que se sabía que iba a fallar.
      expect(y.pedidos.length, String(cantidad)).toBe(0);
    }
  });

  it("sin nombre o sin celular no hay ficha de clienta, así que no hay pedido", async () => {
    for (const sobre of [{ nombre: "" }, { celular: "" }, { celular: "no es un telefono" }]) {
      const r = await cobrarCarrito(ctx(), carrito(sobre), yappyQueContesta().buscar);
      expect(r.ok, JSON.stringify(sobre)).toBe(false);
    }
  });

  it("una referencia de carrito demasiado corta", async () => {
    const r = await cobrarCarrito(ctx(), carrito({ idempotencia: "abc" }), yappyQueContesta().buscar);
    expect(r.ok).toBe(false);
  });

  /**
   * Sin credenciales de Yappy no se cobra — y el pedido TAMPOCO se queda
   * creado a medias sin que nadie lo sepa: `iniciarCobro` deja su fila en
   * `rechazado`, que es la anotación de lo que se intentó.
   */
  it("sin credenciales de Yappy, falla y lo dice", async () => {
    await env.DB.prepare("DELETE FROM pasarela_credenciales").run();
    const r = await cobrarCarrito(ctx(), carrito(), yappyQueContesta().buscar);
    expect(r.ok).toBe(false);
  });
});
