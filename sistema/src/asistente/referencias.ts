/**
 * Lo que el modelo puede saber de una clienta: nada, salvo una referencia.
 *
 * Decisión D-20 (06-asistente §7). El modelo del asistente es un Contributor y
 * Meta entrena con lo que recibe. Las cifras del negocio van —el dueño del
 * proyecto lo aceptó—, pero las clientas son terceras personas que no
 * acordaron nada: hacia el modelo son «C-0042» y punto.
 *
 * El nombre lo pone el panel o Telegram DESPUÉS, al mostrar la respuesta. Y si
 * la persona escribe «¿cuánto me debe Ana?», es `buscar_cliente` quien resuelve
 * «Ana» en el servidor; al modelo le vuelve la referencia.
 *
 * Esto no se sostiene con buena voluntad en cada herramienta nueva: lo sostiene
 * `revisar()`, que mira lo que sale y se queja, y la prueba que lo pasa por
 * TODAS las herramientas registradas.
 */

/** Cómo se escribe una referencia. */
export const PATRON_REFERENCIA = /^C-\d{4,}$/;

export const comoSeEscribe = (n: number): string => `C-${String(n).padStart(4, "0")}`;

export function numeroDe(referencia: string): number | null {
  if (!PATRON_REFERENCIA.test(referencia)) return null;
  const n = Number(referencia.slice(2));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * La referencia de una clienta, dándole una si todavía no tiene.
 *
 * El número sale de `secuencias` con un solo enunciado, que en SQLite es
 * atómico: dos peticiones a la vez no se llevan el mismo. Si dos intentan dar
 * referencia a la MISMA clienta, una gana y la otra gasta un número; por eso
 * al final se vuelve a leer la fila en vez de devolver lo que se acaba de
 * pedir. Un número perdido no le importa a nadie; dos clientas con la misma
 * referencia sí, y eso lo impide el índice único.
 */
export async function referenciaDe(db: D1Database, clienteId: string): Promise<string> {
  const actual = await db
    .prepare("SELECT referencia FROM clientes WHERE id = ?")
    .bind(clienteId)
    .first<{ referencia: number | null }>();

  if (actual === null) throw new Error(`no existe la clienta ${clienteId}`);
  if (actual.referencia !== null) return comoSeEscribe(actual.referencia);

  const siguiente = await db
    .prepare(
      `INSERT INTO secuencias (nombre, valor) VALUES ('cliente_referencia', 1)
       ON CONFLICT(nombre) DO UPDATE SET valor = valor + 1
       RETURNING valor`,
    )
    .first<{ valor: number }>();
  if (siguiente === null) throw new Error("no se pudo pedir el siguiente número de referencia");

  await db
    .prepare("UPDATE clientes SET referencia = ? WHERE id = ? AND referencia IS NULL")
    .bind(siguiente.valor, clienteId)
    .run();

  // Se vuelve a leer: si otra petición ganó la carrera, la buena es la suya.
  const puesta = await db
    .prepare("SELECT referencia FROM clientes WHERE id = ?")
    .bind(clienteId)
    .first<{ referencia: number | null }>();
  if (puesta?.referencia == null) throw new Error(`no se pudo referenciar a ${clienteId}`);
  return comoSeEscribe(puesta.referencia);
}

/** De la referencia a la clienta, para poner el nombre al mostrar. */
export async function clienteDeReferencia(
  db: D1Database,
  referencia: string,
): Promise<{ id: string; nombre: string | null } | null> {
  const n = numeroDe(referencia);
  if (n === null) return null;
  return await db
    .prepare("SELECT id, nombre FROM clientes WHERE referencia = ?")
    .bind(n)
    .first<{ id: string; nombre: string | null }>();
}

/**
 * Pone el nombre donde el modelo escribió la referencia.
 *
 * Es el único sitio donde los dos mundos se juntan, y pasa DESPUÉS de que el
 * modelo contestó: lo que se le mandó a Meta ya era solo «C-0042».
 */
export async function ponerLosNombres(db: D1Database, texto: string): Promise<string> {
  const vistas = [...new Set(texto.match(/C-\d{4,}/g) ?? [])];
  if (vistas.length === 0) return texto;

  let salida = texto;
  for (const ref of vistas) {
    const cliente = await clienteDeReferencia(db, ref);
    if (cliente?.nombre) {
      salida = salida.replaceAll(ref, cliente.nombre);
    }
  }
  return salida;
}

// ---------------------------------------------------------------------------
// La guarda
// ---------------------------------------------------------------------------

export interface Filtracion {
  readonly camino: string;
  readonly que: "celular" | "correo" | "coordenadas" | "nombre_de_clienta" | "direccion";
  readonly muestra: string;
}

// Panamá: los celulares empiezan por 6 y tienen ocho cifras, con o sin guion o
// espacio en medio; con el 507 delante vale cualquier número.
//
// La primera versión cazaba ocho cifras seguidas cualesquiera, y eso daba
// positivo con «BC-20261109» o con un código de bodega. Una guarda que grita
// con cosas inocentes acaba apagada, y entonces no guarda nada: es más segura
// la que solo grita cuando hay algo. (Lo encontró la propia prueba del
// catálogo, con códigos que llevaban la fecha dentro.)
const CELULAR = /\+?507[\s-]?\d{4}[\s-]?\d{3,4}|\b6\d{3}[\s-]?\d{4}\b/;
const CORREO = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const COORDENADAS = /-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/;

/** Claves cuyo contenido es, por nombre, un dato de una persona. */
const CLAVES_PROHIBIDAS = new Set([
  "celular",
  "celular_e164",
  "telefono",
  "correo",
  "email",
  "direccion",
  "direccion_texto",
  "lat",
  "lng",
  "latitud",
  "longitud",
  "nombre_cliente",
  "nombre_clienta",
  "comprobante",
  "comprobante_url",
]);

/**
 * Mira lo que una herramienta va a mandarle al modelo y señala lo que no debe
 * salir.
 *
 * `nombresConocidos` son los nombres que hay en `clientes` ahora mismo: un
 * nombre propio no tiene forma reconocible —«Ana» es una palabra como otra—,
 * así que la única manera honesta de cazarlo es preguntarle a la base quién
 * existe. Es la comprobación que pide 06-asistente §7.
 */
export function revisar(valor: unknown, nombresConocidos: readonly string[] = []): Filtracion[] {
  const encontradas: Filtracion[] = [];
  const nombres = nombresConocidos
    .map((n) => n.trim())
    .filter((n) => n.length >= 3)
    .map(comoPalabra);

  const mirar = (v: unknown, camino: string): void => {
    if (typeof v === "string") {
      if (CORREO.test(v)) encontradas.push({ camino, que: "correo", muestra: recorte(v) });
      else if (COORDENADAS.test(v)) {
        encontradas.push({ camino, que: "coordenadas", muestra: recorte(v) });
      } else if (CELULAR.test(v)) {
        encontradas.push({ camino, que: "celular", muestra: recorte(v) });
      }

      for (const n of nombres) {
        if (n.test(v)) {
          encontradas.push({ camino, que: "nombre_de_clienta", muestra: recorte(v) });
          break;
        }
      }
      return;
    }
    if (typeof v === "number") {
      // Un celular guardado como número se escapa del patrón de texto. Mismo
      // criterio: ocho cifras empezando por 6, no ocho cifras cualesquiera (un
      // precio en centavos o una fecha como 20261109 no son un celular).
      const cifras = String(Math.abs(v));
      if (Number.isInteger(v) && cifras.length === 8 && cifras.startsWith("6")) {
        encontradas.push({ camino, que: "celular", muestra: cifras });
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => mirar(x, `${camino}[${i}]`));
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const sub = camino === "" ? k : `${camino}.${k}`;
        if (CLAVES_PROHIBIDAS.has(k) && x !== null && x !== undefined) {
          encontradas.push({ camino: sub, que: queEs(k), muestra: recorte(String(x)) });
        }
        mirar(x, sub);
      }
    }
  };

  mirar(valor, "");
  return encontradas;
}

/**
 * El nombre de una clienta, buscado COMO PALABRA y no como trozo de otra.
 *
 * Antes se buscaba con `includes` sobre el texto en minúsculas, y con una
 * clienta llamada «Ana» eso daba positivo con «ventanas de entrega», «mañana» y
 * «manga». Es el mismo fallo que ya tuvo el patrón del celular —ocho cifras
 * seguidas cualesquiera, que gritaba con «BC-20261109»— y la misma lección,
 * escrita quince líneas más arriba: una guarda que grita con cosas inocentes
 * acaba apagada, y entonces no guarda nada.
 *
 * Lo encontró la prueba que barre TODAS las herramientas, al añadir una que
 * devuelve los nombres de los ajustes.
 *
 * Qué se pierde y qué no: un nombre pegado dentro de otra palabra
 * («ventanas») deja de cazarse, y un nombre con cualquier signo al lado
 * —«cliente:Ana», «(Ana)», «ANA GÓMEZ», «de Ana.»— se sigue cazando, que es
 * como un nombre aparece de verdad cuando se filtra. Los límites se miran con
 * letras Unicode, no con `\b`: `\b` trata la tilde de «Ánalia» como frontera
 * y volvería a dar positivo.
 */
const comoPalabra = (nombre: string): RegExp =>
  new RegExp(`(?<!\\p{L})${nombre.replace(/[.*+?^$|{}()[\]\\]/g, "\\$&")}(?!\\p{L})`, "iu");

function queEs(clave: string): Filtracion["que"] {
  if (clave.includes("correo") || clave.includes("email")) return "correo";
  if (clave.includes("direccion")) return "direccion";
  if (["lat", "lng", "latitud", "longitud"].includes(clave)) return "coordenadas";
  if (clave.includes("nombre")) return "nombre_de_clienta";
  return "celular";
}

const recorte = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
