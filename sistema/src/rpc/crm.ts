import { WorkerEntrypoint } from "cloudflare:workers";
import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import {
  type Disponibilidad,
  UMBRAL_POCAS,
  disponibilidad,
} from "../dominio/existencias";
import { buscarZona, sugerirZonas } from "../dominio/zonas";
import { ulid } from "../ids";
import {
  type Linea,
  type Movimiento,
  aplicar,
  deshacer as deshacerMovimientos,
  etiquetasDe,
  resolverLineas,
} from "../db/inventario";
import { type Actor, comoDuena, comoPersona, comoSeFirma } from "./actor";
import { type VariantePublica, buscar, listar } from "./catalogo";
import { zonasParaBuscar } from "./zonas";

/**
 * Lo que el CRM puede pedirle al sistema (03-contratos §3).
 *
 * El CRM deja de tener catálogo propio: lo pregunta aquí. Ese es el cambio que
 * da nombre a toda la fase — un dato, un solo dueño— y lo que hace que cambiar
 * un precio en el panel lo cambie en la web y en el bot sin publicar nada.
 *
 * Dos superficies distintas en la misma clase:
 *  - lo que puede el BOT: leer el catálogo y cotizar un envío. Nada más.
 *  - lo que puede la DUEÑA: ver stock, registrar ventas, ajustar y deshacer.
 *
 * La diferencia la hace `comoDuena()`, que no se cree el `actor` que manda el
 * CRM: lo cruza con `usuarios`. Un campo que manda quien llama no es una
 * credencial.
 */

export interface StockPorBodega {
  readonly codigo: string;
  readonly nombre: string;
  readonly porBodega: { bodega: string; fisico: number; reservado: number }[];
}

export interface MovimientoVista {
  readonly cuando: number;
  readonly codigo: string;
  readonly bodega: string;
  readonly delta: number;
  readonly tipo: string;
  readonly motivo: string | null;
  readonly actor: string;
  readonly deshacerId: string | null;
  readonly revierteA: string | null;
}

export interface IdentidadRef {
  readonly canal: string;
  readonly idExterno: string;
  readonly nombre?: string;
  readonly celular?: string;
}

/**
 * Una cantidad que llega de fuera: o no viene, o es un entero positivo.
 *
 * Un 0 o un -5 no son «sin cantidad»: son una pregunta mal hecha, y
 * contestarla como si no hubieran preguntado nada esconde el error.
 */
function normalizarCantidad(c: number | undefined): number | undefined | "invalida" {
  if (c === undefined) return undefined;
  return Number.isSafeInteger(c) && c > 0 ? c : "invalida";
}

export class SistemaCRM extends WorkerEntrypoint<Env> {
  // -------------------------------------------------------------------------
  // Catálogo · lo que reemplaza a CatalogRepo del CRM
  // -------------------------------------------------------------------------

  /**
   * `cantidad` es la única forma en que un número de inventario sale hacia el
   * bot, y solo cuando NO alcanza: «de 30 no, de 25 sí» es la respuesta útil y
   * no hay manera de darla sin el número. Si alcanza, basta un sí.
   */
  async buscarCatalogo(
    q: string,
    limite?: number,
    cantidad?: number,
  ): Promise<Resultado<VariantePublica[]>> {
    const pedida = normalizarCantidad(cantidad);
    if (pedida === "invalida") {
      return fallo("entrada_invalida", "la cantidad tiene que ser un entero positivo");
    }
    return ok(await buscar(this.env.DB, q, limite ?? 20, pedida));
  }

  async listarCatalogo(cantidad?: number): Promise<Resultado<VariantePublica[]>> {
    const pedida = normalizarCantidad(cantidad);
    if (pedida === "invalida") {
      return fallo("entrada_invalida", "la cantidad tiene que ser un entero positivo");
    }
    return ok(await listar(this.env.DB, pedida));
  }

  // -------------------------------------------------------------------------
  // Envíos · lo que el bot necesita para cotizar
  // -------------------------------------------------------------------------

  /**
   * Cuánto cuesta llevar algo a un sitio.
   *
   * Esto reemplaza a `member/zonas-envio.ts` del CRM, y la regla que traía de
   * allá se conserva entera: la respuesta es EXACTA o es «no la tengo». Nunca
   * un número aproximado. Vivía en la base de conocimiento, falló en
   * producción —una clienta preguntó por Tocumen, que está a $8, y el bot dijo
   * que no tenía esa tarifa— y por eso es una consulta y no una búsqueda por
   * parecido.
   */
  async cotizarEnvio(textoZona: string): Promise<
    Resultado<
      | { zona: string; tarifaCents: number | null; requierePagoTotal: boolean }
      | { zona: null; sugerencias: string[] }
    >
  > {
    const zonas = await zonasParaBuscar(this.env.DB);
    const encontrada = buscarZona(textoZona, zonas);

    if (encontrada === null) {
      // Sugerencias en vez de un número: que el bot pregunte «¿se refiere a
      // ...?» es útil; que invente una tarifa cuesta plata.
      return ok({
        zona: null,
        sugerencias: sugerirZonas(textoZona, zonas).map((z) => z.nombre),
      });
    }

    return ok({
      zona: encontrada.nombre,
      tarifaCents: encontrada.tarifa_cents,
      requierePagoTotal: encontrada.requiere_pago_total,
    });
  }

  // -------------------------------------------------------------------------
  // Clientes
  // -------------------------------------------------------------------------

  /**
   * De «este chat de WhatsApp» a «esta clienta».
   *
   * Una persona escribe por WhatsApp, vuelve por Instagram y compra por la web:
   * son tres identidades y una sola clienta. Aquí se resuelve, y si llega un
   * celular que ya tiene dueña se PROPONE la fusión en vez de hacerla — juntar
   * dos clientas es irreversible y lo decide una persona (02-datos §6).
   */
  async clientePorIdentidad(
    r: IdentidadRef,
  ): Promise<Resultado<{ clienteId: string; nuevo: boolean; fusionPropuesta?: string }>> {
    const canal = r.canal.trim();
    const idExterno = r.idExterno.trim();
    if (canal === "" || idExterno === "") {
      return fallo("entrada_invalida", "hacen falta el canal y el identificador");
    }

    const ahora = Date.now();

    const ya = await this.env.DB.prepare(
      "SELECT cliente_id FROM identidades WHERE canal = ? AND id_externo = ?",
    )
      .bind(canal, idExterno)
      .first<{ cliente_id: string }>();

    if (ya !== null) {
      const resuelto = await this.#siguiendoFusiones(ya.cliente_id);
      return ok({ clienteId: resuelto, nuevo: false });
    }

    // ¿El celular ya es de alguien? Entonces es casi seguro la misma persona,
    // pero no se decide aquí.
    let fusionPropuesta: string | undefined;
    if (r.celular !== undefined && r.celular.trim() !== "") {
      const porCelular = await this.env.DB.prepare(
        "SELECT id FROM clientes WHERE celular_e164 = ? AND anonimizado_en IS NULL",
      )
        .bind(r.celular.trim())
        .first<{ id: string }>();
      if (porCelular !== null) fusionPropuesta = porCelular.id;
    }

    const clienteId = ulid(ahora);
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO clientes (id, nombre, creado_en, actualizado_en) VALUES (?,?,?,?)",
      ).bind(clienteId, r.nombre?.trim() ?? null, ahora, ahora),
      this.env.DB.prepare(
        "INSERT INTO identidades (canal, id_externo, cliente_id, creado_en) VALUES (?,?,?,?)",
      ).bind(canal, idExterno, clienteId, ahora),
    ]);

    return ok({ clienteId, nuevo: true, ...(fusionPropuesta === undefined ? {} : { fusionPropuesta }) });
  }

  /**
   * Una clienta fusionada apunta a la que quedó. Se sigue la cadena.
   *
   * El tope de 10 saltos no es paranoia: `fusionado_en_id` es una columna, y
   * una cadena circular mal escrita colgaría la petición para siempre.
   */
  async #siguiendoFusiones(id: string): Promise<string> {
    let actual = id;
    for (let i = 0; i < 10; i += 1) {
      const f = await this.env.DB.prepare("SELECT fusionado_en_id FROM clientes WHERE id = ?")
        .bind(actual)
        .first<{ fusionado_en_id: string | null }>();
      if (f?.fusionado_en_id == null) return actual;
      actual = f.fusionado_en_id;
    }
    return actual;
  }

  // -------------------------------------------------------------------------
  // Inventario · solo la dueña
  // -------------------------------------------------------------------------

  async stockDetallado(actor: Actor, codigo?: string): Promise<Resultado<StockPorBodega[]>> {
    const quien = await comoDuena(this.env.DB, actor);
    if (!quien.ok) return quien;

    const { results } = await this.env.DB.prepare(
      `SELECT v.codigo, v.nombre, b.nombre AS bodega, e.fisico, e.reservado
       FROM existencias e
       JOIN variantes v ON v.codigo = e.codigo
       JOIN bodegas b ON b.id = e.bodega_id
       WHERE (?1 IS NULL OR v.codigo = ?1)
       ORDER BY v.codigo, b.nombre`,
    )
      .bind(codigo ?? null)
      .all<{ codigo: string; nombre: string; bodega: string; fisico: number; reservado: number }>();

    const porCodigo = new Map<string, StockPorBodega>();
    for (const f of results) {
      const ya = porCodigo.get(f.codigo);
      const fila = { bodega: f.bodega, fisico: f.fisico, reservado: f.reservado };
      if (ya === undefined) {
        porCodigo.set(f.codigo, { codigo: f.codigo, nombre: f.nombre, porBodega: [fila] });
      } else {
        ya.porBodega.push(fila);
      }
    }

    return ok([...porCodigo.values()]);
  }

  async movimientos(actor: Actor, codigo?: string, n?: number): Promise<Resultado<MovimientoVista[]>> {
    const quien = await comoDuena(this.env.DB, actor);
    if (!quien.ok) return quien;

    const tope = Math.min(Math.max(Math.trunc(n ?? 30), 1), 200);
    const { results } = await this.env.DB.prepare(
      `SELECT m.creado_en, m.codigo, b.nombre AS bodega, m.delta, m.tipo, m.motivo,
              m.actor, m.referencia_id, m.revierte_id
       FROM movimientos_inventario m
       JOIN bodegas b ON b.id = m.bodega_id
       WHERE (?1 IS NULL OR m.codigo = ?1)
       ORDER BY m.creado_en DESC, m.id DESC
       LIMIT ?2`,
    )
      .bind(codigo ?? null, tope)
      .all<{
        creado_en: number;
        codigo: string;
        bodega: string;
        delta: number;
        tipo: string;
        motivo: string | null;
        actor: string;
        referencia_id: string | null;
        revierte_id: string | null;
      }>();

    return ok(
      results.map((m) => ({
        cuando: m.creado_en,
        codigo: m.codigo,
        bodega: m.bodega,
        delta: m.delta,
        tipo: m.tipo,
        motivo: m.motivo,
        actor: m.actor,
        deshacerId: m.referencia_id,
        revierteA: m.revierte_id,
      })),
    );
  }

  /**
   * Una venta de mostrador: sale del inventario y se anota quién y por qué.
   *
   * Devuelve las etiquetas de DESPUÉS de mover para que la consola conteste en
   * el mismo turno. Tienen que ser las de después: con las de antes, el bot
   * diría que hay de algo de lo que se acaba de llevar la última caja.
   */
  async registrarVenta(
    actor: Actor,
    e: {
      idempotencia: string;
      lineas: Linea[];
      pagado: "todo" | "abono" | "nada";
      metodo?: string;
      clienteRef?: IdentidadRef;
    },
  ): Promise<
    Resultado<{ numero: string; deshacerId: string; etiquetas: Record<string, Disponibilidad> }>
  > {
    const quien = await comoDuena(this.env.DB, actor);
    if (!quien.ok) return quien;

    const repetida = await this.#yaHecha<{
      numero: string;
      deshacerId: string;
      etiquetas: Record<string, Disponibilidad>;
    }>(e.idempotencia, "registrarVenta");
    if (repetida !== null) return ok(repetida);

    const resueltas = await resolverLineas(this.env.DB, e.lineas);
    if (!resueltas.ok) return resueltas;

    const ahora = Date.now();
    const referenciaId = ulid(ahora);
    const numero = `V-${referenciaId.slice(-8)}`;

    const movido = await aplicar(
      { db: this.env.DB, actor: comoSeFirma(actor, quien.datos), ahora },
      resueltas.datos.map((l) => ({
        codigo: l.codigo,
        bodegaId: l.bodegaId,
        delta: -l.cantidad,
        tipo: "venta" as const,
      })),
      { tipo: "venta", id: referenciaId },
    );
    if (!movido.ok) return movido;

    const libres = await etiquetasDe(this.env.DB, resueltas.datos.map((l) => l.codigo));
    const etiquetas = Object.fromEntries(
      Object.entries(libres).map(([c, n]) => [c, disponibilidad(n, UMBRAL_POCAS)]),
    );

    const respuesta = { numero, deshacerId: referenciaId, etiquetas };
    await this.#anotarHecha(e.idempotencia, "registrarVenta", respuesta, ahora);
    return ok(respuesta);
  }

  /**
   * Una devolución.
   *
   * `vuelveAlInventario` es la pregunta que importa: una caja que vuelve
   * cerrada se repone y una mojada no. Si no vuelve, se anota igual —como
   * merma— porque lo que no se anota desaparece de los libros y luego no cuadra
   * el conteo.
   */
  async registrarDevolucion(
    actor: Actor,
    e: {
      idempotencia: string;
      numero?: string;
      codigo: string;
      cantidad: number;
      vuelveAlInventario: boolean;
      motivo: string;
    },
  ): Promise<Resultado<{ deshacerId: string }>> {
    const quien = await comoDuena(this.env.DB, actor);
    if (!quien.ok) return quien;

    if (e.motivo.trim() === "") {
      return fallo("entrada_invalida", "una devolución necesita motivo");
    }

    const repetida = await this.#yaHecha<{ deshacerId: string }>(
      e.idempotencia,
      "registrarDevolucion",
    );
    if (repetida !== null) return ok(repetida);

    const resueltas = await resolverLineas(this.env.DB, [
      // Una devolución ENTRA, así que no hace falta que haya existencia: se
      // pide 0 para que `resolverLineas` elija bodega sin exigir inventario.
      { codigo: e.codigo, cantidad: e.cantidad },
    ]);

    // Si no encontró bodega es porque no hay ninguna con ese artículo: para
    // una entrada vale cualquiera que lo tenga dado de alta.
    const bodegaId = resueltas.ok
      ? resueltas.datos[0]!.bodegaId
      : (
          await this.env.DB.prepare(
            `SELECT e.bodega_id FROM existencias e JOIN bodegas b ON b.id = e.bodega_id
             WHERE e.codigo = ? AND b.activa = 1 ORDER BY b.nombre LIMIT 1`,
          )
            .bind(e.codigo)
            .first<{ bodega_id: string }>()
        )?.bodega_id;

    if (bodegaId === undefined || bodegaId === null) {
      return fallo("no_encontrado", `${e.codigo} no está dado de alta en ninguna bodega activa`);
    }

    const ahora = Date.now();
    const referenciaId = ulid(ahora);

    // La devolución SIEMPRE entra. Si lo devuelto no sirve, sale después como
    // merma: dos movimientos, porque pasaron dos cosas —volvió y se perdió— y
    // uno solo contaría la mitad. Con un solo movimiento neto de cero, el
    // esquema además lo rechazaría (delta <> 0), y con razón.
    const movimientos: Movimiento[] = [
      { codigo: e.codigo, bodegaId, delta: e.cantidad, tipo: "devolucion", motivo: e.motivo },
    ];
    if (!e.vuelveAlInventario) {
      movimientos.push({
        codigo: e.codigo,
        bodegaId,
        delta: -e.cantidad,
        tipo: "merma",
        motivo: `no vuelve al inventario: ${e.motivo}`,
      });
    }

    const movido = await aplicar(
      { db: this.env.DB, actor: comoSeFirma(actor, quien.datos), ahora },
      movimientos,
      { tipo: "devolucion", id: referenciaId },
    );
    if (!movido.ok) return movido;

    const respuesta = { deshacerId: referenciaId };
    await this.#anotarHecha(e.idempotencia, "registrarDevolucion", respuesta, ahora);
    return ok(respuesta);
  }

  /**
   * Ajustar el stock a mano.
   *
   * `fijar` existe porque después de un conteo lo que se sabe es cuánto HAY, no
   * cuánto sobra o falta. Se traduce a un movimiento por la diferencia: el
   * libro sigue siendo una suma de movimientos y nunca un número reescrito.
   */
  async ajustarStock(
    actor: Actor,
    e: {
      idempotencia: string;
      codigo: string;
      bodega: string;
      modo: "sumar" | "restar" | "fijar";
      cantidad: number;
      motivo: string;
    },
  ): Promise<Resultado<{ deshacerId: string }>> {
    const quien = await comoDuena(this.env.DB, actor);
    if (!quien.ok) return quien;

    if (e.motivo.trim() === "") {
      return fallo("entrada_invalida", "un ajuste necesita motivo: es lo que explica el descuadre");
    }
    if (!Number.isSafeInteger(e.cantidad) || e.cantidad < 0) {
      return fallo("entrada_invalida", "la cantidad tiene que ser un entero de cero para arriba");
    }

    const repetida = await this.#yaHecha<{ deshacerId: string }>(e.idempotencia, "ajustarStock");
    if (repetida !== null) return ok(repetida);

    const fila = await this.env.DB.prepare(
      `SELECT e.fisico, e.bodega_id FROM existencias e JOIN bodegas b ON b.id = e.bodega_id
       WHERE e.codigo = ? AND b.nombre = ?`,
    )
      .bind(e.codigo, e.bodega)
      .first<{ fisico: number; bodega_id: string }>();

    if (fila === null) {
      return fallo("no_encontrado", `${e.codigo} no está en «${e.bodega}»`);
    }

    const delta =
      e.modo === "sumar" ? e.cantidad : e.modo === "restar" ? -e.cantidad : e.cantidad - fila.fisico;

    if (delta === 0) {
      // Fijar al número que ya hay no es un error, pero tampoco es un
      // movimiento: el esquema prohíbe delta = 0 y con razón.
      return fallo("entrada_invalida", `${e.codigo} ya está en ${e.cantidad} en «${e.bodega}»`);
    }

    const ahora = Date.now();
    const referenciaId = ulid(ahora);

    const movido = await aplicar(
      { db: this.env.DB, actor: comoSeFirma(actor, quien.datos), ahora },
      [{ codigo: e.codigo, bodegaId: fila.bodega_id, delta, tipo: "ajuste", motivo: e.motivo }],
      { tipo: "ajuste", id: referenciaId },
    );
    if (!movido.ok) return movido;

    const respuesta = { deshacerId: referenciaId };
    await this.#anotarHecha(e.idempotencia, "ajustarStock", respuesta, ahora);
    return ok(respuesta);
  }

  /** Deshacer lo último: escribir lo contrario, nunca borrar. */
  async deshacer(actor: Actor, deshacerId: string): Promise<Resultado<{ hecho: true }>> {
    const quien = await comoDuena(this.env.DB, actor);
    if (!quien.ok) return quien;

    const r = await deshacerMovimientos(
      { db: this.env.DB, actor: comoSeFirma(actor, quien.datos), ahora: Date.now() },
      deshacerId,
    );
    if (!r.ok) return r;
    return ok({ hecho: true as const });
  }

  /** Quién es quien pregunta, para que la consola pueda decirlo. */
  async quienSoy(actor: Actor): Promise<Resultado<{ nombre: string; rol: string }>> {
    const quien = await comoPersona(this.env.DB, actor);
    if (!quien.ok) return quien;
    return ok({ nombre: quien.datos.nombre, rol: quien.datos.rol });
  }

  // -------------------------------------------------------------------------
  // Idempotencia
  // -------------------------------------------------------------------------

  /**
   * Lo mismo pedido dos veces se contesta una vez.
   *
   * La consola reintenta, la red se corta y un botón se toca dos veces. Sin
   * esto, cada una de esas tres cosas descuenta el inventario otra vez.
   */
  async #yaHecha<T>(clave: string, ruta: string): Promise<T | null> {
    if (clave.trim() === "") return null;
    const fila = await this.env.DB.prepare(
      "SELECT respuesta_json FROM idempotencia WHERE clave = ? AND ruta = ? AND vence_en > ?",
    )
      .bind(clave, ruta, Date.now())
      .first<{ respuesta_json: string | null }>();

    if (fila?.respuesta_json == null) return null;
    try {
      return JSON.parse(fila.respuesta_json) as T;
    } catch {
      return null;
    }
  }

  async #anotarHecha(clave: string, ruta: string, respuesta: unknown, ahora: number): Promise<void> {
    if (clave.trim() === "") return;
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO idempotencia (clave, ruta, huella_entrada, respuesta_json, creado_en, vence_en)
       VALUES (?,?,?,?,?,?)`,
    )
      .bind(clave, ruta, "", JSON.stringify(respuesta), ahora, ahora + 24 * 60 * 60 * 1000)
      .run();
  }
}
