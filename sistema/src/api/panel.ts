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
import { EXTENSIONES, MAXIMO_BYTES, tipoDeImagen } from "../db/imagenes";
import { claveDe, enunciadosParaBorrar, subir } from "../db/archivos";
import {
  borrarVariante,
  comoSeBorra,
  crearProducto,
  crearProductoConVariante,
  crearVariante,
  editarVariante,
  leerReceta,
  ponerReceta,
  explicar,
} from "../db/catalogo-admin";
import { guardar as guardarAjuste, historial, leerVigentes } from "../db/ajustes";
import {
  armarRuta,
  cancelarRuta,
  cerrarRuta,
  crearEnvio,
  despacharRuta,
  devolverParada,
  entregasDelDia,
  fechaDePanama,
  guardarPrueba,
  marcarEntregada,
  marcarFallida,
  sugerirParaEnvio,
} from "../db/entregas";

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

/** El contexto que piden las funciones de entregas. */
function contextoEntrega(c: Context<Entorno>) {
  return { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo };
}

/**
 * Un punto del mapa que llegue en el cuerpo, o nada.
 *
 * Media coordenada no es un punto: el esquema tiene un CHECK que lo rechaza,
 * y mandarle medio par sería hacerle reventar el batch por algo que se puede
 * mirar aquí.
 */
function puntoDe(v: unknown): { lat: number; lng: number } | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

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
              v.tasa_itbms_bp, v.publicado, v.activo, v.version, v.imagen, v.es_combo, p.familia, p.nombre AS producto
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

  /**
   * La foto de un producto.
   *
   * El cuerpo son los bytes de la imagen, en crudo. El `Content-Type` que
   * manda el navegador NO se usa para nada: el tipo sale de mirar los bytes
   * (`tipoDeImagen`), porque la cabecera la escribe quien sube el archivo y
   * guardarla tal cual permitiría colar un HTML con cara de imagen.
   *
   * La foto anterior se MARCA para borrar en el mismo batch que entra la
   * nueva: así no quedan dos fotos ocupando por una que se ve, y si la subida
   * se cae no se pierde la que había. Quitarla de R2 es cosa del barrido.
   */
  panel.put("/catalogo/variantes/:codigo/foto", exigeEditar("precios_y_stock"), async (c) => {
    const codigo = c.req.param("codigo");
    const existe = await c.env.DB.prepare("SELECT codigo, imagen FROM variantes WHERE codigo = ?")
      .bind(codigo)
      .first<{ codigo: string; imagen: string | null }>();
    if (existe === null) return c.json(fallo("no_encontrado", "no existe esa variante"), 404);

    const cuerpoBruto = await c.req.arrayBuffer();
    if (cuerpoBruto.byteLength === 0) {
      return c.json(fallo("entrada_invalida", "no llegó ninguna imagen"), 400);
    }
    if (cuerpoBruto.byteLength > MAXIMO_BYTES) {
      return c.json(
        fallo(
          "limite",
          `La imagen pesa ${Math.round(cuerpoBruto.byteLength / 1024 / 1024)} MB y el tope son 5 MB.`,
        ),
        413,
      );
    }

    const tipo = tipoDeImagen(cuerpoBruto);
    if (tipo === null) {
      return c.json(
        fallo("entrada_invalida", "Ese archivo no es una imagen (se aceptan JPG, PNG, WebP y AVIF)."),
        400,
      );
    }

    const ahora = Date.now();
    const ctx = { db: c.env.DB, r2: c.env.PRIVADO, ahora, actor: c.get("usuario").correo };
    const clave = claveDe("catalogo", codigo, EXTENSIONES[tipo], ahora);

    const r = await subir(ctx, clave, cuerpoBruto, {
      tipo: "catalogo",
      mime: tipo,
      bytes: cuerpoBruto.byteLength,
      // La foto de un pañal no es un dato de nadie. Es lo ÚNICO que se marca
      // así, y es lo que la deja salir por `/img/` sin sesión.
      sensible: false,
      referenciaTipo: "variante",
      referenciaId: codigo,
    });
    if (!r.ok) return c.json(r, codigoHttp(r.codigo));

    // La fila apunta a la nueva y la vieja se marca, en un solo batch: si esto
    // fallara a medias, o el producto se queda con la foto vieja o con la
    // nueva, nunca sin ninguna.
    const enunciados = [
      c.env.DB.prepare(
        "UPDATE variantes SET imagen = ?, version = version + 1, actualizado_en = ? WHERE codigo = ?",
      ).bind(`/foto/${clave}`, ahora, codigo),
    ];
    if (existe.imagen !== null && existe.imagen.startsWith("/foto/")) {
      enunciados.push(
        ...enunciadosParaBorrar({ db: c.env.DB, ahora }, [existe.imagen.slice("/foto/".length)]),
      );
    }
    await c.env.DB.batch(enunciados);

    return c.json(ok({ imagen: `/foto/${clave}`, mime: tipo, bytes: cuerpoBruto.byteLength }), 201);
  });

  /** La receta de un combo, con lo que hay de cada pieza. */
  panel.get("/catalogo/variantes/:codigo/receta", exige("pedidos"), async (c) => {
    const r = await leerReceta(contextoCatalogo(c), c.req.param("codigo"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Reemplaza la receta ENTERA.
   *
   * Entera y no por partes: editar ingrediente a ingrediente deja recetas a
   * medias, y quien venda justo en ese momento aparta de menos.
   */
  panel.put("/catalogo/variantes/:codigo/receta", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    const bruta = b === null ? null : b["receta"];
    if (!Array.isArray(bruta)) {
      return c.json(fallo("entrada_invalida", "falta la receta"), 400);
    }

    const receta = bruta.map((x) => {
      const o = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
      return { codigo: texto(o["codigo"]) ?? "", cantidad: entero(o["cantidad"]) ?? 0 };
    });

    const r = await ponerReceta(contextoCatalogo(c), c.req.param("codigo"), receta);
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
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


  // ---------------------------------------------------------------------------
  // Entregas (F4.5)
  //
  // TODAS entran por el panel, que está detrás de Cloudflare Access. El
  // motorizado NO tiene cuenta de Access y por lo tanto hoy NO puede usar
  // ninguna de estas: las toca quien despacha, desde el panel. La puerta del
  // motorizado —celular + PIN, con su propia sesión— es una superficie pública
  // nueva y se decide despierto, no de madrugada. Las piezas ya existen
  // (`dominio/motorizado.ts`, `seguridad/pin.ts`, `seguridad/sesion.ts`).
  // ---------------------------------------------------------------------------

  /** La ruta del día: lo que falta por entregar, lo que ya salió y lo cobrado. */
  panel.get("/entregas", exige("pedidos"), async (c) => {
    const ahora = Date.now();
    const pedida = texto(c.req.query("fecha"));
    const r = await entregasDelDia(c.env.DB, pedida ?? fechaDePanama(ahora), ahora);
    if (!r.ok) return c.json(r, codigoHttp(r.codigo));

    // La pantalla necesita a quién puede asignarle la ruta. Va aquí y no en
    // `entregasDelDia` porque es de la pantalla, no del día: quien consulte el
    // día desde otro sitio no necesita la lista de motorizados.
    const { results: motorizados } = await c.env.DB.prepare(
      "SELECT id, nombre, estado FROM motorizados WHERE estado <> 'inactivo' ORDER BY nombre",
    ).all<{ id: string; nombre: string; estado: string }>();

    return c.json(ok({ ...r.datos, motorizados }));
  });

  /** Preparar un pedido agendado para salir. */
  panel.post("/entregas/pedidos/:pedidoId", exigeEditar("pedidos"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const programadoPara = texto(b["programadoPara"]);
    const ventana = texto(b["ventana"]);
    const r = await crearEnvio(contextoEntrega(c), {
      pedidoId: c.req.param("pedidoId"),
      ...(programadoPara === undefined ? {} : { programadoPara }),
      ...(ventana === undefined ? {} : { ventana }),
    });
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /** A quién le queda mejor esta entrega. */
  panel.get("/entregas/:envioId/candidatos", exige("pedidos"), async (c) => {
    const r = await sugerirParaEnvio(c.env.DB, c.req.param("envioId"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Armar la ruta del día de un motorizado. */
  panel.post("/entregas/rutas", exigeEditar("pedidos"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const ids = b["envioIds"];
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return c.json(fallo("entrada_invalida", "hay que decir qué entregas lleva la ruta"), 400);
    }
    const fecha = texto(b["fecha"]);
    const origen = puntoDe(b["origen"]);

    const r = await armarRuta(contextoEntrega(c), {
      motorizadoId: texto(b["motorizadoId"]) ?? "",
      bodegaId: texto(b["bodegaId"]) ?? "",
      envioIds: ids as string[],
      ...(fecha === undefined ? {} : { fecha }),
      ...(origen === undefined ? {} : { origen }),
    });
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /** La ruta sale a la calle. */
  panel.post("/entregas/rutas/:rutaId/despachar", exigeEditar("pedidos"), async (c) => {
    const r = await despacharRuta(contextoEntrega(c), c.req.param("rutaId"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** La ruta vuelve: se cierra y se cuenta lo cobrado. */
  panel.post("/entregas/rutas/:rutaId/cerrar", exigeEditar("pedidos"), async (c) => {
    const r = await cerrarRuta(contextoEntrega(c), c.req.param("rutaId"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Deshacer una ruta que todavía no salió. */
  panel.post("/entregas/rutas/:rutaId/cancelar", exigeEditar("pedidos"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const r = await cancelarRuta(
      contextoEntrega(c),
      c.req.param("rutaId"),
      texto(b["motivo"]) ?? "",
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Entregada.
   *
   * Dos cosas que esta ruta decide y no delega:
   *
   * **1. El permiso depende del PEDIDO, no solo de la ruta.** Marcar entregado
   * mueve dinero cuando queda saldo por cobrar en la puerta, y eso ya no es
   * «mover un pedido», es cobrar. Un middleware no puede saberlo porque la
   * respuesta depende de la fila. Así que la puerta es `pedidos` y aquí dentro
   * se mira el saldo: si lo hay, hace falta además poder editar `cobros`. Con
   * la matriz de hoy eso significa que la asistente puede cerrar una entrega ya
   * pagada y no una con saldo.
   *
   * **2. `motorizadoId` NO se acepta del cuerpo.** Ese parámetro existe para
   * que quien reparte solo pueda cerrar lo suyo; si llegara del cliente,
   * cualquiera cerraría la parada de cualquiera. Desde el panel no se manda, y
   * el día que exista la puerta del motorizado saldrá del sujeto de su sesión.
   */
  panel.post("/entregas/:envioId/entregada", exigeEditar("pedidos"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const envioId = c.req.param("envioId");

    const saldo = await c.env.DB.prepare(
      `SELECT (p.total_cents - p.pagado_cents) AS saldo
         FROM envios e JOIN pedidos p ON p.id = e.pedido_id
        WHERE e.id = ?`,
    )
      .bind(envioId)
      .first<{ saldo: number }>();

    if ((saldo?.saldo ?? 0) > 0 && !puedeEditar(c.get("usuario").rol, "cobros")) {
      return c.json(
        fallo(
          "no_autorizado",
          "esta entrega lleva saldo por cobrar y usted no puede registrar cobros",
        ),
        403,
      );
    }

    const metodoCobro = texto(b["metodoCobro"]);
    const montoCents = entero(b["montoCents"]);
    const pruebaR2 = texto(b["pruebaR2"]);
    const nota = texto(b["nota"]);
    const punto = puntoDe(b["punto"]);

    const r = await marcarEntregada(contextoEntrega(c), {
      idempotencia: texto(b["idempotencia"]) ?? "",
      envioId,
      ...(metodoCobro === undefined ? {} : { metodoCobro: metodoCobro as never }),
      ...(montoCents === undefined ? {} : { montoCents }),
      ...(pruebaR2 === undefined ? {} : { pruebaR2 }),
      ...(nota === undefined ? {} : { nota }),
      ...(punto === undefined ? {} : { punto }),
    });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** No se pudo entregar. */
  panel.post("/entregas/:envioId/fallida", exigeEditar("pedidos"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const punto = puntoDe(b["punto"]);
    const r = await marcarFallida(contextoEntrega(c), {
      idempotencia: texto(b["idempotencia"]) ?? "",
      envioId: c.req.param("envioId"),
      motivo: texto(b["motivo"]) ?? "",
      ...(punto === undefined ? {} : { punto }),
    });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Vuelve a la bodega: se libera lo que se había apartado. */
  panel.post("/entregas/:envioId/devolucion", exigeEditar("pedidos"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const r = await devolverParada(
      contextoEntrega(c),
      c.req.param("envioId"),
      texto(b["motivo"]) ?? "",
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** La foto de la entrega. Los bytes van crudos, como la foto del catálogo. */
  panel.put("/entregas/:envioId/prueba", exigeEditar("pedidos"), async (c) => {
    const datos = await c.req.arrayBuffer();
    const r = await guardarPrueba(
      { ...contextoEntrega(c), r2: c.env.PRIVADO },
      c.req.param("envioId"),
      datos,
    );
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /**
   * VER la foto de una entrega.
   *
   * No sale por el camino público de `leerPublico` y no es un descuido: una
   * foto de entrega es la puerta de la casa de una clienta, entra marcada como
   * sensible, y ese camino se niega a servirla — correctamente. Para verla hace
   * falta pasar por aquí, que está detrás de Access.
   *
   * La clave de R2 no sale nunca hacia la pantalla: `entregasDelDia` solo dice
   * si hay foto o no. Se pide por el id del envío y es esta ruta la que mira
   * qué clave le toca.
   */
  panel.get("/entregas/:envioId/prueba", exige("pedidos"), async (c) => {
    const fila = await c.env.DB.prepare("SELECT foto_r2 FROM envios WHERE id = ?")
      .bind(c.req.param("envioId"))
      .first<{ foto_r2: string | null }>();
    if (fila?.foto_r2 == null) {
      return c.json(fallo("no_encontrado", "esa entrega no tiene foto"), 404);
    }

    const a = await c.env.PRIVADO.get(fila.foto_r2);
    if (a === null) {
      // La fila dice que hay foto y en R2 no está. Es una avería, no un 404:
      // confundirlos manda al siguiente que lo mire a buscar la foto en vez de
      // mirar el almacenamiento.
      return c.json(fallo("interno", "la foto está registrada pero no se pudo leer"), 500);
    }

    const mime = await c.env.DB.prepare("SELECT mime FROM archivos WHERE r2_key = ?")
      .bind(fila.foto_r2)
      .first<{ mime: string }>();

    return new Response(a.body, {
      headers: {
        "content-type": mime?.mime ?? "application/octet-stream",
        // Que el navegador no adivine el tipo, y que esto NO se guarde en
        // ninguna caché compartida: es la casa de una clienta.
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-disposition": "inline",
      },
    });
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
    const r = await leerVigentes({ db: c.env.DB, ahora: Date.now() });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Cambiar un ajuste.
   *
   * Dos cosas que NO salen del cuerpo de la petición, a propósito:
   *
   *  - **Quién lo cambió** sale de la sesión. Si saliera del cuerpo,
   *    cualquiera firmaría con el nombre de otra persona, y el historial
   *    —que existe para contestar «¿quién bajó la comisión en marzo?»—
   *    dejaría de valer para nada.
   *  - **Qué forma tiene el valor** lo decide `validar` dentro de `guardar`,
   *    no esta ruta. Aquí el valor viaja tal cual (número, booleano, lista,
   *    objeto o la cadena «PENDIENTE»): un segundo sitio que lo interprete
   *    acabaría discrepando del primero.
   */
  panel.post("/ajustes/:clave", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const vigenteDesde = entero(b["vigenteDesde"]);
    const r = await guardarAjuste(
      {
        db: c.env.DB,
        ahora: Date.now(),
        actor: c.get("usuario").correo,
      },
      {
        clave: c.req.param("clave"),
        valor: b["valor"],
        motivo: texto(b["motivo"]) ?? "",
        ...(vigenteDesde === undefined ? {} : { vigenteDesde }),
      },
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Las versiones de un ajuste, de la más nueva a la más vieja.
   *
   * Se lee con `exige` y no con `exigeEditar`: mirar quién cambió una cifra no
   * es cambiarla. Hoy da igual —solo la dueña tiene el permiso `ajustes`— pero
   * el día que alguien más pueda mirar sin tocar, esta ruta ya está del lado
   * correcto.
   */
  panel.get("/ajustes/:clave/historial", exige("ajustes"), async (c) => {
    const r = await historial({ db: c.env.DB, ahora: Date.now() }, c.req.param("clave"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });
}
