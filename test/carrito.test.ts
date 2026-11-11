import { describe, expect, it } from "vitest";
import {
  MAXIMO_POR_LINEA,
  VACIO,
  agregar,
  cantidadDe,
  desdeGuardado,
  estaVacio,
  ponerCantidad,
  quitar,
  unidades,
} from "../src/carrito/carrito";

/**
 * El carrito.
 *
 * Lo que más se vigila aquí no es sumar bien, es lo que el carrito NO guarda:
 * un precio en `localStorage` es un precio que la clienta puede editar. Por eso
 * la primera prueba mira la forma de lo guardado y no un total.
 */

describe("lo que el carrito guarda", () => {
  it("guarda solo código y cantidad, nunca un precio", () => {
    const c = agregar(agregar(VACIO, "PAN-M-40"), "WIP-80", 3);

    // Esta es LA prueba del archivo. Si alguien añade `precioCents` a la línea
    // «para no tener que recalcular», esto se cae, y debe caerse: el precio lo
    // pone el servidor en cada pedido, y lo que vive en el navegador se puede
    // editar con dos clics.
    for (const linea of c.lineas) {
      expect(Object.keys(linea).sort()).toEqual(["cantidad", "codigo"]);
    }
  });

  it("mantiene el orden en que se fueron agregando", () => {
    const c = agregar(agregar(agregar(VACIO, "A"), "B"), "C");
    expect(c.lineas.map((l) => l.codigo)).toEqual(["A", "B", "C"]);
  });
});

describe("agregar", () => {
  it("suma a la línea que ya estaba en vez de duplicarla", () => {
    const c = agregar(agregar(VACIO, "PAN-M-40", 2), "PAN-M-40", 3);
    expect(c.lineas).toHaveLength(1);
    expect(cantidadDe(c, "PAN-M-40")).toBe(5);
  });

  it("no pasa del tope por línea aunque se sume muchas veces", () => {
    let c = agregar(VACIO, "PAN-M-40", MAXIMO_POR_LINEA);
    for (let i = 0; i < 50; i += 1) c = agregar(c, "PAN-M-40", 10);
    // El tope se aplica al total de la línea, no a cada suma: si se aplicara a
    // la suma, tocar «Agregar» cien veces lo pasaría igualmente.
    expect(cantidadDe(c, "PAN-M-40")).toBe(MAXIMO_POR_LINEA);
  });

  it("ignora un código con forma imposible", () => {
    for (const malo of ["", "   ", "con espacio", "salto\nlinea", "a".repeat(65), "../../etc"]) {
      expect(agregar(VACIO, malo)).toEqual(VACIO);
    }
  });

  it("ignora cantidades que no son cantidades", () => {
    for (const mala of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(agregar(VACIO, "PAN-M-40", mala)).toEqual(VACIO);
    }
  });

  it("trunca un decimal en vez de redondear hacia arriba", () => {
    // 2.9 unidades no son 3: nadie compra media caja, y redondear hacia arriba
    // apartaría inventario que la clienta no pidió.
    expect(cantidadDe(agregar(VACIO, "PAN-M-40", 2.9), "PAN-M-40")).toBe(2);
  });
});

describe("cambiar y quitar", () => {
  it("poner cero quita la línea en vez de dejarla en cero", () => {
    const c = ponerCantidad(agregar(VACIO, "PAN-M-40", 4), "PAN-M-40", 0);
    expect(estaVacio(c)).toBe(true);
  });

  it("poner una cantidad negativa también la quita", () => {
    const c = ponerCantidad(agregar(VACIO, "PAN-M-40", 4), "PAN-M-40", -1);
    expect(estaVacio(c)).toBe(true);
  });

  it("poner cantidad no toca las demás líneas", () => {
    let c = agregar(agregar(VACIO, "A", 2), "B", 5);
    c = ponerCantidad(c, "A", 7);
    expect(cantidadDe(c, "A")).toBe(7);
    expect(cantidadDe(c, "B")).toBe(5);
  });

  it("quitar una línea que no está no cambia nada", () => {
    const c = agregar(VACIO, "A", 2);
    expect(quitar(c, "NO-ESTA")).toEqual(c);
  });

  it("unidades suma todas las líneas, no cuenta líneas", () => {
    const c = agregar(agregar(VACIO, "A", 2), "B", 5);
    expect(unidades(c)).toBe(7);
  });
});

describe("leer lo guardado (entrada no confiable)", () => {
  it("un carrito guardado normal vuelve igual", () => {
    const c = agregar(agregar(VACIO, "A", 2), "B", 5);
    expect(desdeGuardado(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("nada de lo que no sea un carrito rompe la página", () => {
    for (const basura of [
      null,
      undefined,
      42,
      "texto",
      [],
      {},
      { lineas: null },
      { lineas: "no es lista" },
      { lineas: [null, 7, "x"] },
    ]) {
      expect(desdeGuardado(basura)).toEqual(VACIO);
    }
  });

  it("descarta las líneas rotas y conserva las buenas", () => {
    // Que sobreviva lo bueno es el punto: perder una línea es molesto, una
    // pantalla en blanco en el carrito es una venta perdida.
    const leido = desdeGuardado({
      lineas: [
        { codigo: "BUENA", cantidad: 2 },
        { codigo: "", cantidad: 1 },
        { codigo: "OTRA BUENA?", cantidad: 1 },
        { codigo: "TAMBIEN", cantidad: "3" },
        { codigo: "NEGATIVA", cantidad: -1 },
        { codigo: "FINAL", cantidad: 4 },
      ],
    });
    expect(leido.lineas).toEqual([
      { codigo: "BUENA", cantidad: 2 },
      { codigo: "FINAL", cantidad: 4 },
    ]);
  });

  it("un código duplicado se queda con el primero y no se suma", () => {
    // Sumarlos inventaría una cantidad que la clienta nunca pidió.
    const leido = desdeGuardado({
      lineas: [
        { codigo: "A", cantidad: 2 },
        { codigo: "A", cantidad: 90 },
      ],
    });
    expect(leido.lineas).toEqual([{ codigo: "A", cantidad: 2 }]);
  });

  it("recorta una cantidad guardada por encima del tope", () => {
    // Alguien que edite `localStorage` a mano no puede apartar 10 000 cajas.
    const leido = desdeGuardado({ lineas: [{ codigo: "A", cantidad: 10000 }] });
    expect(leido.lineas).toEqual([{ codigo: "A", cantidad: MAXIMO_POR_LINEA }]);
  });

  it("descarta un precio que venga en lo guardado", () => {
    // Una versión futura (o un navegador manipulado) podría traer un precio.
    // No debe sobrevivir a la lectura: si sobreviviera, llegaría al pedido.
    const leido = desdeGuardado({
      lineas: [{ codigo: "A", cantidad: 1, precioCents: 1 }],
    });
    expect(leido.lineas[0]).toEqual({ codigo: "A", cantidad: 1 });
  });
});
