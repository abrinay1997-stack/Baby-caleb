#!/usr/bin/env node
/**
 * Lo que el auditor mide, y las pruebas de que de verdad lo mide.
 *
 * Vivía dentro de `auditar-panel.mjs`. Se saca aquí por una razón concreta:
 * **el auditor no tenía ninguna prueba**. Es un guion que dice «sin fallas» y
 * en el que todo el mundo confía, y ya pasó dos veces que dijera eso mientras
 * una regla no medía nada —los dos arreglos de CSS de una tanda se rompieron a
 * propósito y el auditor siguió en verde (`docs/TRAMPAS.md` §11)—. Un control
 * que aprueba siempre no es un control: es un permiso.
 *
 * Así que al lado de cada regla va su par de muestras: un trozo de HTML que
 * TIENE que suspender y otro que TIENE que aprobar. El auditor las corre
 * antes de mirar el panel, y si una regla deja de señalar su propia muestra,
 * se para y lo dice. La regla se rompe sola para demostrar que sirve.
 */

export /**
 * Lo que se mide dentro de la página.
 *
 * Va como una función que se serializa al navegador, así que no puede usar
 * nada de fuera: todo lo que necesita entra por argumento o se declara aquí.
 */
function medir() {
  const fallas = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    // `checkVisibility` es lo único que caza lo que está DENTRO de un
    // `<details>` cerrado: ahí el elemento conserva su tamaño y su
    // `visibility`, así que las dos comprobaciones de arriba lo dan por
    // visible y el auditor mide —y aprueba, o suspende— algo que nadie puede
    // ver. Dio un falso positivo en Pasarelas.
    return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
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

  // 7d - La burbuja de Caleb no se sienta encima de nada que se toque.
  //
  // Es la hermana de la comprobación de la barra, y hacía falta por lo mismo:
  // la burbuja está FIJA, así que en una captura de página entera se dibuja
  // una sola vez, donde estuviera el viewport, encima de una fila cualquiera
  // —y eso es el artefacto, no el fallo—. El fallo de verdad es que el
  // contenido no reserve su hueco, y entonces en la mano hay un botón debajo
  // de la burbuja.
  //
  // Tapaba «No cuadra» en Cobros, que está al lado de «Confirmar: el dinero
  // entró». Se arregló, y los dos arreglos de CSS de esa tanda —éste y el de
  // la cifra clave— se rompieron a propósito y el auditor siguió diciendo
  // «sin fallas»: medían todo menos justo esto. Por eso están aquí.
  //
  // Se mide con la página abajo del todo, que es donde la última fila queda
  // más cerca de la burbuja; quien llama a esto hace el scroll antes.
  const burbuja = document.querySelector(".burbuja-caleb");
  if (burbuja && visible(burbuja)) {
    const b = burbuja.getBoundingClientRect();
    const dentroDelPrincipal = document.querySelectorAll(
      "main button, main a[href], main [role='button'], main summary, main input, main select, main textarea",
    );
    for (const el of dentroDelPrincipal) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Se solapan de verdad: dos rectángulos que solo se rozan por un píxel
      // no esconden nada, y perseguir eso daría rojos que nadie puede
      // arreglar.
      const ancho = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const alto = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (ancho > 1 && alto > 1) {
        fallas.push({
          regla: "la burbuja no tapa lo que se toca",
          detalle: `la burbuja cubre ${Math.round(ancho)}×${Math.round(alto)}px de ${donde(el)}`,
        });
      }
    }
  }

  // 7e - En el teléfono, la cifra que se viene a buscar va ARRIBA A LA
  // DERECHA.
  //
  // El CSS lo declara en prosa desde siempre y se rompía sin que nada lo
  // dijera: cuando la celda del título crecía a dos líneas, la cifra se caía
  // al renglón de abajo y aterrizaba entre dos datos sueltos. En Bodegas se
  // leía «Principal 412 Productos 96 unidades», con otro número metido entre
  // el dato y su unidad; y en Existencias se caía justo en las filas bajas de
  // stock, que son las que se viene a mirar.
  //
  // Solo en el teléfono: en la computadora las filas son columnas de tabla y
  // la regla es otra.
  if (window.innerWidth <= 480) {
    for (const fila of document.querySelectorAll(".filas")) {
      if (!visible(fila)) continue;
      const titulo = fila.querySelector('.celda[data-papel="titulo"]');
      const clave = fila.querySelector('.celda[data-papel="clave"]');
      if (!titulo || !clave || !visible(titulo) || !visible(clave)) continue;

      const t = titulo.getBoundingClientRect();
      const c = clave.getBoundingClientRect();
      const caja = fila.getBoundingClientRect();
      const relleno = parseFloat(getComputedStyle(fila).paddingRight);

      // Comparten el PRIMER renglón: la cifra tiene que empezar dentro de la
      // primera línea del título, no debajo de ella. Se mide contra el alto de
      // una línea del título y no contra su caja entera, que con dos líneas
      // abarcaría también el renglón de abajo y daría por buena justo la
      // forma que esto vigila.
      const unaLinea = parseFloat(getComputedStyle(titulo).lineHeight) || t.height;
      if (c.top > t.top + unaLinea * 0.75) {
        fallas.push({
          regla: "la cifra clave comparte línea con el título",
          detalle: `la cifra de ${donde(titulo)} cayó ${Math.round(c.top - t.top)}px por debajo`,
        });
      }

      // Y toca el borde derecho. Si no, está flotando en medio de la fila,
      // que es como se leía «412 Productos 96».
      const margen = caja.right - relleno - c.right;
      if (margen > 2) {
        fallas.push({
          regla: "la cifra clave va pegada a la derecha",
          detalle: `la cifra de ${donde(titulo)} quedó a ${Math.round(margen)}px del borde`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Accesibilidad
  //
  // Hasta aquí el auditor medía TAMAÑOS: 44 px, 16 px, el piso de 12. Eso es
  // la mitad del §7 y ninguna de las reglas que hacen que un panel se pueda
  // usar de verdad. Contraste, foco, etiquetas y orden de encabezados no los
  // miraba nadie, así que «sin fallas del §7» convivía con texto gris claro
  // sobre crema y con campos sin nombre.
  //
  // Son las de la WCAG 2.2 AA, que no es burocracia: es la lista de lo que
  // deja a alguien fuera. Y aquí la persona que usa esto lo hace con una mano,
  // al sol, con prisa.
  // -------------------------------------------------------------------------

  /** El color de fondo de VERDAD: el primero que no sea transparente. */
  const fondoDe = (el) => {
    let actual = el;
    while (actual) {
      const c = getComputedStyle(actual).backgroundColor;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b, a] = m[1].split(",").map((x) => parseFloat(x));
        if (a === undefined || a > 0.95) return [r, g, b];
      }
      actual = actual.parentElement;
    }
    // Si nada era opaco —ni el elemento, ni la fila, ni el cuerpo, ni el
    // `html`— lo que se pinta debajo es el lienzo del navegador, que es
    // blanco. Leer aquí el fondo del cuerpo sería leer `rgba(0,0,0,0)` y
    // medir contra NEGRO: el texto gris claro saldría aprobado y el oscuro
    // suspendido, o sea la regla exactamente al revés.
    return [255, 255, 255];
  };

  /** Luminancia relativa, tal como la define la WCAG. */
  const luz = ([r, g, b]) => {
    const canal = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
  };

  const contraste = (a, b) => {
    const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  // 7f - Contraste de verdad, medido en píxeles.
  //
  // No se confía en los tokens: un token puede estar bien y aplicarse sobre
  // un fondo que no es el que se pensó. Se mide el color que sale.
  const yaDicho = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const propio = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    if (!propio) continue;

    const estilo = getComputedStyle(el);
    const m = estilo.color.match(/rgba?\(([^)]+)\)/);
    if (!m) continue;
    const partes = m[1].split(",").map((x) => parseFloat(x));
    // Un texto casi transparente ya es otro problema; medirlo daría un número
    // que no significa nada.
    if (partes[3] !== undefined && partes[3] < 0.9) continue;

    const px = parseFloat(estilo.fontSize);
    const grande = px >= 24 || (px >= 18.66 && parseInt(estilo.fontWeight, 10) >= 700);
    const minimo = grande ? 3 : 4.5;
    const r = contraste(partes.slice(0, 3), fondoDe(el));

    if (r < minimo) {
      // Una clase sale UNA vez: el mismo gris repetido en cuarenta filas es un
      // solo arreglo, y cuarenta líneas de informe lo esconden.
      const firma = `${el.className}|${estilo.color}|${px}`;
      if (yaDicho.has(firma)) continue;
      yaDicho.add(firma);
      fallas.push({
        regla: "contraste 4.5:1",
        detalle: `${donde(el)} sale a ${r.toFixed(2)}:1 y necesita ${minimo}:1 (${px}px)`,
      });
    }
  }

  // 7g - Todo lo que se enfoca, se VE enfocado.
  //
  // Quien navega con teclado —o con el teclado del teléfono abierto— pierde
  // el sitio si el foco no se dibuja. Se comprueba enfocando de verdad y
  // mirando si algo cambia: un `outline`, una sombra, un borde o el fondo.
  //
  // IMPORTANTE: quien llama a esto tiene que pulsar un Tab antes.
  // El panel dibuja el aro con `:focus-visible`, y Chrome lo APAGA cuando la
  // última cosa que hizo la persona fue tocar con el ratón: un `focus()` por
  // programa después de un clic no lo enciende. El auditor abre las hojas con
  // clics, así que sin ese Tab medía el panel en modo ratón y acusaba a 86
  // botones de no tener aro. Lo tienen, y es de 2 px. Una sola pulsación de
  // teclado pone al navegador en el modo en que de verdad se usa el teclado,
  // y ahí la medida es la que ve esa persona.
  {
    const antes = { x: window.scrollX, y: window.scrollY };
    const activo = document.activeElement;
    const enfocables = [...document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])",
    )].filter(visible).slice(0, 60);

    const retrato = (el) => {
      const e = getComputedStyle(el);
      return `${e.outlineStyle}|${e.outlineWidth}|${e.boxShadow}|${e.borderColor}|${e.backgroundColor}`;
    };

    for (const el of enfocables) {
      if (el.disabled === true) continue;
      // Puede llegar YA enfocado: una hoja modal enfoca sola su primer botón
      // al abrirse, y quien llama a esto pulsa un Tab antes de medir. Leer su
      // retrato «quieto» en ese estado es compararlo consigo mismo: salía que
      // el botón «Cerrar» de cada hoja no dibujaba su foco, y lo dibujaba.
      if (document.activeElement === el) el.blur();
      const quieto = retrato(el);
      el.focus({ preventScroll: true });
      // Si el foco NO llegó, no hay nada que juzgar: el elemento está apagado,
      // o detrás de una hoja abierta —donde el navegador lo vuelve `inert` a
      // propósito— o no es enfocable de verdad. Sin esto la regla acusaba a
      // 1 130 elementos de no dibujar su foco, y la mayoría eran enlaces de la
      // navegación con un diálogo abierto encima: lo correcto es justo que no
      // se puedan enfocar. Un informe así no se lee: se descarta entero, y con
      // él las fallas de verdad que traía dentro.
      if (document.activeElement !== el) continue;
      const puesto = retrato(el);
      if (quieto === puesto) {
        fallas.push({
          regla: "el foco se ve",
          detalle: `${donde(el)} no cambia nada al enfocarse`,
        });
      }
    }
    if (activo instanceof HTMLElement) activo.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(antes.x, antes.y);
  }

  // 7h - Cada campo tiene nombre, y cada botón de solo icono también.
  //
  // Un texto al lado NO es una etiqueta: el lector de pantalla lee el campo
  // solo y dice «cuadro de edición», sin más. Y un botón que solo lleva un
  // icono se anuncia como «botón», que no le sirve a nadie.
  const nombreDe = (el) => {
    if ((el.getAttribute("aria-label") ?? "").trim() !== "") return true;
    const por = el.getAttribute("aria-labelledby");
    if (por && por.split(/\s+/).some((id) => document.getElementById(id))) return true;
    if ((el.getAttribute("title") ?? "").trim() !== "") return true;
    return false;
  };

  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (!visible(el)) continue;
    if (el.type === "hidden") continue;
    if (nombreDe(el)) continue;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) continue;
    if (el.closest("label")) continue;
    fallas.push({ regla: "cada campo con su etiqueta", detalle: donde(el) });
  }

  for (const el of document.querySelectorAll("button, a[href], [role='button']")) {
    if (!visible(el)) continue;
    if ((el.textContent ?? "").trim() !== "") continue;
    if (nombreDe(el)) continue;
    fallas.push({
      regla: "un icono solo necesita nombre",
      detalle: `<${el.tagName.toLowerCase()}> sin texto ni aria-label`,
    });
  }

  // 7i - Los encabezados no saltan niveles.
  //
  // Quien navega con lector de pantalla salta de encabezado en encabezado: si
  // se pasa de h1 a h3, lo que oye es que falta una sección.
  {
    const niveles = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(visible)
      .map((h) => ({ n: Number(h.tagName[1]), el: h }));
    for (let i = 1; i < niveles.length; i++) {
      const salto = niveles[i].n - niveles[i - 1].n;
      if (salto > 1) {
        fallas.push({
          regla: "los encabezados no saltan",
          detalle: `de h${niveles[i - 1].n} a h${niveles[i].n} en ${donde(niveles[i].el)}`,
        });
      }
    }
    if (niveles.length > 0 && niveles[0].n !== 1) {
      fallas.push({
        regla: "los encabezados no saltan",
        detalle: `la pantalla empieza en h${niveles[0].n}, no en h1`,
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

/**
 * Una muestra por regla: lo que tiene que suspender y lo que tiene que
 * aprobar.
 *
 * `rompe` es un HTML con el fallo que la regla busca; `cumple` es el mismo
 * caso bien hecho. La prueba no mira el resto de las reglas: en una muestra de
 * contraste salta también la de 44 px, y da igual — lo que se comprueba es que
 * ESA regla señala su fallo y no señala lo que está bien.
 *
 * `ancho` solo hace falta donde la regla únicamente aplica en el teléfono.
 *
 * `seccion` es el apartado del §7 que esta regla hace cumplir
 * (`docs/design-system.md`). No es decoración: `test/node/el-septimo-se-mide.test.ts`
 * compara las dos listas y se pone rojo si el contrato dice algo que nadie
 * mide, o si se mide algo que el contrato no dice. Las dos mitades vivían
 * sueltas y ya se habían separado: la burbuja de Caleb y la cifra clave se
 * medían desde hacía semanas sin estar escritas en ninguna parte.
 */
export const PRUEBAS = [
  {
    regla: "44px táctil",
    seccion: "7a",
    rompe: `<button style="height:30px">Confirmar</button>`,
    cumple: `<button style="height:44px">Confirmar</button>`,
  },
  {
    regla: "16px en campos",
    seccion: "7b",
    rompe: `<input style="font-size:13px" aria-label="Celular">`,
    cumple: `<input style="font-size:16px" aria-label="Celular">`,
  },
  {
    regla: "piso de 12px",
    seccion: "7c",
    rompe: `<p style="font-size:10px">Nota al pie</p>`,
    cumple: `<p style="font-size:12px">Nota al pie</p>`,
  },
  {
    regla: "sin 100vh",
    seccion: "7e",
    rompe: `<style>.alto{height:100vh}</style><div class="alto"></div>`,
    cumple: `<style>.alto{height:100dvh}</style><div class="alto"></div>`,
  },
  {
    regla: "sin min-width en px",
    seccion: "7e",
    rompe: `<style>.tabla{min-width:640px}</style><div class="tabla"></div>`,
    cumple: `<style>.tabla{min-width:0}</style><div class="tabla"></div>`,
  },
  {
    // El gris claro sobre blanco: el fallo más común y el más invisible,
    // porque en la pantalla de quien lo escribe se lee perfectamente.
    regla: "contraste 4.5:1",
    seccion: "7h",
    rompe: `<div style="background:#fff;color:#b9b9b9;font-size:14px">Total del día</div>`,
    cumple: `<div style="background:#fff;color:#3a3a3a;font-size:14px">Total del día</div>`,
  },
  {
    regla: "el foco se ve",
    seccion: "7i",
    // Con `:focus-visible`, que es el mecanismo real del panel: una muestra
    // escrita con `:focus` aprobaría la regla sin probar lo que falla.
    rompe: `<style>button{outline:none}button:focus-visible{outline:none}</style><button style="height:44px">Guardar</button>`,
    cumple: `<style>button:focus-visible{outline:3px solid #06c}</style><button style="height:44px">Guardar</button>`,
  },
  {
    regla: "cada campo con su etiqueta",
    seccion: "7j",
    rompe: `<input style="font-size:16px">`,
    cumple: `<label for="cel">Celular</label><input id="cel" style="font-size:16px">`,
  },
  {
    regla: "un icono solo necesita nombre",
    seccion: "7j",
    rompe: `<button style="height:44px"><svg width="20" height="20"></svg></button>`,
    cumple: `<button style="height:44px" aria-label="Cerrar"><svg width="20" height="20"></svg></button>`,
  },
  {
    regla: "los encabezados no saltan",
    seccion: "7k",
    rompe: `<h1>Pedidos</h1><h3>De hoy</h3>`,
    cumple: `<h1>Pedidos</h1><h2>De hoy</h2>`,
  },
  {
    regla: "sin scroll horizontal",
    seccion: "7g",
    rompe: `<div style="width:3000px;height:10px"></div>`,
    cumple: `<div style="width:100px;height:10px"></div>`,
  },
  {
    // La barra de abajo es fija: si el contenido no reserva su alto, la última
    // fila queda debajo de ella y no hay ninguna señal de que falta.
    regla: "la barra no tapa el contenido",
    seccion: "7f",
    ancho: 390,
    rompe:
      `<main class="contenido" style="padding-bottom:0">fila</main>` +
      `<nav class="solo-telefono" style="position:fixed;bottom:0;left:0;right:0;height:60px"></nav>`,
    cumple:
      `<main class="contenido" style="padding-bottom:60px">fila</main>` +
      `<nav class="solo-telefono" style="position:fixed;bottom:0;left:0;right:0;height:60px"></nav>`,
  },
  {
    regla: "la burbuja no tapa lo que se toca",
    seccion: "7d",
    ancho: 390,
    rompe:
      `<main><button style="position:absolute;left:10px;top:10px;width:160px;height:48px">Confirmar</button></main>` +
      `<div class="burbuja-caleb" style="position:fixed;left:40px;top:20px;width:60px;height:60px;background:#06c"></div>`,
    cumple:
      `<main><button style="position:absolute;left:10px;top:10px;width:160px;height:48px">Confirmar</button></main>` +
      `<div class="burbuja-caleb" style="position:fixed;left:300px;top:700px;width:60px;height:60px;background:#06c"></div>`,
  },
  {
    regla: "la cifra clave comparte línea con el título",
    seccion: "7l",
    ancho: 390,
    rompe: fila({ arriba: 40, derecha: 12 }),
    cumple: fila({ arriba: 0, derecha: 12 }),
  },
  {
    regla: "la cifra clave va pegada a la derecha",
    seccion: "7l",
    ancho: 390,
    rompe: fila({ arriba: 0, derecha: 100 }),
    cumple: fila({ arriba: 0, derecha: 12 }),
  },
];

/** Una fila del panel con su título y su cifra, colocada donde se diga. */
function fila({ arriba, derecha }) {
  return (
    `<div class="filas" style="box-sizing:border-box;position:relative;padding-right:12px;width:360px">` +
    `<div class="celda" data-papel="titulo" style="line-height:20px">Principal</div>` +
    `<div class="celda" data-papel="clave" style="position:absolute;top:${arriba}px;right:${derecha}px">412</div>` +
    `</div>`
  );
}
