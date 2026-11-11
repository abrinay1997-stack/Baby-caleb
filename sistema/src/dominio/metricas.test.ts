import { describe, expect, it } from "vitest";
import { fechaDePanama } from "../db/entregas";
import {
  DESFASE_PANAMA_MS,
  DIA_MS,
  MINIMO_DIAS_CON_DATO,
  MINIMO_PARA_PROMEDIO,
  PERIODOS,
  comparar,
  diaDeLaSemana,
  escalaDeBarras,
  esNombrePeriodo,
  fechaPanama,
  fraccion,
  inicioDelDia,
  lunesDeLaSemana,
  mereceGrafico,
  periodoAnterior,
  periodoDe,
  promedio,
  sumarDias,
} from "./metricas";

/**
 * Lo que las cuentas del resumen NO pueden hacer.
 *
 * Una pantalla de métricas miente de cuatro formas, y hay un grupo de pruebas
 * por cada una:
 *
 *  1. Partiendo el día por la mitad (la hora de UTC en vez de la de Panamá).
 *  2. Comparando siete horas de hoy contra veinticuatro de ayer.
 *  3. Imprimiendo un porcentaje sobre cero, o un promedio de cero pedidos.
 *  4. Dibujando un eje con números que la escala no alcanza.
 *
 * Todas las pruebas de abajo se validaron por mutación: se rompió a propósito
 * la línea que vigilan y se comprobó que se ponen rojas.
 */

// 2026-11-11 es un MIÉRCOLES; 2026-11-09, el lunes de esa semana. Las fechas
// están fijas y no calculadas con `new Date()`: una prueba que se calcula su
// propia respuesta no comprueba nada.
const MIERCOLES_9_AM = Date.parse("2026-11-11T14:00:00Z"); // 9:00 a.m. en Panamá

describe("el día de Panamá", () => {
  it("no parte el día por la mitad: las 11 de la noche de aquí siguen siendo hoy", () => {
    // 2026-11-12T04:00Z son las 11 de la noche del 11 en Panamá. En UTC ya es
    // el día 12, y ahí es donde la ruta de hoy aparecería partida en dos días.
    expect(fechaPanama(Date.parse("2026-11-12T04:00:00Z"))).toBe("2026-11-11");
    expect(fechaPanama(Date.parse("2026-11-12T04:59:59Z"))).toBe("2026-11-11");
    // Y a las 5 en punto de UTC empieza el día de aquí.
    expect(fechaPanama(Date.parse("2026-11-12T05:00:00Z"))).toBe("2026-11-12");
  });

  it("dice lo mismo que `fechaDePanama` de las entregas, instante a instante", () => {
    // La regla del huso vive escrita dos veces —el dominio no puede importar de
    // `src/db/` sin dejar de ser puro— y esto es lo único que impide que se
    // separen. Se barre un día entero minuto a minuto más el cambio de año, que
    // es donde un desfase mal puesto se nota.
    for (let t = Date.parse("2026-11-11T00:00:00Z"); t < Date.parse("2026-11-12T00:00:00Z"); t += 60_000) {
      expect(fechaPanama(t), new Date(t).toISOString()).toBe(fechaDePanama(t));
    }
    for (const iso of ["2026-12-31T23:30:00Z", "2027-01-01T00:30:00Z", "2027-01-01T05:00:00Z"]) {
      expect(fechaPanama(Date.parse(iso)), iso).toBe(fechaDePanama(Date.parse(iso)));
    }
  });

  it("el desfase es de cinco horas, ni cuatro ni seis", () => {
    expect(DESFASE_PANAMA_MS).toBe(5 * 60 * 60 * 1000);
    expect(inicioDelDia("2026-11-11")).toBe(Date.parse("2026-11-11T05:00:00Z"));
  });

  it("empieza el día a las 12 de la noche de Panamá y cierra el círculo", () => {
    for (const f of ["2026-11-11", "2026-01-01", "2026-12-31", "2028-02-29"]) {
      expect(fechaPanama(inicioDelDia(f)), f).toBe(f);
      // Un milisegundo antes todavía es el día anterior: el borde está donde se
      // dice que está.
      expect(fechaPanama(inicioDelDia(f) - 1), f).toBe(sumarDias(f, -1));
    }
  });

  it("rechaza lo que no es una fecha en vez de adivinarla", () => {
    expect(() => inicioDelDia("11/11/2026")).toThrow(RangeError);
    expect(() => inicioDelDia("2026-11")).toThrow(RangeError);
    expect(() => inicioDelDia("2026-13-01")).toThrow(RangeError);
    expect(() => fechaPanama(Number.NaN)).toThrow(RangeError);
  });

  it("cuenta la semana desde el lunes", () => {
    expect(diaDeLaSemana("2026-11-09")).toBe(0); // lunes
    expect(diaDeLaSemana("2026-11-11")).toBe(2); // miércoles
    expect(diaDeLaSemana("2026-11-15")).toBe(6); // domingo
    // El domingo es el ÚLTIMO día de la semana, no el primero: su lunes es seis
    // días atrás. Con el 0 del domingo de JavaScript, esto daría el 16.
    expect(lunesDeLaSemana("2026-11-15")).toBe("2026-11-09");
    expect(lunesDeLaSemana("2026-11-09")).toBe("2026-11-09");
    expect(lunesDeLaSemana("2026-11-11")).toBe("2026-11-09");
  });

  it("suma días cruzando meses, años y febreros de 29", () => {
    expect(sumarDias("2026-11-11", 1)).toBe("2026-11-12");
    expect(sumarDias("2026-10-31", 1)).toBe("2026-11-01");
    expect(sumarDias("2026-03-01", -1)).toBe("2026-02-28");
    expect(sumarDias("2026-01-01", -1)).toBe("2025-12-31");
    expect(sumarDias("2028-02-28", 1)).toBe("2028-02-29");
    expect(sumarDias("2026-11-11", -13)).toBe("2026-10-29");
    expect(sumarDias("2026-11-11", 0)).toBe("2026-11-11");
  });
});

describe("los periodos", () => {
  it("son los dos que se miran por la mañana y nada más", () => {
    expect([...PERIODOS]).toEqual(["hoy", "semana"]);
    expect(esNombrePeriodo("semana")).toBe(true);
    expect(esNombrePeriodo("mes")).toBe(false);
  });

  it("«hoy» va de las 12 de la noche de Panamá a este mismo instante", () => {
    const p = periodoDe("hoy", MIERCOLES_9_AM);
    expect(p.desdeFecha).toBe("2026-11-11");
    expect(p.hastaFecha).toBe("2026-11-11");
    expect(p.desde).toBe(Date.parse("2026-11-11T05:00:00Z"));
    // Termina AHORA y no al final del día: no hay datos del futuro, y si la
    // ventana llegara a medianoche, la comparación contra ayer compararía nueve
    // horas contra veinticuatro.
    expect(p.hasta).toBe(MIERCOLES_9_AM);
    expect(p.dias).toBe(1);
  });

  it("«semana» va del lunes a este instante, y el domingo son siete días", () => {
    const miercoles = periodoDe("semana", MIERCOLES_9_AM);
    expect(miercoles.desdeFecha).toBe("2026-11-09");
    expect(miercoles.hastaFecha).toBe("2026-11-11");
    expect(miercoles.desde).toBe(Date.parse("2026-11-09T05:00:00Z"));
    expect(miercoles.hasta).toBe(MIERCOLES_9_AM);
    expect(miercoles.dias).toBe(3);

    const domingo = periodoDe("semana", Date.parse("2026-11-15T20:00:00Z"));
    expect(domingo.desdeFecha).toBe("2026-11-09");
    expect(domingo.dias).toBe(7);

    // Y un lunes a primera hora la semana es un solo día, no la anterior.
    const lunes = periodoDe("semana", Date.parse("2026-11-09T13:00:00Z"));
    expect(lunes.desdeFecha).toBe("2026-11-09");
    expect(lunes.dias).toBe(1);
  });

  it("el periodo anterior dura EXACTAMENTE lo mismo", () => {
    for (const nombre of PERIODOS) {
      for (const ahora of [
        MIERCOLES_9_AM,
        Date.parse("2026-11-15T23:59:00Z"),
        Date.parse("2026-11-09T05:00:00Z"),
        Date.parse("2026-01-01T13:00:00Z"),
      ]) {
        const p = periodoDe(nombre, ahora);
        const a = periodoAnterior(p);
        expect(a.hasta - a.desde, `${nombre} en ${new Date(ahora).toISOString()}`).toBe(
          p.hasta - p.desde,
        );
        expect(a.hasta).toBeLessThan(p.desde);
        expect(a.dias).toBe(p.dias);
      }
    }
  });

  it("«hoy» se compara con ayer A ESTA HORA", () => {
    const a = periodoAnterior(periodoDe("hoy", MIERCOLES_9_AM));
    expect(a.desdeFecha).toBe("2026-11-10");
    expect(a.hastaFecha).toBe("2026-11-10");
    expect(a.hasta).toBe(Date.parse("2026-11-10T14:00:00Z"));
    expect(a.desde).toBe(Date.parse("2026-11-10T05:00:00Z"));
  });

  it("«semana» se compara con la semana pasada hasta el mismo día y hora", () => {
    const a = periodoAnterior(periodoDe("semana", MIERCOLES_9_AM));
    expect(a.desdeFecha).toBe("2026-11-02");
    expect(a.hastaFecha).toBe("2026-11-04");
    // Correr siete días en milisegundos cae en el mismo día de la semana porque
    // Panamá no cambia la hora. Con horario de verano, esta prueba sería la que
    // avisaría.
    expect(diaDeLaSemana(a.desdeFecha)).toBe(0);
    expect(a.hasta - a.desde).toBe(2 * DIA_MS + 9 * 60 * 60 * 1000);
  });

  it("y cruza el cambio de mes sin inventarse un día", () => {
    const p = periodoDe("semana", Date.parse("2026-11-04T18:00:00Z"));
    expect(p.desdeFecha).toBe("2026-11-02");
    const a = periodoAnterior(p);
    expect(a.desdeFecha).toBe("2026-10-26");
    expect(a.hastaFecha).toBe("2026-10-28");
  });
});

describe("comparar dos periodos", () => {
  it("de nada a algo NO es un porcentaje", () => {
    expect(comparar(5000, 0)).toEqual({ tipo: "desde_cero", diferencia: 5000 });
  });

  it("los dos en cero no se comparan: no hay base", () => {
    expect(comparar(0, 0)).toEqual({ tipo: "sin_base" });
  });

  it("de algo a nada sí es un −100 %", () => {
    expect(comparar(0, 4000)).toEqual({ tipo: "relativo", diferencia: -4000, variacionBp: -10_000 });
  });

  it("da la variación en puntos básicos enteros", () => {
    expect(comparar(11_000, 10_000)).toEqual({
      tipo: "relativo",
      diferencia: 1000,
      variacionBp: 1000,
    });
    expect(comparar(5000, 10_000)).toEqual({
      tipo: "relativo",
      diferencia: -5000,
      variacionBp: -5000,
    });
    expect(comparar(10_000, 10_000)).toEqual({
      tipo: "relativo",
      diferencia: 0,
      variacionBp: 0,
    });
  });

  it("redondea simétrico: subir un tercio y bajar un tercio dan el mismo número", () => {
    // 4 contra 3 es +33.33 %, y 2 contra 3 es −33.33 %. Con `Math.round` a secas
    // sobre el negativo, el de bajada saldría en −3333 igual, pero el medio
    // punto se iría hacia el cero; esto fija el criterio de `dinero.ts`.
    expect(comparar(4, 3)).toMatchObject({ variacionBp: 3333 });
    expect(comparar(2, 3)).toMatchObject({ variacionBp: -3333 });
    expect(comparar(3, 2)).toMatchObject({ variacionBp: 5000 });
    // Medio punto básico exacto, hacia arriba y hacia abajo.
    expect(comparar(20_001, 20_000)).toMatchObject({ variacionBp: 1 });
    expect(comparar(19_999, 20_000)).toMatchObject({ variacionBp: -1 });
  });

  it("se para en vez de devolver un signo al revés", () => {
    expect(() => comparar(-1, 10)).toThrow(RangeError);
    expect(() => comparar(10, -1)).toThrow(RangeError);
    expect(() => comparar(Number.NaN, 1)).toThrow(RangeError);
    expect(() => comparar(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("el promedio con pocos datos", () => {
  it("cero pedidos no dan un promedio de cero: no dan promedio", () => {
    expect(promedio(0, 0)).toEqual({ hay: false, porque: "todavia_no_hay_datos" });
    // Y tampoco cuando hay total sin cuenta, que sería un dato corrupto.
    expect(promedio(5000, 0)).toEqual({ hay: false, porque: "todavia_no_hay_datos" });
  });

  it("avisa de que son pocos hasta el umbral, y deja de avisar EN el umbral", () => {
    const pocos = promedio(10_000, MINIMO_PARA_PROMEDIO - 1);
    expect(pocos).toMatchObject({ hay: true });
    expect(pocos.hay && pocos.valor.pocos).toBe(true);

    const bastantes = promedio(10_000, MINIMO_PARA_PROMEDIO);
    expect(bastantes.hay && bastantes.valor.pocos).toBe(false);
  });

  it("redondea a centavo entero, sin dejar un 0.3333 en el dinero", () => {
    const p = promedio(1000, 3);
    expect(p.hay && p.valor.valor).toBe(333);
    expect(p.hay && p.valor.n).toBe(3);
    const q = promedio(2000, 3);
    expect(q.hay && q.valor.valor).toBe(667);
  });

  it("rechaza una cuenta que no es una cuenta", () => {
    expect(() => promedio(100, -1)).toThrow(RangeError);
    expect(() => promedio(100, 1.5)).toThrow(RangeError);
    expect(() => promedio(Number.NaN, 2)).toThrow(RangeError);
  });
});

describe("la escala de un gráfico", () => {
  it("sin nada que dibujar no inventa un eje", () => {
    expect(escalaDeBarras([])).toEqual({ maximo: 0, marcas: [] });
    expect(escalaDeBarras([0, 0, 0, 0])).toEqual({ maximo: 0, marcas: [] });
  });

  it("cubre el dato más alto y reparte marcas enteras hasta el borde", () => {
    // 2 intervalos = 3 marcas: suelo, mitad y techo.
    expect(escalaDeBarras([900, 1700, 300])).toEqual({ maximo: 2000, marcas: [0, 1000, 2000] });
    expect(escalaDeBarras([1, 0])).toEqual({ maximo: 2, marcas: [0, 1, 2] });
    expect(escalaDeBarras([12_000], 4)).toEqual({
      maximo: 20_000,
      marcas: [0, 5000, 10_000, 15_000, 20_000],
    });
    // El paso del DOBLE. Sin él, el eje más cercano a un 3 sería el 10 —tres
    // veces más alto que el dato— y las barras quedarían pegadas al suelo bajo
    // un eje que promete decenas. Lo destapó una mutación: quitar esta rama no
    // rompía ninguna prueba porque la cota de abajo era diez veces el dato.
    expect(escalaDeBarras([3])).toEqual({ maximo: 4, marcas: [0, 2, 4] });
    expect(escalaDeBarras([250, 10])).toEqual({ maximo: 400, marcas: [0, 200, 400] });
    expect(escalaDeBarras([5600], 4)).toEqual({
      maximo: 8000,
      marcas: [0, 2000, 4000, 6000, 8000],
    });
  });

  it("y lo cumple para cualquier dato: nunca corta una barra ni promete de más", () => {
    // La propiedad, no un caso: el techo cubre el máximo, las marcas son
    // enteras, van de 0 al techo y están repartidas por igual. Es lo que hace
    // que una etiqueta nombre un sitio real del dibujo.
    for (const intervalos of [1, 2, 3, 4, 5]) {
      for (const maximoDato of [1, 2, 3, 7, 9, 10, 11, 99, 100, 101, 250, 999, 1234, 5600, 99_999, 1_000_000]) {
        const e = escalaDeBarras([0, Math.trunc(maximoDato / 2), maximoDato], intervalos);
        const quien = `${maximoDato} en ${intervalos} intervalos`;
        expect(e.maximo, quien).toBeGreaterThanOrEqual(maximoDato);
        expect(e.marcas.length, quien).toBe(intervalos + 1);
        expect(e.marcas[0], quien).toBe(0);
        expect(e.marcas.at(-1), quien).toBe(e.maximo);
        for (const m of e.marcas) expect(Number.isSafeInteger(m), `${quien}: marca ${m}`).toBe(true);
        const paso = e.maximo / intervalos;
        e.marcas.forEach((m, i) => expect(m, `${quien}: marca ${i}`).toBe(i * paso));
        // Y no se pasa de largo. La cota es 2.5 veces el dato porque con pasos
        // de 1, 2 y 5 el peor caso es un dato que apenas pasa el 2 y se va al
        // 5. El `intervalos` del otro lado es el suelo de los enteros: con un
        // dato de 1 y cinco intervalos, el paso no puede bajar de 1 sin dejar
        // marcas con decimales. Esta cota la puso una mutación: con «diez veces
        // el dato» un eje tres veces más alto de lo necesario pasaba en verde.
        expect(e.maximo, quien).toBeLessThanOrEqual(Math.max(maximoDato * 2.5, intervalos));
      }
    }
  });

  it("rechaza lo que no se puede dibujar", () => {
    expect(() => escalaDeBarras([-1])).toThrow(RangeError);
    expect(() => escalaDeBarras([Number.NaN])).toThrow(RangeError);
    expect(() => escalaDeBarras([10], 0)).toThrow(RangeError);
    expect(() => escalaDeBarras([10], 2.5)).toThrow(RangeError);
  });

  it("coloca cada valor con la MISMA escala que dibuja las marcas", () => {
    const e = escalaDeBarras([900, 1700, 300]);
    expect(fraccion(0, e)).toBe(0);
    expect(fraccion(1000, e)).toBe(0.5);
    expect(fraccion(2000, e)).toBe(1);
    // La marca de la mitad cae en la mitad: es la comprobación de que el eje y
    // las barras salen del mismo sitio.
    expect(fraccion(e.marcas[1]!, e)).toBe(0.5);
  });

  it("revienta en vez de recortar una barra que no cabe", () => {
    const e = escalaDeBarras([100]);
    expect(() => fraccion(e.maximo + 1, e)).toThrow(RangeError);
    expect(() => fraccion(-1, e)).toThrow(RangeError);
    expect(() => fraccion(5, { maximo: 0, marcas: [] })).toThrow(RangeError);
  });

  it("no dibuja un gráfico con dos puntos", () => {
    expect(MINIMO_DIAS_CON_DATO).toBe(3);
    expect(mereceGrafico([0, 0, 0])).toBe(false);
    expect(mereceGrafico([500, 0, 0, 900])).toBe(false);
    expect(mereceGrafico([500, 0, 700, 900])).toBe(true);
    // Los ceros no cuentan como puntos: catorce días vacíos no son una serie.
    expect(mereceGrafico(Array.from({ length: 14 }, () => 0))).toBe(false);
  });
});
