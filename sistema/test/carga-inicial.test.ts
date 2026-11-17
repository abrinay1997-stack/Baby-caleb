import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * La carga inicial (migración 0003), contra una D1 de verdad.
 *
 * El catálogo se generó LEYENDO las fuentes del CRM, no transcribiéndolas, que
 * es lo que evita los errores de copia. Lo que estas pruebas vigilan es lo
 * otro: que lo cargado sea coherente consigo mismo y que nadie afloje después
 * las decisiones que lo hacen seguro —todo en cero, nada publicado, el ITBMS
 * sin inventar—.
 *
 * El cruce contra el documento de la dueña NO se hace aquí: vive en
 * `auditar-verdad.ts` del CRM, que es donde está la transcripción. Copiarla
 * aquí crearía la segunda fuente de verdad que esta fase existe para quitar.
 */

describe("las bodegas", () => {
  it("son las tres del CRM, activas", async () => {
    const { results } = await env.DB.prepare(
      "SELECT nombre FROM bodegas WHERE id LIKE 'bod-%' AND activa = 1 ORDER BY id",
    ).all<{ nombre: string }>();
    expect(results.map((b) => b.nombre)).toEqual([
      "Bodega Ciudad de Panamá",
      "Bodega Panamá Oeste",
      "Bodega Ciudad de Panamá Este Línea 2",
    ]);
  });
});

/**
 * Los doce que cargó la 0003.
 *
 * Están aquí porque desde la 0020 la tabla tiene más: el espejo del CRM añadió
 * los tres Velvee y los wipes Nateen, que el CRM vendía y el sistema no
 * conocía. Sin esta lista, cada prueba de abajo mediría «la tabla» y no «la
 * carga inicial», y entonces dejaría de vigilar lo que dice que vigila: sus
 * números subirían con cada producto nuevo y alguien los subiría sin mirar.
 */
const DOCE = [
  "DANY-AW1200", "DANY-AW600", "MOON-FUL",
  "NAT-L", "NAT-M", "NAT-P-L", "NAT-P-XL", "NAT-P-XXL",
  "NAT-RN", "NAT-S", "NAT-XL", "NAT-XXL",
] as const;
const EN_DOCE = `codigo IN (${DOCE.map((c) => `'${c}'`).join(", ")})`;

describe("el catálogo", () => {
  it("trae los doce artículos del documento", async () => {
    const n = await env.DB.prepare(
      `SELECT COUNT(*) n FROM variantes WHERE ${EN_DOCE}`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(12);
    // Y que estén los doce no basta: si la 0003 cargara trece, el conteo de
    // arriba seguiría dando doce con uno de más fuera de la lista. Los nombres
    // tienen que ser exactamente éstos.
    const { results } = await env.DB.prepare(
      "SELECT codigo FROM variantes WHERE codigo NOT LIKE 'VELVEE-%' AND codigo <> 'WIPESNAT' ORDER BY codigo",
    ).all<{ codigo: string }>();
    expect(results.map((v) => v.codigo)).toEqual([...DOCE].sort());
  });

  it("NO trae lo descatalogado", async () => {
    // El documento: «Por el momento únicamente nos mantendremos con las
    // toallitas húmedas de Dany Baby». Si NAT-WIP reaparece, el bot volvería a
    // ofrecer algo que ya no se vende.
    const hay = await env.DB.prepare("SELECT COUNT(*) n FROM variantes WHERE codigo = 'NAT-WIP'")
      .first<{ n: number }>();
    expect(hay?.n).toBe(0);
  });

  it("todo entra SIN PUBLICAR", async () => {
    // Mientras `publicado` sea 0, la web y el bot no lo ofrecen. Es lo que
    // permite cargar el catálogo sin que a medias se vea desde fuera.
    const n = await env.DB.prepare(
      `SELECT COUNT(*) n FROM variantes WHERE publicado = 1 AND ${EN_DOCE}`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("y TODO en cero: ninguna existencia inventada", async () => {
    // Inventar un número aquí sería exactamente lo que este sistema existe
    // para no volver a hacer. Las existencias entran con un conteo de verdad.
    const n = await env.DB.prepare(
      "SELECT COUNT(*) n FROM existencias WHERE fisico <> 0 OR reservado <> 0",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("con su fila de existencias en cada bodega", async () => {
    // Tiene que existir aunque esté en cero: `movimientos_inventario` lleva
    // llave foránea a (codigo, bodega_id) y sin ella no se puede registrar ni
    // la primera entrada.
    //
    // Se mide como «a nadie le falta ninguna», no como «hay 36 filas»: el
    // número hay que subirlo con cada producto nuevo, y un número que se sube
    // sin mirar deja de ser un control. Así la regla vale para los doce, para
    // los dieciséis de hoy y para los que vengan.
    const sinFila = await env.DB.prepare(
      `SELECT COUNT(*) n FROM variantes v, bodegas b
        WHERE NOT EXISTS (
          SELECT 1 FROM existencias e WHERE e.codigo = v.codigo AND e.bodega_id = b.id
        )`,
    ).first<{ n: number }>();
    expect(sinFila?.n).toBe(0);
  });

  it("el ITBMS queda PENDIENTE, no en cero", async () => {
    // Cero es una respuesta; NULL es «todavía no se sabe» (pregunta P4). Con
    // NULL, `precios.ts` se niega a calcular en vez de inventar un impuesto:
    // el precio sale mal y ruidoso, no mal y callado.
    const n = await env.DB.prepare(
      `SELECT COUNT(*) n FROM variantes WHERE tasa_itbms_bp IS NOT NULL AND ${EN_DOCE}`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("ningún precio es cero ni negativo", async () => {
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM variantes WHERE precio_cents <= 0")
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("el costo NO viene cargado: no es un dato que la dueña haya dado", async () => {
    // El costo vive solo en `valor_inventario` y entra con las compras. Ponerlo
    // aquí sería inventar el margen del negocio.
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM valor_inventario").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("cada variante cuelga de un producto que existe", async () => {
    const huerfanas = await env.DB.prepare(
      "SELECT COUNT(*) n FROM variantes v LEFT JOIN productos p ON p.id = v.producto_id WHERE p.id IS NULL",
    ).first<{ n: number }>();
    expect(huerfanas?.n).toBe(0);
  });

  it("los slugs de producto no se repiten", async () => {
    // Van en la URL de la web (/productos/:slug): dos iguales y una ficha tapa
    // a la otra.
    const r = await env.DB.prepare(
      "SELECT COUNT(*) total, COUNT(DISTINCT slug) distintos FROM productos",
    ).first<{ total: number; distintos: number }>();
    expect(r?.distintos).toBe(r?.total);
  });
});

describe("la cadena de tallas", () => {
  it("cada «siguiente» apunta a una variante que existe", async () => {
    const rotas = await env.DB.prepare(
      `SELECT v.codigo FROM variantes v
       WHERE v.siguiente_codigo IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM variantes x WHERE x.codigo = v.siguiente_codigo)`,
    ).all<{ codigo: string }>();
    expect(rotas.results).toEqual([]);
  });

  it("lo que NO tiene tallas no encadena nada", async () => {
    // «La siguiente» es la talla de después. Las toallitas y el fular no
    // tienen tallas: encadenar la caja de 1.200 con la de 600 haría que la
    // recompra le ofreciera a la clienta MENOS de lo que ya compraba.
    //
    // Esta prueba nació de ese error: la de abajo solo compara pesos, así que
    // se saltaba justo las filas que no los tienen.
    const { results } = await env.DB.prepare(
      `SELECT codigo FROM variantes
       WHERE siguiente_codigo IS NOT NULL AND (talla IS NULL OR peso_min_lb IS NULL)`,
    ).all<{ codigo: string }>();
    expect(results.map((v) => v.codigo)).toEqual([]);
  });

  it("sube de talla, nunca baja ni se queda igual", async () => {
    // Si NAT-L apuntara a NAT-M, la recompra le ofrecería a la clienta la
    // talla que ya se le quedó chica.
    const { results } = await env.DB.prepare(
      `SELECT v.codigo, v.peso_min_lb AS de, s.peso_min_lb AS hacia
       FROM variantes v JOIN variantes s ON s.codigo = v.siguiente_codigo
       WHERE v.peso_min_lb IS NOT NULL AND s.peso_min_lb IS NOT NULL`,
    ).all<{ codigo: string; de: number; hacia: number }>();

    expect(results.length).toBeGreaterThan(0);
    for (const f of results) {
      expect(f.hacia, `${f.codigo} no sube de talla`).toBeGreaterThan(f.de);
    }
  });

  it("no hay ciclos: la última talla no apunta a nada", async () => {
    const ultimas = await env.DB.prepare(
      "SELECT COUNT(*) n FROM variantes WHERE siguiente_codigo IS NULL",
    ).first<{ n: number }>();
    // Una por familia: pañales, pants, wipes (cada caja) y el fular.
    expect(ultimas?.n).toBeGreaterThanOrEqual(4);
  });

  it("ninguna variante es su propia siguiente", async () => {
    const n = await env.DB.prepare(
      "SELECT COUNT(*) n FROM variantes WHERE siguiente_codigo = codigo",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("las zonas de envío", () => {
  it("están las 45 del tarifario más Panamá Oeste y el interior", async () => {
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM zonas_envio").first<{ n: number }>();
    expect(n?.n).toBe(47);
  });

  it("las de la ciudad tienen tarifa; Panamá Oeste y el interior NO", async () => {
    // El documento dice «de $3 a $6 según la distancia» para Oeste, y el
    // interior lo cobra Ferguson. Inventar un punto medio es inventar un
    // precio, y eso ya falló una vez en producción.
    const sinTarifa = await env.DB.prepare(
      "SELECT nombre FROM zonas_envio WHERE tarifa_cents IS NULL ORDER BY nombre",
    ).all<{ nombre: string }>();
    expect(sinTarifa.results.map((z) => z.nombre)).toEqual([
      "Interior (por Ferguson)",
      "Panamá Oeste",
    ]);
  });

  it("ninguna tarifa de la ciudad es cero", async () => {
    const n = await env.DB.prepare(
      "SELECT COUNT(*) n FROM zonas_envio WHERE tarifa_cents IS NOT NULL AND tarifa_cents <= 0",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("el interior se paga completo antes de salir", async () => {
    // La caja sale de la ciudad y ya no vuelve: cobrar después no es una
    // opción que el negocio tenga.
    const z = await env.DB.prepare(
      "SELECT requiere_pago_total, metodo FROM zonas_envio WHERE id = 'zon-interior'",
    ).first<{ requiere_pago_total: number; metodo: string }>();
    expect(z?.requiere_pago_total).toBe(1);
    expect(z?.metodo).toBe("ferguson");
  });

  it("los alias son listas JSON legibles", async () => {
    const { results } = await env.DB.prepare("SELECT nombre, alias_json FROM zonas_envio").all<{
      nombre: string;
      alias_json: string;
    }>();
    for (const z of results) {
      const leido: unknown = JSON.parse(z.alias_json);
      expect(Array.isArray(leido), `${z.nombre} no tiene una lista de alias`).toBe(true);
    }
  });

  it("un alias no se repite en dos zonas", async () => {
    // Dos zonas con el mismo alias es una tarifa que depende del orden de la
    // consulta: la clienta paga $4 o $7 según qué fila salga primero.
    const { results } = await env.DB.prepare("SELECT nombre, alias_json FROM zonas_envio").all<{
      nombre: string;
      alias_json: string;
    }>();
    const visto = new Map<string, string>();
    for (const z of results) {
      for (const a of JSON.parse(z.alias_json) as string[]) {
        const clave = a.toLowerCase();
        expect(visto.has(clave), `«${a}» está en ${visto.get(clave)} y en ${z.nombre}`).toBe(false);
        visto.set(clave, z.nombre);
      }
    }
  });

  it("ningún alias repite el nombre de otra zona", async () => {
    const { results } = await env.DB.prepare("SELECT nombre, alias_json FROM zonas_envio").all<{
      nombre: string;
      alias_json: string;
    }>();
    const nombres = new Map(results.map((z) => [z.nombre.toLowerCase(), z.nombre]));
    for (const z of results) {
      for (const a of JSON.parse(z.alias_json) as string[]) {
        const choca = nombres.get(a.toLowerCase());
        expect(
          choca === undefined || choca === z.nombre,
          `«${a}» es alias de ${z.nombre} y nombre de ${choca}`,
        ).toBe(true);
      }
    }
  });

  it("cada zona apunta a una bodega que existe", async () => {
    const rotas = await env.DB.prepare(
      `SELECT z.nombre FROM zonas_envio z
       WHERE z.bodega_preferida_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM bodegas b WHERE b.id = z.bodega_preferida_id)`,
    ).all<{ nombre: string }>();
    expect(rotas.results).toEqual([]);
  });

  it("Panamá Oeste despacha desde la bodega de Panamá Oeste", async () => {
    // No es un detalle: mandar un motorizado desde la ciudad a Arraiján por
    // algo que está en la bodega de al lado cuesta el doble.
    const z = await env.DB.prepare(
      "SELECT b.nombre FROM zonas_envio z JOIN bodegas b ON b.id = z.bodega_preferida_id WHERE z.id = 'zon-oeste'",
    ).first<{ nombre: string }>();
    expect(z?.nombre).toBe("Bodega Panamá Oeste");
  });
});
