import { readFile, readdir } from "node:fs/promises";
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

const RAIZ_WEB = join(import.meta.dirname, "..", "..", "..", "src");
const CARRITO = join(RAIZ_WEB, "pages", "Carrito.tsx");
const CARPETA = join(RAIZ_WEB, "carrito");

/**
 * Se leen el carrito Y toda la carpeta `src/carrito/`.
 *
 * Mirar solo `Carrito.tsx` fue un verde falso de verdad: cuando se construyó
 * el paso de pago, la llamada quedó en `src/carrito/pago.ts` y el carrito pasó
 * a ser un enlace a `/pago`. Esta prueba siguió en verde diciendo que la web no
 * cobraba mientras la web ya cobraba — la trampa §8 por segunda vez, en la
 * prueba que existe para impedirla.
 *
 * Se lee la CARPETA ENTERA y no una lista de archivos a propósito: un archivo
 * nuevo ahí dentro entra solo, sin que nadie tenga que acordarse.
 */
const carritoSolo = await readFile(CARRITO, "utf8");
const fuente = [
  carritoSolo,
  ...(await Promise.all(
    (await readdir(CARPETA))
      .filter((n) => n.endsWith(".ts") || n.endsWith(".tsx"))
      .map((n) => readFile(join(CARPETA, n), "utf8")),
  )),
].join("\n");

/**
 * Las señales de que el carrito manda a pagar de verdad.
 *
 * Son rutas y nombres, no palabras sueltas: «pagar» aparece en los textos de
 * la pantalla sin que nada se cobre, y una prueba que buscara esa palabra se
 * pondría roja al corregir una frase. Lo que se busca es una llamada: pedir al
 * servidor que cree el pedido, o arrancar un cobro.
 */
const SENALES_DE_COBRO = [
  // La de verdad, desde que existe el paso de pago. Iba delante de todo lo
  // demás y faltaba: la lista se escribió cuando aún no se sabía cómo se
  // llamaría la ruta, y nadie volvió a tocarla al ponerle nombre.
  "/api/pago/yappy/iniciar",
  "/api/pedidos",
  "/api/checkout",
  "/api/pagos",
  "iniciarPago",
  "crearPedido",
];

describe("el carrito de la web y la constante que lo declara", () => {
  it("se leen de verdad los archivos del carrito", () => {
    // Si una ruta se rompe —se mueve un archivo, se renombra la carpeta— esta
    // prueba leería texto vacío y las de abajo pasarían sin comprobar nada.
    // Esto es lo que impide ese verde falso.
    expect(carritoSolo).toContain("export default function Carrito");
    expect(fuente.length).toBeGreaterThan(5000);
    // Y que la carpeta del paso de pago esté DENTRO de lo que se lee: sin esta
    // línea, volver a apuntar solo a `Carrito.tsx` no pondría nada rojo.
    expect(fuente).toContain("RUTA_DE_INICIO");
  });

  it("hoy el carrito SÍ manda a pagar por la web", () => {
    // `includes` sobre los archivos enteros, comentarios incluidos, a
    // propósito: si alguien escribe una ruta de cobro en un comentario es
    // porque la está programando. Preferible una prueba que se queje de más a
    // una que mire para otro lado.
    expect(fuente).toContain("/api/pago/yappy/iniciar");
  });

  it("WhatsApp ya no es un camino de PEDIDO en el carrito", () => {
    // Decisión del dueño (18-nov-2026): la tienda cobra por la web y el botón
    // «O pedir por WhatsApp» se fue del carrito. Esta casilla decía lo
    // contrario —exigía que siguiera— y se puso roja al quitarlo: hizo
    // exactamente su trabajo, que era avisar de que la regla había cambiado.
    //
    // Lo que vigila ahora es que no vuelva por la puerta de atrás: un botón
    // que se lleva a la clienta a otra aplicación compite con el que cobra, y
    // el que gana es el que está pintado de naranja.
    expect(carritoSolo).not.toContain("whatsappCon");
  });

  it("pero cuando el PAGO falla sigue habiendo a quién escribir", () => {
    // Esto no es nostalgia y no se quita con los botones de pedido: son las
    // dos pantallas de la ruta de pago —el aviso de «Yappy está caído» y el
    // «¿pagaste y no te hemos escrito?»— y salen cuando algo ya falló con el
    // dinero.
    //
    // Quitarle el contacto a alguien que acaba de pagar $50 y no tiene
    // confirmación no es ordenar la tienda: es dejarla sin a quién reclamar.
    // Si algún día se quitan, que sea una decisión y no un descuido.
    expect(fuente, "la ruta de pago se quedó sin forma de hablar con una persona").toContain(
      "WHATSAPP_URL",
    );
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
