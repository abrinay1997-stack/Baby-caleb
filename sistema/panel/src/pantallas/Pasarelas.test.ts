import { describe, expect, it } from "vitest";
import {
  comoSeLeeLaLinea,
  firmaDe,
  peticionDeAccion,
  tituloDeAccion,
  tituloDeCredencial,
  type Accion,
  type EstadoDePasarela,
  type LineaDelLibro,
} from "./Pasarelas";
import { CONECTORES, PASARELAS, type Modo } from "../../../src/dominio/pasarelas";

/**
 * Las partes de la pantalla de pasarelas que deciden algo.
 *
 * Son tres, y las tres se pueden probar sin pintar nada:
 *
 *  1. **A qué ruta se manda cada acción.** Un error aquí manda la credencial
 *     de prueba a la ruta del modo real, o la manda a la pasarela de al lado.
 *  2. **La firma de la acción**, que es lo que decide cuándo se limpia el campo
 *     del secreto. Con una firma poco precisa, lo que se escribió para una
 *     credencial se queda en el campo de la siguiente.
 *  3. **Cómo se lee el libro**, que es texto para una persona y no puede llevar
 *     ningún valor.
 */

const unaPasarela = (sobre: Partial<EstadoDePasarela> = {}): EstadoDePasarela => ({
  pasarela: "yappy",
  titulo: CONECTORES.yappy.titulo,
  explica: CONECTORES.yappy.explica,
  por_confirmar: null,
  fuente: CONECTORES.yappy.fuente,
  modo: "prueba",
  modo_cambiado_por: null,
  modo_cambiado_en: null,
  encendida: false,
  modos: [],
  puede_encenderse: false,
  por_que_no: "falta algo",
  incoherente: false,
  ...sobre,
});

const credencial = CONECTORES.yappy.credenciales[0]!;
const otra = CONECTORES.yappy.credenciales[1]!;

// ---------------------------------------------------------------------------

describe("peticionDeAccion", () => {
  /**
   * El modo viaja en el cuerpo y NO en el camino, pero viaja siempre: sin él,
   * el servidor no sabría en cuál de los dos juegos guardar la credencial.
   *
   * Mutación: quitando `modo` del cuerpo, o fijándolo a `"prueba"`, se cae — y
   * con ella se guardaría la clave de producción en el juego de prueba, que es
   * el fallo que cuesta dinero.
   */
  it("manda la credencial a su pasarela, su campo y su modo", () => {
    for (const modo of ["prueba", "real"] as Modo[]) {
      const p = peticionDeAccion(
        { tipo: "poner", pasarela: unaPasarela(), modo, credencial },
        "VALOR-FALSO-DE-PRUEBA-0001",
        "porque sí",
      );
      expect(p.ruta).toBe(`/api/pasarelas/yappy/credenciales/${credencial.nombre}`);
      expect(p.cuerpo).toEqual({
        modo,
        valor: "VALOR-FALSO-DE-PRUEBA-0001",
        motivo: "porque sí",
      });
    }
  });

  it("manda cada pasarela a su propio camino", () => {
    for (const pasarela of PASARELAS) {
      const p = peticionDeAccion(
        { tipo: "encender", pasarela: unaPasarela({ pasarela }) },
        "",
        "x",
      );
      expect(p.ruta).toBe(`/api/pasarelas/${pasarela}/encendida`);
    }
  });

  /**
   * Encender y apagar van a la misma ruta con un cuerpo distinto, y el cuerpo
   * tiene que decir cuál de las dos: un `encendida` que no viaja convertiría
   * «apagar» en «encender».
   *
   * Mutación: devolviendo `{ encendida: true }` en las dos, se cae.
   */
  it("distingue encender de apagar en el cuerpo", () => {
    const p = unaPasarela();
    expect(peticionDeAccion({ tipo: "encender", pasarela: p }, "", "ya probé").cuerpo).toEqual({
      encendida: true,
      motivo: "ya probé",
    });
    expect(peticionDeAccion({ tipo: "apagar", pasarela: p }, "", "algo va mal").cuerpo).toEqual({
      encendida: false,
      motivo: "algo va mal",
    });
  });

  it("manda el modo nuevo al cambiar de modo, y nada del valor", () => {
    const p = peticionDeAccion(
      { tipo: "modo", pasarela: unaPasarela(), a: "real" },
      "ESTO-NO-DEBE-VIAJAR",
      "a producción",
    );
    expect(p.ruta).toBe("/api/pasarelas/yappy/modo");
    expect(p.cuerpo).toEqual({ modo: "real", motivo: "a producción" });
    expect(JSON.stringify(p)).not.toContain("ESTO-NO-DEBE-VIAJAR");
  });

  /**
   * Quitar no manda el valor. Mutación: pasando `valor` también en el cuerpo de
   * «quitar» —copiar y pegar la rama de arriba— se cae.
   */
  it("al quitar no viaja ningún valor", () => {
    const p = peticionDeAccion(
      { tipo: "quitar", pasarela: unaPasarela(), modo: "real", credencial },
      "ESTO-NO-DEBE-VIAJAR",
      "la revocaron",
    );
    expect(p.ruta).toBe(`/api/pasarelas/yappy/credenciales/${credencial.nombre}/quitar`);
    expect(p.cuerpo).toEqual({ modo: "real", motivo: "la revocaron" });
    expect(JSON.stringify(p)).not.toContain("ESTO-NO-DEBE-VIAJAR");
  });
});

// ---------------------------------------------------------------------------

describe("firmaDe", () => {
  /**
   * **La prueba de seguridad de este archivo.**
   *
   * La hoja limpia sus campos cuando la firma cambia. Si dos acciones distintas
   * compartieran firma, lo que se escribió para una se quedaría en el campo de
   * la otra — y lo que se escribe en ese campo es una clave de cobro. Abrir «ID
   * de comercio», escribir, cancelar y abrir «Clave secreta» guardaría el ID en
   * el sitio de la clave.
   *
   * Mutación: devolviendo solo `a.tipo`, o quitando el modo de la firma, se
   * cae. Lo comprobé con las dos.
   */
  it("da una firma distinta a cada acción posible", () => {
    const acciones: Accion[] = [];
    for (const pasarela of PASARELAS) {
      const p = unaPasarela({ pasarela });
      acciones.push({ tipo: "encender", pasarela: p }, { tipo: "apagar", pasarela: p });
      for (const modo of ["prueba", "real"] as Modo[]) {
        acciones.push({ tipo: "modo", pasarela: p, a: modo });
        for (const c of CONECTORES[pasarela].credenciales) {
          acciones.push(
            { tipo: "poner", pasarela: p, modo, credencial: c },
            { tipo: "quitar", pasarela: p, modo, credencial: c },
          );
        }
      }
    }
    const firmas = new Set(acciones.map(firmaDe));
    expect(acciones.length).toBeGreaterThan(10);
    expect(firmas.size).toBe(acciones.length);
  });

  it("y la misma acción da siempre la misma firma", () => {
    const a: Accion = { tipo: "poner", pasarela: unaPasarela(), modo: "real", credencial };
    expect(firmaDe(a)).toBe(firmaDe({ ...a }));
    expect(firmaDe(a)).not.toBe(firmaDe({ ...a, credencial: otra }));
    expect(firmaDe(a)).not.toBe(firmaDe({ ...a, modo: "prueba" }));
  });
});

// ---------------------------------------------------------------------------

describe("lo que se lee", () => {
  it("el título de la hoja dice qué se va a hacer y sobre qué", () => {
    const p = unaPasarela();
    expect(tituloDeAccion({ tipo: "poner", pasarela: p, modo: "real", credencial })).toContain(
      credencial.titulo,
    );
    expect(tituloDeAccion({ tipo: "apagar", pasarela: p })).toContain(p.titulo);
    expect(tituloDeAccion({ tipo: "modo", pasarela: p, a: "real" })).toContain("real");
  });

  it("usa el título del catálogo y no el nombre técnico", () => {
    expect(tituloDeCredencial("yappy", "clave_secreta")).toBe("Clave secreta");
    // Y si algún día llega un nombre que el catálogo no conoce —una línea
    // vieja del libro de una credencial que se renombró— se enseña tal cual en
    // vez de desaparecer.
    expect(tituloDeCredencial("yappy", "api_key_vieja")).toBe("api_key_vieja");
  });

  /**
   * Una línea del libro se lee como una frase y no lleva ningún valor. Lo
   * segundo lo garantiza la tabla —no tiene columna donde cupiera— y esto lo
   * comprueba por el lado de la pantalla.
   */
  it("escribe cada línea del libro como una frase, con el modo dentro", () => {
    const base: LineaDelLibro = {
      id: "l1",
      pasarela: "yappy",
      accion: "credencial_puesta",
      modo: "real",
      credencial: "clave_secreta",
      version: 1,
      actor: "yarielis@babycaleb.com",
      motivo: "me llegaron",
      creado_en: 1_800_000_000_000,
    };
    expect(comoSeLeeLaLinea(base)).toContain("Clave secreta");
    expect(comoSeLeeLaLinea(base)).toContain("Se puso");
    // El modo va en la frase: «se cambió la clave» sin decir de qué juego no
    // contesta lo que se va a preguntar.
    expect(comoSeLeeLaLinea(base).toLowerCase()).toContain("real");
    expect(comoSeLeeLaLinea({ ...base, modo: "prueba" }).toLowerCase()).toContain("prueba");

    expect(comoSeLeeLaLinea({ ...base, accion: "credencial_cambiada" })).toContain("Se cambió");
    expect(comoSeLeeLaLinea({ ...base, accion: "credencial_quitada" })).toContain("Se quitó");
    const deModo = comoSeLeeLaLinea({
      ...base,
      accion: "modo_cambiado",
      credencial: null,
      version: null,
    });
    expect(deModo).toContain(CONECTORES.yappy.titulo);
    expect(deModo).not.toContain("Clave secreta");
  });
});
