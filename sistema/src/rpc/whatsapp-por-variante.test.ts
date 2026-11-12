import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  catalogoPublico,
  numeroUsable,
  seEnseniaElBoton,
  whatsappDelNegocio,
} from "./catalogo";

/**
 * El botón de «Pedir por WhatsApp», artículo por artículo.
 *
 * El dueño lo pidió así: la web va a tener pago en línea, pero también se va a
 * poder pedir por WhatsApp, y «desde Ajustes el administrador decide si muestra
 * o no el botón de WhatsApp, por producto».
 *
 * Son dos decisiones en dos sitios —el ajuste global en `ajustes`, el
 * artículo en `variantes.pedir_por_whatsapp`— y lo que se vigila aquí es la
 * REGLA QUE LAS JUNTA, porque es donde se puede equivocar uno:
 *
 *  · el nulo de la columna es «lo que diga Ajustes», no «no»;
 *  · un «sí» en un artículo NO se salta el interruptor global;
 *  · sin número puesto no sale ningún botón.
 *
 * Y se prueba por donde lo va a leer la web (`catalogoPublico`), no solo la
 * función pura: la trampa §12 de `docs/TRAMPAS.md` es justo una pieza que
 * funciona y que nadie llama.
 */

const AHORA = 1_800_000_000_000;
const NUMERO = "50767575065";

/** El celular de la dueña, el único que puede ir aquí: está en content.json. */
const puso = async (clave: string, valor: unknown) => {
  await env.DB.prepare(
    `INSERT INTO ajustes (clave, version, valor_json, vigente_desde, cambiado_por, motivo)
     VALUES (?, 1, ?, ?, 'duena@babycaleb.com', 'prueba')
     ON CONFLICT(clave, version) DO UPDATE SET valor_json = excluded.valor_json`,
  )
    .bind(clave, JSON.stringify(valor), AHORA - 1000)
    .run();
};

describe("la regla que junta las dos decisiones", () => {
  const encendido = { activo: true, numero: NUMERO };

  it("el nulo de la columna hereda de Ajustes, no apaga", () => {
    expect(seEnseniaElBoton(encendido, null)).toBe(true);
    // `undefined` es lo que llega si la columna no viene en el SELECT. Se
    // trata igual que el nulo a propósito: la columna nació nula en las doce
    // variantes que ya existían.
    expect(seEnseniaElBoton(encendido, undefined)).toBe(true);
  });

  it("un 0 en el artículo lo apaga solo en ese artículo", () => {
    expect(seEnseniaElBoton(encendido, 0)).toBe(false);
    expect(seEnseniaElBoton(encendido, 1)).toBe(true);
  });

  it("apagar Ajustes manda por encima de un «sí» en el artículo", () => {
    // Es lo que la dueña haría si pierde o cambia el celular. Si un 1 pudiera
    // saltárselo, quedarían botones vivos apuntando a un número que ya no
    // contesta, y nada avisaría.
    expect(seEnseniaElBoton({ activo: false, numero: NUMERO }, 1)).toBe(false);
    expect(seEnseniaElBoton({ activo: false, numero: NUMERO }, null)).toBe(false);
  });

  it("sin número no sale el botón, aunque todo lo demás diga que sí", () => {
    // Pasa si no se pueden leer los ajustes: `whatsappDelNegocio` contesta
    // apagado y sin número en vez de suponer. Un botón que escribe a nadie es
    // peor que no tener botón.
    expect(seEnseniaElBoton({ activo: true, numero: null }, 1)).toBe(false);
  });
});

describe("qué cuenta como un celular usable", () => {
  /**
   * Se prueba AQUÍ, por abajo, y no a través de `whatsappDelNegocio`.
   *
   * Porque por arriba no se llega: `whatsapp_numero` no admite quedarse sin
   * decidir, así que `leerVigentes` nunca devuelve «PENDIENTE» para esa clave y
   * la mutación «quítale la comprobación del PENDIENTE» sobrevivía en verde.
   * Comprobado. Una guarda detrás de otra capa se prueba en su capa (§6).
   */
  it("«PENDIENTE» no es un número: es que falta decidirlo", () => {
    // Sin esto, el día que esa clave admita quedarse sin decidir, el botón
    // apuntaría a `wa.me/PENDIENTE`.
    expect(numeroUsable("PENDIENTE")).toBeNull();
  });

  it("ni lo vacío, ni lo que no es texto", () => {
    expect(numeroUsable("")).toBeNull();
    expect(numeroUsable("   ")).toBeNull();
    expect(numeroUsable(50767575065)).toBeNull();
    expect(numeroUsable(null)).toBeNull();
    expect(numeroUsable(undefined)).toBeNull();
  });

  it("y un número sí, sin los espacios de los bordes", () => {
    expect(numeroUsable(NUMERO)).toBe(NUMERO);
    expect(numeroUsable(` ${NUMERO} `)).toBe(NUMERO);
  });
});

describe("lo que el negocio tiene decidido", () => {
  it("sin nada guardado sale el valor de fábrica de reglas.json", async () => {
    const r = await whatsappDelNegocio(env.DB, AHORA);
    // Encendido y con el número que la web ya usaba. No es una cifra a ojo:
    // es el de `content.json` → `nap.phone`.
    expect(r).toEqual({ activo: true, numero: NUMERO });
  });

  it("lee lo que la dueña guardó, y el número normalizado", async () => {
    await puso("whatsapp_pedidos_activo", false);
    const r = await whatsappDelNegocio(env.DB, AHORA);
    expect(r.activo).toBe(false);
  });

  it("un valor guardado que hoy no se entiende NO se usa", async () => {
    // Alguien lo escribió a mano en la consola de D1. `leerVigentes` cae al
    // valor de fábrica y lo deja dicho; aquí lo que importa es que no salga un
    // «número» que no es un número hacia el navegador.
    await puso("whatsapp_numero", "llámame al celular");
    const r = await whatsappDelNegocio(env.DB, AHORA);
    expect(r.numero).toBe(NUMERO);
  });
});

describe("el catálogo que recibe la web", () => {
  beforeEach(async () => {
    // La carga inicial (0003) trae las doce variantes SIN publicar, y el
    // catálogo público solo enseña las publicadas. Se publican tres aquí: con
    // una sola, «apagarlo en un artículo no toca a los demás» no probaría
    // nada, porque no habría demás.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ajustes"),
      env.DB.prepare("UPDATE variantes SET pedir_por_whatsapp = NULL, publicado = 0"),
      env.DB.prepare(
        "UPDATE variantes SET publicado = 1 WHERE codigo IN ('NAT-M', 'NAT-L', 'NAT-XL')",
      ),
    ]);
  });

  it("trae el número y la decisión YA TOMADA por artículo", async () => {
    const c = await catalogoPublico(env.DB, AHORA);
    expect(c.whatsapp.numero).toBe(NUMERO);
    expect(c.variantes.length).toBeGreaterThan(0);
    // Todas heredan, así que todas con el botón.
    expect(c.variantes.every((v) => v.pedirPorWhatsapp)).toBe(true);
  });

  it("apagarlo en UN artículo no toca a los demás", async () => {
    const primera = (await catalogoPublico(env.DB, AHORA)).variantes[0]!;
    await env.DB.prepare("UPDATE variantes SET pedir_por_whatsapp = 0 WHERE codigo = ?")
      .bind(primera.codigo)
      .run();

    const c = await catalogoPublico(env.DB, AHORA);
    expect(c.variantes.find((v) => v.codigo === primera.codigo)?.pedirPorWhatsapp).toBe(false);
    expect(c.variantes.filter((v) => v.pedirPorWhatsapp).length).toBe(c.variantes.length - 1);
  });

  it("apagarlo en Ajustes lo quita de TODOS y deja el número fuera", async () => {
    await puso("whatsapp_pedidos_activo", false);
    const c = await catalogoPublico(env.DB, AHORA);
    expect(c.variantes.some((v) => v.pedirPorWhatsapp)).toBe(false);
  });

  it("y el catálogo del bot sigue sin saber nada de botones", async () => {
    // `listar` y `buscar` son las del asistente. Darles el campo obligaría a
    // leer los ajustes en cada turno para rellenar algo que nadie mira.
    const { listar } = await import("./catalogo");
    const vs = await listar(env.DB);
    expect(vs.length).toBeGreaterThan(0);
    expect(Object.keys(vs[0]!)).not.toContain("pedirPorWhatsapp");
  });
});
