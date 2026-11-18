import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { crearPedido } from "../../db/pedidos";
import type { Contexto } from "../registro";
import { verAvisosDePago } from "./avisos-de-pago";

/**
 * «Ya pagué» — y el sistema dice que no.
 *
 * Esta herramienta existe para esa conversación. Lo que se vigila aquí son las
 * tres respuestas que la dueña necesita distinguir, porque llevan a tres
 * acciones distintas con una clienta esperando al otro lado.
 */

const ahora = () => Date.now();
let n = 0;
const ctx = (): Contexto => ({
  db: env.DB,
  ahora: ahora(),
  usuario: { id: "u1", correo: "duena@babycaleb.com", rol: "duena" },
  canal: "panel",
  conversacionId: null,
});

/**
 * El escenario se arma con `crearPedido`, la puerta de verdad.
 *
 * Mi primera versión insertaba la fila de `pedidos` a mano y se estrelló dos
 * veces contra columnas obligatorias (`token`, `abono_minimo_cents`). Eso no
 * es solo incomodidad: una fila montada a mano puede quedar en un estado que
 * el sistema nunca produce, y entonces la prueba comprueba algo que no pasa.
 */
async function escenario(opciones: {
  readonly avisoDecia?: string | undefined;
  readonly pagaElPedidoEntero: boolean;
}) {
  const sufijo = `${Date.now()}-${n++}`;
  const clienteId = `cli-av-${sufijo}`;

  await env.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)")
    .bind(clienteId, "Ana", ahora(), ahora())
    .run();
  await env.DB.batch([
    env.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    env.DB.prepare(
      "UPDATE existencias SET fisico = 50 WHERE codigo = 'NAT-M' AND bodega_id = (SELECT id FROM bodegas WHERE activa = 1 LIMIT 1)",
    ),
  ]);

  const p = await crearPedido(
    {
      db: env.DB,
      ahora: ahora(),
      actor: "pruebas",
      abonoMinimoCents: 500,
      minutosParaAbonar: 120,
    },
    {
      idempotencia: `idem-av-${sufijo}`,
      clienteId,
      origen: "web",
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
    },
  );
  if (!p.ok) throw new Error(p.mensaje);

  const fila = (await env.DB.prepare("SELECT numero, total_cents FROM pedidos WHERE id = ?")
    .bind(p.datos.id)
    .first<{ numero: string; total_cents: number }>())!;

  const pagoId = `pag-av-${sufijo}`;
  const ref = `REF${sufijo}`.replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO pagos (id, pedido_id, proveedor, metodo, tipo, estado, monto_cents,
                        intento_ref, creado_en, actualizado_en)
     VALUES (?, ?, 'yappy', 'yappy', 'total', 'esperando_cliente', ?, ?, ?, ?)`,
  )
    .bind(pagoId, p.datos.id, fila.total_cents, ref, ahora(), ahora())
    .run();

  if (opciones.pagaElPedidoEntero) {
    await env.DB.prepare("UPDATE pedidos SET pagado_cents = total_cents WHERE id = ?")
      .bind(p.datos.id)
      .run();
  }

  if (opciones.avisoDecia !== undefined) {
    await env.DB.prepare(
      `INSERT INTO eventos_pasarela (id, proveedor, evento_id, firma_valida, cuerpo_sha256, resultado, recibido_en)
       VALUES (?, 'yappy', ?, 1, 'sha', ?, ?)`,
    )
      .bind(`ev-${sufijo}`, `consulta:${ref}:${opciones.avisoDecia}`, opciones.avisoDecia, ahora())
      .run();
  }
  return { numero: fila.numero, ref };
}

describe("ver_avisos_de_pago", () => {
  /**
   * NO ENCONTRAR NADA NO ES UN ERROR.
   *
   * «No llegó ningún aviso» es una respuesta ÚTIL: significa que el pago no se
   * terminó en el teléfono de la clienta. Lanzar un error la convertiría en
   * «algo falló» y mandaría a la dueña a buscar un problema técnico que no
   * existe (`docs/TRAMPAS.md` §7: cero no es «no se sabe»).
   */
  it("sin avisos lo dice y explica qué significa, sin fallar", async () => {
    const e = await escenario({ pagaElPedidoEntero: false });
    const r = (await verAvisosDePago.ejecutar(ctx(), { pedido: e.numero })) as Record<string, unknown>;

    expect(r.avisos).toBe(0);
    expect(r.existe_el_pedido).toBe(true);
    expect(String(r.aviso)).toMatch(/no ha llegado ningún aviso/i);
  });

  it("un número que no existe lo dice distinto: no es lo mismo", async () => {
    const r = (await verAvisosDePago.ejecutar(ctx(), { pedido: "BC-NOEXISTE" })) as Record<string, unknown>;
    expect(r.existe_el_pedido).toBe(false);
    expect(String(r.aviso)).toMatch(/no existe/i);
  });

  /**
   * EL CASO QUE HAY QUE GRITAR.
   *
   * La pasarela dijo que cobró y el pedido sigue sin pagarse. Puede ser que el
   * monto no cuadrara —y entonces hay dinero cobrado que se dejó sin aplicar a
   * propósito, esperando que alguien lo mire— o un fallo al escribir. Las dos
   * acaban con una clienta que pagó y no tiene pedido, así que esto NO puede
   * quedarse como una fila más de una lista.
   */
  it("si la pasarela cobró y el pedido sigue sin pagar, lo grita", async () => {
    const e = await escenario({ avisoDecia: "aprobado", pagaElPedidoEntero: false });
    const r = (await verAvisosDePago.ejecutar(ctx(), { pedido: e.numero })) as Record<string, unknown>;

    expect(r.hay_que_mirarlo).toBe(true);
    expect(String(r.aviso)).toMatch(/SIGUE SIN PAGARSE/);
  });

  it("si cobró y el pedido quedó pagado, no grita nada", async () => {
    const e = await escenario({ avisoDecia: "aprobado", pagaElPedidoEntero: true });
    const r = (await verAvisosDePago.ejecutar(ctx(), { pedido: e.numero })) as Record<string, unknown>;

    expect(r.hay_que_mirarlo).toBe(false);
    expect(String(r.aviso)).toMatch(/quedó pagado/i);
  });

  /**
   * Y un rechazo explica POR QUÉ, que es lo que la dueña le repite a la
   * clienta. «Falló el pago» no sirve: no se contesta igual a «no confirmaste
   * en cinco minutos» que a «lo cancelaste».
   */
  it("un rechazo dice el motivo, no solo que falló", async () => {
    const e = await escenario({ avisoDecia: "rechazado", pagaElPedidoEntero: false });
    const r = (await verAvisosDePago.ejecutar(ctx(), { pedido: e.numero })) as Record<string, unknown>;

    expect(r.hay_que_mirarlo).toBe(false);
    expect(String(r.aviso)).toMatch(/cinco minutos/);
  });

  it("también se puede buscar por la referencia del cobro, que es lo que se ve en el panel de Yappy", async () => {
    const e = await escenario({ avisoDecia: "ejecutado", pagaElPedidoEntero: true });
    const r = (await verAvisosDePago.ejecutar(ctx(), { pedido: e.ref })) as Record<string, unknown>;
    expect(r.avisos).toBe(1);
  });

  it("es de lectura: no cambia nada", () => {
    expect(verAvisosDePago.nivel).toBe("lectura");
  });
});
