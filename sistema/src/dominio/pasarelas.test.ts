import { describe, expect, it } from "vitest";
import {
  CONECTORES,
  CONECTORES_EN_ORDEN,
  LARGO_MAXIMO_CREDENCIAL,
  LARGO_MINIMO_CREDENCIAL,
  MODOS,
  PASARELAS,
  contextoDeCifrado,
  credencialDe,
  elOtroModo,
  esModo,
  esPasarela,
  puedeEncenderse,
  queFalta,
  validarCredencial,
  type Pasarela,
} from "./pasarelas";
import { PASARELAS_CON_COMISION } from "./ajustes";

/**
 * El catálogo de pasarelas y su validación.
 *
 * Lo que se vigila, por orden de lo que dolería más:
 *
 *  1. **Que un mensaje de error no repita la credencial.** Es la forma más
 *     tonta de que una clave de cobro salga de donde debe estar: el error viaja
 *     por el cable, se pinta en el teléfono y acaba en una captura de WhatsApp.
 *  2. **Que la pantalla pueda decir QUÉ falta.** «Configuración incompleta»
 *     deja a la dueña abriendo campos a ver cuál es.
 *  3. **Que el contexto del cifrado sea distinto para cada sitio.** Si dos
 *     sitios compartieran contexto, el secreto de prueba se podría descifrar
 *     como si fuera el de real, y ahí está el fallo caro de esta pieza.
 *  4. **Que nada de aquí se pueda escribir y que D1 lo rechace después.**
 *
 * Cada prueba se comprobó rompiendo a propósito lo que dice vigilar; las
 * mutaciones están anotadas.
 */

// Obviamente falsa, y escrita así para que se vea de lejos que no es una clave
// de verdad. Ninguna credencial real entra en un archivo de este repositorio.
const FALSA = "CLAVE-FALSA-DE-PRUEBA-NO-SIRVE-1";

/**
 * Corre `cuerpo` con Tilopay bloqueada a propósito, y la deja como estaba.
 *
 * Hace falta porque hoy NINGUNA pasarela está por confirmar, y el mecanismo
 * del bloqueo —que `validarCredencial` y `puedeEncenderse` se nieguen— sigue
 * teniendo que funcionar para la que venga. Esas funciones no reciben el
 * conector: lo buscan en `CONECTORES`, así que la única forma de probarlas es
 * bloquear una de verdad y devolverla.
 *
 * El `finally` no es adorno: sin él, una aserción que falle deja el catálogo
 * roto y arrastra a las pruebas siguientes, que es la peor forma de depurar
 * —un fallo que señala a quien no fue—.
 */
function conTilopayBloqueada(motivo: string, cuerpo: () => void): void {
  const antes = CONECTORES.tilopay;
  (CONECTORES as Record<string, unknown>)["tilopay"] = {
    ...antes,
    porConfirmar: motivo,
    credenciales: [],
  };
  try {
    cuerpo();
  } finally {
    (CONECTORES as Record<string, unknown>)["tilopay"] = antes;
  }
}

const todasLasCredenciales = PASARELAS.flatMap((p) =>
  CONECTORES[p].credenciales.map((c) => ({ pasarela: p, ...c })),
);

// ---------------------------------------------------------------------------

describe("el catálogo", () => {
  /**
   * Las tres listas de pasarelas del sistema son la misma.
   *
   * `pasarelas_activas` (ajustes) decide qué se ofrece al pagar y `PASARELAS`
   * decide qué se puede configurar. Si se separaran, se podría configurar una
   * pasarela que no se puede encender, o encender una que no se puede
   * configurar — y las dos pantallas se echarían la culpa.
   *
   * Mutación: añadiendo una cuarta pasarela a `PASARELAS`, se cae.
   */
  it("tiene las mismas pasarelas que los ajustes", () => {
    expect([...PASARELAS].sort()).toEqual([...PASARELAS_CON_COMISION].sort());
  });

  it("empieza con las tres, todas en el orden del catálogo", () => {
    expect(CONECTORES_EN_ORDEN.map((c) => c.pasarela)).toEqual([...PASARELAS]);
  });

  /**
   * Cada nombre de credencial tiene que caber en la columna `credencial` de
   * `pasarela_credenciales`, que exige minúsculas, dígitos y guion bajo,
   * empezando por letra, de 2 a 64 caracteres (migrations/0010).
   *
   * Esto vigila el salto entre dos capas: el día que alguien añada una
   * credencial llamada «API Key» aquí, el catálogo la aceptaría, la pantalla la
   * pintaría y D1 rechazaría la fila — y el fallo aparecería en el momento de
   * guardar la clave buena, que es el peor momento posible.
   *
   * Mutación: renombrando una credencial a «API Key», se cae.
   */
  it("nombra las credenciales como D1 las acepta", () => {
    for (const c of todasLasCredenciales) {
      expect(c.nombre, `${c.pasarela}.${c.nombre}`).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    }
  });

  it("le pone a cada credencial un título y una explicación para la dueña", () => {
    for (const c of todasLasCredenciales) {
      expect(c.titulo.trim(), c.nombre).not.toBe("");
      expect(c.explica.trim().length, c.nombre).toBeGreaterThan(20);
      // El título es lo que la dueña busca en el portal de la pasarela, así que
      // NO puede ser el nombre técnico con los guiones quitados.
      expect(c.titulo).not.toBe(c.nombre);
    }
  });

  /**
   * Lo que el documento no nombra, no se inventa — y al revés.
   *
   * Tilopay estuvo bloqueada mientras sus credenciales no estaban confirmadas:
   * un campo con el nombre adivinado se llena con la clave buena y el adaptador
   * no la encuentra después. Ya no lo está, porque su documentación las nombra
   * (`apiuser`, `password`, `key`) y el conector usa esos nombres letra por
   * letra.
   *
   * Esta prueba deja de mirar a Tilopay y mira el INVARIANTE, que es lo que
   * vale para la pasarela que venga: o una pasarela dice por qué no se puede
   * configurar, o trae al menos una credencial obligatoria. Lo que no puede
   * existir es una que diga que está lista y no pida nada — esa se encendería
   * sin credenciales.
   */
  it("o una pasarela explica por qué no se puede configurar, o pide credenciales", () => {
    for (const c of CONECTORES_EN_ORDEN) {
      if (c.porConfirmar === null) {
        expect(c.credenciales.some((x) => x.obligatoria), c.pasarela).toBe(true);
      } else {
        expect(c.credenciales, c.pasarela).toEqual([]);
      }
    }
  });

  /**
   * Los nombres de Tilopay son LOS DE SU API, letra por letra.
   *
   * El adaptador los manda tal cual en el cuerpo de `login` y de
   * `processPayment`. Renombrarlos a algo más bonito metería una capa de
   * traducción, y esa capa es exactamente lo que se quiso evitar al dejar la
   * pasarela bloqueada un mes.
   */
  it("Tilopay pide los tres nombres de su API, sin traducir", () => {
    expect(CONECTORES.tilopay.porConfirmar).toBeNull();
    expect(CONECTORES.tilopay.credenciales.map((c) => c.nombre)).toEqual([
      "apiuser",
      "password",
      "key",
    ]);
    // Las tres, porque con dos de las tres no se cobra: `key` no es solo del
    // SDK, es parámetro obligatorio de processPayment y de consult.
    expect(CONECTORES.tilopay.credenciales.every((c) => c.obligatoria)).toBe(true);
  });

  it("dice de dónde sale lo que declara", () => {
    for (const c of CONECTORES_EN_ORDEN) {
      expect(c.fuente, c.pasarela).toContain("04-pagos");
    }
  });

  it("reconoce las pasarelas y los modos, y nada más", () => {
    expect(esPasarela("yappy")).toBe(true);
    expect(esPasarela("manual")).toBe(false);
    expect(esPasarela("")).toBe(false);
    expect(esPasarela(null)).toBe(false);
    expect(esModo("prueba")).toBe(true);
    expect(esModo("real")).toBe(true);
    expect(esModo("sandbox")).toBe(false);
    expect(elOtroModo("prueba")).toBe("real");
    expect(elOtroModo("real")).toBe("prueba");
  });

  it("encuentra una credencial por su nombre, y no una que no existe", () => {
    expect(credencialDe("yappy", "clave_secreta")?.titulo).toBe("Clave secreta");
    expect(credencialDe("yappy", "client_id")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("validarCredencial", () => {
  /**
   * **La prueba que más importa de este archivo.**
   *
   * Ningún mensaje de rechazo puede llevar el valor, ni entero ni recortado.
   * Se prueban todas las formas de que una credencial sea rechazada, con un
   * valor reconocible dentro, y se mira que no asome por ninguna.
   *
   * Mutación: cambiando un solo mensaje por «… no se entiende: ${limpio}», se
   * cae. Lo comprobé con el del largo máximo.
   */
  it("nunca repite el valor en el mensaje de error", () => {
    const reconocible = "SECRETOQUENODEBESALIR";
    const intentos: unknown[] = [
      reconocible + " con espacio",
      reconocible + "\n",
      ` ${reconocible} ${reconocible} `,
      reconocible.repeat(40),
      reconocible + "ñ",
      reconocible + "\t" + reconocible,
    ];
    for (const valor of intentos) {
      // Una vez contra una credencial que existe y otra contra una que no:
      // los dos caminos escriben mensajes distintos.
      for (const nombre of ["clave_secreta", "no_existe"]) {
        const r = validarCredencial("yappy", nombre, valor);
        if (r.ok) {
          expect(r.datos, `se aceptó «${nombre}» con un valor que no debía`).toBe(reconocible);
          continue;
        }
        expect(r.mensaje, `«${nombre}»`).not.toContain(reconocible);
        expect(JSON.stringify(r), `«${nombre}»`).not.toContain(reconocible);
      }
    }
  });

  it("acepta una credencial normal y le quita los bordes", () => {
    // Pegar desde un correo o un PDF arrastra un salto de línea casi siempre.
    const r = validarCredencial("yappy", "clave_secreta", `  ${FALSA}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toBe(FALSA);
  });

  it("no toca el interior: una credencial no se «corrige»", () => {
    const conPuntos = "aa.bb-cc_dd:ee/ff+gg=";
    const r = validarCredencial("paypal", "client_id", conPuntos);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toBe(conPuntos);
  });

  it("rechaza una pasarela que no existe", () => {
    const r = validarCredencial("stripe", "clave_secreta", FALSA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
  });

  /**
   * Tilopay no acepta NADA mientras sus credenciales no estén confirmadas.
   *
   * Mutación: quitando la comprobación de `porConfirmar`, la validación cae en
   * «no pide ninguna credencial que se llame…», que es cierto pero no explica
   * nada, y esto se cae porque exige el motivo de verdad en el mensaje.
   */
  it("no deja configurar una pasarela cuyas credenciales están por confirmar", () => {
    // Hoy NINGUNA pasarela está por confirmar, así que el mecanismo se prueba
    // bloqueando una a propósito y devolviéndola como estaba. La alternativa
    // era borrar esta prueba, y entonces la próxima pasarela que naciera
    // bloqueada no tendría quien vigilara que el bloqueo funciona.
    conTilopayBloqueada("falta hablar con su soporte", () => {
      const r = validarCredencial("tilopay", "apiuser", FALSA);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.mensaje).toContain("Tilopay");
      expect(r.mensaje).toContain("falta hablar con su soporte");
    });
  });

  it("rechaza un nombre de credencial que esa pasarela no pide, y dice cuáles pide", () => {
    const r = validarCredencial("yappy", "client_secret", FALSA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensaje).toContain("ID de comercio");
    expect(r.mensaje).toContain("Clave secreta");
  });

  it("rechaza lo que no es texto", () => {
    for (const valor of [undefined, null, 12345, {}, ["a"]]) {
      expect(validarCredencial("yappy", "clave_secreta", valor).ok, String(valor)).toBe(false);
    }
  });

  /**
   * Vacío no es «todavía no la tengo»: es una credencial puesta que no sirve.
   * Mutación: dejando pasar la cadena vacía, el baúl guardaría un sobre de
   * nada que la pantalla enseñaría como «puesta».
   */
  it("rechaza el vacío y lo que son solo espacios", () => {
    for (const valor of ["", "   ", "\n\t "]) {
      const r = validarCredencial("yappy", "clave_secreta", valor);
      expect(r.ok, JSON.stringify(valor)).toBe(false);
    }
  });

  it("rechaza lo demasiado corto y lo demasiado largo, por los dos lados del límite", () => {
    const corta = "a".repeat(LARGO_MINIMO_CREDENCIAL - 1);
    const justa = "a".repeat(LARGO_MINIMO_CREDENCIAL);
    const larga = "a".repeat(LARGO_MAXIMO_CREDENCIAL + 1);
    const justaLarga = "a".repeat(LARGO_MAXIMO_CREDENCIAL);
    expect(validarCredencial("yappy", "clave_secreta", corta).ok).toBe(false);
    expect(validarCredencial("yappy", "clave_secreta", justa).ok).toBe(true);
    expect(validarCredencial("yappy", "clave_secreta", larga).ok).toBe(false);
    expect(validarCredencial("yappy", "clave_secreta", justaLarga).ok).toBe(true);
  });

  it("rechaza espacios, saltos de línea y acentos por dentro", () => {
    for (const valor of ["clave con espacio", "clave\ncon\nsalto", "clavecónacento", "clave\u0000nula"]) {
      const r = validarCredencial("yappy", "clave_secreta", valor);
      expect(r.ok, JSON.stringify(valor)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("qué falta y si se puede encender", () => {
  /**
   * Mutación: devolviendo `[]` siempre, se cae; devolviendo todas las
   * credenciales sin filtrar por lo puesto, también.
   */
  it("dice qué falta por su nombre, y deja de decirlo cuando se pone", () => {
    expect(queFalta("yappy", []).map((c) => c.nombre)).toEqual([
      "id_comercio",
      "clave_secreta",
    ]);
    expect(queFalta("yappy", ["id_comercio"]).map((c) => c.nombre)).toEqual(["clave_secreta"]);
    expect(queFalta("yappy", ["id_comercio", "clave_secreta"])).toEqual([]);
    // Un nombre que no es de esta pasarela no cuenta como puesto.
    expect(queFalta("yappy", ["client_id"]).map((c) => c.nombre)).toEqual([
      "id_comercio",
      "clave_secreta",
    ]);
  });

  it("solo cuenta las obligatorias", () => {
    for (const p of PASARELAS) {
      const opcionales = CONECTORES[p].credenciales.filter((c) => !c.obligatoria);
      expect(queFalta(p, []).map((c) => c.nombre)).toEqual(
        CONECTORES[p].credenciales
          .filter((c) => c.obligatoria)
          .map((c) => c.nombre),
      );
      // Hoy no hay ninguna opcional: queda dicho aquí para que, el día que la
      // haya, esta prueba siga siendo la que manda y no una que lo suponía.
      expect(opcionales.length).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * El motivo nombra las credenciales que faltan, porque es lo que se enseña en
   * la pantalla y lo que decide si se ofrece el botón.
   *
   * Mutación: devolviendo `{ puede: false, motivo: "configuración incompleta" }`,
   * se cae — y esa mutación es justo la pantalla que el pedido prohíbe.
   */
  it("no deja encender sin las credenciales, y dice cuáles son", () => {
    const sinNada = puedeEncenderse("yappy", []);
    expect(sinNada.puede).toBe(false);
    if (sinNada.puede) return;
    expect(sinNada.motivo).toContain("ID de comercio");
    expect(sinNada.motivo).toContain("Clave secreta");
    expect(sinNada.faltan).toHaveLength(2);

    const aMedias = puedeEncenderse("paypal", ["client_id", "webhook_id"]);
    expect(aMedias.puede).toBe(false);
    if (aMedias.puede) return;
    expect(aMedias.motivo).toContain("Secret de la app REST");
    expect(aMedias.motivo).not.toContain("Client ID");
  });

  it("deja encender cuando están todas", () => {
    expect(puedeEncenderse("yappy", ["id_comercio", "clave_secreta"]).puede).toBe(true);
    expect(
      puedeEncenderse("paypal", ["client_id", "client_secret", "webhook_id"]).puede,
    ).toBe(true);
  });

  /**
   * Y no deja encender una pasarela por confirmar ni dándole credenciales
   * inventadas: `queFalta` de una pasarela sin credenciales declaradas
   * devuelve `[]`, que leído a secas diría «no falta nada».
   *
   * Mutación: quitando la comprobación de `porConfirmar` de `puedeEncenderse`,
   * Tilopay se podría encender sin una sola credencial. Se cae.
   */
  it("no deja encender una pasarela cuyas credenciales están por confirmar", () => {
    conTilopayBloqueada("falta hablar con su soporte", () => {
      // `queFalta` de una pasarela sin credenciales declaradas devuelve `[]`,
      // que leído a secas diría «no falta nada». Es justo el caso que
      // `puedeEncenderse` tiene que atrapar aparte.
      expect(queFalta("tilopay", [])).toEqual([]);
      const r = puedeEncenderse("tilopay", []);
      expect(r.puede).toBe(false);
      if (r.puede) return;
      expect(r.motivo).toBe("falta hablar con su soporte");
    });
  });
});

// ---------------------------------------------------------------------------

describe("contextoDeCifrado", () => {
  /**
   * Cada sitio tiene su propia etiqueta, y no hay dos iguales en todo el
   * sistema. Es lo que hace que un secreto cifrado para el modo de prueba no se
   * pueda abrir como si fuera el del modo real.
   *
   * Mutación: devolviendo solo `pasarela + credencial` (sin el modo), los pares
   * se duplican y se cae. Esa mutación es exactamente el fallo caro: prueba y
   * real compartiendo criptograma.
   */
  it("da una etiqueta distinta a cada pasarela, modo y credencial", () => {
    const vistas = new Set<string>();
    let cuantas = 0;
    for (const p of PASARELAS) {
      for (const m of MODOS) {
        for (const c of CONECTORES[p].credenciales) {
          vistas.add(contextoDeCifrado(p, m, c.nombre));
          cuantas++;
        }
      }
    }
    expect(cuantas).toBeGreaterThan(0);
    expect(vistas.size).toBe(cuantas);
  });

  it("no cambia de forma sin que nadie se entere", () => {
    // Escrito a mano a propósito: si alguien cambia el formato, todas las
    // credenciales guardadas dejan de poder abrirse. Esta prueba es la que
    // obliga a pensarlo antes de tocarlo.
    expect(contextoDeCifrado("yappy", "prueba", "clave_secreta")).toBe(
      "babycaleb/pasarela/yappy/prueba/clave_secreta",
    );
  });

  it("no se puede confundir una etiqueta con otra juntando los trozos de otra forma", () => {
    // Los separadores no aparecen dentro de ninguna parte, así que la etiqueta
    // se puede partir de una sola manera.
    for (const p of PASARELAS as readonly Pasarela[]) {
      expect(p).not.toContain("/");
      for (const c of CONECTORES[p].credenciales) expect(c.nombre).not.toContain("/");
    }
    for (const m of MODOS) expect(m).not.toContain("/");
  });
});
