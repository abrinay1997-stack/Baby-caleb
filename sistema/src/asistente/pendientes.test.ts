import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { pendientesDe } from "./ejecutar";

/**
 * Lo que espera permiso tiene que poder VERSE.
 *
 * EL FALLO QUE CIERRA. Una acción sensible quedaba en `acciones` con estado
 * `por_confirmar`, y la única forma de permitirla era la tarjeta que el chat
 * de Caleb pinta con la respuesta del mensaje que la creó: el id salía de esa
 * respuesta, no de ninguna consulta. Una acción nacida por MCP —sin
 * conversación, sin mensaje, sin botón de Telegram— no aparecía en NINGUNA
 * pantalla. Solo podía vencer.
 *
 * Le pasó dos veces seguidas al dueño con el mismo producto, y las dos creyó
 * haberla aprobado: el error le decía «está esperando en el chat de Caleb» y
 * ahí no estaba. Mientras tanto, TODA herramienta sensible por MCP era
 * inusable — `cambiar_precio`, `ajustar_stock`, `retirar_variante`,
 * `editar_variante`… construidas, probadas y sin nadie que pudiera decirles
 * que sí (trampa §12, en la puerta de salida).
 */

const AHORA = 1_800_000_000_000;
const MEDIA_HORA = 30 * 60_000;

async function sembrarAccion(
  id: string,
  usuario: string,
  estado: string,
  creadoEn: number,
  resumen: string | null = "cambiar «editar variante» — codigo: NAT-M",
): Promise<void> {
  // La tabla lleva un CHECK: `(estado = 'por_confirmar') = (cerrada_en IS
  // NULL)`. O sea que lo cerrado TIENE que traer su fecha de cierre, y lo que
  // sigue esperando no puede traerla. Un dato de prueba que se lo salte no
  // prueba nada: reventaría antes de llegar al código.
  const cerrada = estado === "por_confirmar" ? null : creadoEn + 1000;
  await env.DB.prepare(
    `INSERT INTO acciones (id, herramienta, nivel, categoria, canal, usuario_id,
       argumentos_json, resumen, estado, con_adjuntos, texto_externo, creado_en, cerrada_en)
     VALUES (?, 'editar_variante', 'sensible', 'catalogo', 'mcp', ?, '{}', ?, ?, 0, 0, ?, ?)`,
  )
    .bind(id, usuario, resumen, estado, creadoEn, cerrada)
    .run();
}

describe("lo que espera que una persona lo permita", () => {
  /**
   * Cada prueba estrena usuario, y no se borra nada.
   *
   * `acciones` lleva un trigger que PROHÍBE el DELETE —«acciones no se borra:
   * es la bitácora»— y tiene razón: una bitácora que se puede vaciar no es una
   * bitácora. Así que aislar las pruebas limpiando la tabla no se puede, y
   * tampoco se debe. Se aíslan por usuario, que además es justo lo que la
   * función filtra.
   */
  let n = 0;
  let duena = "";
  let otra = "";
  beforeEach(async () => {
    n += 1;
    duena = `usr-duena-${n}`;
    otra = `usr-otra-${n}`;
    // `acciones.usuario_id` apunta a `usuarios`: sin las filas, la siembra
    // revienta con «FOREIGN KEY constraint failed» y no se prueba nada.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, activo, creado_en)
         VALUES (?, ?, 'Yarielis', 'duena', 1, 0)`,
      ).bind(duena, `${duena}@babycaleb.com`),
      env.DB.prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, activo, creado_en)
         VALUES (?, ?, 'Otra', 'asistente', 1, 0)`,
      ).bind(otra, `${otra}@babycaleb.com`),
    ]);
  });

  it("una acción pedida por MCP se puede VER: ese era el agujero", async () => {
    await sembrarAccion(`a${n}-1`, duena, "por_confirmar", AHORA - 60_000);
    const r = await pendientesDe(env.DB, duena, AHORA);
    expect(r).toHaveLength(1);
    expect(r[0]?.accionId).toBe(`a${n}-1`);
    expect(r[0]?.resumen).toContain("editar variante");
  });

  it("solo las de quien pregunta: una acción la permite quien la pidió", async () => {
    await sembrarAccion(`a${n}-mia`, duena, "por_confirmar", AHORA - 60_000);
    await sembrarAccion(`a${n}-ajena`, otra, "por_confirmar", AHORA - 60_000);
    const r = await pendientesDe(env.DB, duena, AHORA);
    expect(r.map((x) => x.accionId)).toEqual([`a${n}-mia`]);
  });

  it("lo ya resuelto no sale", async () => {
    await sembrarAccion(`a${n}-hecha`, duena, "hecha", AHORA - 60_000);
    await sembrarAccion(`a${n}-rechazada`, duena, "rechazada", AHORA - 60_000);
    expect(await pendientesDe(env.DB, duena, AHORA)).toHaveLength(0);
  });

  it("una vencida NO se enseña aunque el cron no haya pasado todavía", async () => {
    // El cron corre cada cinco minutos. Enseñar como viva una acción muerta
    // hace que la persona toque «Permitir» y reciba un error — que es
    // exactamente la confusión que esto viene a terminar.
    await sembrarAccion(`a${n}-vieja`, duena, "por_confirmar", AHORA - MEDIA_HORA - 1000);
    expect(await pendientesDe(env.DB, duena, AHORA)).toHaveLength(0);

    // Un segundo antes del límite sí vive.
    await sembrarAccion(`a${n}-justo`, duena, "por_confirmar", AHORA - MEDIA_HORA + 1000);
    const r = await pendientesDe(env.DB, duena, AHORA);
    expect(r.map((x) => x.accionId)).toEqual([`a${n}-justo`]);
  });

  it("dice cuándo vence, para poder avisarlo", async () => {
    const nacio = AHORA - 60_000;
    await sembrarAccion(`a${n}-1`, duena, "por_confirmar", nacio);
    const r = await pendientesDe(env.DB, duena, AHORA);
    expect(r[0]?.venceEn).toBe(nacio + MEDIA_HORA);
  });

  it("la más vieja primero: es la que está a punto de vencerse", async () => {
    await sembrarAccion(`a${n}-nueva`, duena, "por_confirmar", AHORA - 10_000);
    await sembrarAccion(`a${n}-vieja`, duena, "por_confirmar", AHORA - 20 * 60_000);
    const r = await pendientesDe(env.DB, duena, AHORA);
    expect(r.map((x) => x.accionId)).toEqual([`a${n}-vieja`, `a${n}-nueva`]);
  });

  it("una fila sin resumen se nombra, no se enseña vacía", async () => {
    // Sin resumen no hay nada que leer antes de decidir, y una tarjeta en
    // blanco con dos botones es peor que no tener tarjeta.
    await sembrarAccion(`a${n}-muda`, duena, "por_confirmar", AHORA - 1000, null);
    const r = await pendientesDe(env.DB, duena, AHORA);
    expect(r[0]?.resumen.trim()).not.toBe("");
  });
});
