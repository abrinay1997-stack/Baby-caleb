import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ulid } from "../ids";
import {
  PLAN_DE_CUENTAS,
  abonoAntesDeEntregar,
  asientoManual,
  balance,
  codigoDeCaja,
  cobroDelSaldo,
  entregaDelPedido,
  fechaContable,
  gasto,
  liquidacionDelMotorizado,
} from "../dominio/contabilidad";
import {
  type ContextoContable,
  cerrarMes,
  cuentaDeMotorizado,
  entregasSinCosto,
  enunciadosDeAsiento,
  huecosAbiertos,
  libroDiario,
  mayorDeCuenta,
  movimientosEntre,
  porCobrar,
  reabrirMes,
  registrarAsiento,
  resumenContable,
  revertirAsiento,
  revisionDeCierre,
  saldosAl,
} from "./contabilidad";

/**
 * Los libros, contra una D1 de verdad (F5.1).
 *
 * No comprueban que el SQL esté bien escrito: comprueban que la BASE hace
 * cumplir lo que el plan da por sentado. Un asiento que no se puede editar solo
 * cuenta si el trigger lo rechaza; un asiento que no cuadra solo cuenta si el
 * batch entero se cae.
 *
 * Cada prueba se validó rompiendo el código o quitando el trigger a propósito.
 *
 * **Este runner NO limpia la base entre pruebas del mismo archivo**, y los
 * asientos no se pueden borrar —el trigger lo prohíbe, que es justo lo que se
 * quiere—. Así que cada prueba trabaja en SU PROPIO AÑO: las lecturas van por
 * ventana de fechas y dos pruebas nunca se ven. Y no se siembra nada en
 * `existencias`, porque la lista de cierre de mes compara las existencias con
 * sus movimientos y una fila sembrada a mano la dejaría en rojo para siempre.
 */

let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const ctx = (): ContextoContable => ({
  db: env.DB,
  ahora: Date.now(),
  actor: "contadora@babycaleb.com",
});

/** Un año propio por prueba. El futuro, para no chocar con los meses cerrados. */
let añoFuturo = 2090;
const ventana = () => {
  const a = añoFuturo++;
  return { desde: `${a}-01-01`, hasta: `${a}-12-31`, fecha: `${a}-06-15`, mes: `${a}-06` };
};

/** Y uno en el pasado para lo que necesita un mes ya terminado. */
let añoPasado = 2001;
const ventanaPasada = () => {
  const a = añoPasado++;
  return { desde: `${a}-06-01`, hasta: `${a}-06-30`, fecha: `${a}-06-15`, mes: `${a}-06` };
};

const unAsiento = (fecha: string, montoCents = 1000) =>
  asientoManual({
    fecha,
    descripcion: `Prueba ${id("as")}`,
    referencia: null,
    lineas: [
      { cuenta: "6199", debeCents: montoCents, haberCents: 0, detalle: "Prueba" },
      { cuenta: "1103", debeCents: 0, haberCents: montoCents, detalle: null },
    ],
  });

function debeSerOk<T>(r: { ok: true; datos: T } | { ok: false; mensaje: string }): T {
  if (!r.ok) throw new Error(`esperaba ok y salió: ${r.mensaje}`);
  return r.datos;
}

const saldoDe = (filas: readonly { codigo: string; saldoCents: number }[], codigo: string) =>
  filas.find((f) => f.codigo === codigo)?.saldoCents ?? 0;

// ---------------------------------------------------------------------------

describe("el plan de cuentas que siembra la 0011", () => {
  it("es exactamente el del dominio: código, nombre, tipo y subtipo", async () => {
    // Las dos listas dicen lo mismo o una de ellas miente. La del dominio es la
    // que usan los asientos; la de la base es la que ven los informes.
    const { results } = await env.DB.prepare(
      "SELECT codigo, nombre, tipo, subtipo FROM cuentas WHERE motorizado_id IS NULL ORDER BY codigo",
    ).all<{ codigo: string; nombre: string; tipo: string; subtipo: string | null }>();

    expect(results).toEqual(
      [...PLAN_DE_CUENTAS]
        .sort((a, b) => a.codigo.localeCompare(b.codigo))
        .map((c) => ({ codigo: c.codigo, nombre: c.nombre, tipo: c.tipo, subtipo: c.subtipo })),
    );
  });

  it("no trae ninguna caja de motorizado: esas nacen con cada persona", async () => {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cuentas WHERE subtipo = 'caja_motorizado'",
    ).first<{ n: number }>();
    expect(r?.n).toBe(0);
  });

  it("una cuenta con motorizado tiene que ser una caja, y al revés", async () => {
    // Con `=` en vez de `IS` en el CHECK, una cuenta de subtipo NULL con un
    // motorizado pegado entraba sin más: el CHECK valía NULL y SQLite deja
    // pasar lo que no es falso.
    const mot = await motorizado();
    await expect(
      env.DB.prepare(
        "INSERT INTO cuentas (id,codigo,nombre,tipo,subtipo,motorizado_id) VALUES (?,?,'X','activo',NULL,?)",
      )
        .bind(id("cta"), id("9"), mot.id)
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);

    await expect(
      env.DB.prepare(
        "INSERT INTO cuentas (id,codigo,nombre,tipo,subtipo,motorizado_id) VALUES (?,?,'X','activo','caja_motorizado',NULL)",
      )
        .bind(id("cta"), id("9"))
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });
});

async function motorizado(): Promise<{ id: string; nombre: string }> {
  const mid = id("mot");
  const nombre = `Motorizado ${mid}`;
  await env.DB.prepare(
    `INSERT INTO motorizados (id,nombre,celular_e164,estado,vehiculo,pin_fallos,creado_en)
     VALUES (?,?,?,'activo','moto',0,?)`,
  )
    .bind(mid, nombre, `507${String(Date.now()).slice(-7)}${n++}`, Date.now())
    .run();
  return { id: mid, nombre };
}

// ---------------------------------------------------------------------------

describe("escribir un asiento", () => {
  it("escribe el asiento, sus líneas y su fila de cuadre", async () => {
    const v = ventana();
    const a = debeSerOk(unAsiento(v.fecha, 2500));
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), a));

    const cabeza = await env.DB.prepare(
      "SELECT fecha, descripcion, origen, hecho, creado_por FROM asientos WHERE id = ?",
    )
      .bind(asientoId)
      .first<{ fecha: string; origen: string; hecho: string; creado_por: string }>();
    expect(cabeza?.fecha).toBe(v.fecha);
    expect(cabeza?.hecho).toBe("manual");
    expect(cabeza?.creado_por).toBe("contadora@babycaleb.com");

    const { results: lineas } = await env.DB.prepare(
      `SELECT c.codigo, l.debe_cents, l.haber_cents FROM asiento_lineas l
         JOIN cuentas c ON c.id = l.cuenta_id WHERE l.asiento_id = ? ORDER BY c.codigo`,
    )
      .bind(asientoId)
      .all<{ codigo: string; debe_cents: number; haber_cents: number }>();
    expect(lineas).toEqual([
      { codigo: "1103", debe_cents: 0, haber_cents: 2500 },
      { codigo: "6199", debe_cents: 2500, haber_cents: 0 },
    ]);

    const cuadre = await env.DB.prepare("SELECT diferencia FROM control_cuadre WHERE asiento_id = ?")
      .bind(asientoId)
      .first<{ diferencia: number }>();
    expect(cuadre?.diferencia).toBe(0);
  });

  it("un asiento escrito a mano que NO cuadra tumba el batch entero", async () => {
    // El dominio ya no deja salir un asiento descuadrado, así que esto prueba
    // la segunda red: que la BASE lo rechace igual. Se escribe el batch a mano,
    // como lo haría un módulo nuevo que se saltara el dominio.
    const v = ventana();
    const asientoId = ulid(Date.now());
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO asientos (id,fecha,descripcion,origen,hecho,creado_por,creado_en)
           VALUES (?,?,'Descuadrado','ajuste','manual','x',?)`,
        ).bind(asientoId, v.fecha, Date.now()),
        env.DB.prepare(
          `INSERT INTO asiento_lineas (id,asiento_id,cuenta_id,debe_cents,haber_cents)
           VALUES (?,?,(SELECT id FROM cuentas WHERE codigo='6199'),1000,0)`,
        ).bind(ulid(Date.now()), asientoId),
        env.DB.prepare(
          `INSERT INTO asiento_lineas (id,asiento_id,cuenta_id,debe_cents,haber_cents)
           VALUES (?,?,(SELECT id FROM cuentas WHERE codigo='1103'),0,900)`,
        ).bind(ulid(Date.now()), asientoId),
        env.DB.prepare(
          `INSERT INTO control_cuadre (asiento_id, diferencia)
           SELECT ?1, SUM(debe_cents) - SUM(haber_cents) FROM asiento_lineas WHERE asiento_id = ?1`,
        ).bind(asientoId),
      ]),
    ).rejects.toThrow(/CHECK|constraint/i);

    // Y no queda nada: ni el asiento ni sus líneas. Esto es lo que de verdad
    // importa — un asiento a medias es peor que ninguno.
    const quedo = await env.DB.prepare("SELECT COUNT(*) AS n FROM asientos WHERE id = ?")
      .bind(asientoId)
      .first<{ n: number }>();
    expect(quedo?.n).toBe(0);
  });

  it("`registrarAsiento` con un asiento descuadrado armado a mano no escribe nada", async () => {
    // Su parámetro es un `Asiento`, no el resultado de `revisarAsiento`, así
    // que un módulo nuevo puede armarlo a mano y saltarse el dominio. Lo que lo
    // para entonces es la fila de cuadre, y por eso tiene que calcularse sobre
    // las líneas de ESTE batch y no ser un 0 escrito a mano.
    const v = ventana();
    const r = await registrarAsiento(ctx(), {
      fecha: v.fecha,
      descripcion: "Descuadrado a mano",
      origen: "ajuste",
      hecho: "manual",
      referencia: null,
      lineas: [
        { cuenta: "6199", debeCents: 1000, haberCents: 0, detalle: null },
        { cuenta: "1103", debeCents: 0, haberCents: 900, detalle: null },
      ],
    });
    expect(r.ok).toBe(false);

    const quedo = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM asientos WHERE descripcion = 'Descuadrado a mano'",
    ).first<{ n: number }>();
    expect(quedo?.n).toBe(0);
  });

  it("un asiento SIN líneas tampoco entra: el cuadre de cero filas es nulo", async () => {
    const v = ventana();
    const asientoId = ulid(Date.now());
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO asientos (id,fecha,descripcion,origen,hecho,creado_por,creado_en)
           VALUES (?,?,'Vacío','ajuste','manual','x',?)`,
        ).bind(asientoId, v.fecha, Date.now()),
        env.DB.prepare(
          `INSERT INTO control_cuadre (asiento_id, diferencia)
           SELECT ?1, SUM(debe_cents) - SUM(haber_cents) FROM asiento_lineas WHERE asiento_id = ?1`,
        ).bind(asientoId),
      ]),
    ).rejects.toThrow(/NOT NULL|constraint/i);
  });

  it("una fecha que no tiene forma de fecha no entra", async () => {
    // Sin este CHECK, un `Date.now()` en milisegundos entraría como texto y el
    // mes del asiento saldría de un `substr()` sobre un número.
    await expect(
      env.DB.prepare(
        `INSERT INTO asientos (id,fecha,descripcion,origen,hecho,creado_por,creado_en)
         VALUES (?,?,'X','ajuste','manual','x',?)`,
      )
        .bind(ulid(Date.now()), String(Date.now()), Date.now())
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("los enunciados se pueden meter en el batch de otro hecho", async () => {
    // Es la razón de que `enunciadosDeAsiento` exista: el asiento entra con el
    // hecho que lo provoca, o no entra ninguno de los dos.
    const v = ventana();
    const a = debeSerOk(unAsiento(v.fecha, 700));
    const { asientoId, enunciados } = enunciadosDeAsiento(ctx(), a);

    await expect(
      env.DB.batch([
        ...enunciados,
        // Un enunciado que falla DESPUÉS del asiento: el hecho de al lado.
        env.DB.prepare("INSERT INTO controles (id, regla, ok, creado_en) VALUES (?,?,0,?)").bind(
          ulid(Date.now()),
          "prueba:el hecho falló",
          Date.now(),
        ),
      ]),
    ).rejects.toThrow(/CHECK|constraint/i);

    const quedo = await env.DB.prepare("SELECT COUNT(*) AS n FROM asientos WHERE id = ?")
      .bind(asientoId)
      .first<{ n: number }>();
    expect(quedo?.n).toBe(0);
  });

  it("un asiento contra una cuenta que no existe no entra", async () => {
    const v = ventana();
    const r = await registrarAsiento(ctx(), {
      fecha: v.fecha,
      descripcion: "Cuenta fantasma",
      origen: "ajuste",
      hecho: "manual",
      referencia: null,
      lineas: [
        { cuenta: "1104-nadie", debeCents: 100, haberCents: 0, detalle: null },
        { cuenta: "1103", debeCents: 0, haberCents: 100, detalle: null },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
  });
});

// ---------------------------------------------------------------------------

describe("los libros no se editan ni se borran", () => {
  it("un asiento no se edita ni se borra", async () => {
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));

    await expect(
      env.DB.prepare("UPDATE asientos SET descripcion = 'otra' WHERE id = ?").bind(asientoId).run(),
    ).rejects.toThrow(/no se editan/);
    await expect(
      env.DB.prepare("DELETE FROM asientos WHERE id = ?").bind(asientoId).run(),
    ).rejects.toThrow(/no se borran/);
  });

  it("una línea no se edita ni se borra", async () => {
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));

    await expect(
      env.DB.prepare("UPDATE asiento_lineas SET debe_cents = 1 WHERE asiento_id = ?")
        .bind(asientoId)
        .run(),
    ).rejects.toThrow(/no se editan/);
    await expect(
      env.DB.prepare("DELETE FROM asiento_lineas WHERE asiento_id = ?").bind(asientoId).run(),
    ).rejects.toThrow(/no se borran/);
  });

  it("no se le añaden líneas a un asiento ya cuadrado", async () => {
    // Esta es la que de verdad cierra el agujero. Sin ella, un segundo batch le
    // mete una línea a un asiento viejo, el `control_cuadre` de aquel día sigue
    // diciendo 0, y el balance se desequilibra sin que nada falle.
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));

    await expect(
      env.DB.prepare(
        `INSERT INTO asiento_lineas (id,asiento_id,cuenta_id,debe_cents,haber_cents)
         VALUES (?,?,(SELECT id FROM cuentas WHERE codigo='6199'),500,0)`,
      )
        .bind(ulid(Date.now()), asientoId)
        .run(),
    ).rejects.toThrow(/ya está cuadrado/);
  });

  it("y el cuadre no se toca, porque es lo que sostiene esa regla", async () => {
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));

    await expect(
      env.DB.prepare("DELETE FROM control_cuadre WHERE asiento_id = ?").bind(asientoId).run(),
    ).rejects.toThrow(/no se borra/);
    await expect(
      env.DB.prepare("UPDATE control_cuadre SET diferencia = 0 WHERE asiento_id = ?")
        .bind(asientoId)
        .run(),
    ).rejects.toThrow(/no se edita/);
  });

  it("una cuenta con movimientos no cambia de naturaleza ni se borra", async () => {
    const v = ventana();
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));

    // Cambiarle el tipo a 6199 reescribiría en silencio todos los informes del
    // pasado: lo que era un gasto pasaría a ser otra cosa.
    await expect(
      env.DB.prepare("UPDATE cuentas SET tipo = 'activo' WHERE codigo = '6199'").run(),
    ).rejects.toThrow(/naturaleza/);
    await expect(
      env.DB.prepare("UPDATE cuentas SET codigo = '6198' WHERE codigo = '6199'").run(),
    ).rejects.toThrow(/naturaleza/);
    await expect(
      env.DB.prepare("DELETE FROM cuentas WHERE codigo = '6199'").run(),
    ).rejects.toThrow(/desactívela/);

    // El NOMBRE sí se cambia: «Banco (cuál: PENDIENTE)» tiene que poder pasar a
    // su nombre de verdad el día que la dueña lo diga.
    await env.DB.prepare("UPDATE cuentas SET nombre = 'Otros gastos varios' WHERE codigo = '6199'").run();
    await env.DB.prepare("UPDATE cuentas SET nombre = 'Otros gastos' WHERE codigo = '6199'").run();
  });

  it("una línea de extracto solo cambia al conciliarla, y no se borra", async () => {
    const extractoId = id("ext");
    const lineaId = id("eli");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO extractos (id,cuenta_id,archivo_r2,formato,importado_por,importado_en)
         VALUES (?,(SELECT id FROM cuentas WHERE codigo='1101'),?,'csv','x',?)`,
      ).bind(extractoId, `extractos/${extractoId}.csv`, Date.now()),
      env.DB.prepare(
        `INSERT INTO extracto_lineas (id,extracto_id,fecha,descripcion,monto_cents,huella)
         VALUES (?,?,'2026-11-07','Yappy BC-1',1500,?)`,
      ).bind(lineaId, extractoId, id("huella")),
    ]);

    await expect(
      env.DB.prepare("UPDATE extracto_lineas SET monto_cents = 9999 WHERE id = ?").bind(lineaId).run(),
    ).rejects.toThrow(/solo cambia/);
    await expect(
      env.DB.prepare("DELETE FROM extracto_lineas WHERE id = ?").bind(lineaId).run(),
    ).rejects.toThrow(/no se borra/);

    await env.DB.prepare(
      `UPDATE extracto_lineas SET conciliado_con_tipo='pago', conciliado_con_id=?, conciliado_en=?
        WHERE id = ?`,
    )
      .bind("pag-1", Date.now(), lineaId)
      .run();

    // Y la misma línea no se importa dos veces: la huella es única.
    const huella = await env.DB.prepare("SELECT huella FROM extracto_lineas WHERE id = ?")
      .bind(lineaId)
      .first<{ huella: string }>();
    await expect(
      env.DB.prepare(
        `INSERT INTO extracto_lineas (id,extracto_id,fecha,descripcion,monto_cents,huella)
         VALUES (?,?,'2026-11-07','Yappy BC-1',1500,?)`,
      )
        .bind(id("eli"), extractoId, huella!.huella)
        .run(),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });
});

describe("la cuenta a la que entra un pago", () => {
  it("no puede apuntar a una cuenta que no existe", async () => {
    // La 0006 dejó `pagos.cuenta_id` sin llave foránea porque `cuentas` no
    // existía y SQLite no puede añadir una con ALTER. Estos triggers son esa
    // llave: sin ellos, el dinero de un pago no aparece en ninguna cuenta y
    // nada falla.
    const { pedidoId } = await pedidoEntregado({ totalCents: 1000, pagadoCents: 0 });
    await expect(
      env.DB.prepare(
        `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,intento_ref,
           cuenta_id,creado_en,actualizado_en)
         VALUES (?,?,'manual','yappy','abono','confirmando',500,?,'cta-fantasma',?,?)`,
      )
        .bind(id("pag"), pedidoId, id("ref"), Date.now(), Date.now())
        .run(),
    ).rejects.toThrow(/cuenta que no existe/);

    const pagoId = id("pag");
    await env.DB.prepare(
      `INSERT INTO pagos (id,pedido_id,proveedor,metodo,tipo,estado,monto_cents,intento_ref,
         creado_en,actualizado_en)
       VALUES (?,?,'manual','yappy','abono','confirmando',500,?,?,?)`,
    )
      .bind(pagoId, pedidoId, id("ref"), Date.now(), Date.now())
      .run();

    await expect(
      env.DB.prepare("UPDATE pagos SET cuenta_id = 'cta-fantasma' WHERE id = ?").bind(pagoId).run(),
    ).rejects.toThrow(/cuenta que no existe/);

    // Con una cuenta de verdad sí.
    await env.DB.prepare("UPDATE pagos SET cuenta_id = 'cta-1101' WHERE id = ?").bind(pagoId).run();
    const p = await env.DB.prepare("SELECT cuenta_id FROM pagos WHERE id = ?")
      .bind(pagoId)
      .first<{ cuenta_id: string }>();
    expect(p?.cuenta_id).toBe("cta-1101");
  });
});

// ---------------------------------------------------------------------------

describe("corregir un asiento equivocado", () => {
  it("se registra el contrario, enlazado al original", async () => {
    const v = ventana();
    const original = debeSerOk(
      gasto({
        fecha: v.fecha,
        referencia: { tipo: "gasto", id: "gas-1" },
        cuentaGasto: "6101",
        cuentaPago: "1102",
        montoCents: 4000,
        concepto: "Cargado por error",
      }),
    );
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), original));

    const r = debeSerOk(await revertirAsiento(ctx(), asientoId, "era del mes pasado"));
    const { results } = await env.DB.prepare(
      `SELECT c.codigo, l.debe_cents, l.haber_cents FROM asiento_lineas l
         JOIN cuentas c ON c.id = l.cuenta_id WHERE l.asiento_id = ? ORDER BY l.id`,
    )
      .bind(r.asientoId)
      .all<{ codigo: string; debe_cents: number; haber_cents: number }>();
    expect(results).toEqual([
      { codigo: "6101", debe_cents: 0, haber_cents: 4000 },
      { codigo: "1102", debe_cents: 4000, haber_cents: 0 },
    ]);

    const nuevo = await env.DB.prepare(
      "SELECT revierte_id, descripcion, fecha FROM asientos WHERE id = ?",
    )
      .bind(r.asientoId)
      .first<{ revierte_id: string; descripcion: string; fecha: string }>();
    expect(nuevo?.revierte_id).toBe(asientoId);
    expect(nuevo?.descripcion).toMatch(/mes pasado/);
  });

  it("un asiento se corrige UNA vez", async () => {
    // Dos reversos del mismo error descuentan el doble, y los dos cuadran por
    // separado: no habría nada que lo delatara. Lo impide el UNIQUE.
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));
    debeSerOk(await revertirAsiento(ctx(), asientoId, "primera corrección"));

    const otra = await revertirAsiento(ctx(), asientoId, "segunda corrección");
    expect(otra.ok).toBe(false);
    if (!otra.ok) expect(otra.codigo).toBe("repetido");
  });

  it("no se corrige un asiento que no existe, ni sin motivo", async () => {
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));
    expect((await revertirAsiento(ctx(), "no-existe", "x")).ok).toBe(false);
    expect((await revertirAsiento(ctx(), asientoId, "  ")).ok).toBe(false);
  });

  it("un asiento no se puede revertir a sí mismo", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO asientos (id,fecha,descripcion,origen,hecho,revierte_id,creado_por,creado_en)
         VALUES ('auto-1','2026-11-07','X','ajuste','manual','auto-1','x',?)`,
      )
        .bind(Date.now())
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("el reverso queda marcado en el libro para no ofrecerlo dos veces", async () => {
    const v = ventana();
    const { asientoId } = debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha))));
    debeSerOk(await revertirAsiento(ctx(), asientoId, "corregido"));

    const libro = await libroDiario(ctx(), v);
    const original = libro.find((a) => a.id === asientoId);
    expect(original?.revertido).toBe(true);

    // Y el reverso NO está en el diario del original: lleva la fecha de hoy,
    // porque el error se descubre hoy y el mes del original puede estar
    // cerrado. Está en el diario de hoy.
    expect(libro.some((a) => a.revierteId === asientoId)).toBe(false);
    const hoy = fechaContable(Date.now());
    const diarioDeHoy = await libroDiario(ctx(), { desde: hoy, hasta: hoy, limite: 200 });
    expect(diarioDeHoy.some((a) => a.revierteId === asientoId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("la caja de un motorizado", () => {
  it("nace cuando hace falta y llamarlo dos veces no es un error", async () => {
    const mot = await motorizado();
    const primera = debeSerOk(await cuentaDeMotorizado(ctx(), mot.id));
    const segunda = debeSerOk(await cuentaDeMotorizado(ctx(), mot.id));
    expect(primera.codigo).toBe(codigoDeCaja(mot.id));
    expect(segunda.codigo).toBe(primera.codigo);

    const r = await env.DB.prepare("SELECT COUNT(*) AS n, nombre FROM cuentas WHERE codigo = ?")
      .bind(primera.codigo)
      .first<{ n: number; nombre: string }>();
    expect(r?.n).toBe(1);
    expect(r?.nombre).toBe(`Caja de ${mot.nombre}`);
  });

  it("no se crea la caja de un motorizado que no existe", async () => {
    expect((await cuentaDeMotorizado(ctx(), "mot-fantasma")).ok).toBe(false);
  });

  it("el cobro en efectivo y la liquidación la dejan en cero", async () => {
    const v = ventana();
    const mot = await motorizado();
    const { codigo } = debeSerOk(await cuentaDeMotorizado(ctx(), mot.id));

    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          cobroDelSaldo({
            fecha: v.fecha,
            referencia: null,
            cuenta: codigo,
            montoCents: 3850,
            numero: "BC-000125",
          }),
        ),
      ),
    );
    let movs = await movimientosEntre(ctx(), v.desde, v.hasta);
    expect(saldoDe(movs, codigo)).toBe(3850);

    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          liquidacionDelMotorizado({
            fecha: v.fecha,
            referencia: null,
            cuentaCaja: codigo,
            cuentaDestino: "1103",
            montoCents: 3850,
            motorizado: mot.nombre,
          }),
        ),
      ),
    );
    movs = await movimientosEntre(ctx(), v.desde, v.hasta);
    expect(saldoDe(movs, codigo)).toBe(0);
    expect(saldoDe(movs, "1103")).toBe(3850);
  });
});

// ---------------------------------------------------------------------------

describe("leer los saldos", () => {
  it("un saldo es «al día X» y no cuenta lo de después", async () => {
    const v = ventana();
    const antes = await saldosAl(ctx(), `${v.fecha}`);
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(`${v.desde.slice(0, 4)}-07-01`, 900))));

    // El asiento es de julio: al 15 de junio no existe todavía.
    const alMismoDia = await saldosAl(ctx(), v.fecha);
    expect(saldoDe(alMismoDia, "6199") - saldoDe(antes, "6199")).toBe(0);

    const alFinal = await saldosAl(ctx(), v.hasta);
    expect(saldoDe(alFinal, "6199") - saldoDe(antes, "6199")).toBe(900);
  });

  it("un movimiento es «del X al Y» y los dos días cuentan", async () => {
    const v = ventana();
    const a = v.desde.slice(0, 4);
    for (const fecha of [`${a}-03-01`, `${a}-03-31`, `${a}-04-01`]) {
      debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(fecha, 100))));
    }
    const marzo = await movimientosEntre(ctx(), `${a}-03-01`, `${a}-03-31`);
    expect(saldoDe(marzo, "6199")).toBe(200);
  });

  it("enseña también las cuentas en cero: una que desaparece no la busca nadie", async () => {
    const v = ventana();
    const filas = await saldosAl(ctx(), v.hasta);
    expect(filas.length).toBeGreaterThanOrEqual(PLAN_DE_CUENTAS.length);
    expect(filas.some((f) => f.codigo === "3201")).toBe(true);
  });

  it("el mayor de una cuenta trae SOLO sus apuntes del periodo", async () => {
    const v = ventana();
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha, 1234))));
    // Otro asiento del mismo periodo en OTRA cuenta de gasto: un mayor que
    // enseñe los apuntes de las demás cuentas no sirve para cuadrar nada, y
    // mirar solo «está el mío» no lo distingue.
    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          gasto({
            fecha: v.fecha,
            referencia: null,
            cuentaGasto: "6101",
            cuentaPago: "1103",
            montoCents: 777,
            concepto: "De otra cuenta",
          }),
        ),
      ),
    );

    const mayor = debeSerOk(await mayorDeCuenta(ctx(), "6199", v));
    expect(mayor.nombre).toBe("Otros gastos");
    expect(mayor.apuntes.map((ap) => ap.debeCents)).toEqual([1234]);

    expect((await mayorDeCuenta(ctx(), "9999", v)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pedidos, para los informes que no salen del mayor
// ---------------------------------------------------------------------------

let semilla: { productoId: string; bodegaId: string; zonaId: string } | null = null;

/** Un producto, una bodega y una zona. Sin tocar `existencias` (ver la nota de arriba). */
async function sembrar() {
  if (semilla !== null) return semilla;
  const productoId = id("prod");
  const bodegaId = id("bod");
  const zonaId = id("zon");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES (?,?,?,?,?)").bind(
      productoId,
      "panal",
      "Para contabilidad",
      id("slug"),
      Date.now(),
    ),
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(
      bodegaId,
      `Bodega ${bodegaId}`,
    ),
    env.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,region,metodo,tarifa_cents,actualizado_en)
       VALUES (?,?,'ciudad','motorizado',500,?)`,
    ).bind(zonaId, `Zona ${zonaId}`, Date.now()),
  ]);
  semilla = { productoId, bodegaId, zonaId };
  return semilla;
}

/**
 * Un pedido entregado, escrito directo.
 *
 * No se usa `crearPedido` ni `marcarEntregada` a propósito: lo que se prueba
 * aquí es cómo LEEN los informes, y pasar por el flujo entero obligaría a
 * sembrar existencias —que es lo que dejaría en rojo la casilla de cierre que
 * compara existencias con movimientos—.
 */
async function pedidoEntregado(o: {
  totalCents: number;
  pagadoCents: number;
  entregadoEn?: number;
  conCosto?: boolean;
  cliente?: string;
}): Promise<{ pedidoId: string; numero: string; clienteId: string }> {
  const s = await sembrar();
  const pedidoId = id("ped");
  const clienteId = id("cli");
  const codigo = id("CT").toUpperCase();
  const lineaId = id("lin");
  const numero = `BC-${String(n).padStart(6, "0")}`;
  const t = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,?,?,?)",
    ).bind(clienteId, o.cliente ?? `Clienta ${clienteId}`, t, t),
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,unidades_por_caja,precio_cents,
         publicado,activo,version,actualizado_en) VALUES (?,?,?,1,?,0,1,1,?)`,
    ).bind(codigo, s.productoId, `pieza ${codigo}`, o.totalCents, t),
    env.DB.prepare(
      `INSERT INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,zona_id,
         subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,pagado_cents,
         abono_minimo_cents,requiere_pago_total,version,creado_en,actualizado_en)
       VALUES (?,?,?,?,'panel','entregado',?,?,?,0,0,0,?,?,0,0,1,?,?)`,
    ).bind(
      pedidoId,
      numero,
      id("tok"),
      clienteId,
      o.pagadoCents >= o.totalCents ? "pagado" : "abonado",
      s.zonaId,
      o.totalCents,
      o.totalCents,
      o.pagadoCents,
      t,
      t,
    ),
    env.DB.prepare(
      `INSERT INTO pedido_lineas (id,pedido_id,codigo,nombre,cantidad,precio_unit_cents,
         itbms_bp,costo_unit_cents,bodega_id) VALUES (?,?,?,?,1,?,0,?,?)`,
    ).bind(
      lineaId,
      pedidoId,
      codigo,
      `pieza ${codigo}`,
      o.totalCents,
      o.conCosto === false ? null : Math.round(o.totalCents * 0.6),
      s.bodegaId,
    ),
    env.DB.prepare(
      `INSERT INTO envios (id,pedido_id,estado,metodo,bodega_id,guia_token,cobro_cents,
         cobrado_cents,version,creado_en,entregado_en)
       VALUES (?,?,'entregado','motorizado',?,?,0,0,1,?,?)`,
    ).bind(id("env"), pedidoId, s.bodegaId, id("guia"), t, o.entregadoEn ?? t),
  ]);

  return { pedidoId, numero, clienteId };
}

describe("lo que te deben", () => {
  it("sale por pedido entregado, con su antigüedad", async () => {
    const hoy = Date.now();
    const dia = 86_400_000;
    const al = fechaContable(hoy);
    // Deltas y no totales: este runner no limpia la base entre pruebas y lo por
    // cobrar es un saldo acumulado, así que otra prueba del archivo puede haber
    // dejado deuda. Lo que se comprueba es lo que ESTA prueba añade.
    const antes = await porCobrar(ctx(), al);
    await pedidoEntregado({ totalCents: 5000, pagadoCents: 1000, entregadoEn: hoy - 3 * dia });
    await pedidoEntregado({ totalCents: 8000, pagadoCents: 0, entregadoEn: hoy - 20 * dia });
    await pedidoEntregado({ totalCents: 3000, pagadoCents: 0, entregadoEn: hoy - 60 * dia });
    // Este está pagado: no debe aparecer.
    await pedidoEntregado({ totalCents: 9000, pagadoCents: 9000, entregadoEn: hoy - 5 * dia });

    const r = await porCobrar(ctx(), al);
    expect(r.porTramo["0-7"] - antes.porTramo["0-7"]).toBe(4000);
    expect(r.porTramo["8-30"] - antes.porTramo["8-30"]).toBe(8000);
    expect(r.porTramo["mas-de-30"] - antes.porTramo["mas-de-30"]).toBe(3000);
    // El pedido pagado no suma: 4 000 + 8 000 + 3 000 y nada de los 9 000.
    expect(r.totalCents - antes.totalCents).toBe(15000);
    expect(r.deudas.every((d) => d.saldoCents > 0)).toBe(true);
  });

  it("cuenta los pedidos entregados sin costo, que es lo que tumba el margen", async () => {
    const v = ventana();
    // La fecha de entrega se mide en hora de Panamá, así que se siembra con una
    // marca de tiempo dentro del día y se lee por la ventana del día.
    const cuando = Date.parse(`${v.fecha}T18:00:00Z`);
    await pedidoEntregado({ totalCents: 5000, pagadoCents: 5000, entregadoEn: cuando, conCosto: false });
    await pedidoEntregado({ totalCents: 5000, pagadoCents: 5000, entregadoEn: cuando, conCosto: true });

    expect(await entregasSinCosto(ctx(), v.fecha, v.fecha)).toBe(1);
    // Y fuera de su día no cuenta.
    expect(await entregasSinCosto(ctx(), v.desde, v.desde)).toBe(0);

    // Las 02:00 UTC del día siguiente son las 21:00 del día de Panamá: esa
    // entrega es del día anterior. Sin la conversión, se iría al día siguiente
    // y una entrega de la noche del último día del mes caería en el mes que
    // viene — justo en la casilla del cierre que cuenta las entregas sin costo.
    const diaSiguiente = `${v.fecha.slice(0, 8)}${String(Number(v.fecha.slice(8)) + 1).padStart(2, "0")}`;
    await pedidoEntregado({
      totalCents: 5000,
      pagadoCents: 5000,
      entregadoEn: Date.parse(`${diaSiguiente}T02:00:00Z`),
      conCosto: false,
    });
    expect(await entregasSinCosto(ctx(), v.fecha, v.fecha)).toBe(2);
    expect(await entregasSinCosto(ctx(), diaSiguiente, diaSiguiente)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("el resumen de la pantalla", () => {
  it("separa los saldos del día de los movimientos del periodo", async () => {
    const v = ventana();
    // Los saldos son acumulados y el runner no limpia la base, así que de
    // «te deben» se comprueba el delta y no el total.
    const antes = await resumenContable(ctx(), { desde: v.desde, hasta: v.hasta });
    // Un abono (entra dinero, nace una deuda con la clienta) y una entrega.
    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          abonoAntesDeEntregar({
            fecha: v.fecha,
            referencia: null,
            cuenta: "1101",
            montoCents: 1000,
            detalle: "Pedido BC-000200",
          }),
        ),
      ),
    );
    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          entregaDelPedido({
            fecha: v.fecha,
            referencia: null,
            numero: "BC-000200",
            subtotalCents: 5000,
            descuentoCents: 0,
            envioCents: 500,
            itbmsCents: 0,
            totalCents: 5500,
            abonadoCents: 1000,
          }),
        ),
      ),
    );

    const r = await resumenContable(ctx(), { desde: v.desde, hasta: v.hasta });
    expect(r.resultados.ventasCents).toBe(5000);
    expect(r.resultados.ingresosEnvioCents).toBe(500);
    expect(r.asientos).toBe(2);
    expect(r.asientosSinCuadre).toBe(0);
    // El dinero y lo que deben son saldos acumulados, así que se comprueba que
    // la cuenta del periodo esté dentro y no el total exacto.
    expect(r.dinero.some((c) => c.codigo === "1101")).toBe(true);
    expect(r.teDebenCents - antes.teDebenCents).toBe(4500);
    expect(r.dineroTotalCents - antes.dineroTotalCents).toBe(1000);
  });

  it("sin costo cargado no hay margen, aunque haya ganancia bruta", async () => {
    const v = ventana();
    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          entregaDelPedido({
            fecha: v.fecha,
            referencia: null,
            numero: "BC-000201",
            subtotalCents: 5000,
            descuentoCents: 0,
            envioCents: 0,
            itbmsCents: 0,
            totalCents: 5000,
            abonadoCents: 0,
          }),
        ),
      ),
    );
    await pedidoEntregado({
      totalCents: 5000,
      pagadoCents: 5000,
      entregadoEn: Date.parse(`${v.fecha}T18:00:00Z`),
      conCosto: false,
    });

    const r = await resumenContable(ctx(), { desde: v.desde, hasta: v.hasta });
    expect(r.resultados.entregasSinCosto).toBe(1);
    expect(r.resultados.margenBrutoBp).toBeNull();
    expect(r.resultados.gananciaBrutaCents).toBe(5000);
  });

  it("los movimientos de un periodo donde todo cuadra, cuadran", async () => {
    const v = ventana();
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha, 1500))));
    const b = balance(await movimientosEntre(ctx(), v.desde, v.hasta));
    expect(b.cuadra).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("lo que falta por decidir", () => {
  it("mide lo que se puede medir y enseña el resto igual", async () => {
    const huecos = await huecosAbiertos(ctx());

    const itbms = huecos.find((h) => h.clave === "itbms")!;
    // La carga inicial deja `tasa_itbms_bp` en NULL a propósito, así que este
    // hueco está abierto y con cuenta.
    expect(itbms.estado).toBe("abierto");
    expect(itbms.nota).toMatch(/artículos sin tasa/);

    const banco = huecos.find((h) => h.clave === "banco")!;
    expect(banco.estado).toBe("abierto");
    expect(banco.nota).toMatch(/PENDIENTE/);

    const comisiones = huecos.find((h) => h.clave === "comisiones")!;
    expect(comisiones.estado).toBe("abierto");

    // Los que nadie puede comprobar siguen en la lista: un hueco que no se ve
    // es un hueco que nadie llena.
    const factura = huecos.find((h) => h.clave === "factura_fiscal")!;
    expect(factura.estado).toBe("lo_dice_una_persona");
    expect(factura.quien).toMatch(/contadora/i);
  });

  it("el del banco se cierra solo cuando la cuenta deja de decir PENDIENTE", async () => {
    await env.DB.prepare("UPDATE cuentas SET nombre = 'Banco General 04-00-00' WHERE codigo = '1102'").run();
    const huecos = await huecosAbiertos(ctx());
    expect(huecos.find((h) => h.clave === "banco")!.estado).toBe("resuelto");
    await env.DB.prepare("UPDATE cuentas SET nombre = 'Banco (cuál: PENDIENTE)' WHERE codigo = '1102'").run();
  });
});

// ---------------------------------------------------------------------------

describe("cierre de mes", () => {
  it("no cierra un mes que todavía no terminó", async () => {
    const v = ventana();
    const r = await cerrarMes(ctx(), v.mes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");

    const revision = debeSerOk(await revisionDeCierre(ctx(), v.mes));
    expect(revision.mesTerminado).toBe(false);
  });

  it("no acepta un mes que no es un mes", async () => {
    expect((await revisionDeCierre(ctx(), "2026-13")).ok).toBe(false);
    expect((await revisionDeCierre(ctx(), "noviembre")).ok).toBe(false);
  });

  it("una caja con saldo bloquea el cierre, y liquidarla lo desbloquea", async () => {
    const v = ventanaPasada();
    const mot = await motorizado();
    const { codigo } = debeSerOk(await cuentaDeMotorizado(ctx(), mot.id));

    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          cobroDelSaldo({
            fecha: v.fecha,
            referencia: null,
            cuenta: codigo,
            montoCents: 2000,
            numero: "BC-000300",
          }),
        ),
      ),
    );

    let revision = debeSerOk(await revisionDeCierre(ctx(), v.mes));
    const caja = revision.casillas.find((c) => c.clave === "cajas")!;
    expect(caja.estado).toBe("falta");
    expect(caja.detalle).toMatch(mot.nombre);
    expect(revision.sePuedeCerrar).toBe(false);
    expect((await cerrarMes(ctx(), v.mes)).ok).toBe(false);

    debeSerOk(
      await registrarAsiento(
        ctx(),
        debeSerOk(
          liquidacionDelMotorizado({
            fecha: v.fecha,
            referencia: null,
            cuentaCaja: codigo,
            cuentaDestino: "1103",
            montoCents: 2000,
            motorizado: mot.nombre,
          }),
        ),
      ),
    );

    revision = debeSerOk(await revisionDeCierre(ctx(), v.mes));
    expect(revision.casillas.find((c) => c.clave === "cajas")!.estado).toBe("ok");
    expect(revision.sePuedeCerrar).toBe(true);
  });

  it("al cerrar, ningún asiento puede llevar fecha de ese mes", async () => {
    const v = ventanaPasada();
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha, 1000))));

    const revision = debeSerOk(await revisionDeCierre(ctx(), v.mes));
    expect(revision.sePuedeCerrar).toBe(true);
    expect(revision.mesTerminado).toBe(true);
    debeSerOk(await cerrarMes(ctx(), v.mes));

    // Esto es lo que hace que un cierre signifique algo.
    const tarde = await registrarAsiento(ctx(), debeSerOk(unAsiento(`${v.mes}-20`, 500)));
    expect(tarde.ok).toBe(false);
    if (!tarde.ok) expect(tarde.codigo).toBe("periodo_cerrado");

    // Y el mes de al lado sigue abierto: el trigger mira el mes, no la fecha.
    const a = v.mes.slice(0, 4);
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(`${a}-07-05`, 500))));

    // Cerrarlo otra vez no es un error nuevo: ya estaba cerrado.
    const otra = await cerrarMes(ctx(), v.mes);
    expect(otra.ok).toBe(false);
    if (!otra.ok) expect(otra.codigo).toBe("repetido");
  });

  it("reabrir pide motivo y queda registrado", async () => {
    const v = ventanaPasada();
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha, 1000))));
    debeSerOk(await cerrarMes(ctx(), v.mes));

    // Pedir motivo lo hace cumplir el CHECK de la tabla —un motivo vacío no
    // entra—, así que lo que la comprobación de `reabrirMes` añade es el
    // MENSAJE: sin ella, quien se olvida del motivo lee «ese mes no estaba
    // cerrado» y se va a buscar el problema donde no está. Lo probé quitándola:
    // la llamada seguía fallando, pero con el motivo equivocado.
    const sinMotivo = await reabrirMes(ctx(), v.mes, "   ");
    expect(sinMotivo.ok).toBe(false);
    if (!sinMotivo.ok) {
      expect(sinMotivo.codigo).toBe("entrada_invalida");
      expect(sinMotivo.mensaje).toMatch(/motivo/);
    }
    debeSerOk(await reabrirMes(ctx(), v.mes, "la contadora mandó una factura que faltaba"));

    const fila = await env.DB.prepare("SELECT estado, reabierto_motivo, cerrado_por FROM periodos WHERE mes = ?")
      .bind(v.mes)
      .first<{ estado: string; reabierto_motivo: string; cerrado_por: string }>();
    expect(fila?.estado).toBe("abierto");
    expect(fila?.reabierto_motivo).toMatch(/factura que faltaba/);
    // Quién cerró se conserva: la reapertura no borra el rastro del cierre.
    expect(fila?.cerrado_por).toBe("contadora@babycaleb.com");

    // Y ahora el asiento que faltaba sí entra.
    debeSerOk(await registrarAsiento(ctx(), debeSerOk(unAsiento(v.fecha, 300))));
  });

  it("no dice que reabrió si el motivo registrado es el de otra persona", async () => {
    // La carrera que la fila de control tiene que cazar: dos personas reabren
    // el mismo mes a la vez. Un control que solo mirara «¿está abierto?» daría
    // por bueno el segundo intento —el mes está abierto, sí— y esa persona se
    // iría creyendo que su motivo quedó registrado, cuando el que quedó es el
    // de la otra. El control mira el mes abierto CON ESTE motivo.
    const v = ventanaPasada();
    await env.DB.prepare(
      `INSERT INTO periodos (mes,estado,cerrado_por,cerrado_en,reabierto_motivo)
       VALUES (?,'abierto','otra@babycaleb.com',?,'lo reabrió otra persona')`,
    )
      .bind(v.mes, Date.now())
      .run();

    const r = await reabrirMes(ctx(), v.mes, "mi motivo, que no es el que quedó");
    expect(r.ok).toBe(false);

    const fila = await env.DB.prepare("SELECT reabierto_motivo FROM periodos WHERE mes = ?")
      .bind(v.mes)
      .first<{ reabierto_motivo: string }>();
    expect(fila?.reabierto_motivo).toBe("lo reabrió otra persona");
  });

  it("un mes que no estaba cerrado no se reabre", async () => {
    const v = ventanaPasada();
    const r = await reabrirMes(ctx(), v.mes, "porque sí");
    expect(r.ok).toBe(false);
  });

  it("un periodo abierto sin motivo de reapertura no se puede guardar", async () => {
    // El CHECK de la tabla: «reabrir pide motivo» no es una costumbre del
    // código, es que la fila no entra sin él.
    await expect(
      env.DB.prepare(
        "INSERT INTO periodos (mes,estado,cerrado_por,cerrado_en) VALUES ('1999-01','abierto','x',?)",
      )
        .bind(Date.now())
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);

    await expect(
      env.DB.prepare(
        "INSERT INTO periodos (mes,estado,cerrado_por,cerrado_en,reabierto_motivo) VALUES ('1999-02','abierto','x',?,'   ')",
      )
        .bind(Date.now())
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });
});
