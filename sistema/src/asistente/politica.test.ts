import { describe, expect, it } from "vitest";
import {
  TOPES,
  TURNO_LIMPIO,
  type Turno,
  decidir,
  estaVencida,
  puedeConfirmar,
  revisarArgumentos,
  revisarMensaje,
} from "./politica";

const lectura = { nombre: "ver_stock", nivel: "lectura" as const, roles: ["duena", "asistente"] as const };
const construccion = {
  nombre: "registrar_gasto",
  nivel: "construccion" as const,
  roles: ["duena", "asistente"] as const,
};
const sensible = { nombre: "cambiar_precio", nivel: "sensible" as const, roles: ["duena"] as const };

const turno = (cambios: Partial<Turno> = {}): Turno => ({ ...TURNO_LIMPIO, ...cambios });

describe("quién puede qué", () => {
  it("una herramienta que no es de su rol se bloquea", () => {
    // «El asistente nunca actúa con más permisos que la persona con quien
    // habla» (06-asistente §3, punto 5).
    const d = decidir(sensible, "asistente");
    expect(d.clase).toBe("bloquear");
  });

  it("y se bloquea ANTES de preguntar", () => {
    // Si se preguntara primero, se le enseñaría a la persona una tarjeta de
    // «¿permite esto?» para algo que su rol no puede hacer de todos modos.
    const d = decidir(sensible, "contadora", turno({ huboArchivoReciente: true }));
    expect(d.clase).toBe("bloquear");
  });

  it("lo de lectura va directo", () => {
    expect(decidir(lectura, "asistente").clase).toBe("ejecutar");
  });
});

describe("cuándo hay que preguntarle a la persona", () => {
  it("lo sensible siempre", () => {
    const d = decidir(sensible, "duena");
    expect(d).toMatchObject({ clase: "confirmar", porque: "nivel_sensible" });
  });

  it("construir va directo cuando no hay nada raro", () => {
    expect(decidir(construccion, "duena").clase).toBe("ejecutar");
  });

  it("construir PREGUNTA si hubo un archivo hace poco", () => {
    // Defensa de 06-asistente §7: lo que el modelo cree que le pidieron puede
    // venir de dentro del archivo, no de la persona.
    const d = decidir(construccion, "duena", turno({ huboArchivoReciente: true }));
    expect(d).toMatchObject({ clase: "confirmar", porque: "hubo_un_archivo" });
  });

  it("construir PREGUNTA si en el turno se leyó texto de una clienta", () => {
    const d = decidir(construccion, "duena", turno({ seLeyoTextoDeFuera: true }));
    expect(d).toMatchObject({ clase: "confirmar", porque: "se_leyo_texto_de_fuera" });
  });

  it("pero leer sigue siendo directo aunque haya habido un archivo", () => {
    // Endurecer la lectura no protege de nada —leer no cambia nada— y haría
    // que la dueña tuviera que tocar «Permitir» para preguntar cuánto hay.
    const d = decidir(lectura, "duena", turno({ huboArchivoReciente: true, seLeyoTextoDeFuera: true }));
    expect(d.clase).toBe("ejecutar");
  });
});

describe("el tope de pasos", () => {
  it("corta cuando el modelo ya usó ocho herramientas", () => {
    // Sin esto, un bucle del modelo gasta la cuota del mes en un turno.
    const d = decidir(lectura, "duena", turno({ pasosDados: TOPES.pasosPorTurno }));
    expect(d.clase).toBe("bloquear");
  });

  it("y deja pasar el octavo", () => {
    const d = decidir(lectura, "duena", turno({ pasosDados: TOPES.pasosPorTurno - 1 }));
    expect(d.clase).toBe("ejecutar");
  });
});

describe("tamaños", () => {
  it("un argumento enorme no pasa", () => {
    const r = revisarArgumentos({ nota: "x".repeat(TOPES.letrasPorArgumento + 1) });
    expect(r.ok).toBe(false);
  });

  it("ni muchos argumentos que juntos pasan del tope", () => {
    // Cada uno cabe; la suma no. Mirar solo cada campo dejaría pasar la mitad
    // de un megabyte repartida en treinta campos.
    const medio = "x".repeat(9_000);
    const r = revisarArgumentos({ a: medio, b: medio, c: medio, d: medio });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.explicacion).toMatch(/la llamada suma/);
  });

  it("mira dentro de listas y objetos", () => {
    const r = revisarArgumentos({ lineas: [{ nota: "x".repeat(TOPES.letrasPorArgumento + 1) }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.explicacion).toContain("lineas[0].nota");
  });

  it("lo normal pasa", () => {
    expect(revisarArgumentos({ codigo: "BC-001-03", cuantos: 20 }).ok).toBe(true);
  });

  it("un mensaje largo de más no pasa", () => {
    expect(revisarMensaje("x".repeat(TOPES.letrasPorMensaje + 1)).ok).toBe(false);
  });

  it("ni seis archivos de una vez", () => {
    expect(revisarMensaje("hola", TOPES.archivosPorMensaje + 1).ok).toBe(false);
    expect(revisarMensaje("hola", TOPES.archivosPorMensaje).ok).toBe(true);
  });
});

describe("confirmaciones", () => {
  const T = 1_762_000_000_000;

  it("vence a los 30 minutos", () => {
    expect(estaVencida(T, T + 29 * 60_000)).toBe(false);
    expect(estaVencida(T, T + 31 * 60_000)).toBe(true);
  });

  it("solo la confirma quien la pidió", () => {
    // En Telegram los botones viven en un chat: sin esto, cualquiera con
    // acceso a ese chat confirmaría un cobro que pidió otra persona.
    expect(puedeConfirmar({ usuario_id: "u1" }, "u1")).toBe(true);
    expect(puedeConfirmar({ usuario_id: "u1" }, "u2")).toBe(false);
  });
});
