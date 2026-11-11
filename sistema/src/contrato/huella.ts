import { z } from "zod";
import { DATOS_POR_TIPO, SobreEvento, TIPOS_EVENTO } from "./eventos";
import { ESQUEMAS } from "./esquemas";
import { CODIGOS_ERROR } from "./resultado";

/**
 * La huella del contrato.
 *
 * PARA QUÉ
 *
 * El CRM tiene una copia de estos esquemas. Si una copia se queda atrás, el
 * síntoma no es un error claro: es un pedido que entra con un campo que el otro
 * lado ignora, o un evento que llega con una etiqueta que no entiende, y eso se
 * descubre semanas después mirando por qué un aviso no salió. La huella lo
 * convierte en una prueba que falla.
 *
 * DE QUÉ SALE, Y POR QUÉ NO DEL TEXTO
 *
 * El plan dice «SHA-256 del texto de los esquemas». Sale del SIGNIFICADO en vez
 * del texto: se convierte cada esquema a JSON Schema y se hace el hash de eso.
 * Con el texto, arreglar una tilde en un comentario rompería la prueba en los
 * dos repos y obligaría a un commit en el otro lado por nada; con el
 * significado, solo cambia cuando cambia de verdad lo que viaja por el cable.
 *
 * Agregar un campo opcional SÍ cambia la huella, y está bien: es compatible
 * hacia atrás, pero los dos lados tienen que saberlo.
 */

/** Serializa de forma determinista: las claves de todo objeto, ordenadas. */
function estable(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(estable);
  if (valor && typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const clave of Object.keys(valor as Record<string, unknown>).sort()) {
      salida[clave] = estable((valor as Record<string, unknown>)[clave]);
    }
    return salida;
  }
  return valor;
}

/** El contrato entero, como un objeto comparable. */
export function formaDelContrato(): Record<string, unknown> {
  const esquemas: Record<string, unknown> = {};
  for (const nombre of Object.keys(ESQUEMAS).sort()) {
    esquemas[nombre] = z.toJSONSchema(ESQUEMAS[nombre as keyof typeof ESQUEMAS]);
  }

  const eventos: Record<string, unknown> = {};
  for (const tipo of [...TIPOS_EVENTO].sort()) {
    eventos[tipo] = z.toJSONSchema(DATOS_POR_TIPO[tipo]);
  }

  return estable({
    version: 1,
    esquemas,
    eventos,
    sobre: z.toJSONSchema(SobreEvento),
    codigosError: [...CODIGOS_ERROR].sort(),
  }) as Record<string, unknown>;
}

export function textoDelContrato(): string {
  return JSON.stringify(formaDelContrato());
}

/** SHA-256 en hexadecimal. */
export async function calcularHuella(): Promise<string> {
  const bytes = new TextEncoder().encode(textoDelContrato());
  const resumen = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(resumen), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * La huella que este repo declara tener.
 *
 * Está escrita a mano y hay una prueba que la recalcula y la compara: así, un
 * cambio en un esquema no pasa en silencio — hay que venir aquí, ver que la
 * huella cambió y entender que el CRM necesita la misma. Es una molestia a
 * propósito.
 *
 * Se actualiza con `npm run huella`.
 */
/*
 * 2026-11-11 · cambió al registrar `Cobertura` y `VariantePublica.pedido`.
 *
 * No cambia ningún comportamiento: documenta uno que ya existía. `buscarCatalogo`
 * devolvía el campo `pedido` —la única puerta por la que una cantidad de
 * inventario sale del sistema— y el contrato no lo mencionaba, así que la huella
 * vigilaba todo menos el campo que lleva el número exacto. El CRM necesita esta
 * misma huella en `src/sistema/contrato.ts`.
 */
export const HUELLA_CONTRATO =
  "c0595a467dd9c25779e36dc57fe96dd4c45ea177a3567519a8a62a6eb134a047";
