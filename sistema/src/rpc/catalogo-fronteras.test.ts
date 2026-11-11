import { createExecutionContext } from "cloudflare:test";
import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SistemaCRM } from "./crm";

/**
 * La cantidad exacta de inventario sale UNA VEZ por llamada, o no sale.
 *
 * `pedido` existe porque «de 30 no, de 20 sí» es la respuesta útil y no hay
 * manera de darla sin el número: lo decidió el dueño y viene del CRM. Pero esa
 * `cantidad` se aplicaba a TODA la lista, así que una sola llamada
 * —`listarCatalogo(999999)`— devolvía el número exacto de cada artículo
 * publicado. Eso ya no es un contraofrecimiento: es el inventario del negocio
 * en un solo viaje, por la puerta que se abrió para otra cosa.
 *
 * Lo que vigilan estas pruebas es el reparto: el SÍ o el NO puede ir en cada
 * artículo (dice «menos de 30» y nada más); el NÚMERO va en el artículo que
 * mejor casa con lo que se buscó, y en ninguno más.
 */

const crm = () => new SistemaCRM(createExecutionContext(), real as Env);

/** Las unidades que pone el beforeEach. Es el número que NO debe escaparse. */
const LIBRES = { "NAT-M": 20, "NAT-L": 7, "NAT-XL": 3 } as const;

beforeEach(async () => {
  // `comoDuena` no se cree el `actor` que manda el CRM: lo cruza con
  // `usuarios`. Sin esta fila, la dueña de la prueba no es nadie — y eso está
  // bien, es la frontera funcionando.
  await real.DB.prepare("DELETE FROM usuarios").run();
  await real.DB.prepare(
    `INSERT INTO usuarios (id,correo,nombre,rol,telegram_chat_id,activo,creado_en)
     VALUES ('u-duena','duena@babycaleb.com','Yarielis','duena','9999',1,?)`,
  )
    .bind(Date.now())
    .run();

  await real.DB.batch([
    real.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    real.DB.prepare("UPDATE variantes SET publicado = 0"),
    real.DB.prepare(
      "UPDATE variantes SET publicado = 1 WHERE codigo IN ('NAT-M','NAT-L','NAT-XL')",
    ),
    ...Object.entries(LIBRES).map(([codigo, n]) =>
      real.DB.prepare(
        "UPDATE existencias SET fisico = ?2 WHERE codigo = ?1 AND bodega_id = 'bod-1'",
      ).bind(codigo, n),
    ),
  ]);
});

/** Cuántos artículos de la respuesta traen la cantidad exacta. */
const conNumero = (variantes: readonly { pedido?: { maximoDisponible?: number } }[]): number =>
  variantes.filter((v) => v.pedido?.maximoDisponible !== undefined).length;

describe("listarCatalogo con una cantidad", () => {
  it("contesta el sí o el no de cada artículo", async () => {
    // La capacidad se conserva: con 10 pedidas, la M (20) alcanza y la XL (3) no.
    const r = await crm().listarCatalogo(10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const porCodigo = new Map(r.datos.map((v) => [v.codigo, v.pedido]));
    expect(porCodigo.get("NAT-M")?.alcanza).toBe(true);
    expect(porCodigo.get("NAT-XL")?.alcanza).toBe(false);
  });

  it("y el número exacto de NINGUNO", async () => {
    const r = await crm().listarCatalogo(10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(conNumero(r.datos)).toBe(0);
  });

  it("una cantidad absurda ya no devuelve el inventario entero", async () => {
    // Esta era la fuga. Con 999.999 nada alcanza, así que antes TODOS los
    // artículos salían con `maximoDisponible` = sus unidades exactas.
    const r = await crm().listarCatalogo(999_999);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(conNumero(r.datos)).toBe(0);

    // Se revisa el `pedido`, NO el JSON entero: los nombres de los pañales
    // llevan su rango de peso dentro («15–39 lbs / 7–18 kg»), así que buscar
    // «7» a pelo encuentra el nombre y no el inventario. Es el mismo tropiezo
    // que ya está anotado en crm.test.ts con el sello de tiempo.
    for (const v of r.datos) {
      expect(Object.keys(v.pedido ?? {}).sort(), v.codigo).toEqual([
        "alcanza",
        "cantidadPedida",
      ]);
    }
  });
});

describe("buscarCatalogo con una cantidad", () => {
  it("el número exacto sale UNA VEZ, en el mejor acierto", async () => {
    // «nateen» casa con las tres tallas publicadas y ninguna llega a 999.999.
    const r = await crm().buscarCatalogo("nateen", 50, 999_999);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos.length).toBeGreaterThan(1);
    expect(conNumero(r.datos)).toBe(1);
    expect(r.datos[0]?.pedido?.maximoDisponible).toBeDefined();
  });

  it("los demás aciertos se llevan el sí o el no, que no es el inventario", async () => {
    const r = await crm().buscarCatalogo("nateen", 50, 999_999);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const v of r.datos.slice(1)) {
      expect(v.pedido?.alcanza, v.codigo).toBe(false);
      expect(v.pedido?.maximoDisponible, v.codigo).toBeUndefined();
    }
  });

  it("preguntando por UN artículo, el contraofrecimiento sigue entero", async () => {
    // El contrapeso: cerrar la fuga no puede dejar inútil la única capacidad
    // por la que el número salía. «De 30 no, de 20 sí.»
    const r = await crm().buscarCatalogo("NAT-M", 10, 30);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos[0]?.codigo).toBe("NAT-M");
    expect(r.datos[0]?.pedido).toEqual({
      cantidadPedida: 30,
      alcanza: false,
      maximoDisponible: 20,
    });
  });

  it("una búsqueda vacía no es una pregunta por un artículo: no suelta ningún número", async () => {
    // Con el texto vacío —o con solo comodines, que se quedan en nada— la
    // búsqueda se comporta como la lista completa, y la lista completa no
    // suelta números.
    for (const q of ["", "%", "__"]) {
      const r = await crm().buscarCatalogo(q, 50, 999_999);
      expect(r.ok, q).toBe(true);
      if (!r.ok) continue;
      expect(conNumero(r.datos), `«${q}» soltó números`).toBe(0);
    }
  });
});

describe("stockDetallado · lo que lee la dueña no puede ser ambiguo", () => {
  it("dice lo LIBRE y la etiqueta, no solo físico y reservado", async () => {
    // Al otro lado del binding hay un modelo. «fisico: 20, reservado: 18»
    // contestado de memoria se vuelve «hay 20»; lo que se puede vender son 2.
    await real.DB.prepare(
      "UPDATE existencias SET reservado = 18 WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).run();

    const r = await crm().stockDetallado({ tipo: "duena", id: "9999", canal: "telegram" }, "NAT-M");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const bod = r.datos[0]?.porBodega.find((b) => b.fisico === 20);
    expect(bod?.libres).toBe(2);
    expect(bod?.hay).toBe("pocas");
  });

  it("y el bot no lo puede pedir", async () => {
    const r = await crm().stockDetallado({ tipo: "bot", id: "9999", canal: "whatsapp_qr" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_autorizado");
  });
});
