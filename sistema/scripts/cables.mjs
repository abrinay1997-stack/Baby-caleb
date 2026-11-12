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
  for (const p of c.products ?? []) {
    if (p.descatalogado === true) continue;
    for (const v of p.variants ?? []) if (v.codigo) codigos.add(v.codigo);
  }
  return codigos;
}

const dinero = (c) => "$" + (c / 100).toFixed(2);

const variantes = await delSistema();
const tienda = deLaTienda();
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

if (malas === 0) {
  console.log("Los cables están conectados: la tienda y el sistema dicen lo mismo.");
  process.exit(0);
}

console.log(malas + " cosa(s) que mirar.");
process.exit(1);
