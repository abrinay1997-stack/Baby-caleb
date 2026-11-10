import { Hono, type Context, type MiddlewareHandler } from "hono";
import { fallo, ok } from "../contrato/resultado";
import { atrasados } from "../eventos";
import {
  type Permiso,
  type Usuario,
  permisosDe,
  puedeEditar,
  puedeVer,
  revisarPeticion,
  usuarioDeCorreo,
} from "../seguridad";
import {
  borrarVariante,
  comoSeBorra,
  crearProducto,
  crearProductoConVariante,
  crearVariante,
  editarVariante,
  explicar,
} from "../db/catalogo-admin";

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

/**
 * Corta la ruta si el rol puede MIRAR pero no CAMBIAR.
 *
 * `exige` usa `puedeVer` y vale para las pantallas de lectura. Escribir es otra
 * cosa, y la diferencia es el pedido explícito del dueño: «que Juancito no
 * venga y cambie los permisos y las políticas; eso lo hace solamente el
 * administrador». Para `precios_y_stock`, `ajustes` y `cierre_de_mes` el único
 * rol que puede editar es `duena` — hay una prueba en `roles.test.ts` que se
 * cae si eso cambia.
 *
 * Esto NO sustituye a esconder el botón en el panel: esconder sin comprobar no
 * es seguridad, y comprobar sin esconder es ofrecer algo que va a dar 403.
 *
 * Se exporta para poder probarlo CONTRA UN PERMISO DONDE VER Y EDITAR NO
 * COINCIDEN. Hoy, sobre `precios_y_stock`, los tres roles del panel dan el
 * mismo resultado con `puedeVer` y con `puedeEditar` —la dueña edita, las
 * otras dos no ven— así que una prueba por las rutas del catálogo no distingue
 * una puerta de la otra y pasaría igual con la equivocada. Lo comprobé
 * cambiándola: la prueba seguía verde. La diferencia importa el día que exista
 * un rol que mire precios sin tocarlos, y ese día nadie va a volver aquí.
 */
export function exigeEditar(permiso: Permiso): MiddlewareHandler<Entorno> {
  return async (c, next) => {
    const usuario = c.get("usuario");
    if (!puedeEditar(usuario.rol, permiso)) {
      return c.json(
        fallo(
          "no_autorizado",
          `Su rol puede ver ${permiso.replace(/_/g, " ")}, pero no cambiarlo.`,
        ),
        403,
      );
    }
    await next();
    return;
  };
}

/** El cuerpo de la petición, o `null` si no venía un objeto JSON. */
async function cuerpo(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const j = await c.req.json();
    return typeof j === "object" && j !== null && !Array.isArray(j)
      ? (j as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const texto = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * El código del contrato decide el HTTP, no al revés.
 *
 * Los doce códigos son contrato con el CRM y quien llama actúa según el código,
 * no según el número. Esto existe para que el navegador y los intermedios
 * (cachés, proxys) no traten un conflicto como un éxito.
 */
function codigoHttp(codigo: string): 400 | 403 | 404 | 409 | 422 | 500 {
  switch (codigo) {
    case "entrada_invalida":
      return 400;
    case "no_autorizado":
      return 403;
    case "no_encontrado":
      return 404;
    // Repetido y conflicto de versión son los dos «alguien llegó antes»: 409 es
    // justo lo que significa, y la pantalla sabe que toca recargar.
    case "repetido":
    case "conflicto_version":
      return 409;
    case "transicion_invalida":
    case "sin_stock":
      return 422;
    default:
      return 500;
  }
}

/**
 * El contexto que piden las operaciones de catálogo, con QUIÉN lo hizo.
 *
 * El actor es el correo del usuario y no un «panel» genérico: es lo que queda
 * escrito en `precios_historial` cuando alguien pregunte quién cambió un
 * precio, y «panel» no contesta esa pregunta.
 */
function contextoCatalogo(c: Context<Entorno>) {
  return { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo };
}
const entero = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;

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
              v.tasa_itbms_bp, v.publicado, v.activo, v.version, p.familia, p.nombre AS producto
              ${conCosto ? ", vi.unidades AS costo_unidades, vi.valor_cents AS costo_valor_cents" : ""}
       FROM variantes v
       JOIN productos p ON p.id = v.producto_id
       ${conCosto ? "LEFT JOIN valor_inventario vi ON vi.codigo = v.codigo" : ""}
       ORDER BY p.orden, p.nombre, v.talla, v.codigo`,
    ).all();

    return c.json(ok({ variantes: results, muestraCosto: conCosto }));
  });

  // -------------------------------------------------------------------------
  // Catálogo: crear, editar y borrar (F4.19)
  //
  // Todas con `exigeEditar`: mirar el catálogo es una cosa y cambiar un precio
  // es otra. El único rol que puede cambiarlo es `duena`.
  // -------------------------------------------------------------------------

  panel.post("/catalogo/productos", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await crearProducto(contextoCatalogo(c), {
      familia: texto(b["familia"]) ?? "",
      nombre: texto(b["nombre"]) ?? "",
      slug: texto(b["slug"]) ?? "",
      ...(texto(b["marca"]) === undefined ? {} : { marca: texto(b["marca"]) as string }),
    });
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /**
   * Producto y su primera presentación, de una sola vez.
   *
   * En dos llamadas, si la segunda falla queda un producto sin variantes — y
   * ese no se puede ver ni arreglar desde el panel, porque la lista sale de
   * `variantes JOIN productos`. Un batch de D1 es una transacción.
   */
  panel.post("/catalogo/altas", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await crearProductoConVariante(
      contextoCatalogo(c),
      {
        familia: texto(b["familia"]) ?? "",
        nombre: texto(b["nombre"]) ?? "",
        slug: texto(b["slug"]) ?? "",
      },
      {
        codigo: (texto(b["codigo"]) ?? "").trim().toUpperCase(),
        nombre: texto(b["nombre"]) ?? "",
        ...(texto(b["talla"]) === undefined ? {} : { talla: texto(b["talla"]) as string }),
        unidadesPorCaja: entero(b["unidadesPorCaja"]) ?? 0,
        precioCents: entero(b["precioCents"]) ?? 0,
        ...(entero(b["tasaItbmsBp"]) === undefined
          ? {}
          : { tasaItbmsBp: entero(b["tasaItbmsBp"]) as number }),
      },
    );
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  panel.post("/catalogo/variantes", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await crearVariante(contextoCatalogo(c), {
      codigo: (texto(b["codigo"]) ?? "").trim().toUpperCase(),
      productoId: texto(b["productoId"]) ?? "",
      nombre: texto(b["nombre"]) ?? "",
      ...(texto(b["talla"]) === undefined ? {} : { talla: texto(b["talla"]) as string }),
      unidadesPorCaja: entero(b["unidadesPorCaja"]) ?? 0,
      precioCents: entero(b["precioCents"]) ?? 0,
      ...(entero(b["tasaItbmsBp"]) === undefined
        ? {}
        : { tasaItbmsBp: entero(b["tasaItbmsBp"]) as number }),
    });
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  panel.patch("/catalogo/variantes/:codigo", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    // La versión es OBLIGATORIA y no se deduce: sin ella, dos personas editando
    // a la vez se pisan y el último que guarda gana en silencio.
    const version = entero(b["version"]);
    if (version === undefined) {
      return c.json(fallo("entrada_invalida", "falta la versión que se leyó"), 400);
    }

    const r = await editarVariante(
      contextoCatalogo(c),
      c.req.param("codigo"),
      {
        ...(texto(b["nombre"]) === undefined ? {} : { nombre: texto(b["nombre"]) as string }),
        ...(b["talla"] === undefined ? {} : { talla: texto(b["talla"]) ?? null }),
        ...(entero(b["unidadesPorCaja"]) === undefined
          ? {}
          : { unidadesPorCaja: entero(b["unidadesPorCaja"]) as number }),
        ...(entero(b["precioCents"]) === undefined
          ? {}
          : { precioCents: entero(b["precioCents"]) as number }),
        ...(b["tasaItbmsBp"] === undefined ? {} : { tasaItbmsBp: entero(b["tasaItbmsBp"]) ?? null }),
        ...(typeof b["publicado"] === "boolean" ? { publicado: b["publicado"] } : {}),
        ...(texto(b["motivo"]) === undefined ? {} : { motivo: texto(b["motivo"]) as string }),
      },
      version,
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Qué va a pasar de verdad si se borra. La pantalla lo pide ANTES de enseñar
   * el «¿seguro?», para que la advertencia diga la verdad: hay productos que no
   * se borran sino que se ocultan, y la persona tiene que saberlo antes y no
   * después.
   */
  panel.get("/catalogo/variantes/:codigo/borrado", exigeEditar("precios_y_stock"), async (c) => {
    const r = await comoSeBorra(contextoCatalogo(c), c.req.param("codigo"));
    if (!r.ok) return c.json(r, codigoHttp(r.codigo));
    return c.json(
      ok(
        r.datos.modo === "se_borra"
          ? { modo: r.datos.modo, archivos: r.datos.archivos.length, razones: [] }
          : {
              modo: r.datos.modo,
              yaOculta: r.datos.yaOculta,
              // En español y armadas aquí: el panel no debe inventarse la frase
              // ni leer nombres de tablas.
              razones: r.datos.rastros.map(explicar),
            },
      ),
    );
  });

  panel.delete("/catalogo/variantes/:codigo", exigeEditar("precios_y_stock"), async (c) => {
    const r = await borrarVariante(contextoCatalogo(c), c.req.param("codigo"));
    if (!r.ok) return c.json(r, codigoHttp(r.codigo));
    return c.json(
      ok({
        modo: r.datos.modo,
        archivos: r.datos.archivos.length,
        razones: r.datos.rastros.map(explicar),
      }),
    );
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
