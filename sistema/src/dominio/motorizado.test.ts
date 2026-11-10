import { describe, expect, it } from "vitest";
import {
  type CandadoPin,
  ESTADOS_MOTORIZADO,
  FALLOS_PARA_BLOQUEAR,
  MINUTOS_DE_BLOQUEO,
  VEHICULOS,
  esEstadoMotorizado,
  esVehiculo,
  estadoDelCandado,
  mensajeDelCandado,
  puedeEntrar,
  puedeRecibirEntregas,
  trasAcertarElPin,
  trasFallarElPin,
} from "./motorizado";

describe("estados del motorizado", () => {
  it("quien está en pausa no recibe entregas nuevas pero sí entra a cerrar las suyas", () => {
    // Pausar a alguien a media tarde no puede dejarle tres paquetes sin poder
    // marcar.
    expect(puedeRecibirEntregas("pausa")).toBe(false);
    expect(puedeEntrar("pausa")).toBe(true);
  });

  it("quien está inactivo no entra", () => {
    expect(puedeRecibirEntregas("inactivo")).toBe(false);
    expect(puedeEntrar("inactivo")).toBe(false);
  });

  it("quien está activo hace las dos cosas", () => {
    expect(puedeRecibirEntregas("activo")).toBe(true);
    expect(puedeEntrar("activo")).toBe(true);
  });

  it("son los tres del CHECK de motorizados", () => {
    expect([...ESTADOS_MOTORIZADO]).toEqual(["activo", "pausa", "inactivo"]);
    for (const e of ESTADOS_MOTORIZADO) expect(esEstadoMotorizado(e)).toBe(true);
    expect(esEstadoMotorizado("de vacaciones")).toBe(false);
  });

  it("los vehículos son los cuatro del CHECK", () => {
    expect([...VEHICULOS]).toEqual(["moto", "auto", "bicicleta", "a_pie"]);
    expect(esVehiculo("a pie")).toBe(false); // en la base es a_pie
  });
});

describe("el candado del PIN", () => {
  // Las cifras son las de docs/plan/07-seguridad.md: 5 fallos, 15 minutos.
  const T = 1_700_000_000_000;
  const limpio: CandadoPin = { pin_fallos: 0, bloqueado_hasta: null };

  it("usa las cifras del plan, no unas inventadas", () => {
    expect(FALLOS_PARA_BLOQUEAR).toBe(5);
    expect(MINUTOS_DE_BLOQUEO).toBe(15);
  });

  it("de entrada no está bloqueado y tiene cinco intentos", () => {
    const e = estadoDelCandado(limpio, T);
    expect(e.bloqueado).toBe(false);
    expect(e.intentos_restantes).toBe(5);
  });

  it("bloquea justo al quinto fallo", () => {
    let c = limpio;
    for (let i = 1; i <= 4; i += 1) {
      c = trasFallarElPin(c, T);
      expect(estadoDelCandado(c, T).bloqueado, `fallo ${i}`).toBe(false);
    }
    c = trasFallarElPin(c, T);
    expect(c.pin_fallos).toBe(5);
    expect(estadoDelCandado(c, T).bloqueado).toBe(true);
  });

  it("el bloqueo dura quince minutos y se suelta solo", () => {
    let c = limpio;
    for (let i = 0; i < 5; i += 1) c = trasFallarElPin(c, T);

    expect(estadoDelCandado(c, T + 14 * 60_000).bloqueado).toBe(true);
    expect(estadoDelCandado(c, T + 15 * 60_000).bloqueado).toBe(false);
    expect(estadoDelCandado(c, T + 16 * 60_000).bloqueado).toBe(false);
  });

  it("un bloqueo ya vencido no se arrastra: el contador empieza de nuevo", () => {
    let c = limpio;
    for (let i = 0; i < 5; i += 1) c = trasFallarElPin(c, T);

    // Vuelve 20 minutos después y falla otra vez: es su primer fallo nuevo, no
    // el sexto, así que no se bloquea de inmediato.
    const despues = T + 20 * 60_000;
    c = trasFallarElPin(c, despues);
    expect(c.pin_fallos).toBe(1);
    expect(estadoDelCandado(c, despues).bloqueado).toBe(false);
  });

  it("acertar deja el candado limpio", () => {
    expect(trasAcertarElPin()).toEqual({ pin_fallos: 0, bloqueado_hasta: null });
  });

  it("aguanta un contador corrupto en la base sin dejar entrar de más", () => {
    expect(estadoDelCandado({ pin_fallos: -3, bloqueado_hasta: null }, T).intentos_restantes).toBe(5);
    expect(estadoDelCandado({ pin_fallos: 99, bloqueado_hasta: null }, T).intentos_restantes).toBe(0);
    expect(estadoDelCandado({ pin_fallos: 0, bloqueado_hasta: Number.NaN }, T).bloqueado).toBe(false);
  });
});

describe("lo que se le dice a quien está en la calle", () => {
  const T = 1_700_000_000_000;

  it("avisa de los intentos que quedan cuando ya van pocos", () => {
    const c = { pin_fallos: 4, bloqueado_hasta: null };
    expect(mensajeDelCandado(estadoDelCandado(c, T))).toBe("PIN incorrecto. Le quedan 1 intentos.");
  });

  it("no alarma en el primer fallo", () => {
    const c = { pin_fallos: 1, bloqueado_hasta: null };
    expect(mensajeDelCandado(estadoDelCandado(c, T))).toBe("PIN incorrecto.");
  });

  it("dice cuántos minutos faltan, redondeando hacia arriba", () => {
    const c = { pin_fallos: 5, bloqueado_hasta: T + 90_000 };
    expect(mensajeDelCandado(estadoDelCandado(c, T))).toBe(
      "Demasiados intentos. Vuelva a probar en 2 minutos.",
    );
  });

  it("nunca dice «en 0 minutos»", () => {
    const c = { pin_fallos: 5, bloqueado_hasta: T + 1_000 };
    expect(mensajeDelCandado(estadoDelCandado(c, T))).toContain("1 minuto.");
  });

  it("habla de usted", () => {
    const mensajes = [
      mensajeDelCandado(estadoDelCandado({ pin_fallos: 4, bloqueado_hasta: null }, T)),
      mensajeDelCandado(estadoDelCandado({ pin_fallos: 5, bloqueado_hasta: T + 60_000 }, T)),
    ];
    for (const m of mensajes) expect(m).not.toMatch(/\b(tu|tus|tienes|puedes|vuelve)\b/i);
  });
});
