#!/usr/bin/env node
/**
 * Auditor del panel: mide en un navegador de verdad lo que el §7 del sistema
 * de diseño exige, y guarda capturas.
 *
 * Por qué medido y no revisado a ojo: el §7 es un contrato con números —44 px
 * de alto táctil, 16 px en los campos, 12 px de piso en el texto, nada de
 * `100vh` ni de `min-width` en píxeles— y los números solo se comprueban
 * leyendo el estilo ya calculado. Una clase de Tailwind puede estar escrita
 * bien y quedar aplastada por otra; eso se ve aquí y no en el typecheck.
 *
 *   node scripts/auditar-panel.mjs                  mide y escribe capturas
 *   node scripts/auditar-panel.mjs --solo-medir     sin capturas
 *
 * Necesita el panel servido en BASE (por defecto http://127.0.0.1:4173).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const SALIDA = process.env.SALIDA ?? ".capturas";
const soloMedir = process.argv.includes("--solo-medir");

/** Las pantallas que hay. El cajón se audita aparte, abierto. */
const PANTALLAS = [
  ["resumen", "/"],
  ["catalogo", "/catalogo"],
  ["existencias", "/existencias"],
  ["bodegas", "/bodegas"],
  ["zonas", "/zonas"],
  ["ajustes", "/ajustes"],
  ["usuarios", "/usuarios"],
];

const VISTAS = [
  ["escritorio", { width: 1440, height: 900 }],
  // 390x844 es un iPhone 14; el teléfono real de la dueña no es más ancho.
  ["telefono", { width: 390, height: 844 }],
];

/**
 * Lo que se mide dentro de la página.
 *
 * Va como una función que se serializa al navegador, así que no puede usar
 * nada de fuera: todo lo que necesita entra por argumento o se declara aquí.
 */
function medir() {
  const fallas = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const donde = (el) => {
    const t = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `<${el.tagName.toLowerCase()}>${t ? ` «${t}»` : ""}`;
  };

  // 7a - 44 px de alto en todo lo que se toca. Un enlace dentro de un párrafo
  // no cuenta: lo táctil es lo que existe para tocarse.
  for (const el of document.querySelectorAll("button, a[href], [role='button'], summary")) {
    if (!visible(el)) continue;
    if (el.closest("p")) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 44 - 0.5) {
      fallas.push({ regla: "44px táctil", detalle: `${donde(el)} mide ${r.height.toFixed(1)}px de alto` });
    }
  }

  // 7b - 16 px en los campos. Con menos, iOS hace zoom al enfocar y la
  // pantalla se descoloca sola.
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (!visible(el)) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 16 - 0.01) {
      fallas.push({ regla: "16px en campos", detalle: `${donde(el)} tiene ${px}px` });
    }
  }

  // 7c - nada de texto por debajo de 12 px, ni aunque sea una nota al pie.
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const propio = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
    );
    if (!propio) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12 - 0.01) {
      fallas.push({ regla: "piso de 12px", detalle: `${donde(el)} tiene ${px}px` });
    }
  }

  // 7e - ni `100vh` (en el teléfono se la come la barra del navegador) ni
  // `min-width` en píxeles (obliga a hacer scroll de lado). Se miran las hojas
  // de estilo porque es ahí donde se escriben, no en el estilo calculado.
  for (const hoja of Array.from(document.styleSheets)) {
    let reglas;
    try {
      reglas = hoja.cssRules;
    } catch {
      continue; // De otro origen: no se puede leer, y tampoco es nuestra.
    }
    const recorrer = (lista) => {
      for (const regla of Array.from(lista)) {
        if (regla.cssRules) recorrer(regla.cssRules);
        const texto = regla.style?.cssText;
        if (!texto) continue;
        if (/\b100vh\b/.test(texto)) {
          fallas.push({ regla: "sin 100vh", detalle: `${regla.selectorText}: ${texto.slice(0, 80)}` });
        }
        const min = regla.style.minWidth;
        if (min && /\d(px)$/.test(min) && parseFloat(min) > 0) {
          fallas.push({ regla: "sin min-width en px", detalle: `${regla.selectorText}: min-width:${min}` });
        }
      }
    };
    recorrer(reglas);
  }

  // Se desborda de lado: el síntoma de todo lo de arriba cuando se escapa.
  const desborde = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (desborde > 1) {
    fallas.push({ regla: "sin scroll horizontal", detalle: `${desborde}px de más` });
  }

  return fallas;
}

const navegador = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

if (!soloMedir) await mkdir(SALIDA, { recursive: true });

const todas = [];
let revisadas = 0;

for (const [nombreVista, tamano] of VISTAS) {
  const contexto = await navegador.newContext({
    viewport: tamano,
    // Escala 2 para las capturas que va a ver una persona; el 7 se mide en
    // píxeles de CSS, que no cambian con la escala.
    deviceScaleFactor: soloMedir ? 1 : 2,
  });
  const pagina = await contexto.newPage();

  for (const [nombre, ruta] of PANTALLAS) {
    await pagina.goto(`${BASE}${ruta}`, { waitUntil: "networkidle" });
    // El panel pregunta `/api/yo` antes de pintar nada: hasta que haya un
    // encabezado, lo que se mediría es la pantalla de «cargando».
    await pagina.waitForSelector("h1", { timeout: 10000 });

    const fallas = await pagina.evaluate(medir);
    revisadas += 1;
    for (const f of fallas) todas.push({ vista: nombreVista, pantalla: nombre, ...f });

    if (!soloMedir) {
      await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-${nombre}.png`, fullPage: true });
    }
  }

  // El cajón, abierto: es donde viven el foco atrapado y los títulos de
  // sección, y cerrado no se mide nada de eso.
  if (nombreVista === "telefono") {
    await pagina.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await pagina.waitForSelector("h1");
    await pagina.getByRole("button", { name: /men/i }).first().click();
    await pagina.waitForTimeout(300);

    const fallas = await pagina.evaluate(medir);
    revisadas += 1;
    for (const f of fallas) todas.push({ vista: nombreVista, pantalla: "cajon-abierto", ...f });

    // Lo del 7d que sí se puede comprobar solo: el disparador anuncia que
    // está abierto y a qué, y el cajón es un diálogo con nombre.
    const aria = await pagina.evaluate(() => {
      const disparador = Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-expanded") === "true",
      );
      const id = disparador?.getAttribute("aria-controls");
      const cajon = id ? document.getElementById(id) : null;
      return {
        disparador: Boolean(disparador),
        apunta: Boolean(cajon),
        dialogo: cajon?.getAttribute("role") === "dialog",
        nombrado: Boolean(cajon?.getAttribute("aria-label")),
        titulos: cajon ? cajon.querySelectorAll("h2").length : 0,
        foco: cajon?.contains(document.activeElement) ?? false,
      };
    });
    const exigencias = [
      ["disparador", 'ningún botón declara aria-expanded="true" con el cajón abierto'],
      ["apunta", "aria-controls no apunta a ningún elemento"],
      ["dialogo", 'el cajón no es role="dialog"'],
      ["nombrado", "el cajón no tiene aria-label"],
      ["foco", "el foco no entró en el cajón al abrirlo"],
    ];
    for (const [clave, mensaje] of exigencias) {
      if (!aria[clave]) {
        todas.push({ vista: nombreVista, pantalla: "cajon-abierto", regla: "7d accesible", detalle: mensaje });
      }
    }
    if (aria.titulos < 2) {
      todas.push({
        vista: nombreVista,
        pantalla: "cajon-abierto",
        regla: "7d accesible",
        detalle: `solo ${aria.titulos} <h2> dentro del cajón: los títulos de sección han de ser encabezados de verdad`,
      });
    }

    // Escape cierra. Es la mitad del 7d y se comprueba en una línea.
    await pagina.keyboard.press("Escape");
    await pagina.waitForTimeout(300);
    const cerrado = await pagina.evaluate(
      () => !Array.from(document.querySelectorAll("button")).some((b) => b.getAttribute("aria-expanded") === "true"),
    );
    if (!cerrado) {
      todas.push({ vista: nombreVista, pantalla: "cajon-abierto", regla: "7d accesible", detalle: "Escape no cerró el cajón" });
    }
  }

  await contexto.close();
}

/* ---------------------------------------------------------------------------
   La frontera de errores.

   React desmonta el árbol entero cuando un render tira una excepción, así que
   sin frontera un campo inesperado del API deja la pantalla EN BLANCO. Se
   comprueba rompiendo una respuesta a propósito —aquí, no en el servidor de
   muestra, para no tener que montar un servidor roto— y mirando tres cosas: que
   NO quede en blanco, que la navegación siga viva para poder salir, y que irse
   a otra pestaña de verdad arregle la pantalla.
   --------------------------------------------------------------------------- */
{
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const pagina = await contexto.newPage();

  // `zonas: null` revienta en `d.zonas.length`, que es justo la forma de fallo
  // que dejó el panel en blanco la primera vez que se abrió en un navegador.
  await pagina.route("**/api/zonas", (ruta) =>
    ruta.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, datos: { zonas: null } }),
    }),
  );

  // `domcontentloaded` y no `networkidle`: SIN frontera, React reintenta el
  // render en bucle y la página no se asienta nunca, así que esperar a que la
  // red calle convierte un fallo claro en un tiempo agotado ilegible.
  await pagina.goto(`${BASE}/zonas`, { waitUntil: "domcontentloaded" });
  await pagina.waitForTimeout(1200);
  revisadas += 1;

  const tras = await pagina.evaluate(() => ({
    enBlanco: (document.body.innerText ?? "").trim().length === 0,
    avisa: /se rompió/i.test(document.body.innerText ?? ""),
    navegacionViva: document.querySelectorAll("nav a[href]").length > 0,
  }));

  const dice = [
    [!tras.enBlanco, "la pantalla quedó EN BLANCO: la frontera de errores no atrapó el fallo"],
    [tras.avisa, "no se ve ningún aviso de que la pantalla se rompió"],
    [tras.navegacionViva, "la navegación desapareció: no hay forma de salir de la pantalla rota"],
  ];
  for (const [bien, mensaje] of dice) {
    if (!bien) todas.push({ vista: "escritorio", pantalla: "frontera", regla: "frontera de errores", detalle: mensaje });
  }

  // Y que navegar la sane: la frontera se remonta con la ruta.
  if (tras.navegacionViva) {
    await pagina.getByRole("link", { name: "Resumen" }).first().click();
    await pagina.waitForTimeout(500);
    const sano = await pagina.evaluate(
      () => !/se rompió/i.test(document.body.innerText ?? "") && document.querySelectorAll("main *").length > 0,
    );
    if (!sano) {
      todas.push({
        vista: "escritorio",
        pantalla: "frontera",
        regla: "frontera de errores",
        detalle: "irse a otra pestaña no limpió la pantalla rota",
      });
    }
  }

  await contexto.close();
}

await navegador.close();

if (!soloMedir) {
  await writeFile(`${SALIDA}/informe.json`, `${JSON.stringify(todas, null, 2)}\n`);
}

console.log(`Medidas ${revisadas} pantallas en ${VISTAS.length} tamaños.`);
if (todas.length === 0) {
  console.log("Sin fallas del §7.");
  if (!soloMedir) console.log(`Capturas en ${SALIDA}/`);
  process.exit(0);
}

console.error(`\n${todas.length} falla(s) del §7:\n`);
const porRegla = new Map();
for (const f of todas) porRegla.set(f.regla, [...(porRegla.get(f.regla) ?? []), f]);
for (const [regla, lista] of porRegla) {
  console.error(`  ${regla} — ${lista.length}`);
  for (const f of lista.slice(0, 8)) console.error(`    [${f.vista}/${f.pantalla}] ${f.detalle}`);
  if (lista.length > 8) console.error(`    … y ${lista.length - 8} más`);
}
process.exit(1);
