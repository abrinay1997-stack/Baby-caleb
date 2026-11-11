import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abrirCredenciales,
  cambiarModo,
  configurarCredencial,
  enunciadosDeCredencial,
  enunciadosDeModo,
  enunciadosDeQuitar,
  encender,
  apagar,
  estado,
  quitarCredencial,
  type ContextoPasarelas,
} from "./pasarelas";
import { guardar, leerVigentes } from "./ajustes";
import { contextoDeCifrado } from "../dominio/pasarelas";
import { abrirLlaveMaestra, cifrar } from "../seguridad/cifrado";

/**
 * Configurar las pasarelas de cobro en D1.
 *
 * Lo que se vigila, por orden de lo que dolería más:
 *
 *  1. **Que un secreto no salga.** Ni en el estado que lee la pantalla, ni en
 *     el libro, ni en la fila de la tabla, ni en un mensaje de error.
 *  2. **Que no se cobre con el juego de credenciales equivocado.** El modo
 *     decide qué claves se usan, y no hay forma de pedir las de prueba estando
 *     en real.
 *  3. **Que sin llave maestra no se guarde NADA.** Un secreto en claro en una
 *     tabla no se nota y nadie vuelve a mirarlo.
 *  4. **Que configurar no encienda.** Encender es un acto aparte de la dueña.
 *  5. **Que nadie pierda un cambio** cuando dos personas tocan lo mismo.
 *
 * Cada prueba se comprobó rompiendo a propósito lo que dice vigilar; las
 * mutaciones están anotadas.
 */

// Obviamente falsas: 32 bytes de texto legible. Ninguna llave ni credencial de
// verdad entra en un archivo de este repositorio.
const LLAVE = "TExBVkUtRkFMU0EtREUtUFJVRUJBLTMyLUJZVEVTISE=";
const OTRA_LLAVE = "T1RSQS1MTEFWRS1GQUxTQS1ERS1QUlVFQkEtMzItQiE=";

const ID_FALSO = "ID-COMERCIO-FALSO-DE-PRUEBA-0001";
const CLAVE_FALSA = "CLAVE-SECRETA-FALSA-DE-PRUEBA-01";
const ID_FALSO_REAL = "ID-COMERCIO-FALSO-MODO-REAL-0002";
const CLAVE_FALSA_REAL = "CLAVE-SECRETA-FALSA-MODO-REAL-02";

// Cada prueba usa su propio instante. El libro no se puede borrar —es un
// libro—, así que las líneas de una prueba se encuentran por su `creado_en` en
// vez de suponiendo que la tabla está vacía.
const BASE = 1_800_000_000_000;
let n = 0;
let ahora = BASE;
let ctx: ContextoPasarelas;

const otraPersona = (): ContextoPasarelas => ({ ...ctx, actor: "juan@juancitoads.com" });

beforeEach(async () => {
  ahora = BASE + ++n * 3_600_000;
  ctx = { db: env.DB, ahora, actor: "yarielis@babycaleb.com", llaveMaestra: LLAVE };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pasarela_credenciales"),
    env.DB.prepare("DELETE FROM ajustes"),
    env.DB.prepare("DELETE FROM controles"),
    env.DB.prepare(
      "UPDATE pasarelas SET modo = 'prueba', modo_cambiado_por = NULL, modo_cambiado_en = NULL",
    ),
  ]);
});

const unaDe = async (pasarela: string) => {
  const r = await estado(ctx);
  if (!r.ok) throw new Error(r.mensaje);
  const p = r.datos.pasarelas.find((x) => x.pasarela === pasarela);
  if (p === undefined) throw new Error(`${pasarela} no está en el estado`);
  return p;
};

const filaDe = (modo: string, credencial: string) =>
  env.DB.prepare(
    `SELECT credencial, version, secreto_cifrado, llave_id, puesta_por, puesta_en
       FROM pasarela_credenciales WHERE pasarela = 'yappy' AND modo = ? AND credencial = ?`,
  )
    .bind(modo, credencial)
    .first<{
      credencial: string;
      version: number;
      secreto_cifrado: string;
      llave_id: string;
      puesta_por: string;
      puesta_en: number;
    }>();

const lineasDeEstaPrueba = async () => {
  const { results } = await env.DB.prepare(
    `SELECT accion, modo, credencial, version, llave_id, actor, motivo
       FROM pasarela_bitacora WHERE creado_en = ? ORDER BY id`,
  )
    .bind(ahora)
    .all<{
      accion: string;
      modo: string;
      credencial: string | null;
      version: number | null;
      llave_id: string | null;
      actor: string;
      motivo: string;
    }>();
  return results;
};

const encendidas = async (): Promise<readonly string[]> => {
  const r = await leerVigentes(ctx);
  if (!r.ok) throw new Error(r.mensaje);
  const a = r.datos.ajustes.find((x) => x.clave === "pasarelas_activas");
  return Array.isArray(a?.valor) ? (a.valor as string[]) : [];
};

async function ponerYappyCompleta(modo: "prueba" | "real" = "prueba") {
  const id = modo === "prueba" ? ID_FALSO : ID_FALSO_REAL;
  const clave = modo === "prueba" ? CLAVE_FALSA : CLAVE_FALSA_REAL;
  for (const [credencial, valor] of [
    ["id_comercio", id],
    ["clave_secreta", clave],
  ]) {
    const r = await configurarCredencial(ctx, {
      pasarela: "yappy",
      modo,
      credencial,
      valor,
      motivo: "me llegaron las de Yappy",
    });
    if (!r.ok) throw new Error(r.mensaje);
  }
}

/** Un sobre de verdad, para probar el esquema sin pasar por el módulo. */
async function unSobre(
  secreto = CLAVE_FALSA,
  sitio = contextoDeCifrado("yappy", "prueba", "clave_secreta"),
): Promise<string> {
  const k = await abrirLlaveMaestra(LLAVE);
  if (!k.ok) throw new Error(k.mensaje);
  const s = await cifrar(k.datos, secreto, sitio);
  if (!s.ok) throw new Error(s.mensaje);
  return s.datos;
}

// ---------------------------------------------------------------------------

describe("estado", () => {
  /**
   * La pantalla tiene que poder contestar de un vistazo: qué pasarelas hay,
   * cuáles están encendidas, a cuál le falta QUÉ, y en qué modo está.
   *
   * Mutación: devolviendo solo las pasarelas que tienen alguna credencial
   * puesta, se cae. Una pasarela que desaparece de la lista es una que nadie
   * vuelve a buscar — y al principio no hay ninguna configurada.
   */
  it("devuelve las tres pasarelas, apagadas y en modo prueba", async () => {
    const r = await estado(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.pasarelas.map((p) => p.pasarela)).toEqual(["yappy", "tilopay", "paypal"]);
    for (const p of r.datos.pasarelas) {
      // Nace apagada, y en el modo que no cobra.
      expect(p.encendida, p.pasarela).toBe(false);
      expect(p.modo, p.pasarela).toBe("prueba");
      expect(p.modo_cambiado_por, p.pasarela).toBeNull();
      expect(p.puede_encenderse, p.pasarela).toBe(false);
    }
  });

  /**
   * Y dice CUÁL falta, por su nombre de verdad.
   *
   * Mutación: devolviendo `faltan: []` o un «configuración incompleta», se cae.
   */
  it("dice qué credencial falta, con el nombre que la dueña ve en el portal", async () => {
    const yappy = await unaDe("yappy");
    const prueba = yappy.modos.find((m) => m.modo === "prueba");
    expect(prueba?.faltan).toEqual(["ID de comercio", "Clave secreta"]);
    expect(prueba?.completo).toBe(false);
    expect(yappy.por_que_no).toContain("ID de comercio");
    expect(yappy.por_que_no).toContain("Clave secreta");
  });

  it("enseña Tilopay con su motivo y sin campos que inventar", async () => {
    const tilopay = await unaDe("tilopay");
    expect(tilopay.por_confirmar).not.toBeNull();
    expect(tilopay.modos.every((m) => m.credenciales.length === 0)).toBe(true);
    expect(tilopay.modos.every((m) => !m.completo)).toBe(true);
  });

  /**
   * De la llave maestra se puede decir UNA cosa: si está puesta. Nada más —ni
   * su largo, ni un trozo, ni su huella.
   *
   * Mutación: devolviendo `llave_maestra_puesta: true` fijo, se cae; y la
   * pantalla dejaría de avisar de lo único que impide guardar.
   */
  it("dice si la llave maestra está puesta, y nada más de ella", async () => {
    const sin = await estado({ db: env.DB, ahora });
    expect(sin.ok).toBe(true);
    if (!sin.ok) return;
    expect(sin.datos.llave_maestra_puesta).toBe(false);
    expect(sin.datos.llave_maestra_problema).toContain("PASARELAS_LLAVE_MAESTRA");
    expect(JSON.stringify(sin.datos)).not.toContain(LLAVE);

    const con = await estado(ctx);
    expect(con.ok).toBe(true);
    if (!con.ok) return;
    expect(con.datos.llave_maestra_puesta).toBe(true);
    expect(con.datos.llave_maestra_problema).toBeNull();
    expect(JSON.stringify(con.datos)).not.toContain(LLAVE);
  });

  /**
   * Una pasarela encendida sin credenciales completas no se puede dar por
   * buena en silencio. Por estas funciones no pasa, pero la lista de encendidas
   * también se puede editar desde la pantalla de Ajustes, que no sabe nada de
   * credenciales.
   *
   * Mutación: quitando `incoherente`, la pantalla enseñaría «Encendida» a secas
   * sobre un checkout que ofrece un botón que no cobra.
   */
  it("marca como incoherente una pasarela encendida a la que le falta algo", async () => {
    // El camino de la pantalla de Ajustes: se escribe el ajuste directamente.
    const g = await guardar(
      { db: env.DB, ahora, actor: "yarielis@babycaleb.com" },
      { clave: "pasarelas_activas", valor: ["yappy"], motivo: "a mano desde Ajustes" },
    );
    expect(g.ok).toBe(true);
    const yappy = await unaDe("yappy");
    expect(yappy.encendida).toBe(true);
    expect(yappy.incoherente).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("configurarCredencial", () => {
  /**
   * **Sin llave maestra no se guarda nada.** Ni en claro «mientras tanto», ni
   * con un cifrado de juguete.
   *
   * Mutación: guardando el valor tal cual cuando falta la llave —el atajo «ya
   * lo ciframos cuando esté la llave»— se cae: la tabla acaba con una fila.
   */
  it("falla si no hay llave maestra, y no deja ni una fila", async () => {
    const r = await configurarCredencial(
      { db: env.DB, ahora, actor: "yarielis@babycaleb.com" },
      {
        pasarela: "yappy",
        modo: "prueba",
        credencial: "clave_secreta",
        valor: CLAVE_FALSA,
        motivo: "probando",
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensaje).toContain("PASARELAS_LLAVE_MAESTRA");

    const cuantas = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pasarela_credenciales",
    ).first<{ n: number }>();
    expect(cuantas?.n).toBe(0);
    expect(await lineasDeEstaPrueba()).toEqual([]);
  });

  /**
   * Lo que queda en la tabla es un sobre, no la clave.
   *
   * Mutación: guardando `valor` en vez de `sobre.datos`, se cae por el
   * `not.toContain` — y antes de eso la tumba el `CHECK` de la migración, que
   * exige la marca `aesgcm1.`. Las dos defensas se solapan a propósito.
   */
  it("guarda el secreto cifrado, firmado y con la huella de la llave", async () => {
    const r = await configurarCredencial(ctx, {
      pasarela: "yappy",
      modo: "prueba",
      credencial: "clave_secreta",
      valor: `  ${CLAVE_FALSA}\n`,
      motivo: "me llegó la clave de Yappy",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toMatchObject({ version: 1, primera_vez: true, modo: "prueba" });
    // Lo que devuelve la función tampoco lleva el valor.
    expect(JSON.stringify(r.datos)).not.toContain(CLAVE_FALSA);

    const fila = await filaDe("prueba", "clave_secreta");
    expect(fila?.secreto_cifrado.startsWith("aesgcm1.")).toBe(true);
    expect(fila?.secreto_cifrado).not.toContain(CLAVE_FALSA);
    expect(fila?.puesta_por).toBe("yarielis@babycaleb.com");
    expect(fila?.puesta_en).toBe(ahora);
    expect(fila?.llave_id.length).toBeGreaterThan(0);
  });

  /**
   * **La prueba principal de todo este trabajo.**
   *
   * El estado que lee la pantalla no lleva el valor por ningún camino: ni en la
   * credencial, ni en el libro, ni escondido en un campo que nadie mira. Se
   * serializa todo y se busca el secreto dentro.
   *
   * Mutación: añadiendo `secreto_cifrado` a la consulta de `estado` y
   * devolviéndolo en `CredencialPuesta`, el criptograma asoma; cambiando además
   * el cifrado por un base64, asoma el secreto. Lo comprobé con las dos.
   */
  it("el estado dice que está puesta y no deja salir el valor por ningún lado", async () => {
    await ponerYappyCompleta();

    const r = await estado(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const entero = JSON.stringify(r.datos);
    for (const secreto of [ID_FALSO, CLAVE_FALSA]) {
      expect(entero).not.toContain(secreto);
      expect(entero).not.toContain(btoa(secreto));
    }
    // Ni el criptograma: lo que no se lee de la base no puede salir.
    expect(entero).not.toContain("aesgcm1.");

    const yappy = r.datos.pasarelas.find((p) => p.pasarela === "yappy");
    const prueba = yappy?.modos.find((m) => m.modo === "prueba");
    expect(prueba?.credenciales.map((c) => [c.nombre, c.puesta])).toEqual([
      ["id_comercio", true],
      ["clave_secreta", true],
    ]);
    expect(prueba?.faltan).toEqual([]);
    expect(prueba?.completo).toBe(true);
    expect(prueba?.credenciales[0]?.puesta_por).toBe("yarielis@babycaleb.com");
    // Y el otro modo sigue vacío: son dos juegos distintos.
    const real = yappy?.modos.find((m) => m.modo === "real");
    expect(real?.credenciales.every((c) => !c.puesta)).toBe(true);
    expect(real?.completo).toBe(false);
  });

  it("anota en el libro qué credencial cambió, nunca su valor", async () => {
    await configurarCredencial(ctx, {
      pasarela: "yappy",
      modo: "prueba",
      credencial: "clave_secreta",
      valor: CLAVE_FALSA,
      motivo: "me llegó la clave de Yappy",
    });
    const lineas = await lineasDeEstaPrueba();
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({
      accion: "credencial_puesta",
      modo: "prueba",
      credencial: "clave_secreta",
      version: 1,
      actor: "yarielis@babycaleb.com",
      motivo: "me llegó la clave de Yappy",
    });
    expect(JSON.stringify(lineas)).not.toContain(CLAVE_FALSA);
  });

  it("al volver a ponerla sube de versión y el libro dice que se cambió", async () => {
    await configurarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta",
      valor: CLAVE_FALSA, motivo: "la primera",
    });
    const r = await configurarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta",
      valor: CLAVE_FALSA + "X", motivo: "Yappy me la rotó",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toMatchObject({ version: 2, primera_vez: false });

    expect((await filaDe("prueba", "clave_secreta"))?.version).toBe(2);
    const lineas = await lineasDeEstaPrueba();
    expect(lineas.map((l) => l.accion)).toEqual(["credencial_puesta", "credencial_cambiada"]);
    expect(lineas.map((l) => l.version)).toEqual([1, 2]);
  });

  /**
   * **Configurar no enciende.** Es el punto 6 del pedido, y aquí es donde se
   * comprueba: después de dejar Yappy completa, `pasarelas_activas` sigue
   * vacío.
   *
   * Mutación: metiendo la pasarela en `pasarelas_activas` al completar sus
   * credenciales —«ya está lista, para qué otro clic»— se cae. Y con ella se
   * perdería el único punto en el que una persona confirma que probó el cobro.
   */
  it("no enciende nada: dejar la pasarela completa no la pone a cobrar", async () => {
    await ponerYappyCompleta();
    expect(await encendidas()).toEqual([]);
    const yappy = await unaDe("yappy");
    expect(yappy.encendida).toBe(false);
    // Lista, pero apagada.
    expect(yappy.puede_encenderse).toBe(true);
  });

  it("exige decir el modo, un motivo y una firma", async () => {
    const base = {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta", valor: CLAVE_FALSA,
    };
    expect((await configurarCredencial(ctx, { ...base, modo: "sandbox", motivo: "x" })).ok).toBe(false);
    expect((await configurarCredencial(ctx, { ...base, modo: undefined, motivo: "x" })).ok).toBe(false);
    expect((await configurarCredencial(ctx, { ...base, motivo: "   " })).ok).toBe(false);
    expect((await configurarCredencial(ctx, { ...base, motivo: "x".repeat(501) })).ok).toBe(false);
    expect((await configurarCredencial({ ...ctx, actor: " " }, { ...base, motivo: "x" })).ok).toBe(false);
    expect(await lineasDeEstaPrueba()).toEqual([]);
  });

  it("no acepta una credencial que esa pasarela no pide, ni una pasarela por confirmar", async () => {
    expect(
      (await configurarCredencial(ctx, {
        pasarela: "yappy", modo: "prueba", credencial: "client_id",
        valor: CLAVE_FALSA, motivo: "x",
      })).ok,
    ).toBe(false);
    expect(
      (await configurarCredencial(ctx, {
        pasarela: "tilopay", modo: "prueba", credencial: "api_key",
        valor: CLAVE_FALSA, motivo: "x",
      })).ok,
    ).toBe(false);
  });

  /**
   * Dos personas poniendo la misma credencial a la vez: la segunda FALLA, no
   * pisa. Lo cierra el trigger `pasarela_credencial_sube_de_version`, que mira
   * la versión que había contra la que este lote quiere escribir.
   *
   * Se corre con los enunciados a mano porque es la única forma de reproducir
   * la carrera: se preparan los de una persona, escribe la otra, y entonces se
   * sueltan los primeros.
   *
   * Mutación: quitando ese trigger de migrations/0010, el lote pasa y la clave
   * de la segunda pisa la de la primera sin que nada falle. Se cae aquí.
   */
  it("el segundo que guarda a la vez falla, y no pisa lo que entró", async () => {
    await configurarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta",
      valor: CLAVE_FALSA, motivo: "la primera",
    });

    // Yarielis prepara la versión 2 con su clave…
    const suyos = enunciadosDeCredencial(ctx, {
      pasarela: "yappy",
      modo: "prueba",
      credencial: "clave_secreta",
      secretoCifrado: await unSobre(CLAVE_FALSA + "-YARIELIS"),
      llaveId: "huella",
      version: 2,
      motivo: "la de Yarielis",
    });

    // …y mientras tanto Juan guarda la suya.
    const deJuan = await configurarCredencial(otraPersona(), {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta",
      valor: CLAVE_FALSA + "-JUAN", motivo: "la de Juan",
    });
    expect(deJuan.ok).toBe(true);

    await expect(env.DB.batch(suyos)).rejects.toThrow();

    const fila = await filaDe("prueba", "clave_secreta");
    expect(fila?.version).toBe(2);
    // La que quedó es la de Juan, que llegó primero. La de Yarielis no entró.
    expect(fila?.puesta_por).toBe("juan@juancitoads.com");
  });

  it("y el mismo camino, sin carrera, sí guarda", async () => {
    const suyos = enunciadosDeCredencial(ctx, {
      pasarela: "yappy",
      modo: "prueba",
      credencial: "clave_secreta",
      secretoCifrado: await unSobre(),
      llaveId: "huella",
      version: 1,
      motivo: "sin nadie en medio",
    });
    await expect(env.DB.batch(suyos)).resolves.toBeDefined();
    expect((await filaDe("prueba", "clave_secreta"))?.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("encender y apagar", () => {
  /**
   * Mutación: quitando la comprobación de `puede_encenderse`, Yappy se
   * enciende sin credenciales y el checkout ofrece un botón que no cobra. Se
   * cae.
   */
  it("no enciende una pasarela a la que le falta una credencial, y dice cuál", async () => {
    await configurarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "id_comercio",
      valor: ID_FALSO, motivo: "la primera que me dieron",
    });
    const r = await encender(ctx, { pasarela: "yappy", motivo: "a cobrar" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("transicion_invalida");
    expect(r.mensaje).toContain("Clave secreta");
    expect(await encendidas()).toEqual([]);
  });

  it("no enciende una pasarela cuyas credenciales están por confirmar", async () => {
    const r = await encender(ctx, { pasarela: "tilopay", motivo: "a cobrar" });
    expect(r.ok).toBe(false);
    expect(await encendidas()).toEqual([]);
  });

  /**
   * Encender es cambiar `ajustes.pasarelas_activas`, que es su único dueño: así
   * queda con su versión, su firma y su motivo, y el checkout lee de un solo
   * sitio.
   *
   * Mutación: escribiendo una columna `activa` propia, esta prueba se cae
   * porque el ajuste no cambia — y el checkout, que lee el ajuste, seguiría sin
   * ofrecer la pasarela por mucho que el panel la enseñara encendida.
   */
  it("enciende cuando están todas, y queda en los ajustes con firma y motivo", async () => {
    await ponerYappyCompleta();
    const r = await encender(ctx, { pasarela: "yappy", motivo: "el cobro de $1 salió bien" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.cambio).toBe(true);
    expect(await encendidas()).toEqual(["yappy"]);

    const vigentes = await leerVigentes(ctx);
    if (!vigentes.ok) return;
    const ajuste = vigentes.datos.ajustes.find((a) => a.clave === "pasarelas_activas");
    expect(ajuste?.cambiado_por).toBe("yarielis@babycaleb.com");
    expect(ajuste?.motivo).toBe("el cobro de $1 salió bien");

    expect((await unaDe("yappy")).encendida).toBe(true);
    expect((await unaDe("yappy")).incoherente).toBe(false);
  });

  /**
   * El historial de encendidas no lo escribe mi libro: sale del historial de
   * `ajustes.pasarelas_activas`, que es su dueño. Esto comprueba que la
   * pantalla lo puede leer de ahí — si no, «¿quién encendió Yappy?» no tendría
   * respuesta en ningún sitio que alguien vaya a mirar.
   *
   * Mutación: devolviendo `encendidas_historial: []` fijo, se cae.
   */
  it("el estado trae quién encendió y apagó, leído del historial del ajuste", async () => {
    await ponerYappyCompleta();
    await encender(ctx, { pasarela: "yappy", motivo: "el cobro de $1 salió bien" });
    await apagar(ctx, { pasarela: "yappy", motivo: "Yappy está caído" });

    const r = await estado(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // De la más nueva a la más vieja, como el historial de ajustes.
    expect(r.datos.encendidas_historial.map((c) => c.encendidas)).toEqual([[], ["yappy"]]);
    expect(r.datos.encendidas_historial.map((c) => c.motivo)).toEqual([
      "Yappy está caído",
      "el cobro de $1 salió bien",
    ]);
    expect(r.datos.encendidas_historial.every((c) => c.quien === "yarielis@babycaleb.com")).toBe(
      true,
    );
    // Y encender/apagar NO ensucian el libro de las credenciales: son dos
    // registros distintos y cada hecho está en uno solo.
    expect((await lineasDeEstaPrueba()).every((l) => l.accion !== "modo_cambiado")).toBe(true);
  });

  it("encender dos veces no escribe una versión de más", async () => {
    await ponerYappyCompleta();
    await encender(ctx, { pasarela: "yappy", motivo: "ya probé" });
    const otra = await encender(ctx, { pasarela: "yappy", motivo: "otra vez" });
    expect(otra.ok).toBe(true);
    if (!otra.ok) return;
    expect(otra.datos.cambio).toBe(false);
    const cuantas = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ajustes WHERE clave = 'pasarelas_activas'",
    ).first<{ n: number }>();
    expect(cuantas?.n).toBe(1);
  });

  /**
   * Apagar no lleva ninguna condición: es el interruptor de emergencia de
   * 04-pagos §10. Una condición aquí es un interruptor que no responde el día
   * que hace falta.
   */
  it("apaga siempre, incluso una pasarela encendida a la que le falta algo", async () => {
    await guardar(
      { db: env.DB, ahora, actor: "yarielis@babycaleb.com" },
      { clave: "pasarelas_activas", valor: ["yappy"], motivo: "a mano" },
    );
    expect((await unaDe("yappy")).incoherente).toBe(true);
    const r = await apagar(ctx, { pasarela: "yappy", motivo: "algo va mal" });
    expect(r.ok).toBe(true);
    expect(await encendidas()).toEqual([]);
  });

  it("apagar lo que ya estaba apagado no escribe nada", async () => {
    const r = await apagar(ctx, { pasarela: "yappy", motivo: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.cambio).toBe(false);
    const cuantas = await env.DB.prepare("SELECT COUNT(*) AS n FROM ajustes").first<{ n: number }>();
    expect(cuantas?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("cambiarModo", () => {
  /**
   * **La regla que impide el fallo caro.** El modo decide qué juego de
   * credenciales se usa, así que cambiarlo con el cobro abierto cambia en
   * silencio con qué claves se cobra: el siguiente pedido se cobra de verdad
   * con las de prueba, o al revés.
   *
   * Mutación: quitando esta comprobación, se cae.
   */
  it("no cambia de modo con la pasarela encendida", async () => {
    await ponerYappyCompleta();
    await encender(ctx, { pasarela: "yappy", motivo: "probada" });
    const r = await cambiarModo(ctx, { pasarela: "yappy", modo: "real", motivo: "a producción" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("transicion_invalida");
    expect((await unaDe("yappy")).modo).toBe("prueba");
  });

  it("apagada sí cambia, y queda anotado con quién y cuándo", async () => {
    const r = await cambiarModo(ctx, {
      pasarela: "yappy", modo: "real", motivo: "ya tengo las credenciales de producción",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.cambio).toBe(true);

    const yappy = await unaDe("yappy");
    expect(yappy.modo).toBe("real");
    expect(yappy.modo_cambiado_por).toBe("yarielis@babycaleb.com");
    expect(yappy.modo_cambiado_en).toBe(ahora);

    const lineas = await lineasDeEstaPrueba();
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({
      accion: "modo_cambiado", modo: "real", credencial: null, version: null,
    });
  });

  it("al mismo modo no escribe ninguna línea en el libro", async () => {
    const r = await cambiarModo(ctx, { pasarela: "yappy", modo: "prueba", motivo: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.cambio).toBe(false);
    expect(await lineasDeEstaPrueba()).toEqual([]);
  });

  /**
   * El control del cambio de modo mira el estado YA ESCRITO, y mira el actor y
   * el instante que ESTE lote quería dejar puestos. Se corre **el control solo,
   * sin su UPDATE**, con otra persona ya adelantada: si mirara solo `modo =
   * 'real'`, encontraría la fila del otro y daría por bueno un cambio que no
   * escribió nada — y el libro diría que lo hizo Yarielis.
   *
   * Mutación: quitando `modo_cambiado_por` y `modo_cambiado_en` del `WHERE` del
   * control, el lote pasa y esto se cae.
   */
  it("el control no da por bueno un cambio de modo que no escribió nada", async () => {
    const mios = enunciadosDeModo(ctx, {
      pasarela: "yappy", de: "prueba", a: "real", motivo: "el mío",
    });

    // Otra persona ya dejó Yappy en real.
    await env.DB.prepare(
      "UPDATE pasarelas SET modo = 'real', modo_cambiado_por = 'otra@persona', modo_cambiado_en = ? WHERE pasarela = 'yappy'",
    )
      .bind(ahora - 1)
      .run();

    // Solo el control: se simula que el UPDATE no casó con nada.
    await expect(env.DB.batch(mios.slice(1, 2))).rejects.toThrow();

    const fila = await env.DB.prepare(
      "SELECT modo_cambiado_por FROM pasarelas WHERE pasarela = 'yappy'",
    ).first<{ modo_cambiado_por: string }>();
    expect(fila?.modo_cambiado_por).toBe("otra@persona");
  });

  it("y sí lo da por bueno cuando el cambio es el de este lote", async () => {
    const mios = enunciadosDeModo(ctx, {
      pasarela: "yappy", de: "prueba", a: "real", motivo: "el mío",
    });
    await expect(env.DB.batch(mios)).resolves.toBeDefined();
    const control = await env.DB.prepare(
      "SELECT regla FROM controles WHERE regla = 'pasarela:modo:yappy'",
    ).first<{ regla: string }>();
    expect(control?.regla).toBe("pasarela:modo:yappy");
  });
});

// ---------------------------------------------------------------------------

describe("abrirCredenciales", () => {
  /**
   * **El fallo caro, probado.** Con las credenciales de los DOS modos puestas,
   * lo que sale es el juego del modo en el que está la pasarela — y nunca el
   * otro.
   *
   * Mutación: quitando `AND modo = ?` de la consulta, salen las cuatro y esto
   * se cae. Esa mutación es exactamente «cobrar de verdad con las credenciales
   * de prueba», y es la que no haría fallar nada más del sistema.
   */
  it("solo abre el juego del modo en el que está la pasarela", async () => {
    await ponerYappyCompleta("prueba");
    await ponerYappyCompleta("real");

    const enPrueba = await abrirCredenciales(ctx, "yappy");
    expect(enPrueba.ok).toBe(true);
    if (!enPrueba.ok) return;
    expect(enPrueba.datos.modo).toBe("prueba");
    expect(enPrueba.datos.valores.get("id_comercio")).toBe(ID_FALSO);
    expect(enPrueba.datos.valores.get("clave_secreta")).toBe(CLAVE_FALSA);

    await cambiarModo(ctx, { pasarela: "yappy", modo: "real", motivo: "a producción" });

    const enReal = await abrirCredenciales(ctx, "yappy");
    expect(enReal.ok).toBe(true);
    if (!enReal.ok) return;
    expect(enReal.datos.modo).toBe("real");
    expect(enReal.datos.valores.get("id_comercio")).toBe(ID_FALSO_REAL);
    expect(enReal.datos.valores.get("clave_secreta")).toBe(CLAVE_FALSA_REAL);
    // Y en ningún caso se cuela el juego del otro modo.
    expect([...enReal.datos.valores.values()]).not.toContain(CLAVE_FALSA);
  });

  /**
   * Un `Map` metido por error en una respuesta HTTP sale como `{}`. No sustituye
   * a no meterlo; es la red por si alguien lo mete dentro de un año.
   *
   * Mutación: devolviendo un objeto plano en vez de un `Map`, se cae.
   */
  it("su resultado no lleva los secretos al serializarlo", async () => {
    await ponerYappyCompleta();
    const r = await abrirCredenciales(ctx, "yappy");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r)).not.toContain(CLAVE_FALSA);
    expect(JSON.stringify(r)).not.toContain(ID_FALSO);
    // Y aun así el adaptador las tiene.
    expect(r.datos.valores.size).toBe(2);
  });

  it("falla si falta una, en vez de devolver media configuración", async () => {
    await configurarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "id_comercio",
      valor: ID_FALSO, motivo: "solo esta",
    });
    const r = await abrirCredenciales(ctx, "yappy");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("pasarela_no_disponible");
    expect(r.mensaje).toContain("Clave secreta");
  });

  it("falla si la llave maestra no está, o si es otra", async () => {
    await ponerYappyCompleta();
    expect((await abrirCredenciales({ db: env.DB, ahora }, "yappy")).ok).toBe(false);
    const conOtra = await abrirCredenciales(
      { db: env.DB, ahora, llaveMaestra: OTRA_LLAVE },
      "yappy",
    );
    expect(conOtra.ok).toBe(false);
    if (conOtra.ok) return;
    expect(conOtra.mensaje).toContain("Vuelva a pegarla");
  });

  it("no abre una pasarela por confirmar ni una que no existe", async () => {
    expect((await abrirCredenciales(ctx, "tilopay")).ok).toBe(false);
    expect((await abrirCredenciales(ctx, "stripe")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("quitarCredencial", () => {
  it("la quita y lo anota, sin el valor", async () => {
    await ponerYappyCompleta();
    const r = await quitarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta",
      motivo: "Yappy la revocó",
    });
    expect(r.ok).toBe(true);
    expect(await filaDe("prueba", "clave_secreta")).toBeNull();

    const quitada = (await lineasDeEstaPrueba()).filter((l) => l.accion === "credencial_quitada");
    expect(quitada).toHaveLength(1);
    expect(quitada[0]).toMatchObject({ credencial: "clave_secreta", version: null, llave_id: null });
    expect(JSON.stringify(quitada)).not.toContain(CLAVE_FALSA);

    const yappy = await unaDe("yappy");
    expect(yappy.puede_encenderse).toBe(false);
    expect(yappy.por_que_no).toContain("Clave secreta");
  });

  it("no se quita con la pasarela encendida", async () => {
    await ponerYappyCompleta();
    await encender(ctx, { pasarela: "yappy", motivo: "probada" });
    const r = await quitarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta", motivo: "x",
    });
    expect(r.ok).toBe(false);
    expect(await filaDe("prueba", "clave_secreta")).not.toBeNull();
  });

  it("no quita lo que no estaba puesto", async () => {
    const r = await quitarCredencial(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta", motivo: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });

  /**
   * El control de quitar mira la AUSENCIA que este lote dejó. Se corre el
   * control solo, con la fila todavía puesta: un `DELETE` que no casa con nada
   * no falla, y sin este control el libro diría que la credencial se quitó
   * mientras sigue ahí.
   *
   * Mutación: quitando la fila de `controles` de `enunciadosDeQuitar`, el lote
   * pasa y esto se cae.
   */
  it("el control no da por bueno un borrado que no ocurrió", async () => {
    await ponerYappyCompleta();
    const mios = enunciadosDeQuitar(ctx, {
      pasarela: "yappy", modo: "prueba", credencial: "clave_secreta", motivo: "el mío",
    });
    await expect(env.DB.batch(mios.slice(1, 2))).rejects.toThrow();
    expect(await filaDe("prueba", "clave_secreta")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("el esquema lo hace imposible", () => {
  const meter = (
    modo: string,
    credencial: string,
    secreto: string,
    version = 1,
  ): Promise<unknown> =>
    env.DB.prepare(
      `INSERT INTO pasarela_credenciales
         (pasarela, modo, credencial, version, secreto_cifrado, llave_id, puesta_por, puesta_en)
       VALUES ('yappy', ?, ?, ?, ?, 'huella', 'a@b.com', 1)`,
    )
      .bind(modo, credencial, version, secreto)
      .run();

  /**
   * Un secreto pegado a mano en la consola de D1 no entra. Es la última
   * barandilla: el módulo cifra siempre, pero la tabla no se fía.
   *
   * Mutación: quitando el `CHECK` de `secreto_cifrado`, las tres entran.
   */
  it("no deja escribir un secreto en claro en la columna del criptograma", async () => {
    await expect(meter("prueba", "clave_secreta", CLAVE_FALSA)).rejects.toThrow();
    // Con la marca pero sin cuerpo: no cabe ni el nonce y la etiqueta.
    await expect(meter("prueba", "clave_secreta", "aesgcm1.corto")).rejects.toThrow();
    // Con la marca, el largo y un espacio dentro.
    await expect(
      meter("prueba", "clave_secreta", "aesgcm1." + "A".repeat(30) + " " + "A".repeat(30)),
    ).rejects.toThrow();
  });

  it("acepta un sobre de verdad", async () => {
    await expect(meter("prueba", "clave_secreta", await unSobre())).resolves.toBeDefined();
  });

  /**
   * El mismo criptograma en dos sitios es la pinta de una copia de fila a fila,
   * que es como se intentaría usar la credencial de prueba en el modo real. El
   * cifrado ya lo impide (va atado a su sitio); esto lo deja además imposible
   * de escribir.
   */
  it("no deja el mismo criptograma en dos sitios", async () => {
    const sobre = await unSobre();
    await meter("prueba", "clave_secreta", sobre);
    await expect(meter("real", "clave_secreta", sobre)).rejects.toThrow();
    await expect(meter("prueba", "id_comercio", sobre)).rejects.toThrow();
  });

  it("no deja mudar una credencial a otro modo", async () => {
    await meter("prueba", "clave_secreta", await unSobre());
    await expect(
      env.DB.prepare(
        "UPDATE pasarela_credenciales SET modo = 'real', version = version + 1 WHERE pasarela = 'yappy' AND credencial = 'clave_secreta'",
      ).run(),
    ).rejects.toThrow(/otra pasarela ni a otro modo/);
  });

  it("no deja reescribir una credencial sin subir de versión", async () => {
    await meter("prueba", "clave_secreta", await unSobre());
    const otro = await unSobre(CLAVE_FALSA + "X");
    await expect(
      env.DB.prepare(
        "UPDATE pasarela_credenciales SET secreto_cifrado = ? WHERE pasarela = 'yappy' AND modo = 'prueba' AND credencial = 'clave_secreta'",
      )
        .bind(otro)
        .run(),
    ).rejects.toThrow();
  });

  const unaLinea = (campos: string, valores: string) =>
    env.DB.prepare(
      `INSERT INTO pasarela_bitacora (id, pasarela, accion, modo, actor, motivo, creado_en${campos})
       VALUES (?, 'yappy', ?, 'prueba', 'a@b.com', 'por qué', ?${valores})`,
    );

  it("no deja editar ni borrar el libro", async () => {
    await unaLinea(", credencial, version, llave_id", ", 'clave_secreta', 1, 'huella'")
      .bind(`lib-${n}-1`, "credencial_puesta", ahora)
      .run();
    await expect(
      env.DB.prepare("UPDATE pasarela_bitacora SET motivo = 'otro' WHERE id = ?")
        .bind(`lib-${n}-1`)
        .run(),
    ).rejects.toThrow(/no se edita/);
    await expect(
      env.DB.prepare("DELETE FROM pasarela_bitacora WHERE id = ?").bind(`lib-${n}-1`).run(),
    ).rejects.toThrow(/no se borra/);
  });

  /**
   * Una línea que no se puede leer no sirve de nada: «se cambió una credencial
   * de Yappy» sin decir cuál no contesta la pregunta por la que existe el libro.
   */
  it("no deja una línea de credencial sin decir cuál, ni una de modo que nombre una", async () => {
    await expect(
      unaLinea("", "").bind(`lib-${n}-2`, "credencial_puesta", ahora).run(),
    ).rejects.toThrow();
    await expect(
      unaLinea(", credencial, version, llave_id", ", 'clave_secreta', 1, 'huella'")
        .bind(`lib-${n}-3`, "modo_cambiado", ahora)
        .run(),
    ).rejects.toThrow();
    // Y una de «se quitó» no puede decir que quedó algo guardado.
    await expect(
      unaLinea(", credencial, version, llave_id", ", 'clave_secreta', 2, 'huella'")
        .bind(`lib-${n}-4`, "credencial_quitada", ahora)
        .run(),
    ).rejects.toThrow();
  });

  it("no deja una línea del libro sin motivo", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO pasarela_bitacora (id, pasarela, accion, modo, credencial, version, llave_id, actor, motivo, creado_en)
         VALUES (?, 'yappy', 'credencial_puesta', 'prueba', 'clave_secreta', 1, 'h', 'a@b.com', '  ', ?)`,
      )
        .bind(`lib-${n}-5`, ahora)
        .run(),
    ).rejects.toThrow();
  });

  it("no deja una pasarela que no es una de las tres", async () => {
    await expect(
      env.DB.prepare("INSERT INTO pasarelas (pasarela, modo) VALUES ('stripe', 'prueba')").run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE pasarelas SET modo = 'sandbox' WHERE pasarela = 'yappy'").run(),
    ).rejects.toThrow();
  });
});
