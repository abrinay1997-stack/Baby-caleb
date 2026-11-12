import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogo } from "./index";
import { CATEGORIAS, NIVELES, Registro, cerrado, definir } from "./registro";

const cualquiera = (nombre: string, extra: Record<string, unknown> = {}) =>
  definir({
    nombre,
    descripcion: "Hace algo. Ejemplo: algo.",
    parametros: z.object({}),
    nivel: "lectura" as const,
    categoria: "inventario" as const,
    roles: ["duena"] as const,
    ejecutar: async () => ({}),
    ...extra,
  }) as never;

describe("el registro", () => {
  it("entrega las herramientas SIEMPRE en el mismo orden", () => {
    // Orden fijo (06-asistente §6): con este modelo preseleccionar no ahorra
    // nada que importe, y una lista fija da respuestas más predecibles.
    const uno = new Registro();
    uno.registrar(cualquiera("ver_stock"));
    uno.registrar(cualquiera("anotar_algo"));

    const otro = new Registro();
    otro.registrar(cualquiera("anotar_algo"));
    otro.registrar(cualquiera("ver_stock"));

    expect(uno.todas().map((h) => h.nombre)).toEqual(otro.todas().map((h) => h.nombre));
  });

  it("no deja registrar dos veces el mismo nombre", () => {
    const r = new Registro();
    r.registrar(cualquiera("ver_stock"));
    // En producción esto se vería como «a veces hace una cosa y a veces otra».
    expect(() => r.registrar(cualquiera("ver_stock"))).toThrow(/ya está registrada/);
  });

  it("exige nombres en español, verbo + objeto, sin acentos", () => {
    for (const malo of ["VerStock", "ver stock", "ver-stock", "ñ", "v", "verás_stock"]) {
      expect(() => new Registro().registrar(cualquiera(malo)), malo).toThrow(/no sirve de nombre/);
    }
  });

  it("no deja una herramienta que no pueda usar nadie", () => {
    expect(() => new Registro().registrar(cualquiera("ver_algo", { roles: [] }))).toThrow(
      /no la puede usar nadie/,
    );
  });

  it("solo entrega a cada rol lo suyo", () => {
    const r = new Registro();
    r.registrar(cualquiera("ver_todo", { roles: ["duena", "asistente"] }));
    r.registrar(cualquiera("ver_libros", { roles: ["contadora"] }));

    expect(r.para("asistente").map((h) => h.nombre)).toEqual(["ver_todo"]);
    expect(r.para("contadora").map((h) => h.nombre)).toEqual(["ver_libros"]);
    // El motorizado no tiene asistente: su superficie es otra.
    expect(r.para("motorizado")).toEqual([]);
  });
});

describe("lo que se le manda al modelo", () => {
  it("cierra los objetos, también los de dentro", () => {
    // Sin `additionalProperties: false` un argumento de más viaja hasta el
    // servidor y hay que acordarse de descartarlo en cada herramienta. zod lo
    // pone en la raíz; lo de dentro se quedaba abierto.
    const esquema = cerrado(
      z.toJSONSchema(
        z.object({
          codigo: z.string(),
          donde: z.object({ bodega: z.string() }),
          lista: z.array(z.object({ x: z.number() })),
        }),
      ),
    );

    const texto = JSON.stringify(esquema);
    const abiertos = (texto.match(/"type":"object"/g) ?? []).length;
    const cerrados = (texto.match(/"additionalProperties":false/g) ?? []).length;
    expect(cerrados).toBe(abiertos);
  });

  it("cada definición lleva nombre, descripción y esquema", () => {
    for (const d of catalogo().definicionesPara("duena")) {
      expect(d.name).toMatch(/^[a-z][a-z0-9_]+$/);
      // La descripción es lo que lee el modelo para elegir: una línea vacía o
      // de tres palabras hace que elija mal, y eso no se ve hasta producción.
      expect(d.description.length).toBeGreaterThan(40);
      expect(d.input_schema["type"]).toBe("object");
      expect(d.input_schema["additionalProperties"]).toBe(false);
    }
  });
});

describe("el catálogo de verdad", () => {
  const todas = catalogo().todas();

  it("tiene herramientas", () => {
    expect(todas.length).toBeGreaterThan(0);
  });

  it("todas declaran un nivel y una categoría de los que existen", () => {
    for (const h of todas) {
      expect(NIVELES, h.nombre).toContain(h.nivel);
      expect(CATEGORIAS, h.nombre).toContain(h.categoria);
    }
  });

  it("lo que CAMBIA algo es sensible, nunca de construcción a secas", () => {
    // Esta prueba nació en F2.7 diciendo «hoy son todas de lectura», para
    // ponerse roja el día que entrara la primera que escribe —y obligar a
    // mirar que la política, la confirmación y la bitácora estuvieran listas—.
    // Se puso roja en F3.8 y eso hizo su trabajo. Ahora vigila lo siguiente:
    // que nada que toque precios o existencias entre como «construcción», que
    // se ejecuta directo sin que nadie lo permita.
    const queCambian = /cambiar|ajustar|trasladar|merma|anular|reembolsar|cobro|abono|cerrar_mes/;
    const mal = todas
      .filter((h) => queCambian.test(h.nombre) && h.nivel !== "sensible")
      .map((h) => h.nombre);
    expect(mal).toEqual([]);
  });

  it("y lo sensible es SOLO de la dueña", () => {
    for (const h of todas.filter((x) => x.nivel === "sensible")) {
      expect(h.roles, `${h.nombre} lo puede usar alguien más`).toEqual(["duena"]);
    }
  });

  it("toda herramienta que escribe pide un motivo, salvo las que solo cierran", () => {
    // Un cambio sin motivo es un descuadre sin explicación, y dentro de un mes
    // nadie se acuerda de por qué el stock bajó.
    //
    // La excepción se nombra una por una y con su razón, nunca por un patrón:
    // CERRAR no corrige nada ni mueve una cifra —cuenta lo que ya pasó y marca
    // el día como terminado—, y lo que explica un cierre es su propio
    // contenido: qué se entregó y cuánto se cobró, que la base ya guarda.
    // Además `cerrarRuta` no tiene dónde escribir un motivo, así que pedirlo
    // dejaría un parámetro que se ignora en silencio, que es la trampa §9. Lo
    // que sí queda de un cierre es quién y cuándo: su fila en `acciones` y
    // `rutas.cerrada_en`.
    const soloCierran = new Set(["cerrar_ruta"]);
    const queEscriben = todas.filter((x) => x.nivel !== "lectura" && !soloCierran.has(x.nombre));
    // Si la lista se vaciara, esta prueba pasaría sin mirar nada.
    expect(queEscriben.length).toBeGreaterThan(0);

    for (const h of queEscriben) {
      const forma = JSON.stringify(cerrado(z.toJSONSchema(h.parametros)));
      expect(forma, `${h.nombre} no pide motivo`).toContain("motivo");
    }
  });

  it("ninguna existe para borrar, para permisos, para secretos ni para SQL", () => {
    // Lo que el asistente nunca hace NO se comprueba en tiempo de ejecución:
    // no existe (06-asistente §3). Esto vigila que siga sin existir.
    const prohibido = /borrar|eliminar|permiso|rol_|secreto|clave|sql|consulta_libre|ejecutar/;
    expect(todas.filter((h) => prohibido.test(h.nombre)).map((h) => h.nombre)).toEqual([]);
  });
});
