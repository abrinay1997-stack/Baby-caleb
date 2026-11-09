import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { catalogo } from "./index";
import {
  clienteDeReferencia,
  comoSeEscribe,
  numeroDe,
  ponerLosNombres,
  referenciaDe,
  revisar,
} from "./referencias";

/**
 * D-20: los datos de las clientas no llegan al modelo.
 *
 * El modelo del asistente es un Contributor y Meta entrena con lo que recibe
 * (comprobado en noviembre de 2026: el nivel cuesta ~$0.10/$0.20 por millón a
 * cambio de permiso para entrenar con los prompts y las respuestas). Las cifras
 * del negocio van; las clientas son terceras personas y no.
 *
 * La prueba que importa es la última: pasa TODAS las herramientas registradas
 * por la guarda. No comprueba las dos que hay hoy, comprueba la regla, y por
 * eso sigue valiendo cuando se añada la número veinte.
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

describe("cómo se escribe una referencia", () => {
  it("va con cuatro cifras como mínimo", () => {
    expect(comoSeEscribe(42)).toBe("C-0042");
    expect(comoSeEscribe(7)).toBe("C-0007");
  });

  it("y aguanta pasar de diez mil sin romperse", () => {
    // Con `C-` + 4 fijas, la clienta 12.345 habría sido «C-2345», que es la de
    // otra persona. Un negocio que crece no debería estrenar ese fallo.
    expect(comoSeEscribe(12_345)).toBe("C-12345");
    expect(numeroDe("C-12345")).toBe(12_345);
  });

  it("lo que no tiene esa forma no es una referencia", () => {
    expect(numeroDe("C-7")).toBeNull();
    expect(numeroDe("Ana")).toBeNull();
    expect(numeroDe("C-0000")).toBeNull(); // no hay clienta cero
  });
});

// La secuencia NO se reinicia entre pruebas: reiniciarla repartiría números
// que las clientas de pruebas anteriores ya tienen, y el índice único —con
// razón— lo rechazaría. En producción tampoco se reinicia nunca.
describe("dar y resolver una referencia", () => {
  async function unaClienta(nombre: string): Promise<string> {
    const c = id("c");
    await env.DB.prepare(
      "INSERT INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
    )
      .bind(c, nombre, `507${String(6000_0000 + n++)}`, ahora(), ahora())
      .run();
    return c;
  }

  it("la misma clienta recibe siempre la misma", async () => {
    const c = await unaClienta("Ana");
    const una = await referenciaDe(env.DB, c);
    const otra = await referenciaDe(env.DB, c);
    expect(una).toBe(otra);
  });

  it("dos clientas no comparten referencia", async () => {
    const a = await referenciaDe(env.DB, await unaClienta("Ana"));
    const b = await referenciaDe(env.DB, await unaClienta("Beatriz"));
    expect(a).not.toBe(b);
  });

  it("de la referencia se vuelve a la clienta", async () => {
    const c = await unaClienta("Carolina");
    const ref = await referenciaDe(env.DB, c);
    const vuelta = await clienteDeReferencia(env.DB, ref);
    expect(vuelta?.id).toBe(c);
    expect(vuelta?.nombre).toBe("Carolina");
  });

  it("el nombre se pone DESPUÉS, al mostrar", async () => {
    // Este es el orden que sostiene D-20: lo que viajó a Meta decía «C-0001».
    const c = await unaClienta("Daniela");
    const ref = await referenciaDe(env.DB, c);
    const loQueDijoElModelo = `${ref} debe $45.00 desde el martes.`;

    expect(loQueDijoElModelo).not.toContain("Daniela");
    expect(await ponerLosNombres(env.DB, loQueDijoElModelo)).toBe(
      "Daniela debe $45.00 desde el martes.",
    );
  });

  it("una referencia que no existe se queda como estaba", async () => {
    expect(await ponerLosNombres(env.DB, "C-9999 no es nadie")).toBe("C-9999 no es nadie");
  });
});

describe("la guarda: qué NO puede salir hacia el modelo", () => {
  it("caza un celular panameño en cualquiera de sus formas", () => {
    for (const v of ["50762345678", "6234-5678", "6234 5678", "62345678", "+507 6234-5678"]) {
      expect(revisar({ nota: v }), `no cazó «${v}»`).not.toEqual([]);
    }
  });

  it("caza un celular guardado como número", () => {
    // Sin esto se escapa: el patrón de texto no mira los números.
    expect(revisar({ contacto: 62345678 })[0]?.que).toBe("celular");
  });

  it("caza un correo", () => {
    expect(revisar({ nota: "escríbele a ana@gmail.com" })[0]?.que).toBe("correo");
  });

  it("caza unas coordenadas", () => {
    expect(revisar({ donde: "8.98312, -79.51987" })[0]?.que).toBe("coordenadas");
  });

  it("caza una clave prohibida aunque su valor parezca inocente", () => {
    // El valor «Casa 4» no tiene nada reconocible; lo que delata es la clave.
    expect(revisar({ direccion: "Casa 4" })[0]?.que).toBe("direccion");
  });

  it("caza el nombre de una clienta que existe", () => {
    const f = revisar({ resumen: "Ana pidió dos mantas" }, ["Ana", "Beatriz"]);
    expect(f[0]?.que).toBe("nombre_de_clienta");
  });

  it("y mira dentro de listas y objetos anidados", () => {
    const f = revisar({ pedidos: [{ cliente: { correo: "x@y.com" } }] });
    expect(f[0]?.camino).toBe("pedidos[0].cliente.correo");
  });

  it("NO grita con ocho cifras que no son un celular", () => {
    // El primer patrón cazaba ocho cifras seguidas cualesquiera y daba positivo
    // con un código de producto o una fecha. Una guarda que grita con cosas
    // inocentes acaba apagada, y entonces no guarda nada.
    for (const v of ["BC-20261109", "pedido 10045872", "ref 12345678", "20261109"]) {
      expect(revisar({ nota: v }), `gritó con «${v}»`).toEqual([]);
    }
  });

  it("pero un celular de verdad no se le escapa por eso", () => {
    // El contrapeso de la prueba anterior: afinar no puede volverla ciega.
    for (const v of ["61234567", "6999-0000", "mi celu es 6234 5678"]) {
      expect(revisar({ nota: v }), `se le escapó «${v}»`).not.toEqual([]);
    }
  });

  it("deja pasar lo que sí puede ir: cifras del negocio", () => {
    expect(
      revisar({
        articulos: [{ codigo: "BC-001-03", nombre: "Body manga larga", libres: 12, hay: "disponible" }],
        vendido_cents: 125_000,
        cliente: "C-0042",
      }),
    ).toEqual([]);
  });

  it("un nombre muy corto no se persigue", () => {
    // Con nombres de una o dos letras, cualquier palabra daría positivo y la
    // guarda se volvería ruido que alguien acabaría apagando.
    expect(revisar({ nota: "la talla M está agotada" }, ["M", "Jo"])).toEqual([]);
  });
});

describe("la guarda, aplicada a TODAS las herramientas", () => {
  it("ningún resultado que sale hacia el modelo lleva datos de una clienta", async () => {
    // Esta es la prueba que pide 06-asistente §7, y está escrita para no
    // envejecer: recorre el catálogo entero, así que una herramienta nueva que
    // devuelva un celular la pone roja sin que nadie tenga que acordarse.
    const bodega = id("b");
    const prod = id("p");
    // Código único por corrida: este runner no aísla el almacenamiento entre
    // pruebas del mismo archivo y los movimientos no se pueden borrar.
    const codigo = id("BC").toUpperCase();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)")
        .bind(bodega, `Principal ${bodega}`),
      env.DB.prepare(
        "INSERT INTO productos (id,familia,nombre,slug,orden,activo,creado_en) VALUES (?,'panal','Body',?,1,1,?)",
      ).bind(prod, `body-${prod}`, ahora()),
      env.DB.prepare(
        `INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,
           tasa_itbms_bp,publicado,activo,actualizado_en)
         VALUES (?,?,'Body manga larga','0-3m',12,1250,0,1,1,?)`,
      ).bind(codigo, prod, ahora()),
      env.DB.prepare(
        "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,14,2,5)",
      ).bind(codigo, bodega),
      env.DB.prepare(
        // Un movimiento con `actor` que ES una persona y con costo: si alguna
        // herramienta los devolviera, aquí se vería.
        `INSERT INTO movimientos_inventario (id,codigo,bodega_id,delta,tipo,costo_unit_cents,
           referencia_tipo,referencia_id,motivo,actor,creado_en)
         VALUES (?, ?, ?, 14, 'compra', 640, 'compra', 'co-1', NULL, 'ana@babycaleb.com', ?)`,
      ).bind(id("mv"), codigo, bodega, ahora()),
    ]);

    // Los nombres que hay en la base: es la única forma honesta de cazar un
    // nombre propio, que no tiene forma reconocible.
    const { results: clientas } = await env.DB.prepare(
      "SELECT nombre FROM clientes WHERE nombre IS NOT NULL",
    ).all<{ nombre: string }>();
    const nombres = clientas.map((c) => c.nombre);

    const ctx = {
      db: env.DB,
      usuario: { id: "u1", correo: "duena@babycaleb.com", rol: "duena" as const },
      canal: "panel" as const,
      conversacionId: null,
      ahora: ahora(),
    };

    const todas = catalogo().todas();
    expect(todas.length).toBeGreaterThan(0);

    for (const h of todas) {
      // Argumentos mínimos que sirvan para cualquier herramienta de lectura.
      const args = h.parametros.safeParse({ codigo });
      if (!args.success) continue;

      const salida: unknown = await h.ejecutar(ctx, args.data as never);
      const filtra = revisar(salida, nombres);
      expect(filtra, `«${h.nombre}» filtra: ${JSON.stringify(filtra)}`).toEqual([]);
    }
  });
});
