import type { Hono } from "hono";
import { z } from "zod";
import { conversar, type Conversacion, type Final } from "../asistente/conversar";
import { confirmar } from "../asistente/ejecutar";
import { catalogo as catalogoDeHerramientas } from "../asistente/index";
import { promptDeCaleb } from "../asistente/prompt";
import {
  MAX_TOKENS_POR_OMISION,
  type Mensaje,
  type Proveedor,
  meta,
} from "../asistente/proveedor";
import { anotarUso } from "../asistente/uso";
import { fallo, ok } from "../contrato/resultado";
import { fechaContable } from "../dominio/contabilidad";
import type { Usuario } from "../seguridad/roles";

/**
 * La puerta de Caleb: el chat del asistente dentro del panel.
 *
 * Vive en su propio archivo y no dentro de `panel.ts` por dos razones, y las
 * dos son prácticas: `panel.ts` ya pasa de las mil líneas, y este trozo tiene
 * su propio secreto, su propio proveedor y su propio motivo para fallar.
 *
 * No lleva `exige(...)`. A propósito: el permiso de cada herramienta ya lo
 * decide la política por el ROL de quien habla, y el registro solo le enseña
 * al modelo las que esa persona puede usar. Poner además un permiso en la
 * puerta dejaría a la asistente sin poder preguntar «¿cuánto queda de la talla
 * M?», que es justo para lo que sirve.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /** La llave del modelo del asistente. Secreto, puesto con `wrangler secret put`. */
      META_API_KEY?: string;
      /** El modelo. Vacío = el de fábrica del proveedor. Es configuración. */
      MODELO_ASISTENTE?: string;
    }
  }
  /**
   * Y también el `Env` global, que es otro. `worker-configuration.d.ts`
   * declara los dos por separado y son HERMANOS, no padre e hijo: ampliar uno
   * no llega al otro. Las pruebas usan `Cloudflare.Env`; las rutas, el global.
   * Es el mismo recurso que usa `seguridad/cifrado.ts`.
   */
  interface Env {
    META_API_KEY?: string;
    MODELO_ASISTENTE?: string;
  }
}

/** Lo que el navegador manda. El historial va y vuelve, como el chat de la web. */
const PETICION = z.object({
  mensajes: z
    .array(
      z.object({
        rol: z.enum(["user", "assistant", "tool"]),
        contenido: z.string().max(8_000),
        llamadaId: z.string().max(80).optional(),
        llamadas: z
          .array(
            z.object({
              id: z.string().max(80),
              nombre: z.string().max(80),
              argumentos: z.unknown(),
            }),
          )
          .max(16)
          .optional(),
      }),
    )
    .min(1)
    .max(40),
  /** En qué pantalla está, para que entienda «esto» y «aquí». */
  pantalla: z.string().max(60).optional(),
});

const DECISION = z.object({ decision: z.enum(["permitir", "rechazar"]) });

type Variables = { usuario: Usuario };
type Entorno = { Bindings: Env; Variables: Variables };

/** Lo que se le devuelve al navegador. El historial vuelve para el siguiente turno. */
function comoSeDevuelve(final: Final): Record<string, unknown> {
  return final.clase === "dijo"
    ? { clase: "dijo", texto: final.texto, historial: final.historial, pasos: final.pasos }
    : {
        clase: "pide_permiso",
        texto: final.texto,
        accionId: final.accionId,
        resumen: final.resumen,
        venceEn: final.venceEn,
        historial: final.historial,
        pasos: final.pasos,
      };
}

/**
 * De dónde sale el cerebro.
 *
 * Devuelve `null` cuando no hay llave, que no es un error: es el estado de un
 * sistema recién instalado. Es una fábrica y no un objeto suelto por lo mismo
 * que `crearPanel`: para que las pruebas puedan entrar sin llamar a Meta de
 * verdad, sin pagar y sin que el resultado cambie cada vez. El valor por
 * OMISIÓN es el real, así que para saltárselo hay que pasar otra cosa a
 * propósito.
 */
export type HacerProveedor = (env: Env) => Proveedor | null;

const porMeta: HacerProveedor = (env) => {
  const llave = (env.META_API_KEY ?? "").trim();
  if (llave === "") return null;
  return meta({ clave: llave, modelo: env.MODELO_ASISTENTE ?? "muse-spark-1.3-contributor" });
};

export function registrarRutasDelAsistente(
  panel: Hono<Entorno>,
  hacerProveedor: HacerProveedor = porMeta,
): void {

  /**
   * Un turno de conversación.
   *
   * Sin llave no se contesta con un error técnico: se dice en español qué
   * falta y quién lo pone. Quien abre el panel no sabe lo que es un secreto de
   * Cloudflare, y un «500» aquí no le dice a nadie qué hacer.
   */
  panel.post("/asistente", async (c) => {
    const proveedor = hacerProveedor(c.env);
    if (proveedor === null) {
      return c.json(
        fallo(
          "no_autorizado",
          "El asistente no tiene su llave puesta todavía. La pone quien administra el sistema, con el secreto META_API_KEY.",
        ),
        503,
      );
    }

    const crudo: unknown = await c.req.json().catch(() => null);
    const leido = PETICION.safeParse(crudo);
    if (!leido.success) {
      return c.json(fallo("entrada_invalida", "ese mensaje no tiene la forma esperada"), 400);
    }

    const usuario = c.get("usuario");
    const ahora = Date.now();

    const peticion: Conversacion = {
      sistema: promptDeCaleb(
        { nombre: usuario.nombre, rol: usuario.rol, pantalla: leido.data.pantalla },
        fechaContable(ahora),
      ),
      mensajes: leido.data.mensajes as readonly Mensaje[],
      canal: "panel",
      conversacionId: null,
      maxTokens: MAX_TOKENS_POR_OMISION,
    };

    try {
      const final = await conversar(
        { db: c.env.DB, usuario: { id: usuario.id, correo: usuario.correo, rol: usuario.rol }, ahora },
        catalogoDeHerramientas(),
        proveedor,
        peticion,
      );

      // Se anota DESPUÉS de contestar bien y antes de devolver. Si falla, no
      // revienta: `anotarUso` se queja en el registro y sigue.
      await anotarUso(c.env.DB, {
        usuarioId: usuario.id,
        canal: "panel",
        modelo: proveedor.modelo,
        uso: final.uso,
        ahora,
        // La tarifa no existe todavía: hueco «tarifa_del_modelo» en
        // Contabilidad. Las fichas sí se anotan.
        tarifa: null,
      });

      return c.json(ok(comoSeDevuelve(final)), 200);
    } catch (e) {
      // El detalle va al registro, no a la pantalla: el cuerpo de un error del
      // proveedor puede traer de vuelta lo que se le mandó, y ahí va el prompt.
      console.warn(
        JSON.stringify({
          evento: "asistente_fallo",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return c.json(
        fallo("interno", "El asistente no está disponible ahora mismo. Inténtelo en un momento."),
        502,
      );
    }
  });

  /**
   * Permitir o rechazar una acción que quedó esperando.
   *
   * Los argumentos NO vienen del navegador: salen de la fila de `acciones`. Es
   * lo que garantiza que se ejecute lo que la persona LEYÓ y no otra cosa.
   */
  panel.post("/asistente/acciones/:id", async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null);
    const leido = DECISION.safeParse(crudo);
    if (!leido.success) {
      return c.json(fallo("entrada_invalida", "falta decir si se permite o se rechaza"), 400);
    }

    const usuario = c.get("usuario");
    const r = await confirmar(
      { db: c.env.DB, usuario: { id: usuario.id, correo: usuario.correo, rol: usuario.rol }, ahora: Date.now() },
      catalogoDeHerramientas(),
      c.req.param("id"),
      leido.data.decision,
    );

    if (!r.ok) {
      const estado =
        r.codigo === "no_encontrado"
          ? 404
          : r.codigo === "no_autorizado"
            ? 403
            : r.codigo === "repetido"
              ? 409
              : 422;
      return c.json(r, estado);
    }
    return c.json(r, 200);
  });
}
