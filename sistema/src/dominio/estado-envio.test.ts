import { describe, expect, it } from "vitest";
import {
  ESTADOS_CON_LA_GUIA,
  ESTADOS_DEL_MOTORIZADO,
  ESTADOS_ENVIO,
  ETIQUETAS_ENVIO,
  type EstadoEnvio,
  esEstadoDelMotorizado,
  esEstadoEnvio,
  esTerminalEnvio,
  estaEnLaCalle,
  puedeCambiarEnvio,
  validarTransicionEnvio,
} from "./estado-envio";

describe("puedeCambiarEnvio", () => {
  it("deja recorrer el camino normal de principio a fin", () => {
    const camino: EstadoEnvio[] = ["pendiente", "asignado", "recogido", "en_ruta", "entregado"];
    for (let i = 0; i < camino.length - 1; i += 1) {
      expect(puedeCambiarEnvio(camino[i]!, camino[i + 1]!)).toBe(true);
    }
  });

  it("no deja retroceder desde entregado", () => {
    // El caso que motiva toda la máquina: quien marca estos estados va en la
    // calle, con una mano en el manillar. Los toques accidentales existen, y un
    // envío que vuelve de «entregado» deja a la clienta mirando una mentira.
    for (const destino of ESTADOS_ENVIO) {
      if (destino === "entregado") continue;
      expect(puedeCambiarEnvio("entregado", destino), destino).toBe(false);
    }
  });

  it("no deja saltarse pasos", () => {
    expect(puedeCambiarEnvio("pendiente", "en_ruta")).toBe(false);
    expect(puedeCambiarEnvio("pendiente", "entregado")).toBe(false);
    expect(puedeCambiarEnvio("asignado", "entregado")).toBe(false);
  });

  it("acepta quedarse donde está", () => {
    for (const estado of ESTADOS_ENVIO) expect(puedeCambiarEnvio(estado, estado)).toBe(true);
  });

  it("deja desasignar un envío que todavía no salió", () => {
    expect(puedeCambiarEnvio("asignado", "pendiente")).toBe(true);
  });

  it("un intento fallido se reintenta o se devuelve, pero no se da por entregado", () => {
    // Si al final se entregó, hubo un segundo intento y ese intento tiene que
    // constar: vuelve a la cola y recorre el camino otra vez. Es lo que permite
    // contar cuántas entregas se intentaron dos veces, que es justo el número
    // que dice si el dato de la dirección sirve.
    expect(puedeCambiarEnvio("fallido", "pendiente")).toBe(true);
    expect(puedeCambiarEnvio("fallido", "devuelto")).toBe(true);
    expect(puedeCambiarEnvio("fallido", "entregado")).toBe(false);
  });

  it("desde cualquier estado vivo se puede fallar", () => {
    for (const estado of ["pendiente", "asignado", "recogido", "en_ruta"] as const) {
      expect(puedeCambiarEnvio(estado, "fallido")).toBe(true);
    }
  });

  it("anular solo se puede antes de que el envío sea algo", () => {
    // Desde «asignado» ya hay una persona con una tarea, y desde «recogido» hay
    // un paquete en la calle: eso es «fallido» o «devuelto», no «anulado».
    expect(puedeCambiarEnvio("pendiente", "anulado")).toBe(true);
    for (const estado of ["asignado", "recogido", "en_ruta", "fallido"] as const) {
      expect(puedeCambiarEnvio(estado, "anulado"), estado).toBe(false);
    }
  });
});

describe("esTerminalEnvio", () => {
  it("entregado, devuelto y anulado son el final del camino", () => {
    expect(esTerminalEnvio("entregado")).toBe(true);
    expect(esTerminalEnvio("devuelto")).toBe(true);
    // Un envío anulado no se resucita: si el pedido vuelve a despacharse es un
    // envío nuevo, con su guía y su token.
    expect(esTerminalEnvio("anulado")).toBe(true);
  });

  it("fallido no es terminal: todavía se puede reintentar", () => {
    expect(esTerminalEnvio("fallido")).toBe(false);
  });
});

describe("estaEnLaCalle", () => {
  it("reconoce los estados en los que el envío ya salió", () => {
    expect(estaEnLaCalle("recogido")).toBe(true);
    expect(estaEnLaCalle("en_ruta")).toBe(true);
  });

  it("no confunde los de bodega ni los terminales", () => {
    for (const estado of ["pendiente", "asignado", "entregado", "devuelto", "anulado"] as const) {
      expect(estaEnLaCalle(estado), estado).toBe(false);
    }
  });
});

describe("quién puede marcar qué", () => {
  it("con la guía en la mano, exactamente dos: entregado y fallido", () => {
    // El QR no pide sesión: quien recibe puede no ser quien lleva. Si esta
    // lista crece sin querer, cualquiera con el papel podría asignar envíos.
    expect([...ESTADOS_CON_LA_GUIA]).toEqual(["entregado", "fallido"]);
  });

  it("un motorizado identificado puede además recoger y ponerse en camino", () => {
    expect([...ESTADOS_DEL_MOTORIZADO]).toEqual(["recogido", "en_ruta", "entregado", "fallido"]);
  });

  it("ni asignar ni devolver: esas son de quien despacha", () => {
    for (const prohibido of ["asignado", "pendiente", "devuelto", "anulado"]) {
      expect(esEstadoDelMotorizado(prohibido), prohibido).toBe(false);
    }
  });

  it("los dos estados de la guía se alcanzan desde «va en camino», que es donde estará", () => {
    for (const estado of ESTADOS_CON_LA_GUIA) {
      expect(puedeCambiarEnvio("en_ruta", estado)).toBe(true);
    }
  });
});

describe("validarTransicionEnvio", () => {
  it("no se queja de un cambio válido", () => {
    expect(validarTransicionEnvio("en_ruta", "entregado")).toBeNull();
  });

  it("explica el cambio inválido con los nombres que se leen en pantalla", () => {
    // El mensaje lo lee una persona, así que nombra los estados como se ven y
    // no como se llaman en la base.
    const error = validarTransicionEnvio("entregado", "en_ruta");
    expect(error?.mensaje).toBe('Un envío «Entregado» no puede pasar a «Va en camino».');
  });
});

describe("coherencia con el esquema", () => {
  it("son los ocho estados del CHECK de envios", () => {
    expect([...ESTADOS_ENVIO]).toEqual([
      "pendiente", "asignado", "recogido", "en_ruta",
      "entregado", "fallido", "devuelto", "anulado",
    ]);
  });

  it("todo estado tiene etiqueta", () => {
    expect(Object.keys(ETIQUETAS_ENVIO).sort()).toEqual([...ESTADOS_ENVIO].sort());
  });

  it("esEstadoEnvio reconoce los ocho y rechaza el resto", () => {
    for (const e of ESTADOS_ENVIO) expect(esEstadoEnvio(e)).toBe(true);
    expect(esEstadoEnvio("en ruta")).toBe(false);
    expect(esEstadoEnvio("")).toBe(false);
  });
});
