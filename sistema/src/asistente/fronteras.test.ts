import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { catalogo } from "./index";
import type { Contexto, HerramientaCualquiera } from "./registro";

/**
 * Las fronteras de TODAS las herramientas, no de las que hay hoy.
 *
 * Está escrito para no envejecer: recorre el catálogo entero y ejecuta cada
 * herramienta de lectura. Una herramienta nueva que devuelva un costo, o que
 * conteste una lista vacía sin decir por qué, pone esto rojo sin que nadie
 * tenga que acordarse de venir aquí.
 *
 * Y lo primero que comprueba es que de verdad ejecutó algo. Una prueba que
 * recorre una lista y se salta todo lo que no encaja pasa en verde vigilando
 * nada; de eso hay precedente en este repo. Aquí, si una herramienta de lectura
 * no se pudo ejecutar, la prueba falla y nombra cuál.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

/** Números sembrados a propósito para reconocerlos si se escapan. */
const COSTO_UNITARIO_CENTS = 64_321;
const VALOR_INVENTARIO_CENTS = 987_654;

interface Mundo {
  codigo: string;
  bodega: string;
}

/**
 * Un artículo con costo por todos lados: costo de entrada en su movimiento y
 * costo promedio en `valor_inventario`. Si alguna herramienta lo devolviera,
 * aquí se vería.
 */
async function sembrar(): Promise<Mundo> {
  const bodega = id("b");
  const prod = id("p");
  const codigo = id("FR").toUpperCase();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(
      bodega,
      `Bodega ${bodega}`,
    ),
    env.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,orden,activo,creado_en) VALUES (?,'panal','Frontera',?,1,1,?)",
    ).bind(prod, `slug-${prod}`, ahora()),
    env.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,talla,peso_min_lb,peso_max_lb,
         unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,activo,actualizado_en)
       VALUES (?,?,'Pieza de frontera','M',8,19,12,1250,0,1,1,?)`,
    ).bind(codigo, prod, ahora()),
    env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,14,2,5)",
    ).bind(codigo, bodega),
    env.DB.prepare(
      `INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,costo_unit_cents,
         referencia_tipo,referencia_id,motivo,actor,creado_en)
       VALUES (?,?,?,14,'compra',?,'compra','co-1',NULL,'duena@babycaleb.com',?)`,
    ).bind(id("mv"), codigo, bodega, COSTO_UNITARIO_CENTS, ahora()),
    env.DB.prepare(
      "INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES (?,14,?)",
    ).bind(codigo, VALOR_INVENTARIO_CENTS),
  ]);

  return { codigo, bodega };
}

const contexto = (): Contexto => ({
  db: env.DB,
  usuario: { id: "u1", correo: "duena@babycaleb.com", rol: "duena" },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

/**
 * Las formas de argumentos que sirven para una herramienta de lectura.
 *
 * Se prueban en orden y vale la primera que el esquema acepte. Antes esto era
 * un solo `{ codigo }`, y por eso la guarda de D-20 se saltaba en silencio
 * cualquier herramienta que pidiera sus argumentos de otra manera.
 *
 * `pedido` y `clienta` entraron con las herramientas de pedidos y de dinero:
 * `ver_pedido` pide un número de pedido y `historial_de_cliente` una
 * referencia de clienta, así que ninguna de las formas de arriba les vale. Sin
 * añadirlas, esta prueba se habría puesto roja nombrándolas —que es lo que
 * está escrita para hacer— en vez de saltárselas en silencio.
 */
const formasDeLlamar = (codigo: string): unknown[] => [
  { codigo },
  { texto: codigo },
  { codigo, texto: codigo },
  {},
  { pedido: codigo },
  { clienta: codigo },
];

function argumentosPara(h: HerramientaCualquiera, codigo: string): unknown | null {
  for (const forma of formasDeLlamar(codigo)) {
    const r = h.parametros.safeParse(forma);
    if (r.success) return r.data;
  }
  return null;
}

const deLectura = (): HerramientaCualquiera[] =>
  catalogo()
    .todas()
    .filter((h) => h.nivel === "lectura");

/** Ejecuta todas las de lectura y devuelve lo que contestó cada una. */
async function ejecutarTodasDeLectura(codigo: string): Promise<Map<string, unknown>> {
  const salidas = new Map<string, unknown>();
  const sinArgumentos: string[] = [];

  for (const h of deLectura()) {
    const args = argumentosPara(h, codigo);
    if (args === null) {
      sinArgumentos.push(h.nombre);
      continue;
    }
    salidas.set(h.nombre, await h.ejecutar(contexto(), args as never));
  }

  // Si una de lectura no se pudo llamar, esta prueba dejó de vigilarla: eso se
  // dice en voz alta, no se salta.
  expect(
    sinArgumentos,
    `no se supo con qué llamar a estas herramientas de lectura, así que nadie las vigila: ${sinArgumentos.join(", ")}`,
  ).toEqual([]);

  return salidas;
}

/** `64321` dentro de `1796432100000` no es un costo: es una fecha. */
const sueltoEn = (texto: string, n: number): boolean =>
  new RegExp(`(?<!\\d)${n}(?!\\d)`).test(texto);

/** Caminos del resultado cuyo nombre o cuyo valor delata un costo. */
function dondeHayCosto(valor: unknown): string[] {
  const encontrados: string[] = [];

  const mirar = (v: unknown, camino: string): void => {
    if (typeof v === "number") {
      if (v === COSTO_UNITARIO_CENTS || v === VALOR_INVENTARIO_CENTS) {
        encontrados.push(`${camino} = ${v}`);
      }
      return;
    }
    if (typeof v === "string") {
      // El número tiene que estar SUELTO, no dentro de otro número.
      //
      // Los códigos y los identificadores de la siembra llevan la fecha en
      // milisegundos dentro, y una fecha de trece cifras puede contener por
      // casualidad las cinco del centinela. Sin los bordes, esta prueba se
      // pondría roja sola a ciertas horas y nadie entendería por qué —ya pasó
      // en este repo con el sello de tiempo del catálogo—.
      if (sueltoEn(v, COSTO_UNITARIO_CENTS) || sueltoEn(v, VALOR_INVENTARIO_CENTS)) {
        encontrados.push(`${camino} (dentro del texto)`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => mirar(x, `${camino}[${i}]`));
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const sub = camino === "" ? k : `${camino}.${k}`;
        // Por el nombre también: un costo que todavía no tiene valor sembrado
        // sigue siendo un costo, y mañana lo tendrá.
        if (/costo|margen|valor_cents|valorCents/i.test(k)) encontrados.push(`${sub} (por el nombre)`);
        mirar(x, sub);
      }
    }
  };

  mirar(valor, "");
  return encontrados;
}

describe("el costo no sale por ninguna herramienta", () => {
  it("ni por su nombre ni por su valor", async () => {
    // El costo vive en `valor_inventario` y en `movimientos_inventario`, tiene
    // su propio permiso (`costo_y_margen`) y ninguna herramienta del asistente
    // lo tiene. Una herramienta que a veces trae costo y a veces no sería una
    // forma difícil de equivocarse.
    const { codigo } = await sembrar();
    const salidas = await ejecutarTodasDeLectura(codigo);
    expect(salidas.size).toBeGreaterThan(0);

    for (const [nombre, salida] of salidas) {
      const fugas = dondeHayCosto(salida);
      expect(fugas, `«${nombre}» devuelve costo: ${fugas.join(", ")}`).toEqual([]);
    }
  });

  it("y la prueba sabe reconocerlo si un día saliera", () => {
    // El contrapeso. Sin esto, `dondeHayCosto` podría estar devolviendo siempre
    // la lista vacía y las dos pruebas pasarían vigilando nada.
    expect(dondeHayCosto({ articulos: [{ costo_unit_cents: COSTO_UNITARIO_CENTS }] })).not.toEqual(
      [],
    );
    expect(dondeHayCosto({ total: VALOR_INVENTARIO_CENTS })).not.toEqual([]);
    expect(dondeHayCosto({ resumen: `salió a ${COSTO_UNITARIO_CENTS}` })).not.toEqual([]);
    expect(dondeHayCosto({ margenCents: 1 })).not.toEqual([]);
    // Y no grita con lo que sí puede ir: el precio de venta es público.
    expect(dondeHayCosto({ precioCents: 1250, libres: 12, hay: "disponible" })).toEqual([]);
    // Ni con el centinela metido dentro de otro número, que es lo que pasa con
    // los códigos que llevan la fecha en milisegundos.
    expect(dondeHayCosto({ codigo: `FR-179${COSTO_UNITARIO_CENTS}0000-3` })).toEqual([]);
  });
});

describe("una respuesta vacía nunca se queda sin explicación", () => {
  it("toda herramienta de lectura dice POR QUÉ no encontró nada", async () => {
    // Es la regla que más le importa a un modelo: `[]` a secas se contesta como
    // «no hay», y «no hay» es distinto de «ese código no existe» y de «no se
    // sabe». Con un código inventado, ninguna puede encontrar nada, así que
    // todas tienen que explicarse.
    const inexistente = id("NO-EXISTE").toUpperCase();

    for (const h of deLectura()) {
      const args = argumentosPara(h, inexistente);
      expect(args, `no se supo con qué llamar a «${h.nombre}»`).not.toBeNull();

      const salida = (await h.ejecutar(contexto(), args as never)) as Record<string, unknown>;
      expect(
        salida["aviso"],
        `«${h.nombre}» contestó sin encontrar nada y sin decir por qué`,
      ).toEqual(expect.any(String));
    }
  });

  it("y el aviso se calla cuando no hay nada que explicar", async () => {
    // El contrapeso: si `aviso` llevara texto siempre, la prueba de arriba
    // pasaría vigilando nada. Así que con el artículo delante tiene que haber
    // herramientas que no avisen.
    //
    // No se exige que TODAS callen, y es a propósito: `ver_combo` sobre un
    // artículo que no es un combo lo encuentra y aun así tiene algo que decir
    // —«esto no es un combo, pregunte con ver_stock»—, que es justo la clase de
    // respuesta que esta prueba quiere que exista.
    const { codigo } = await sembrar();
    const salidas = await ejecutarTodasDeLectura(codigo);

    const callan = [...salidas]
      .filter(([, s]) => (s as Record<string, unknown>)["aviso"] == null)
      .map(([nombre]) => nombre);
    expect(callan.length, "ninguna calla: el aviso está puesto siempre").toBeGreaterThan(0);

    // Y el que avisa habiéndolo encontrado, explica algo distinto de «no está».
    for (const [nombre, s] of salidas) {
      const aviso = (s as Record<string, unknown>)["aviso"];
      if (typeof aviso !== "string") continue;
      expect(aviso, `«${nombre}» dice que no existe un artículo que sí existe`).not.toMatch(
        /no existe/,
      );
    }
  });
});
