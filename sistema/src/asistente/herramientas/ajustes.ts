import { z } from "zod";
import { historial } from "../../db/ajustes";
import { CLAVES } from "../../dominio/ajustes";
import { definir } from "../registro";

/**
 * Los ajustes del negocio, por MCP.
 *
 * De momento solo el HISTORIAL, que es la pregunta que no tenía respuesta
 * fuera del panel: «¿quién bajó la comisión en marzo, y por qué?». Leer el
 * valor vigente y cambiarlo van por sus propias rutas (`GET /ajustes` y
 * `POST /ajustes/:clave`) y no por aquí.
 *
 * Llama a `historial()` de `src/db/ajustes.ts`, la MISMA función que sirve
 * `GET /ajustes/:clave/historial`. Ahí está decidido qué versión manda —la de
 * número más alto entre las que ya empezaron— y se calcula sobre las mismas
 * filas que se devuelven, para que el panel y esto no puedan discrepar.
 *
 * ## Por qué la lista de ajustes va en la DESCRIPCIÓN y no en el resultado
 *
 * Los nombres de los ajustes se le enseñan al modelo en el esquema de la
 * herramienta, no devolviéndoselos. No es estilo: la guarda de D-20 compara lo
 * que sale con los nombres de clientas que hay en la base, y un nombre de tres
 * letras casa dentro de una palabra larga —«Ana» vive dentro de
 * «ventanas_entrega»—. Con la lista en el resultado, tener una clienta llamada
 * Ana tumbaba el resultado ENTERO y la herramienta dejaba de servir. En el
 * esquema la lista va igual de completa, llega antes (el modelo la lee para
 * elegir) y no pasa por la guarda, porque no es un dato del negocio: es la
 * declaración de qué ajustes existen.
 *
 * ## Por qué el correo de quien lo cambió no sale tal cual
 *
 * `ajustes.cambiado_por` guarda el correo de la sesión. Un correo es un dato de
 * contacto y la guarda de D-20 (`asistente/referencias.ts`) rechaza cualquier
 * resultado que lleve uno: no sabe —ni puede saber— si es de una clienta o del
 * equipo, y aflojarla para que distinga sería abrirle la puerta a lo que
 * protege. Así que sale solo la parte de delante de la arroba, que es lo que
 * contesta «quién» sin entregar una dirección a la que escribirle. Si saliera
 * el correo completo, el servidor de MCP tumbaría el resultado ENTERO y la
 * herramienta no serviría para nada.
 */

export const verHistorialDeAjuste = definir({
  nombre: "ver_historial_de_ajuste",
  descripcion:
    "Las versiones de un ajuste, de la más nueva a la más vieja, con quién lo cambió, cuándo empezó a valer y por qué. Ejemplo: ver_historial_de_ajuste con ajuste «abono_minimo_cents» cuenta cada vez que se movió el abono mínimo.",
  parametros: z.object({
    ajuste: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe(
        // La lista completa, aquí y no en el resultado: ver la cabecera del
        // archivo. El modelo la lee antes de elegir, así que no tiene por qué
        // inventarse un nombre.
        `El nombre del ajuste. Los que hay son: ${CLAVES.join(", ")}.`,
      ),
  }),
  nivel: "lectura",
  // La ruta del panel pide el permiso `ajustes` para LEER esto (mirar quién
  // cambió una cifra no es cambiarla), y hoy solo la dueña lo tiene.
  roles: ["duena"],
  categoria: "ajustes",

  async ejecutar(ctx, args) {
    // Sin ajuste no se adivina uno. Y la lista de los que hay NO se devuelve:
    // está en la descripción del parámetro, por lo que explica la cabecera.
    if (args.ajuste === undefined) {
      return {
        ajuste: null,
        versiones: [],
        cuantas: 0,
        aviso: "falta decir de qué ajuste quiere el historial: el nombre va en «ajuste».",
      };
    }

    const r = await historial({ db: ctx.db, ahora: ctx.ahora }, args.ajuste);

    if (!r.ok) {
      // Un nombre que no es un ajuste de este sistema se contesta explicado y
      // no como un fallo: «[]» a secas se lee como «nunca se cambió», que es
      // una afirmación distinta y falsa. El texto es el de `db/ajustes.ts`, no
      // uno nuevo: dos redacciones de la misma causa acaban discrepando.
      if (r.codigo === "no_encontrado") {
        return {
          ajuste: args.ajuste,
          versiones: [],
          cuantas: 0,
          aviso: `${r.mensaje} Mire la lista de la descripción de esta herramienta.`,
        };
      }
      throw new Error(r.mensaje);
    }

    const versiones = r.datos.versiones.map((v) => ({
      version: v.version,
      valor: v.valor,
      vigente_desde: v.vigente_desde,
      cambiado_por: quienLoCambio(v.cambiado_por),
      motivo: v.motivo,
      // Las dos cosas se dicen por separado porque son distintas: la vigente es
      // la que manda hoy, y una futura está guardada y todavía no vale. Un
      // modelo que solo viera la lista ordenada contestaría que manda la de
      // arriba, que puede ser la de la semana que viene.
      vigente: v.vigente,
      futura: v.futura,
    }));

    return {
      ajuste: r.datos.clave,
      versiones,
      cuantas: versiones.length,
      aviso:
        versiones.length === 0
          ? `«${r.datos.clave}» nunca se ha cambiado: vale el valor de fábrica de reglas.json.`
          : null,
    };
  },
});

/** El correo recortado antes de la arroba. Contesta «quién» sin dar la dirección. */
const quienLoCambio = (correo: string): string => correo.split("@")[0] ?? correo;

export const HERRAMIENTAS_DE_AJUSTES = [verHistorialDeAjuste] as const;
