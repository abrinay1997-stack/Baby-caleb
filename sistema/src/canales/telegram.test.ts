import { describe, expect, it } from "vitest";
import { ulid } from "../ids";
import {
  ACTUALIZACION,
  LARGO_MENSAJE,
  MAX_CALLBACK,
  MAX_TROZOS,
  botonesDe,
  leerBoton,
  loQueLlega,
  secretoCoincide,
  trozos,
} from "./telegram";

/**
 * El protocolo de Telegram, sin red y sin base.
 *
 * Todo lo que se prueba aquí decide si un mensaje se atiende o se ignora, así
 * que son las reglas que más barato es romper sin notarlo: una forma de
 * actualización que no se contempló, un secreto comparado de más, un texto que
 * Telegram rechaza entero por largo.
 */

const actualizacion = (cuerpo: unknown) => {
  const leido = ACTUALIZACION.safeParse(cuerpo);
  if (!leido.success) return null;
  return loQueLlega(leido.data);
};

const mensajePrivado = (texto: string, id = 777) => ({
  update_id: 1,
  message: { message_id: 10, chat: { id, type: "private" }, from: { id }, text: texto },
});

describe("el secreto del webhook", () => {
  it("coincide cuando es el mismo", () => {
    expect(secretoCoincide("abc123", "abc123")).toBe(true);
  });

  it("no coincide con otro, ni con uno más largo que empieza igual", () => {
    expect(secretoCoincide("abc124", "abc123")).toBe(false);
    expect(secretoCoincide("abc1234", "abc123")).toBe(false);
    expect(secretoCoincide("abc12", "abc123")).toBe(false);
  });

  it("falla CERRADO: sin secreto configurado no pasa nadie", () => {
    // Es la misma regla que Access: sin configuración se cierra, no se abre.
    // Si esto devolviera true, un entorno sin el secreto puesto tendría el
    // webhook abierto a cualquiera — y no se notaría, porque funcionaría.
    expect(secretoCoincide("lo que sea", undefined)).toBe(false);
    expect(secretoCoincide("lo que sea", "")).toBe(false);
    expect(secretoCoincide("lo que sea", "   ")).toBe(false);
    expect(secretoCoincide(undefined, undefined)).toBe(false);
    // Y tampoco pasa quien no manda la cabecera.
    expect(secretoCoincide(null, "abc123")).toBe(false);
    expect(secretoCoincide(undefined, "abc123")).toBe(false);
  });
});

describe("qué hay que atender", () => {
  it("un mensaje de texto en un chat privado", () => {
    expect(actualizacion(mensajePrivado("¿cuánto queda de la M?"))).toEqual({
      clase: "texto",
      chatId: "777",
      texto: "¿cuánto queda de la M?",
    });
  });

  it("un mensaje sin texto —una foto, una nota de voz— se reconoce como tal", () => {
    expect(
      actualizacion({
        update_id: 2,
        message: { message_id: 11, chat: { id: 777, type: "private" }, from: { id: 777 } },
      }),
    ).toEqual({ clase: "sin_texto", chatId: "777" });
  });

  it("un chat de GRUPO no se atiende", () => {
    // Si el bot acaba en un grupo y ese grupo quedara vinculado, cualquiera de
    // sus miembros le hablaría a Caleb con los permisos de la dueña.
    expect(
      actualizacion({
        update_id: 3,
        message: { message_id: 12, chat: { id: -100, type: "group" }, from: { id: 777 }, text: "hola" },
      }),
    ).toBeNull();
  });

  it("ni un chat que dice ser de grupo con los dos ids iguales", () => {
    // Las dos guardas son distintas y hacen falta las dos. Esta prueba existe
    // porque la de arriba NO la distingue: un id de grupo es negativo, así que
    // la comprobación de «quien escribe es el dueño del chat» ya la rechazaba
    // y quitar la del tipo no ponía nada rojo (trampa nº 6 — si la mutación
    // sobrevive porque hay otra capa delante, hay que probar esta capa).
    expect(
      actualizacion({
        update_id: 31,
        message: {
          message_id: 14,
          chat: { id: 777, type: "group" },
          from: { id: 777 },
          text: "hola",
        },
      }),
    ).toBeNull();
  });

  it("un privado donde quien escribe NO es el dueño del chat tampoco", () => {
    // En un privado de Telegram `chat.id` y `from.id` son el mismo número. Que
    // no lo sean significa que esto no es la forma que creemos que es.
    expect(
      actualizacion({
        update_id: 4,
        message: { message_id: 13, chat: { id: 777, type: "private" }, from: { id: 999 }, text: "hola" },
      }),
    ).toBeNull();
  });

  it("lo que no es un mensaje ni un botón se ignora sin ruido", () => {
    // Por el webhook pasan avisos que no son mensajes. Un esquema estricto los
    // convertiría en errores de forma, o sea en ruido por cosas normales.
    expect(actualizacion({ update_id: 5, my_chat_member: { algo: true } })).toBeNull();
    expect(actualizacion({ update_id: 6 })).toBeNull();
  });

  it("un cuerpo sin update_id no es una actualización", () => {
    expect(ACTUALIZACION.safeParse({ message: { text: "hola" } }).success).toBe(false);
  });

  it("un botón tocado en un chat privado", () => {
    expect(
      actualizacion({
        update_id: 7,
        callback_query: {
          id: "cb-1",
          from: { id: 777 },
          data: "ok:ABC",
          message: { message_id: 20, chat: { id: 777, type: "private" }, from: { id: 1 } },
        },
      }),
    ).toEqual({ clase: "boton", chatId: "777", mensajeId: 20, callbackId: "cb-1", datos: "ok:ABC" });
  });

  it("un botón de un grupo, no", () => {
    expect(
      actualizacion({
        update_id: 8,
        callback_query: {
          id: "cb-2",
          from: { id: 777 },
          data: "ok:ABC",
          message: { message_id: 21, chat: { id: -100, type: "supergroup" }, from: { id: 1 } },
        },
      }),
    ).toBeNull();
  });

  it("un id de chat que no cabe en un entero seguro se descarta", () => {
    // `String(...)` de un número ya redondeado escribiría un chat que no
    // existe, y el cruce con `usuarios` podría dar contra otra fila.
    expect(
      actualizacion({
        update_id: 9,
        message: {
          message_id: 22,
          chat: { id: Number.MAX_SAFE_INTEGER + 2, type: "private" },
          from: { id: Number.MAX_SAFE_INTEGER + 2 },
          text: "hola",
        },
      }),
    ).toBeNull();
  });
});

describe("los botones de una acción sensible", () => {
  it("van y vuelven", () => {
    const id = ulid(Date.now());
    const botones = botonesDe(id);
    const datos = botones.inline_keyboard[0]!.map((b) => b.callback_data);
    expect(leerBoton(datos[0]!)).toEqual({ decision: "permitir", accionId: id });
    expect(leerBoton(datos[1]!)).toEqual({ decision: "rechazar", accionId: id });
  });

  it("caben en los 64 bytes que admite Telegram", () => {
    // Si no cupieran, Telegram rechazaría el mensaje ENTERO y la dueña no
    // vería ni la pregunta. Un ULID son 26 letras; el margen es de sobra, y
    // esta prueba es la que avisa si algún día el id crece.
    for (const boton of botonesDe(ulid(Date.now())).inline_keyboard[0]!) {
      expect(new TextEncoder().encode(boton.callback_data).length).toBeLessThanOrEqual(
        MAX_CALLBACK,
      );
    }
  });

  it("revienta en vez de mandar un callback_data que Telegram va a rechazar", () => {
    expect(() => botonesDe("X".repeat(MAX_CALLBACK))).toThrow(/64/);
  });

  it("un dato que no escribió botonesDe no se interpreta", () => {
    expect(leerBoton("permitir:ABC")).toBeNull();
    expect(leerBoton("ok:")).toBeNull();
    expect(leerBoton("ABC")).toBeNull();
    expect(leerBoton("")).toBeNull();
  });
});

describe("partir una respuesta larga", () => {
  it("un texto corto sale en un solo mensaje", () => {
    expect(trozos("Quedan 12 cajas.")).toEqual(["Quedan 12 cajas."]);
  });

  it("un texto vacío no manda nada", () => {
    expect(trozos("   \n ")).toEqual([]);
  });

  it("ningún trozo pasa del largo que acepta Telegram", () => {
    // Si uno pasara, Telegram rechaza el mensaje y la persona no ve NADA: un
    // corte feo se lee, un mensaje que no llegó no.
    const partes = trozos(`${"palabra ".repeat(2_000)}`);
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(LARGO_MENSAJE);
  });

  it("corta por un espacio y no por la mitad de una palabra", () => {
    const partes = trozos(`${"ab ".repeat(2_000)}`);
    expect(partes[0]!.endsWith("ab")).toBe(true);
  });

  it("si no cabe ni en los trozos permitidos, lo DICE", () => {
    // Una respuesta cortada que no avisa de que está cortada se lee como
    // completa, y eso es peor que un mensaje de más.
    const partes = trozos("x".repeat(LARGO_MENSAJE * (MAX_TROZOS + 2)));
    expect(partes.length).toBe(MAX_TROZOS + 1);
    expect(partes.at(-1)).toContain("por partes");
  });
});
