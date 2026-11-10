import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  barrer,
  claveDe,
  enunciadosParaBorrar,
  GRACIA_MS,
  huerfanos,
  leerPublico,
  marcarParaBorrar,
  recuperar,
  rotas,
  subir,
  type ContextoArchivo,
} from "../src/db/archivos";

/**
 * Que al borrar no quede basura (F4.18).
 *
 * Esto es lo que pidió el dueño del negocio con estas palabras: «que cuando se
 * eliminan el sistema quede limpio, que no queden archivos corruptos o
 * fantasmas o multimedia dentro de Cloudflare llenándoles de basura».
 *
 * Son DOS basuras distintas y las pruebas de aquí persiguen las dos:
 *
 *   - el archivo en R2 sin fila que lo explique (nadie sabe qué es, y se paga
 *     todos los meses);
 *   - la fila sin archivo (la foto rota en la web).
 *
 * El caso que más importa no es el feliz: es el que se CAE EN MEDIO. Entre
 * escribir en D1 y escribir en R2 no hay transacción posible, así que lo único
 * que queda es ordenar las dos escrituras de modo que una interrupción deje un
 * estado que el barrido sepa limpiar. Casi todas las pruebas de abajo cortan la
 * operación a propósito en un punto distinto.
 */

let n = 0;
const clave = () => `prueba/x/${Date.now()}-${n++}.webp`;
const cuerpo = (texto = "foto") => new TextEncoder().encode(texto).buffer as ArrayBuffer;

const ctxEn = (ahora: number, r2: R2Bucket = env.PRIVADO): ContextoArchivo => ({
  db: env.DB,
  r2,
  ahora,
  actor: "yarielis",
});

let ctx: ContextoArchivo;
beforeEach(() => {
  ctx = ctxEn(Date.now());
});

const fila = (k: string) =>
  env.DB.prepare("SELECT r2_key, borrar_despues_de, bytes FROM archivos WHERE r2_key = ?")
    .bind(k)
    .first<{ r2_key: string; borrar_despues_de: number | null; bytes: number }>();

/** Un R2 que falla donde se le diga, para cortar la operación en medio. */
const r2Roto = (donde: "put" | "delete"): R2Bucket =>
  new Proxy(env.PRIVADO, {
    get(destino, prop, recibidor) {
      if (prop === donde) {
        return () => Promise.reject(new Error(`R2 ${String(donde)} falló a propósito`));
      }
      return Reflect.get(destino, prop, recibidor);
    },
  }) as R2Bucket;

describe("subir", () => {
  it("deja el archivo en R2 y su fila confirmada", async () => {
    const k = clave();
    const r = await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });

    expect(r.ok).toBe(true);
    const o = await env.PRIVADO.get(k);
    expect(o, "el archivo tiene que estar en R2").not.toBeNull();
    expect(await o!.text()).toBe("foto");
    // Sin marca: confirmado. Si quedara marcada, el barrido borraría una foto
    // que sí se subió bien.
    expect((await fila(k))?.borrar_despues_de).toBeNull();
  });

  it("si R2 falla, la fila queda marcada y el barrido la limpia — no queda nada", async () => {
    const k = clave();
    const r = await subir(ctxEn(ctx.ahora, r2Roto("put")), k, cuerpo(), {
      tipo: "catalogo",
      mime: "image/webp",
      bytes: 4,
    });

    expect(r.ok).toBe(false);
    // La fila existe y está MARCADA. Es el punto del orden: la fila va primero
    // justo para que esta interrupción deje un rastro que el barrido sepa
    // limpiar. Al revés (R2 primero) no habría fila ninguna y el archivo —si
    // hubiera llegado— sería un huérfano para siempre.
    const f = await fila(k);
    // Explícito a propósito: `expect(f?.borrar_despues_de).not.toBeNull()` a
    // secas pasaría con `f` nulo, que es justo el caso que esta prueba existe
    // para descartar.
    expect(f, "la fila tiene que existir").not.toBeNull();
    expect(f!.borrar_despues_de, "y tiene que estar marcada").not.toBeNull();

    const b = await barrer(ctxEn(f!.borrar_despues_de! + 1));
    expect(b.ok && b.datos.borrados).toBeGreaterThanOrEqual(1);
    expect(await fila(k), "no tiene que quedar fila").toBeNull();
    expect(await env.PRIVADO.head(k), "no tiene que quedar archivo").toBeNull();
  });

  it("rechaza un tamaño que no coincide, sin escribir en ningún lado", async () => {
    const k = clave();
    const r = await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 999 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("entrada_invalida");
    expect(await fila(k)).toBeNull();
    expect(await env.PRIVADO.head(k)).toBeNull();
  });

  it("rechaza un archivo vacío", async () => {
    const r = await subir(ctx, clave(), new ArrayBuffer(0), {
      tipo: "catalogo",
      mime: "image/webp",
      bytes: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("no pisa una clave que ya existe", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo("primera"), { tipo: "catalogo", mime: "image/webp", bytes: 7 });
    const r = await subir(ctx, k, cuerpo("segunda"), { tipo: "catalogo", mime: "image/webp", bytes: 7 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("repetido");
    // Y la primera sigue intacta: un `put` ciego la habría sobrescrito.
    expect(await (await env.PRIVADO.get(k))!.text()).toBe("primera");
  });
});

describe("borrar", () => {
  it("marcar NO borra el archivo: sigue ahí durante el margen", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });

    const m = await marcarParaBorrar(ctx, k);
    expect(m.ok).toBe(true);

    // Esto es lo que da el margen para recuperarse de un borrado por error.
    expect(await env.PRIVADO.head(k), "el archivo no se toca al marcar").not.toBeNull();
    expect((await fila(k))?.borrar_despues_de).toBe(ctx.ahora + GRACIA_MS);
  });

  it("el barrido no se adelanta al margen", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);

    const b = await barrer(ctxEn(ctx.ahora + GRACIA_MS - 1));
    expect(b.ok).toBe(true);
    expect(await env.PRIVADO.head(k), "todavía dentro del margen").not.toBeNull();
    expect(await fila(k)).not.toBeNull();
  });

  it("pasado el margen, el barrido borra las dos cosas", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);

    const b = await barrer(ctxEn(ctx.ahora + GRACIA_MS + 1));
    expect(b.ok && b.datos.fallidos).toBe(0);
    expect(await env.PRIVADO.head(k), "el archivo se fue").toBeNull();
    expect(await fila(k), "la fila se fue").toBeNull();
  });

  it("recuperar dentro del margen salva la foto", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);

    expect((await recuperar(ctx, k)).ok).toBe(true);
    await barrer(ctxEn(ctx.ahora + GRACIA_MS + 1));
    expect(await env.PRIVADO.head(k), "ya no estaba marcada").not.toBeNull();
  });

  it("recuperar no inventa nada: sobre algo que no estaba marcado, falla", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    const r = await recuperar(ctx, k);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });

  it("marcar algo que no existe no finge que sí", async () => {
    const r = await marcarParaBorrar(ctx, "prueba/no/existe.webp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("no_encontrado");
  });
});

describe("el barrido aguanta que R2 falle", () => {
  it("si el borrado de R2 falla, la fila se queda marcada para reintentar", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);

    const despues = ctx.ahora + GRACIA_MS + 1;
    const b = await barrer(ctxEn(despues, r2Roto("delete")));
    expect(b.ok && b.datos.fallidos).toBeGreaterThanOrEqual(1);
    expect(b.ok && b.datos.borrados).toBe(0);

    // La fila SIGUE marcada. Si se hubiera borrado primero la fila, el archivo
    // quedaría en R2 sin nada que lo recuerde: basura permanente.
    expect((await fila(k))?.borrar_despues_de).not.toBeNull();

    // Y el reintento con R2 sano termina el trabajo.
    const b2 = await barrer(ctxEn(despues));
    expect(b2.ok && b2.datos.fallidos).toBe(0);
    expect(await fila(k)).toBeNull();
    expect(await env.PRIVADO.head(k)).toBeNull();
  });

  it("una fila marcada cuyo archivo ya no está se limpia igual", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);
    await env.PRIVADO.delete(k); // alguien lo borró por fuera

    const b = await barrer(ctxEn(ctx.ahora + GRACIA_MS + 1));
    expect(b.ok && b.datos.fallidos).toBe(0);
    // Si un `delete` de una clave ausente fallara, esta fila se quedaría
    // marcada para siempre y el barrido la reintentaría cada cinco minutos.
    expect(await fila(k), "la fila se limpia aunque el archivo ya no esté").toBeNull();
  });

  it("el tope corta el trabajo sin perderlo", async () => {
    const claves = [clave(), clave(), clave()];
    for (const k of claves) {
      await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
      await marcarParaBorrar(ctx, k);
    }

    const despues = ctx.ahora + GRACIA_MS + 1;
    const b = await barrer(ctxEn(despues), 2);
    expect(b.ok && b.datos.borrados).toBe(2);

    // Lo que no entró entra en el siguiente barrido: nada se queda colgado.
    const b2 = await barrer(ctxEn(despues), 2);
    expect(b2.ok).toBe(true);
    for (const k of claves) expect(await fila(k)).toBeNull();
  });
});

describe("la marca entra con lo que la provoca, o no entra", () => {
  it("si el batch se cae, la foto NO queda marcada", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });

    // Un batch con la marca y, detrás, un control imposible — que es como se
    // cae de verdad un batch en este sistema.
    await expect(
      env.DB.batch([
        ...enunciadosParaBorrar(ctx, [k]),
        env.DB.prepare("INSERT INTO controles (id,regla,ok,creado_en) VALUES (?,?,0,?)").bind(
          `ctl-${n++}`,
          "imposible",
          ctx.ahora,
        ),
      ]),
    ).rejects.toThrow();

    // Esto es por lo que `enunciadosParaBorrar` devuelve enunciados en vez de
    // ejecutarlos: si el producto no se borra, su foto tampoco se marca. Con
    // dos escrituras separadas, la foto se habría quedado condenada a morir en
    // 24 horas aunque el producto siguiera vivo.
    expect((await fila(k))?.borrar_despues_de, "la marca no tiene que haber entrado").toBeNull();
  });

  it("no vuelve a marcar lo que ya estaba marcado: no alarga el plazo", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);
    const plazo = (await fila(k))!.borrar_despues_de;

    await env.DB.batch(enunciadosParaBorrar(ctxEn(ctx.ahora + 60_000), [k]));

    // `WHERE borrar_despues_de IS NULL`: una segunda marca no empuja la fecha
    // hacia adelante. Si lo hiciera, marcar en bucle mantendría un archivo vivo
    // sin que nadie lo decidiera.
    expect((await fila(k))!.borrar_despues_de).toBe(plazo);
  });
});

describe("encontrar la basura que ya hubiera", () => {
  it("reporta el archivo sin fila, y no el que sí la tiene", async () => {
    const prefijo = `huerfanos-${Date.now()}-${n++}`;
    const suelto = `${prefijo}/suelto.webp`;
    const conFila = `${prefijo}/con-fila.webp`;

    await env.PRIVADO.put(suelto, cuerpo("suelto")); // a R2 sin pasar por D1
    await subir(ctx, conFila, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });

    const r = await huerfanos(ctx, `${prefijo}/`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.claves).toEqual([suelto]);
      expect(r.datos.bytes).toBe(6);
    }
  });

  it("no reporta nada cuando todo está en orden", async () => {
    const prefijo = `limpio-${Date.now()}-${n++}`;
    await subir(ctx, `${prefijo}/a.webp`, cuerpo(), {
      tipo: "catalogo",
      mime: "image/webp",
      bytes: 4,
    });
    const r = await huerfanos(ctx, `${prefijo}/`);
    expect(r.ok && r.datos.claves).toEqual([]);
  });

  it("reporta la fila cuyo archivo ya no está (la foto rota)", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await env.PRIVADO.delete(k);

    const r = await rotas(ctx, 500);
    expect(r.ok && r.datos.claves).toContain(k);
  });

  it("no cuenta como rota una fila que solo está marcada para borrar", async () => {
    const k = clave();
    await subir(ctx, k, cuerpo(), { tipo: "catalogo", mime: "image/webp", bytes: 4 });
    await marcarParaBorrar(ctx, k);

    // Una marcada no es una foto rota: es una que está esperando su turno. Si
    // saliera en este informe, el informe se llenaría de ruido justo cuando
    // alguien borra un producto y dejaría de servir para ver lo que importa.
    const r = await rotas(ctx, 500);
    expect(r.ok && r.datos.claves).not.toContain(k);
  });
});

describe("las claves", () => {
  it("agrupa por tipo y referencia, con el tiempo delante", () => {
    const k = claveDe("catalogo", "NAT-M", "webp", 1_700_000_000_000);
    expect(k).toMatch(/^catalogo\/NAT-M\/[0-9A-HJKMNP-TV-Z]{26}\.webp$/);
  });

  it("no deja que una referencia inventada escape de su carpeta", () => {
    // `../` en una clave de R2 no es un directorio de verdad, pero sí haría que
    // el prefijo dejara de agrupar lo que dice agrupar, y un listado por
    // `catalogo/` se dejaría archivos fuera.
    const k = claveDe("catalogo", "../../secreto", "webp", 1_700_000_000_000);
    expect(k).not.toContain("..");
    expect(k.startsWith("catalogo/")).toBe(true);
  });

  it("normaliza la extensión en vez de confiar en ella", () => {
    expect(claveDe("catalogo", "A", ".WEBP", 1)).toMatch(/\.webp$/);
  });
});

const ahora = () => Date.now();

describe("servir en abierto: la frontera entre una foto y un comprobante", () => {
  /**
   * En este bucket viven las fotos del catálogo y los comprobantes de pago de
   * las clientas. Una ruta pública que no distinga pone la foto de una cédula
   * en Google. Estas pruebas son las que vigilan esa frontera.
   */
  async function guardar(sobre: Record<string, unknown> = {}): Promise<string> {
    const k = clave();
    await env.PRIVADO.put(k, cuerpo("imagen"));
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,borrar_despues_de,creado_en)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(
        k,
        (sobre["tipo"] as string) ?? "catalogo",
        (sobre["mime"] as string) ?? "image/webp",
        6,
        (sobre["sensible"] as number) ?? 0,
        "yarielis",
        (sobre["borrar_despues_de"] as number | null) ?? null,
        ahora(),
      )
      .run();
    return k;
  }

  it("una foto del catálogo sale", async () => {
    const k = await guardar();
    const r = await leerPublico(ctx, k);
    expect(r).not.toBeNull();
    expect(r?.mime).toBe("image/webp");
  });

  it("un archivo SENSIBLE no sale, aunque la clave sea correcta", async () => {
    const k = await guardar({ sensible: 1, tipo: "comprobante" });
    expect(await leerPublico(ctx, k), "un comprobante de pago NO se sirve").toBeNull();
  });

  it("lo que nadie clasificó tampoco sale", async () => {
    // La columna es 1 por defecto. Equivocarse hacia «no se ve» es
    // recuperable; hacia el otro lado es irreversible.
    const k = clave();
    await env.PRIVADO.put(k, cuerpo());
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,subido_por,creado_en)
       VALUES (?,'catalogo','image/webp',4,?,?)`,
    )
      .bind(k, "yarielis", ahora())
      .run();
    expect(await leerPublico(ctx, k)).toBeNull();
  });

  it("lo marcado para borrar deja de servirse YA, no cuando pase el barrido", async () => {
    const k = await guardar({ borrar_despues_de: ahora() + GRACIA_MS });
    expect(await leerPublico(ctx, k)).toBeNull();
    // Y el archivo todavía está en R2: lo que cambió es que no se sirve.
    expect(await env.PRIVADO.head(k)).not.toBeNull();
  });

  it("un HTML marcado como no sensible NO se sirve", async () => {
    // Servido desde aquí correría con el origen del panel. Que alguien lo
    // marque «no sensible» por error no puede bastar.
    const k = await guardar({ mime: "text/html" });
    expect(await leerPublico(ctx, k)).toBeNull();
  });

  it("un PDF tampoco, aunque sea inofensivo", async () => {
    const k = await guardar({ mime: "application/pdf" });
    expect(await leerPublico(ctx, k)).toBeNull();
  });

  it("el tipo sale de la FILA, no de lo que R2 tenga guardado", async () => {
    // El caso: alguien escribe en R2 por fuera (una migración, un arreglo a
    // mano) y deja ahí un contentType distinto del que se validó al subir. La
    // fila es el registro de lo que SE COMPROBÓ; los metadatos de R2 no los
    // comprobó nadie. Servir con el tipo de R2 es cómo un HTML sale con la
    // bendición de una imagen.
    const k = clave();
    await env.PRIVADO.put(k, cuerpo("<h1>hola</h1>"), {
      httpMetadata: { contentType: "text/html" },
    });
    await env.DB.prepare(
      `INSERT INTO archivos (r2_key,tipo,mime,bytes,sensible,subido_por,creado_en)
       VALUES (?,'catalogo','image/webp',13,0,?,?)`,
    )
      .bind(k, "yarielis", ahora())
      .run();

    const r = await leerPublico(ctx, k);
    expect(r).not.toBeNull();
    expect(r?.mime, "el tipo es el de la fila, el que se validó").toBe("image/webp");
  });

  it("una fila sin archivo en R2 no revienta: devuelve nada", async () => {
    const k = await guardar();
    await env.PRIVADO.delete(k);
    expect(await leerPublico(ctx, k)).toBeNull();
  });

  it("una clave que no existe devuelve nada", async () => {
    expect(await leerPublico(ctx, "no/existe.webp")).toBeNull();
  });
});
