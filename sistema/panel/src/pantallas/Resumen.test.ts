import { describe, expect, it } from "vitest";
import { barras, escalaDeLaSerie, pendientesDe, textoDeComparacion } from "./Resumen";
import { comparar, fraccion } from "../../../src/dominio/metricas";

/**
 * Lo que la pantalla de resumen convierte en palabras y en píxeles.
 *
 * Son las tres partes de la pantalla con lógica, y las tres son sitios donde se
 * puede mentir sin querer:
 *
 *  1. **La geometría del gráfico.** Una barra dibujada a ojo es un número
 *     falso con aspecto de dato. Aquí se comprueba que toda la altura sale de
 *     la escala y que ninguna barra se sale ni se monta encima de otra.
 *  2. **El texto de la comparación.** «+100 %» sobre cero no existe.
 *  3. **La lista de lo que hay que atender.** Que no enseñe una fila en cero y
 *     que no cuente dos veces el mismo pedido.
 *
 * Validadas por mutación.
 */

const atencion = {
  pedidosEnTotal: 0,
  porAbonar: 0,
  porAbonarVencidos: 0,
  agendadosSinDespachar: 0,
  pagosPorRevisar: 0,
  pagosEsperandoClienta: 0,
  entregasAtrasadas: 0,
  entregasFallidas: 0,
  paradasDeHoySinAsignar: 0,
  rutasDeHoySinSalir: 0,
};

describe("las barras del gráfico", () => {
  const serie = [0, 1200, 300, 4500, 0, 900, 2000];

  it("miden lo que dice la escala, no lo que parece", () => {
    const escala = escalaDeLaSerie(serie);
    const dibujo = barras(serie, escala, 100);

    // Cuatro tramos: el techo redondo más cercano a 4500 por arriba es 8000.
    expect(escala.maximo).toBe(8000);
    expect(escala.marcas).toEqual([0, 2000, 4000, 6000, 8000]);
    dibujo.forEach((b, i) => {
      // El alto es la fracción de la escala por el alto del dibujo, sin
      // atajos: es lo que amarra la barra al eje.
      expect(b.alto, `barra ${i}`).toBeCloseTo(fraccion(serie[i]!, escala) * 100, 9);
      // Y el suelo está siempre abajo: y + alto es el borde inferior.
      expect(b.y + b.alto, `barra ${i}`).toBeCloseTo(100, 9);
    });
    // Un día en cero es una barra de cero. No un mínimo visible: eso sería
    // dibujar una venta que no hubo.
    expect(dibujo[0]!.alto).toBe(0);
    // Y el día más alto no llega al techo, porque la escala redondea hacia
    // arriba: 4500 de 8000 son el 56.25 %. Que no toque el techo es correcto; lo
    // que no puede pasar es que lo toque sin ser el máximo de la escala.
    expect(dibujo[3]!.alto).toBeCloseTo(56.25, 9);
  });

  it("caben todas en el ancho y ninguna se monta sobre la siguiente", () => {
    const escala = escalaDeLaSerie(serie);
    const ancho = 70;
    const dibujo = barras(serie, escala, ancho);
    expect(dibujo).toHaveLength(serie.length);
    dibujo.forEach((b, i) => {
      expect(b.x, `barra ${i}`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.ancho, `barra ${i}`).toBeLessThanOrEqual(ancho + 1e-9);
      expect(b.ancho, `barra ${i}`).toBeGreaterThan(0);
      const siguiente = dibujo[i + 1];
      if (siguiente !== undefined) {
        expect(b.x + b.ancho, `barra ${i} contra la ${i + 1}`).toBeLessThanOrEqual(
          siguiente.x + 1e-9,
        );
      }
    });
    // Y están repartidas por igual: el hueco entre dos es siempre el mismo.
    const paso = ancho / serie.length;
    const pasos = dibujo.slice(1).map((b, i) => b.x - dibujo[i]!.x);
    for (const p of pasos) expect(p).toBeCloseTo(paso, 9);

    dibujo.forEach((b, i) => {
      // Cada barra va centrada en su tramo y deja hueco a los lados. El hueco
      // no es decoración: catorce barras pegadas se leen como un bloque y no se
      // distingue un día del siguiente. Lo pidió una mutación que las hacía
      // ocupar el tramo entero y pasaba en verde.
      expect(b.ancho, `barra ${i}`).toBeLessThan(paso);
      expect(b.x + b.ancho / 2, `barra ${i}`).toBeCloseTo((i + 0.5) * paso, 9);
    });
  });

  it("una barra que llega al tope de la escala llega al tope del dibujo", () => {
    // 2000 en cuatro tramos da una escala de 0 a 2000 exactos, así que la barra
    // más alta sí toca el techo. Es el caso que comprueba que no hay un margen
    // escondido.
    const escala = escalaDeLaSerie([2000, 500]);
    expect(escala.maximo).toBe(2000);
    const dibujo = barras([2000, 500], escala, 20);
    expect(dibujo[0]!.alto).toBe(100);
    expect(dibujo[0]!.y).toBe(0);
  });

  it("sin días no dibuja nada", () => {
    expect(barras([], { maximo: 0, marcas: [] }, 100)).toEqual([]);
  });
});

describe("el texto de la comparación", () => {
  it("de nada a algo no es un porcentaje", () => {
    expect(textoDeComparacion(comparar(5000, 0), "hoy")).toBe("No hubo nada que ayer a esta hora");
    expect(textoDeComparacion(comparar(5000, 0), "semana")).toBe(
      "No hubo nada que la semana pasada a estas alturas",
    );
  });

  it("los dos en cero no se comparan", () => {
    expect(textoDeComparacion(comparar(0, 0), "hoy")).toBe("Tampoco ayer a esta hora");
    expect(textoDeComparacion(comparar(0, 0), "semana")).toBe(
      "Tampoco la semana pasada a estas alturas",
    );
  });

  it("dice más o menos, con el porcentaje redondeado", () => {
    expect(textoDeComparacion(comparar(12_000, 10_000), "hoy")).toBe(
      "20 % más que ayer a esta hora",
    );
    expect(textoDeComparacion(comparar(8000, 10_000), "hoy")).toBe(
      "20 % menos que ayer a esta hora",
    );
    expect(textoDeComparacion(comparar(0, 4000), "hoy")).toBe("100 % menos que ayer a esta hora");
  });

  it("y no imprime un «0 % más» cuando el cambio no se ve", () => {
    expect(textoDeComparacion(comparar(10_000, 10_000), "hoy")).toBe("Igual que ayer a esta hora");
    // 10 040 contra 10 000 es +0.4 %: redondeado daría «0 % más», que es una
    // frase que no dice nada y encima suena a dato.
    expect(textoDeComparacion(comparar(10_040, 10_000), "hoy")).toBe(
      "Casi igual que ayer a esta hora",
    );
    // Y en el borde del medio punto ya se dice la cifra.
    expect(textoDeComparacion(comparar(10_050, 10_000), "hoy")).toBe(
      "1 % más que ayer a esta hora",
    );
  });
});

describe("la lista de lo que hay que atender", () => {
  it("no enseña una fila en cero", () => {
    expect(pendientesDe(atencion, 0)).toEqual([]);
  });

  it("pone primero lo que la clienta ya está notando", () => {
    const filas = pendientesDe(
      {
        ...atencion,
        porAbonar: 3,
        entregasAtrasadas: 1,
        pagosPorRevisar: 2,
        rutasDeHoySinSalir: 1,
      },
      4,
    );
    // Un mensaje que no salió y una caja que lleva un día en una moto van antes
    // que un comprobante esperando dentro de la casa.
    expect(filas.map((f) => f.clave)).toEqual([
      "avisos",
      "atrasadas",
      "cobros",
      "porAbonar",
      "rutas",
    ]);
    expect(filas[0]!.cuantos).toBe(4);
  });

  it("los pedidos por abonar van en UNA fila, no en dos que se solapan", () => {
    const sinVencer = pendientesDe({ ...atencion, porAbonar: 3 }, 0);
    expect(sinVencer).toHaveLength(1);
    expect(sinVencer[0]!.cuantos).toBe(3);
    expect(sinVencer[0]!.urgente).toBe(false);

    const conVencidos = pendientesDe({ ...atencion, porAbonar: 3, porAbonarVencidos: 2 }, 0);
    // Sigue siendo UNA fila de tres, y los vencidos se cuentan dentro. Dos
    // tarjetas —«3 por abonar» y «2 vencidos»— se leen como cinco pedidos.
    expect(conVencidos).toHaveLength(1);
    expect(conVencidos[0]!.cuantos).toBe(3);
    expect(conVencidos[0]!.urgente).toBe(true);
    expect(conVencidos[0]!.haga).toContain("2 ya pasaron su hora");
  });

  it("y lo que espera a la clienta no se marca como urgente para usted", () => {
    const filas = pendientesDe({ ...atencion, pagosEsperandoClienta: 2 }, 0);
    expect(filas[0]!.clave).toBe("esperandoClienta");
    expect(filas[0]!.urgente).toBe(false);
    expect(filas[0]!.haga).toContain("NO dependen de usted");
  });
});
