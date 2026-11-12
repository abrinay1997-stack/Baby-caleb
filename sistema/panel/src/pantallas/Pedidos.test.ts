import { describe, expect, it } from "vitest";
import { estadoDeLaUrl } from "./Pedidos";

/**
 * El filtro por estado viaja en la barra de direcciones.
 *
 * Es lo que permite que el Resumen mande aquí con la lista ya acotada
 * (`/pedidos?estado=por_abonar`) en vez de dejar a la dueña buscando el filtro
 * a mano después de haber leído el número.
 *
 * Y un estado que esta pantalla no conoce se ignora: mandárselo al servidor
 * devolvería una lista vacía, que en un teléfono se lee como «no hay pedidos»
 * —que es justo lo contrario de lo que pasa.
 *
 * Validada por mutación: devolver `crudo ?? ""` sin comprobar pone roja la
 * tercera; devolver siempre "" pone roja la primera.
 */
describe("el estado que llega por la barra de direcciones", () => {
  it("acepta los estados que la pantalla sabe filtrar", () => {
    for (const clave of ["cotizacion", "por_abonar", "agendado", "en_ruta", "entregado"]) {
      expect(estadoDeLaUrl(clave), clave).toBe(clave);
    }
  });

  it("sin nada en la barra, no filtra", () => {
    expect(estadoDeLaUrl(null)).toBe("");
    expect(estadoDeLaUrl("")).toBe("");
  });

  it("un estado inventado no se le manda al servidor", () => {
    expect(estadoDeLaUrl("por_cobrar")).toBe("");
    expect(estadoDeLaUrl("ENTREGADO")).toBe("");
  });
});
