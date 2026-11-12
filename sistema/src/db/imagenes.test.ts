import { describe, expect, it } from "vitest";
import { EXTENSIONES, MAXIMO_BYTES, TIPOS_DE_IMAGEN, esFotoDeIphone, porQueNoSirveLaImagen, tipoDeImagen } from "./imagenes";

/**
 * Qué es un archivo de verdad.
 *
 * Esto existe porque el `Content-Type` lo escribe quien sube el archivo. Si se
 * guardara tal cual, alguien podría subir un HTML diciendo que es `image/webp`
 * y `leerPublico` lo serviría como imagen, porque la fila diría que lo es.
 */

/** Bytes con una cabecera concreta y relleno detrás, como un archivo real. */
function conCabecera(...partes: (number[] | string)[]): ArrayBuffer {
  const bytes: number[] = [];
  for (const p of partes) {
    if (typeof p === "string") bytes.push(...[...p].map((c) => c.charCodeAt(0)));
    else bytes.push(...p);
  }
  while (bytes.length < 32) bytes.push(0);
  return new Uint8Array(bytes).buffer;
}

describe("reconoce las imágenes por sus bytes", () => {
  it("PNG", () => {
    expect(tipoDeImagen(conCabecera([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });

  it("JPEG", () => {
    expect(tipoDeImagen(conCabecera([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("WebP, que lleva el tamaño en medio", () => {
    expect(tipoDeImagen(conCabecera("RIFF", [0x20, 0, 0, 0], "WEBP"))).toBe("image/webp");
  });

  it("AVIF", () => {
    expect(tipoDeImagen(conCabecera([0, 0, 0, 0x20], "ftyp", "avif"))).toBe("image/avif");
  });
});

describe("rechaza lo que no es una imagen", () => {
  it("un HTML que se hace pasar por imagen", () => {
    // El caso entero: el navegador diría `image/webp` y los bytes dicen otra
    // cosa. Manda lo que dicen los bytes.
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    expect(tipoDeImagen(html.buffer as ArrayBuffer)).toBeNull();
  });

  it("un PDF", () => {
    expect(tipoDeImagen(conCabecera("%PDF-1.7"))).toBeNull();
  });

  it("un SVG: es una imagen, pero ejecuta JavaScript", () => {
    // Por eso no está en la lista. Un SVG servido desde el origen de la web
    // puede correr scripts; no es lo mismo que un PNG.
    expect(tipoDeImagen(conCabecera("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
  });

  it("un RIFF que NO es WebP (un WAV, por ejemplo)", () => {
    // Mirar solo «RIFF» aceptaría audio. Hacen falta las dos marcas.
    expect(tipoDeImagen(conCabecera("RIFF", [0x20, 0, 0, 0], "WAVE"))).toBeNull();
  });

  it("un «ftyp» que no es AVIF (un MP4)", () => {
    expect(tipoDeImagen(conCabecera([0, 0, 0, 0x20], "ftyp", "mp42"))).toBeNull();
  });

  it("un archivo demasiado corto para ser nada", () => {
    expect(tipoDeImagen(new Uint8Array([0x89, 0x50]).buffer as ArrayBuffer)).toBeNull();
    expect(tipoDeImagen(new ArrayBuffer(0))).toBeNull();
  });

  it("los bytes correctos pero CORRIDOS una posición", () => {
    // Un archivo con un byte de basura delante no es un PNG, y aceptarlo sería
    // buscar la cabecera en cualquier sitio en vez de donde va.
    expect(tipoDeImagen(conCabecera([0x00, 0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("coherencia", () => {
  it("cada tipo reconocido tiene su extensión", () => {
    for (const t of TIPOS_DE_IMAGEN) {
      expect(EXTENSIONES[t], t).toBeTruthy();
    }
  });

  it("el tope son 5 MB, que es una foto de teléfono sin encoger", () => {
    expect(MAXIMO_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("la foto de un iPhone", () => {
  /** Los doce primeros bytes de un HEIC: tamaño de caja, «ftyp» y la marca. */
  const heic = (marca: string): ArrayBuffer => {
    const b = new Uint8Array(32);
    b.set([0, 0, 0, 0x20], 0);
    b.set([..."ftyp"].map((c) => c.charCodeAt(0)), 4);
    b.set([...marca].map((c) => c.charCodeAt(0)), 8);
    return b.buffer;
  };

  it("no se acepta, porque ningún navegador la puede enseñar", () => {
    for (const marca of ["heic", "heix", "mif1", "msf1"]) {
      expect(tipoDeImagen(heic(marca)), marca).toBeNull();
    }
  });

  it("pero se RECONOCE, y eso cambia lo que se le dice a la persona", () => {
    // Sin esto, la dueña sube la foto de un pañal desde su teléfono y lee
    // «Ese archivo no es una imagen», mirando la foto. El mensaje tiene que
    // decirle qué tocar en su iPhone.
    const mensaje = porQueNoSirveLaImagen(heic("heic"));
    expect(mensaje).toContain("HEIC");
    expect(mensaje).toContain("Más compatible");
    expect(mensaje).not.toContain("no es una imagen");
  });

  it("y lo que de verdad no es una imagen sigue diciéndolo claro", () => {
    const basura = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).buffer;
    expect(porQueNoSirveLaImagen(basura)).toContain("no es una imagen");
  });

  it("y un AVIF de verdad, que comparte contenedor con HEIC, no se confunde", () => {
    // Los dos son ISO-BMFF y la marca va en el mismo sitio. Si la detección
    // mirara solo «ftyp», un AVIF bueno se rechazaría como foto de iPhone.
    const b = new Uint8Array(32);
    b.set([0, 0, 0, 0x20], 0);
    b.set([..."ftyp"].map((c) => c.charCodeAt(0)), 4);
    b.set([..."avif"].map((c) => c.charCodeAt(0)), 8);
    expect(tipoDeImagen(b.buffer)).toBe("image/avif");
    expect(esFotoDeIphone(b.buffer)).toBe(false);
  });
});
