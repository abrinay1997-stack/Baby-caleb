/**
 * Auditoría de la web sobre las páginas YA RENDERIZADAS: contraste, §7 y
 * accesibilidad.
 *
 *   npm run auditar:web      (necesita `npm run build` antes)
 *
 * Se llamaba `auditar-contraste.mjs` y medía solo el contraste, solo en
 * escritorio y solo en siete páginas. Las tres cosas eran huecos:
 *
 *   · **Solo escritorio.** La tienda se mira desde el teléfono más que desde
 *     cualquier otra parte. El contraste no cambia con el ancho, pero QUÉ
 *     texto está visible sí: el menú del teléfono es otro trozo de página, y
 *     nunca se había medido ni una vez.
 *   · **Faltaban páginas.** La ficha de un producto —la página con la que se
 *     vende— y el carrito no estaban en la lista. Tampoco las legales ni la
 *     de «no existe». Es la trampa §4 otra vez: una pantalla que no está en
 *     la lista no dice «está bien», no dice nada, y se lee igual.
 *   · **Solo contraste.** El foco, las etiquetas de los campos, el nombre de
 *     los botones de solo icono y el orden de los encabezados no los miraba
 *     nadie. Son las reglas del §7 del panel, y la tienda las necesita igual:
 *     se reutilizan desde `sistema/scripts/medir-el-panel.mjs`, que es donde
 *     viven con sus muestras.
 *
 * No mira las clases de Tailwind: abre cada página en un navegador de verdad,
 * recorre cada nodo de texto visible, saca el color CALCULADO y el fondo
 * efectivo —subiendo por los ancestros hasta encontrar uno opaco— y mide la
 * relación de contraste de WCAG 2.1. Así caza lo que un grep no ve: un color
 * heredado, una opacidad, un fondo que viene de tres divs más arriba.
 *
 * Los umbrales son los de AA: 4.5:1 para texto normal y 3:1 para texto grande
 * (24 px, o 18.66 px en negrita).
 *
 * POR QUÉ EXISTE
 *
 * El 2026-11-09 esta auditoría encontró 55 fallos en las siete páginas. Entre
 * ellos el titular del llamado a la acción a 72 px (1.75:1, crema sobre verde)
 * y el botón «Pedir por WhatsApp» (2.20:1), que es el botón con el que se
 * compra. No eran errores de nadie: `brand.json` propone crema sobre naranja y
 * crema sobre verde, y los dos pares son ilegibles. La web se arregló usando
 * versiones oscurecidas del mismo tono para texto y bordes.
 *
 * Esto corre en CI para que no vuelva a pasar.
 */

import { chromium } from 'playwright';

// Las reglas del §7 viven con sus muestras en el sistema. Se importan, no se
// copian: una segunda copia se separa de la primera y nadie se da cuenta.
// Solo exporta funciones —no importa `playwright` ni nada—, así que cruzar la
// frontera entre los dos paquetes no arrastra dependencias.
import { medir } from '../sistema/scripts/medir-el-panel.mjs';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

import { fileURLToPath } from 'node:url';
const raiz = join(fileURLToPath(new URL('../dist', import.meta.url)));
const tipos = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml',
  '.woff2':'font/woff2','.ico':'image/x-icon','.txt':'text/plain','.xml':'application/xml','.avif':'image/avif' };
const servidor = createServer(async (req, res) => {
  let ruta = decodeURIComponent((req.url || '/').split('?')[0]);
  let archivo = join(raiz, ruta);
  try { if ((await stat(archivo)).isDirectory()) archivo = join(archivo, 'index.html'); }
  catch { archivo = join(raiz, 'index.html'); }
  try { const c = await readFile(archivo);
    res.writeHead(200, { 'content-type': tipos[extname(archivo)] || 'application/octet-stream' }); res.end(c); }
  catch { res.writeHead(404); res.end('no'); }
});
await new Promise(r => servidor.listen(8098, r));

// Se ejecuta DENTRO de la página: recorre cada nodo de texto visible, saca el
// color calculado y el fondo efectivo (subiendo por los ancestros hasta
// encontrar uno opaco) y mide el contraste WCAG.
const auditar = () => {
  /**
   * El color que sale, sea cual sea la sintaxis con que se escribió.
   *
   * ANTES ERA UN `rgba?\(…\)` A MANO, Y SE LE ESCAPABA LA MITAD DE LA MARCA.
   * Tailwind v4 compila `bg-sage/20` a `color-mix(…)`, y Chrome lo CALCULA
   * como `oklab(0.786 -0.072 0.035 / 0.2)`. Esa expresión no la reconoce
   * ningún `rgba(` — así que el fondo verde al 20 % devolvía `null`, el bucle
   * seguía subiendo hasta el crema opaco y medía contra un fondo que no era
   * el que se ve.
   *
   * Qué costaba: el 2026-11-13 este archivo decía «sin fallos de contraste»
   * en las siete páginas mientras axe-core encontraba 18 nodos malos. Entre
   * ellos la insignia de los testimonios (4.16 contra el mínimo de 4.5). O
   * sea, la trampa §1: un control que aprueba siempre no es un control.
   *
   * Ahora lo convierte el propio navegador: se pinta el color en un lienzo de
   * un píxel y se lee el píxel. Eso entiende `rgb`, `oklab`, `oklch`, `lab`,
   * `color(srgb …)`, `color-mix`, los nombres y lo que Chrome añada mañana,
   * sin que nadie tenga que venir a enseñarle una sintaxis nueva.
   */
  const lienzo = document.createElement('canvas');
  lienzo.width = 1; lienzo.height = 1;
  const pincel = lienzo.getContext('2d', { willReadFrequently: true });
  const aRgb = (s) => {
    if (!s) return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    pincel.clearRect(0, 0, 1, 1);
    pincel.fillStyle = '#000';
    pincel.fillStyle = s;
    // `fillStyle` se queda en negro si el valor no se entiende. Un negro de
    // verdad también sale negro, así que se comprueba aparte.
    if (pincel.fillStyle === '#000000' && !/^(#000|black|rgba?\(0,\s*0,\s*0)/i.test(s.trim())) return null;
    pincel.fillRect(0, 0, 1, 1);
    const d = pincel.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const mezclar = (f, b) => ({ r: f.r*f.a + b.r*(1-f.a), g: f.g*f.a + b.g*(1-f.a), b: f.b*f.a + b.b*(1-f.a), a: 1 });
  const lum = (c) => { const f = [c.r, c.g, c.b].map(v => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; };
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1]; return (hi+0.05)/(lo+0.05); };

  /**
   * El fondo que de verdad hay detrás, y cuánta opacidad lleva encima.
   *
   * DOS ARREGLOS, Y LOS DOS SALIERON DE UN FALLO REAL:
   *
   * 1. **Los fondos traslúcidos se COMPONEN, no se saltan.** Antes se subía
   *    hasta encontrar uno con alfa > 0.95 y se ignoraba todo lo de en medio.
   *    Un `bg-sage/20` sobre crema no es crema: es el crema teñido de verde, y
   *    es más claro — o sea, el texto contrasta MENOS de lo que decía la
   *    medida. Así se le escapó la insignia de los testimonios.
   *
   * 2. **La `opacity` de los ancestros cuenta.** Antes solo se descartaba el
   *    nodo si su propia opacidad bajaba de 0.1. Pero `opacity` es del
   *    ancestro y se hereda al pintar: una fila con `opacity-60` deja su texto
   *    al 60 % contra el fondo, y eso baja el contraste de verdad. En la lista
   *    de presentaciones agotadas eso daba 2.35 donde el mínimo es 4.5, y esta
   *    auditoría lo daba por bueno porque medía el color declarado.
   *
   * Devuelve el fondo ya compuesto y el producto de todas las opacidades.
   */
  const fondoYOpacidad = (el) => {
    const capas = [];
    let opac = 1;
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const o = parseFloat(cs.opacity);
      opac *= Number.isFinite(o) ? o : 1;
      const bg = aRgb(cs.backgroundColor);
      if (bg && bg.a > 0) capas.push(bg);
      if (bg && bg.a >= 0.999) break;
      n = n.parentElement;
    }
    const raizBg = aRgb(getComputedStyle(document.body).backgroundColor);
    let fondo = raizBg && raizBg.a >= 0.999 ? raizBg : { r: 255, g: 255, b: 255, a: 1 };
    // De la capa más lejana a la más cercana: cada una se pinta sobre la
    // anterior. Al revés daría un color plausible y equivocado.
    for (let i = capas.length - 1; i >= 0; i--) fondo = mezclar(capas[i], fondo);
    return { fondo, opac };
  };

  const fallos = [];
  const vistos = new Set();
  const paseador = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let nodo;
  while ((nodo = paseador.nextNode())) {
    const texto = (nodo.textContent || '').trim();
    if (!texto) continue;
    const el = nodo.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const caja = el.getBoundingClientRect();
    if (caja.width < 2 || caja.height < 2) continue;

    const frenteCrudo = aRgb(cs.color);
    if (!frenteCrudo) continue;
    const { fondo, opac } = fondoYOpacidad(el);
    // Por debajo de 0.1 no se mide: eso ya no es texto apagado, es texto
    // escondido, y exigirle contraste a algo invisible es ruido.
    if (opac < 0.1) continue;
    const frente = mezclar({ ...frenteCrudo, a: frenteCrudo.a * opac }, fondo);
    const r = ratio(frente, fondo);

    const px = parseFloat(cs.fontSize);
    const peso = parseInt(cs.fontWeight, 10) || 400;
    const grande = px >= 24 || (px >= 18.66 && peso >= 700);
    const minimo = grande ? 3.0 : 4.5;

    if (r < minimo) {
      const clave = `${cs.color}|${cs.backgroundColor}|${opac}|${el.className}|${px}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      fallos.push({
        texto: texto.slice(0, 48), ratio: Math.round(r*100)/100, minimo,
        color: cs.color + (opac < 0.999 ? ` al ${Math.round(opac * 100)} %` : ''),
        fondo: `rgb(${Math.round(fondo.r)}, ${Math.round(fondo.g)}, ${Math.round(fondo.b)})`,
        px, peso, clases: String(el.className).slice(0, 70),
      });
    }
  }
  return fallos;
};

// ---------------------------------------------------------------------------
// Antes de abrir el navegador: la hoja de la web y brand.json dicen lo mismo
// ---------------------------------------------------------------------------
// El plan dice que «la marca de brand.json manda en la web y en el panel». La
// hoja `babycaleb.css` repite los valores en vez de importarlos, así que algo
// tiene que vigilar que no se separen. El panel lo hace en su propia prueba;
// esto lo hace por la web.
{
  const marca = JSON.parse(await readFile(new URL('../brand.json', import.meta.url), 'utf8'));
  const hoja = await readFile(new URL('../src/styles/themes/babycaleb.css', import.meta.url), 'utf8');
  const desajustes = [];
  for (const [nombre, valor] of Object.entries(marca.color)) {
    const m = new RegExp(`--${nombre}:\\s*([^;]+);`).exec(hoja);
    if (!m) { desajustes.push(`la hoja no declara --${nombre}`); continue; }
    const enHoja = m[1].trim();
    if (enHoja.toLowerCase() !== String(valor).toLowerCase()) {
      desajustes.push(`--${nombre}: la hoja dice ${enHoja} y brand.json dice ${valor}`);
    }
  }
  if (desajustes.length > 0) {
    console.error('La hoja de la web se separó de brand.json:');
    for (const d of desajustes) console.error('  ' + d);
    servidor.close();
    process.exit(1);
  }
  console.log(`✓ los ${Object.keys(marca.color).length} colores de brand.json coinciden con babycaleb.css`);
}

const paginas = [
  '/',
  '/productos',
  // La ficha de una variante: la página con la que de verdad se vende, y no
  // estaba en la lista. El slug es de un producto real del catálogo; si
  // desaparece, esta página se queda en blanco y las reglas del §7 lo dicen.
  '/productos/panales-nateen-cierre-nat-m',
  '/beneficios',
  '/historia',
  '/tips',
  '/como-comprar',
  '/faq',
  // El carrito, las legales y la de «no existe»: tampoco se medían.
  '/carrito',
  '/privacidad',
  '/terminos',
  '/esta-direccion-no-existe',
];

const VISTAS = [
  ['escritorio', { width: 1440, height: 900 }],
  // 390×844 es un iPhone 14. La tienda se mira desde aquí.
  ['telefono', { width: 390, height: 844 }],
];
/**
 * Abre el navegador, y si el que Playwright espera no está, usa el de la
 * imagen.
 *
 * Playwright pide una compilación EXACTA de Chromium, y donde el navegador
 * viene con la imagen los números no coinciden casi nunca. El error que sale
 * manda a bajar un navegador habiendo uno bueno al lado (`docs/TRAMPAS.md`
 * §10), y por eso esta auditoría no se podía correr fuera de CI.
 *
 * El panel tiene el mismo respaldo en su propio auditor y a propósito no se
 * comparten: son dos paquetes de npm con dos `node_modules`, y un módulo
 * común resolvería `playwright` desde el sitio equivocado en la mitad de los
 * casos.
 */
async function abrirNavegador() {
  const opciones = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) {
    return chromium.launch({ ...opciones, executablePath: process.env.CHROMIUM_PATH });
  }
  try {
    return await chromium.launch(opciones);
  } catch (error) {
    if (!/Executable doesn't exist/i.test(String(error?.message))) throw error;
    const deLaImagen = '/opt/pw-browsers/chromium';
    if (!existsSync(deLaImagen)) {
      throw new Error(
        'Playwright no encuentra su Chromium y tampoco hay uno en ' + deLaImagen +
          '. Corra `npx playwright install chromium`, o apunte CHROMIUM_PATH a un Chrome que ya tenga.',
      );
    }
    console.log('El Chromium de Playwright no está; se usa el de la imagen (' + deLaImagen + ').');
    return chromium.launch({ ...opciones, executablePath: deLaImagen });
  }
}

const navegador = await abrirNavegador();

// ---------------------------------------------------------------------------
// Antes de mirar la web: la regla del contraste se prueba a sí misma
// ---------------------------------------------------------------------------
// `docs/design-system.md` lo pide con todas las letras, y esta regla es el
// caso que lo justifica: durante días dijo «sin fallos» en siete páginas
// mientras axe-core encontraba 18 nodos malos, porque no sabía leer un fondo
// `oklab(… / α)` ni aplicar la opacidad de un ancestro. Un control que aprueba
// siempre no es un control, es un permiso (`docs/TRAMPAS.md` §1).
//
// Las dos muestras que suspenden son EXACTAMENTE los dos casos que se le
// escapaban. Si alguien vuelve a simplificar la lectura del color o el paseo
// por los ancestros, esto se para aquí y no llega a la web.
{
  const MUESTRAS = [
    {
      nombre: 'fondo traslúcido: verde de marca sobre verde al 20 %',
      debe: 'suspender',
      html: `<div style="background:#F2EFE5;padding:8px">
               <span style="background:color-mix(in oklab, #91C9A2 20%, transparent);color:#53735C;font-size:12px;font-weight:700">
                 Cero alergias
               </span>
             </div>`,
    },
    {
      nombre: 'opacidad heredada: texto bueno dentro de un ancestro al 60 %',
      debe: 'suspender',
      html: `<div style="background:#F9F6ED;opacity:0.6;padding:8px">
               <span style="color:#985D2F;font-size:12px;font-weight:700">$45</span>
             </div>`,
    },
    {
      nombre: 'el par de siempre: navy sobre crema',
      debe: 'aprobar',
      html: `<div style="background:#F9F6ED;padding:8px">
               <span style="color:#1B3246;font-size:14px">Pañales Nateen</span>
             </div>`,
    },
    {
      nombre: 'el par de los botones: navy sobre el naranja de marca',
      debe: 'aprobar',
      html: `<div style="background:#EE924A;padding:8px">
               <span style="color:#1B3246;font-size:14px;font-weight:700">Pedir por WhatsApp</span>
             </div>`,
    },
  ];

  const ctx = await navegador.newContext({ viewport: { width: 900, height: 600 } });
  const p = await ctx.newPage();
  const rotas = [];
  for (const m of MUESTRAS) {
    await p.setContent(`<!doctype html><html lang="es"><body style="background:#F9F6ED;margin:0">${m.html}</body></html>`);
    const fallos = await p.evaluate(auditar);
    const suspende = fallos.length > 0;
    if (suspende !== (m.debe === 'suspender')) {
      rotas.push(`  ${m.nombre}: tenía que ${m.debe} y ${suspende ? 'suspendió' : 'aprobó'}`);
    }
  }
  await ctx.close();
  if (rotas.length > 0) {
    console.error('\nLa regla del contraste dejó de señalar su propia muestra:');
    for (const r of rotas) console.error(r);
    console.error('\nNo se midió la web: un control que no caza su propio caso no dice nada de lo demás.');
    await navegador.close();
    servidor.close();
    process.exit(1);
  }
  console.log(`✓ la regla del contraste caza sus ${MUESTRAS.length} muestras`);
}

let totalFallos = 0;
const delSeptimo = [];

for (const [nombreVista, tamano] of VISTAS) {
  const ctx = await navegador.newContext({ viewport: tamano, reducedMotion: 'reduce' });
  const p = await ctx.newPage();

  for (const pagina of paginas) {
    await p.goto(`http://127.0.0.1:8098${pagina}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);

    // Abajo del todo: lo que está fijo solo puede tapar algo cuando hay algo
    // debajo, y arriba del todo nunca lo hay.
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await p.waitForTimeout(150);

    const fallos = await p.evaluate(auditar);
    totalFallos += fallos.length;
    console.log(`\n[${nombreVista}] ${pagina}  ${fallos.length === 0 ? 'sin fallos de contraste' : fallos.length + ' fallo(s)'}`);
    for (const f of fallos) {
      console.log(`  ${f.ratio} < ${f.minimo}  ${f.px}px/${f.peso}  "${f.texto}"`);
      console.log(`     ${f.color} sobre ${f.fondo}`);
      console.log(`     ${f.clases}`);
    }

    // El Tab no es un adorno: Chrome apaga `:focus-visible` mientras la última
    // cosa que pasó fue un clic o nada, y sin él la regla del aro de foco
    // acusa a toda la página. Está contado en `docs/TRAMPAS.md` §14.
    await p.keyboard.press('Tab');
    // Las dianas de la tienda se miden con la WCAG 2.5.8 —24 px o separación
    // suficiente—, no con los 44 px del panel. Los 44 son el contrato del
    // panel, que se usa con una mano y con prisa; la tienda es otra cosa y su
    // pie de página es una lista densa de enlaces, separados de sobra. Con la
    // norma del panel salían 434 fallas y ninguna incumplía la 2.5.8: 434
    // rojos que un revisor descarta con razón, y una regla así deja de
    // leerse (`docs/TRAMPAS.md` §14).
    for (const f of await p.evaluate(medir, { tactilMinimo: 24, exencionPorSeparacion: true })) {
      delSeptimo.push({ vista: nombreVista, pagina, ...f });
    }
  }
  await ctx.close();
}

await navegador.close();
servidor.close();

console.log(`\n=== contraste: ${totalFallos} fallo(s) en ${paginas.length} páginas × ${VISTAS.length} tamaños ===`);

if (delSeptimo.length === 0) {
  console.log('=== §7 y accesibilidad: sin fallas ===');
} else {
  console.log(`\n=== §7 y accesibilidad: ${delSeptimo.length} falla(s) ===`);
  const porRegla = new Map();
  for (const f of delSeptimo) porRegla.set(f.regla, [...(porRegla.get(f.regla) ?? []), f]);
  for (const [regla, lista] of [...porRegla.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${regla} — ${lista.length}`);
    for (const f of lista.slice(0, 8)) console.log(`    [${f.vista}${f.pagina}] ${f.detalle}`);
    if (lista.length > 8) console.log(`    … y ${lista.length - 8} más`);
  }
}

process.exit(totalFallos === 0 && delSeptimo.length === 0 ? 0 : 1);
