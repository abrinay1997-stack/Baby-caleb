import { describe, expect, it } from "vitest";
import {
  comoCobra,
  comoSeLeeLaLinea,
  etiquetaDeEncendida,
  firmaDe,
  fraseDeCobro,
  peticionDeAccion,
  tituloDeAccion,
  tituloDeCredencial,
  tonoDeLaPastilla,
  type Accion,
  type EstadoDeModo,
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

/**
 * «Está cobrando» de una pasarela que no cobra nada.
 *
 * La tarjeta lo decía de CUALQUIER pasarela encendida, sin mirar el modo. Con
 * Yappy encendida en prueba eso afirma que le está cobrando a las clientas
 * cuando no les cobra nada — y la pantalla contradecía al dominio en lo único
 * que existe para contestar.
 *
 * Lo que se comprueba aquí es que el veredicto sale de `dominio/checkout.ts`
 * y dice el modo. Validada por mutación: volver a «Está cobrando.» para toda
 * encendida pone roja la segunda.
 */
describe("qué dice la tarjeta de una pasarela", () => {
  const completa = [
    { modo: "prueba" as Modo, esElActual: true, credenciales: [], faltan: [], completo: true },
    { modo: "real" as Modo, esElActual: false, credenciales: [], faltan: [], completo: true },
  ];

  it("en modo real y encendida: cobra dinero de verdad", () => {
    const p = unaPasarela({
      encendida: true,
      modo: "real",
      puede_encenderse: true,
      modos: completa.map((m) => ({ ...m, esElActual: m.modo === "real" })),
    });
    expect(comoCobra(p)).toBe("real");
    expect(fraseDeCobro(p)).toMatch(/de verdad/);
  });

  it("en modo de prueba y encendida: NO le cobra nada a nadie, y lo dice", () => {
    const p = unaPasarela({ encendida: true, modo: "prueba", puede_encenderse: true, modos: completa });
    expect(comoCobra(p)).toBe("prueba");
    const frase = fraseDeCobro(p);
    expect(frase).toMatch(/prueba/i);
    expect(frase).not.toMatch(/Está cobrando dinero de verdad/);
  });

  it("apagada: ni cobra ni dice que cobra", () => {
    const p = unaPasarela({ encendida: false, modo: "real", puede_encenderse: true, modos: completa });
    expect(comoCobra(p)).toBe("no");
    expect(fraseDeCobro(p)).toBe("Lista para encender.");
  });

  it("encendida con las credenciales incompletas tampoco cobra", () => {
    const p = unaPasarela({
      encendida: true,
      modo: "real",
      modos: completa.map((m) => ({ ...m, completo: false, faltan: ["Clave secreta"] })),
    });
    expect(comoCobra(p)).toBe("no");
  });
});

/**
 * Lo PRIMERO que se lee de una pasarela no puede desmentir a lo que hay tres
 * renglones más abajo.
 *
 * La pastilla decía «Encendida: se le ofrece a las clientas» para cualquiera
 * con el interruptor puesto, sin mirar si podía cobrar. En producción las tres
 * están encendidas y a las tres les faltan las credenciales, así que la
 * tarjeta afirmaba que se le ofrece a las clientas algo que no cobra nada —
 * y debajo, la misma tarjeta decía «está encendida y no puede cobrar».
 *
 * La frase de abajo se arregló en su día y la pastilla se quedó. Lo vio una
 * persona mirando el panel desplegado, no una prueba: por eso existe ésta.
 */
describe("la pastilla de encendida dice la verdad", () => {
  /** Un modo completo de verdad, con todos los campos que pide el tipo. */
  const unModo = (modo: "real" | "prueba", faltan: string[] = []): EstadoDeModo => ({
    modo,
    esElActual: true,
    credenciales: [],
    faltan,
    completo: faltan.length === 0,
  });

  const base = (opciones: Partial<EstadoDePasarela> = {}): EstadoDePasarela =>
    ({
      pasarela: "yappy",
      titulo: "Yappy",
      encendida: true,
      modo: "real",
      modos: [unModo("real")],
      ...opciones,
    }) as EstadoDePasarela;

  it("apagada lo dice, y sin adornos", () => {
    expect(etiquetaDeEncendida(base({ encendida: false }))).toBe("Apagada");
    expect(tonoDeLaPastilla(base({ encendida: false }))).toBe("neutro");
  });

  it("encendida y cobrando de verdad: verde y se lo dice a las clientas", () => {
    expect(etiquetaDeEncendida(base())).toContain("se le ofrece a las clientas");
    expect(tonoDeLaPastilla(base())).toBe("bien");
  });

  it("encendida y SIN credenciales: ni verde, ni «se le ofrece»", () => {
    // El estado de las tres pasarelas en producción hoy, y el que la pastilla
    // vieja pintaba de verde.
    const sinLlaves = base({ modos: [unModo("real", ["Client ID", "Secret"])] });
    const t = etiquetaDeEncendida(sinLlaves);
    expect(t).toContain("no puede cobrar");
    expect(t).not.toContain("se le ofrece a las clientas");
    expect(tonoDeLaPastilla(sinLlaves)).toBe("neutro");
  });

  it("encendida en PRUEBA: tampoco verde, y dice que no cobra", () => {
    const prueba = base({ modo: "prueba", modos: [unModo("prueba")] });
    expect(etiquetaDeEncendida(prueba)).toContain("no cobra");
    expect(tonoDeLaPastilla(prueba)).toBe("neutro");
  });

  it("y nunca dice lo contrario que la frase de abajo", () => {
    // La prueba que cierra la clase: las dos líneas salen de la MISMA
    // clasificación, así que no pueden separarse otra vez.
    for (const p of [
      base(),
      base({ modos: [unModo("real", ["x"])] }),
      base({ modo: "prueba", modos: [unModo("prueba")] }),
    ]) {
      const arriba = etiquetaDeEncendida(p);
      const abajo = fraseDeCobro(p);
      const arribaCobra = arriba.includes("se le ofrece a las clientas");
      const abajoCobra = abajo.includes("dinero de verdad");
      expect(arribaCobra, `arriba «${arriba}» y abajo «${abajo}»`).toBe(abajoCobra);
    }
  });
});
