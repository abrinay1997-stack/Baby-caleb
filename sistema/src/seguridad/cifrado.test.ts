import { describe, expect, it } from "vitest";
import {
  LARGO_LLAVE,
  LARGO_NONCE,
  PREFIJO,
  abrirLlaveMaestra,
  cifrar,
  descifrar,
  type Llave,
} from "./cifrado";

/**
 * El cifrado de las credenciales de cobro.
 *
 * Lo que se vigila, por orden de lo que dolería más:
 *
 *  1. **Que el criptograma no contenga el secreto.** Un «cifrado» que en
 *     realidad es un base64 pasa cualquier prueba de ida y vuelta y no protege
 *     nada. Aquí se mira el texto guardado.
 *  2. **Que el nonce sea distinto en cada cifrado.** Repetirlo con la misma
 *     llave rompe el cifrado de los dos mensajes y la autenticación de todos.
 *  3. **Que un secreto no se pueda mover de sitio.** El contexto va como datos
 *     autenticados: el de prueba no se abre como si fuera el de real. Es el
 *     fallo caro de esta pieza, hecho imposible por el criptograma.
 *  4. **Que un cambio en la base se note.** Un bit tocado tiene que fallar, no
 *     devolver basura.
 *  5. **Que sin llave maestra no se guarde nada**, y que el error lo diga con
 *     palabras que sirvan.
 *
 * Cada prueba se comprobó rompiendo a propósito lo que dice vigilar; las
 * mutaciones están anotadas.
 */

// Llaves obviamente falsas: son 32 bytes de texto legible, no llaves de verdad.
// Ninguna llave ni credencial real entra en un archivo de este repositorio.
const LLAVE_A = "TExBVkUtRkFMU0EtREUtUFJVRUJBLTMyLUJZVEVTISE="; // 'LLAVE-FALSA-DE-PRUEBA-32-BYTES!!'
const LLAVE_B = "T1RSQS1MTEFWRS1GQUxTQS1ERS1QUlVFQkEtMzItQiE="; // 'OTRA-LLAVE-FALSA-DE-PRUEBA-32-B!'

const SECRETO = "CLAVE-FALSA-DE-PRUEBA-NO-SIRVE-1";
const SITIO = "babycaleb/pasarela/yappy/prueba/clave_secreta";
const OTRO_SITIO = "babycaleb/pasarela/yappy/real/clave_secreta";

async function llave(material = LLAVE_A): Promise<Llave> {
  const r = await abrirLlaveMaestra(material);
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

async function sobreDe(secreto = SECRETO, sitio = SITIO, material = LLAVE_A): Promise<string> {
  const r = await cifrar(await llave(material), secreto, sitio);
  if (!r.ok) throw new Error(r.mensaje);
  return r.datos;
}

/** Los bytes del sobre, para mirarle el nonce por dentro. */
function bytesDe(sobre: string): Uint8Array {
  const base = sobre.slice(PREFIJO.length).replace(/-/g, "+").replace(/_/g, "/");
  const relleno = base + "=".repeat((4 - (base.length % 4)) % 4);
  return Uint8Array.from(atob(relleno), (l) => l.charCodeAt(0));
}

// ---------------------------------------------------------------------------

describe("abrirLlaveMaestra", () => {
  /**
   * Sin llave no se cifra, y el mensaje tiene que servirle a quien lo lea en un
   * teléfono: nombra el secreto que falta y dice a quién avisar.
   *
   * Mutación: devolviendo `ok` con una llave de ceros cuando falta el material
   * —el atajo «para que al menos funcione»— se cae. Y eso es justo el fallo que
   * esta prueba existe para impedir: un cifrado con llave conocida es texto
   * plano con pasos extra.
   */
  it("falla si no está puesta, y dice cómo se pone", async () => {
    for (const material of [undefined, null, "", "   "]) {
      const r = await abrirLlaveMaestra(material);
      expect(r.ok, JSON.stringify(material)).toBe(false);
      if (r.ok) return;
      expect(r.mensaje).toContain("PASARELAS_LLAVE_MAESTRA");
    }
  });

  /**
   * Una llave que no mide 32 bytes se rechaza en vez de estirarse o recortarse.
   * Derivar una llave de cualquier cosa dejaría que una contraseña corta —o la
   * palabra «cambiar»— pasara por llave maestra.
   *
   * Mutación: rellenando con ceros hasta 32 bytes, se cae.
   */
  it("exige 32 bytes exactos", async () => {
    // 'corta' y 31 y 33 bytes, todos en base64 válido.
    for (const material of [
      btoa("corta"),
      btoa("a".repeat(LARGO_LLAVE - 1)),
      btoa("a".repeat(LARGO_LLAVE + 1)),
      "no-es-base64-%%%",
    ]) {
      const r = await abrirLlaveMaestra(material);
      expect(r.ok, material).toBe(false);
    }
    expect((await abrirLlaveMaestra(btoa("a".repeat(LARGO_LLAVE)))).ok).toBe(true);
  });

  /**
   * Acepta las dos variantes de base64 porque la llave la va a pegar una
   * persona: `openssl rand -base64 32` da `+/=` y un generador en la web suele
   * dar `-_`. Rechazar una llave buena por el alfabeto es un cuarto de hora
   * perdido buscando un error que no existe.
   */
  it("acepta base64 normal y base64url, con relleno y sin él", async () => {
    const conMas = await abrirLlaveMaestra(LLAVE_A);
    const sinRelleno = await abrirLlaveMaestra(LLAVE_A.replace(/=+$/, ""));
    const comoUrl = await abrirLlaveMaestra(LLAVE_A.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(conMas.ok && sinRelleno.ok && comoUrl.ok).toBe(true);
    if (!conMas.ok || !sinRelleno.ok || !comoUrl.ok) return;
    // Las tres escrituras son la MISMA llave, así que la huella coincide.
    expect(sinRelleno.datos.id).toBe(conMas.datos.id);
    expect(comoUrl.datos.id).toBe(conMas.datos.id);
  });

  /**
   * La huella distingue dos llaves y es estable. Es de la LLAVE, no de ningún
   * secreto: una huella del secreto permitiría comprobar conjeturas.
   *
   * Mutación: devolviendo `id: "llave"` fijo, se cae — y con ella se perdería
   * lo único que avisa de que un sobre viejo ya no se puede abrir.
   */
  it("da una huella estable y distinta por llave", async () => {
    const a1 = await llave(LLAVE_A);
    const a2 = await llave(LLAVE_A);
    const b = await llave(LLAVE_B);
    expect(a1.id).toBe(a2.id);
    expect(a1.id).not.toBe(b.id);
    expect(a1.id.length).toBeGreaterThan(8);
  });

  it("no deja extraer los bytes de la llave ni al propio código", async () => {
    const k = await llave();
    expect(k.clave.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", k.clave)).rejects.toThrow();
  });

  it("no repite el material de la llave en ningún mensaje", async () => {
    const reconocible = btoa("x".repeat(7));
    const r = await abrirLlaveMaestra(reconocible);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r)).not.toContain(reconocible);
  });
});

// ---------------------------------------------------------------------------

describe("cifrar y descifrar", () => {
  it("da la vuelta completa", async () => {
    const k = await llave();
    const sobre = await cifrar(k, SECRETO, SITIO);
    expect(sobre.ok).toBe(true);
    if (!sobre.ok) return;
    const claro = await descifrar(k, sobre.datos, SITIO);
    expect(claro.ok).toBe(true);
    if (!claro.ok) return;
    expect(claro.datos).toBe(SECRETO);
  });

  /**
   * **La prueba que más importa de este archivo.**
   *
   * El sobre no puede contener el secreto, ni tal cual ni en base64 ni al
   * revés. Mutación: cambiando `cifrar` por `PREFIJO + btoa(secreto)` —el
   * «cifrado» que pasa cualquier prueba de ida y vuelta— se cae aquí y en
   * ningún otro sitio.
   */
  it("el sobre no contiene el secreto de ninguna forma reconocible", async () => {
    const sobre = await sobreDe();
    expect(sobre.startsWith(PREFIJO)).toBe(true);
    expect(sobre).not.toContain(SECRETO);
    expect(sobre).not.toContain(btoa(SECRETO));
    expect(sobre).not.toContain(btoa(SECRETO).replace(/\+/g, "-").replace(/\//g, "_"));
    expect(sobre).not.toContain([...SECRETO].reverse().join(""));
    // Ni un trozo largo de él: cinco caracteres seguidos del secreto ya serían
    // una pista de que algo pasa en claro.
    for (let i = 0; i + 5 <= SECRETO.length; i++) {
      expect(sobre, `trozo en ${i}`).not.toContain(SECRETO.slice(i, i + 5));
    }
  });

  /**
   * Un nonce nuevo en cada cifrado. Mutación: fijando el nonce a doce ceros, la
   * ida y vuelta sigue funcionando y esto se cae — que es exactamente por qué
   * una prueba de ida y vuelta no basta para un cifrado.
   */
  it("cifra el mismo secreto dos veces y salen dos sobres distintos", async () => {
    const k = await llave();
    const uno = await cifrar(k, SECRETO, SITIO);
    const dos = await cifrar(k, SECRETO, SITIO);
    expect(uno.ok && dos.ok).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect(uno.datos).not.toBe(dos.datos);
    // Y lo que cambia es el nonce, no un relleno cualquiera al final.
    const nonceUno = bytesDe(uno.datos).subarray(0, LARGO_NONCE);
    const nonceDos = bytesDe(dos.datos).subarray(0, LARGO_NONCE);
    expect([...nonceUno]).not.toEqual([...nonceDos]);
  });

  it("el sobre mide lo que debe: nonce, texto y etiqueta de 16 bytes", async () => {
    const sobre = await sobreDe();
    const bytes = bytesDe(sobre);
    expect(bytes.length).toBe(LARGO_NONCE + SECRETO.length + 16);
  });

  /**
   * Con otra llave no se abre. Mutación: pasando `additionalData` por fuera o
   * ignorando la llave, se cae.
   */
  it("no se abre con otra llave maestra", async () => {
    const sobre = await sobreDe(SECRETO, SITIO, LLAVE_A);
    const r = await descifrar(await llave(LLAVE_B), sobre, SITIO);
    expect(r.ok).toBe(false);
  });

  /**
   * **El guardia contra el fallo caro.** Un secreto cifrado para el modo de
   * prueba no se puede abrir como el del modo real, aunque alguien copie el
   * texto de una fila a otra con un UPDATE a mano.
   *
   * Mutación: quitando `additionalData` de las dos llamadas, la ida y vuelta
   * sigue pasando y esto se cae. Es la mutación más peligrosa de todas, porque
   * el sistema seguiría funcionando: cobraría con las claves equivocadas.
   */
  it("no se abre en otro sitio del que se cifró", async () => {
    const sobre = await sobreDe(SECRETO, SITIO);
    expect((await descifrar(await llave(), sobre, OTRO_SITIO)).ok).toBe(false);
    // Ni con el de otra pasarela, ni con el de otra credencial.
    for (const sitio of [
      "babycaleb/pasarela/paypal/prueba/clave_secreta",
      "babycaleb/pasarela/yappy/prueba/id_comercio",
      "",
      SITIO + " ",
    ]) {
      expect((await descifrar(await llave(), sobre, sitio)).ok, sitio).toBe(false);
    }
    // Y en el suyo sí.
    expect((await descifrar(await llave(), sobre, SITIO)).ok).toBe(true);
  });

  /**
   * Un bit tocado tiene que fallar, no devolver basura. Es la etiqueta de
   * autenticación de GCM: sin ella, quien pueda escribir en la base puede
   * cambiar el criptograma y lo que salga al descifrar será otra cosa sin que
   * nada se queje.
   *
   * Mutación: usando AES-CTR en vez de AES-GCM, la ida y vuelta pasa y esto se
   * cae.
   */
  it("detecta que alguien cambió el criptograma", async () => {
    const sobre = await sobreDe();
    const k = await llave();

    // Un carácter del medio, cambiado por otro del mismo alfabeto.
    const medio = Math.floor(sobre.length / 2);
    const original = sobre[medio]!;
    const cambiado =
      sobre.slice(0, medio) + (original === "A" ? "B" : "A") + sobre.slice(medio + 1);
    expect(cambiado).not.toBe(sobre);
    expect((await descifrar(k, cambiado, SITIO)).ok).toBe(false);

    // Recortado por el final: se lleva parte de la etiqueta.
    expect((await descifrar(k, sobre.slice(0, sobre.length - 4), SITIO)).ok).toBe(false);

    // Y el nonce cambiado por delante.
    const trasPrefijo = PREFIJO.length;
    const conOtroNonce =
      sobre.slice(0, trasPrefijo) +
      (sobre[trasPrefijo] === "A" ? "B" : "A") +
      sobre.slice(trasPrefijo + 1);
    expect((await descifrar(k, conOtroNonce, SITIO)).ok).toBe(false);
  });

  it("rechaza lo que no tiene la forma de un sobre de este sistema", async () => {
    const k = await llave();
    for (const sobre of ["", SECRETO, btoa(SECRETO), "aesgcm2." + btoa(SECRETO), PREFIJO, PREFIJO + "AAAA"]) {
      expect((await descifrar(k, sobre, SITIO)).ok, JSON.stringify(sobre)).toBe(false);
    }
  });

  it("no cifra la nada, ni cifra sin decir a qué sitio pertenece", async () => {
    const k = await llave();
    expect((await cifrar(k, "", SITIO)).ok).toBe(false);
    expect((await cifrar(k, SECRETO, "")).ok).toBe(false);
  });

  /**
   * Ningún mensaje de error lleva el secreto. Un error se pinta en la pantalla
   * y acaba en una captura; es una de las formas fáciles de que una clave salga
   * de donde debe estar.
   */
  it("no repite el secreto en ningún mensaje de error", async () => {
    const k = await llave();
    const fallos = [
      await cifrar(k, "", SITIO),
      await cifrar(k, SECRETO, ""),
      await descifrar(k, SECRETO, SITIO),
      await descifrar(await llave(LLAVE_B), await sobreDe(), SITIO),
    ];
    for (const r of fallos) {
      expect(JSON.stringify(r)).not.toContain(SECRETO);
    }
  });

  /**
   * Los tres motivos de que un sobre no se abra se contestan IGUAL.
   * Distinguirlos le diría a quien está probando cuál de las tres acertó, y eso
   * es lo único que hace falta para ir afinando.
   */
  it("no dice cuál de los tres motivos fue", async () => {
    const sobre = await sobreDe();
    const otraLlave = await descifrar(await llave(LLAVE_B), sobre, SITIO);
    const otroSitio = await descifrar(await llave(), sobre, OTRO_SITIO);
    expect(otraLlave.ok || otroSitio.ok).toBe(false);
    if (otraLlave.ok || otroSitio.ok) return;
    expect(otraLlave.mensaje).toBe(otroSitio.mensaje);
  });

  it("aguanta un secreto largo y con caracteres raros dentro de lo visible", async () => {
    const raro = "aA0!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".repeat(10);
    const k = await llave();
    const sobre = await cifrar(k, raro, SITIO);
    expect(sobre.ok).toBe(true);
    if (!sobre.ok) return;
    const claro = await descifrar(k, sobre.datos, SITIO);
    expect(claro.ok).toBe(true);
    if (!claro.ok) return;
    expect(claro.datos).toBe(raro);
  });
});
