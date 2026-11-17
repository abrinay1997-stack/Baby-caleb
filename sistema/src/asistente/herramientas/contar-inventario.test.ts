import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Contexto } from "../registro";
import { contarInventario } from "./precios-y-stock";

/**
 * El conteo completo, contra una D1 de verdad.
 *
 * ## Por qué existe la herramienta
 *
 * `ajustar_stock` corrige UN artículo en UNA bodega, y un conteo de verdad son
 * decenas de renglones. Con una herramienta de a uno, la dueña toca
 * «Permitir» dieciséis veces para un solo conteo — y a la cuarta deja de leer
 * lo que permite. Peor: si se cansa en la novena, el inventario queda contado
 * a medias y nada dice cuál.
 *
 * La ruta del panel ya aceptaba muchos renglones. Por MCP no se podía, que es
 * la trampa §13: una capacidad que solo se alcanza desde una pantalla no está
 * terminada.
 *
 * ## Qué se vigila aquí
 *
 * Que el conteo sea ENTERO: o entra todo o no entra nada. Un conteo a medias
 * es peor que ninguno, porque deja el inventario mezclando dos verdades y
 * nadie sabe dónde está la costura.
 */

let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const ctx = (): Contexto => ({
  db: env.DB,
  usuario: { id: "u1", correo: "duena@babycaleb.com", rol: "duena" },
  canal: "panel",
  conversacionId: null,
  ahora: Date.now(),
});

/** Dos artículos en una bodega propia de cada prueba, para no pisar a nadie. */
async function sembrar(fisicos: readonly number[]) {
  const bodega = id("b");
  const nombreBodega = `Bodega ${bodega}`;
  const prod = id("p");
  const codigos = fisicos.map(() => id("BC").toUpperCase());

  const enunciados = [
    env.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,1)").bind(
      bodega,
      nombreBodega,
    ),
    env.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,orden,activo,creado_en) VALUES (?,'panal','Caja',?,1,1,?)",
    ).bind(prod, `slug-${prod}`, Date.now()),
  ];
  for (const [i, codigo] of codigos.entries()) {
    enunciados.push(
      env.DB.prepare(
        `INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,
           tasa_itbms_bp,publicado,activo,actualizado_en)
         VALUES (?,?,'Caja de pañales','M',12,1250,0,1,1,?)`,
      ).bind(codigo, prod, Date.now()),
      env.DB.prepare(
        "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,?,0,NULL)",
      ).bind(codigo, bodega, fisicos[i]),
    );
  }
  await env.DB.batch(enunciados);
  return { codigos, nombreBodega };
}

const fisicoDe = async (codigo: string) =>
  (
    await env.DB.prepare("SELECT fisico FROM existencias WHERE codigo = ?")
      .bind(codigo)
      .first<{ fisico: number }>()
  )?.fisico;

describe("contar_inventario", () => {
  it("corrige varios artículos en una sola pasada", async () => {
    const { codigos, nombreBodega } = await sembrar([0, 0, 0]);
    const r = await contarInventario.ejecutar(ctx(), {
      renglones: [
        { codigo: codigos[0]!, bodega: nombreBodega, contado: 8 },
        { codigo: codigos[1]!, bodega: nombreBodega, contado: 4 },
        { codigo: codigos[2]!, bodega: nombreBodega, contado: 15 },
      ],
      motivo: "carga inicial contra el catálogo del CRM",
    });

    expect(r.renglones).toBe(3);
    expect(r.movimientos).toBe(3);
    expect(await fisicoDe(codigos[0]!)).toBe(8);
    expect(await fisicoDe(codigos[1]!)).toBe(4);
    expect(await fisicoDe(codigos[2]!)).toBe(15);
  });

  it("baja lo que sobraba igual que sube lo que faltaba", async () => {
    // Un conteo corrige en los dos sentidos. El fular Moon es el caso real:
    // el sistema creía que había 20 y en el CRM había 2.
    const { codigos, nombreBodega } = await sembrar([20, 0]);
    await contarInventario.ejecutar(ctx(), {
      renglones: [
        { codigo: codigos[0]!, bodega: nombreBodega, contado: 2 },
        { codigo: codigos[1]!, bodega: nombreBodega, contado: 7 },
      ],
      motivo: "conteo del lunes",
    });
    expect(await fisicoDe(codigos[0]!)).toBe(2);
    expect(await fisicoDe(codigos[1]!)).toBe(7);
  });

  it("lo que ya cuadra no escribe nada, y lo dice con palabras", async () => {
    // Contar y que todo esté bien es el caso BUENO. Si esto devolviera un
    // error, quien lo lea creería que el conteo falló.
    const { codigos, nombreBodega } = await sembrar([6]);
    const r = await contarInventario.ejecutar(ctx(), {
      renglones: [{ codigo: codigos[0]!, bodega: nombreBodega, contado: 6 }],
      motivo: "conteo del lunes",
    });
    expect(r.movimientos).toBe(0);
    expect(r.cuadraba).toMatch(/ya coincidía/);
    expect(await fisicoDe(codigos[0]!)).toBe(6);
  });

  it("cada corrección queda en el libro, con el motivo y los dos números", async () => {
    // Un stock sin historia que lo explique es un stock en el que nadie puede
    // confiar dentro de tres meses.
    const { codigos, nombreBodega } = await sembrar([0]);
    await contarInventario.ejecutar(ctx(), {
      renglones: [{ codigo: codigos[0]!, bodega: nombreBodega, contado: 23 }],
      motivo: "catálogo vivo del CRM, 2026-11-17",
    });
    const m = await env.DB.prepare(
      "SELECT delta, tipo, motivo, actor FROM movimientos_inventario WHERE codigo = ?",
    )
      .bind(codigos[0]!)
      .first<{ delta: number; tipo: string; motivo: string; actor: string }>();
    expect(m).toMatchObject({ delta: 23, tipo: "conteo", motivo: "catálogo vivo del CRM, 2026-11-17" });
    // Y firmado por quien lo pidió, no por «sistema»: un libro sin firma no
    // sirve para preguntarle a nadie.
    expect(m?.actor).toBe("u1");
  });

  it("una bodega mal escrita NO deja el conteo a medias", async () => {
    // Lo que importa de verdad. Si los nombres se tradujeran sobre la marcha,
    // un error en el renglón tres dejaría los dos primeros ya escritos y el
    // inventario mezclando lo contado con lo anotado.
    const { codigos, nombreBodega } = await sembrar([0, 0]);
    await expect(
      contarInventario.ejecutar(ctx(), {
        renglones: [
          { codigo: codigos[0]!, bodega: nombreBodega, contado: 5 },
          { codigo: codigos[1]!, bodega: "Bodega que no existe", contado: 9 },
        ],
        motivo: "conteo del lunes",
      }),
    ).rejects.toThrow(/no existe la bodega/);

    // Ninguno de los dos se movió.
    expect(await fisicoDe(codigos[0]!)).toBe(0);
    expect(await fisicoDe(codigos[1]!)).toBe(0);
  });

  it("es sensible: la aprueba una persona, no el asistente", async () => {
    // Escribe los libros del negocio. Que sea «sensible» es lo que obliga a
    // que alguien lea el resumen y toque «Permitir» antes de que pase.
    expect(contarInventario.nivel).toBe("sensible");
    expect(contarInventario.roles).toEqual(["duena"]);
  });

  it("un conteo entero cabe: el tope es el del motor, no uno propio", async () => {
    // Dos topes distintos significan que uno rechaza lo que el otro aceptaría,
    // y el mensaje saldría del sitio equivocado.
    const forma = contarInventario.parametros.safeParse({
      renglones: Array.from({ length: 201 }, () => ({
        codigo: "X",
        bodega: "b",
        contado: 1,
      })),
      motivo: "demasiados",
    });
    expect(forma.success).toBe(false);
    const cabe = contarInventario.parametros.safeParse({
      renglones: Array.from({ length: 200 }, () => ({ codigo: "X", bodega: "b", contado: 1 })),
      motivo: "justo el tope",
    });
    expect(cabe.success).toBe(true);
  });
});
