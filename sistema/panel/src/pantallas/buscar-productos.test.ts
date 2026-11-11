import { describe, expect, it } from "vitest";
import { TOPE_RESULTADOS, buscarProductos, sinTildes } from "./buscar-productos";

const p = (codigo: string, nombre: string, talla: string | null = null) => ({ codigo, nombre, talla });

const catalogo = [
  p("BC-001-03", "Body manga larga pima", "0-3m"),
  p("BC-001-36", "Body manga larga pima", "3-6m"),
  p("NAT-M", "Pañal Nateen de cierre", "M"),
  p("NAT-G", "Pañal Nateen de cierre", "G"),
  p("BC-002-U", "Set de 3 mantas de muselina"),
];

describe("buscarProductos", () => {
  it("con la consulta vacía no devuelve NADA", () => {
    // Devolver todo es el problema que esto viene a resolver.
    expect(buscarProductos(catalogo, "").resultados).toEqual([]);
    expect(buscarProductos(catalogo, "   ").resultados).toEqual([]);
  });

  it("encuentra «pañal» escribiendo «panal», sin la eñe", () => {
    // Quien toma un pedido por teléfono escribe deprisa y sin tildes.
    const { resultados } = buscarProductos(catalogo, "panal");
    expect(resultados.map((r) => r.codigo)).toEqual(["NAT-M", "NAT-G"]);
  });

  it("no le importan las mayúsculas", () => {
    expect(buscarProductos(catalogo, "BODY").resultados).toHaveLength(2);
  });

  it("encuentra por talla y por código, no solo por nombre", () => {
    // Seis tallas del mismo pañal comparten nombre: la talla es lo que
    // distingue una presentación de otra.
    expect(buscarProductos(catalogo, "3-6m").resultados.map((r) => r.codigo)).toEqual([
      "BC-001-36",
    ]);
    expect(buscarProductos(catalogo, "nat-g").resultados.map((r) => r.codigo)).toEqual(["NAT-G"]);
  });

  it("recorta al tope y avisa de que hay más", () => {
    const muchos = Array.from({ length: 20 }, (_, i) => p(`X-${i}`, "Pañal de prueba", `${i}`));
    const { resultados, hayMas } = buscarProductos(muchos, "panal");
    expect(resultados).toHaveLength(TOPE_RESULTADOS);
    expect(hayMas).toBe(true);
  });

  it("no avisa de más cuando caben todos", () => {
    const { resultados, hayMas } = buscarProductos(catalogo, "panal");
    expect(resultados).toHaveLength(2);
    expect(hayMas).toBe(false);
  });

  it("una talla nula no rompe la búsqueda", () => {
    expect(buscarProductos(catalogo, "muselina").resultados.map((r) => r.codigo)).toEqual([
      "BC-002-U",
    ]);
  });
});

describe("sinTildes", () => {
  it("quita las tildes y baja a minúsculas", () => {
    expect(sinTildes("Pañal Algodón ÁÉÍÓÚ")).toBe("panal algodon aeiou");
  });
});
