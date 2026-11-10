import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * La bitácora del asistente, contra una D1 de verdad.
 *
 * `acciones` es el libro que dice qué hizo el asistente, con qué argumentos y
 * por orden de quién. Si se puede editar o borrar, no sirve para nada: el día
 * que haya que reconstruir qué pasó, lo que se lea podría ser lo que alguien
 * dejó, no lo que ocurrió.
 *
 * Estas pruebas no comprueban que el SQL esté bien escrito —eso lo haría
 * cualquier SQLite—: comprueban que D1 HACE CUMPLIR los triggers.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

async function unUsuario(): Promise<string> {
  const u = id("u");
  await env.DB.prepare(
    "INSERT INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES (?,?,'La dueña','duena',1,?)",
  )
    .bind(u, `${u}@babycaleb.com`, ahora())
    .run();
  return u;
}

/** Una acción ya cerrada (lo normal en una herramienta de lectura). */
async function unaAccionHecha(usuario: string): Promise<string> {
  const a = id("a");
  await env.DB.prepare(
    `INSERT INTO acciones (id,herramienta,nivel,canal,usuario_id,argumentos_json,estado,creado_en,cerrada_en)
     VALUES (?,'ver_stock','lectura','panel',?,'{}','hecha',?,?)`,
  )
    .bind(a, usuario, ahora(), ahora())
    .run();
  return a;
}

async function argumentosDe(a: string): Promise<string | undefined> {
  const fila = await env.DB.prepare("SELECT argumentos_json FROM acciones WHERE id = ?")
    .bind(a)
    .first<{ argumentos_json: string }>();
  return fila?.argumentos_json;
}

/** Una acción sensible esperando el «Permitir» de una persona. */
async function unaAccionEsperando(usuario: string): Promise<string> {
  const a = id("a");
  await env.DB.prepare(
    `INSERT INTO acciones (id,herramienta,nivel,canal,usuario_id,argumentos_json,resumen,estado,creado_en)
     VALUES (?,'cambiar_precio','sensible','panel',?,'{"codigo":"BC-1","precio_cents":1500}',
             'Cambiar el precio de BC-1 a $15.00','por_confirmar',?)`,
  )
    .bind(a, usuario, ahora())
    .run();
  return a;
}

describe("acciones · la bitácora no se edita ni se borra", () => {
  it("no se puede borrar una acción", async () => {
    const a = await unaAccionHecha(await unUsuario());
    await expect(env.DB.prepare("DELETE FROM acciones WHERE id = ?").bind(a).run()).rejects.toThrow(
      /es la bitácora/,
    );
  });

  // Sobre una acción ya cerrada pueden saltar DOS guardas a la vez, y SQLite no
  // promete cuál habla primero. Así que aquí no se mira el mensaje: se mira lo
  // único que importa, que la fila quede como estaba.
  it("no se pueden cambiar los argumentos de una acción ya cerrada", async () => {
    const a = await unaAccionHecha(await unUsuario());
    const antes = await argumentosDe(a);
    await expect(
      env.DB.prepare("UPDATE acciones SET argumentos_json = '{\"otro\":1}' WHERE id = ?").bind(a).run(),
    ).rejects.toThrow();
    expect(await argumentosDe(a)).toBe(antes);
  });

  it("tampoco se puede reabrir una acción cerrada", async () => {
    const a = await unaAccionHecha(await unUsuario());
    await expect(
      env.DB.prepare("UPDATE acciones SET estado = 'por_confirmar', cerrada_en = NULL WHERE id = ?")
        .bind(a)
        .run(),
    ).rejects.toThrow();
    const fila = await env.DB.prepare("SELECT estado, cerrada_en FROM acciones WHERE id = ?")
      .bind(a)
      .first<{ estado: string; cerrada_en: number | null }>();
    expect(fila?.estado).toBe("hecha");
    expect(fila?.cerrada_en).not.toBeNull();
  });
});

describe("acciones · confirmar una acción sensible", () => {
  it("se puede cerrar la que está esperando", async () => {
    const a = await unaAccionEsperando(await unUsuario());
    await env.DB.prepare(
      "UPDATE acciones SET estado='hecha', resultado_json='{\"ok\":true}', cerrada_en=? WHERE id=?",
    )
      .bind(ahora(), a)
      .run();

    const fila = await env.DB.prepare("SELECT estado, cerrada_en FROM acciones WHERE id = ?")
      .bind(a)
      .first<{ estado: string; cerrada_en: number }>();
    expect(fila?.estado).toBe("hecha");
    expect(fila?.cerrada_en).toBeGreaterThan(0);
  });

  it("confirmarla DOS VECES no la ejecuta dos veces", async () => {
    // Esta es la idempotencia de las confirmaciones (06-asistente §3): el id de
    // la acción es la llave, y la hace cumplir la base, no el código. Importa
    // porque en Telegram un botón se puede tocar dos veces y porque la red
    // reintenta: sin esto, un cobro se registraría dos veces.
    const a = await unaAccionEsperando(await unUsuario());
    const confirmar = () =>
      env.DB.prepare("UPDATE acciones SET estado='hecha', cerrada_en=? WHERE id=?")
        .bind(ahora(), a)
        .run();

    await confirmar();
    await expect(confirmar()).rejects.toThrow(/ya está cerrada/);
  });

  it("rechazarla también la cierra, y después ya no se toca", async () => {
    const a = await unaAccionEsperando(await unUsuario());
    await env.DB.prepare("UPDATE acciones SET estado='rechazada', cerrada_en=? WHERE id=?")
      .bind(ahora(), a)
      .run();
    await expect(
      env.DB.prepare("UPDATE acciones SET estado='hecha' WHERE id=?").bind(a).run(),
    ).rejects.toThrow(/ya está cerrada/);
  });

  it("al cerrarla no se puede cambiar de herramienta por el camino", async () => {
    // Sin este trigger, el UPDATE que confirma podría reescribir QUÉ se
    // confirmaba: se enseña «cambiar el precio a $15» y se ejecuta otra cosa.
    const a = await unaAccionEsperando(await unUsuario());
    await expect(
      env.DB.prepare(
        "UPDATE acciones SET estado='hecha', cerrada_en=?, herramienta='ajustar_stock' WHERE id=?",
      )
        .bind(ahora(), a)
        .run(),
    ).rejects.toThrow(/solo cambian estado, resultado y cerrada_en/);
  });

  it("ni los argumentos", async () => {
    const a = await unaAccionEsperando(await unUsuario());
    await expect(
      env.DB.prepare(
        `UPDATE acciones SET estado='hecha', cerrada_en=?,
         argumentos_json='{"codigo":"BC-1","precio_cents":1}' WHERE id=?`,
      )
        .bind(ahora(), a)
        .run(),
    ).rejects.toThrow(/solo cambian estado, resultado y cerrada_en/);
  });

  it("ni el resumen que la persona leyó antes de permitirla", async () => {
    const a = await unaAccionEsperando(await unUsuario());
    await expect(
      env.DB.prepare(
        "UPDATE acciones SET estado='hecha', cerrada_en=?, resumen='Otra cosa' WHERE id=?",
      )
        .bind(ahora(), a)
        .run(),
    ).rejects.toThrow(/solo cambian estado, resultado y cerrada_en/);
  });

  it("ni a nombre de otra persona", async () => {
    const a = await unaAccionEsperando(await unUsuario());
    const otro = await unUsuario();
    await expect(
      env.DB.prepare("UPDATE acciones SET estado='hecha', cerrada_en=?, usuario_id=? WHERE id=?")
        .bind(ahora(), otro, a)
        .run(),
    ).rejects.toThrow(/solo cambian estado, resultado y cerrada_en/);
  });

  it("y un campo que pasa de nulo a algo tampoco cuela", async () => {
    // `IS NOT` y no `<>`: con `<>`, comparar NULL con algo da NULL —ni cierto
    // ni falso—, el WHEN no se cumple y el trigger deja pasar el cambio.
    const a = await unaAccionEsperando(await unUsuario());
    await expect(
      env.DB.prepare(
        "UPDATE acciones SET estado='hecha', cerrada_en=?, categoria='inventario' WHERE id=?",
      )
        .bind(ahora(), a)
        .run(),
    ).rejects.toThrow(/solo cambian estado, resultado y cerrada_en/);
  });
});

describe("acciones · estado y cierre van juntos", () => {
  it("no se puede nacer cerrada sin fecha de cierre", async () => {
    const u = await unUsuario();
    await expect(
      env.DB.prepare(
        `INSERT INTO acciones (id,herramienta,nivel,canal,usuario_id,argumentos_json,estado,creado_en)
         VALUES (?,'ver_stock','lectura','panel',?,'{}','hecha',?)`,
      )
        .bind(id("a"), u, ahora())
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("ni esperando con fecha de cierre puesta", async () => {
    const u = await unUsuario();
    await expect(
      env.DB.prepare(
        `INSERT INTO acciones (id,herramienta,nivel,canal,usuario_id,argumentos_json,estado,creado_en,cerrada_en)
         VALUES (?,'cambiar_precio','sensible','panel',?,'{}','por_confirmar',?,?)`,
      )
        .bind(id("a"), u, ahora(), ahora())
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("un nivel que no existe no entra", async () => {
    const u = await unUsuario();
    await expect(
      env.DB.prepare(
        `INSERT INTO acciones (id,herramienta,nivel,canal,usuario_id,argumentos_json,estado,creado_en,cerrada_en)
         VALUES (?,'lo_que_sea','superusuario','panel',?,'{}','hecha',?,?)`,
      )
        .bind(id("a"), u, ahora(), ahora())
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });
});

describe("asistente_uso · lo que se gastó no se reescribe", () => {
  async function unGasto(usuario: string): Promise<string> {
    const g = id("g");
    await env.DB.prepare(
      `INSERT INTO asistente_uso
       (id,usuario_id,canal,modelo,entrada,salida,cache_leida,cache_escrita,costo_micro_usd,mes,creado_en)
       VALUES (?,?,'panel','muse-spark-1.2-contributor',8000,600,0,0,920,'2026-11',?)`,
    )
      .bind(g, usuario, ahora())
      .run();
    return g;
  }

  it("no se edita", async () => {
    const g = await unGasto(await unUsuario());
    await expect(
      env.DB.prepare("UPDATE asistente_uso SET costo_micro_usd = 0 WHERE id = ?").bind(g).run(),
    ).rejects.toThrow(/anote otra fila/);
  });

  it("no se borra", async () => {
    const g = await unGasto(await unUsuario());
    await expect(
      env.DB.prepare("DELETE FROM asistente_uso WHERE id = ?").bind(g).run(),
    ).rejects.toThrow(/no se borra/);
  });

  it("el costo va en microdólares, no en centavos", async () => {
    // Una llamada cuesta ~$0.0006. En centavos eso es 0, y mil llamadas
    // sumarían 0: el tope mensual no vería nada y no frenaría nunca.
    const u = await unUsuario();
    await unGasto(u);
    await unGasto(u);
    const fila = await env.DB.prepare(
      "SELECT SUM(costo_micro_usd) AS micro FROM asistente_uso WHERE usuario_id = ?",
    )
      .bind(u)
      .first<{ micro: number }>();
    expect(fila?.micro).toBe(1840); // $0.00184, que en centavos habría sido 0
  });
});

describe("conversaciones · se borran, la bitácora no", () => {
  it("borrar una conversación se lleva sus mensajes pero DEJA sus acciones", async () => {
    // Las conversaciones se barren a los 180 días; la bitácora se conserva
    // siempre. Por eso `acciones.conversacion_id` no lleva llave foránea: con
    // una, el barrido chocaría con la bitácora.
    const u = await unUsuario();
    const c = id("c");
    await env.DB.prepare(
      "INSERT INTO asistente_conversaciones (id,usuario_id,canal,creado_en,ultima_en) VALUES (?,?,'panel',?,?)",
    )
      .bind(c, u, ahora(), ahora())
      .run();
    await env.DB.prepare(
      "INSERT INTO asistente_mensajes (id,conversacion_id,rol,contenido_json,creado_en) VALUES (?,?,'user','\"hola\"',?)",
    )
      .bind(id("m"), c, ahora())
      .run();
    const a = id("a");
    await env.DB.prepare(
      `INSERT INTO acciones (id,herramienta,nivel,canal,usuario_id,conversacion_id,argumentos_json,estado,creado_en,cerrada_en)
       VALUES (?,'ver_stock','lectura','panel',?,?,'{}','hecha',?,?)`,
    )
      .bind(a, u, c, ahora(), ahora())
      .run();

    await env.DB.prepare("DELETE FROM asistente_conversaciones WHERE id = ?").bind(c).run();

    const mensajes = await env.DB.prepare(
      "SELECT COUNT(*) n FROM asistente_mensajes WHERE conversacion_id = ?",
    )
      .bind(c)
      .first<{ n: number }>();
    const accion = await env.DB.prepare("SELECT conversacion_id FROM acciones WHERE id = ?")
      .bind(a)
      .first<{ conversacion_id: string }>();

    expect(mensajes?.n).toBe(0);
    expect(accion?.conversacion_id).toBe(c); // el rastro queda
  });
});
