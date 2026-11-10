/**
 * Lectura de CSV.
 *
 * Portado de `packages/domain/src/csv.ts` de Nébula sin cambios: el formato es
 * el formato y el razonamiento vale igual. Lo necesitan la carga inicial del
 * catálogo (F3.1), la importación de compras y el skill `/exportar`.
 *
 * Existe en vez de un `split(',')` porque los ficheros reales lo rompen en la
 * primera fila. Un nombre de producto es, literalmente:
 *
 *   "Pañal Nateen Talla M, caja de 144, hipoalergénico"
 *
 * Con `split(',')` eso son tres columnas, el precio se coloca donde va la marca,
 * y el catálogo entra con la basura ya dentro. Después nadie sabe qué producto
 * estaba mal porque los mil están mal a la vez.
 *
 * Y no se usa una librería porque el formato que hay que aguantar es pequeño y
 * conocido —RFC 4180 más los delimitadores que usa Excel— y una dependencia más
 * en la carpeta que no depende de nada se paga cada vez que alguien la actualiza.
 */

/** Los tres delimitadores que salen de verdad de una hoja de cálculo. */
const DELIMITADORES = [",", ";", "\t"] as const;

export type Delimitador = (typeof DELIMITADORES)[number];

export interface CsvLeido {
  encabezados: string[];
  filas: string[][];
  delimitador: Delimitador;
}

/**
 * Adivina con qué se separan las columnas.
 *
 * Importa más de lo que parece: **Excel en español exporta con punto y coma**,
 * no con coma, porque en español la coma es el separador decimal. Un fichero así
 * leído con coma da una sola columna gigante, y el mensaje de error natural
 * —«no encuentro la columna de precio»— manda a buscar al sitio equivocado.
 *
 * Se decide contando en la primera línea **fuera de comillas**: un nombre con
 * comas dentro no puede votar por la coma.
 */
export function detectarDelimitador(texto: string): Delimitador {
  const primeraLinea = texto.split(/\r?\n/, 1)[0] ?? "";

  let mejor: Delimitador = ",";
  let masApariciones = 0;

  for (const candidato of DELIMITADORES) {
    let apariciones = 0;
    let entreComillas = false;

    for (let i = 0; i < primeraLinea.length; i += 1) {
      const caracter = primeraLinea[i];
      if (caracter === '"') entreComillas = !entreComillas;
      else if (caracter === candidato && !entreComillas) apariciones += 1;
    }

    if (apariciones > masApariciones) {
      masApariciones = apariciones;
      mejor = candidato;
    }
  }

  return mejor;
}

/**
 * Convierte el texto en filas y columnas.
 *
 * Sigue RFC 4180: las comillas protegen delimitadores y saltos de línea, y unas
 * comillas dobles dentro de un campo entrecomillado son una comilla literal.
 *
 * Nunca lanza. Un fichero mal formado —comillas sin cerrar— se lee lo mejor que
 * se puede y lo que salga raro lo verá quien revise la previsualización, que es
 * quien puede juzgarlo. Lanzar aquí le daría un error técnico en vez de sus datos.
 */
export function leerCsv(texto: string, delimitador?: Delimitador): CsvLeido {
  // El BOM que pone Excel al guardar en UTF-8 se pega al primer encabezado y lo
  // vuelve irreconocible: `﻿codigo` no coincide con `codigo`.
  const limpio = texto.replace(/^﻿/, "");
  const separador = delimitador ?? detectarDelimitador(limpio);

  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let entreComillas = false;

  for (let i = 0; i < limpio.length; i += 1) {
    const caracter = limpio[i];

    if (entreComillas) {
      if (caracter === '"') {
        if (limpio[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        campo += caracter;
      }
      continue;
    }

    if (caracter === '"') {
      entreComillas = true;
    } else if (caracter === separador) {
      fila.push(campo);
      campo = "";
    } else if (caracter === "\n") {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = "";
    } else if (caracter === "\r") {
      // Fin de línea de Windows: el `\n` que viene detrás hace el trabajo.
      continue;
    } else {
      campo += caracter;
    }
  }

  // La última fila no termina en salto de línea si el fichero no acaba con uno.
  if (campo !== "" || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  const sinVacias = filas.filter((f) => f.some((c) => c.trim() !== ""));
  const [encabezados = [], ...resto] = sinVacias;

  return {
    encabezados: encabezados.map((e) => e.trim()),
    filas: resto,
    delimitador: separador,
  };
}

/** Escribe un campo escapando lo que RFC 4180 obliga a escapar. */
export function escaparCampo(valor: string, delimitador: Delimitador = ","): string {
  const necesitaComillas =
    valor.includes('"') ||
    valor.includes("\n") ||
    valor.includes("\r") ||
    valor.includes(delimitador);
  return necesitaComillas ? `"${valor.replace(/"/g, '""')}"` : valor;
}

/**
 * Arma un CSV. Lo usa el skill `/exportar`.
 *
 * Lleva BOM porque el destino es Excel en una computadora en español: sin él,
 * «Pañal» se abre como «PaÃ±al» y parece que los datos están corruptos.
 */
export function escribirCsv(
  encabezados: readonly string[],
  filas: readonly (readonly string[])[],
  delimitador: Delimitador = ",",
): string {
  const linea = (campos: readonly string[]) =>
    campos.map((c) => escaparCampo(c, delimitador)).join(delimitador);
  return "﻿" + [linea(encabezados), ...filas.map(linea)].join("\r\n");
}
