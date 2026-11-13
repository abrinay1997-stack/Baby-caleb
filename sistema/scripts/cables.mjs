/**
 * ¿Dicen lo mismo la tienda y el sistema, AHORA MISMO, en producción?
 *
 * La prueba de `test/cables-del-catalogo.test.ts` compara el repositorio
 * consigo mismo y corre en cada cambio. No puede ver lo que de verdad pasó
 * aquí: un producto dado de alta desde el panel existe en la base y no está en
 * ninguna migración, así que esa prueba no lo conoce. Eso es lo que mira esto.
 *
 * Lo destapó el dueño mirando la página con sus propios ojos, después de que
 * yo afirmara que un producto de prueba estaba visible en la tienda. No lo
 * estaba. Yo había comprobado el DATO —salía en `/api/catalogo`— y no la
 * pantalla, y di por hecho el resto. Este guion existe para que esa
 * comprobación no dependa de que alguien se acuerde de hacerla.
 *
 * Solo lee. No cambia nada, no necesita credenciales y se puede correr desde
 * la pestaña Actions, que es como lo usa quien no abre una terminal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITIO = process.env.SITIO ?? "https://babycaleb.com";
const raiz = join(import.meta.dirname, "..", "..");

/** Lo que el sistema publica de verdad, preguntándoselo a la web. */
async function delSistema() {
  const r = await fetch(SITIO + "/api/catalogo", { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(SITIO + "/api/catalogo contestó " + r.status);
  const d = await r.json();
  // Si la web está sirviendo su copia de emergencia, lo que se compararía no
  // es el sistema: es una foto vieja. Mejor decirlo que dar un informe falso.
  if (d.desdeRespaldo === true) {
    throw new Error(
      "la web está sirviendo la COPIA del build, no el sistema. " +
        "Eso ya es un problema por sí solo: mírelo antes de fiarse de nada de aquí.",
    );
  }
  return d.variantes ?? [];
}

/** Lo que la tienda pinta: la lista escrita a mano del repositorio. */
function deLaTienda() {
  const c = JSON.parse(readFileSync(join(raiz, "content.json"), "utf8"));
  const codigos = new Set();
  const promete = new Map();
  for (const p of c.products ?? []) {
    if (p.descatalogado === true) continue;
    for (const v of p.variants ?? []) {
      if (!v.codigo) continue;
      codigos.add(v.codigo);
      promete.set(v.codigo, v);
    }
  }
  return { codigos, promete };
}

const dinero = (c) => "$" + (c / 100).toFixed(2);

const variantes = await delSistema();
const { codigos: tienda, promete } = deLaTienda();
const publicados = new Map(variantes.map((v) => [v.codigo, v]));

const invisibles = [...publicados.keys()].filter((c) => !tienda.has(c));
const fantasmas = [...tienda].filter((c) => !publicados.has(c));

console.log("Catálogo en vivo de " + SITIO);
console.log("  el sistema publica: " + publicados.size);
console.log("  la tienda enseña:   " + tienda.size);
console.log("");

let malas = 0;

if (invisibles.length > 0) {
  malas += invisibles.length;
  console.log("PUBLICADOS EN EL SISTEMA Y QUE LA TIENDA NO ENSEÑA");
  console.log("  Tienen ficha propia viva: quien tenga el enlace los ve, con su precio.");
  for (const c of invisibles) {
    const v = publicados.get(c);
    console.log(
      "  · " + c + " — «" + v.nombre + "» a " + dinero(v.precioCents) + " (" + v.disponibilidad + ")",
    );
    console.log("    " + SITIO + "/productos/" + v.slug);
  }
  console.log("");
}

if (fantasmas.length > 0) {
  malas += fantasmas.length;
  console.log("LA TIENDA LOS OFRECE Y EL SISTEMA NO LOS TIENE");
  console.log("  Es el peor de los dos: una clienta tocando «Pedir» sobre algo que no existe.");
  for (const c of fantasmas) console.log("  · " + c);
  console.log("");
}

// Lo que parece de prueba y está publicado. No es una regla de negocio: es
// que esto ya pasó, y pasó por una herramienta que corrí yo mismo.
const sospechosos = variantes.filter((v) =>
  /prueba|test|borrar|no vender|zz-/i.test(v.codigo + " " + v.nombre),
);
if (sospechosos.length > 0) {
  malas += sospechosos.length;
  console.log("CON PINTA DE SER UNA PRUEBA, Y PUBLICADOS");
  for (const v of sospechosos) {
    console.log("  · " + v.codigo + " — «" + v.nombre + "» a " + dinero(v.precioCents));
  }
  console.log("");
}

// Los PESOS que la tienda promete, contra los que dice el sistema.
//
// Comparar los códigos no bastaba: los dos lados pueden tener el mismo
// producto y decir cosas distintas de él. Y aquí lo decían: la web daba otros
// rangos de peso para los tres pants, con el XXL empezando en 33 libras
// cuando el sistema dice 55. Un niño de 35 libras recibe tallas distintas
// según dónde mire, y se lleva una caja de 160 pañales que no le sirven.
//
// Lo encontró una persona mirando la página al lado del panel. Esto es para
// que no haga falta.
const sinPeso = [];
const pesos = [];
for (const [codigo, v] of promete) {
  const s = publicados.get(codigo);
  if (!s) continue;
  // Un producto sin peso en el sistema —unas toallitas, un fular— no es una
  // discrepancia: es que esa medida no le aplica.
  if (s.pesoMinLb === null || s.pesoMinLb === undefined) {
    if (v.range) sinPeso.push(codigo);
    continue;
  }
  const delaWeb = String(v.range ?? "").match(/\d+(?:\.\d+)?/g) ?? [];
  const delSis = [s.pesoMinLb, s.pesoMaxLb].filter((x) => x !== null && x !== undefined).map(String);
  if (delaWeb.join("-") !== delSis.join("-")) {
    pesos.push({ codigo, web: v.range ?? "(nada)", sistema: delSis.join(" a ") + " lb" });
  }
}

if (pesos.length > 0) {
  malas += pesos.length;
  console.log("LA TIENDA Y EL SISTEMA NO DICEN EL MISMO PESO");
  console.log("  Una mamá elige la talla por el peso. Si no coinciden, compra la que no es.");
  for (const x of pesos) {
    console.log("  · " + x.codigo + ": la web dice «" + x.web + "» y el sistema «" + x.sistema + "»");
  }
  console.log("");
}

if (sinPeso.length > 0) {
  // No cuenta como falla: es información para quien lo lea.
  console.log("LA TIENDA DA UN PESO QUE EL SISTEMA NO TIENE (no se puede cotejar)");
  for (const c of sinPeso) console.log("  · " + c + ": «" + promete.get(c).range + "»");
  console.log("");
}

if (malas === 0) {
  console.log("Los cables están conectados: la tienda y el sistema dicen lo mismo.");
  process.exit(0);
}

console.log(malas + " cosa(s) que mirar.");
process.exit(1);
