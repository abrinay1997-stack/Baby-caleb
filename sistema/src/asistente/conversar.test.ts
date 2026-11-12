import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { conversar } from "./conversar";
import { TOPES } from "./politica";
import { guionFijo, type Parlamento } from "./proveedor";
import { Registro, definir } from "./registro";
import type { Contexto } from "./registro";

/**
 * El bucle de Caleb.
 *
 * Las piezas estaban todas y ninguna se tocaba con otra. Esto comprueba el
 * hilo: que una herramienta se ejecute y su resultado vuelva al modelo, que
 * una acción sensible PARE el turno en vez de seguir como si hubiera pasado,
 * que un error vuelva en palabras, y que el turno termine siempre.
 *
 * Las herramientas son de mentira a propósito: lo que se prueba es el hilo, no
 * el inventario. Las de verdad ya tienen sus pruebas.
 */

// Correos propios de este archivo: `usuarios.correo` es UNIQUE, y con uno
// repetido el INSERT OR IGNORE no crea nada, el usuario no existe y lo que
// falla después es una clave foránea que no dice de dónde viene.
const duena: Contexto["usuario"] = { id: "u-conv-duena", correo: "conv-duena@babycaleb.com", rol: "duena" };
const asistente: Contexto["usuario"] = { id: "u-conv-asis", correo: "conv-asis@babycaleb.com", rol: "asistente" };

let ejecutadas: string[] = [];

const mirar = definir({
  nombre: "mirar",
  descripcion: "Mira algo.",
  parametros: z.object({}),
  nivel: "lectura",
  categoria: "inventario",
  roles: ["duena", "asistente", "contadora"],
  async ejecutar() {
    ejecutadas.push("mirar");
    return { quedan: 12 };
  },
});

const leerMensajes = definir({
  nombre: "leer_mensajes",
  descripcion: "Lee lo que escribió una clienta.",
  parametros: z.object({}),
  nivel: "lectura",
  categoria: "inventario",
  roles: ["duena"],
  textoExterno: true,
  async ejecutar() {
    ejecutadas.push("leer_mensajes");
    return { texto: "hola, ¿tienen talla M?" };
  },
});

const anotar = definir({
  nombre: "anotar",
  descripcion: "Anota algo.",
  parametros: z.object({}),
  nivel: "construccion",
  categoria: "inventario",
  roles: ["duena"],
  async ejecutar() {
    ejecutadas.push("anotar");
    return { anotado: true };
  },
});

const cambiar = definir({
  nombre: "cambiar",
  descripcion: "Cambia un precio.",
  parametros: z.object({}),
  nivel: "sensible",
  categoria: "inventario",
  roles: ["duena"],
  async ejecutar() {
    ejecutadas.push("cambiar");
    return { cambiado: true };
  },
});

/** Devuelve lo que NUNCA debe llegarle al modelo (D-20). */
const verClienta = definir({
  nombre: "ver_clienta",
  descripcion: "Trae la ficha de una clienta.",
  parametros: z.object({}),
  nivel: "lectura",
  categoria: "inventario",
  roles: ["duena"],
  async ejecutar() {
    ejecutadas.push("ver_clienta");
    return {
      nombre: "Rosalinda Quintero",
      celular: "60001234",
      correo: "rosalinda@ejemplo.com",
      debe_cents: 4500,
    };
  },
});

const registro = new Registro();
for (const h of [mirar, leerMensajes, anotar, cambiar, verClienta]) registro.registrar(h as never);

const quien = (usuario = duena) => ({ db: real.DB, usuario, ahora: Date.now() });

const hablar = (...guion: Parlamento[]) => guionFijo(guion);

const pedir = (texto = "¿cuánto hay?") => ({
  sistema: "Eres Caleb.",
  mensajes: [{ rol: "user" as const, contenido: texto }],
  canal: "panel" as const,
  conversacionId: null,
});

beforeEach(async () => {
  ejecutadas = [];
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, ?, 'duena', 1, ?)",
    ).bind(duena.id, duena.correo, "Dueña de prueba", Date.now()),
    real.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id, correo, nombre, rol, activo, creado_en) VALUES (?, ?, ?, 'asistente', 1, ?)",
    ).bind(asistente.id, asistente.correo, "Asistente de prueba", Date.now()),
  ]);
});

describe("conversar", () => {
  it("contesta sin herramientas cuando no hacen falta", async () => {
    const final = await conversar(quien(), registro, hablar({ texto: "Buenas, ¿en qué le ayudo?" }), pedir("hola"));

    expect(final.clase).toBe("dijo");
    expect(final.texto).toBe("Buenas, ¿en qué le ayudo?");
    expect(ejecutadas).toEqual([]);
  });

  it("ejecuta la herramienta y le devuelve el resultado al modelo", async () => {
    const final = await conversar(
      quien(),
      registro,
      hablar(
        { texto: "Déjeme ver.", llamadas: [{ id: "t1", nombre: "mirar", argumentos: {} }] },
        { texto: "Quedan 12." },
      ),
      pedir(),
    );

    expect(final.clase).toBe("dijo");
    expect(final.texto).toBe("Quedan 12.");
    expect(ejecutadas).toEqual(["mirar"]);

    // El turno del modelo guarda lo que PIDIÓ, no solo lo que dijo: sin eso la
    // segunda vuelta manda un resultado que apunta a un id inexistente.
    const delModelo = final.historial.find((m) => m.rol === "assistant" && m.llamadas !== undefined);
    expect(delModelo?.llamadas?.[0]?.id).toBe("t1");

    const resultado = final.historial.find((m) => m.rol === "tool");
    expect(resultado?.llamadaId).toBe("t1");
    expect(resultado?.contenido).toContain("12");
  });

  it("una acción sensible PARA el turno y no se ejecuta", async () => {
    const final = await conversar(
      quien(),
      registro,
      hablar(
        { texto: "Se lo cambio.", llamadas: [{ id: "t1", nombre: "cambiar", argumentos: {} }] },
        { texto: "Listo, ya está cambiado." }, // esto NO debe llegar a pasar
      ),
      pedir("súbele el precio"),
    );

    expect(final.clase).toBe("pide_permiso");
    // Lo que importa: NO se ejecutó.
    expect(ejecutadas).toEqual([]);
    if (final.clase === "pide_permiso") {
      expect(final.accionId).toBeTruthy();
      expect(final.resumen).toBeTruthy();
    }
  });

  it("si una acción queda esperando, lo demás del turno tampoco se ejecuta", async () => {
    // Pero sí se contesta: un tool_use sin su resultado al lado deja el
    // historial roto para cuando la persona vuelva.
    const final = await conversar(
      quien(),
      registro,
      hablar({
        texto: "",
        llamadas: [
          { id: "t1", nombre: "cambiar", argumentos: {} },
          { id: "t2", nombre: "mirar", argumentos: {} },
        ],
      }),
      pedir(),
    );

    expect(final.clase).toBe("pide_permiso");
    expect(ejecutadas).toEqual([]);

    const ids = final.historial.filter((m) => m.rol === "tool").map((m) => m.llamadaId);
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("un error vuelve al modelo en palabras, no revienta", async () => {
    const final = await conversar(
      quien(asistente), // no puede usar «cambiar»
      registro,
      hablar(
        { texto: "", llamadas: [{ id: "t1", nombre: "cambiar", argumentos: {} }] },
        { texto: "No puedo cambiar precios; pídaselo a la dueña." },
      ),
      pedir("súbele el precio"),
    );

    expect(final.clase).toBe("dijo");
    expect(final.texto).toContain("No puedo cambiar precios");
    expect(ejecutadas).toEqual([]);

    const resultado = final.historial.find((m) => m.rol === "tool");
    expect(resultado?.contenido).toContain("no_autorizado");
  });

  it("leer texto de una clienta hace que anotar pase por la persona", async () => {
    // La defensa contra la inyección: una vez que el modelo leyó algo escrito
    // por alguien de fuera, lo que pida construir deja de ser directo.
    const final = await conversar(
      quien(),
      registro,
      hablar({
        texto: "",
        llamadas: [
          { id: "t1", nombre: "leer_mensajes", argumentos: {} },
          { id: "t2", nombre: "anotar", argumentos: {} },
        ],
      }),
      pedir(),
    );

    expect(ejecutadas).toEqual(["leer_mensajes"]); // «anotar» no corrió
    expect(final.clase).toBe("pide_permiso");
    if (final.clase === "pide_permiso") {
      expect(final.resumen.length).toBeGreaterThan(0);
    }
  });

  it("quinientas llamadas de golpe no son quinientas filas en la bitácora", async () => {
    // El presupuesto es del TURNO. Sin eso, el tope de la política bloquearía
    // una a una — pero bloquear también escribe, así que una sola respuesta
    // del modelo llenaría la bitácora.
    const conversacionId = `conv-tope-${Date.now()}`;
    const final = await conversar(
      quien(),
      registro,
      hablar(
        {
          texto: "",
          llamadas: Array.from({ length: 500 }, (_, i) => ({
            id: `t${i}`,
            nombre: "mirar",
            argumentos: {},
          })),
        },
        { texto: "Ya le digo." },
      ),
      { ...pedir(), conversacionId },
    );

    // Todas se contestan —si no, el historial queda roto—, pero solo las del
    // presupuesto llegan al ejecutor.
    expect(final.historial.filter((m) => m.rol === "tool")).toHaveLength(500);
    expect(ejecutadas.length).toBe(TOPES.pasosPorTurno);

    const filas = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM acciones WHERE conversacion_id = ?",
    )
      .bind(conversacionId)
      .first<{ n: number }>();
    expect(filas?.n).toBe(TOPES.pasosPorTurno);
  });

  it("y quinientas llamadas BLOQUEADAS tampoco", async () => {
    // Bloquear también escribe. Así que una llamada que la política rechaza
    // tiene que gastar paso igual: si solo contaran las que salen bien, un
    // modelo pidiendo lo que su rol no puede llenaría la bitácora sin tope.
    const conversacionId = `conv-bloq-${Date.now()}`;
    await conversar(
      quien(asistente), // no puede usar «cambiar»
      registro,
      hablar(
        {
          texto: "",
          llamadas: Array.from({ length: 500 }, (_, i) => ({
            id: `b${i}`,
            nombre: "cambiar",
            argumentos: {},
          })),
        },
        { texto: "No puedo cambiar precios." },
      ),
      { ...pedir(), conversacionId },
    );

    expect(ejecutadas).toEqual([]);
    const filas = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM acciones WHERE conversacion_id = ?",
    )
      .bind(conversacionId)
      .first<{ n: number }>();
    expect(filas?.n).toBe(TOPES.pasosPorTurno);
  });

  it("un modelo que nunca para termina igual, y lo dice", async () => {
    // El tope de la política bloquea llamadas, pero un modelo terco seguiría
    // pidiendo. El tope de vueltas es el que garantiza que se sale.
    const terco: Parlamento[] = Array.from({ length: 40 }, (_, i) => ({
      texto: "",
      llamadas: [{ id: `t${i}`, nombre: "mirar", argumentos: {} }],
    }));

    const final = await conversar(quien(), registro, hablar(...terco), pedir());

    expect(final.clase).toBe("dijo");
    expect(final.texto).toContain("No pude terminar");
    // La política cortó: nunca se ejecutaron más de los pasos permitidos.
    expect(ejecutadas.length).toBeLessThanOrEqual(TOPES.pasosPorTurno);
  });
});

// ---------------------------------------------------------------------------
// D-20 · los datos de una clienta no salen hacia el modelo
// ---------------------------------------------------------------------------
//
// `referencias.revisar()` estaba escrito y probado para esto y no lo llamaba
// nadie. Mientras el asistente no tuvo puerta, la regla no costaba nada
// incumplirla porque no salía nada. Abrir la puerta es lo que la vuelve real.

describe("lo que sale hacia el modelo", () => {
  it("no lleva el celular ni el correo de una clienta", async () => {
    const final = await conversar(
      quien(),
      registro,
      hablar(
        { texto: "", llamadas: [{ id: "t1", nombre: "ver_clienta", argumentos: {} }] },
        { texto: "No puedo enseñarle esos datos." },
      ),
      pedir("¿quién me debe?"),
    );

    const resultado = final.historial.find((m) => m.rol === "tool");
    expect(resultado).toBeDefined();

    // Lo que importa: el dato NO está.
    expect(resultado?.contenido).not.toContain("60001234");
    expect(resultado?.contenido).not.toContain("rosalinda@ejemplo.com");
    // Y se le dice al modelo QUÉ clase de dato era, para que lo explique.
    expect(resultado?.contenido).toContain("celular");
    expect(resultado?.contenido).toContain("correo");
  });

  it("tampoco lleva el nombre, si esa clienta existe en la base", async () => {
    // Un nombre propio no tiene forma reconocible: la única manera honesta de
    // cazarlo es preguntarle a la base quién existe.
    const id = `cli-d20-${Date.now()}`;
    await real.DB.prepare(
      "INSERT INTO clientes (id, nombre, creado_en, actualizado_en) VALUES (?, 'Rosalinda', ?, ?)",
    )
      .bind(id, Date.now(), Date.now())
      .run();

    const final = await conversar(
      quien(),
      registro,
      hablar(
        { texto: "", llamadas: [{ id: "t1", nombre: "ver_clienta", argumentos: {} }] },
        { texto: "No puedo." },
      ),
      pedir(),
    );

    const resultado = final.historial.find((m) => m.rol === "tool");
    expect(resultado?.contenido).not.toContain("Rosalinda");
    expect(resultado?.contenido).toContain("nombre_de_clienta");

    await real.DB.prepare("DELETE FROM clientes WHERE id = ?").bind(id).run();
  });

  it("un resultado sin datos de nadie pasa entero", async () => {
    // Si el filtro se pasara de celoso, el asistente dejaría de servir. Las
    // cifras del negocio SÍ van: eso lo aceptó el dueño del proyecto.
    const final = await conversar(
      quien(),
      registro,
      hablar(
        { texto: "", llamadas: [{ id: "t1", nombre: "mirar", argumentos: {} }] },
        { texto: "Quedan 12." },
      ),
      pedir(),
    );

    const resultado = final.historial.find((m) => m.rol === "tool");
    expect(resultado?.contenido).toContain("12");
    expect(resultado?.contenido).not.toContain("no se le pueden enseñar");
  });
});
