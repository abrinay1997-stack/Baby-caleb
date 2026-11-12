import { describe, expect, it } from "vitest";
import {
  LADO_MAXIMO,
  NO_VALE_LA_PENA_BYTES,
  hayQueConvertir,
  medidasDestino,
  pesoLegible,
  vaLeMejorConvertida,
} from "./imagen";

/**
 * Solo lo que se puede probar sin un navegador.
 *
 * La conversión de verdad necesita `canvas` y `createImageBitmap`, que dentro
 * de workerd no existen. Una prueba que los imitara probaría la imitación, así
 * que aquí se prueban las decisiones —cuánto encoger, cuándo vale la pena, qué
 * decirle a la persona— y la conversión queda cubierta por el hecho de que
 * nunca lanza: pase lo que pase devuelve el archivo original y contesta el
 * servidor, que es quien decide.
 */

describe("cuánto encoger", () => {
  it("una foto de teléfono de 4000 px baja a 1600 sin deformarse", () => {
    const r = medidasDestino(4032, 3024);
    expect(r.ancho).toBe(1600);
    // 3024 × (1600/4032) = 1200 exacto.
    expect(r.alto).toBe(1200);
    // La proporción se conserva: 4:3 sigue siendo 4:3.
    expect(r.ancho / r.alto).toBeCloseTo(4032 / 3024, 5);
  });

  it("una foto vertical se mide por su lado largo, que es el alto", () => {
    const r = medidasDestino(3024, 4032);
    expect(r.alto).toBe(1600);
    expect(r.ancho).toBe(1200);
  });

  it("una foto que ya cabe NO se agranda", () => {
    // Agrandar no añade detalle: inventa píxeles, pesa más y se ve peor.
    expect(medidasDestino(800, 600)).toEqual({ ancho: 800, alto: 600 });
    expect(medidasDestino(LADO_MAXIMO, 900)).toEqual({ ancho: LADO_MAXIMO, alto: 900 });
  });

  it("una panorámica muy larga tampoco se queda en cero de alto", () => {
    // 6000 × 20 encogido a 1600 da 5.33 de alto. Con un `floor` descuidado
    // saldría 5; con un redondeo a la baja agresivo podría salir 0, y un
    // lienzo de alto cero no dibuja nada y la foto se sube en blanco.
    const r = medidasDestino(6000, 20);
    expect(r.ancho).toBe(1600);
    expect(r.alto).toBeGreaterThanOrEqual(1);
  });

  it("y una imagen sin medidas no revienta", () => {
    expect(medidasDestino(0, 0)).toEqual({ ancho: 0, alto: 0 });
  });
});

describe("cuándo vale la pena tocarla", () => {
  it("un JPG de teléfono, siempre", () => {
    expect(hayQueConvertir("image/jpeg", 3.8 * 1024 * 1024)).toBe(true);
  });

  it("un PNG grande, también: un PNG de cámara pesa muchísimo", () => {
    expect(hayQueConvertir("image/png", 12 * 1024 * 1024)).toBe(true);
  });

  it("un WebP que ya pesa poco se deja en paz", () => {
    // Volver a convertir lo ya convertido solo pierde calidad y un segundo.
    expect(hayQueConvertir("image/webp", 120 * 1024)).toBe(false);
    expect(hayQueConvertir("image/avif", 90 * 1024)).toBe(false);
  });

  it("pero un WebP enorme sí se encoge", () => {
    // Que el formato sea bueno no quiere decir que las medidas lo sean: un
    // WebP de 4000 px sigue siendo cuatro veces más imagen de la que se ve.
    expect(hayQueConvertir("image/webp", NO_VALE_LA_PENA_BYTES + 1)).toBe(true);
  });

  it("y un HEIC se intenta, que es como se arregla la foto del iPhone", () => {
    // Safari sí sabe decodificarlo, así que dibujarlo y volver a guardarlo
    // convierte sola la foto que el servidor rechazaría. Donde no se pueda, la
    // decodificación falla y se manda el original.
    expect(hayQueConvertir("image/heic", 2 * 1024 * 1024)).toBe(true);
  });
});

describe("si sale peor, se manda el original", () => {
  it("un PNG plano que comprime mejor como PNG se queda como está", () => {
    // Pasa de verdad con capturas y logos de pocos colores.
    expect(vaLeMejorConvertida(50_000, 80_000)).toBe(false);
  });

  it("una foto de verdad siempre mejora", () => {
    expect(vaLeMejorConvertida(3_900_000, 240_000)).toBe(true);
  });

  it("y una conversión vacía no cuenta como mejora", () => {
    // Un blob de cero bytes es un fallo disfrazado de éxito: pesa menos que
    // todo, así que sin esta comprobación «ganaría» siempre y se subiría nada.
    expect(vaLeMejorConvertida(3_900_000, 0)).toBe(false);
  });
});

describe("el peso, como lo diría una persona", () => {
  it("los tres tamaños", () => {
    expect(pesoLegible(840)).toBe("840 B");
    expect(pesoLegible(240 * 1024)).toBe("240 KB");
    expect(pesoLegible(Math.round(3.8 * 1024 * 1024))).toBe("3.8 MB");
  });

  it("y el tope del servidor se lee redondo, no como 5.0000 MB", () => {
    expect(pesoLegible(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
