import { describe, expect, it } from "vitest";
import { fecha } from "./api";

/**
 * Una fecha no se puede poder leer de dos maneras.
 *
 * Esta prueba existe porque el panel imprimía `11/10/2026` para el 10 de
 * noviembre —mes primero, al estilo de Estados Unidos— a una dueña panameña,
 * que lo lee como «11 de octubre». Lo hacía `dateStyle: "medium"`, que parece
 * lo correcto y que con `es-PA` no lo es.
 *
 * Lo que se fija aquí no es un formato concreto, es la propiedad: **el mes va
 * con nombre**. Mientras eso se cumpla da igual cómo se ordenen los trozos,
 * porque ya no hay forma de leer la fecha al revés en ningún país.
 */
describe("las fechas del panel", () => {
  // Mediodía en Panamá, para que la hora no empuje el día a otro.
  const alMediodia = (anio: number, mes: number, dia: number): number =>
    Date.UTC(anio, mes - 1, dia, 17, 0);

  it("escriben el mes con letras, no con número", () => {
    const t = fecha(alMediodia(2026, 11, 10));
    expect(t).toContain("nov");
    // La prueba de verdad: NO empieza por el número del mes. Así se pone roja
    // si alguien vuelve a `dateStyle`, que es por donde entró el fallo.
    expect(t).not.toMatch(/^11\/10/);
    expect(t).not.toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("y el caso que más engaña: el primero de diciembre", () => {
    // Salía `12/01/2026`, que en Panamá se lee «12 de enero». Dos meses y un
    // año de diferencia, y las dos lecturas son fechas plausibles, así que
    // nada delata el error.
    const t = fecha(alMediodia(2026, 12, 1));
    expect(t).toContain("dic");
    expect(t).toContain("2026");
    expect(t).not.toContain("12/01");
  });

  it("lleva la hora, porque varias pantallas la necesitan", () => {
    // Cobros y el Resumen dicen a qué hora entró un comprobante. Quitar la
    // hora al arreglar el día habría roto eso en silencio.
    expect(fecha(alMediodia(2026, 11, 10))).toMatch(/\d{1,2}:\d{2}/);
  });

  it("y va en hora de Panamá, no en la del navegador", () => {
    // Las 2 de la madrugada UTC del día 11 son todavía las 9 de la noche del
    // día 10 en Panamá. Si esto se leyera en UTC, el panel diría que un pago
    // entró un día después de cuando entró.
    const t = fecha(Date.UTC(2026, 10, 11, 2, 0));
    expect(t).toContain("10 nov");
  });
});
