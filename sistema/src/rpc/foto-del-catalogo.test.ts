import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PREFIJO_FOTO, catalogoPublico, fotoPublica, listar } from "./catalogo";

/**
 * La foto que la dueña sube en el panel tiene que llegar a la tienda.
 *
 * La cadena estaba entera menos el último eslabón: la foto se subía, se
 * convertía, se guardaba en R2, quedaba en `variantes.imagen` y `/foto/<clave>`
 * la servía con un 200 — pero el catálogo público NO llevaba el campo, así que
 * la tienda seguía pintando la de `content.json` y la foto subida no se veía
 * en ningún sitio. Es la trampa §12 en su versión más cara: todas las piezas
 * construidas y probadas, y nadie llamando a la última.
 *
 * Lo que se vigila aquí son las dos reglas de la forma —relativa, y con algo
 * detrás del prefijo— por los dos caminos: la función pura y la puerta por la
 * que la web va a leerla de verdad (`catalogoPublico`), que es lo que manda la
 * trampa §6.
 */

const AHORA = 1_800_000_000_000;
const CLAVE = "catalogo/NAT-M/01HXQ2W3E4R5T6Y7U8I9O0P1A2.webp";
const RUTA = `${PREFIJO_FOTO}${CLAVE}`;

describe("qué forma tiene que tener una foto para salir hacia un navegador", () => {
  it("una ruta relativa del sistema sale tal cual", () => {
    expect(fotoPublica(RUTA)).toBe(RUTA);
    expect(fotoPublica(` ${RUTA} `)).toBe(RUTA);
  });

  /**
   * Este es EL caso. Puesta con el dominio del panel delante, la foto subía
   * bien (201, y el archivo de verdad en R2) y no se veía nunca: Access tapa
   * `panel.babycaleb.com` para quien no tiene sesión y la CSP del panel
   * (`img-src 'self'`) habría tapado la otra dirección. Dos muros y los dos
   * callados, que es la peor combinación que hay.
   */
  it("con un dominio delante, no sale: así es como una foto no se ve NUNCA", () => {
    expect(fotoPublica(`https://panel.babycaleb.com${RUTA}`)).toBeNull();
    expect(fotoPublica(`https://babycaleb.com${RUTA}`)).toBeNull();
    // `//otro.com/…` el navegador lo lee como «el mismo esquema, otro
    // dominio»: es absoluto aunque no lo parezca.
    expect(fotoPublica(`//babycaleb.com${RUTA}`)).toBeNull();
  });

  it("`/foto/` a secas tampoco: eso es un hueco, no una foto", () => {
    expect(fotoPublica(PREFIJO_FOTO)).toBeNull();
    expect(fotoPublica(`${PREFIJO_FOTO}   `)).toBeNull();
  });

  it("ni una clave más larga de lo que el propio sistema acepta", () => {
    // `SistemaWeb.archivo` rechaza por encima de 512, así que una más larga es
    // un 404 asegurado: prometerla sería prometer un hueco.
    expect(fotoPublica(`${PREFIJO_FOTO}${"a".repeat(512)}`)).toBe(
      `${PREFIJO_FOTO}${"a".repeat(512)}`,
    );
    expect(fotoPublica(`${PREFIJO_FOTO}${"a".repeat(513)}`)).toBeNull();
  });

  it("`/img/…` se queda fuera: de esa carpeta manda content.json", () => {
    // La columna nació documentada como «ruta pública en la web (/img/…)» en
    // `migrations/0001`. Esos archivos viven en el paquete de la web y su
    // dueño es `content.json`; dejarlos salir por aquí crearía un segundo
    // dueño de la misma ruta.
    expect(fotoPublica("/img/producto-caja-m.png")).toBeNull();
  });

  it("y lo que no es texto es que no hay foto", () => {
    expect(fotoPublica(null)).toBeNull();
    expect(fotoPublica(undefined)).toBeNull();
    expect(fotoPublica(42)).toBeNull();
    expect(fotoPublica("")).toBeNull();
  });
});

describe("el catálogo que recibe la web", () => {
  beforeEach(async () => {
    // La carga inicial (0003) trae las variantes SIN publicar y el catálogo
    // público solo enseña las publicadas.
    await env.DB.batch([
      env.DB.prepare("UPDATE variantes SET imagen = NULL, publicado = 0"),
      env.DB.prepare("UPDATE variantes SET publicado = 1 WHERE codigo IN ('NAT-M', 'NAT-L')"),
    ]);
  });

  const deLaWeb = async (codigo: string) =>
    (await catalogoPublico(env.DB, AHORA)).variantes.find((v) => v.codigo === codigo);

  it("sin foto subida, el campo viene en null y la tienda enseña lo de siempre", async () => {
    expect((await deLaWeb("NAT-M"))?.imagen).toBeNull();
  });

  it("con foto subida, la foto llega a la tienda", async () => {
    await env.DB.prepare("UPDATE variantes SET imagen = ? WHERE codigo = 'NAT-M'")
      .bind(RUTA)
      .run();

    expect((await deLaWeb("NAT-M"))?.imagen).toBe(RUTA);
    // Y solo a la suya: la foto de un artículo no se le pega al de al lado.
    expect((await deLaWeb("NAT-L"))?.imagen).toBeNull();
  });

  it("un valor absoluto guardado a mano no sale por la puerta", async () => {
    // Por aquí se llega: la columna es TEXT y nada en la base impide escribir
    // un dominio. Si saliera, la tienda pediría una foto que Access no deja
    // ver y el hueco no se lo explicaría nadie.
    await env.DB.prepare("UPDATE variantes SET imagen = ? WHERE codigo = 'NAT-M'")
      .bind(`https://panel.babycaleb.com${RUTA}`)
      .run();

    expect((await deLaWeb("NAT-M"))?.imagen).toBeNull();
  });

  it("y el catálogo del bot sigue sin saber nada de fotos", async () => {
    // `listar` es la del asistente: contesta WhatsApps con texto y una ruta de
    // imagen no le sirve para nada. Si algún día la necesita, que esta prueba
    // se ponga roja y se lea por qué no estaba.
    await env.DB.prepare("UPDATE variantes SET imagen = ? WHERE codigo = 'NAT-M'")
      .bind(RUTA)
      .run();

    for (const v of await listar(env.DB)) {
      expect(Object.keys(v), v.codigo).not.toContain("imagen");
    }
  });
});
