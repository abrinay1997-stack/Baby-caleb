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
  const aRgb = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const mezclar = (f, b) => ({ r: f.r*f.a + b.r*(1-f.a), g: f.g*f.a + b.g*(1-f.a), b: f.b*f.a + b.b*(1-f.a), a: 1 });
  const lum = (c) => { const f = [c.r, c.g, c.b].map(v => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; };
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1]; return (hi+0.05)/(lo+0.05); };

  const fondoDe = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = aRgb(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.95) return bg;
      n = n.parentElement;
    }
    const raizBg = aRgb(getComputedStyle(document.body).backgroundColor);
    return raizBg && raizBg.a > 0.5 ? raizBg : { r: 255, g: 255, b: 255, a: 1 };
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
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.1) continue;
    const caja = el.getBoundingClientRect();
    if (caja.width < 2 || caja.height < 2) continue;

    const frenteCrudo = aRgb(cs.color);
    if (!frenteCrudo) continue;
    const fondo = fondoDe(el);
    const frente = mezclar(frenteCrudo, fondo);
    const r = ratio(frente, fondo);

    const px = parseFloat(cs.fontSize);
    const peso = parseInt(cs.fontWeight, 10) || 400;
    const grande = px >= 24 || (px >= 18.66 && peso >= 700);
    const minimo = grande ? 3.0 : 4.5;

    if (r < minimo) {
      const clave = `${cs.color}|${cs.backgroundColor}|${el.className}|${px}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      fallos.push({
        texto: texto.slice(0, 48), ratio: Math.round(r*100)/100, minimo,
        color: cs.color, fondo: `rgb(${Math.round(fondo.r)}, ${Math.round(fondo.g)}, ${Math.round(fondo.b)})`,
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
    for (const f of await p.evaluate(medir)) {
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
