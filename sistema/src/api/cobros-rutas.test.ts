import { env as real } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Las rutas de cobros (F4.4, enganchadas).
 *
 * El módulo `db/pagos.ts` estaba escrito y probado desde F4.4 y NO TENÍA NI
 * UNA RUTA. El efecto no era un error visible: era que un comprobante entraba
 * en «confirmando» y se quedaba ahí para siempre, porque no existía forma de
 * llamar a `confirmarPago` desde ningún sitio. La regla «el navegador no
 * decide un pago» quedaba cumplida de la peor manera posible — nadie decidía.
 *
 * En su propio archivo por lo mismo que `entregas-rutas.test.ts`: aquí no se
 * limpia entre pruebas porque los pagos son un libro y los libros no se
 * borran, así que cada prueba trae sus propios identificadores.
 *
 * Y se vigila lo que decide LA RUTA, no lo que decide el módulo (eso ya tiene
 * sus 24 pruebas en `test/pagos-manuales.test.ts`): el permiso, lo que se
 * rechaza antes de tocar la base, y que `?limite=` se respete.
 */

const T = 1_800_000_000_000;

const comoUsuario = (rol: RolDePanel): Usuario => ({
  id: `u-${rol}`,
  correo: `${rol}@babycaleb.com`,
  nombre: `La ${rol}`,
  rol,
  activo: true,
});

const entrandoComo = (rol: RolDePanel) =>
  crearPanel((async () => ({ ok: true, usuario: comoUsuario(rol) })) as ResolverUsuario);

async function pedir(app: ReturnType<typeof crearPanel>, ruta: string) {
  const r = await app.fetch(new Request(`https://panel.babycaleb.com${ruta}`), real as Env);
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

async function postJson(
  app: ReturnType<typeof crearPanel>,
  ruta: string,
  cuerpo: Record<string, unknown>,
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: "POST",
      body: JSON.stringify(cuerpo),
      headers: { "content-type": "application/json" },
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

let n = 0;

/** Un pedido por abonar, con su mercancía apartada. */
async function unPedido(): Promise<{ pedidoId: string; numero: string }> {
  const suf = `${Date.now()}-${n++}`;
  const pedidoId = `ped-${suf}`;
  const numero = `BC-${suf}`;
  const clienteId = `cli-${suf}`;
  const bodegaId = `bod-${suf}`;
  const productoId = `pro-${suf}`;

  await real.DB.batch([
    real.DB.prepare("INSERT INTO bodegas (id,nombre) VALUES (?,?)").bind(bodegaId, `Bodega ${suf}`),
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,'panal','Pañal Nateen',?,?)",
    ).bind(productoId, `panal-${suf}`, T),
    real.DB.prepare(
      `INSERT OR IGNORE INTO variantes
         (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en)
       VALUES ('NAT-M',?,'Pañal Nateen M','M',144,5000,0,1,?)`,
    ).bind(productoId, T),
    real.DB.prepare(
      "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,'Ana',?,?)",
    ).bind(clienteId, T, T),
    real.DB.prepare(
      `INSERT INTO pedidos
         (id,numero,token,cliente_id,origen,estado,estado_pago,
          subtotal_cents,descuento_cents,envio_cents,itbms_cents,total_cents,
          pagado_cents,abono_minimo_cents,requiere_pago_total,creado_en,actualizado_en)
       VALUES (?,?,?,?,'panel','por_abonar','sin_pago',
          10000,0,0,0,10000,0,500,0,?,?)`,
    ).bind(pedidoId, numero, `tok-${suf}`, clienteId, T, T),
  ]);
  return { pedidoId, numero };
}

describe("/cobros", () => {
  it("la bandeja pide el permiso de cobros: quien despacha no ve el dinero", async () => {
    // `cobros` en «no» para el asistente no es un olvido: quien despacha mira
    // los pedidos y no tiene por qué tocar el dinero. En la matriz de hoy este
    // permiso solo lo tiene la dueña.
    const r = await pedir(entrandoComo("asistente"), "/cobros");
    expect(r.estado).toBe(403);
  });

  it("trae el total y lo ya cobrado del pedido, no solo el comprobante", async () => {
    const { pedidoId, numero } = await unPedido();
    const puesto = await postJson(entrandoComo("duena"), "/cobros", {
      pedidoId,
      montoCents: 3000,
      metodo: "yappy",
      tipo: "abono",
      idempotencia: `comp-${pedidoId}`,
    });
    expect(puesto.estado, JSON.stringify(puesto.cuerpo)).toBe(200);

    const r = await pedir(entrandoComo("duena"), "/cobros?limite=100");
    expect(r.estado).toBe(200);
    const datos = r.cuerpo["datos"] as { comprobantes: Record<string, unknown>[] };
    const mio = datos.comprobantes.find((x) => x["numero"] === numero);
    expect(mio, "el comprobante no salió en la bandeja").toBeDefined();
    // Las dos cifras que hacen falta para decidir sin abrir otra pestaña:
    // «¿este abono de $30 completa el mínimo?» no se contesta mirando solo el
    // comprobante, y obligar a salir de la pantalla es cómo se confirma lo
    // que no se debía.
    expect(mio?.["totalCents"]).toBe(10000);
    expect(mio?.["pagadoCents"]).toBe(0);
    expect(mio?.["montoCents"]).toBe(3000);
  });

  it("confirmar entra el dinero y deja el asiento; el pedido se agenda solo", async () => {
    const { pedidoId } = await unPedido();
    const puesto = await postJson(entrandoComo("duena"), "/cobros", {
      pedidoId,
      montoCents: 3000,
      metodo: "yappy",
      tipo: "abono",
      idempotencia: `comp2-${pedidoId}`,
    });
    const pagoId = (puesto.cuerpo["datos"] as { pagoId: string }).pagoId;

    // Mientras no lo confirma una persona, el pedido NO se mueve.
    const antes = await real.DB.prepare("SELECT estado, pagado_cents FROM pedidos WHERE id = ?")
      .bind(pedidoId)
      .first<{ estado: string; pagado_cents: number }>();
    expect(antes).toEqual({ estado: "por_abonar", pagado_cents: 0 });

    const r = await postJson(entrandoComo("duena"), `/cobros/${pagoId}/confirmar`, {});
    expect(r.estado, JSON.stringify(r.cuerpo)).toBe(200);

    const despues = await real.DB.prepare("SELECT estado, pagado_cents FROM pedidos WHERE id = ?")
      .bind(pedidoId)
      .first<{ estado: string; pagado_cents: number }>();
    expect(despues).toEqual({ estado: "agendado", pagado_cents: 3000 });

    // Y el asiento, que es lo que faltaba hasta hoy.
    const a = await real.DB.prepare(
      "SELECT hecho FROM asientos WHERE referencia_tipo = 'pago' AND referencia_id = ?",
    )
      .bind(pagoId)
      .first<{ hecho: string }>();
    expect(a?.hecho).toBe("1");
  });

  it("confirmar también pide el permiso: no se cobra desde otra silla", async () => {
    const r = await postJson(entrandoComo("asistente"), "/cobros/cualquiera/confirmar", {});
    expect(r.estado).toBe(403);
  });

  it("un rechazo sin motivo se para en la ruta, antes de tocar la base", async () => {
    const r = await postJson(entrandoComo("duena"), "/cobros/cualquiera/rechazar", {});
    expect(r.estado).toBe(400);
    expect(String(r.cuerpo["mensaje"])).toContain("por qué");
  });

  it("un tipo inventado da «entrada_invalida» y no «ya estaba registrado»", async () => {
    // La guarda de la ruta da el mensaje bueno. Lo que esta prueba fija además
    // es lo de DEBAJO: sin ella, el CHECK de la columna `tipo` saltaba y el
    // `catch` de `registrarComprobante` lo contaba como el UNIQUE de
    // `intento_ref` —en SQLite los dos dicen «constraint»— y respondía 409
    // «ese comprobante ya estaba registrado». Lo medí quitando la guarda.
    //
    // Un error así cuesta tiempo de verdad: quien lo recibe se pone a buscar
    // un comprobante repetido que no existe.
    const { pedidoId } = await unPedido();
    const r = await postJson(entrandoComo("duena"), "/cobros", {
      pedidoId,
      montoCents: 1000,
      metodo: "yappy",
      tipo: "inventado",
      idempotencia: `tipo-${pedidoId}`,
    });
    expect(r.estado).toBe(400);
    expect(r.cuerpo["codigo"]).toBe("entrada_invalida");
  });

  it("un método que no es manual se para en la ruta", async () => {
    const { pedidoId } = await unPedido();
    const r = await postJson(entrandoComo("duena"), "/cobros", {
      pedidoId,
      montoCents: 1000,
      metodo: "tilopay",
      tipo: "abono",
    });
    expect(r.estado).toBe(400);
  });

  it("«?limite=» se respeta, que no es obvio: antes se ignoraba en silencio", async () => {
    // `entero()` pide un `number` y `c.req.query()` devuelve `string`, así que
    // `entero(c.req.query("limite"))` daba `undefined` siempre y la ruta usaba
    // su valor por defecto. No fallaba, no daba 400: ignoraba el parámetro.
    // Pasaba en tres rutas y ninguna prueba lo notaba porque todas pedían sin
    // límite. Esta pide con límite.
    const uno = await unPedido();
    const dos = await unPedido();
    for (const [i, p] of [uno, dos].entries()) {
      await postJson(entrandoComo("duena"), "/cobros", {
        pedidoId: p.pedidoId,
        montoCents: 1000,
        metodo: "yappy",
        tipo: "abono",
        idempotencia: `lim-${p.pedidoId}-${i}`,
      });
    }

    const r = await pedir(entrandoComo("duena"), "/cobros?limite=1");
    expect(r.estado).toBe(200);
    const datos = r.cuerpo["datos"] as { comprobantes: unknown[]; hayMas: boolean };
    expect(datos.comprobantes).toHaveLength(1);
    expect(datos.hayMas).toBe(true);

    // Y un límite imposible se dice, no se redondea a algo razonable.
    const malo = await pedir(entrandoComo("duena"), "/cobros?limite=5000");
    expect(malo.estado).toBe(400);
  });
});
