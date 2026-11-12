import { env as real } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel } from "./panel";

/**
 * EL CIRCUITO ENTERO, por las rutas, como lo recorre una persona.
 *
 * ## Por qué existe este archivo
 *
 * El sistema tiene más de mil setecientas pruebas y todas prueban PIEZAS.
 * Ninguna recorría el camino completo por las rutas HTTP. Las de entregas
 * siembran el pedido con SQL directo —`INSERT INTO pedidos … 'en_ruta'`— así
 * que demuestran que `marcarEntregada` funciona sobre una fila que alguien
 * escribió a mano, no que un pedido pueda LLEGAR a ese estado por las puertas
 * que usa el negocio. Y en la base de producción hay 0 pedidos, 0 pagos, 0
 * envíos y 0 asientos: el circuito está construido y nunca ha corrido.
 *
 * Es la trampa nº 12 del repositorio en su forma más caída: «comprueban que la
 * pieza funciona, no que esté enchufada». Un eslabón que pide algo que el
 * anterior no da no lo ve ninguna prueba de unidad, porque cada una se siembra
 * su propio punto de partida.
 *
 * Aquí **nada se siembra con SQL salvo lo que no tiene puerta**: el catálogo,
 * las existencias, el costo de apertura y el motorizado (ver `sembrar`). Todo
 * lo demás —la clienta, la zona, el pedido, el cobro, la confirmación, el
 * envío, la ruta, el despacho, la entrega y el cierre del día— pasa por su
 * ruta del panel, con el cuerpo que esa ruta pide.
 *
 * ## Dos reglas de cómo están escritas estas pruebas
 *
 *  1. **Identificadores propios y únicos en cada corrida.** La base no se
 *     limpia entre pruebas del mismo archivo (lo comprobé: una fila escrita en
 *     la primera sigue ahí en la segunda), y los libros —`asientos`,
 *     `movimientos_inventario`, `envio_eventos`— tienen triggers que prohíben
 *     borrarlos. Está bien que los tengan: aquí no se borra nada.
 *  2. **Se cuentan DIFERENCIAS, no totales.** Un `toEqual` sobre el total de
 *     una tabla pasa hoy y se cae el día que otra prueba siembre al lado, y
 *     entonces lo que se arregla es la prueba y no el sistema.
 *
 * ## Qué se rompió a propósito para saber que esto vigila algo
 *
 * La trampa nº 6 dice que una prueba se valida rompiendo lo que vigila. Las
 * siete mutaciones que se probaron, y la prueba se puso roja con las siete:
 *
 *  1. `marcarEntregada` sin el asiento 3 → la lista de hechos sale `['1','3b','4']`.
 *  2. La entrega baja `fisico` y no `reservado` → el apartado se queda en 3.
 *  3. `enunciadosDeAsiento` sin la fila de `control_cuadre` → `diferencia` sale
 *     `null`, que es justo lo que el LEFT JOIN de `asientosDe` existe para ver.
 *  4. `cancelar` sin liberar lo apartado → el reservado no vuelve a cero.
 *  5. `confirmarPago` que no agenda → `agendado: false`.
 *  6. El ingreso por envío a 4101 en vez de 4102 → lo caza la comparación por
 *     cuenta. Esta es la que importa: ese asiento CUADRA igual, así que el
 *     cuadre solo no lo habría visto nunca.
 *  7. La siembra sin `valor_inventario` → `costoDesconocido: true` y sin
 *     asiento 3b. Y la entrega sigue dando 200, que es el hueco de producción
 *     que el reporte de este trabajo nombra.
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

/** La dueña: es la que puede tomar pedidos, cobrar y despachar. */
const duena = entrandoComo("duena");

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

/**
 * `datos` de una respuesta que tenía que salir bien.
 *
 * El `expect` del estado va DENTRO para que, cuando un paso del circuito
 * falle, el error diga qué ruta fue y con qué mensaje, en vez de un
 * «undefined no tiene id» tres pasos más abajo.
 */
function datosDe<T>(
  r: { estado: number; cuerpo: Record<string, unknown> },
  ruta: string,
  esperado = 200,
): T {
  expect(r.estado, `${ruta} respondió ${r.estado}: ${JSON.stringify(r.cuerpo)}`).toBe(esperado);
  return r.cuerpo["datos"] as T;
}

// ---------------------------------------------------------------------------
// Lo único que se siembra con SQL, y por qué cada cosa
// ---------------------------------------------------------------------------

/** Números de teléfono inventados, uno por clienta de prueba. */
let n = 0;

interface Sembrado {
  readonly suf: string;
  readonly codigo: string;
  readonly bodegaId: string;
  readonly bodega: string;
  readonly motorizadoId: string;
  readonly motorizado: string;
  /** Lo que cuesta una caja, puesto en bodega. Inventado, y aquí se dice. */
  readonly costoUnitCents: number;
  readonly precioUnitCents: number;
  readonly cajas: number;
}

/**
 * El punto de partida del negocio: catálogo, bodega, existencias, costo y un
 * motorizado.
 *
 * Las cuatro primeras cosas son «la siembra inicial del catálogo y las
 * existencias», que es lo que una base recién migrada ya trae (migración 0003)
 * y que aquí se repite con códigos propios para no contar sobre las filas de
 * nadie.
 *
 * Las otras dos NO son una comodidad de la prueba: son dos datos que el
 * circuito necesita y que **no tienen ninguna puerta** por donde entrar.
 *
 *  · **`valor_inventario` (el costo promedio).** Ningún archivo de `src/`
 *    inserta en esa tabla: se lee al entregar, se baja al entregar, se sube al
 *    devolver y se borra con la variante — pero nadie la llena nunca. El
 *    `costoUnitCents` que acepta `POST /existencias/movimientos` acaba en
 *    `movimientos_inventario.costo_unit_cents` y no toca el promedio. Sin esta
 *    fila, `marcarEntregada` contesta `costoDesconocido: true`, se salta el
 *    asiento 3b y el pedido cae en «entregados sin costo» del cierre — que es
 *    el comportamiento correcto (trampa nº 7: un cero afirmaría que la
 *    mercancía no costó nada y pondría el margen en 100 %), pero significa que
 *    HOY, en producción, ninguna entrega podrá tener su costo.
 *  · **El motorizado.** El panel lista los motorizados en `GET /entregas` y
 *    `armarRuta` exige uno, pero no hay ninguna ruta que dé de alta a uno. Sin
 *    esta fila el circuito se corta en «armar la ruta» y no hay forma de
 *    seguir desde ninguna pantalla.
 *
 * Las dos quedan dichas aquí y en el reporte, no disimuladas.
 */
async function sembrar(etiqueta: string): Promise<Sembrado> {
  const suf = `${etiqueta}-${Date.now()}-${n++}`;
  const codigo = `CIRC-${suf}`;
  const bodegaId = `bod-circ-${suf}`;
  const bodega = `Bodega del circuito ${suf}`;
  const motorizadoId = `mot-circ-${suf}`;
  const motorizado = `Fulano de Prueba (inventado) ${suf}`;
  const cajas = 12;
  const costoUnitCents = 900;
  const precioUnitCents = 2500;

  await real.DB.batch([
    real.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,'panal',?,?,?)",
    ).bind(`pro-circ-${suf}`, `Pañal de prueba del circuito ${suf}`, `circuito-${suf}`, T),
    real.DB.prepare(
      `INSERT INTO variantes
         (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en)
       VALUES (?,?,?,'M',144,?,0,1,?)`,
    ).bind(codigo, `pro-circ-${suf}`, `Pañal de prueba del circuito ${suf} — M`, precioUnitCents, T),
    real.DB.prepare("INSERT INTO bodegas (id,nombre) VALUES (?,?)").bind(bodegaId, bodega),
    real.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,?,0,NULL)",
    ).bind(codigo, bodegaId, cajas),
    // El costo de apertura. Sin puerta: ver la nota de arriba.
    real.DB.prepare(
      "INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,?,?)",
    ).bind(codigo, cajas, cajas * costoUnitCents),
    // El motorizado. Sin puerta: ver la nota de arriba.
    real.DB.prepare(
      "INSERT INTO motorizados (id,nombre,celular_e164,estado,vehiculo,creado_en) VALUES (?,?,?,'activo','moto',?)",
    ).bind(motorizadoId, motorizado, `5076${String(400_0000 + n).padStart(7, "0")}`, T),
  ]);

  return {
    suf,
    codigo,
    bodegaId,
    bodega,
    motorizadoId,
    motorizado,
    costoUnitCents,
    precioUnitCents,
    cajas,
  };
}

// ---------------------------------------------------------------------------
// Lo que se mira para saber si el circuito hizo su trabajo
// ---------------------------------------------------------------------------

/** Lo apartado y lo que hay, de una variante en una bodega. */
async function existencias(s: Sembrado): Promise<{ fisico: number; reservado: number }> {
  const f = await real.DB.prepare(
    "SELECT fisico, reservado FROM existencias WHERE codigo = ? AND bodega_id = ?",
  )
    .bind(s.codigo, s.bodegaId)
    .first<{ fisico: number; reservado: number }>();
  if (f === null) throw new Error("la siembra no dejó existencias");
  return f;
}

interface AsientoVisto {
  readonly hecho: string;
  readonly diferencia: number | null;
  readonly debe: number;
  readonly haber: number;
  readonly lineas: Record<string, number>;
}

/**
 * Los asientos de UN pedido y de SUS pagos, con su cuadre y sus líneas.
 *
 * Por referencia y no por fecha ni por un `ORDER BY creado_en DESC`: en esta
 * base hay asientos de otras pruebas, y «el último asiento» es la clase de
 * atajo que pasa solo mientras el archivo corre solo.
 *
 * `diferencia` viene de `control_cuadre` con un LEFT JOIN a propósito. La
 * columna tiene `CHECK (diferencia = 0)`, así que una fila que existe cuadra
 * por construcción; lo que hay que poder distinguir es el asiento al que le
 * FALTA la fila, y eso con un JOIN normal no se vería: el asiento sin cuadre
 * desaparecería de la lista y la prueba diría que todo está bien.
 */
async function asientosDe(pedidoId: string): Promise<AsientoVisto[]> {
  const { results } = await real.DB.prepare(
    `SELECT a.id, a.hecho, cc.diferencia AS diferencia
       FROM asientos a
       LEFT JOIN control_cuadre cc ON cc.asiento_id = a.id
      WHERE (a.referencia_tipo = 'pedido' AND a.referencia_id = ?1)
         OR (a.referencia_tipo = 'pago'
             AND a.referencia_id IN (SELECT id FROM pagos WHERE pedido_id = ?1))
      ORDER BY a.hecho, a.creado_en`,
  )
    .bind(pedidoId)
    .all<{ id: string; hecho: string; diferencia: number | null }>();

  const vistos: AsientoVisto[] = [];
  for (const a of results) {
    const { results: lineas } = await real.DB.prepare(
      `SELECT c.codigo AS codigo, l.debe_cents AS debe, l.haber_cents AS haber
         FROM asiento_lineas l JOIN cuentas c ON c.id = l.cuenta_id
        WHERE l.asiento_id = ?`,
    )
      .bind(a.id)
      .all<{ codigo: string; debe: number; haber: number }>();

    const porCuenta: Record<string, number> = {};
    let debe = 0;
    let haber = 0;
    for (const l of lineas) {
      // Con signo: debe positivo, haber negativo. Así una cuenta que aparece
      // en los dos lados del mismo asiento (2101 del asiento 16) no se cuenta
      // dos veces con el signo perdido.
      porCuenta[l.codigo] = (porCuenta[l.codigo] ?? 0) + l.debe - l.haber;
      debe += l.debe;
      haber += l.haber;
    }
    vistos.push({ hecho: a.hecho, diferencia: a.diferencia, debe, haber, lineas: porCuenta });
  }
  return vistos;
}

/**
 * El saldo que los asientos de ESTE pedido dejaron en una cuenta.
 *
 * Es la comprobación que de verdad cierra el circuito: después de entregar y
 * cobrar, 1201 («te deben») y 2101 («anticipos de clientas») tienen que volver
 * a cero para este pedido. Un asiento que falte o que vaya a la cuenta
 * equivocada cuadra igual —las dos columnas salen del mismo número— y solo se
 * nota mirando el saldo por cuenta.
 */
async function saldoDeCuenta(pedidoId: string, codigo: string): Promise<number> {
  const f = await real.DB.prepare(
    `SELECT COALESCE(SUM(l.debe_cents - l.haber_cents), 0) AS saldo
       FROM asiento_lineas l
       JOIN asientos a ON a.id = l.asiento_id
       JOIN cuentas c ON c.id = l.cuenta_id
      WHERE c.codigo = ?2
        AND ((a.referencia_tipo = 'pedido' AND a.referencia_id = ?1)
          OR (a.referencia_tipo = 'pago'
              AND a.referencia_id IN (SELECT id FROM pagos WHERE pedido_id = ?1)))`,
  )
    .bind(pedidoId, codigo)
    .first<{ saldo: number }>();
  return f?.saldo ?? 0;
}

/** Lo que el inventario dice que salió por este envío. */
async function movimientosDe(envioId: string) {
  const { results } = await real.DB.prepare(
    `SELECT codigo, delta, tipo, costo_unit_cents
       FROM movimientos_inventario
      WHERE referencia_tipo = 'envio' AND referencia_id = ?`,
  )
    .bind(envioId)
    .all<{ codigo: string; delta: number; tipo: string; costo_unit_cents: number | null }>();
  return results;
}

// ---------------------------------------------------------------------------

describe("el circuito entero, por las rutas", () => {
  /**
   * Una clienta nueva, por su ruta.
   *
   * El celular es inventado y se nota: la ficha dice «de Prueba (inventada)».
   * Tiene que ser único en cada llamada porque `clientes.celular_e164` es
   * UNIQUE —y eso está bien: es la defensa contra la misma señora con tres
   * fichas— así que un número fijo haría que la segunda prueba recibiera la
   * clienta de la primera y contara sus pedidos.
   */
  async function unaClienta(etiqueta: string): Promise<{ clienteId: string; nombre: string }> {
    const nombre = `Yarielis de Prueba (inventada) ${etiqueta}`;
    const celular = `6555${String(1000 + n).padStart(4, "0")}`;
    const r = await postJson(duena, "/clientes", { nombre, celular });
    const d = datosDe<{ clienteId: string; nuevo: boolean }>(r, "POST /clientes", 201);
    expect(d.nuevo, "la clienta de esta prueba tenía que ser nueva").toBe(true);
    return { clienteId: d.clienteId, nombre };
  }

  /** La zona a la que se entrega, por su ruta. El método manda: motorizado. */
  async function unaZona(s: Sembrado, tarifaCents: number): Promise<string> {
    const nombre = `Barrio de prueba ${s.suf}`;
    const r = await postJson(duena, "/zonas", {
      nombre,
      region: "ciudad",
      // De aquí sale `envios.metodo`, y de ahí que la parada pueda entrar en
      // la ruta de un motorizado: `armarRuta` rechaza las que van por
      // Ferguson o por «otro». Una zona mal puesta corta el circuito tres
      // pasos más abajo, con un mensaje que no la nombra.
      metodo: "motorizado",
      tarifaCents,
      bodegaPreferidaId: s.bodegaId,
    });
    datosDe<{ id: string; nombre: string }>(r, "POST /zonas", 201);
    return nombre;
  }

  it("de la clienta al asiento: el pedido llega, el stock sale y los libros cuadran", async () => {
    const s = await sembrar("ok");
    const antes = await existencias(s);
    const { clienteId, nombre } = await unaClienta(s.suf);
    const zona = await unaZona(s, 350);

    const CAJAS = 3;
    const SUBTOTAL = CAJAS * s.precioUnitCents; // 7 500
    const ENVIO = 350;
    const TOTAL = SUBTOTAL + ENVIO; // 7 850 · sin ITBMS (05 §6b: no aplica)
    const ABONO = 2000;
    const SALDO = TOTAL - ABONO; // 5 850, lo que cobra el motorizado en la puerta
    const COSTO = CAJAS * s.costoUnitCents; // 2 700

    // ── 1. El pedido ────────────────────────────────────────────────────────
    const pedido = datosDe<{
      id: string;
      numero: string;
      totalCents: number;
      envioCents: number;
      abonoMinimoCents: number;
      requierePagoTotal: boolean;
    }>(
      await postJson(duena, "/pedidos", {
        idempotencia: `circ-${s.suf}`,
        clienteId,
        zona,
        lineas: [{ codigo: s.codigo, cantidad: CAJAS, bodega: s.bodega }],
        notasCliente: "Prueba del circuito completo. Gente inventada.",
      }),
      "POST /pedidos",
      201,
    );
    expect(pedido.numero).toMatch(/^BC-/);
    // El precio y el envío los pone el SERVIDOR: el cuerpo de arriba no tiene
    // dónde escribir un precio, y esta igualdad es la que lo demuestra.
    expect({ total: pedido.totalCents, envio: pedido.envioCents }).toEqual({
      total: TOTAL,
      envio: ENVIO,
    });

    // ── 2. El stock quedó APARTADO, no vendido ──────────────────────────────
    //
    // Es la distinción que sostiene el resto: `reservado` sube y `fisico` NO
    // baja. Si bajara aquí, la mercancía estaría fuera del inventario antes de
    // que nadie la entregue, y una cancelación tendría que «devolver» algo que
    // los libros ya dieron por salido.
    const apartado = await existencias(s);
    expect({
      fisico: apartado.fisico - antes.fisico,
      reservado: apartado.reservado - antes.reservado,
    }).toEqual({ fisico: 0, reservado: CAJAS });

    // ── 3. Agendar sin abono NO se puede ────────────────────────────────────
    const sinAbono = await postJson(duena, `/pedidos/${pedido.id}/agendar`, {});
    expect(sinAbono.estado, JSON.stringify(sinAbono.cuerpo)).toBe(422);
    expect(sinAbono.cuerpo["codigo"]).toBe("transicion_invalida");

    // ── 4. El abono: se anota, y después una persona lo confirma ────────────
    //
    // Son dos hechos distintos y el sistema no los junta: «alguien dice que
    // pagó» entra en `confirmando` y no mueve el pedido.
    const comprobante = datosDe<{ pagoId: string }>(
      await postJson(duena, "/cobros", {
        pedidoId: pedido.id,
        montoCents: ABONO,
        metodo: "yappy",
        tipo: "abono",
        idempotencia: `circ-abono-${s.suf}`,
      }),
      "POST /cobros",
    );

    const quietoAun = await real.DB.prepare(
      "SELECT estado, pagado_cents FROM pedidos WHERE id = ?",
    )
      .bind(pedido.id)
      .first<{ estado: string; pagado_cents: number }>();
    expect(quietoAun, "un comprobante sin confirmar no mueve el pedido").toEqual({
      estado: "por_abonar",
      pagado_cents: 0,
    });

    const confirmado = datosDe<{ pagadoCents: number; agendado: boolean }>(
      await postJson(duena, `/cobros/${comprobante.pagoId}/confirmar`, {}),
      "POST /cobros/:pagoId/confirmar",
    );
    expect(confirmado.pagadoCents).toBe(ABONO);

    // ── 5. Y aquí el pedido YA está agendado ────────────────────────────────
    //
    // No hubo que llamar a `/pedidos/:id/agendar`: `confirmarPago` agenda en el
    // MISMO batch que entra el dinero, porque el abono ya alcanza el mínimo
    // copiado en el pedido. Lo dice en su respuesta, y se exige, porque es un
    // eslabón del circuito que ninguna pantalla pulsa.
    expect(confirmado.agendado, "el cobro que alcanza el mínimo tiene que agendar").toBe(true);

    // Por eso la ruta explícita contesta 422: no es que falle, es que el paso
    // ya está dado. Se comprueba para que quede escrito cuál es la respuesta
    // de verdad — si algún día `confirmarPago` deja de agendar, esto se cae y
    // señala el sitio.
    const yaAgendado = await postJson(duena, `/pedidos/${pedido.id}/agendar`, {});
    expect(yaAgendado.estado, JSON.stringify(yaAgendado.cuerpo)).toBe(422);
    expect(String(yaAgendado.cuerpo["mensaje"])).toContain("agendado");

    // ── 6. La pantalla del día ya tiene trabajo ─────────────────────────────
    //
    // El eslabón entre tomar un pedido y repartirlo: un pedido agendado sin
    // envío sale en `porPreparar`. Si no saliera, la dueña abriría la pantalla
    // de entregas vacía teniendo trabajo esperando, y nada fallaría.
    const dia = datosDe<{ porPreparar: { pedidoId: string; saldoCents: number }[] }>(
      await pedir(duena, "/entregas"),
      "GET /entregas",
    );
    const esperando = dia.porPreparar.find((p) => p.pedidoId === pedido.id);
    expect(esperando, "el pedido agendado no sale en «por preparar»").toBeDefined();
    expect(esperando?.saldoCents).toBe(SALDO);

    // ── 7. El envío ─────────────────────────────────────────────────────────
    const envio = datosDe<{
      envioId: string;
      bodegaId: string;
      metodo: string;
      cobroCents: number;
    }>(
      await postJson(duena, `/entregas/pedidos/${pedido.id}`, {}),
      "POST /entregas/pedidos/:pedidoId",
      201,
    );
    // La bodega sale de donde está APARTADO, no de la preferida de la zona:
    // mandar al motorizado a otra bodega es mandarlo a buscar lo que no está.
    expect({ bodega: envio.bodegaId, metodo: envio.metodo, cobro: envio.cobroCents }).toEqual({
      bodega: s.bodegaId,
      metodo: "motorizado",
      cobro: SALDO,
    });

    // A quién le toca. No asigna: propone, y el motorizado de esta prueba
    // tiene que estar entre los candidatos (se busca el propio, no se cuenta
    // la lista: otras pruebas del archivo siembran los suyos).
    const candidatos = datosDe<{ candidatos: { motorizado_id: string; proponible: boolean }[] }>(
      await pedir(duena, `/entregas/${envio.envioId}/candidatos`),
      "GET /entregas/:envioId/candidatos",
    );
    const mio = candidatos.candidatos.find((c) => c.motorizado_id === s.motorizadoId);
    expect(mio, "el motorizado de esta prueba no sale entre los candidatos").toBeDefined();
    expect(mio?.proponible, "va vacío: se le puede proponer").toBe(true);

    // ── 8. La ruta del día, y a la calle ────────────────────────────────────
    const ruta = datosDe<{ rutaId: string; paradas: { envioId: string; orden: number }[] }>(
      await postJson(duena, "/entregas/rutas", {
        motorizadoId: s.motorizadoId,
        bodegaId: s.bodegaId,
        envioIds: [envio.envioId],
      }),
      "POST /entregas/rutas",
      201,
    );
    expect(ruta.paradas).toEqual([{ envioId: envio.envioId, orden: 1 }]);

    const despachada = datosDe<{ paradas: number; pedidos: number }>(
      await postJson(duena, `/entregas/rutas/${ruta.rutaId}/despachar`, {}),
      "POST /entregas/rutas/:rutaId/despachar",
    );
    expect(despachada).toEqual({ paradas: 1, pedidos: 1 });

    // Despachar mueve el PEDIDO, no solo la parada: `marcarEntregada` exige
    // `en_ruta` y sin esta transición el último paso no se podría dar.
    const enRuta = await real.DB.prepare("SELECT estado FROM pedidos WHERE id = ?")
      .bind(pedido.id)
      .first<{ estado: string }>();
    expect(enRuta?.estado).toBe("en_ruta");

    // Y el stock sigue solo APARTADO mientras la caja va en la moto.
    const enCamino = await existencias(s);
    expect({
      fisico: enCamino.fisico - antes.fisico,
      reservado: enCamino.reservado - antes.reservado,
    }).toEqual({ fisico: 0, reservado: CAJAS });

    // ── 9. Entregada, cobrando el saldo en la puerta ────────────────────────
    const entregada = datosDe<{
      cobradoCents: number;
      pedidoEntregado: boolean;
      costoDesconocido: boolean;
      yaEstaba: boolean;
    }>(
      await postJson(duena, `/entregas/${envio.envioId}/entregada`, {
        idempotencia: `circ-entrega-${s.suf}`,
        metodoCobro: "efectivo",
        montoCents: SALDO,
        nota: "Entregado a la clienta inventada.",
      }),
      "POST /entregas/:envioId/entregada",
    );
    expect(entregada.cobradoCents).toBe(SALDO);
    expect(entregada.pedidoEntregado).toBe(true);
    // El costo se sabe porque esta prueba sembró el promedio. Se exige para
    // que la siembra sea LOAD-BEARING: si alguien la quita creyendo que es
    // decorativa, esto se pone rojo en vez de pasar en silencio con el asiento
    // 3b ausente.
    expect(entregada.costoDesconocido).toBe(false);

    // ── 10. El final: la mercancía salió de verdad ──────────────────────────
    const fin = await existencias(s);
    expect({
      fisico: fin.fisico - antes.fisico,
      reservado: fin.reservado - antes.reservado,
    }).toEqual({ fisico: -CAJAS, reservado: 0 });

    const movimientos = await movimientosDe(envio.envioId);
    expect(movimientos).toEqual([
      {
        codigo: s.codigo,
        delta: -CAJAS,
        tipo: "venta",
        costo_unit_cents: s.costoUnitCents,
      },
    ]);

    // El promedio bajó con la salida, no después.
    const promedio = await real.DB.prepare(
      "SELECT unidades, valor_cents FROM valor_inventario WHERE codigo = ?",
    )
      .bind(s.codigo)
      .first<{ unidades: number; valor_cents: number }>();
    expect(promedio).toEqual({
      unidades: s.cajas - CAJAS,
      valor_cents: s.cajas * s.costoUnitCents - COSTO,
    });

    // ── 11. El pedido, por su ruta ──────────────────────────────────────────
    const leido = datosDe<{
      estado: string;
      estado_pago: string;
      cliente: string | null;
      zona: string | null;
      total_cents: number;
      pagado_cents: number;
      saldo_cents: number;
      items: { costo_unit_cents: number | null }[];
    }>(await pedir(duena, `/pedidos/${pedido.id}`), "GET /pedidos/:id");
    // La clienta que se dio de alta en el primer paso es la del pedido, y la
    // zona que se creó es la que quedó pegada. Son los dos extremos del
    // circuito mirándose: sin esto, un `clienteId` que no casara con nada
    // dejaría el pedido sin dueña y nada fallaría hasta que alguien lo buscara.
    expect({ cliente: leido.cliente, zona: leido.zona }).toEqual({ cliente: nombre, zona });
    expect({
      estado: leido.estado,
      pago: leido.estado_pago,
      total: leido.total_cents,
      pagado: leido.pagado_cents,
      saldo: leido.saldo_cents,
    }).toEqual({
      estado: "entregado",
      pago: "pagado",
      total: TOTAL,
      pagado: TOTAL,
      saldo: 0,
    });
    // El costo quedó COPIADO en la línea: un cambio del promedio mañana no
    // reescribe la venta de hoy (05 §4).
    expect(leido.items.map((i) => i.costo_unit_cents)).toEqual([s.costoUnitCents]);

    // ── 12. Y los libros ────────────────────────────────────────────────────
    const asientos = await asientosDe(pedido.id);

    // Los cuatro hechos del documento, ni uno más ni uno menos: el abono (1),
    // la venta (3), su costo (3b) y el cobro del saldo en la caja del
    // motorizado (4). Se exige la lista EXACTA porque está acotada a este
    // pedido y a sus pagos: un asiento de más aquí es un asiento inventado.
    expect(asientos.map((a) => a.hecho)).toEqual(["1", "3", "3b", "4"]);

    // CUADRAN: cada uno tiene su fila de `control_cuadre` y en 0. La fila que
    // falta es lo que este LEFT JOIN existe para ver —un asiento sin cuadre no
    // lo impide SQLite, lo dice el propio esquema— y sale como `null`.
    for (const a of asientos) {
      expect(a.diferencia, `al asiento ${a.hecho} le falta su cuadre`).toBe(0);
      expect(a.debe, `el asiento ${a.hecho} no cuadra`).toBe(a.haber);
    }

    const porHecho = new Map(asientos.map((a) => [a.hecho, a]));
    // Asiento 1 · el abono entró a Yappy y es un pasivo: dinero de la clienta
    // que todavía hay que ganarse.
    expect(porHecho.get("1")?.lineas).toEqual({ "1101": ABONO, "2101": -ABONO });
    // Asiento 3 · la venta se reconoce AL ENTREGAR. El anticipo se cancela, lo
    // que falta se vuelve cuenta por cobrar, el ingreso entra sin ITBMS y el
    // envío va a su propia cuenta. Sin línea de 2201: la tasa es 0 y una línea
    // de cero no es «el impuesto es cero», es que no hay nada que anotar.
    expect(porHecho.get("3")?.lineas).toEqual({
      "2101": ABONO,
      "1201": SALDO,
      "4101": -SUBTOTAL,
      "4102": -ENVIO,
    });
    // Asiento 3b · lo que costó la mercancía que salió.
    expect(porHecho.get("3b")?.lineas).toEqual({ "5101": COSTO, "1301": -COSTO });
    // Asiento 4 · el efectivo lo tiene el motorizado y vive en SU caja, no en
    // la caja del local. La cuenta nace en el mismo batch que el primer cobro.
    expect(porHecho.get("4")?.lineas).toEqual({
      [`1104-${s.motorizadoId}`]: SALDO,
      "1201": -SALDO,
    });

    // Y la prueba que resume todo: este pedido no dejó nada colgando. «Te
    // deben» vuelve a cero porque el saldo se cobró, y «anticipos» vuelve a
    // cero porque la venta ya se reconoció. Un asiento que faltara cuadraría
    // igual —las dos columnas salen del mismo número— y esto es lo único que
    // lo caza.
    expect(await saldoDeCuenta(pedido.id, "1201"), "1201 quedó con saldo").toBe(0);
    expect(await saldoDeCuenta(pedido.id, "2101"), "2101 quedó con saldo").toBe(0);

    // ── 13. El día se cierra ────────────────────────────────────────────────
    const cerrada = datosDe<{ cerrada: true; entregadas: number; cobradoCents: number }>(
      await postJson(duena, `/entregas/rutas/${ruta.rutaId}/cerrar`, {}),
      "POST /entregas/rutas/:rutaId/cerrar",
    );
    expect(cerrada).toEqual({ cerrada: true, entregadas: 1, cobradoCents: SALDO });
  });

  it("el mismo camino, cancelado a mitad: lo apartado vuelve y NO hay venta", async () => {
    const s = await sembrar("cancel");
    const antes = await existencias(s);
    const { clienteId } = await unaClienta(s.suf);
    const zona = await unaZona(s, 400);

    const CAJAS = 2;
    const ABONO = 1500;

    const pedido = datosDe<{ id: string; totalCents: number }>(
      await postJson(duena, "/pedidos", {
        idempotencia: `circ-cancel-${s.suf}`,
        clienteId,
        zona,
        lineas: [{ codigo: s.codigo, cantidad: CAJAS, bodega: s.bodega }],
      }),
      "POST /pedidos",
      201,
    );
    expect(pedido.totalCents).toBe(CAJAS * s.precioUnitCents + 400);

    const apartado = await existencias(s);
    expect({
      fisico: apartado.fisico - antes.fisico,
      reservado: apartado.reservado - antes.reservado,
    }).toEqual({ fisico: 0, reservado: CAJAS });

    // La clienta abona y el pedido se agenda. Hasta aquí es el mismo camino.
    const comprobante = datosDe<{ pagoId: string }>(
      await postJson(duena, "/cobros", {
        pedidoId: pedido.id,
        montoCents: ABONO,
        metodo: "yappy",
        tipo: "abono",
        idempotencia: `circ-cancel-abono-${s.suf}`,
      }),
      "POST /cobros",
    );
    const confirmado = datosDe<{ agendado: boolean }>(
      await postJson(duena, `/cobros/${comprobante.pagoId}/confirmar`, {}),
      "POST /cobros/:pagoId/confirmar",
    );
    expect(confirmado.agendado).toBe(true);

    // ── Y aquí se cae: la clienta cambió de idea ────────────────────────────
    //
    // Sin motivo no entra, y no es burocracia: cancelar devuelve mercancía al
    // inventario y deja dinero de una clienta esperando una decisión.
    const sinMotivo = await postJson(duena, `/pedidos/${pedido.id}/cancelar`, {});
    expect(sinMotivo.estado).toBe(400);
    expect(
      (await existencias(s)).reservado - antes.reservado,
      "un 400 que igual libera el stock es peor que no tener 400",
    ).toBe(CAJAS);

    const cancelado = datosDe<{ cancelado: true; liberadas: number }>(
      await postJson(duena, `/pedidos/${pedido.id}/cancelar`, {
        motivo: "la clienta inventada cambió de idea",
      }),
      "POST /pedidos/:id/cancelar",
    );
    expect(cancelado.liberadas).toBe(1);

    // ── Lo apartado VUELVE, y el físico no se movió nunca ───────────────────
    const fin = await existencias(s);
    expect({
      fisico: fin.fisico - antes.fisico,
      reservado: fin.reservado - antes.reservado,
    }).toEqual({ fisico: 0, reservado: 0 });

    // Nada salió del inventario: no hay un solo movimiento de este pedido.
    const { results: movimientos } = await real.DB.prepare(
      `SELECT m.id FROM movimientos_inventario m
        WHERE m.codigo = ? AND m.bodega_id = ?`,
    )
      .bind(s.codigo, s.bodegaId)
      .all<{ id: string }>();
    expect(movimientos, "un pedido cancelado no saca mercancía").toEqual([]);

    // El pedido está cancelado y el pago NO desaparece: `estado_pago` sigue
    // diciendo «abonado» a propósito, porque ese dinero existe y alguien tiene
    // que decidir si se devuelve o queda como crédito. Ponerlo en «sin_pago»
    // haría desaparecer la deuda del sistema.
    const p = await real.DB.prepare(
      "SELECT estado, estado_pago, pagado_cents FROM pedidos WHERE id = ?",
    )
      .bind(pedido.id)
      .first<{ estado: string; estado_pago: string; pagado_cents: number }>();
    expect(p).toEqual({ estado: "cancelado", estado_pago: "abonado", pagado_cents: ABONO });

    // ── Y los libros: NO hay venta, porque no hubo venta ────────────────────
    const asientos = await asientosDe(pedido.id);
    // Solo el asiento del abono. Ni 3 (la venta) ni 3b (su costo): eso es lo
    // que esta prueba vigila, y es la forma de descuadre que no se ve hasta el
    // cierre — ingresos de algo que nunca salió de la bodega.
    expect(asientos.map((a) => a.hecho)).toEqual(["1"]);
    for (const a of asientos) {
      expect(a.diferencia, `al asiento ${a.hecho} le falta su cuadre`).toBe(0);
      expect(a.debe).toBe(a.haber);
    }

    // Nada en ingresos, nada en costo de ventas, nada en cuentas por cobrar.
    for (const cuenta of ["4101", "4102", "5101", "1201"]) {
      expect(await saldoDeCuenta(pedido.id, cuenta), `${cuenta} se movió sin venta`).toBe(0);
    }

    // Lo que SÍ queda, y tiene que quedar: el abono de la clienta en 2101.
    // Son $15 suyos que están aquí. Quién los devuelve o los convierte en
    // crédito es la decisión que falta —`cancelacion_con_abono` está en
    // PENDIENTE en producción— y el sistema la deja a la vista en vez de
    // elegir por la dueña.
    expect(await saldoDeCuenta(pedido.id, "2101")).toBe(-ABONO);
  });
});
