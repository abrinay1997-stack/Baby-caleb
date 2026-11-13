import { describe, expect, it } from "vitest";
import { loQueFalta } from "./NuevoPedido";

/**
 * Por qué está apagado el botón de tomar el pedido.
 *
 * La hoja se abre con el botón apagado —no hay clienta ni productos todavía—
 * y no decía por qué. Un botón apagado y mudo no se lee como «falta algo»: se
 * lee como «esto no sirve», y quien atiende por teléfono cierra la hoja.
 *
 * Lo que importa aquí es que el aviso y el botón miren LA MISMA condición: si
 * se separan, un día el botón se enciende con el aviso puesto y a partir de
 * ahí no se cree ninguno de los dos.
 *
 * Validada por mutación: devolver siempre `null` pone rojas las tres primeras.
 */
describe("lo que le falta a un pedido para poder mandarse", () => {
  it("con la hoja recién abierta dice que faltan las dos cosas", () => {
    expect(loQueFalta(false, 0)).toBe("Falta la clienta y falta añadir productos.");
  });

  it("con productos y sin clienta nombra solo la clienta", () => {
    const falta = loQueFalta(false, 2);
    expect(falta).toMatch(/clienta/);
    expect(falta).not.toMatch(/productos/);
  });

  it("con clienta y sin productos nombra solo los productos", () => {
    const falta = loQueFalta(true, 0);
    expect(falta).toMatch(/producto/);
    expect(falta).not.toMatch(/clienta/);
  });

  it("no falta nada cuando están las dos cosas", () => {
    expect(loQueFalta(true, 1)).toBeNull();
  });
});
