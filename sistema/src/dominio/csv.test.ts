import { describe, expect, it } from "vitest";
import { detectarDelimitador, escaparCampo, escribirCsv, leerCsv } from "./csv";

describe("detectarDelimitador", () => {
  it("reconoce la coma", () => {
    expect(detectarDelimitador("codigo,nombre,precio\nNAT-M,Pañal,50")).toBe(",");
  });

  it("reconoce el punto y coma de Excel en español", () => {
    // Excel en español exporta con punto y coma porque la coma es el separador
    // decimal. Leerlo con coma daría una sola columna gigante.
    expect(detectarDelimitador("codigo;nombre;precio")).toBe(";");
  });

  it("reconoce el tabulador", () => {
    expect(detectarDelimitador("codigo\tnombre\tprecio")).toBe("\t");
  });

  it("no cuenta los delimitadores que están dentro de comillas", () => {
    // Un nombre con comas dentro no puede votar por la coma.
    expect(detectarDelimitador('"Pañal, caja de 144, grande";precio')).toBe(";");
  });

  it("con una sola columna se queda con la coma", () => {
    expect(detectarDelimitador("codigo")).toBe(",");
  });
});

describe("leerCsv", () => {
  it("lee encabezados y filas", () => {
    const r = leerCsv("codigo,nombre,precio\nNAT-M,Pañal Nateen M,50.00\nNAT-L,Pañal Nateen L,50.00");
    expect(r.encabezados).toEqual(["codigo", "nombre", "precio"]);
    expect(r.filas).toEqual([
      ["NAT-M", "Pañal Nateen M", "50.00"],
      ["NAT-L", "Pañal Nateen L", "50.00"],
    ]);
  });

  it("un nombre con comas dentro sigue siendo una sola columna", () => {
    // El caso que justifica no usar split(','): si esto se rompe, el precio se
    // coloca donde va la marca y el catálogo entra con la basura dentro.
    const r = leerCsv('codigo,nombre,precio\nNAT-M,"Pañal Nateen M, caja de 144, suave",50.00');
    expect(r.filas[0]).toEqual(["NAT-M", "Pañal Nateen M, caja de 144, suave", "50.00"]);
  });

  it("aguanta saltos de línea dentro de un campo entrecomillado", () => {
    const r = leerCsv('codigo,nota\nNAT-M,"primera línea\nsegunda línea"');
    expect(r.filas).toEqual([["NAT-M", "primera línea\nsegunda línea"]]);
  });

  it("unas comillas dobles dentro son una comilla literal", () => {
    const r = leerCsv('codigo,nombre\nX,"Pañal ""extra suave"""');
    expect(r.filas[0]![1]).toBe('Pañal "extra suave"');
  });

  it("lee ficheros con fin de línea de Windows", () => {
    const r = leerCsv("codigo,nombre\r\nNAT-M,Pañal\r\nNAT-L,Otro");
    expect(r.encabezados).toEqual(["codigo", "nombre"]);
    expect(r.filas).toEqual([
      ["NAT-M", "Pañal"],
      ["NAT-L", "Otro"],
    ]);
  });

  it("quita el BOM que pone Excel al guardar en UTF-8", () => {
    // Sin esto, «﻿codigo» no coincide con «codigo» y la columna se
    // vuelve irreconocible.
    const r = leerCsv("﻿codigo,nombre\nNAT-M,Pañal");
    expect(r.encabezados[0]).toBe("codigo");
  });

  it("recorta los espacios de los encabezados", () => {
    expect(leerCsv(" codigo , nombre \nX,Y").encabezados).toEqual(["codigo", "nombre"]);
  });

  it("descarta las filas completamente vacías", () => {
    expect(leerCsv("codigo,nombre\nNAT-M,Pañal\n,\n\nNAT-L,Otro").filas).toEqual([
      ["NAT-M", "Pañal"],
      ["NAT-L", "Otro"],
    ]);
  });

  it("lee el último campo aunque el fichero no acabe en salto de línea", () => {
    expect(leerCsv("codigo,nombre\nNAT-M,Pañal").filas).toEqual([["NAT-M", "Pañal"]]);
  });

  it("respeta el delimitador que se le pase, sin adivinar", () => {
    const r = leerCsv("a,b;c", ";");
    expect(r.encabezados).toEqual(["a,b", "c"]);
  });

  it("con comillas sin cerrar no revienta", () => {
    // Lo que salga raro lo verá quien revise la previsualización, que es quien
    // puede juzgarlo. Lanzar aquí le daría un error técnico en vez de sus datos.
    expect(() => leerCsv('codigo,nombre\nX,"sin cerrar')).not.toThrow();
  });

  it("un fichero vacío da encabezados y filas vacíos", () => {
    expect(leerCsv("")).toMatchObject({ encabezados: [], filas: [] });
  });

  it("un fichero con solo encabezados no da filas", () => {
    expect(leerCsv("codigo,nombre")).toMatchObject({
      encabezados: ["codigo", "nombre"],
      filas: [],
    });
  });
});

describe("escribirCsv", () => {
  it("escapa lo que RFC 4180 obliga a escapar", () => {
    expect(escaparCampo("simple")).toBe("simple");
    expect(escaparCampo("con, coma")).toBe('"con, coma"');
    expect(escaparCampo('con "comillas"')).toBe('"con ""comillas"""');
    expect(escaparCampo("con\nsalto")).toBe('"con\nsalto"');
  });

  it("escapa según el delimitador que se vaya a usar", () => {
    expect(escaparCampo("a;b", ";")).toBe('"a;b"');
    expect(escaparCampo("a;b", ",")).toBe("a;b");
  });

  it("lleva BOM para que Excel en español no rompa las tildes", () => {
    // Sin BOM, «Pañal» se abre como «PaÃ±al» y parece que los datos están
    // corruptos.
    const csv = escribirCsv(["codigo", "nombre"], [["NAT-M", "Pañal"]]);
    expect(csv.startsWith("﻿")).toBe(true);
  });

  it("lo que escribe se vuelve a leer igual", () => {
    const encabezados = ["codigo", "nombre", "nota"];
    const filas = [
      ["NAT-M", 'Pañal Nateen M, caja de 144', 'dijo "suave"'],
      ["NAT-L", "Pañal Nateen L", "con\nsalto de línea"],
    ];
    const vuelta = leerCsv(escribirCsv(encabezados, filas));
    expect(vuelta.encabezados).toEqual(encabezados);
    expect(vuelta.filas).toEqual(filas);
  });
});
