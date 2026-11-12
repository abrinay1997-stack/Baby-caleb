import { z } from "zod";
import { guardar, historial, leerVigentes } from "../../db/ajustes";
import {
  CLAVES,
  ESQUEMAS,
  esPendiente,
  esquemaDe,
  type Clave,
} from "../../dominio/ajustes";
import { definir } from "../registro";

/**
 * Las cifras del negocio, por la otra puerta.
 *
 * ## Por qué existe este archivo
 *
 * La regla la puso el dueño del proyecto y está en el `CLAUDE.md`: un ajuste
 * nuevo no está terminado hasta que se puede usar también por MCP, **en el
 * mismo cambio**. El porqué está en `docs/TRAMPAS.md` §13, y el caso que lo
 * puso ahí es de esta misma tabla: `checkout_activo` vale `true` en producción
 * y ningún código lo consultaba, así que la dueña podía encenderlo y no pasaba
 * nada. Una capacidad que solo se alcanza desde una pantalla depende de que esa
 * pantalla exista, se despliegue y esté bien escrita, y en este repositorio ya
 * se han visto las tres fallar por separado.
 *
 * Hasta hoy `GET /ajustes` y `POST /ajustes/:clave` eran «PENDIENTE» en el mapa
 * de `scripts/sin-mcp.mjs`. Con estas dos herramientas dejan de serlo, y con
 * ellas quedan cubiertos de entrada los dos ajustes nuevos
 * (`whatsapp_pedidos_activo` y `whatsapp_numero`) y los quince que ya estaban.
 *
 * ## Por qué `cambiar_ajuste` es una y no quince
 *
 * Porque el esquema ya describe cada clave —su tipo, su unidad, sus límites y
 * qué significa— en `src/dominio/ajustes.ts`, y es el MISMO que valida la ruta
 * del panel. Una herramienta por clave sería quince copias de esa descripción,
 * y la que se olvide de actualizar es la que nadie revisa. La descripción que
 * lee el modelo se arma aquí a partir del esquema, así que una clave nueva
 * aparece sola.
 *
 * ## Por qué es `sensible`
 *
 * Porque cambia una regla del negocio, y algunas apagan la tienda
 * (`checkout_activo`) o el asistente (`tope_ia_mensual_usd`). `sensible`
 * significa que el asistente NO la ejecuta: la propone con el detalle exacto y
 * espera a que una persona toque «Permitir» (06-asistente §3). Y el motivo es
 * obligatorio, igual que en el panel: es lo que convierte la tabla en un
 * historial que contesta «¿quién apagó esto en marzo?».
 */

/** La lista de claves, escrita para que el modelo pueda elegir una. */
const claveDeAjuste = z
  .enum(CLAVES as [string, ...string[]])
  .describe(
    `Qué regla. Las que hay: ${CLAVES.map((c) => `${c} (${ESQUEMAS[c].titulo})`).join("; ")}.`,
  );

const motivo = z
  .string()
  .min(3)
  .max(500)
  .describe(
    "Por qué se cambia. Queda guardado con el nombre de quien lo hizo y la fecha, y es lo que explica el cambio dentro de seis meses.",
  );

/**
 * Un número de teléfono NO sale entero hacia el modelo. Solo las cuatro
 * últimas cifras.
 *
 * El celular de `whatsapp_numero` es del NEGOCIO, no de una clienta, y está
 * publicado en la web: mandarlo no filtra nada de nadie. Sale enmascarado por
 * otra razón, y conviene decirla: la guarda de D-20 (`revisar()` en
 * `referencias.ts`) señala cualquier cosa con forma de celular en lo que una
 * herramienta devuelve, y la prueba que la aplica recorre TODAS. Abrirle una
 * excepción a «este teléfono es nuestro» sería el primer agujero de una guarda
 * que ya ha cazado fugas de verdad, y el segundo lo pondría otro día alguien
 * con otra buena razón.
 *
 * Y no se pierde nada que haga falta: a «¿a qué número llegan los pedidos?» se
 * contesta igual de bien con las cuatro últimas cifras, que es como lo
 * reconoce quien lo tiene. El número entero se ve en el panel, donde lo lee
 * una persona y no un modelo.
 */
const enmascarar = (numero: string): string =>
  numero.length <= 4 ? "••••" : `•••• ${numero.slice(-4)}`;

/** El valor como puede salir hacia el modelo. */
function valorQuePuedeSalir(clave: Clave, valor: unknown): unknown {
  if (esquemaDe(clave).tipo === "telefono" && typeof valor === "string" && !esPendiente(valor)) {
    return enmascarar(valor);
  }
  return valor;
}

/**
 * El correo recortado antes de la arroba. Contesta «quién» sin dar la dirección.
 *
 * Va arriba del todo porque la usan las dos herramientas de este archivo y un
 * `const` no se iza: definida abajo, `verAjustes` reventaría al cargarse.
 */
const quienLoCambio = (correo: string): string => correo.split("@")[0] ?? correo;

export const verAjustes = definir({
  nombre: "ver_ajustes",
  descripcion:
    "Dice cuánto vale cada regla del negocio ahora mismo, de dónde sale (puesta por alguien o valor de arranque) y cuáles están sin decidir. Con una `clave` da además su historial de cambios. Ejemplo: ver_ajustes con clave «whatsapp_numero» dice a qué celular van los pedidos y quién lo puso.",
  parametros: z.object({
    clave: claveDeAjuste
      .optional()
      .describe(
        "Opcional. Sin ella salen todas; con ella sale esa y su historial.",
      ),
  }),
  nivel: "lectura",
  categoria: "ajustes",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const vigentes = await leerVigentes({ db: ctx.db, ahora: ctx.ahora });
    if (!vigentes.ok) throw new Error(vigentes.mensaje);

    const conSentido = vigentes.datos.ajustes.map((a) => {
      // `esquemaDe` y no `ESQUEMAS[clave]`: el objeto está declarado `as const`,
      // así que indexarlo con una clave variable da el tipo de UNA de ellas y
      // los campos opcionales (`unidad`) desaparecen. El ayudante devuelve
      // `Esquema`, que es lo que describe a todas.
      const e = esquemaDe(a.clave);
      return {
        clave: a.clave,
        titulo: e.titulo,
        valor: valorQuePuedeSalir(a.clave, a.valor),
        // `pendiente` se dice aparte del valor y no se traduce a cero: «falta
        // decidirlo» y «es cero» son dos cosas distintas, y un modelo que lea un
        // 0 va a contestar como si el dato estuviera resuelto (trampa §7).
        sinDecidir: a.pendiente,
        unidad: e.unidad ?? null,
        origen: a.origen,
        // QUIÉN lo cambió NO sale de esta lista, y no es un olvido.
        //
        // `ajustes.cambiado_por` guarda el correo de la sesión, y la guarda de
        // D-20 rechaza cualquier resultado que lleve uno: no sabe —ni puede
        // saber— si es de una clienta o del equipo. Hasta hoy salía entero, y
        // el fallo estaba escondido donde no lo veía nadie: en local y en las
        // pruebas ese campo está vacío en todas las filas (solo lo llevan los
        // ajustes que alguien tocó), así que esto pasaba verde en todas partes
        // y estaba MUERTO en producción — el servidor de MCP tumbaba el
        // resultado entero en cuanto la dueña había cambiado una sola cifra.
        // Lo destapó pedirlo en vivo por MCP.
        //
        // Recortar el correo antes de la arroba —lo que hace el historial— no
        // arregla la clase, solo la estrecha: de `ana@babycaleb.com` queda
        // «ana», y con una clienta llamada Ana la guarda vuelve a tumbarlo, con
        // razón. Así que aquí el campo se quita: en una lista de dieciocho
        // reglas el quién sobra —`origen` ya dice si está guardado o si es el
        // valor de arranque— y para el quién está `ver_historial_de_ajuste`,
        // que es la herramienta que existe para esa pregunta.
        motivo: a.motivo,
        // Un valor guardado que hoy no se puede leer cae al de fábrica y se
        // dice por qué. Callarlo dejaría al modelo contestando con un número
        // que no es el que la dueña cree que puso.
        aviso: a.aviso,
      };
    });

    const faltan = conSentido.filter((a) => a.sinDecidir).map((a) => a.clave);

    /**
     * `aviso` dice lo que NO se sabe, que es el tercer caso que pide
     * 06-asistente: «no hay», «eso no existe» y «no se sabe» son tres
     * respuestas distintas y un modelo las contesta igual si se le dan igual.
     *
     * Aquí la lista nunca vuelve vacía —las claves están siempre—, así que el
     * caso que un modelo podría contestar mal es el otro: leer un `PENDIENTE`
     * y hablar como si el dato estuviera resuelto (trampa §7, «cero no es no
     * sé»). Por eso el aviso cuenta las que faltan, y calla cuando no falta
     * ninguna.
     */
    const aviso =
      faltan.length === 0
        ? null
        : `${faltan.length} de ${conSentido.length} reglas están sin decidir (${faltan.join(", ")}). No valen cero: lo que dependa de ellas no está encendido, y decidirlas es de la dueña.`;

    if (args.clave === undefined) {
      return { ajustes: conSentido, sinDecidir: faltan, aviso };
    }

    const uno = conSentido.find((a) => a.clave === args.clave);
    const versiones = await historial(
      { db: ctx.db, ahora: ctx.ahora },
      args.clave,
    );
    if (!versiones.ok) throw new Error(versiones.mensaje);

    return {
      ajuste: uno,
      versiones: versiones.datos.versiones.map((v) => ({
        ...v,
        valor: v.valor === null ? null : valorQuePuedeSalir(args.clave as Clave, v.valor),
      })),
      aviso: uno?.sinDecidir === true ? `«${uno.titulo}» está sin decidir.` : null,
    };
  },
});

export const cambiarAjuste = definir({
  nombre: "cambiar_ajuste",
  descripcion:
    "Cambia una regla del negocio. El valor va con la forma que esa regla tenga: un número («stock_bajo»: 5), un sí/no («whatsapp_pedidos_activo»: true), un texto («whatsapp_numero»: «50767575065») o la palabra «PENDIENTE» para dejarla sin decidir. No borra nada: escribe la versión siguiente y la anterior queda en el historial. Ejemplo: cambiar_ajuste con clave «whatsapp_pedidos_activo», valor false y motivo «se perdió el celular» quita el botón de WhatsApp de toda la web.",
  parametros: z.object({
    clave: claveDeAjuste,
    // `unknown` a propósito: la forma de cada valor la decide `validar` del
    // dominio, que es la misma copia que usa el panel. Un segundo esquema aquí
    // acabaría discrepando del primero, y el que se equivoca es el que nadie
    // revisa.
    valor: z
      .unknown()
      .describe(
        "El valor nuevo, con la forma de esa regla. «PENDIENTE» (así, en mayúsculas) la deja sin decidir, y no todas lo admiten.",
      ),
    motivo,
  }),
  nivel: "sensible",
  categoria: "ajustes",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const antes = await leerVigentes({ db: ctx.db, ahora: ctx.ahora });
    if (!antes.ok) throw new Error(antes.mensaje);
    const anterior = antes.datos.ajustes.find((a) => a.clave === args.clave);

    const r = await guardar(
      {
        db: ctx.db,
        ahora: ctx.ahora,
        // La firma sale de la sesión, nunca de los argumentos: si el modelo
        // pudiera elegir el nombre, el historial dejaría de contestar quién.
        actor: ctx.usuario.correo,
      },
      { clave: args.clave, valor: args.valor, motivo: args.motivo },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      clave: r.datos.clave,
      titulo: esquemaDe(r.datos.clave).titulo,
      antes:
        anterior === undefined ? null : valorQuePuedeSalir(args.clave as Clave, anterior.valor),
      antesSinDecidir: anterior?.pendiente ?? false,
      ahora: valorQuePuedeSalir(r.datos.clave, r.datos.valor),
      ahoraSinDecidir: esPendiente(r.datos.valor),
      version: r.datos.version,
    };
  },
});

/**
 * El historial de un ajuste: quién lo cambió, cuándo y por qué.
 *
 * Llega de un trabajo paralelo y entra aquí porque es un ajuste. Llama a
 * `historial()` de `src/db/ajustes.ts`, la MISMA función que sirve
 * `GET /ajustes/:clave/historial`: ahí está decidido qué versión manda —la de
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

export const HERRAMIENTAS_DE_AJUSTES = [
  verAjustes,
  cambiarAjuste,
  verHistorialDeAjuste,
] as const;
