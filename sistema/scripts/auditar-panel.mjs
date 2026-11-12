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
  ["cobros", "/cobros"],
  // La contabilidad no se había medido NUNCA, y es la pantalla más grande del
  // panel (mil líneas). Hasta que se engancharon los asientos no tenía datos
  // que enseñar, así que tampoco se había visto con nada dentro.
  ["contabilidad", "/contabilidad"],
  // Pedidos, entregas y pasarelas NO se medían, y no por descuido: el servidor
  // de muestra no traía datos para ellas, así que medirlas habría sido medir
  // una pantalla vacía. El hueco se destapó en un teléfono de verdad —los
  // filtros de pedidos rompían la caja— con CI en verde. Una auditoría que no
  // cubre una pantalla no dice «está bien»: no dice nada, y se lee igual.
  ["pedidos", "/pedidos"],
  ["entregas", "/entregas"],
  ["motorizados", "/motorizados"],
  ["pasarelas", "/pasarelas"],
  // Clientas sale DOS veces: aquí vacía —que es lo primero que ve la dueña al
  // entrar, porque la lista no se enseña sin buscar— y más abajo con
  // resultados y con la hoja abierta. Medir solo una de las dos diría que la
  // pantalla está bien habiendo mirado la mitad.
  ["clientas", "/clientas"],
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

  // La barra inferior es `position: fixed`: no empuja nada, así que si el
  // contenido no reserva su alto, la última fila queda DEBAJO de ella. Es un
  // fallo que no se ve en una captura de página entera —ahí la barra se dibuja
  // donde esté el viewport— y que en la mano significa que a la dueña le falta
  // el último producto de la lista sin ninguna señal de que falta.
  //
  // Se mide, no se estima: el hueco se escribe una vez en el CSS y el alto de
  // la barra cambia cada vez que alguien le toca un renglón.
  const barra = document.querySelector("nav.solo-telefono");
  const principal = document.querySelector("main.contenido");
  if (barra && principal && getComputedStyle(barra).display !== "none") {
    const alto = barra.getBoundingClientRect().height;
    const hueco = parseFloat(getComputedStyle(principal).paddingBottom);
    if (hueco < alto) {
      fallas.push({
        regla: "la barra no tapa el contenido",
        detalle: `la barra mide ${alto}px y el hueco es de ${hueco}px: faltan ${(alto - hueco).toFixed(1)}px`,
      });
    }
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

  // Las llaves de MCP: la pantalla y la hoja de crear.
  //
  // Lo que más riesgo tiene aquí es el bloque del token recién creado: es un
  // texto largo sin espacios, que es exactamente lo que desborda en un
  // teléfono. Por eso se mide la pantalla con la hoja abierta.
  {
    await pagina.goto(`${BASE}/llaves`, { waitUntil: "networkidle" });
    await pagina.waitForSelector("h1");
    const deLlaves = await pagina.evaluate(medir);
    revisadas += 1;
    for (const f of deLlaves) todas.push({ vista: nombreVista, pantalla: "llaves", ...f });
    if (!soloMedir) await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-llaves.png` });

    const crear = pagina.getByRole("button", { name: /Crear una llave/ }).first();
    if ((await crear.count()) > 0) {
      await crear.click();
      await pagina.waitForTimeout(300);
      const deHoja = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of deHoja) todas.push({ vista: nombreVista, pantalla: "hoja-crear-llave", ...f });
      if (!soloMedir) {
        await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-crear-llave.png` });
      }
      await pagina.keyboard.press("Escape");
      await pagina.waitForTimeout(150);
    }
  }

  // Caleb: el botón flotante y su hoja.
  //
  // Va en TODAS las pantallas, así que una falla suya se multiplica por doce.
  // Y la hoja de Caleb es la única del panel que crece sola mientras se usa
  // —cada respuesta añade una burbuja—, que es justo donde se rompen los
  // tamaños.
  {
    await pagina.goto(`${BASE}/pedidos`, { waitUntil: "networkidle" });
    const boton = pagina.getByRole("button", { name: /Preguntarle a Caleb/i }).first();
    if ((await boton.count()) > 0) {
      await boton.click();
      await pagina.waitForTimeout(300);

      // Con una pregunta ya contestada: la hoja vacía no mide las burbujas.
      const campo = pagina.getByPlaceholder("Pregúntele a Caleb");
      if ((await campo.count()) > 0) {
        await campo.fill("¿cuánto queda de la M?");
        await pagina.getByRole("button", { name: /^Enviar$/ }).first().click();
        await pagina.waitForTimeout(400);
      }

      const deCaleb = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of deCaleb) todas.push({ vista: nombreVista, pantalla: "hoja-caleb", ...f });
      if (!soloMedir) {
        await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-caleb.png` });
      }
      await pagina.keyboard.press("Escape");
      await pagina.waitForTimeout(150);
    }
  }

  // La hoja de hacer una COTIZACIÓN, en las dos vistas.
  //
  // Es la misma hoja que «Tomar un pedido» con otro modo, pero no es la misma
  // pantalla: cambia el título, el botón y —lo que importa— el aviso de que
  // esto NO aparta mercancía, que es un párrafo en caja y es justo donde se
  // rompe una caja. Y va fuera del bloque de «si es teléfono» porque la hoja
  // en computadora ya estuvo un año pegada a la esquina sin que nadie la
  // mirara (docs/TRAMPAS.md §4).
  {
    await pagina.goto(`${BASE}/pedidos`, { waitUntil: "networkidle" });
    const abrir = pagina.getByRole("button", { name: /Hacer una cotización/ }).first();
    const aparecio = await abrir
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!aparecio) {
      // Una hoja que no se puede abrir NO se da por buena en silencio.
      todas.push({
        vista: nombreVista,
        pantalla: "hoja-cotizacion",
        regla: "la hoja se puede abrir",
        detalle: "no encontré con qué abrirla en /pedidos",
      });
    } else {
      await abrir.click();
      await pagina.waitForTimeout(300);

      const suyas = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of suyas) todas.push({ vista: nombreVista, pantalla: "hoja-cotizacion", ...f });

      if (!soloMedir) {
        await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-cotizacion.png` });
      }

      /**
       * Y la pantalla de DESPUÉS de hacerla, que es la que importa.
       *
       * Es donde está el aviso de que una cotización no aparta mercancía: el
       * párrafo que separa un presupuesto de una venta. Medir solo la hoja en
       * blanco no lo mide nunca, y es justo el texto que la dueña va a leer
       * para entender qué acaba de hacer.
       *
       * Se llega como se llega de verdad: buscando la clienta, añadiendo un
       * producto y tocando el botón. Si algún paso no está, se dice en vez de
       * darlo por bueno en silencio.
       */
      const celular = pagina.getByPlaceholder("6000-0001");
      if ((await celular.count()) > 0) {
        await celular.fill("6000-0101");
        await pagina.getByRole("button", { name: /Buscar o dar de alta/ }).first().click();
        await pagina.waitForTimeout(300);

        const buscador = pagina.getByPlaceholder("Nombre, talla o código");
        await buscador.fill("ma");
        await pagina.waitForTimeout(250);
        const anadir = pagina.getByRole("button", { name: /Añadir/ }).first();
        if ((await anadir.count()) > 0) {
          await anadir.click();
          await pagina.waitForTimeout(150);
        }

        const hacerla = pagina.getByRole("button", { name: /^Hacer la cotización$/ });
        if ((await hacerla.count()) > 0 && (await hacerla.first().isEnabled())) {
          await hacerla.first().click();
          await pagina.waitForTimeout(400);

          const hecha = await pagina.evaluate(medir);
          revisadas += 1;
          for (const f of hecha) {
            todas.push({ vista: nombreVista, pantalla: "hoja-cotizacion-hecha", ...f });
          }
          if (!soloMedir) {
            await pagina.screenshot({
              path: `${SALIDA}/${nombreVista}-hoja-cotizacion-hecha.png`,
            });
          }
        } else {
          todas.push({
            vista: nombreVista,
            pantalla: "hoja-cotizacion-hecha",
            regla: "la cotización se puede hacer",
            detalle: "el botón de hacerla no llegó a habilitarse",
          });
        }
      }

      await pagina.keyboard.press("Escape");
      await pagina.waitForTimeout(150);
    }
  }

  // Y la hoja de ACTUAR sobre una cotización: la que lleva el botón de
  // confirmar y el aviso de que ahí se aparta el inventario. Se abre sobre
  // BC-1040, que es la cotización del panel de muestra.
  {
    await pagina.goto(`${BASE}/pedidos`, { waitUntil: "networkidle" });
    const fila = pagina.getByRole("button", { name: /BC-1040/ }).first();
    const aparecio = await fila
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!aparecio) {
      todas.push({
        vista: nombreVista,
        pantalla: "hoja-acciones-cotizacion",
        regla: "la hoja se puede abrir",
        detalle: "no hay ninguna cotización en /pedidos sobre la que actuar",
      });
    } else {
      await fila.click();
      await pagina.waitForTimeout(300);

      const suyas = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of suyas) {
        todas.push({ vista: nombreVista, pantalla: "hoja-acciones-cotizacion", ...f });
      }

      // La captura va ANTES de desplegar el descarte: si se tomara después,
      // el archivo que dice «acciones» enseñaría la hoja ya abierta en el
      // descarte, y quien la mire creería que eso es lo primero que ve la
      // dueña. Una captura con el nombre de otro estado es peor que no
      // tenerla.
      if (!soloMedir) {
        await pagina.screenshot({
          path: `${SALIDA}/${nombreVista}-hoja-acciones-cotizacion.png`,
        });
      }

      // Y con el «¿por qué se descarta?» desplegado, que es donde está el
      // campo: una hoja medida sin él no mide los 16 px del §7b.
      const descartar = pagina
        .locator("dialog.hoja[open]")
        .getByRole("button", { name: /Descartar la cotización/ });
      if ((await descartar.count()) > 0) {
        await descartar.click();
        await pagina.waitForTimeout(200);
        const conCampo = await pagina.evaluate(medir);
        revisadas += 1;
        for (const f of conCampo) {
          todas.push({ vista: nombreVista, pantalla: "hoja-descartar-cotizacion", ...f });
        }
        if (!soloMedir) {
          await pagina.screenshot({
            path: `${SALIDA}/${nombreVista}-hoja-descartar-cotizacion.png`,
          });
        }
      }

      await pagina.keyboard.press("Escape");
      await pagina.waitForTimeout(150);
    }
  }

  // La hoja en ESCRITORIO.
  //
  // Todo el bloque de hojas de abajo vive dentro del «si es teléfono», que se
  // escribió para el cajón y se llevó las hojas por delante. Resultado: no
  // había ni una captura de una hoja en computadora, y la hoja llevaba desde
  // el primer día pegada a la esquina de arriba a la izquierda — en cada
  // pedido, cada ajuste y cada movimiento de inventario. Nadie lo vio porque
  // nadie lo miraba.
  //
  // Se mide el centrado, no solo el §7: una captura enseña que la hoja sale,
  // y lo que estaba mal era DÓNDE salía.
  if (nombreVista === "escritorio") {
    await pagina.goto(`${BASE}/pedidos`, { waitUntil: "networkidle" });
    const abrirEnEscritorio = pagina.getByRole("button", { name: /Tomar un pedido/ }).first();
    if ((await abrirEnEscritorio.count()) > 0) {
      await abrirEnEscritorio.click();
      await pagina.waitForTimeout(300);

      const deHoja = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of deHoja) {
        todas.push({ vista: nombreVista, pantalla: "hoja-tomar-pedido", ...f });
      }

      const desvio = await pagina.evaluate(() => {
        const d = document.querySelector("dialog.hoja[open]");
        if (d === null) return null;
        const r = d.getBoundingClientRect();
        // Lo que sobra a cada lado. Si la hoja está centrada, es lo mismo.
        return Math.abs(r.left - (window.innerWidth - r.right));
      });
      if (desvio !== null && desvio > 2) {
        todas.push({
          vista: nombreVista,
          pantalla: "hoja-tomar-pedido",
          regla: "hoja centrada en escritorio",
          detalle: `sobran ${Math.round(desvio)}px más de un lado que del otro`,
        });
      }

      if (!soloMedir) {
        await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-tomar-pedido.png` });
      }
      await pagina.keyboard.press("Escape");
      await pagina.waitForTimeout(150);
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
    // La hoja de editar también es una pantalla, y es la que TIENE los campos:
    // el §7 pide 16 px en ellos y 44 px en lo que se toca, y una hoja que se
    // mide a ojo es una hoja en la que el teléfono hace zoom al escribir el
    // precio. Se mide con ella abierta, que es cuando existe.
    await pagina.goto(`${BASE}/catalogo`, { waitUntil: "networkidle" });
    const abridor = pagina.locator("dialog.hoja").first();
    const fila = pagina.getByRole("button", { name: /Body manga larga pima/ }).first();
    if ((await fila.count()) > 0) {
      await fila.click();
      await pagina.waitForTimeout(300);
      const deLaHoja = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of deLaHoja) todas.push({ vista: nombreVista, pantalla: "hoja-editar", ...f });

      // La hoja de mover existencias es la otra que tiene campos, y además
      // seis opciones que se tocan con el pulgar: el §7 pide 44 px en cada
      // una. Se mide abierta, igual que la de editar.
      await pagina.goto(`${BASE}/existencias`, { waitUntil: "networkidle" });
      const filaStock = pagina
        .getByRole("button", { name: /Set de 3 mantas de muselina/ })
        .first();
      if ((await filaStock.count()) > 0) {
        await filaStock.click();
        await pagina.waitForTimeout(300);
        const deLaHojaStock = await pagina.evaluate(medir);
        revisadas += 1;
        for (const f of deLaHojaStock) {
          todas.push({ vista: nombreVista, pantalla: "hoja-mover-stock", ...f });
        }
        if (!soloMedir) {
          await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-mover-stock.png` });
        }
        await pagina.keyboard.press("Escape");
      }
      // Tomar un pedido es la hoja más larga del panel: la clienta, el
      // catálogo entero con una casilla por producto, la zona y las notas. Si
      // alguna se mide a ojo, es la que hace zoom al escribir en un teléfono.
      await pagina.goto(`${BASE}/pedidos`, { waitUntil: "networkidle" });
      const tomar = pagina.getByRole("button", { name: /Tomar un pedido/ }).first();
      if ((await tomar.count()) > 0) {
        await tomar.click();
        await pagina.waitForTimeout(300);
        const deTomar = await pagina.evaluate(medir);
        revisadas += 1;
        for (const f of deTomar) todas.push({ vista: nombreVista, pantalla: "hoja-tomar-pedido", ...f });
        if (!soloMedir) {
          await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-tomar-pedido.png` });
        }

        // Con el buscador escrito. Es un estado DISTINTO y es el que más
        // riesgo tiene: las filas de resultado solo existen mientras hay
        // consulta, así que medir la hoja vacía no las mide nunca.
        const buscador = pagina.getByPlaceholder("Nombre, talla o código");
        if ((await buscador.count()) > 0) {
          await buscador.fill("ma"); // «manga» y «mantas» en el catálogo de muestra: filas de verdad
          await pagina.waitForTimeout(250);
          const deBuscar = await pagina.evaluate(medir);
          revisadas += 1;
          for (const f of deBuscar) {
            todas.push({ vista: nombreVista, pantalla: "hoja-tomar-pedido-buscando", ...f });
          }
          if (!soloMedir) {
            await pagina.screenshot({
              path: `${SALIDA}/${nombreVista}-hoja-tomar-pedido-buscando.png`,
            });
          }
        }

        await pagina.keyboard.press("Escape");
        await pagina.waitForTimeout(150);
      }

      /**
       * Las hojas de bodegas, zonas y usuarios.
       *
       * Son las tres pantallas que hasta hace poco solo leían, así que sus
       * hojas son lo más nuevo del panel — y lo más nuevo es lo que nadie ha
       * mirado todavía en un teléfono. Las cuatro tienen campos, y una hoja
       * con un campo a 14 px es una hoja en la que el teléfono hace zoom al
       * escribir (§7b).
       *
       * Van en una tabla y no copiadas cuatro veces: lo único que cambia entre
       * ellas es dónde se toca para abrirlas.
       */
      const HOJAS = [
        // La de la bodega se abre y además se marca «Dejar de usarla», porque
        // el aviso de las unidades que quedan dentro solo existe entonces — y
        // es justo lo que hay que mirar en la captura.
        {
          nombre: "hoja-bodega",
          ruta: "/bodegas",
          abrir: /Principal/,
          despues: async (p) => {
            // El radio DENTRO de la hoja, por su papel. Buscarlo por texto
            // encontraba el párrafo de la tarjeta de arriba —que explica lo
            // mismo con las mismas palabras— y el clic se quedaba esperando
            // detrás del diálogo para siempre.
            const apagar = p
              .locator("dialog.hoja[open]")
              .getByRole("radio", { name: /Dejar de usarla/ });
            if ((await apagar.count()) > 0) await apagar.check();
          },
        },
        {
          // Se elige el origen a propósito: el desplegable de «qué se mueve»
          // no existe hasta entonces, y una hoja medida vacía deja sin medir
          // justo el campo con el que se trabaja.
          nombre: "hoja-traslado",
          ruta: "/bodegas",
          abrir: /Trasladar mercancía/,
          despues: async (p) => {
            await p.locator("dialog.hoja[open] select").first().selectOption({ index: 1 });
          },
        },
        // La zona del interior: es la que viene «se cotiza a mano», o sea la
        // que enseña las dos formas de cobrar y no solo la del número.
        { nombre: "hoja-zona", ruta: "/zonas", abrir: /^Interior/ },
        // El alta, que es la hoja de usuarios con campos; la de quitar el
        // acceso se mide después.
        { nombre: "hoja-usuario-alta", ruta: "/usuarios", abrir: /Dar de alta/ },
        { nombre: "hoja-usuario", ruta: "/usuarios", abrir: /Yarielis/ },
      ];

      for (const hoja of HOJAS) {
        await pagina.goto(`${BASE}${hoja.ruta}`, { waitUntil: "networkidle" });
        const disparador = pagina.getByRole("button", { name: hoja.abrir }).first();
        // Se ESPERA a que aparezca, no se cuenta y ya. `count()` contesta al
        // instante, y el panel pinta después de contestar `/api/yo` y la
        // consulta de la pantalla: en una máquina ocupada, contar sin esperar
        // da cero sobre una pantalla que está perfecta. Pasó aquí —cinco
        // hojas «sin forma de abrirlas» justo después de correr la suite— y
        // el fallo era del guion, no del panel.
        const aparecio = await disparador
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (!aparecio) {
          // Una hoja que no se puede abrir NO se da por buena en silencio: una
          // pantalla que la auditoría no mide no dice «está bien», no dice
          // nada. Se cuenta como falla para que se vea.
          todas.push({
            vista: nombreVista,
            pantalla: hoja.nombre,
            regla: "la hoja se puede abrir",
            detalle: `no encontré con qué abrirla en ${hoja.ruta}`,
          });
          continue;
        }
        await disparador.click();
        await pagina.waitForTimeout(300);
        if (hoja.despues) await hoja.despues(pagina);
        await pagina.waitForTimeout(150);

        const suyas = await pagina.evaluate(medir);
        revisadas += 1;
        for (const f of suyas) todas.push({ vista: nombreVista, pantalla: hoja.nombre, ...f });

        if (!soloMedir) {
          await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-${hoja.nombre}.png` });
        }
        await pagina.keyboard.press("Escape");
        await pagina.waitForTimeout(150);
      }

      // Y la de agendar/cancelar, que es donde se toca un pedido de verdad.
      await pagina.goto(`${BASE}/pedidos`, { waitUntil: "networkidle" });
      const unPedido = pagina.getByRole("button", { name: /BC-1041/ }).first();
      if ((await unPedido.count()) > 0) {
        await unPedido.click();
        await pagina.waitForTimeout(300);
        const deAcciones = await pagina.evaluate(medir);
        revisadas += 1;
        for (const f of deAcciones) {
          todas.push({ vista: nombreVista, pantalla: "hoja-acciones-pedido", ...f });
        }
        if (!soloMedir) {
          await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-acciones-pedido.png` });
        }
        await pagina.keyboard.press("Escape");
      }

      await pagina.goto(`${BASE}/catalogo`, { waitUntil: "networkidle" });
      await fila.click();
      await pagina.waitForTimeout(200);

      // La hoja tiene que ser un <dialog> ABIERTO CON showModal: solo así trae
      // la trampa de foco y el fondo inerte. Un <dialog open> puesto a mano se
      // ve igual y no hace nada de eso.
      const modal = await pagina.evaluate(() => {
        // EL QUE ESTÁ ABIERTO, no el primero del documento. En la página hay
        // más de una hoja montada a la vez —la de «producto nuevo» vive
        // cerrada esperando su botón— y `querySelector("dialog.hoja")` cogía
        // esa, dando por rota una hoja que estaba perfecta. Lo destapó añadir
        // la segunda hoja: hasta entonces solo había una y el selector
        // alcanzaba.
        const d = document.querySelector("dialog.hoja[open]");
        return {
          existe: d !== null,
          // `:modal` solo casa con un diálogo abierto con showModal().
          modal: d !== null && d.matches(":modal"),
          nombrado: d?.getAttribute("aria-labelledby") !== null,
          dentro: d !== null && d.contains(document.activeElement),
        };
      });
      for (const [clave, mensaje] of [
        ["existe", "la hoja de editar no se abrió"],
        ["modal", "la hoja no se abrió con showModal(): sin trampa de foco ni fondo inerte"],
        ["nombrado", "la hoja no tiene nombre accesible"],
        ["dentro", "el foco no entró en la hoja al abrirla"],
      ]) {
        if (!modal[clave]) {
          todas.push({ vista: nombreVista, pantalla: "hoja-editar", regla: "7d accesible", detalle: mensaje });
        }
      }
      if (!soloMedir) {
        await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-editar.png`, fullPage: false });
      }
      await pagina.keyboard.press("Escape");
      void abridor;
    }

    // Clientas con resultados y con la ficha abierta. La lista no sale hasta
    // que se escribe algo —es a propósito: nombres y teléfonos de personas no
    // se listan solos— así que aquí se escribe, igual que haría la dueña.
    //
    // La hoja de la ficha es la que TIENE los campos: el apellido, la cédula y
    // la dirección de facturación. Medirla a ojo es dejar que el teléfono haga
    // zoom al escribir una cédula.
    await pagina.goto(`${BASE}/clientas`, { waitUntil: "networkidle" });
    const buscador = pagina.getByPlaceholder(/Celular o nombre/i).first();
    if ((await buscador.count()) > 0) {
      await buscador.fill("muestra");
      await pagina.waitForTimeout(400);
      const conResultados = await pagina.evaluate(medir);
      revisadas += 1;
      for (const f of conResultados) {
        todas.push({ vista: nombreVista, pantalla: "clientas-buscada", ...f });
      }
      if (!soloMedir) {
        await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-clientas-buscada.png`, fullPage: true });
      }

      const unaClienta = pagina.getByRole("button", { name: /Clienta De Muestra Villarreal/ }).first();
      if ((await unaClienta.count()) > 0) {
        await unaClienta.click();
        await pagina.waitForTimeout(400);
        const deLaFicha = await pagina.evaluate(medir);
        revisadas += 1;
        for (const f of deLaFicha) {
          todas.push({ vista: nombreVista, pantalla: "hoja-ficha-clienta", ...f });
        }
        if (!soloMedir) {
          await pagina.screenshot({ path: `${SALIDA}/${nombreVista}-hoja-ficha-clienta.png` });
        }
        await pagina.keyboard.press("Escape");
        await pagina.waitForTimeout(150);
      }
    }

    // El cajón otra vez, que es lo que miden las comprobaciones de abajo: las
    // pantallas de arriba lo dejaron cerrado.
    await pagina.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await pagina.waitForSelector("h1");
    await pagina.getByRole("button", { name: /men/i }).first().click();
    await pagina.waitForTimeout(300);

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
