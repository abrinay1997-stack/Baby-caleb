import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cuantosCombos } from "../../dominio/combos";
import type { Contexto } from "../registro";
import { buscarArticulo, comoSeLeeElPeso, verCombo } from "./catalogo";
import { verStock } from "./inventario";

/**
 * Las herramientas con las que el asistente contesta una pregunta de clienta.
 *
 * Lo que se vigila aquí no es que el SQL corra: es que no se pueda entender mal
 * lo que devuelven. Un modelo contesta con lo que le das, y si le das un dato
 * ambiguo inventa el resto con total seguridad — así que cada prueba de este
 * archivo defiende una frontera concreta:
 *
 *  - el PRECIO sale de D1 y de ningún otro sitio;
 *  - la CANTIDAD exacta no sale por la herramienta con la que se le contesta a
 *    una clienta (si no la tiene, no la puede soltar);
 *  - lo que NO SE SABE llega como «no se sabe» y nunca como cero;
 *  - de un COMBO se contesta bien, que es lo que menos se parece a lo obvio.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const ctx = (): Contexto => ({
  db: env.DB,
  usuario: { id: "u1", correo: "duena@babycaleb.com", rol: "duena" },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

interface Siembra {
  nombre?: string;
  producto?: string;
  talla?: string | null;
  pesoMin?: number | null;
  pesoMax?: number | null;
  precioCents?: number;
  unidadesPorCaja?: number;
  /** `null` = no se le crea fila en `existencias` (no está dado de alta). */
  fisico?: number | null;
  reservado?: number;
  publicado?: boolean;
  activo?: boolean;
  esCombo?: boolean;
  /** Para que el código no lleve letras que ensucien una búsqueda. */
  prefijo?: string;
}

async function sembrar(o: Siembra = {}): Promise<{ codigo: string; bodega: string }> {
  const bodega = id("b");
  const prod = id("p");
  const codigo = id(o.prefijo ?? "ZZ").toUpperCase();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(
      bodega,
      `Bodega ${bodega}`,
    ),
    env.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,orden,activo,creado_en) VALUES (?,'panal',?,?,1,1,?)",
    ).bind(prod, o.producto ?? "Prueba", `slug-${prod}`, ahora()),
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,talla,peso_min_lb,peso_max_lb,
         unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,activo,es_combo,actualizado_en)
       VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    ).bind(
      codigo,
      prod,
      o.nombre ?? "Pieza de prueba",
      o.talla === undefined ? null : o.talla,
      o.pesoMin === undefined ? null : o.pesoMin,
      o.pesoMax === undefined ? null : o.pesoMax,
      o.unidadesPorCaja ?? 12,
      o.precioCents ?? 1250,
      (o.publicado ?? true) ? 1 : 0,
      (o.activo ?? true) ? 1 : 0,
      (o.esCombo ?? false) ? 1 : 0,
      ahora(),
    ),
  ]);

  const fisico = o.fisico === undefined ? 20 : o.fisico;
  if (fisico !== null) {
    await env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,?,?,NULL)",
    )
      .bind(codigo, bodega, fisico, o.reservado ?? 0)
      .run();
  }

  return { codigo, bodega };
}

/** Un combo con su receta. El componente no puede ser combo: lo prohíbe un trigger. */
async function sembrarCombo(
  receta: { libres: number | null; porCombo: number }[],
  precioCents = 9900,
): Promise<{ combo: string; componentes: string[] }> {
  const { codigo: combo } = await sembrar({
    esCombo: true,
    precioCents,
    nombre: "Canastilla de prueba",
    // Un combo no tiene fila en `existencias`: es justo lo que lo hace difícil.
    fisico: null,
  });

  const componentes: string[] = [];
  for (const r of receta) {
    const { codigo } = await sembrar({ fisico: r.libres, nombre: "Componente" });
    componentes.push(codigo);
    await env.DB.prepare(
      "INSERT INTO combo_componentes (combo_codigo,codigo,cantidad) VALUES (?,?,?)",
    )
      .bind(combo, codigo, r.porCombo)
      .run();
  }
  return { combo, componentes };
}

// ---------------------------------------------------------------------------

describe("el peso en palabras", () => {
  it("dice el rango cuando se sabe entero", () => {
    expect(comoSeLeeElPeso(8, 19)).toBe("de 8 a 19 lb");
  });

  it("con tope en NULL dice que no hay tope anotado, no «hasta 0»", () => {
    // NAT-XXL es «+55 lbs»: peso_min_lb = 55 y peso_max_lb = NULL. Un modelo
    // que recibiera un 0 ahí escribiría «hasta 0 lb» sin pestañear, y con el
    // peso de un bebé encima eso es un consejo peligroso.
    expect(comoSeLeeElPeso(55, null)).toBe("desde 55 lb, sin tope anotado");
    expect(comoSeLeeElPeso(55, null)).not.toContain("0");
  });

  it("sin nada anotado lo dice, y no se inventa un rango", () => {
    const texto = comoSeLeeElPeso(null, null);
    expect(texto).toBe("no está anotado el peso de este artículo");
    expect(texto).not.toMatch(/\d/);
  });

  it("y si solo hay tope, solo dice el tope", () => {
    expect(comoSeLeeElPeso(null, 24)).toBe("hasta 24 lb");
  });
});

describe("buscar_articulo · de lo que dice la clienta a lo que sabe la base", () => {
  it("encuentra por código", async () => {
    const { codigo } = await sembrar();
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 10 });
    expect(r.articulos.map((a) => a.codigo)).toContain(codigo);
  });

  it("encuentra por palabras del nombre", async () => {
    const palabra = id("fular").toLowerCase();
    const { codigo } = await sembrar({ nombre: `Fular prearmado ${palabra}` });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: palabra, cuantos: 10 });
    expect(r.articulos.map((a) => a.codigo)).toEqual([codigo]);
  });

  it("encuentra por nombre del PRODUCTO, no solo de la variante", async () => {
    const marca = id("nateen").toLowerCase();
    const { codigo } = await sembrar({ producto: `Panal ${marca}`, nombre: "Pieza de prueba" });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: marca, cuantos: 10 });
    expect(r.articulos.map((a) => a.codigo)).toEqual([codigo]);
  });

  it("«M» trae la talla M y NO la Unitalla", async () => {
    // La talla se compara EXACTA y el resto por parecido. Con LIKE «%m%» quien
    // pregunta por la M recibe también la «Unitalla», y una talla equivocada en
    // un pañal es una caja devuelta.
    //
    // Ni los nombres ni los códigos de esta siembra llevan la letra M, para que
    // lo único que pueda responder a la búsqueda sea la talla.
    const conM = await sembrar({ talla: "M", nombre: "Pieza roja", producto: "Prueba tallas" });
    const uni = await sembrar({ talla: "Unitalla", nombre: "Pieza azul", producto: "Prueba tallas" });

    const r = await buscarArticulo.ejecutar(ctx(), { texto: "M", cuantos: 20 });
    const codigos = r.articulos.map((a) => a.codigo);
    expect(codigos).toContain(conM.codigo);
    expect(codigos).not.toContain(uni.codigo);
  });

  it("pone primero el acierto exacto por código", async () => {
    const raiz = id("ZZEXACTO").toUpperCase();
    // El segundo CONTIENE al primero, así que los dos responden a la búsqueda.
    await sembrar({ nombre: `Pieza ${raiz} larga`, prefijo: `${raiz}X` });
    const exacto = await env.DB.prepare("SELECT codigo FROM variantes WHERE codigo LIKE ?")
      .bind(`${raiz}X%`)
      .first<{ codigo: string }>();

    const r = await buscarArticulo.ejecutar(ctx(), { texto: exacto?.codigo ?? "", cuantos: 10 });
    expect(r.articulos[0]?.codigo).toBe(exacto?.codigo);
  });

  it("devuelve el precio que está en D1, en centavos y en dólares", async () => {
    // «¿Cuánto cuesta?» es la pregunta más frecuente que existe, y hasta ahora
    // ninguna herramienta la contestaba: el modelo solo podía inventarla.
    const { codigo } = await sembrar({ precioCents: 5500 });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 10 });

    expect(r.articulos[0]?.precioCents).toBe(5500);
    // En palabras también: dividir 5500 entre 100 es una cuenta que a veces
    // sale «$550.00», y el modelo la hace en un WhatsApp.
    expect(r.articulos[0]?.precio).toBe("$55.00");
  });

  it("traduce la cantidad a disponible / pocas / agotado", async () => {
    const mucho = await sembrar({ fisico: 20 });
    const poco = await sembrar({ fisico: 3 });
    const nada = await sembrar({ fisico: 0 });

    const dime = async (codigo: string) =>
      (await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 5 })).articulos[0]?.hay;

    expect(await dime(mucho.codigo)).toBe("disponible");
    expect(await dime(poco.codigo)).toBe("pocas");
    expect(await dime(nada.codigo)).toBe("agotado");
  });

  it("descuenta lo ya comprometido: la etiqueta sale de lo LIBRE", async () => {
    // 20 en la bodega con 18 apartados son 2 para vender. Prometer 20 es
    // cancelarle la compra a alguien.
    const { codigo } = await sembrar({ fisico: 20, reservado: 18 });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 5 });
    expect(r.articulos[0]?.hay).toBe("pocas");
  });

  it("NUNCA devuelve la cantidad exacta: solo la etiqueta", async () => {
    // Esta es la frontera que da nombre al archivo. Si una herramienta devuelve
    // «quedan 37», ese número acaba en un WhatsApp y la clienta lo trata como
    // una promesa. Lo que no se tiene no se puede soltar.
    const { codigo } = await sembrar({ fisico: 37, unidadesPorCaja: 11, precioCents: 1300 });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 5 });

    expect(r.articulos[0]?.hay).toBe("disponible");
    const texto = JSON.stringify(r.articulos[0]);
    expect(texto, "se escapó la cantidad exacta").not.toContain("37");
    expect(texto).not.toMatch(/libres|fisico|reservado|comprometido/i);
  });

  it("y tampoco el costo", async () => {
    const { codigo } = await sembrar();
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 5 });
    expect(JSON.stringify(r)).not.toMatch(/costo/i);
  });

  it("dice el rango de peso, que es la pregunta de «¿hasta qué peso sirve?»", async () => {
    const { codigo } = await sembrar({ pesoMin: 15, pesoMax: 39 });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 5 });
    expect(r.articulos[0]?.peso).toBe("de 15 a 39 lb");
    expect(r.articulos[0]?.pesoDesdeLb).toBe(15);
    expect(r.articulos[0]?.pesoHastaLb).toBe(39);
  });

  it("un peso que no está anotado llega como «no se sabe», no como cero", async () => {
    const { codigo } = await sembrar({ pesoMin: null, pesoMax: null });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: codigo, cuantos: 5 });

    expect(r.articulos[0]?.peso).toBe("no está anotado el peso de este artículo");
    expect(r.articulos[0]?.pesoDesdeLb).toBeNull();
    expect(r.articulos[0]?.pesoHastaLb).toBeNull();
    // Un null el modelo lo lee como «no lo sé»; un 0 lo lee como «cero libras».
    expect(r.articulos[0]?.pesoDesdeLb).not.toBe(0);
  });

  it("dice si se vende en la web y si sigue activo", async () => {
    // Las dos cosas que impiden venderlo aunque haya existencias.
    const guardado = await sembrar({ publicado: false });
    const r = await buscarArticulo.ejecutar(ctx(), { texto: guardado.codigo, cuantos: 5 });
    expect(r.articulos[0]?.seVendeEnLaWeb).toBe(false);
    expect(r.articulos[0]?.activo).toBe(true);
  });

  it("de un combo contesta la etiqueta de lo que se puede ARMAR", async () => {
    // Un combo no tiene fila en `existencias`. Si la etiqueta saliera de ahí,
    // todos los combos estarían siempre agotados.
    const { combo } = await sembrarCombo([{ libres: 100, porCombo: 1 }]);
    const r = await buscarArticulo.ejecutar(ctx(), { texto: combo, cuantos: 5 });

    expect(r.articulos[0]?.esCombo).toBe(true);
    expect(r.articulos[0]?.hay).toBe("disponible");
  });

  it("y un combo con un componente agotado sale agotado", async () => {
    const { combo } = await sembrarCombo([
      { libres: 500, porCombo: 1 },
      { libres: 0, porCombo: 1 },
    ]);
    const r = await buscarArticulo.ejecutar(ctx(), { texto: combo, cuantos: 5 });
    expect(r.articulos[0]?.hay).toBe("agotado");
  });

  it("cuando no encuentra nada lo DICE, para que el modelo no lo describa de memoria", async () => {
    const r = await buscarArticulo.ejecutar(ctx(), { texto: "bicicleta de montana", cuantos: 5 });
    expect(r.articulos).toEqual([]);
    expect(r.aviso).toMatch(/no hay ningún artículo/);
  });

  it("no se traga los comodines de LIKE", async () => {
    // Sin quitarlos, quien escribe «%» recibe el catálogo entero como si cada
    // artículo fuera un acierto de su búsqueda.
    await sembrar();
    const r = await buscarArticulo.ejecutar(ctx(), { texto: "%", cuantos: 20 });
    expect(r.articulos).toEqual([]);
    expect(r.aviso).toMatch(/comodines/);
  });

  it("los argumentos se validan en el servidor", () => {
    // 06-asistente §6: no se cuenta con que el modelo valide nada.
    expect(buscarArticulo.parametros.safeParse({}).success).toBe(false);
    expect(buscarArticulo.parametros.safeParse({ texto: "", cuantos: 5 }).success).toBe(false);
    expect(buscarArticulo.parametros.safeParse({ texto: "m", cuantos: 10_000 }).success).toBe(false);
    expect(buscarArticulo.parametros.safeParse({ texto: "m", cuantos: 0 }).success).toBe(false);
    const r = buscarArticulo.parametros.safeParse({ texto: "m" });
    expect(r.success && r.data.cuantos).toBe(10);
  });
});

describe("ver_combo · de un combo caben tantos como permita el que menos alcance", () => {
  const casos = [
    { nombre: "manda el que menos alcanza", receta: [[10, 2], [3, 1]] },
    { nombre: "uno agotado deja todo en cero", receta: [[500, 1], [0, 1]] },
    { nombre: "no parte unidades", receta: [[7, 2]] },
    { nombre: "justo para uno", receta: [[2, 2], [3, 3]] },
    { nombre: "holgado", receta: [[100, 1], [100, 2], [100, 5]] },
  ] as const;

  for (const caso of casos) {
    it(`${caso.nombre}, y da lo mismo que la regla pura`, async () => {
      const receta = caso.receta.map(([libres, porCombo]) => ({ libres, porCombo }));
      const { combo, componentes } = await sembrarCombo(receta);

      const esperado = cuantosCombos(
        receta.map((r, i) => ({
          codigo: componentes[i]!,
          cantidad: r.porCombo,
          libres: r.libres,
        })),
      );

      const r = await verCombo.ejecutar(ctx(), { codigo: combo });
      expect(r.sePuedenArmar, `esperaba ${esperado}`).toBe(esperado);
    });
  }

  it("dice CUÁL componente lo frena, no solo que no se puede", async () => {
    // «No se puede armar» a secas obliga a ir mirando uno por uno cuál falta.
    const { combo, componentes } = await sembrarCombo([
      { libres: 100, porCombo: 1 },
      { libres: 2, porCombo: 1 },
    ]);
    const r = await verCombo.ejecutar(ctx(), { codigo: combo });
    expect(r.loQueFrena).toEqual([componentes[1]]);
  });

  it("de cada componente dice para cuántos combos alcanza, truncado", async () => {
    // 7 libres con 2 por combo son 3 combos, no 3.5. Es la cuenta en la que un
    // modelo se equivoca si se la dejas a él.
    const { combo } = await sembrarCombo([{ libres: 7, porCombo: 2 }]);
    const r = await verCombo.ejecutar(ctx(), { codigo: combo });
    expect(r.componentes?.[0]?.alcanzaPara).toBe(3);
    expect(r.sePuedenArmar).toBe(3);
  });

  it("un combo SIN receta da 0 y lo explica: cero no es «ilimitado»", async () => {
    const { combo } = await sembrarCombo([]);
    const r = await verCombo.ejecutar(ctx(), { codigo: combo });

    expect(r.sePuedenArmar).toBe(0);
    expect(r.hay).toBe("agotado");
    expect(r.aviso).toMatch(/no tiene receta/);
  });

  it("un componente sin dar de alta es «no se sabe», no cero mercancía", async () => {
    // Las dos cosas dan cero combos y se arreglan de maneras distintas: una es
    // comprar, la otra es dar de alta el artículo en una bodega. Quien lea la
    // respuesta tiene que saber cuál de las dos es.
    const { combo, componentes } = await sembrarCombo([{ libres: null, porCombo: 1 }]);
    const r = await verCombo.ejecutar(ctx(), { codigo: combo });

    expect(r.sePuedenArmar).toBe(0);
    expect(r.sinDarDeAlta).toEqual([componentes[0]]);
    expect(r.componentes?.[0]?.libres).toBeNull();
    expect(r.componentes?.[0]?.alcanzaPara).toBeNull();
    expect(r.aviso).toMatch(/no se sabe/);
  });

  it("y un componente con cero mercancía NO se confunde con uno sin dar de alta", async () => {
    // El contrapeso de la prueba anterior: si las dos dieran el mismo aviso, la
    // distinción no serviría de nada.
    const { combo } = await sembrarCombo([{ libres: 0, porCombo: 1 }]);
    const r = await verCombo.ejecutar(ctx(), { codigo: combo });

    expect(r.sePuedenArmar).toBe(0);
    expect(r.sinDarDeAlta).toEqual([]);
    expect(r.componentes?.[0]?.libres).toBe(0);
    expect(r.aviso).toBeNull();
  });

  it("de un artículo que no es combo lo dice, en vez de contestar cero", async () => {
    const { codigo } = await sembrar({ fisico: 20 });
    const r = await verCombo.ejecutar(ctx(), { codigo });

    expect(r.existe).toBe(true);
    expect(r.esCombo).toBe(false);
    expect(r.aviso).toMatch(/no es un combo/);
    // Y NO inventa un cero: un 0 aquí haría que el modelo dijera «no hay».
    expect(r).not.toHaveProperty("sePuedenArmar");
  });

  it("de un código que no existe lo dice", async () => {
    const r = await verCombo.ejecutar(ctx(), { codigo: "NO-EXISTE-NADA" });
    expect(r.existe).toBe(false);
    expect(r.aviso).toMatch(/no existe/);
  });

  it("no devuelve el costo", async () => {
    const { combo } = await sembrarCombo([{ libres: 10, porCombo: 1 }]);
    const r = await verCombo.ejecutar(ctx(), { codigo: combo });
    expect(JSON.stringify(r)).not.toMatch(/costo/i);
  });
});

describe("ver_stock · una lista vacía es tres respuestas distintas", () => {
  it("de un COMBO no dice «no hay»: dice que es un combo y a dónde ir", async () => {
    // Era la peor de las tres: un combo que SÍ se puede armar contestaba
    // `articulos: []`, y el modelo leía eso como «no hay». Venta perdida.
    const { combo } = await sembrarCombo([{ libres: 100, porCombo: 1 }]);
    const r = await verStock.ejecutar(ctx(), { codigo: combo });

    expect(r.articulos).toEqual([]);
    expect(r.aviso).toMatch(/es un combo/);
    expect(r.aviso).toMatch(/ver_combo/);
  });

  it("de un artículo sin dar de alta dice NO SE SABE, no cero", async () => {
    const { codigo } = await sembrar({ fisico: null });
    const r = await verStock.ejecutar(ctx(), { codigo });

    expect(r.articulos).toEqual([]);
    expect(r.aviso).toMatch(/NO SE SABE/);
    expect(r.aviso).toMatch(/no es lo mismo que cero/);
  });

  it("de un código que no existe dice que no existe", async () => {
    const r = await verStock.ejecutar(ctx(), { codigo: "NO-EXISTE-NADA" });
    expect(r.aviso).toMatch(/no existe/);
  });

  it("y cuando sí hay filas no avisa de nada", async () => {
    const { codigo } = await sembrar({ fisico: 5 });
    const r = await verStock.ejecutar(ctx(), { codigo });
    expect(r.articulos).toHaveLength(1);
    expect(r.aviso).toBeNull();
  });

  it("filtrando por bodega, el aviso nombra ESA bodega", async () => {
    // Si dijera «en ninguna bodega» cuando solo se preguntó por una, sería
    // mentira, y una mentira que el modelo repetiría.
    const { codigo } = await sembrar({ fisico: 5 });
    const otra = `Bodega ${id("b")}`;
    await env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)")
      .bind(id("b"), otra)
      .run();

    const r = await verStock.ejecutar(ctx(), { codigo, bodega: otra });
    expect(r.articulos).toEqual([]);
    expect(r.aviso).toContain(otra);
  });
});
