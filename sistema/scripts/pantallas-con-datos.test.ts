import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONECTORES, MODOS, PASARELAS, puedeEncenderse, queFalta } from "../src/dominio/pasarelas";

/**
 * Una pantalla del auditor que el servidor de muestra no alimenta se pone
 * ROJA, en vez de aprobarse sola.
 *
 * ## El fallo que cierra
 *
 * Una pantalla vive en DOS listas: la de `scripts/auditar-panel.mjs` (qué se
 * mide) y la de `scripts/panel-de-muestra.mjs` (con qué datos). Están en dos
 * archivos y nada las ata, así que alguien tiene que acordarse de tocar las
 * dos — y es exactamente la clase de lista que se olvida (docs/TRAMPAS.md §8).
 *
 * Cuando se olvida, no falla nada: el panel pide su API, la muestra contesta
 * 404, React pinta la tarjeta de «No se pudo cargar» —que tiene su `<h1>`, sus
 * 44 px y su texto de 16 px— y el auditor la mide, no encuentra ni una falla
 * del §7 y escribe «Sin fallas». Una pantalla que no se rinde se cuenta como
 * una pantalla aprobada. Pasó con `/entregas` —una de las tres pestañas de la
 * barra de abajo— y con `/pasarelas`, y el informe decía «Medidas 57 pantallas
 * … Sin fallas» con las dos enseñando una tarjeta de error.
 *
 * ## Cómo lo cierra
 *
 * Recorre las pantallas que el auditor abre, mira QUÉ le pide cada una al
 * servidor —los `useCarga(...)` de su pantalla y de las hojas que esa pantalla
 * monta— y le pregunta al servidor de muestra DE VERDAD, levantándolo en un
 * puerto propio. Cada petición tiene que contestar 200 con `ok: true`.
 *
 * ## Por qué corre en Node y no en workerd
 *
 * Porque levanta un proceso y lee el disco: `node:child_process` y `node:fs`
 * no existen dentro de workerd, y ahí esta prueba se saltaría en silencio
 * —verde sin comprobar nada, que es peor que no tenerla—. Por eso vive en
 * `vitest.node.config.ts`, igual que `panel-de-muestra.test.ts`.
 *
 * Y por eso TODO lo que no puede leer es un fallo y no un `skip`: si mañana se
 * reescribe la lista del auditor, o el mapa de rutas del panel, o aparece un
 * trozo variable en una ruta que aquí no está declarado, esta prueba se pone
 * roja y lo dice. Una prueba que no puede leer lo que vigila tiene que
 * quejarse, no callarse.
 */

const AQUI = import.meta.dirname;
const PANEL = join(AQUI, "..", "panel", "src");

// ---------------------------------------------------------------------------
// 1. Qué pantallas abre el auditor
// ---------------------------------------------------------------------------

const AUDITOR = await readFile(join(AQUI, "auditar-panel.mjs"), "utf8");

/**
 * Las rutas que el auditor visita.
 *
 * Dos sitios, porque el auditor las escribe de dos maneras: la tabla
 * `PANTALLAS`, y los `goto(`${BASE}/loquesea`)` sueltos de los bloques que
 * abren una hoja (`/llaves`, por ejemplo). Leer solo la tabla dejaría fuera
 * justo las que se añadieron a mano, que son las nuevas.
 */
function rutasDelAuditor(): string[] {
  const bloque = /const PANTALLAS = \[([\s\S]*?)\n\];/.exec(AUDITOR);
  if (bloque === null) {
    throw new Error(
      "no encontré la lista PANTALLAS en auditar-panel.mjs: si cambió de forma, hay que enseñarle a esta prueba a leerla",
    );
  }
  const deLaTabla = [...bloque[1]!.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map(
    (m) => m[2]!,
  );
  const sueltas = [...AUDITOR.matchAll(/\$\{BASE\}(\/[a-z0-9-]*)`/g)].map((m) => m[1]!);
  return [...new Set([...deLaTabla, ...sueltas])].sort();
}

const RUTAS = rutasDelAuditor();

// ---------------------------------------------------------------------------
// 2. Qué pantalla pinta cada ruta
// ---------------------------------------------------------------------------

const APP = await readFile(join(PANEL, "App.tsx"), "utf8");

function componentesPorRuta(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const m of APP.matchAll(
    /<Route\s+(?:index|path="([^"]*)")\s+element=\{<(\w+)\s*\/>\}/g,
  )) {
    const ruta = m[1] === undefined ? "/" : `/${m[1]}`;
    mapa.set(ruta, m[2]!);
  }
  return mapa;
}

const COMPONENTES = componentesPorRuta();

// ---------------------------------------------------------------------------
// 3. Qué le pide cada pantalla al servidor
// ---------------------------------------------------------------------------

/**
 * Los trozos variables de una ruta, con un valor que la muestra tiene.
 *
 * Se declaran aquí a propósito, y un trozo que no esté declarado es un FALLO,
 * no un «pues me lo salto»: `/api/clientes/${clienteId}` sin un id de verdad
 * se quedaría en `/api/clientes/`, que contesta otra cosa, y la prueba estaría
 * mirando una ruta que nadie pide. Al añadir una pantalla con un parámetro
 * nuevo, se escribe aquí el valor que la muestra conoce.
 */
const VALORES: Record<string, string> = {
  // El día que pide la pantalla de entregas es el de hoy en Panamá, igual que
  // `hoyEnPanama()` del panel.
  dia: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10),
  al: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10),
  periodo: "hoy",
  mes: "2026-11",
  "rango.desde": "2026-11-01",
  "rango.hasta": "2026-11-30",
  // La única cuenta con mayor en la muestra.
  "cuenta.codigo": "1201",
  // Una clienta que la muestra sí tiene ficha de.
  clienteId: "cli-muestra-1",
  "encodeURIComponent(texto)": "muestra",
  'cola === "" ? "" : `?${cola}`': "",
  'verTodos ? "?todos=1" : ""': "?todos=1",
};

/** Lee un literal (comilla o plantilla) desde `i`, devolviendo su cuerpo crudo. */
function leerLiteral(texto: string, i: number): { cuerpo: string; fin: number } | null {
  const comilla = texto[i];
  if (comilla !== '"' && comilla !== "'" && comilla !== "`") return null;
  let j = i + 1;
  let cuerpo = "";
  while (j < texto.length) {
    const c = texto[j]!;
    if (c === "\\") {
      cuerpo += texto.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === comilla) return { cuerpo, fin: j + 1 };
    if (comilla === "`" && c === "$" && texto[j + 1] === "{") {
      // El hueco entero, con sus llaves anidadas: dentro puede haber otra
      // plantilla (`/api/pedidos${cola === "" ? "" : `?${cola}`}`).
      let nivel = 0;
      let k = j + 1;
      for (; k < texto.length; k += 1) {
        if (texto[k] === "{") nivel += 1;
        else if (texto[k] === "}") {
          nivel -= 1;
          if (nivel === 0) break;
        }
      }
      cuerpo += texto.slice(j, k + 1);
      j = k + 1;
      continue;
    }
    cuerpo += c;
    j += 1;
  }
  return null;
}

/** Las rutas de API que pide `useCarga` en un archivo. */
function peticionesDe(fuente: string, archivo: string): string[] {
  const rutas: string[] = [];
  for (const m of fuente.matchAll(/useCarga\s*</g)) {
    const abre = fuente.indexOf("(", m.index!);
    if (abre === -1) continue;
    // Hasta el paréntesis que cierra la llamada, saltándose los literales
    // —un paréntesis dentro de un texto no cierra nada—.
    let nivel = 0;
    let fin = abre;
    for (let i = abre; i < fuente.length; i += 1) {
      const lit = leerLiteral(fuente, i);
      if (lit !== null) {
        i = lit.fin - 1;
        continue;
      }
      if (fuente[i] === "(") nivel += 1;
      else if (fuente[i] === ")") {
        nivel -= 1;
        if (nivel === 0) {
          fin = i;
          break;
        }
      }
    }
    const argumentos = fuente.slice(abre, fin);
    for (let i = 0; i < argumentos.length; i += 1) {
      const lit = leerLiteral(argumentos, i);
      if (lit === null) continue;
      i = lit.fin - 1;
      if (lit.cuerpo.startsWith("/api/")) rutas.push(resolver(lit.cuerpo, archivo));
    }
  }
  return rutas;
}

/** Cambia cada `${...}` por el valor declarado. Sin valor, se queja. */
function resolver(literal: string, archivo: string): string {
  let salida = "";
  for (let i = 0; i < literal.length; i += 1) {
    if (literal[i] !== "$" || literal[i + 1] !== "{") {
      salida += literal[i];
      continue;
    }
    // Hasta la llave que cierra, contando las de dentro: el hueco puede traer
    // otra plantilla con el suyo propio.
    let nivel = 0;
    let k = i + 1;
    for (; k < literal.length; k += 1) {
      if (literal[k] === "{") nivel += 1;
      else if (literal[k] === "}") {
        nivel -= 1;
        if (nivel === 0) break;
      }
    }
    const expresion = literal.slice(i + 2, k).replace(/\s+/g, " ").trim();
    const valor = VALORES[expresion];
    if (valor === undefined) {
      throw new Error(
        `${archivo} pide «${literal}» y no sé qué poner en «${expresion}». ` +
          "Declare su valor en VALORES (scripts/pantallas-con-datos.test.ts).",
      );
    }
    salida += valor;
    i = k;
  }
  return salida;
}

/** La pantalla y todo lo que monta: sus hojas viven en archivos vecinos. */
async function archivosDe(componente: string): Promise<string[]> {
  const vistos = new Set<string>();
  const porVer = [componente];
  const archivos: string[] = [];
  while (porVer.length > 0) {
    const nombre = porVer.pop()!;
    if (vistos.has(nombre)) continue;
    vistos.add(nombre);
    const ruta = join(PANEL, "pantallas", `${nombre}.tsx`);
    if (!existsSync(ruta)) {
      throw new Error(`no encontré la pantalla ${nombre} en panel/src/pantallas/`);
    }
    archivos.push(ruta);
    const fuente = await readFile(ruta, "utf8");
    for (const m of fuente.matchAll(/from "\.\/(\w+)"/g)) porVer.push(m[1]!);
  }
  return archivos;
}

const DE_CADA_PANTALLA = new Map<string, string[]>();
for (const ruta of RUTAS) {
  const componente = COMPONENTES.get(ruta);
  if (componente === undefined) {
    throw new Error(
      `el auditor abre ${ruta} y App.tsx no dice qué pantalla la pinta: ` +
        "o la ruta se escribe de otra forma, o esta prueba ya no sabe leer el mapa de rutas",
    );
  }
  // `/api/yo` lo pide el panel entero antes de pintar nada.
  const pide = new Set<string>(["/api/yo"]);
  for (const archivo of await archivosDe(componente)) {
    for (const p of peticionesDe(await readFile(archivo, "utf8"), archivo)) pide.add(p);
  }
  DE_CADA_PANTALLA.set(ruta, [...pide].sort());
}

// ---------------------------------------------------------------------------
// 4. El servidor de muestra, de verdad
// ---------------------------------------------------------------------------

const PUERTO = 4200 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PUERTO}`;
let servidor: ChildProcess;

beforeAll(async () => {
  servidor = spawn(process.execPath, [join(AQUI, "panel-de-muestra.mjs")], {
    env: { ...process.env, PUERTO: String(PUERTO) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let quejas = "";
  servidor.stderr?.on("data", (d: Buffer) => (quejas += d.toString()));

  for (let intento = 0; intento < 100; intento += 1) {
    try {
      const r = await fetch(`${BASE}/api/yo`);
      if (r.ok) return;
    } catch {
      // Todavía no escucha.
    }
    await new Promise((listo) => setTimeout(listo, 100));
  }
  throw new Error(`el panel de muestra no llegó a contestar en ${BASE}. ${quejas}`);
}, 20_000);

afterAll(() => {
  servidor?.kill();
});

describe("cada pantalla que el auditor mide tiene datos de muestra", () => {
  it("el auditor abre más de una docena de pantallas y todas están en el mapa de rutas", () => {
    // Si esto baja de golpe, la lista dejó de leerse: es la forma en que esta
    // prueba avisa de que se quedó ciega en vez de aprobar por no mirar.
    expect(RUTAS.length).toBeGreaterThanOrEqual(12);
    expect(DE_CADA_PANTALLA.size).toBe(RUTAS.length);
  });

  for (const ruta of RUTAS) {
    it(`${ruta} recibe todo lo que pide`, async () => {
      const peticiones = DE_CADA_PANTALLA.get(ruta)!;
      expect(peticiones.length).toBeGreaterThan(0);

      for (const peticion of peticiones) {
        const r = await fetch(`${BASE}${peticion}`);
        const cuerpo = (await r.json()) as { ok: boolean; mensaje?: string };
        expect(
          { ruta: peticion, estado: r.status, mensaje: cuerpo.mensaje },
          `la pantalla ${ruta} pide ${peticion} y el panel de muestra no la tiene: ` +
            "añádala a RESPUESTAS en scripts/panel-de-muestra.mjs, o el auditor medirá " +
            "la tarjeta de «No se pudo cargar» y dirá que no hay fallas",
        ).toEqual({ ruta: peticion, estado: 200, mensaje: undefined });
        expect(cuerpo.ok, `${peticion} contestó 200 pero con un fallo dentro`).toBe(true);
      }
    });
  }
});

/**
 * Y las pasarelas de la muestra dicen lo que dice el catálogo de verdad.
 *
 * La pantalla dibuja sus campos del catálogo (`src/dominio/pasarelas.ts`), no
 * de la respuesta: busca cada credencial por su NOMBRE. Una muestra con un
 * nombre inventado pintaría «falta» encima de una credencial puesta, y lo que
 * el auditor mediría sería una pantalla que en producción sale distinta.
 *
 * Por eso no se comprueba «que haya algo», se comprueba que lo que hay sea lo
 * que las mismas funciones del servidor calcularían con esas credenciales.
 */
describe("las pasarelas de muestra", () => {
  it("traen las tres, con las credenciales y los veredictos del catálogo", async () => {
    const r = await fetch(`${BASE}/api/pasarelas`);
    expect(r.status).toBe(200);
    const { datos } = (await r.json()) as { datos: Record<string, any> };

    expect(datos["pasarelas"].map((p: any) => p.pasarela)).toEqual([...PASARELAS]);

    for (const p of datos["pasarelas"]) {
      const conector = CONECTORES[p.pasarela as keyof typeof CONECTORES];
      expect(p.titulo).toBe(conector.titulo);
      expect(p.explica).toBe(conector.explica);
      expect(p.fuente).toBe(conector.fuente);
      expect(p.por_confirmar).toBe(conector.porConfirmar);
      expect(p.modos.map((m: any) => m.modo)).toEqual([...MODOS]);

      for (const m of p.modos) {
        const nombres = m.credenciales
          .filter((c: any) => c.puesta)
          .map((c: any) => c.nombre);
        expect(
          m.credenciales.map((c: any) => c.nombre),
          `las credenciales de ${p.pasarela} en ${m.modo} no son las del catálogo`,
        ).toEqual(conector.credenciales.map((c) => c.nombre));
        expect(m.faltan).toEqual(queFalta(p.pasarela, nombres).map((c) => c.titulo));
        expect(m.completo).toBe(m.faltan.length === 0);
        expect(m.esElActual).toBe(m.modo === p.modo);
      }

      const suyas = p.modos
        .find((m: any) => m.esElActual)
        .credenciales.filter((c: any) => c.puesta)
        .map((c: any) => c.nombre);
      const decision = puedeEncenderse(p.pasarela, suyas);
      expect(p.puede_encenderse).toBe(decision.puede);
      expect(p.por_que_no).toBe(decision.puede ? null : decision.motivo);
      expect(p.incoherente).toBe(p.encendida && !decision.puede);
    }

    // Los tres estados que hacen falta para que la pantalla se vea entera: una
    // encendida en prueba, una encendida en real y una que no se puede
    // encender. Con las tres iguales, media pantalla no la mira nadie.
    const encendidas = datos["pasarelas"].filter((p: any) => p.encendida);
    expect(encendidas.some((p: any) => p.modo === "prueba")).toBe(true);
    expect(encendidas.some((p: any) => p.modo === "real")).toBe(true);
    expect(datos["pasarelas"].some((p: any) => !p.puede_encenderse)).toBe(true);
  });

  it("y lo que dice el checkout sale de ellas, no de un texto escrito a mano", async () => {
    const pasarelas = (await (await fetch(`${BASE}/api/pasarelas`)).json()) as {
      datos: Record<string, any>;
    };
    const checkout = (await (await fetch(`${BASE}/api/checkout`)).json()) as {
      datos: Record<string, any>;
    };

    const enSuModo = (p: any) => p.modos.find((m: any) => m.esElActual);
    const listas = pasarelas.datos["pasarelas"]
      .filter((p: any) => p.encendida && enSuModo(p).completo && p.modo === "real")
      .map((p: any) => p.titulo);
    const enPrueba = pasarelas.datos["pasarelas"]
      .filter((p: any) => p.encendida && enSuModo(p).completo && p.modo === "prueba")
      .map((p: any) => p.titulo);

    // Es la cuenta de `estadoDelCheckout` (src/dominio/checkout.ts). Si las dos
    // muestras se separan, la pantalla de Ajustes diría «ninguna pasarela
    // encendida» al lado de una de Pasarelas con dos encendidas.
    expect(checkout.datos["listas"]).toEqual(listas);
    expect(checkout.datos["enPrueba"]).toEqual(enPrueba);
  });
});

/**
 * La ruta del día también se cuenta sola.
 *
 * El resumen de arriba —lo que falta, lo entregado y lo cobrado— es lo primero
 * que lee la dueña y lo primero que se separa de la lista que tiene debajo si
 * se escribe a mano. Aquí se comprueba con la misma cuenta que hace
 * `entregasDelDia` (src/db/entregas.ts).
 */
describe("las entregas de muestra", () => {
  it("cuadran con sus paradas y traen los estados que cambian la pantalla", async () => {
    const hoy = VALORES["dia"]!;
    const r = await fetch(`${BASE}/api/entregas?fecha=${hoy}`);
    expect(r.status).toBe(200);
    const { datos } = (await r.json()) as { datos: Record<string, any> };

    expect(datos["fecha"]).toBe(hoy);
    const todas = [...datos["sinRuta"], ...datos["rutas"].flatMap((x: any) => x.paradas)];
    const abiertas = todas.filter(
      (p: any) => !["entregado", "devuelto", "anulado"].includes(p.estado),
    );
    expect(datos["resumen"]).toEqual({
      porEntregar: abiertas.length,
      entregadas: todas.filter((p: any) => p.estado === "entregado").length,
      fallidas: todas.filter((p: any) => p.estado === "fallido").length,
      cobradoCents: todas.reduce((s: number, p: any) => s + p.cobradoCents, 0),
    });

    // Los estados que la pantalla pinta distinto, y la hoja que solo existe
    // sobre una parada en la calle.
    const estados = new Set(todas.map((p: any) => p.estado));
    for (const e of ["entregado", "fallido", "en_ruta", "pendiente"]) {
      expect(estados, `falta una parada en estado ${e}`).toContain(e);
    }
    // Una sin ruta (nadie la lleva) y una ruta sin despachar.
    expect(datos["sinRuta"].length).toBeGreaterThan(0);
    expect(datos["rutas"].some((x: any) => x.estado === "borrador")).toBe(true);
    expect(datos["rutas"].some((x: any) => x.estado === "en_curso")).toBe(true);

    // Y el motorizado inactivo NO sale: la ruta de verdad lo excluye, y con él
    // dentro la auditoría aprobaría un desplegable que en producción es otro.
    expect(datos["motorizados"].every((m: any) => m.estado !== "inactivo")).toBe(true);
  });
});
