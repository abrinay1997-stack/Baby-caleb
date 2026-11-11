/**
 * El `<head>` de cada ruta, en un solo sitio.
 *
 * Lo leen DOS cosas: el Worker, que lo escribe en el HTML antes de mandarlo
 * (para que Meta, WhatsApp y Google lo vean sin ejecutar JavaScript), y el
 * componente `Seo`, que lo vuelve a poner al navegar dentro de la SPA.
 *
 * Por eso vive aquí y no en cada página: si el título de «Productos» estuviera
 * escrito en dos lados, el día que alguien cambie uno, el enlace que se
 * comparte por WhatsApp diría una cosa y la pestaña del navegador otra. Nadie
 * se daría cuenta hasta que lo notara una clienta.
 */

export const SITE_NAME = "Baby Caleb Panamá";

export interface MetaDeRuta {
  readonly title: string;
  readonly description: string;
}

/**
 * Las rutas que se renderizan con `<head>` propio.
 *
 * Las claves son el camino exacto. Lo que no esté aquí —`/carrito`,
 * `/mi-cuenta`, `/seguimiento/...`— sale con el `<head>` de `index.html` y sin
 * indexar, que es lo que corresponde a una pantalla privada.
 */
export const RUTAS: Record<string, MetaDeRuta> = {
  "/": {
    title: "Baby Caleb Panamá | Pañales y Wipes Nateen hipoalergénicos",
    description:
      "Pañales Nateen hipoalergénicos de bambú, sin cloro, sin perfumes. Tallas RN a XXL en caja para todo el mes. Venta online con delivery en Ciudad de Panamá.",
  },
  "/productos": {
    title: "Catálogo | Pañales y Wipes Nateen — Baby Caleb Panamá",
    description:
      "Pañales Nateen de talla RN a XXL, wipes hipoalergénicos y fulares Moon. Precios por presentación y pedido directo por WhatsApp con entrega en Ciudad de Panamá.",
  },
  "/beneficios": {
    title: "Beneficios | Pañales hipoalergénicos Nateen — Baby Caleb Panamá",
    description:
      "Cajas para todo el mes, tallas de RN a XXL, atención personal por WhatsApp y delivery a domicilio. Descubre por qué las familias eligen Baby Caleb.",
  },
  "/historia": {
    title: "Nuestra historia | Baby Caleb Panamá",
    description:
      "Baby Caleb nació en 2024 en Panamá para que conseguir pañales y wipes hipoalergénicos deje de ser una odisea. Marcas de confianza, cajas para todo el mes y delivery.",
  },
  "/tips": {
    title: "Tips y cuidado de la piel del bebé | Baby Caleb Panamá",
    description:
      "Consejos prácticos para evitar la pañalitis, entender qué significa 'sin cloro' y reconocer señales de irritación en la piel de tu bebé.",
  },
  "/como-comprar": {
    title: "Cómo comprar | Baby Caleb Panamá",
    description:
      "Haz tu pedido por WhatsApp en 3 pasos. Vendemos 100% online con entrega a domicilio en Ciudad de Panamá.",
  },
  "/faq": {
    title: "Preguntas frecuentes | Baby Caleb Panamá",
    description:
      "Tallas por peso de RN a XXL, diferencia entre hipoalergénico y sin cloro, ingredientes de los wipes y cómo funciona el delivery. Resolvemos tus dudas.",
  },

  // Las páginas legales (F1.7). Entran en esta lista y no en `SIN_INDEXAR`
  // porque son públicas a propósito: un aviso de privacidad que Google no
  // encuentra no sirve de aviso, y la Ley 81 pide que la persona pueda leerlo
  // antes de dar sus datos. Estar aquí es también lo que las mete en el
  // sitemap (`vite.config.ts` lee las claves de este objeto) y lo que hace que
  // el Worker les ponga su propio <head> — para eso tienen que estar además
  // en `run_worker_first` de `wrangler.jsonc`.
  "/privacidad": {
    title: "Política de privacidad | Baby Caleb Panamá",
    description:
      "Qué datos recoge esta página, qué pasa con lo que usted escribe en el chat de inteligencia artificial, con quién se comparte y cómo pedir que se borren (Ley 81 de 2019).",
  },
  "/terminos": {
    title: "Términos y condiciones | Baby Caleb Panamá",
    description:
      "Cómo funciona comprar en Baby Caleb Panamá: los pedidos se cierran por WhatsApp, los precios y la disponibilidad del catálogo, entregas en Ciudad de Panamá y reclamos.",
  },
};

/** Rutas que existen pero NO se indexan: son de una persona, no del público. */
export const SIN_INDEXAR = ["/carrito", "/mi-cuenta", "/pedido", "/seguimiento"];

export function metaDe(camino: string): MetaDeRuta | null {
  // Sin la barra final: «/faq/» y «/faq» son la misma página.
  const limpio = camino.length > 1 ? camino.replace(/\/+$/, "") : camino;
  return RUTAS[limpio === "" ? "/" : limpio] ?? null;
}

export const seIndexa = (camino: string): boolean =>
  !SIN_INDEXAR.some((p) => camino === p || camino.startsWith(`${p}/`));
