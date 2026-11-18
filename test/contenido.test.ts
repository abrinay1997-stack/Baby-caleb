import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Un dato, un solo dueño — vigilado desde el repositorio (F3.5).
 *
 * El precio vive en la D1 del sistema y la web lo pide a `/api/catalogo`.
 * Nada impide que mañana alguien escriba un `"price": 45` en `content.json`
 * «para que se vea rápido»: el sitio lo mostraría, nadie fallaría, y la web
 * volvería a decir una cosa mientras el bot dice otra. Esa es exactamente la
 * forma en que se pierde una fuente de verdad: en silencio y con buena
 * intención.
 *
 * Estas pruebas son el contrato que lo impide (03-contratos.md §2).
 */

const RAIZ = resolve(import.meta.dirname, '..');
const leer = (r: string) => readFileSync(join(RAIZ, r), 'utf8');

interface Variante {
  codigo?: string;
  size: string;
  units?: string;
}
interface Producto {
  id: string;
  name: string;
  descatalogado?: boolean;
  variants: Variante[];
}

const contenido = JSON.parse(leer('content.json')) as { products: Producto[] };
const respaldo = JSON.parse(leer('src/data/catalogo.respaldo.json')) as {
  variantes: { codigo: string; precioCents: number }[];
};
const EN_EL_CATALOGO = new Set(respaldo.variantes.map((v) => v.codigo));

describe('content.json no guarda precios', () => {
  it('ni `price` ni `priceFrom` en ninguna parte', () => {
    const crudo = leer('content.json');
    expect(crudo).not.toMatch(/"price"/);
    expect(crudo).not.toMatch(/"priceFrom"/);
  });

  it('y tampoco un monto en dólares escrito a mano', () => {
    // Un `"desde $45"` metido en una descripción esquiva la comprobación de
    // arriba y engaña igual a la clienta.
    const crudo = leer('content.json');
    const montos = crudo.match(/\$\s?\d/g) ?? [];
    expect(montos, `montos encontrados: ${montos.join(', ')}`).toEqual([]);
  });
});

describe('cada variante que se pinta existe en el catálogo', () => {
  const visibles = contenido.products.filter((p) => p.descatalogado !== true);

  it('todas tienen código', () => {
    const sinCodigo = visibles.flatMap((p) =>
      p.variants.filter((v) => !v.codigo).map((v) => `${p.id} · ${v.size}`)
    );
    expect(sinCodigo, `sin código: ${sinCodigo.join(', ')}`).toEqual([]);
  });

  it('y su código existe de verdad en la copia del catálogo', () => {
    // Si esto falla, la web está ofreciendo algo que el sistema no tiene: una
    // clienta puede pedirlo y el bot le dirá que no existe.
    const fantasmas = visibles.flatMap((p) =>
      p.variants
        .filter((v) => v.codigo && !EN_EL_CATALOGO.has(v.codigo))
        .map((v) => `${p.id} · ${v.size} (${v.codigo})`)
    );
    expect(fantasmas, `códigos que no están en el catálogo: ${fantasmas.join(', ')}`).toEqual([]);
  });

  it('la copia del catálogo no está vacía', () => {
    // Una copia vacía haría pasar en verde la prueba de arriba por la razón
    // equivocada: sin códigos que comprobar, no hay fantasma que encontrar.
    expect(respaldo.variantes.length).toBeGreaterThan(0);
  });
});

describe('lo descatalogado se marca, no se deja suelto', () => {
  it('un producto sin códigos tiene que estar marcado como descatalogado', () => {
    const sospechosos = contenido.products
      .filter((p) => p.descatalogado !== true)
      .filter((p) => p.variants.every((v) => !v.codigo))
      .map((p) => p.id);
    expect(sospechosos, `sin un solo código y sin marcar: ${sospechosos.join(', ')}`).toEqual([]);
  });
});

describe('el Worker no escribe montos a mano', () => {
  const archivos = (dir: string): string[] =>
    readdirSync(join(RAIZ, dir)).flatMap((n) => {
      const r = join(dir, n);
      if (statSync(join(RAIZ, r)).isDirectory()) return archivos(r);
      return r.endsWith('.ts') && !r.endsWith('.test.ts') ? [r] : [];
    });

  it('ningún `$<número>` fuera de los formateadores', () => {
    // El único sitio donde un símbolo de dólar es correcto es la función que
    // convierte centavos a texto. En cualquier otro, es un precio escrito a
    // mano que el catálogo no puede corregir.
    const culpables: string[] = [];
    for (const r of archivos('worker')) {
      leer(r)
        .split('\n')
        .forEach((linea, i) => {
          // `${` es interpolación de plantilla, no un monto.
          const limpia = linea.replace(/\$\{/g, '');
          if (/\$\s?\d/.test(limpia)) culpables.push(`${r}:${i + 1} ${linea.trim()}`);
        });
    }
    expect(culpables, culpables.join('\n')).toEqual([]);
  });
});

/**
 * Ningún BOTÓN del contenido manda a WhatsApp.
 *
 * ## Por qué existe, y por qué llega tarde
 *
 * El 18-nov-2026 se quitaron los botones de WhatsApp de la tienda. Se buscaron
 * en el código —`whatsappCon`, `WHATSAPP_URL`, `wa.me`— y se quitaron seis. El
 * más grande del sitio **no salió en esa búsqueda**: el botón naranja del hero,
 * el primero que ve cualquiera que entra, porque su texto y su dirección no
 * viven en el código sino aquí, en `content.json`.
 *
 * Estuvo desplegado en producción diciendo «Pedir por WhatsApp» mientras el
 * resto del sitio ya había dejado de ofrecerlo. Se vio en una captura, no en
 * una prueba (`docs/TRAMPAS.md` §5).
 *
 * La lección no es «buscar mejor»: es que **el contenido también es código**
 * cuando decide a dónde va un botón. Esta prueba lo mira donde está.
 *
 * ## Qué SÍ se permite
 *
 * `social.whatsapp` es el enlace del pie, que se queda a propósito: es donde
 * busca WhatsApp quien lo quiere, en vez de encontrárselo quien pasaba por ahí.
 * Y los testimonios se citan, no se editan: son las palabras de una clienta
 * sobre lo que le pasó, no una promesa nuestra.
 */
describe('ningún botón del contenido manda a WhatsApp', () => {
  /** Las claves que son una DIRECCIÓN a la que va un botón o un enlace. */
  const ES_DESTINO = /^(href|url|link|cta)$/i;
  /** El único que se queda: el del pie. */
  const PERMITIDO = new Set(['social.whatsapp']);

  const destinosAWhatsApp = (): string[] => {
    const malos: string[] = [];
    const recorre = (nodo: unknown, ruta: string): void => {
      if (typeof nodo === 'string') {
        if (/wa\.me|api\.whatsapp|web\.whatsapp/i.test(nodo) && !PERMITIDO.has(ruta)) {
          const hoja = ruta.split('.').pop() ?? '';
          if (ES_DESTINO.test(hoja)) malos.push(`${ruta} → ${nodo}`);
        }
        return;
      }
      if (Array.isArray(nodo)) {
        nodo.forEach((v, i) => recorre(v, `${ruta}[${i}]`));
        return;
      }
      if (nodo !== null && typeof nodo === 'object') {
        for (const [k, v] of Object.entries(nodo as Record<string, unknown>)) {
          recorre(v, ruta === '' ? k : `${ruta}.${k}`);
        }
      }
    };
    recorre(JSON.parse(leer('content.json')), '');
    return malos;
  };

  it('el CTA del hero lleva a la tienda, no fuera de ella', () => {
    // Es el botón más visible del sitio: el que decide si alguien entra al
    // catálogo o se va a otra aplicación.
    const d = JSON.parse(leer('content.json')) as { hero: { cta: { href: string } } };
    expect(d.hero.cta.href).toBe('/productos');
  });

  it('y ninguna otra dirección del contenido sale a WhatsApp', () => {
    const malos = destinosAWhatsApp();
    expect(
      malos,
      'Un botón del contenido vuelve a mandar a WhatsApp. El pie es su sitio ' +
        `(social.whatsapp), no un CTA:\n${malos.join('\n')}`,
    ).toEqual([]);
  });

  it('la prueba mira de verdad el archivo — si no, no vigila nada', () => {
    // La trampa §1: un control que comprueba lo que ya era cierto. Si el
    // recorrido no llegara a ninguna cadena, lo de arriba pasaría siempre.
    const d = JSON.parse(leer('content.json')) as { social: { whatsapp?: string } };
    expect(d.social.whatsapp, 'el enlace del pie desapareció').toMatch(/wa\.me/);
  });
});

/**
 * Y los tres pasos de «Cómo comprar» cuentan el camino que existe.
 *
 * Decían «Escríbenos por WhatsApp al 6757-5065», que desde el 18-nov-2026 es
 * falso: se compra en la página. Un texto que promete un canal que ya no existe
 * es peor que un botón de más — el botón se ve, el texto se cree.
 */
describe('«Cómo comprar» cuenta el camino que existe', () => {
  const pasos = (JSON.parse(leer('content.json')) as { howToBuy: { text: string }[] }).howToBuy;

  it('hay tres pasos de verdad', () => {
    expect(pasos.length).toBeGreaterThanOrEqual(3);
  });

  it('ninguno dice que el pedido se hace por WhatsApp o por Instagram', () => {
    const malos = pasos
      .map((p, i) => ({ i, t: p.text }))
      .filter(({ t }) => /(pedido|pedir|cont[áa]ctanos|escr[íi]benos).{0,60}(whatsapp|instagram|dm)/i.test(t))
      .map(({ i, t }) => `paso ${i + 1}: ${t.slice(0, 90)}`);
    expect(malos, `pasos que mandan a pedir fuera de la web:\n${malos.join('\n')}`).toEqual([]);
  });

  it('y alguno nombra el pago en la página, que es lo que pasa ahora', () => {
    expect(pasos.some((p) => /carrito|pagar|paga/i.test(p.text))).toBe(true);
  });
});
