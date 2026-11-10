/**
 * Auditoría de contraste de la web, sobre las páginas YA RENDERIZADAS.
 *
 *   npm run contraste        (necesita `npm run build` antes)
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
import { createServer } from 'node:http';
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

const paginas = ['/', '/productos', '/beneficios', '/historia', '/tips', '/como-comprar', '/faq'];
// En CI, `npx playwright install chromium` deja el navegador donde playwright
// lo espera. En un entorno que ya trae uno, se le dice con CHROMIUM_PATH.
const navegador = await chromium.launch(
  process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
    : {},
);
const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const p = await ctx.newPage();

let totalFallos = 0;
for (const pagina of paginas) {
  await p.goto(`http://127.0.0.1:8098${pagina}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const fallos = await p.evaluate(auditar);
  totalFallos += fallos.length;
  console.log(`\n${pagina}  ${fallos.length === 0 ? 'sin fallos de contraste' : fallos.length + ' fallo(s)'}`);
  for (const f of fallos) {
    console.log(`  ${f.ratio} < ${f.minimo}  ${f.px}px/${f.peso}  "${f.texto}"`);
    console.log(`     ${f.color} sobre ${f.fondo}`);
    console.log(`     ${f.clases}`);
  }
}
await navegador.close();
servidor.close();
console.log(`\n=== total: ${totalFallos} fallo(s) de contraste en 7 páginas ===`);
process.exit(totalFallos === 0 ? 0 : 1);
