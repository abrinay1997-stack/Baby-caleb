import { fallo, ok, type Resultado } from "../contrato/resultado";

/**
 * Cifrar y descifrar un secreto que tiene que vivir en D1.
 *
 * ## Por qué existe
 *
 * D1 guarda texto plano. Una credencial de cobro escrita tal cual en una
 * columna la puede leer cualquiera que pueda leer la base: una copia de
 * seguridad, una consulta desde el panel de Cloudflare, un volcado de
 * depuración. Así que a la base no entra el secreto: entra su criptograma, y la
 * llave con la que se abre vive en otro sitio —un secreto del Worker—, que es
 * lo que hace que tener la base no sea tener las claves.
 *
 * ## Cómo se pone la llave maestra
 *
 * Es un secreto del Worker llamado `PASARELAS_LLAVE_MAESTRA`: 32 bytes al azar
 * escritos en base64. Se pone UNA vez por entorno y **no se guarda en el
 * repositorio, ni en `wrangler.jsonc`, ni en D1**.
 *
 *   1. Generar el valor (una sola vez, en cualquier terminal):
 *        openssl rand -base64 32
 *   2. Guardarlo en el gestor de contraseñas del negocio. Si se pierde, los
 *      secretos guardados NO se pueden recuperar: hay que volver a pegar cada
 *      credencial desde el portal de cada pasarela. Es a propósito — el sistema
 *      no tiene ninguna otra forma de abrirlos, y si la tuviera, la tendría
 *      también quien robara la base.
 *   3. Ponerlo en cada entorno, con el valor pegado cuando lo pida:
 *        npx wrangler secret put PASARELAS_LLAVE_MAESTRA --env production
 *        npx wrangler secret put PASARELAS_LLAVE_MAESTRA --env staging
 *      Sin terminal, lo mismo se hace en el panel de Cloudflare:
 *      Workers & Pages › el Worker › Settings › Variables and Secrets ›
 *      Add › tipo «Secret» › nombre `PASARELAS_LLAVE_MAESTRA` › valor › Save.
 *
 * **Si no está puesta, guardar una credencial FALLA.** No se guarda en claro
 * «mientras tanto»: un secreto en claro en una tabla no se nota, nadie vuelve a
 * mirarlo, y el día que alguien lo note ya estuvo ahí seis meses.
 *
 * ## Rotarla
 *
 * Cada criptograma guarda al lado la HUELLA de la llave con que se hizo
 * (`llave_id`). No es parte del secreto ni se deriva de él: es de la llave, y
 * sirve para una sola cosa — decir «esto se cifró con una llave que ya no
 * tenemos» en vez de un error ilegible. Rotar la llave maestra obliga a volver
 * a pegar las credenciales; no hay descifrado con la vieja y cifrado con la
 * nueva porque eso exigiría tener las dos a la vez en el Worker, y tener dos
 * llaves vivas es tener el doble de superficie por la mitad de beneficio.
 */

const texto = new TextEncoder();
const letras = new TextDecoder();

/**
 * La marca del sobre, y para qué sirve de verdad.
 *
 * Además de dejar sitio a un algoritmo futuro, es lo que permite que la tabla
 * COMPRUEBE en un `CHECK` que lo que se guarda tiene pinta de criptograma:
 * migrations/0010 exige que la columna empiece por esto. Un secreto pegado a
 * mano en la consola de D1 no empieza por `aesgcm1.` y la fila se rechaza.
 */
export const PREFIJO = "aesgcm1.";

/** AES-GCM de 256 bits: 32 bytes de llave. */
export const LARGO_LLAVE = 32;

/**
 * 12 bytes, que es el nonce recomendado para GCM.
 *
 * **Se genera uno nuevo en CADA cifrado, y eso no es higiene: es el cifrado.**
 * GCM es un cifrado en flujo: la llave y el nonce producen un chorro de bytes
 * con el que se hace XOR. Repetir el nonce con la misma llave produce el MISMO
 * chorro, así que el XOR de los dos criptogramas es el XOR de los dos textos
 * claros —adiós confidencialidad— y además deja despejar el valor interno con
 * el que GCM autentica, lo que permite falsificar mensajes que el sistema dará
 * por buenos. Dos credenciales guardadas con el mismo nonce no son «un poco
 * menos seguras»: rompen el cifrado de las dos y la autenticación de todas.
 *
 * Por eso aquí no hay contador, ni nonce derivado del nombre de la credencial,
 * ni nada que pueda repetirse al reescribir una fila: `crypto.getRandomValues`
 * y a otra cosa. Con 96 bits al azar y unas decenas de credenciales en toda la
 * vida del sistema, la probabilidad de repetir es la de acertar la lotería
 * varias veces seguidas.
 */
export const LARGO_NONCE = 12;

/** 128 bits de etiqueta de autenticación, el máximo de GCM. */
const BITS_ETIQUETA = 128;

/** Lo menos que puede medir un sobre: nonce + etiqueta, sin un solo byte de texto. */
const BYTES_MINIMOS = LARGO_NONCE + BITS_ETIQUETA / 8;

/** El entorno del Worker, solo con lo que este módulo necesita. */
export interface EntornoCifrado {
  PASARELAS_LLAVE_MAESTRA?: string | undefined;
}

// El secreto se declara en el tipo de `env` para que una ruta lo pueda leer sin
// ponerle un `as` encima. Se hace aquí, en el módulo que lo usa, y no tocando
// `worker-configuration.d.ts`, que lo regenera `wrangler types` y borraría lo
// escrito a mano. Es el mismo recurso que usa `test/env.d.ts` con MIGRACIONES.
declare global {
  namespace Cloudflare {
    interface Env {
      /** 32 bytes al azar en base64. Ver la cabecera de `src/seguridad/cifrado.ts`. */
      PASARELAS_LLAVE_MAESTRA?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Base64, en las dos variantes
// ---------------------------------------------------------------------------

function aBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Acepta base64 normal y base64url, con relleno o sin él.
 *
 * Las dos variantes porque la llave maestra la va a pegar una persona: lo que
 * sale de `openssl rand -base64 32` trae `+`, `/` y `=`, y lo que sale de un
 * generador en la web suele traer `-` y `_`. Rechazar una llave buena por el
 * alfabeto sería un cuarto de hora perdido buscando un error que no existe.
 */
function deBase64(entrada: string): Uint8Array | null {
  const limpio = entrada.replace(/\s+/g, "");
  if (limpio === "" || !/^[A-Za-z0-9+/_=-]+$/.test(limpio)) return null;
  const normal = limpio.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const relleno = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(relleno), (l) => l.charCodeAt(0));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// La llave
// ---------------------------------------------------------------------------

export interface Llave {
  /** No es extraíble: ni el propio código puede volver a sacar sus bytes. */
  readonly clave: CryptoKey;
  /**
   * Huella de LA LLAVE, nunca del secreto.
   *
   * La distinción importa: una huella del secreto permitiría comprobar
   * conjeturas —calcular el hash de «la clave que creo que es» y compararlo—
   * y eso convierte un dato público en un oráculo contra el secreto. La huella
   * de la llave maestra no dice nada de ningún secreto: solo deja saber si dos
   * criptogramas se hicieron con la misma llave.
   */
  readonly id: string;
}

/**
 * Abre la llave maestra, o explica qué le falta.
 *
 * Falla cerrado y lo dice con palabras que sirvan: lo va a leer la dueña en un
 * teléfono, y «invalid key length» no le dice a quién avisar.
 *
 * El mensaje NUNCA incluye el valor que se recibió, ni su largo, ni un trozo.
 */
export async function abrirLlaveMaestra(
  material: string | undefined | null,
): Promise<Resultado<Llave>> {
  const crudo = (material ?? "").trim();
  if (crudo === "") {
    return fallo(
      "interno",
      "Falta la llave maestra con la que el sistema cifra las credenciales de cobro, así que no se puede guardar ninguna. Avísele a Juan: se pone una sola vez por entorno, como secreto del Worker con el nombre PASARELAS_LLAVE_MAESTRA. Hasta entonces no se guarda nada, a propósito: una credencial de cobro no se guarda sin cifrar.",
    );
  }

  const bytes = deBase64(crudo);
  if (bytes === null || bytes.length !== LARGO_LLAVE) {
    return fallo(
      "interno",
      `La llave maestra de cifrado no tiene la forma que debe: son ${LARGO_LLAVE} bytes al azar escritos en base64. Avísele a Juan — se genera con «openssl rand -base64 32» y se guarda como secreto del Worker. No se guarda ninguna credencial mientras no esté bien puesta.`,
    );
  }

  try {
    const clave = await crypto.subtle.importKey(
      "raw",
      bytes as unknown as BufferSource,
      { name: "AES-GCM" },
      // No extraíble: aunque alguien consiga ejecutar código aquí, no puede
      // pedirle a WebCrypto los bytes de la llave para llevárselos.
      false,
      ["encrypt", "decrypt"],
    );
    const huella = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
    );
    // Once bytes de base64url, o sea 8 bytes de hash: suficiente para
    // distinguir dos llaves y demasiado poco para reconstruir ninguna.
    return ok({ clave, id: aBase64Url(huella.subarray(0, 8)) });
  } catch {
    return fallo("interno", "La llave maestra de cifrado no se pudo usar. Avísele a Juan.");
  }
}

// ---------------------------------------------------------------------------
// Cifrar y descifrar
// ---------------------------------------------------------------------------

/**
 * Cifra un secreto y devuelve el sobre listo para guardar.
 *
 * `contexto` va como datos autenticados adicionales: no se cifra, pero sin él
 * exacto el descifrado falla. Ahí va el sitio al que pertenece el secreto
 * (`contextoDeCifrado` de `src/dominio/pasarelas.ts`), y eso es lo que hace que
 * mover un criptograma de fila a fila no sirva de nada.
 *
 * El sobre es `aesgcm1.` + base64url(nonce ‖ criptograma ‖ etiqueta). El nonce
 * va delante en claro porque tiene que ir: no es secreto, es único.
 */
export async function cifrar(
  llave: Llave,
  secreto: string,
  contexto: string,
): Promise<Resultado<string>> {
  if (secreto === "") {
    // Un sobre que al abrirse da la cadena vacía se guardaría como «credencial
    // puesta» y se usaría como clave vacía. Se para aquí.
    return fallo("entrada_invalida", "No hay nada que cifrar.");
  }
  if (contexto === "") {
    // Sin contexto el criptograma se podría mover de sitio, que es justo lo
    // que el contexto existe para impedir. Es un error de programación, no de
    // la dueña.
    return fallo("interno", "No se puede cifrar sin decir a qué sitio pertenece el secreto.");
  }

  const nonce = crypto.getRandomValues(new Uint8Array(LARGO_NONCE));
  try {
    const sellado = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce as unknown as BufferSource,
          additionalData: texto.encode(contexto) as unknown as BufferSource,
          tagLength: BITS_ETIQUETA,
        },
        llave.clave,
        texto.encode(secreto) as unknown as BufferSource,
      ),
    );
    const sobre = new Uint8Array(nonce.length + sellado.length);
    sobre.set(nonce, 0);
    sobre.set(sellado, nonce.length);
    return ok(PREFIJO + aBase64Url(sobre));
  } catch {
    // El mensaje no lleva nada del secreto: un error que se pinta en pantalla
    // y acaba en una captura es una de las formas fáciles de que una clave
    // salga de donde debe estar.
    return fallo("interno", "No se pudo cifrar la credencial.");
  }
}

/**
 * Abre un sobre. Falla si la llave es otra, si el contexto es otro, o si
 * alguien tocó un solo bit.
 *
 * Lo tercero no es un extra de GCM: es su etiqueta de autenticación. Un cifrado
 * sin autenticar deja que alguien que puede escribir en la base cambie el
 * criptograma y que lo que salga al descifrar sea otra cosa —basura, o algo
 * elegido— sin que nada se queje. Aquí se queja.
 */
export async function descifrar(
  llave: Llave,
  sobre: string,
  contexto: string,
): Promise<Resultado<string>> {
  if (!sobre.startsWith(PREFIJO)) {
    return fallo(
      "interno",
      "Lo que hay guardado en esa credencial no tiene la forma de un secreto cifrado por este sistema.",
    );
  }
  const bytes = deBase64(sobre.slice(PREFIJO.length));
  if (bytes === null || bytes.length < BYTES_MINIMOS) {
    return fallo("interno", "El secreto guardado en esa credencial está incompleto.");
  }

  try {
    const claro = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, LARGO_NONCE) as unknown as BufferSource,
        additionalData: texto.encode(contexto) as unknown as BufferSource,
        tagLength: BITS_ETIQUETA,
      },
      llave.clave,
      bytes.subarray(LARGO_NONCE) as unknown as BufferSource,
    );
    return ok(letras.decode(claro));
  } catch {
    // Los tres motivos se contestan IGUAL a propósito. Distinguir «la llave es
    // otra» de «el contexto es otro» de «esto está manipulado» le diría a quien
    // está probando cosas cuál de las tres acertó, y eso es lo único que hace
    // falta para ir afinando. Quien repara lo averigua comparando `llave_id`,
    // que para eso está guardado al lado.
    return fallo(
      "interno",
      "Esa credencial no se puede abrir: o se cifró con otra llave maestra, o alguien la cambió en la base. Vuelva a pegarla desde el portal de la pasarela.",
    );
  }
}
