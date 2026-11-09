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

  it("hoy son TODAS de lectura", () => {
    // F2.7 trae solo lectura (09-fases.md). Cuando entre la primera de
    // construcción o sensible, esta prueba se pone roja y obliga a mirar que la
    // política, la confirmación y la bitácora estén listas para ella —que es
    // exactamente cuando hay que mirarlo.
    expect(todas.filter((h) => h.nivel !== "lectura").map((h) => h.nombre)).toEqual([]);
  });

  it("ninguna existe para borrar, para permisos, para secretos ni para SQL", () => {
    // Lo que el asistente nunca hace NO se comprueba en tiempo de ejecución:
    // no existe (06-asistente §3). Esto vigila que siga sin existir.
    const prohibido = /borrar|eliminar|permiso|rol_|secreto|clave|sql|consulta_libre|ejecutar/;
    expect(todas.filter((h) => prohibido.test(h.nombre)).map((h) => h.nombre)).toEqual([]);
  });
});
