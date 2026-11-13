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
function medir(opciones = {}) {
  const fallas = [];

  // Qué tan grande tiene que ser lo que se toca, y con qué norma.
  //
  // El panel pide 44 px: es su contrato (§7a), y está justificado porque se
  // usa con una mano, con prisa y a veces al sol. La TIENDA no se rige por el
  // contrato del panel, se rige por la WCAG 2.5.8 (AA, nueva en la 2.2), que
  // pide 24×24 px **o** separación suficiente: una diana pequeña cumple si su
  // círculo de 24 px no toca el de ninguna otra.
  //
  // La diferencia no es un detalle. Medir la tienda con los 44 px del panel
  // daba 434 fallas, y al comprobarlas una por una resultó que **ninguna**
  // incumple la 2.5.8: son listas densas de enlaces de pie y de navegación,
  // separadas de sobra. Son 434 rojos que un revisor con criterio descarta, y
  // a una regla a la que se le descartan los rojos se deja de leer entera
  // (`docs/TRAMPAS.md` §14). Así que cada superficie se mide con su norma, y
  // el informe dice con cuál.
  const tactilMinimo = opciones.tactilMinimo ?? 44;
  const porSeparacion = opciones.exencionPorSeparacion === true;
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

  // 7a - Lo que se toca tiene que poder tocarse. Un enlace dentro de un
  // párrafo no cuenta: lo táctil es lo que existe para tocarse.
  const dianas = [
    ...document.querySelectorAll("button, a[href], [role='button'], summary"),
  ].filter((el) => visible(el) && !el.closest("p"));

  /**
   * La excepción de separación de la WCAG 2.5.8.
   *
   * Una diana por debajo del mínimo cumple igual si está lo bastante sola: se
   * le dibuja un círculo del diámetro mínimo centrado en ella y, si no toca el
   * círculo de ninguna otra diana, nadie va a pulsar la de al lado por error.
   * Es la razón por la que un pie con veinte enlaces de 20 px bien espaciados
   * es correcto, y una fila de botones pegados no lo es.
   */
  const tieneSitio = (el, r) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const otra of dianas) {
      if (otra === el) continue;
      const o = otra.getBoundingClientRect();
      const ox = o.left + o.width / 2;
      const oy = o.top + o.height / 2;
      // Dos círculos de radio `tactilMinimo / 2` se tocan cuando sus centros
      // están a menos de `tactilMinimo`.
      if (Math.hypot(cx - ox, cy - oy) < tactilMinimo) return false;
    }
    return true;
  };

  /**
   * Una diana TAPADA no es una diana.
   *
   * Se comprueba preguntándole al navegador qué hay de verdad en su centro.
   * Si lo que contesta no es ella ni algo suyo, hay otra capa encima y quien
   * toque ahí no la va a pulsar — así que exigirle tamaño no significa nada.
   *
   * Hizo falta por un caso concreto: en la tienda, el aviso de permisos es
   * una capa fija abajo, y con el aviso abierto su enlace «Leer la política
   * de privacidad» (316×44) se queda ENCIMA de los enlaces legales del pie.
   * La regla de separación veía ese enlace como un vecino a 19 px del
   * «Términos» de 16 px de alto y lo cantaba como falla de la 2.5.8 en las
   * doce páginas. No era eso: era una capa tapando a otra.
   *
   * Y que algo quede tapado no se deja de vigilar por esto: lo mira su propia
   * regla, la de la burbuja, que es la que sabe distinguir «tapado a
   * propósito mientras hay un diálogo» de «tapado siempre».
   */
  const estaTapada = (el, r) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    const encima = document.elementFromPoint(cx, cy);
    if (encima === null) return false;
    return encima !== el && !el.contains(encima);
  };

  for (const el of dianas) {
    const r = el.getBoundingClientRect();
    if (estaTapada(el, r)) continue;
    // En el panel manda el ALTO: las filas ocupan el ancho entero y lo que se
    // queda corto es siempre la altura. La 2.5.8 mide los dos lados.
    const corta = porSeparacion
      ? r.width < tactilMinimo - 0.5 || r.height < tactilMinimo - 0.5
      : r.height < tactilMinimo - 0.5;
    if (!corta) continue;
    if (porSeparacion && tieneSitio(el, r)) continue;
    fallas.push({
      regla: porSeparacion ? `${tactilMinimo}px táctil (WCAG 2.5.8)` : `${tactilMinimo}px táctil`,
      detalle: porSeparacion
        ? `${donde(el)} mide ${r.width.toFixed(1)}×${r.height.toFixed(1)}px y tiene otra diana a menos de un diámetro`
        : `${donde(el)} mide ${r.height.toFixed(1)}px de alto`,
    });
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

  /**
   * El color que sale, sea cual sea la sintaxis con que se escribió.
   *
   * NO se lee con una expresión regular. Tailwind v4 compila `bg-accent/20` a
   * `color-mix(…)`, y Chrome lo CALCULA como `oklab(0.78 -0.07 0.03 / 0.2)`:
   * una expresión que ningún `rgba?\(…\)` reconoce. El resultado no era un
   * error visible, era algo peor — el color volvía `null`, la medición se
   * saltaba, y la regla decía «sin fallas».
   *
   * Lo destapó el agente que auditaba la tienda: el mismo fallo, en el auditor
   * de la web, decía «sin fallos de contraste» en las siete páginas mientras
   * axe-core encontraba 18 nodos malos. Esta copia tenía el defecto idéntico y
   * por eso el panel daba cero: no es que el panel estuviera bien, es que
   * nadie estaba midiendo. La trampa §1, dentro del propio control.
   *
   * Ahora lo convierte el navegador: se pinta en un lienzo de un píxel y se
   * lee el píxel. Eso entiende `rgb`, `oklab`, `oklch`, `lab`, `color(srgb …)`,
   * `color-mix`, los nombres de color y lo que Chrome añada mañana, sin que
   * nadie tenga que venir a enseñarle una sintaxis nueva.
   */
  const lienzo = document.createElement("canvas");
  lienzo.width = 1;
  lienzo.height = 1;
  const pincel = lienzo.getContext("2d", { willReadFrequently: true });
  const aRgb = (valor) => {
    if (!valor) return null;
    if (valor === "transparent") return [0, 0, 0, 0];
    pincel.clearRect(0, 0, 1, 1);
    pincel.fillStyle = "#000";
    pincel.fillStyle = valor;
    // `fillStyle` se queda en negro cuando el valor no se entiende. Un negro
    // de verdad también sale negro, así que se distingue aparte.
    if (
      pincel.fillStyle === "#000000" &&
      !/^(#000|black|rgba?\(0,\s*0,\s*0)/i.test(valor.trim())
    ) {
      return null;
    }
    pincel.fillRect(0, 0, 1, 1);
    const d = pincel.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };

  /** Una capa sobre otra, como las pinta el navegador. */
  const mezclar = ([r, g, b, a], [fr, fg, fb]) => [
    r * a + fr * (1 - a),
    g * a + fg * (1 - a),
    b * a + fb * (1 - a),
    1,
  ];

  /**
   * El fondo que de verdad hay detrás, ya compuesto, y la opacidad acumulada.
   *
   * Dos cosas que la versión anterior hacía mal, y las dos bajan el contraste
   * de verdad por debajo de lo que la medida decía:
   *
   *  1. **Los fondos traslúcidos se componen, no se saltan.** Subía hasta
   *     encontrar uno opaco e ignoraba todo lo de en medio. Un `bg-accent/10`
   *     sobre crema no es crema: es crema teñido de azul, y es más claro.
   *  2. **La `opacity` de los ancestros cuenta.** Es del ancestro y se aplica
   *     al pintar: una fila con `opacity-60` deja su texto al 60 % contra el
   *     fondo. Medir el color declarado da por bueno un texto que nadie lee.
   */
  const fondoYOpacidad = (el) => {
    const capas = [];
    let opacidad = 1;
    let actual = el;
    while (actual && actual !== document.documentElement) {
      const estilo = getComputedStyle(actual);
      const o = parseFloat(estilo.opacity);
      opacidad *= Number.isFinite(o) ? o : 1;
      const bg = aRgb(estilo.backgroundColor);
      if (bg && bg[3] > 0) capas.push(bg);
      if (bg && bg[3] >= 0.999) break;
      actual = actual.parentElement;
    }
    // Si nada era opaco —ni el elemento, ni la fila, ni el cuerpo, ni el
    // `html`— lo que se pinta debajo es el lienzo del navegador, que es
    // blanco. Leer aquí el fondo del cuerpo sería leer `rgba(0,0,0,0)` y
    // medir contra NEGRO: la regla exactamente al revés.
    const delCuerpo = aRgb(getComputedStyle(document.body).backgroundColor);
    let fondo = delCuerpo && delCuerpo[3] >= 0.999 ? delCuerpo : [255, 255, 255, 1];
    // De la capa más lejana a la más cercana. Al revés daría un color
    // plausible y equivocado.
    for (let i = capas.length - 1; i >= 0; i--) fondo = mezclar(capas[i], fondo);
    return { fondo, opacidad };
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

  // 7h - Contraste de verdad, medido en píxeles.
  //
  // No se confía en los tokens: un token puede estar bien y aplicarse sobre
  // un fondo que no era el que se pensó. Se mide el color que sale.
  const yaDicho = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const propio = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    if (!propio) continue;

    const estilo = getComputedStyle(el);
    const frente = aRgb(estilo.color);
    if (!frente) continue;

    // Un control APAGADO está exento, y lo dice la propia WCAG: el 1.4.3 no
    // pide contraste a un «componente de interfaz inactivo». Tiene sentido —
    // el gris es precisamente lo que comunica que no se puede tocar.
    //
    // No es un detalle de abogado: el panel apaga sus botones con
    // `disabled:opacity-50`, así que sin esta excepción la regla señalaba 14
    // botones —«Tomar el pedido», «Hacer la cotización», «Crear», «Enviar»—
    // que están grises a propósito porque falta llenar el formulario. Catorce
    // rojos que cualquiera que sepa de accesibilidad descarta con razón, y una
    // regla a la que se le descartan los rojos deja de leerse entera: es la
    // trampa §14 otra vez, el mismo día.
    //
    // Lo que NO está exento es un texto cualquiera bajado de opacidad. Un
    // `<span>` no se puede «deshabilitar»; si está al 50 % es que alguien lo
    // apagó a mano, y ahí sigue habiendo alguien que no lo puede leer.
    if (el.closest(":disabled, [aria-disabled='true']")) continue;

    // Y el texto que SOLO existe para el lector de pantalla tampoco: un
    // `sr-only` es una caja de 1×1 px recortada, nadie la ve con los ojos y
    // pedirle contraste visual no quiere decir nada. Se reconoce por el
    // tamaño, que es lo que de verdad lo define. Salió de aquí: la pastilla
    // de PayPal llevaba dentro un `<span class="sr-only">` y el auditor lo
    // estaba midiendo.
    const caja = el.getBoundingClientRect();
    if (caja.width < 4 || caja.height < 4) continue;

    const { fondo, opacidad } = fondoYOpacidad(el);
    // Por debajo de 0.1 ya no es texto apagado: es texto escondido, y
    // exigirle contraste a algo invisible es ruido.
    if (opacidad < 0.1) continue;

    const px = parseFloat(estilo.fontSize);
    const grande = px >= 24 || (px >= 18.66 && parseInt(estilo.fontWeight, 10) >= 700);
    const minimo = grande ? 3 : 4.5;
    const pintado = mezclar([frente[0], frente[1], frente[2], frente[3] * opacidad], fondo);
    const r = contraste(pintado, fondo);

    if (r < minimo) {
      // Una clase sale UNA vez: el mismo gris repetido en cuarenta filas es un
      // solo arreglo, y cuarenta líneas de informe lo esconden.
      const firma = `${el.className}|${estilo.color}|${opacidad}|${px}`;
      if (yaDicho.has(firma)) continue;
      yaDicho.add(firma);
      fallas.push({
        regla: "contraste 4.5:1",
        detalle:
          `${donde(el)} sale a ${r.toFixed(2)}:1 y necesita ${minimo}:1 (${px}px` +
          (opacidad < 0.999 ? `, al ${Math.round(opacidad * 100)} %` : "") +
          ")",
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
 * `ancho` solo hace falta donde la regla únicamente aplica en el teléfono, y
 * `opciones` donde la regla se mide con otra norma —la tienda usa la WCAG
 * 2.5.8 para las dianas y el panel su propio contrato de 44 px—.
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
    // La misma regla con la norma de la TIENDA: 24 px, o separación
    // suficiente. La muestra que aprueba es una diana de 20 px **sola**, que
    // cumple por la excepción; la que suspende son dos pegadas, que es cuando
    // de verdad se pulsa la de al lado. Sin estas dos, el cambio de norma
    // sería una afirmación sin comprobar.
    regla: "24px táctil (WCAG 2.5.8)",
    seccion: "7a",
    opciones: { tactilMinimo: 24, exencionPorSeparacion: true },
    rompe: `<button style="width:20px;height:20px"></button><button style="width:20px;height:20px"></button>`,
    cumple: `<button style="width:20px;height:20px"></button>`,
  },
  {
    // Una diana tapada no es una diana: las mismas dos de 20 px pegadas, pero
    // con una capa opaca encima, no se cantan. Es el caso del aviso de
    // permisos de la tienda sentado sobre los enlaces del pie.
    regla: "24px táctil (WCAG 2.5.8)",
    seccion: "7a",
    opciones: { tactilMinimo: 24, exencionPorSeparacion: true },
    rompe: `<button style="width:20px;height:20px"></button><button style="width:20px;height:20px"></button>`,
    cumple:
      `<button style="width:20px;height:20px"></button><button style="width:20px;height:20px"></button>` +
      `<div style="position:fixed;inset:0;background:#fff"></div>`,
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
    // El contraste tiene TRES muestras más, y cada una es un fallo que esta
    // misma regla dejó pasar durante días diciendo «sin fallas». No se borran
    // aunque parezcan repetidas: son los tres agujeros por los que se escapó.

    // (1) Sintaxis moderna. Tailwind v4 compila las opacidades a `color-mix`,
    // y Chrome las calcula como `oklab(…)`. Leído con una expresión regular de
    // `rgba(`, el color volvía nulo y la medición se SALTABA.
    regla: "contraste 4.5:1",
    seccion: "7h",
    rompe: `<div style="background:#fff"><span style="color:oklch(0.82 0.02 250);font-size:14px">Total del día</span></div>`,
    cumple: `<div style="background:#fff"><span style="color:oklch(0.35 0.02 250);font-size:14px">Total del día</span></div>`,
  },
  {
    // (2) Una capa traslúcida se COMPONE. Antes se subía hasta el primer fondo
    // opaco y se ignoraba lo de en medio: aquí el texto se medía contra el azul
    // marino —y pasaba— cuando lo que hay detrás es ese azul tapado por un
    // blanco al 85 %, o sea casi blanco.
    regla: "contraste 4.5:1",
    seccion: "7h",
    rompe:
      `<div style="background:#0A1628"><div style="background:rgba(255,255,255,0.85)">` +
      `<span style="color:#8899AA;font-size:14px">Quedan 3 por marcar</span></div></div>`,
    cumple:
      `<div style="background:#0A1628"><div style="background:rgba(255,255,255,0.85)">` +
      `<span style="color:#223344;font-size:14px">Quedan 3 por marcar</span></div></div>`,
  },
  {
    // (3) La `opacity` de un ancestro cuenta. Una fila apagada al 30 % deja su
    // texto al 30 % contra el fondo; medir el color declarado da por bueno un
    // texto que nadie puede leer.
    regla: "contraste 4.5:1",
    seccion: "7h",
    rompe: `<div style="background:#fff;opacity:0.3"><span style="color:#333;font-size:14px">Agotado</span></div>`,
    cumple: `<div style="background:#fff;opacity:1"><span style="color:#333;font-size:14px">Agotado</span></div>`,
  },
  {
    // (4) Un control apagado NO cuenta, y un texto apagado a mano SÍ. La
    // muestra que aprueba es un botón `disabled`; la que suspende es el mismo
    // texto sin control que lo justifique, que es el caso real de la pastilla
    // de PayPal en Pasarelas.
    regla: "contraste 4.5:1",
    seccion: "7h",
    rompe: `<div style="background:#fff"><span style="color:#555;opacity:0.5;font-size:15px">PayPal</span></div>`,
    cumple: `<div style="background:#fff"><button disabled style="height:44px"><span style="color:#555;opacity:0.5;font-size:15px">PayPal</span></button></div>`,
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
