import { Hono, type MiddlewareHandler } from "hono";
import { fallo, ok } from "../contrato/resultado";
import { atrasados } from "../eventos";
import { type Permiso, type Usuario, permisosDe, puedeVer, revisarPeticion, usuarioDeCorreo } from "../seguridad";

/**
 * La API del panel.
 *
 * Va aparte de `src/index.ts` para que el Worker siga siendo legible de un
 * vistazo y para que esto se pueda probar sin montar el enrutador entero.
 *
 * Tres reglas que se cumplen en TODAS las rutas:
 *
 *  1. **La puerta se comprueba en cada petición**, no al entrar. Access firma un
 *     token con vencimiento, y el correo se cruza con `usuarios` cada vez: así,
 *     desactivar a alguien tiene efecto en la siguiente llamada y no cuando
 *     caduque su sesión.
 *  2. **El permiso se comprueba aquí**, no en la pantalla. Que el panel esconda
 *     un botón es una cortesía; esto es la defensa.
 *  3. **El costo no sale si el rol no lo tiene.** No se filtra en la pantalla:
 *     no se consulta. Lo que no sale del servidor no se puede filtrar por error.
 */

type Variables = { usuario: Usuario };
type Entorno = { Bindings: Env; Variables: Variables };

/**
 * Quién abrió. Devuelve el usuario, o el motivo por el que no entra.
 *
 * Son dos pasos distintos y los dos pueden fallar: Access dice que la persona
 * es quien dice ser, y `usuarios` dice si además trabaja aquí. Separarlos es lo
 * que hace que desactivar a alguien tenga efecto en la siguiente petición, sin
 * esperar a que caduque su sesión de Access ni tocar nada en Cloudflare.
 */
export type ResolverUsuario = (
  request: Request,
  env: Env,
) => Promise<{ ok: true; usuario: Usuario } | { ok: false; motivo: string }>;

const porAccess: ResolverUsuario = async (request, env) => {
  const puerta = await revisarPeticion(request, env);
  if (!("identidad" in puerta)) {
    return { ok: false, motivo: `Access: ${puerta.rechazo.motivo}` };
  }

  const fila = await env.DB.prepare(
    // COLLATE NOCASE: Access entrega el correo en minúsculas, pero las filas
    // de `usuarios` se escriben a mano y un «Yarielis@Gmail.com» tecleado con
    // mayúscula dejaría a esa persona fuera para siempre, con un «no
    // autorizado» que no explica nada. El índice único de la migración 0005
    // impide además que existan dos filas que solo se diferencien en eso.
    "SELECT id, correo, nombre, rol, activo FROM usuarios WHERE correo = ? COLLATE NOCASE",
  )
    .bind(puerta.identidad.correo)
    .first<{ id: string; correo: string; nombre: string; rol: string; activo: number }>();

  const usuario = usuarioDeCorreo(puerta.identidad.correo, fila);
  return usuario.ok ? { ok: true, usuario: usuario.usuario } : { ok: false, motivo: usuario.motivo };
};

/**
 * Arma la API del panel.
 *
 * Es una fábrica y no un objeto suelto para que las pruebas puedan entrar sin
 * montar un Cloudflare Access de verdad. El valor por DEFECTO es la puerta
 * real: para saltársela hay que pasar otra cosa a propósito, así que no se
 * puede olvidar — que es la propiedad que importa.
 */
export function crearPanel(resolver: ResolverUsuario = porAccess) {
  const panel = new Hono<Entorno>();

  panel.use("*", async (c, next) => {
    const quien = await resolver(c.req.raw, c.env);
    if (!quien.ok) return c.json(fallo("no_autorizado", quien.motivo), 403);
    c.set("usuario", quien.usuario);
    await next();
    return;
  });

  registrarRutas(panel);
  return panel;
}

/** La API lista para montar, con la puerta de verdad. */
export const panel = crearPanel();

/** Corta la ruta si el rol no alcanza. */
function exige(permiso: Permiso): MiddlewareHandler<Entorno> {
  return async (c, next) => {
    const usuario = c.get("usuario");
    if (!puedeVer(usuario.rol, permiso)) {
      return c.json(
        fallo("no_autorizado", `Su rol no tiene acceso a ${permiso.replace(/_/g, " ")}.`),
        403,
      );
    }
    await next();
    return;
  };
}

// ---------------------------------------------------------------------------

function registrarRutas(panel: Hono<Entorno>): void {
  panel.get("/yo", (c) => {
    const usuario = c.get("usuario");
    return c.json(ok({ usuario, permisos: permisosDe(usuario.rol) }));
  });

  /**
   * El resumen del inicio.
   *
   * Son cuentas, no listas: lo que la dueña necesita al abrir el panel es saber
   * si algo va mal, y para eso basta un número. Lo de «avisos sin publicar» no
   * sale de ninguna otra pantalla y es la primera señal de que los mensajes a las
   * clientas no están llegando.
   */
  panel.get("/resumen", async (c) => {
    const [variantes, bodegas, zonas, clientes, outbox] = await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) n FROM variantes WHERE activo = 1").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) n FROM bodegas WHERE activa = 1").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) n FROM zonas_envio WHERE activa = 1").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) n FROM clientes WHERE anonimizado_en IS NULL").first<{ n: number }>(),
      atrasados(c.env.DB),
    ]);

    // Lo que está por acabarse, con la etiqueta y nunca el número exacto hacia
    // afuera — aquí sí se puede, porque esto es el panel de la dueña.
    const { results: bajos } = await c.env.DB.prepare(
      `SELECT e.codigo, v.nombre, b.nombre AS bodega, e.fisico - e.reservado AS libres, e.minimo
       FROM existencias e
       JOIN variantes v ON v.codigo = e.codigo
       JOIN bodegas b ON b.id = e.bodega_id
       WHERE e.minimo IS NOT NULL AND e.fisico - e.reservado <= e.minimo
       ORDER BY libres, e.codigo
       LIMIT 20`,
    ).all<{ codigo: string; nombre: string; bodega: string; libres: number; minimo: number }>();

    return c.json(
      ok({
        variantes: variantes?.n ?? 0,
        bodegas: bodegas?.n ?? 0,
        zonas: zonas?.n ?? 0,
        clientes: clientes?.n ?? 0,
        avisosSinPublicar: outbox.cuantos,
        avisoMasViejo: outbox.masViejo,
        porAcabarse: bajos,
      }),
    );
  });

  panel.get("/catalogo", exige("pedidos"), async (c) => {
    const usuario = c.get("usuario");
    const conCosto = puedeVer(usuario.rol, "costo_y_margen");

    // El costo se une solo si el rol lo tiene. No se consulta y se filtra: no se
    // consulta.
    const { results } = await c.env.DB.prepare(
      `SELECT v.codigo, v.nombre, v.talla, v.unidades_por_caja, v.precio_cents,
              v.tasa_itbms_bp, v.publicado, v.activo, p.familia, p.nombre AS producto
              ${conCosto ? ", vi.unidades AS costo_unidades, vi.valor_cents AS costo_valor_cents" : ""}
       FROM variantes v
       JOIN productos p ON p.id = v.producto_id
       ${conCosto ? "LEFT JOIN valor_inventario vi ON vi.codigo = v.codigo" : ""}
       ORDER BY p.orden, p.nombre, v.talla, v.codigo`,
    ).all();

    return c.json(ok({ variantes: results, muestraCosto: conCosto }));
  });

  panel.get("/existencias", exige("pedidos"), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT e.codigo, v.nombre, b.id AS bodega_id, b.nombre AS bodega,
              e.fisico, e.reservado, e.fisico - e.reservado AS libres, e.minimo
       FROM existencias e
       JOIN variantes v ON v.codigo = e.codigo
       JOIN bodegas b ON b.id = e.bodega_id
       ORDER BY v.nombre, b.nombre`,
    ).all();
    return c.json(ok({ existencias: results }));
  });

  panel.get("/bodegas", exige("pedidos"), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.nombre, b.activa,
              (SELECT COUNT(*) FROM existencias e WHERE e.bodega_id = b.id) AS variantes,
              (SELECT COALESCE(SUM(e.fisico), 0) FROM existencias e WHERE e.bodega_id = b.id) AS unidades
       FROM bodegas b ORDER BY b.nombre`,
    ).all();
    return c.json(ok({ bodegas: results }));
  });

  panel.get("/zonas", exige("pedidos"), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT z.id, z.nombre, z.alias_json, z.region, z.metodo, z.tarifa_cents,
              z.requiere_pago_total, z.activa, b.nombre AS bodega_preferida
       FROM zonas_envio z
       LEFT JOIN bodegas b ON b.id = z.bodega_preferida_id
       ORDER BY z.region, z.nombre`,
    ).all<{ alias_json: string }>();

    // El alias viaja como texto JSON en la base; la pantalla quiere una lista.
    const zonas = results.map((z) => {
      let alias: string[] = [];
      try {
        const leido: unknown = JSON.parse(z.alias_json);
        if (Array.isArray(leido)) alias = leido.filter((a): a is string => typeof a === "string");
      } catch {
        // Un alias ilegible no tumba la pantalla: se ve la zona sin sus alias.
      }
      const { alias_json: _, ...resto } = z;
      return { ...resto, alias };
    });

    return c.json(ok({ zonas }));
  });

  panel.get("/usuarios", exige("ajustes"), async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, correo, nombre, rol, telegram_chat_id, activo, creado_en FROM usuarios ORDER BY nombre",
    ).all();
    return c.json(ok({ usuarios: results }));
  });

  /**
   * Los ajustes vigentes.
   *
   * Cada clave puede tener varias versiones y vale la más alta cuya vigencia ya
   * empezó (02-datos §9). Lo que no tiene ninguna versión cae en el valor de
   * fábrica de `reglas.json`, y eso se dice: una pantalla que enseña un número
   * sin decir de dónde sale invita a creérselo.
   */
  panel.get("/ajustes", exige("ajustes"), async (c) => {
    const ahora = Date.now();
    const { results } = await c.env.DB.prepare(
      `SELECT a.clave, a.version, a.valor_json, a.vigente_desde, a.cambiado_por, a.motivo
       FROM ajustes a
       WHERE a.vigente_desde <= ?1
         AND a.version = (SELECT MAX(b.version) FROM ajustes b
                          WHERE b.clave = a.clave AND b.vigente_desde <= ?1)
       ORDER BY a.clave`,
    )
      .bind(ahora)
      .all<{ clave: string; version: number; valor_json: string; vigente_desde: number }>();

    const vigentes = results.map((a) => {
      let valor: unknown = null;
      try {
        valor = JSON.parse(a.valor_json);
      } catch {
        valor = a.valor_json;
      }
      return { ...a, valor };
    });

    return c.json(ok({ vigentes, ahora }));
  });
}
