// Recorta y copia imágenes de la carpeta ../.. al public/img del sitio.
// Todas las fuentes son PNG 1080x1350 (Instagram post 4:5).
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';

const SRC = path.resolve('..');            // carpeta padre = "BABY CALEB" con 1..71.png
const OUT = path.resolve('public/img');    // destino en el sitio
await fs.mkdir(OUT, { recursive: true });

// Cada entrada define de dónde recortar (o copiar) qué archivo.
// { src, dst, crop?: {left, top, width, height}, resize?: {width, height, fit} }
const jobs = [
  // ---------- LOGO ----------
  // 11.png: logo Baby Caleb con "PAÑALES DESECHABLES" en el propio badge (círculo verde).
  // Crop cuadrado que abarca exactamente el badge.
  { src: '11.png', dst: 'logo-babycaleb.png',
    crop: { left: 200, top: 300, width: 680, height: 680 },
    resize: { width: 512 } },
  // Versión square más apretada para nav (icono)
  { src: '11.png', dst: 'logo-badge.png',
    crop: { left: 200, top: 300, width: 680, height: 680 },
    resize: { width: 256 } },
  // 15.png: logo Nateen (marca aliada) para trust
  { src: '15.png', dst: 'logo-nateen.png',
    crop: { left: 300, top: 570, width: 500, height: 200 },
    resize: { width: 400 } },

  // ---------- PRODUCTOS "LIMPIOS" ----------
  // 7.png ya viene sin texto (caja + paquete S).
  { src: '7.png', dst: 'producto-panal-nateen-s.png',
    crop: { left: 40, top: 100, width: 1000, height: 1200 },
    resize: { width: 900 } },

  // ---------- PRODUCTOS DESDE IG ----------
  // Layout típico de 8/9/10 (título+bubble+producto+texto+footer):
  // - Bubble precio: x≥780, y=340-580
  // - Producto: x=140-780, y=430-1020
  // - Texto lateral: y≥870
  // Crop conservador: x∈[130,780], y∈[430,860]  →  650×430
  { src: '8.png',  dst: 'producto-caja-s.png',
    crop: { left: 130, top: 430, width: 620, height: 460 }, resize: { width: 900 } },
  { src: '9.png',  dst: 'producto-caja-m.png',
    crop: { left: 130, top: 430, width: 620, height: 460 }, resize: { width: 900 } },
  { src: '10.png', dst: 'producto-caja-l.png',
    crop: { left: 130, top: 430, width: 620, height: 460 }, resize: { width: 900 } },
  // 55.png caja XL (layout distinto: producto centrado grande, bubble $45 esquina superior derecha)
  // Producto (paquete solo): visualmente x=280-820, y=460-1020
  // Bubble: x=790-1050, y=430-680 → producto y bubble se traslapan en x
  // Recortar central sin bubble: x=280-780, y=460-970 → 500×510
  { src: '55.png', dst: 'producto-caja-xl.png',
    crop: { left: 360, top: 540, width: 380, height: 440 }, resize: { width: 900 } },
  { src: '45.png', dst: 'producto-prematuro.png',
    crop: { left: 380, top: 520, width: 380, height: 440 }, resize: { width: 900 } },
  { src: '30.png', dst: 'producto-wipes-caja.png',
    crop: { left: 410, top: 580, width: 340, height: 420 }, resize: { width: 900 } },
  // 4.png Wipes ADULTO – layout como 8 (caja marrón izquierda + paquete derecha, bubble derecha)
  // Producto x=180-780, y=470-950
  { src: '4.png',  dst: 'producto-wipes-adulto.png',
    crop: { left: 180, top: 470, width: 600, height: 480 }, resize: { width: 900 } },
  // 50.png Promo Nateen: 3 cajas juntas – para hero secundario
  { src: '50.png', dst: 'promo-nateen-familia.png',
    crop: { left: 60, top: 430, width: 960, height: 680 },
    resize: { width: 1200 } },

  // ---------- IMAGEN HERO (bebé real) ----------
  // 65.png tiene una foto real de un bebé (piecitos en moisés).
  { src: '65.png', dst: 'hero-bebe.png',
    crop: { left: 100, top: 570, width: 880, height: 680 },
    resize: { width: 1200 } },

  // ---------- BLOG / TIPS ----------
  { src: '3.png',  dst: 'tip-wipes-caja-beneficios.png', resize: { width: 900 } },
  { src: '6.png',  dst: 'tip-panalitis.png',            resize: { width: 900 } },
  { src: '40.png', dst: 'tip-cloro-tcf.png',            resize: { width: 900 } },
  { src: '60.png', dst: 'tip-lo-que-siente.png',        resize: { width: 900 } },
  { src: '61.png', dst: 'tip-quien-se-beneficia.png',   resize: { width: 900 } },
  { src: '66.png', dst: 'tip-senal-rojeces.png',        resize: { width: 900 } },
  { src: '70.png', dst: 'tip-cuando-pediatra.png',      resize: { width: 900 } },
  { src: '71.png', dst: 'tip-cta-final.png',            resize: { width: 900 } },
];

for (const job of jobs) {
  const inPath = path.join(SRC, job.src);
  const outPath = path.join(OUT, job.dst);
  let pipe = sharp(inPath);
  if (job.crop) pipe = pipe.extract(job.crop);
  if (job.resize) pipe = pipe.resize(job.resize);
  await pipe.png({ quality: 88, compressionLevel: 9 }).toFile(outPath);
  const stat = await fs.stat(outPath);
  console.log(`✓ ${job.dst}  ${(stat.size / 1024).toFixed(0)}KB`);
}

console.log('\nDone. Written to public/img/');
