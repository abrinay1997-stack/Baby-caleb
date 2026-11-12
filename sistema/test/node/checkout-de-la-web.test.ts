import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LA_WEB_TIENE_CHECKOUT } from "../../src/dominio/checkout";

/**
 * `LA_WEB_TIENE_CHECKOUT` tiene que decir lo que hace el carrito de verdad.
 *
 * ## Qué problema resuelve esta prueba
 *
 * El veredicto de `src/dominio/checkout.ts` incluye un hecho que no está en la
 * base: si el carrito de la web sabe mandar a una clienta a pagar. Hoy no
 * sabe, y por eso el interruptor `checkout_activo` sale «encendido pero
 * inerte» en la pantalla de Ajustes.
 *
 * Un hecho declarado a mano es exactamente la clase de lista que alguien tiene
 * que acordarse de tocar (docs/TRAMPAS.md §8), y olvidarla aquí sale caro en
 * las dos direcciones:
 *
 *  - si se programa el cobro en la web y nadie cambia la constante, Ajustes
 *    seguirá diciendo «inerte» con el cobro funcionando, y la dueña no lo
 *    encenderá;
 *  - si alguien pone la constante en `true` antes de que el carrito cobre,
 *    Ajustes dirá que la web cobra cuando no cobra — que es volver a la mentira
 *    que todo este cambio existe para quitar.
 *
 * Así que lo comprueba una máquina: lee el carrito de verdad y exige que la
 * constante y el archivo coincidan.
 *
 * ## Por qué lee un archivo de FUERA de `sistema/`
 *
 * Porque el hecho vive ahí. `sistema/` es el Worker del negocio y la web vive
 * en la raíz del repositorio; son dos paquetes, pero un mismo repositorio y un
 * mismo despliegue. Mirar el archivo que de verdad decide es lo contrario de
 * adivinarlo.
 *
 * Vive en `test/node/` y no al lado del módulo porque `node:fs` no existe
 * dentro de workerd: ahí la prueba se saltaría en silencio, pasando en verde
 * sin comprobar nada. Es la misma lección de `scripts/panel-de-muestra.test.ts`.
 */

const CARRITO = join(import.meta.dirname, "..", "..", "..", "src", "pages", "Carrito.tsx");

const fuente = await readFile(CARRITO, "utf8");

/**
 * Las señales de que el carrito manda a pagar de verdad.
 *
 * Son rutas y nombres, no palabras sueltas: «pagar» aparece en los textos de
 * la pantalla sin que nada se cobre, y una prueba que buscara esa palabra se
 * pondría roja al corregir una frase. Lo que se busca es una llamada: pedir al
 * servidor que cree el pedido, o arrancar un cobro.
 */
const SENALES_DE_COBRO = [
  "/api/pedidos",
  "/api/checkout",
  "/api/pagos",
  "iniciarPago",
  "crearPedido",
];

describe("el carrito de la web y la constante que lo declara", () => {
  it("se lee de verdad el archivo del carrito", () => {
    // Si la ruta se rompe —se mueve el archivo, se renombra— esta prueba
    // leería un archivo vacío y las dos de abajo pasarían sin comprobar nada.
    // Esto es lo que impide ese verde falso.
    expect(fuente.length).toBeGreaterThan(500);
    expect(fuente).toContain("export default function Carrito");
  });

  it("hoy termina en WhatsApp y no llama a ninguna ruta de cobro", () => {
    for (const senal of SENALES_DE_COBRO) {
      // `includes` sobre el archivo entero, comentarios incluidos, a
      // propósito: el comentario de cabecera del carrito habla de lo que
      // todavía no hace, y si alguien escribe ahí una ruta de cobro es porque
      // la está programando. Preferible una prueba que se queje de más a una
      // que mire para otro lado.
      expect(fuente, `el carrito menciona ${senal}`).not.toContain(senal);
    }
    expect(fuente).toContain("whatsappCon");
  });

  it("y la constante dice justo eso", () => {
    const parece = SENALES_DE_COBRO.some((s) => fuente.includes(s));
    expect(
      LA_WEB_TIENE_CHECKOUT,
      parece
        ? "El carrito ya llama a una ruta de cobro: ponga LA_WEB_TIENE_CHECKOUT en true en src/dominio/checkout.ts."
        : "El carrito todavía termina en WhatsApp: LA_WEB_TIENE_CHECKOUT tiene que ser false.",
    ).toBe(parece);
  });
});
