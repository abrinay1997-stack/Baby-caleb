import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import {
  COMO_SE_LEE_EL_NIVEL,
  type Turno,
  TURNO_LIMPIO,
  decidir,
  estaVencida,
  puedeConfirmar,
  revisarArgumentos,
} from "./politica";
import type { Canal, Contexto, Registro } from "./registro";

/**
 * Ejecutar una herramienta: la política, la bitácora y la confirmación.
 *
 * Esto es lo que hace que «sensible» signifique algo. Sin ejecutor, declarar
 * una herramienta como sensible es escribir una palabra en un objeto: lo que
 * de verdad la para es este archivo, que la deja en `por_confirmar` y no la
 * corre hasta que una persona toque «Permitir».
 *
 * El orden importa y es siempre el mismo:
 *
 *   1. ¿Existe la herramienta?        no → bloqueada, y se anota
 *   2. ¿Los argumentos son enormes?   sí → bloqueada ANTES de guardarlos
 *   3. ¿Los argumentos son válidos?   no → bloqueada, y se anota
 *   4. ¿Qué dice la política?         bloquear / confirmar / ejecutar
 *   5. Se ejecuta y se cierra la fila de `acciones`
 *
 * El paso 2 va antes que cualquier escritura a propósito: si no, una llamada
 * de medio megabyte entra entera en la bitácora y el tope no sirve de nada
 * porque el daño ya está guardado.
 */

/** Lo que se pide ejecutar. (`Peticion` a secas es la del proveedor.) */
export interface PeticionDeHerramienta {
  readonly nombre: string;
  readonly argumentos: unknown;
  readonly canal: Canal;
  readonly conversacionId: string | null;
  readonly conAdjuntos: boolean;
  readonly textoExterno: boolean;
}

export type Desenlace =
  | { readonly clase: "hecha"; readonly accionId: string; readonly datos: unknown }
  | {
      readonly clase: "por_confirmar";
      readonly accionId: string;
      readonly resumen: string;
      readonly venceEn: number;
    };

interface Quien {
  readonly db: D1Database;
  readonly usuario: Contexto["usuario"];
  readonly ahora: number;
}

/** Ejecuta, o deja la acción esperando a que una persona la permita. */
export async function ejecutar(
  quien: Quien,
  registro: Registro,
  peticion: PeticionDeHerramienta,
  turno: Turno = TURNO_LIMPIO,
): Promise<Resultado<Desenlace>> {
  const herramienta = registro.buscar(peticion.nombre);
  if (herramienta === undefined) {
    // No se anota en la bitácora: `acciones.herramienta` guardaría un nombre
    // que no existe, y la bitácora es de lo que el sistema HIZO.
    return fallo("no_encontrado", `no existe ninguna herramienta llamada «${peticion.nombre}»`);
  }

  // ANTES de guardar nada.
  const tamano = revisarArgumentos(peticion.argumentos);
  if (!tamano.ok) return fallo("limite", tamano.explicacion);

  // El ROL antes que el esquema. A quien no puede usar una herramienta se le
  // dice que no puede, no se le corrige la forma de los argumentos: lo segundo
  // le enseña el esquema de algo que no le corresponde, y además deja la
  // impresión de que arreglando los argumentos entraría.
  const decision = decidir(herramienta, quien.usuario.rol, turno);

  if (decision.clase === "bloquear") {
    await anotar(quien, peticion, herramienta, "bloqueada", { error: decision.explicacion });
    return fallo("no_autorizado", decision.explicacion);
  }

  const validos = herramienta.parametros.safeParse(peticion.argumentos);
  if (!validos.success) {
    const porque = validos.error.issues
      .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("; ");
    await anotar(quien, peticion, herramienta, "bloqueada", { error: porque });
    return fallo("entrada_invalida", porque);
  }

  if (decision.clase === "confirmar") {
    const accionId = ulid(quien.ahora);
    const resumen = resumir(herramienta.nombre, herramienta.nivel, validos.data, decision.explicacion);
    await anotar(quien, peticion, herramienta, "por_confirmar", { id: accionId, resumen });
    return ok({
      clase: "por_confirmar" as const,
      accionId,
      resumen,
      venceEn: quien.ahora + 30 * 60_000,
    });
  }

  // Lectura y construcción sin sospechas: directo, y auditado.
  const accionId = ulid(quien.ahora);
  try {
    const datos: unknown = await herramienta.ejecutar(
      {
        db: quien.db,
        usuario: quien.usuario,
        canal: peticion.canal,
        conversacionId: peticion.conversacionId,
        ahora: quien.ahora,
      },
      validos.data as never,
    );
    await anotar(quien, peticion, herramienta, "hecha", { id: accionId, resultado: datos });
    return ok({ clase: "hecha" as const, accionId, datos });
  } catch (e) {
    const porque = e instanceof Error ? e.message : String(e);
    await anotar(quien, peticion, herramienta, "error", { id: accionId, error: porque });
    return fallo("interno", porque);
  }
}

/**
 * Permitir o rechazar una acción que estaba esperando.
 *
 * Tres cosas que tienen que cumplirse, y las tres por una razón:
 *
 *  - **Solo quien la pidió.** En Telegram los botones viven en un chat, y sin
 *    esto cualquiera con acceso a ese chat confirmaría un cobro ajeno.
 *  - **Antes de 30 minutos.** Lo que se enseñó («cambiar el precio a $15») pudo
 *    dejar de ser verdad; confirmar a ciegas algo de ayer es peor que repetirlo.
 *  - **Una sola vez.** Lo hace cumplir la BASE, no este código: el trigger
 *    `acciones_solo_se_cierran_una_vez` aborta el segundo UPDATE. Por eso la
 *    acción se cierra ANTES de ejecutar.
 */
export async function confirmar(
  quien: Quien,
  registro: Registro,
  accionId: string,
  decision: "permitir" | "rechazar",
): Promise<Resultado<Desenlace>> {
  const fila = await quien.db
    .prepare(
      `SELECT id, herramienta, canal, usuario_id, conversacion_id, argumentos_json, estado, creado_en
       FROM acciones WHERE id = ?`,
    )
    .bind(accionId)
    .first<{
      id: string;
      herramienta: string;
      canal: string;
      usuario_id: string;
      conversacion_id: string | null;
      argumentos_json: string;
      estado: string;
      creado_en: number;
    }>();

  if (fila === null) return fallo("no_encontrado", "esa acción no existe");
  if (fila.estado !== "por_confirmar") {
    return fallo("repetido", `esa acción ya está ${fila.estado}`);
  }
  if (!puedeConfirmar(fila, quien.usuario.id)) {
    return fallo("no_autorizado", "solo puede confirmarla quien la pidió");
  }

  if (estaVencida(fila.creado_en, quien.ahora)) {
    await cerrar(quien, accionId, "vencida", { error: "nadie la confirmó en 30 minutos" });
    return fallo("transicion_invalida", "esa acción venció: pídala otra vez");
  }

  if (decision === "rechazar") {
    await cerrar(quien, accionId, "rechazada", {});
    return ok({ clase: "hecha" as const, accionId, datos: { rechazada: true } });
  }

  const herramienta = registro.buscar(fila.herramienta);
  if (herramienta === undefined) {
    // La herramienta desapareció entre que se propuso y se confirmó: pasa si
    // se despliega en medio. Mejor fallar que ejecutar otra cosa.
    await cerrar(quien, accionId, "error", { error: "la herramienta ya no existe" });
    return fallo("no_encontrado", "esa herramienta ya no existe; vuelva a pedirlo");
  }

  // Los argumentos salen de la BASE, no de quien confirma: es lo que garantiza
  // que se ejecute lo que la persona leyó y no otra cosa. El trigger
  // `acciones_lo_demas_no_se_edita` impide además que alguien los cambiara.
  const validos = herramienta.parametros.safeParse(JSON.parse(fila.argumentos_json));
  if (!validos.success) {
    await cerrar(quien, accionId, "error", { error: "los argumentos guardados ya no valen" });
    return fallo("entrada_invalida", "los argumentos guardados ya no son válidos");
  }

  // Se cierra ANTES de ejecutar. Si se cerrara después, dos confirmaciones a la
  // vez pasarían las dos la comprobación y ejecutarían dos veces; aquí la
  // segunda choca con el trigger y no llega a ejecutar nada.
  const cerrada = await cerrar(quien, accionId, "hecha", {});
  if (!cerrada) return fallo("repetido", "esa acción ya se confirmó");

  try {
    const datos: unknown = await herramienta.ejecutar(
      {
        db: quien.db,
        usuario: quien.usuario,
        canal: fila.canal as Canal,
        conversacionId: fila.conversacion_id,
        ahora: quien.ahora,
      },
      validos.data as never,
    );
    // El resultado se guarda aparte: la fila ya está cerrada y el trigger solo
    // deja cambiar lo que no es el desenlace... así que no se reescribe. Queda
    // en el `resultado_json` de la fila de cierre, que es lo que se escribió.
    await quien.db
      .prepare("UPDATE acciones SET resultado_json = ? WHERE id = ? AND resultado_json IS NULL")
      .bind(JSON.stringify(datos), accionId)
      .run()
      .catch(() => undefined);
    return ok({ clase: "hecha" as const, accionId, datos });
  } catch (e) {
    return fallo("interno", e instanceof Error ? e.message : String(e));
  }
}

/** Vence lo que nadie confirmó. Lo llama el cron. */
export async function vencerPendientes(db: D1Database, ahora: number): Promise<number> {
  const limite = ahora - 30 * 60_000;
  const r = await db
    .prepare(
      `UPDATE acciones SET estado = 'vencida', cerrada_en = ?, error = 'nadie la confirmó en 30 minutos'
       WHERE estado = 'por_confirmar' AND creado_en <= ?`,
    )
    .bind(ahora, limite)
    .run();
  return r.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// La bitácora
// ---------------------------------------------------------------------------

async function anotar(
  quien: Quien,
  peticion: PeticionDeHerramienta,
  herramienta: { nombre: string; nivel: string; categoria: string },
  estado: "hecha" | "error" | "bloqueada" | "por_confirmar",
  extra: { id?: string; resultado?: unknown; error?: string; resumen?: string },
): Promise<void> {
  const cerrada = estado === "por_confirmar" ? null : quien.ahora;
  await quien.db
    .prepare(
      `INSERT INTO acciones
         (id, herramienta, nivel, categoria, canal, usuario_id, conversacion_id, argumentos_json,
          resultado_json, error, resumen, estado, con_adjuntos, texto_externo, creado_en, cerrada_en)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      extra.id ?? ulid(quien.ahora),
      herramienta.nombre,
      herramienta.nivel,
      herramienta.categoria,
      peticion.canal,
      quien.usuario.id,
      peticion.conversacionId,
      JSON.stringify(peticion.argumentos),
      extra.resultado === undefined ? null : JSON.stringify(extra.resultado),
      extra.error ?? null,
      extra.resumen ?? null,
      estado,
      peticion.conAdjuntos ? 1 : 0,
      peticion.textoExterno ? 1 : 0,
      quien.ahora,
      cerrada,
    )
    .run();
}

/** Cierra una acción. Devuelve false si el trigger lo impidió. */
async function cerrar(
  quien: Quien,
  accionId: string,
  estado: "hecha" | "rechazada" | "vencida" | "error",
  extra: { error?: string },
): Promise<boolean> {
  try {
    const r = await quien.db
      .prepare("UPDATE acciones SET estado = ?, cerrada_en = ?, error = ? WHERE id = ?")
      .bind(estado, quien.ahora, extra.error ?? null, accionId)
      .run();
    return (r.meta.changes ?? 0) > 0;
  } catch {
    // El trigger aborta si ya estaba cerrada. Eso no es un fallo del sistema:
    // es la idempotencia funcionando.
    return false;
  }
}

/**
 * El resumen que lee la persona antes de permitir.
 *
 * Tiene que decir QUÉ va a pasar con los números concretos. «¿Permite
 * cambiar_precio?» no es una pregunta que nadie pueda contestar bien; «Cambiar
 * el precio de NAT-M a $15.00» sí.
 */
export function resumir(
  nombre: string,
  nivel: "lectura" | "construccion" | "sensible",
  args: unknown,
  porque: string,
): string {
  const partes: string[] = [];
  if (args !== null && typeof args === "object") {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      partes.push(`${k.replaceAll("_", " ")}: ${comoSeLee(k, v)}`);
    }
  }
  const que = `${COMO_SE_LEE_EL_NIVEL[nivel]} «${nombre.replaceAll("_", " ")}»`;
  return partes.length > 0 ? `${que} — ${partes.join(", ")} (${porque})` : `${que} (${porque})`;
}

/** Los centavos se leen en dólares: nadie confirma «150000» a ojo. */
function comoSeLee(clave: string, valor: unknown): string {
  if (clave.endsWith("_cents") && typeof valor === "number") {
    const signo = valor < 0 ? "-" : "";
    const abs = Math.abs(valor);
    return `${signo}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  }
  return String(valor);
}
