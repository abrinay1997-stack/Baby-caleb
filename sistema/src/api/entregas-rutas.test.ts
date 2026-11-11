import { env as real } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * Las rutas de entregas (F4.5).
 *
 * EN SU PROPIO ARCHIVO, y el motivo es una lección que costó varios intentos:
 * `panel.test.ts` limpia la base entre pruebas, y las filas de entregas NO SE
 * PUEDEN BORRAR — `envio_eventos` es una bitácora y tiene un trigger que lo
 * impide, porque los libros no se borran. Está bien que la base lo haga
 * cumplir; lo que no cabía era mezclar las dos cosas en un archivo.
 *
 * Aquí no se limpia nada: cada prueba usa identificadores propios, como ya
 * hace `db/entregas.test.ts`.
 *
 * Y se vigila lo que decide LA RUTA, no lo que decide el módulo —eso ya tiene
 * sus 76 pruebas al lado—: el permiso que depende del saldo del pedido, que el
 * motorizado no llegue del cuerpo, y que la clave de la foto no salga nunca.
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

/** El catálogo mínimo que necesita un envío, con códigos propios. */
async function sembrarCatalogo(suf: string): Promise<void> {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,'panal','Pañal Nateen',?,?)",
    ).bind(`p-${suf}`, `panal-${suf}`, T),
    real.DB.prepare(
      `INSERT OR IGNORE INTO variantes
         (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en)
       VALUES ('NAT-M',?, 'Pañal Nateen M','M',144,5000,0,1,?)`,
    ).bind(`p-${suf}`, T),
  ]);
}

describe("/entregas", () => {
  /** Un envío listo para marcarse entregado, con el saldo que se le diga. */
  let n = 0;
  async function unEnvio(saldoCents: number): Promise<string> {
    // Todo único por llamada: aquí no se limpia entre pruebas (ver el
    // `beforeEach`), así que lo que distingue una prueba de otra son los ids.
    const suf = `${Date.now()}-${n++}`;
    const envioId = `env-${suf}`;
    const pedidoId = `ped-${suf}`;
    const clienteId = `cli-${suf}`;
    const lineaId = `lin-${suf}`;
    const bodegaId = `bod-${suf}`;
    await sembrarCatalogo(suf);
    await real.DB.batch([
      real.DB.prepare("INSERT INTO bodegas (id,nombre) VALUES (?,?)"
      ).bind(bodegaId, `Bodega ${suf}`),
      real.DB.prepare(
        "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,'Ana',?,?)",
      ).bind(clienteId, T, T),
      real.DB.prepare(
        `INSERT INTO pedidos
           (id,numero,token,cliente_id,origen,estado,estado_pago,
            subtotal_cents,descuento_cents,envio_cents,itbms_cents,total_cents,
            pagado_cents,abono_minimo_cents,requiere_pago_total,creado_en,actualizado_en)
         VALUES (?,?,?,?,'panel','en_ruta','abonado',
            10000,0,0,0,10000,?,500,0,?,?)`,
      ).bind(pedidoId, `BC-${suf}`, `tok-${suf}`, clienteId, 10000 - saldoCents, T, T),
      // La línea y su reserva: el sistema se niega —con razón— a entregar un
      // pedido que no tiene nada apartado.
      real.DB.prepare(
        `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,itbms_bp,bodega_id)
         VALUES (?,?,'NAT-M','Pañal Nateen M',1,5000,0,?)`,
      ).bind(lineaId, pedidoId, bodegaId),
      real.DB.prepare(
        "INSERT INTO existencias (codigo,bodega_id,fisico,reservado) VALUES ('NAT-M',?,5,1)",
      ).bind(bodegaId),
      // Lo que se APARTÓ, que es de donde sale la mercancía al entregar — no
      // la receta de hoy, sino lo que se quitó cuando se hizo el pedido.
      real.DB.prepare(
        "INSERT INTO pedido_linea_componentes (linea_id,codigo,bodega_id,cantidad) VALUES (?,'NAT-M',?,1)",
      ).bind(lineaId, bodegaId),
      real.DB.prepare(
        `INSERT INTO envios (id,pedido_id,estado,metodo,bodega_id,guia_token,
            cobro_cents,version,creado_en)
         VALUES (?,?,'en_ruta','motorizado',?,?,?,1,?)`,
      ).bind(envioId, pedidoId, bodegaId, `guia-${envioId}`, saldoCents, T),
    ]);
    return envioId;
  }

  it("con saldo por cobrar hace falta poder registrar cobros", async () => {
    // Marcar entregado MUEVE DINERO cuando queda saldo en la puerta, y eso ya
    // no es «mover un pedido», es cobrar. Un middleware no puede saberlo
    // porque la respuesta depende de la fila, así que la ruta lo mira dentro.
    const envioId = await unEnvio(4000);
    const r = await postJson(entrandoComo("asistente"), `/entregas/${envioId}/entregada`, {
      idempotencia: "i1",
      metodoCobro: "efectivo",
      montoCents: 4000,
    });
    expect(r.estado).toBe(403);

    // Y no se entregó: un 403 que igual escribe es peor que no tener 403.
    const e = await real.DB.prepare("SELECT estado FROM envios WHERE id = ?")
      .bind(envioId)
      .first<{ estado: string }>();
    expect(e?.estado).toBe("en_ruta");
  });

  it("sin saldo, la misma persona sí puede cerrarla", async () => {
    // La diferencia no es de rango, es de qué hace falta hacer: una entrega ya
    // pagada se cierra sin tocar dinero.
    const envioId = await unEnvio(0);
    const r = await postJson(entrandoComo("asistente"), `/entregas/${envioId}/entregada`, {
      idempotencia: "i2",
    });
    // Se exige el 200 y no «cualquier cosa menos 403»: con eso bastaba un 422
    // —o sea, no haber entregado nada— para que la prueba pasara.
    expect(r.estado).toBe(200);
    const e = await real.DB.prepare("SELECT estado FROM envios WHERE id = ?")
      .bind(envioId)
      .first<{ estado: string }>();
    expect(e?.estado).toBe("entregado");
  });

  it("el motorizado NO se acepta del cuerpo", async () => {
    // Ese parámetro existe para que quien reparte solo cierre lo suyo. Si
    // llegara del cliente, cualquiera cerraría la parada de cualquiera.
    const envioId = await unEnvio(0);
    await real.DB.prepare(
      "INSERT INTO motorizados (id,nombre,celular_e164,estado,creado_en) VALUES (?,?,?,'activo',?)",
    )
      .bind(`m-otro-${n}`, `Otro ${n}`, `5079${String(n).padStart(7, "0")}`, T)
      .run();

    const r = await postJson(entrandoComo("duena"), `/entregas/${envioId}/entregada`, {
      idempotencia: `i3-${n}`,
      motorizadoId: `m-otro-${n}`,
    });
    // Se entrega igual: el campo se ignora, no hace fallar la petición.
    expect(r.estado).toBe(200);
    const e = await real.DB.prepare("SELECT motorizado_id FROM envios WHERE id = ?")
      .bind(envioId)
      .first<{ motorizado_id: string | null }>();
    expect(e?.motorizado_id).toBeNull();
  });

  it("la foto de una entrega que no tiene foto es 404, no un error", async () => {
    const envioId = await unEnvio(0);
    const r = await pedir(entrandoComo("duena"), `/entregas/${envioId}/prueba`);
    expect(r.estado).toBe(404);
  });

  it("el día trae a quién se le puede asignar la ruta, y no a quien no", async () => {
    // Se comprueba EL FILTRO, no que la tabla esté vacía: aquí no se limpia
    // entre pruebas, así que una lista exacta fallaría en cuanto otra prueba
    // cree un motorizado. Lo que importa es que el activo salga y el inactivo
    // no, y eso es cierto con la tabla como esté.
    const suf = `${Date.now()}-${n++}`;
    const activo = `m-act-${suf}`;
    const inactivo = `m-ina-${suf}`;
    await real.DB.batch([
      real.DB.prepare(
        "INSERT INTO motorizados (id,nombre,celular_e164,estado,creado_en) VALUES (?,?,?,'activo',?)",
      ).bind(activo, `Luis ${suf}`, `5076${String(n).padStart(7, "0")}`, T),
      // Inactivo: no se ofrece, porque no entra a trabajar.
      real.DB.prepare(
        "INSERT INTO motorizados (id,nombre,celular_e164,estado,creado_en) VALUES (?,?,?,'inactivo',?)",
      ).bind(inactivo, `Pedro ${suf}`, `5075${String(n).padStart(7, "0")}`, T),
    ]);

    const r = await pedir(entrandoComo("duena"), "/entregas");
    expect(r.estado).toBe(200);
    const ids = (r.cuerpo.datos as { motorizados: { id: string }[] }).motorizados.map((m) => m.id);
    expect(ids).toContain(activo);
    expect(ids).not.toContain(inactivo);
  });
});
