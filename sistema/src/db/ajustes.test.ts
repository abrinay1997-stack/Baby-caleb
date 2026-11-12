import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enunciadosDeGuardado,
  guardar,
  historial,
  leerVigentes,
  type ContextoAjustes,
} from "./ajustes";
import { PENDIENTE } from "../dominio/ajustes";
import reglas from "../../reglas.json";

/**
 * Cambiar un ajuste en D1.
 *
 * Lo que se vigila aquí, por orden de lo que dolería más:
 *
 *  1. **Que nadie pierda un cambio.** Dos personas guardando a la vez es el
 *     caso real: el panel abierto en el teléfono mientras alguien toca la
 *     computadora. La segunda tiene que FALLAR, no pisar.
 *  2. **Que el historial no se pueda reescribir.** Ni con un `UPDATE` ni con
 *     una vigencia en el pasado, que es un `UPDATE` con otra cara: cambiaría
 *     las reglas de un pedido ya cobrado.
 *  3. **Que la firma sea de verdad.** `cambiado_por` sale de la sesión.
 *
 * Cada prueba se comprobó rompiendo a propósito lo que dice vigilar; las
 * mutaciones están anotadas.
 */

let ctx: ContextoAjustes;

beforeEach(async () => {
  ctx = { db: env.DB, ahora: Date.now(), actor: "yarielis@babycaleb.com" };
  // Las migraciones se aplican una vez por archivo, no por prueba: sin vaciar
  // la tabla, la versión 1 de una clave la habría escrito la prueba anterior y
  // cada prueba contaría lo que pasó en la de antes.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ajustes"),
    env.DB.prepare("DELETE FROM controles"),
  ]);
});

const en = (ms: number): ContextoAjustes => ({ ...ctx, ahora: ms });

const filas = async (clave: string) => {
  const { results } = await env.DB.prepare(
    "SELECT clave, version, valor_json, vigente_desde, cambiado_por, motivo FROM ajustes WHERE clave = ? ORDER BY version",
  )
    .bind(clave)
    .all<{ version: number; valor_json: string; cambiado_por: string; motivo: string | null }>();
  return results;
};

const vigente = async (clave: string, cuando = ctx) => {
  const r = await leerVigentes(cuando);
  if (!r.ok) throw new Error(r.mensaje);
  const a = r.datos.ajustes.find((x) => x.clave === clave);
  if (a === undefined) throw new Error(`${clave} no está en la lista de vigentes`);
  return a;
};

// ---------------------------------------------------------------------------

describe("leerVigentes", () => {
  /**
   * Las quince claves salen siempre, guardadas o no.
   *
   * Mutación: devolviendo solo las filas de D1, se cae. Una clave que
   * desaparece de la pantalla porque nadie la ha tocado es una que nadie vuelve
   * a buscar — y siete de las quince son justo las que faltan por decidir.
   */
  it("devuelve todas las claves, también las que nadie ha tocado", async () => {
    const r = await leerVigentes(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const deFabrica = Object.keys(reglas).filter((k) => !k.startsWith("_"));
    expect(r.datos.ajustes.map((a) => a.clave).sort()).toEqual(deFabrica.sort());
    expect(r.datos.ajustes.every((a) => a.origen === "fabrica")).toBe(true);
  });

  /**
   * Y dice de dónde sale cada una.
   *
   * La pantalla lo necesita: «lo decidió Yarielis en octubre» y «esto es lo que
   * venía de fábrica» no son lo mismo, y enseñar las dos cosas igual invita a
   * creerse un número que nadie confirmó. Mutación: devolviendo `origen:
   * "guardado"` siempre, se cae.
   */
  it("distingue el valor de fábrica del que alguien puso", async () => {
    expect(await vigente("abono_minimo_cents")).toMatchObject({
      valor: 500,
      origen: "fabrica",
      version: null,
      cambiado_por: null,
    });

    await guardar(ctx, { clave: "abono_minimo_cents", valor: 1000, motivo: "Subió a $10" });

    expect(await vigente("abono_minimo_cents")).toMatchObject({
      valor: 1000,
      origen: "guardado",
      version: 1,
      cambiado_por: "yarielis@babycaleb.com",
      motivo: "Subió a $10",
    });
  });

  it("marca lo que falta decidir, y no lo confunde con cero", async () => {
    expect(await vigente("ventanas_entrega")).toMatchObject({
      valor: PENDIENTE,
      pendiente: true,
    });
    // Cero es una decisión tomada, no una ausencia.
    await guardar(ctx, { clave: "stock_bajo", valor: 0, motivo: "No quiero el aviso" });
    expect(await vigente("stock_bajo")).toMatchObject({ valor: 0, pendiente: false });
  });

  /**
   * Una versión programada para mañana no vale hoy.
   *
   * Mutación: quitando el `vigente_desde <= ?1` de la consulta, se cae — y en
   * producción un cambio programado para el mes que viene se aplicaría hoy.
   */
  it("no aplica una versión cuya vigencia todavía no empezó", async () => {
    const manana = ctx.ahora + 86_400_000;
    await guardar(ctx, {
      clave: "abono_minimo_cents",
      valor: 1500,
      motivo: "Sube el mes que viene",
      vigenteDesde: manana,
    });

    expect((await vigente("abono_minimo_cents")).valor).toBe(500);
    expect((await vigente("abono_minimo_cents", en(manana))).valor).toBe(1500);
  });

  /**
   * Un valor guardado que hoy no se puede interpretar NO se usa.
   *
   * Pasa si alguien lo escribe a mano en la consola de D1. Lo que vale es el
   * valor de arranque —el sistema no corre con un dato que no sabe leer— y el
   * aviso dice qué había. Mutación: devolviendo el valor leído sin pasarlo por
   * `validar`, se cae, y en producción `reserva_minutos_pago_en_linea` valdría
   * «muchos» y el cron que libera reservas se volvería impredecible.
   */
  it("ignora un valor guardado que no pasa su propia validación, y lo dice", async () => {
    await env.DB.prepare(
      `INSERT INTO ajustes (clave, version, valor_json, vigente_desde, cambiado_por, motivo)
       VALUES ('reserva_minutos_pago_en_linea', 1, '"muchos"', ?, 'alguien@mano', 'a mano en la consola')`,
    )
      .bind(ctx.ahora - 1000)
      .run();

    const a = await vigente("reserva_minutos_pago_en_linea");
    expect(a.valor).toBe(PENDIENTE);
    expect(a.origen).toBe("fabrica");
    // El aviso dice QUÉ pasa y NO quién lo guardó.
    //
    // Esta prueba exigía lo contrario —que el aviso llevara «alguien@mano»— y
    // con eso estaba fijando un fallo en vez de protegerlo: ese correo volvía
    // crudo dentro del texto, así que salía por la rama de lista de
    // `ver_ajustes` (la que se creyó saneada al quitar el campo `cambiado_por`)
    // y la guarda de D-20 habría tumbado la herramienta entera el día que un
    // valor guardado no se pudiera leer. Estaba dormido solo porque hoy
    // ninguno está corrupto.
    //
    // Ahora se exige la ausencia, que es la propiedad que importa: el quién
    // está en `ver_historial_de_ajuste`, que existe para esa pregunta.
    expect(a.aviso).not.toContain("alguien@mano");
    expect(a.aviso).not.toContain("@");
    expect(a.aviso).toContain("arranque");
    expect(a.aviso).toContain("no se puede usar");
  });

  it("y lo mismo si el JSON guardado está roto", async () => {
    await env.DB.prepare(
      `INSERT INTO ajustes (clave, version, valor_json, vigente_desde, cambiado_por, motivo)
       VALUES ('stock_bajo', 1, '{no es json', ?, 'alguien@mano', NULL)`,
    )
      .bind(ctx.ahora - 1000)
      .run();

    const a = await vigente("stock_bajo");
    expect(a.valor).toBe(5);
    expect(a.origen).toBe("fabrica");
    expect(a.aviso).toContain("no se puede leer");
  });
});

describe("guardar", () => {
  it("inserta la versión siguiente y no toca la que había", async () => {
    await guardar(ctx, { clave: "stock_bajo", valor: 8, motivo: "Hay más rotación" });
    await guardar(ctx, { clave: "stock_bajo", valor: 3, motivo: "Me quedé sin espacio" });

    const puestas = await filas("stock_bajo");
    expect(puestas.map((f) => [f.version, f.valor_json])).toEqual([
      [1, "8"],
      [2, "3"],
    ]);
  });

  /**
   * La firma sale de la sesión, nunca del cuerpo.
   *
   * Mutación: leyendo `cambiado_por` de `cambio` en vez de `ctx.actor`, se cae.
   * Es lo que impide que alguien firme un cambio con el nombre de otro, y sin
   * eso el historial deja de servir para lo único que sirve.
   */
  it("firma con quien abrió la sesión, y no se puede suplantar", async () => {
    await guardar(
      { ...ctx, actor: "asistente@babycaleb.com" },
      {
        clave: "stock_bajo",
        valor: 7,
        motivo: "prueba",
        // Esto viene del cuerpo de la petición y tiene que ser ignorado.
        ...({ cambiado_por: "yarielis@babycaleb.com", actor: "yarielis@babycaleb.com" } as object),
      },
    );
    const [puesta] = await filas("stock_bajo");
    expect(puesta?.cambiado_por).toBe("asistente@babycaleb.com");
  });

  it("sin actor no se guarda nada", async () => {
    const r = await guardar({ ...ctx, actor: "  " }, {
      clave: "stock_bajo",
      valor: 7,
      motivo: "prueba",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_autorizado");
    expect(await filas("stock_bajo")).toEqual([]);
  });

  /**
   * El motivo es obligatorio.
   *
   * Mutación: aceptando un motivo vacío, se cae. El historial sin motivos es un
   * registro de guardados: dice quién tocó qué y cuándo, y no contesta por qué
   * — que es la pregunta que alguien hará dentro de seis meses.
   */
  it("exige un motivo, y no guarda nada sin él", async () => {
    for (const motivo of ["", "   "]) {
      const r = await guardar(ctx, { clave: "stock_bajo", valor: 7, motivo });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.mensaje).toContain("por qué");
    }
    expect(await filas("stock_bajo")).toEqual([]);
  });

  it("guarda el motivo sin espacios al borde", async () => {
    await guardar(ctx, { clave: "stock_bajo", valor: 7, motivo: "  Lo pidió la dueña  " });
    expect((await filas("stock_bajo"))[0]?.motivo).toBe("Lo pidió la dueña");
  });

  it("rechaza un motivo que es un informe", async () => {
    const r = await guardar(ctx, { clave: "stock_bajo", valor: 7, motivo: "a".repeat(501) });
    expect(r.ok).toBe(false);
    expect(await filas("stock_bajo")).toEqual([]);
  });

  /**
   * Una vigencia en el pasado reescribiría la historia.
   *
   * Mutación: quitando la comprobación, se cae. Y en producción un ajuste con
   * fecha de la semana pasada cambiaría la regla con la que se cobró un pedido
   * que ya está cobrado: el pedido guardaría una cosa y el ajuste diría otra.
   */
  it("no deja que un cambio empiece a valer en el pasado", async () => {
    const r = await guardar(ctx, {
      clave: "abono_minimo_cents",
      valor: 1000,
      motivo: "retroactivo",
      vigenteDesde: ctx.ahora - 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain("pasado");
    expect(await filas("abono_minimo_cents")).toEqual([]);
  });

  it("sí deja desde ahora mismo y desde el futuro", async () => {
    expect((await guardar(ctx, { clave: "stock_bajo", valor: 6, motivo: "hoy" })).ok).toBe(true);
    expect(
      (
        await guardar(ctx, {
          clave: "stock_bajo",
          valor: 7,
          motivo: "mañana",
          vigenteDesde: ctx.ahora + 86_400_000,
        })
      ).ok,
    ).toBe(true);
  });

  /**
   * Una versión nueva no puede colarse DELANTE de una programada.
   *
   * Lo vigente es la versión más alta entre las que ya empezaron. Si la nueva
   * —que es la más alta— empezara antes que una ya programada, la programada
   * quedaría en la tabla con su fecha y su motivo sin llegar a valer nunca, y
   * nadie lo vería. Mutación: quitando la comprobación, se cae; sin ella el
   * cambio programado para dentro de un mes se pierde en silencio.
   */
  it("no deja adelantarse a un cambio ya programado", async () => {
    const mes = ctx.ahora + 30 * 86_400_000;
    await guardar(ctx, {
      clave: "abono_minimo_cents",
      valor: 1500,
      motivo: "Sube en un mes",
      vigenteDesde: mes,
    });

    const r = await guardar(ctx, {
      clave: "abono_minimo_cents",
      valor: 800,
      motivo: "Un cambio para hoy",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("transicion_invalida");

    // El programado sigue siendo la única versión, intacto.
    expect((await filas("abono_minimo_cents")).map((f) => f.version)).toEqual([1]);
    expect((await vigente("abono_minimo_cents", en(mes))).valor).toBe(1500);
  });

  it("valida el valor contra su esquema antes de tocar la base", async () => {
    const r = await guardar(ctx, {
      clave: "reserva_minutos_pago_en_linea",
      valor: 2,
      motivo: "muy poco",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
    expect(await filas("reserva_minutos_pago_en_linea")).toEqual([]);
  });

  it("no guarda una clave inventada", async () => {
    const r = await guardar(ctx, { clave: "descuento_secreto", valor: 1, motivo: "probando" });
    expect(r.ok).toBe(false);
    const { results } = await env.DB.prepare("SELECT clave FROM ajustes").all();
    expect(results).toEqual([]);
  });

  it("guarda las dos estructuras y las devuelve enteras", async () => {
    const ventanas = [
      { id: "manana", etiqueta: "Mañana", desde: "08:00", hasta: "12:00" },
      { id: "tarde", etiqueta: "Tarde", desde: "13:00", hasta: "18:00" },
    ];
    await guardar(ctx, { clave: "ventanas_entrega", valor: ventanas, motivo: "Las de siempre" });
    expect((await vigente("ventanas_entrega")).valor).toEqual(ventanas);

    const comisiones = {
      yappy: { porcentaje_bp: 350, fijo_cents: 0, lleva_itbms: true },
      tilopay: PENDIENTE,
      paypal: PENDIENTE,
    };
    await guardar(ctx, { clave: "comisiones", valor: comisiones, motivo: "Llegó el de Yappy" });
    expect((await vigente("comisiones")).valor).toEqual(comisiones);
  });

  it("guarda el valor normalizado, no el que llegó", async () => {
    await guardar(ctx, {
      clave: "ventanas_entrega",
      valor: [{ id: "manana", etiqueta: " Mañana ", desde: "9:00", hasta: "12:00" }],
      motivo: "una sola",
    });
    expect((await filas("ventanas_entrega"))[0]?.valor_json).toBe(
      '[{"id":"manana","etiqueta":"Mañana","desde":"09:00","hasta":"12:00"}]',
    );
  });
});

describe("dos personas guardando a la vez", () => {
  /**
   * La segunda falla. No pisa.
   *
   * Las dos leen la misma versión máxima, las dos calculan la misma siguiente y
   * la llave primaria `(clave, version)` tumba a la segunda.
   *
   * Mutación: con `INSERT OR REPLACE`, las dos entran, la segunda pisa a la
   * primera y esto se cae — y en producción la primera se habría ido creyendo
   * que su valor es el que vale.
   *
   * Medido, por si alguien lo intenta: pasar el cálculo de la versión a un
   * `MAX(version)+1` dentro del SQL **no** rompe esta prueba, porque entonces
   * la tumba el control de abajo (busca la versión que este batch calculó y no
   * la encuentra). Las dos defensas se solapan a propósito; quitar las dos sí
   * la rompe.
   */
  it("la segunda se cae con conflicto, y la primera queda intacta", async () => {
    const [a, b] = await Promise.all([
      guardar(ctx, { clave: "stock_bajo", valor: 9, motivo: "la primera" }),
      guardar(ctx, { clave: "stock_bajo", valor: 2, motivo: "la segunda" }),
    ]);

    const buenas = [a, b].filter((r) => r.ok);
    const malas = [a, b].filter((r) => !r.ok);
    expect(buenas).toHaveLength(1);
    expect(malas).toHaveLength(1);
    const mala = malas[0];
    if (mala !== undefined && !mala.ok) expect(mala.codigo).toBe("conflicto_version");

    // Y en la tabla hay UNA sola versión: la que ganó.
    const puestas = await filas("stock_bajo");
    expect(puestas).toHaveLength(1);
    expect(puestas[0]?.version).toBe(1);
  });

  /**
   * El control mira EL VALOR ESCRITO, no solo el número de versión.
   *
   * Esta es la lección amarga de `catalogo-admin.ts` aplicada aquí, y es la
   * razón de que `enunciadosDeGuardado` se exporte: se corre **el control solo,
   * sin su INSERT**, con una fila ajena ya puesta en la versión que el control
   * espera. Si el control mirara solo `version`, encontraría la fila del otro y
   * daría por bueno un guardado que no escribió nada.
   *
   * Mutación: quitando `valor_json`, `vigente_desde` y `cambiado_por` del
   * `WHERE` del control, el batch pasa y esto se cae.
   */
  it("el control no da por bueno un guardado que no escribió nada", async () => {
    // Alguien más ya dejó la versión 1 de esta clave, con OTRO valor.
    await env.DB.prepare(
      `INSERT INTO ajustes (clave, version, valor_json, vigente_desde, cambiado_por, motivo)
       VALUES ('stock_bajo', 1, '99', ?, 'otra@persona', 'la de verdad')`,
    )
      .bind(ctx.ahora)
      .run();

    const enunciados = enunciadosDeGuardado(ctx, {
      clave: "stock_bajo",
      valorJson: "4",
      version: 1,
      vigenteDesde: ctx.ahora,
      motivo: "el mío",
    });

    // Solo el control: se simula que el INSERT no llegó a escribir.
    const soloElControl = enunciados.slice(1);
    await expect(env.DB.batch(soloElControl)).rejects.toThrow();

    // Y la fila del otro sigue como estaba.
    expect((await filas("stock_bajo"))[0]?.valor_json).toBe("99");
  });

  it("y sí lo da por bueno cuando el valor escrito es el de este batch", async () => {
    const enunciados = enunciadosDeGuardado(ctx, {
      clave: "stock_bajo",
      valorJson: "4",
      version: 1,
      vigenteDesde: ctx.ahora,
      motivo: "el mío",
    });
    await expect(env.DB.batch(enunciados)).resolves.toBeDefined();
    expect((await filas("stock_bajo"))[0]?.valor_json).toBe("4");
  });
});

describe("historial", () => {
  it("devuelve las versiones de la más nueva a la más vieja", async () => {
    await guardar(ctx, { clave: "stock_bajo", valor: 8, motivo: "primero" });
    await guardar(ctx, { clave: "stock_bajo", valor: 6, motivo: "después" });

    const r = await historial(ctx, "stock_bajo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.versiones.map((v) => [v.version, v.valor, v.motivo])).toEqual([
      [2, 6, "después"],
      [1, 8, "primero"],
    ]);
  });

  /**
   * Y dice cuál manda ahora.
   *
   * Mutación: marcando siempre la versión más alta como vigente, se cae: la
   * programada para mañana es la más alta y todavía no manda. En la pantalla
   * eso sería enseñar como regla de hoy una que entra el mes que viene.
   */
  it("marca la que manda hoy y la que está programada", async () => {
    const manana = ctx.ahora + 86_400_000;
    await guardar(ctx, { clave: "abono_minimo_cents", valor: 700, motivo: "hoy" });
    await guardar(ctx, {
      clave: "abono_minimo_cents",
      valor: 900,
      motivo: "mañana",
      vigenteDesde: manana,
    });

    const r = await historial(ctx, "abono_minimo_cents");
    if (!r.ok) throw new Error(r.mensaje);
    expect(r.datos.versiones.map((v) => [v.version, v.vigente, v.futura])).toEqual([
      [2, false, true],
      [1, true, false],
    ]);
  });

  it("de una clave sin tocar devuelve una lista vacía, no un error", async () => {
    const r = await historial(ctx, "comisiones");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.datos.versiones).toEqual([]);
  });

  it("de una clave inventada devuelve no encontrado", async () => {
    const r = await historial(ctx, "descuento_secreto");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  /**
   * El historial no se corrige.
   *
   * Una versión vieja que hoy no pasaría la validación se devuelve tal como se
   * guardó: cuenta lo que pasó. Si se escondiera, se estaría borrando la prueba
   * de que alguien guardó eso aquel día — y la fila de al lado explicaría un
   * cambio que no se ve.
   */
  it("enseña una versión vieja aunque hoy no se aceptaría", async () => {
    await env.DB.prepare(
      `INSERT INTO ajustes (clave, version, valor_json, vigente_desde, cambiado_por, motivo)
       VALUES ('stock_bajo', 1, '-3', ?, 'alguien@mano', 'así estaba')`,
    )
      .bind(ctx.ahora - 1000)
      .run();

    const r = await historial(ctx, "stock_bajo");
    if (!r.ok) throw new Error(r.mensaje);
    expect(r.datos.versiones[0]).toMatchObject({ version: 1, valor: -3, motivo: "así estaba" });
  });
});
