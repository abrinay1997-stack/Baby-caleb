import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

// Prueba el Worker entero, no los módulos sueltos: que la puerta esté cerrada
// de verdad y que ninguna respuesta salga sin sus cabeceras. Las pruebas de la
// firma del JWT están en src/seguridad/access.test.ts, que puede inyectar las
// llaves; aquí lo que importa es el comportamiento por defecto.

const panel = (ruta: string) => SELF.fetch(`https://panel.babycaleb.com${ruta}`);

describe("la puerta está cerrada por defecto", () => {
  it("/api/yo responde 403 porque Access no está configurado", async () => {
    // ACCESS_EQUIPO y ACCESS_AUD están vacíos en wrangler.jsonc hasta que
    // exista la aplicación de Access. Sin ellos NO se abre: el panel no tiene
    // otra puerta detrás, al revés que D'Casa, donde Odoo tenía su propio login.
    const r = await panel("/api/yo");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({
      ok: false,
      codigo: "no_autorizado",
      mensaje: "Access: sin configurar",
    });
  });

  it("un token inventado tampoco abre", async () => {
    const r = await panel("/api/yo");
    // Da igual lo que traiga: sin configuración ni se mira el token.
    const conToken = await SELF.fetch("https://panel.babycaleb.com/api/yo", {
      headers: { "Cf-Access-Jwt-Assertion": "a.b.c" },
    });
    expect(r.status).toBe(403);
    expect(conToken.status).toBe(403);
  });
});

describe("ninguna respuesta sale sin cabeceras de seguridad", () => {
  it("ni /salud, que es pública", async () => {
    const r = await panel("/salud");
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("ni un 404", async () => {
    const r = await panel("/no-existe");
    expect(r.status).toBe(404);
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("ni un 403", async () => {
    const r = await panel("/api/yo");
    expect(r.status).toBe(403);
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("las cabeceras cambian según la superficie", () => {
  it("la cámara solo se permite en la ruta del motorizado", async () => {
    const enPanel = await panel("/salud");
    const enRuta = await SELF.fetch("https://ruta.babycaleb.com/salud");

    expect(enPanel.headers.get("Permissions-Policy")).toContain("camera=()");
    // La necesita para la foto de entrega.
    expect(enRuta.headers.get("Permissions-Policy")).toContain("camera=(self)");
  });
});

describe("HSTS", () => {
  it("está apagado, como dice la variable", async () => {
    // Se enciende cambiando HSTS a «si» en wrangler.jsonc, cuando esté
    // confirmado que todo subdominio sirve HTTPS.
    const r = await panel("/salud");
    expect(r.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

/**
 * El webhook de Telegram, probado sobre el Worker ENTERO.
 *
 * Las pruebas de `src/api/telegram-rutas.test.ts` montan la puerta sola, y eso
 * no dice si está enchufada: una puerta perfecta que `src/index.ts` no monta
 * —o que monta DETRÁS de Access— se vería exactamente igual en verde (trampa
 * nº 12). Lo que se comprueba aquí es que existe, que Telegram puede llegar
 * sin sesión de Access y que responde con sus cabeceras como todo lo demás.
 */
describe("el webhook de Telegram está montado y fuera de Access", () => {
  // El secreto sale del binding de pruebas (`vitest.config.ts`), no de una
  // copia escrita aquí: así lo que se manda en la cabecera y lo que el Worker
  // tiene configurado no pueden separarse. Y si el código leyera otra
  // variable, esto se pondría rojo en vez de pasar por casualidad.
  const SECRETO = env.TELEGRAM_WEBHOOK_SECRET ?? "";

  const entregar = (cabeceras: Record<string, string>, cuerpo: unknown) =>
    SELF.fetch("https://panel.babycaleb.com/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...cabeceras },
      body: JSON.stringify(cuerpo),
    });

  it("con el secreto correcto contesta 200, SIN pasar por Access", async () => {
    // El contraste es lo que importa: `/api/yo` contesta 403 «Access: sin
    // configurar» y esto no, porque Telegram no inicia sesión en nada. Si
    // alguna vez quedara detrás de Access, esta prueba se pone roja en vez de
    // que el bot se quede mudo en producción sin un error a la vista.
    const r = await entregar(
      { "X-Telegram-Bot-Api-Secret-Token": SECRETO },
      { update_id: 1, algo_que_no_entendemos: true },
    );

    expect(r.status).toBe(200);
    expect(await (await panel("/api/yo")).json()).toMatchObject({
      mensaje: "Access: sin configurar",
    });
  });

  it("sin el secreto, la ruta se comporta como si no existiera", async () => {
    const r = await entregar({}, { update_id: 2 });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, codigo: "no_encontrado" });
  });

  it("y con otro secreto, lo mismo", async () => {
    const r = await entregar({ "X-Telegram-Bot-Api-Secret-Token": "otro" }, { update_id: 3 });
    expect(r.status).toBe(404);
  });

  it("tampoco sale sin cabeceras de seguridad", async () => {
    const r = await entregar(
      { "X-Telegram-Bot-Api-Secret-Token": SECRETO },
      { update_id: 4 },
    );
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
  });
});

/**
 * La foto de un producto, vista DESDE EL PANEL.
 *
 * Esto no es una prueba de leer un archivo —eso ya lo cubre
 * `src/db/archivos.test.ts`— sino de que la ruta exista EN ESTE DOMINIO. Es la
 * distinción que costó el fallo: subir la foto funcionaba (201, y el archivo
 * de verdad en R2), pero `variantes.imagen` guarda una ruta relativa y el
 * `<img>` del panel la pedía a `panel.babycaleb.com`, donde no había ninguna
 * ruta `/foto/`. El servidor de estáticos contestaba con el login de Access y
 * la foto no aparecía nunca. Ninguna prueba de módulo podía ver eso: las dos
 * mitades estaban bien y lo que faltaba era el cable (trampa nº 12).
 *
 * Por eso va con `SELF`, que monta el Worker entero, y por eso se pide al
 * dominio del panel y no a otro.
 */
describe("la foto de un producto se ve desde el panel", () => {
  const T = 1_800_000_000_000;
  // Los ocho bytes de la firma de un PNG y cuatro de relleno: `tipoDeImagen`
  // pide doce para no confundir WebP con AVIF, y aquí lo que importa es que
  // sean los de una imagen de verdad.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x08, 1, 2, 3, 4]);

  async function sembrar(
    clave: string,
    opciones: { mime?: string; sensible?: 0 | 1; borrar?: number | null } = {},
  ) {
    const { mime = "image/png", sensible = 0, borrar = null } = opciones;
    await env.PRIVADO.put(clave, PNG);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO archivos
         (r2_key, tipo, mime, bytes, sensible, subido_por, referencia_tipo,
          referencia_id, borrar_despues_de, creado_en)
       VALUES (?, 'catalogo', ?, ?, ?, 'prueba@babycaleb.com', 'variante', 'ZZ-1', ?, ?)`,
    )
      .bind(clave, mime, PNG.byteLength, sensible, borrar, T)
      .run();
  }

  const foto = (clave: string) => SELF.fetch(`https://panel.babycaleb.com/foto/${clave}`);

  it("sale con sus bytes y su tipo, sin pedir sesión", async () => {
    await sembrar("catalogo/ZZ-1/una.png");
    const r = await foto("catalogo/ZZ-1/una.png");

    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
    // El contraste con `/api/yo`, que sí contesta 403: si esta ruta acabara
    // detrás de Access, el `<img>` volvería a recibir el login y la foto
    // volvería a no verse, sin un error a la vista en ningún sitio.
    expect((await panel("/api/yo")).status).toBe(403);
  });

  it("cachea para siempre, porque otra foto es otra clave", async () => {
    await sembrar("catalogo/ZZ-1/cache.png");
    const r = await foto("catalogo/ZZ-1/cache.png");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("un comprobante de pago NO sale por aquí", async () => {
    // Lo más importante de este bloque. En ese bucket viven las fotos del
    // catálogo y los comprobantes de pago de las clientas, y lo único que los
    // separa es `sensible`. Si esta prueba se pone roja, se está sirviendo el
    // comprobante de una clienta a cualquiera que adivine la clave.
    await sembrar("pago/C-0042/comprobante.png", { sensible: 1 });
    const r = await foto("pago/C-0042/comprobante.png");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("PNG");
  });

  it("una foto marcada para borrar tampoco", async () => {
    await sembrar("catalogo/ZZ-1/vieja.png", { borrar: T });
    expect((await foto("catalogo/ZZ-1/vieja.png")).status).toBe(404);
  });

  it("algo que no es una imagen tampoco, aunque no sea sensible", async () => {
    await sembrar("catalogo/ZZ-1/raro.pdf", { mime: "application/pdf" });
    expect((await foto("catalogo/ZZ-1/raro.pdf")).status).toBe(404);
  });

  it("una clave que no existe contesta lo MISMO que una prohibida", async () => {
    // A propósito: distinguirlas le diría a quien prueba claves al azar cuáles
    // existen de verdad.
    await sembrar("pago/C-0042/otro.png", { sensible: 1 });
    const prohibida = await foto("pago/C-0042/otro.png");
    const inexistente = await foto("catalogo/ZZ-1/no-esta.png");
    expect(inexistente.status).toBe(prohibida.status);
    expect(await inexistente.text()).toBe(await prohibida.text());
  });

  it("y sale con las cabeceras de seguridad como todo lo demás", async () => {
    await sembrar("catalogo/ZZ-1/segura.png");
    const r = await foto("catalogo/ZZ-1/segura.png");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
  });
});
