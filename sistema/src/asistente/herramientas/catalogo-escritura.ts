import { z } from "zod";
import {
  borrarVariante,
  comoSeBorra,
  crearProducto,
  crearProductoConVariante,
  crearVariante,
  editarVariante,
  explicar,
} from "../../db/catalogo-admin";
import { type Contexto, definir } from "../registro";

/**
 * Administrar el catálogo por MCP: crear, editar y retirar.
 *
 * Por qué existe este archivo: hasta hoy el catálogo solo se podía administrar
 * desde el panel. `node scripts/sin-mcp.mjs --lista` marcaba cinco rutas de
 * catálogo como PENDIENTE y una a medias, y eso es exactamente lo que
 * `docs/TRAMPAS.md` §13 prohíbe — una capacidad que solo se alcanza desde una
 * pantalla depende de que esa pantalla exista, se despliegue y esté bien
 * escrita, y en este repositorio ya se han visto las tres cosas fallar.
 *
 * ## Ninguna de estas herramientas escribe SQL propio
 *
 * Cada una llama a la MISMA función de `src/db/catalogo-admin.ts` que llama la
 * ruta del panel: `crearProducto`, `crearVariante`, `crearProductoConVariante`,
 * `editarVariante`, `comoSeBorra` y `borrarVariante`. Lo único que se hace aquí
 * es traducir —del nombre de un producto a su id, de los argumentos del modelo
 * a los de la función— y pasar el resultado. Si una de estas herramientas
 * repitiera la lógica, el panel y MCP acabarían discrepando, y el camino que
 * nadie revisa es el que miente. Es la misma razón que ya está escrita en
 * `trasladar_stock`.
 *
 * ## Qué pide que una persona lo permita, y qué no
 *
 * Con la tabla de 06-asistente §3 delante, y mirando lo que cada función
 * escribe de verdad:
 *
 *  - **Crear** (`crear_producto`, `crear_variante`, `dar_de_alta_producto`) es
 *    **construcción**, o sea directo y auditado. Una variante nueva nace
 *    `publicado = 0` siempre —lo dice y lo hace `crearVariante`—, así que su
 *    precio no sale a la web ni al bot: es un borrador, como «crear pedido en
 *    borrador» de la tabla. Y no mueve inventario: ni `crearVariante` ni
 *    `crearProductoConVariante` escriben una sola fila en `existencias` ni en
 *    `movimientos_inventario` (está leído, no supuesto). Lo que sí es
 *    irreversible y visible —publicarla— vive en `editar_variante`, que sí
 *    pide permiso.
 *  - **Editar** (`editar_variante`) es **sensible**. Cambia el ITBMS, las
 *    unidades que trae la caja y el interruptor de `publicado`: publicar es el
 *    momento en que un precio recién tecleado sale hacia una clienta, y eso no
 *    se deshace con un botón.
 *  - **Retirar** (`retirar_variante`) es **sensible**. Esconde mercancía: o
 *    borra la fila con sus existencias, o la deja `activo = 0` y fuera del
 *    catálogo del bot y de la web. Las dos cosas se notan en lo que se puede
 *    vender hoy.
 *  - **Mirar antes de retirar** (`ver_retiro_variante`) es **lectura**: no
 *    escribe nada, y sin ella el modelo tendría que proponer un retiro sin
 *    saber si lo que va a pasar es borrar o esconder.
 *
 * ## El costo no pasa por aquí
 *
 * Ninguna de estas herramientas lee ni devuelve costo (D-20 y 06-asistente
 * §7): el costo vive en `valor_inventario` y en `movimientos_inventario`, tiene
 * su propio permiso (`costo_y_margen`) y ninguna consulta de este archivo lo
 * nombra. El precio de VENTA sí va y sí vuelve: es público, lo lee cualquiera
 * en la web.
 */

// ---------------------------------------------------------------------------
// Lo compartido
// ---------------------------------------------------------------------------

/**
 * El contexto que esperan las funciones de `catalogo-admin.ts`.
 *
 * `actor` va con el CORREO y no con el id, porque es lo que pasa
 * `contextoCatalogo` en la ruta del panel. Ese `actor` acaba escrito en
 * `precios_historial.cambiado_por`, y dos puertas que escriban cosas distintas
 * en la misma columna —un correo desde el panel y un ULID desde MCP— vuelven
 * ese historial ilegible justo cuando se consulta, que es cuando una clienta
 * reclama lo que le cotizaron ayer.
 */
const paraCatalogo = (ctx: Contexto) => ({
  db: ctx.db,
  ahora: ctx.ahora,
  actor: ctx.usuario.correo,
});

const codigo = z
  .string()
  .min(1)
  .max(40)
  .describe("El código del artículo, como NAT-M o DANY-AW600.");

/**
 * El motivo es obligatorio en todo lo que escribe.
 *
 * Donde queda es en `acciones.argumentos_json`, que es una bitácora con un
 * trigger que no deja editarla ni borrarla. No es decoración: un cambio de
 * catálogo sin motivo es, dentro de un mes, un precio o una talla que nadie
 * sabe por qué son así.
 */
const motivo = z
  .string()
  .min(3)
  .max(200)
  .describe("Por qué se hace. Queda escrito en la bitácora y es lo que lo explica después.");

const nombreDeProducto = z
  .string()
  .min(1)
  .max(120)
  .describe("El nombre del producto, como «Pañal Nateen pants».");

/**
 * La familia se acepta como texto y no como lista cerrada.
 *
 * `productos.familia` es TEXT sin CHECK en la base, el panel ofrece seis
 * valores y la carga inicial trae un séptimo (`portabebe`) que el panel no
 * sabe producir. Cerrar la lista aquí sería decidir por la dueña una regla que
 * nadie decidió, así que queda PENDIENTE y la descripción nombra las que de
 * verdad se usan.
 */
const familia = z
  .string()
  .min(2)
  .max(40)
  .describe(
    "El tipo de producto. Los que se usan hoy: panal, pants, wipes, portabebe, ropa, accesorio, otro.",
  );

const unidadesPorCaja = z
  .number()
  .int()
  .positive()
  .max(100_000)
  .describe("Cuántas unidades trae la caja o el paquete.");

const precioCents = z
  .number()
  .int()
  .positive()
  .max(1_000_000)
  .describe("El precio de venta en centavos. $15.00 son 1500.");

/**
 * El ITBMS en puntos básicos, y ausente NO es cero.
 *
 * 700 es 7 %. Si no se manda, la variante queda con la tasa en NULL, que es
 * PENDIENTE: un cero ahí sería afirmar que ese artículo no lleva impuesto
 * (`docs/TRAMPAS.md` §7).
 */
const tasaItbmsBp = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .describe("ITBMS en puntos básicos: 700 es 7 %. Si no se sabe, NO lo mande: queda PENDIENTE.");

const slug = z
  .string()
  .min(1)
  .max(80)
  .describe("La dirección web de la ficha. Si no se manda, sale del nombre.");

/**
 * Del nombre de un producto a su id.
 *
 * El asistente habla de productos por su nombre y la base por su id, que es un
 * ULID que nadie teclea y que ninguna herramienta de lectura devuelve. Sin esta
 * traducción, `crear_variante` solo se podría usar en el mismo turno en que se
 * creó el producto, y una herramienta que solo sirve encadenada a otra es una
 * herramienta a medias. Es la misma traducción que hace `bodegaPorNombre` para
 * `ajustar_stock`, y por la misma razón.
 *
 * Devuelve TODOS los que casan y no el primero: en la base lo único único es el
 * slug, no el nombre, así que elegir uno de dos en silencio es colgarle una
 * talla al producto equivocado.
 */
async function productosLlamados(
  db: D1Database,
  nombre: string,
): Promise<{ id: string; nombre: string }[]> {
  const { results } = await db
    .prepare("SELECT id, nombre FROM productos WHERE nombre = ? COLLATE NOCASE ORDER BY id")
    .bind(nombre.trim())
    .all<{ id: string; nombre: string }>();
  return results;
}

/** El id del producto, o un error que dice qué hacer en vez de «no se encontró». */
async function elProducto(db: D1Database, nombre: string): Promise<string> {
  const candidatos = await productosLlamados(db, nombre);
  const primero = candidatos[0];

  if (primero === undefined) {
    throw new Error(
      `no hay ningún producto llamado «${nombre}». No lo dé por hecho: créelo con ` +
        "crear_producto, o cree el producto y su primera presentación de una vez con " +
        "dar_de_alta_producto.",
    );
  }
  if (candidatos.length > 1) {
    throw new Error(
      `hay ${candidatos.length} productos llamados «${nombre}» y desde aquí no se puede saber ` +
        "cuál es: hay que distinguirlos en el panel antes de colgarles una presentación.",
    );
  }
  return primero.id;
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

export const crearProductoDelCatalogo = definir({
  nombre: "crear_producto",
  descripcion:
    "Crea un producto del catálogo: el grupo que después lleva presentaciones (las tallas). No lleva precio ni existencias y no se ve en ninguna parte hasta que tenga al menos una presentación. Ejemplo: crear_producto con familia «pants», nombre «Pañal Nateen pants» y marca «Nateen». Si el producto ya existe y lo que falta es una talla, use crear_variante; si no existe ninguno de los dos, use dar_de_alta_producto.",
  parametros: z.object({
    familia,
    nombre: nombreDeProducto,
    marca: z.string().min(1).max(60).optional().describe("La marca, si la tiene."),
    slug: slug.optional(),
    motivo,
  }),
  nivel: "construccion",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // El `slug` vacío es lo que la ruta del panel manda cuando nadie lo
    // escribe, y `crearProducto` lo entiende como «sácalo del nombre». Se
    // repite ese convenio en vez de derivarlo aquí: derivarlo sería tener dos
    // reglas de slug, y la que se usa menos es la que se queda desactualizada.
    const r = await crearProducto(paraCatalogo(ctx), {
      familia: args.familia.trim(),
      nombre: args.nombre,
      slug: args.slug ?? "",
      ...(args.marca === undefined ? {} : { marca: args.marca }),
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      id: r.datos.id,
      nombre: args.nombre.trim(),
      familia: args.familia.trim(),
      // Decir el paso que falta: un producto sin presentaciones no sale en la
      // lista del catálogo —la lista es `variantes JOIN productos`—, así que
      // quien lo cree y no siga puede creer que no se guardó.
      siguientePaso:
        "todavía no se ve en el catálogo: póngale su primera presentación con crear_variante",
    };
  },
});

export const crearVarianteDelCatalogo = definir({
  nombre: "crear_variante",
  descripcion:
    "Añade una presentación (una talla) a un producto que ya existe, con su código, su precio y cuántas unidades trae la caja. Nace SIN PUBLICAR: no sale a la web ni al bot hasta que se publique con editar_variante. Ejemplo: crear_variante con producto «Pañal Nateen pants», codigo «NAT-PANTS-XL», nombre «Pañal Nateen pants XL», talla «XL», unidades_por_caja 36 y precio_cents 5500.",
  parametros: z.object({
    producto: nombreDeProducto,
    codigo: codigo.describe(
      "El código nuevo, en mayúsculas, de 2 a 24 letras, números o guiones (ej. NAT-M).",
    ),
    nombre: z.string().min(1).max(120).describe("El nombre de esta presentación."),
    talla: z.string().min(1).max(20).optional().describe("La talla, si la tiene: M, XL, Unitalla."),
    unidades_por_caja: unidadesPorCaja,
    precio_cents: precioCents,
    tasa_itbms_bp: tasaItbmsBp.optional(),
    motivo,
  }),
  nivel: "construccion",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const productoId = await elProducto(ctx.db, args.producto);

    // El código se pasa a mayúsculas antes de validar, igual que la ruta del
    // panel: `revisarCodigo` exige mayúsculas y rechazarle «nat-m» al modelo
    // sería hacerle adivinar una regla de forma que ya está resuelta.
    const r = await crearVariante(paraCatalogo(ctx), {
      codigo: args.codigo.trim().toUpperCase(),
      productoId,
      nombre: args.nombre,
      ...(args.talla === undefined ? {} : { talla: args.talla }),
      unidadesPorCaja: args.unidades_por_caja,
      precioCents: args.precio_cents,
      ...(args.tasa_itbms_bp === undefined ? {} : { tasaItbmsBp: args.tasa_itbms_bp }),
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      codigo: r.datos.codigo,
      producto: args.producto.trim(),
      precioCents: args.precio_cents,
      publicado: false,
      siguientePaso:
        "está guardada y SIN PUBLICAR: revise el precio y publíquela con editar_variante",
    };
  },
});

export const darDeAltaProducto = definir({
  nombre: "dar_de_alta_producto",
  descripcion:
    "Da de alta un producto nuevo y su primera presentación de una sola vez, para que no quede un producto sin presentaciones si algo falla a medias. Nace SIN PUBLICAR. Ejemplo: dar_de_alta_producto con familia «wipes», nombre «Water wipes Dany Baby», codigo «DANY-AW600», unidades_por_caja 600 y precio_cents 1300. Si el producto ya existe, use crear_variante.",
  parametros: z.object({
    familia,
    nombre: nombreDeProducto.describe(
      "El nombre, que se usa para el producto Y para su primera presentación.",
    ),
    slug: slug.optional(),
    codigo: codigo.describe("El código de la primera presentación, en mayúsculas (ej. NAT-M)."),
    talla: z.string().min(1).max(20).optional().describe("La talla, si la tiene."),
    unidades_por_caja: unidadesPorCaja,
    precio_cents: precioCents,
    tasa_itbms_bp: tasaItbmsBp.optional(),
    motivo,
  }),
  nivel: "construccion",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // El MISMO nombre para el producto y para su presentación, que es lo que
    // manda la ruta del panel. No se añade un nombre aparte para la
    // presentación aunque la función lo acepte: con él, MCP escribiría algo
    // que el panel no puede escribir, y entonces las dos puertas ya no hacen
    // lo mismo. Para cambiárselo después está editar_variante.
    const r = await crearProductoConVariante(
      paraCatalogo(ctx),
      { familia: args.familia.trim(), nombre: args.nombre, slug: args.slug ?? "" },
      {
        codigo: args.codigo.trim().toUpperCase(),
        nombre: args.nombre,
        ...(args.talla === undefined ? {} : { talla: args.talla }),
        unidadesPorCaja: args.unidades_por_caja,
        precioCents: args.precio_cents,
        ...(args.tasa_itbms_bp === undefined ? {} : { tasaItbmsBp: args.tasa_itbms_bp }),
      },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      id: r.datos.id,
      codigo: r.datos.codigo,
      nombre: args.nombre.trim(),
      precioCents: args.precio_cents,
      publicado: false,
      siguientePaso:
        "está guardado y SIN PUBLICAR: revise el precio y publíquelo con editar_variante",
    };
  },
});

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

export const editarVarianteDelCatalogo = definir({
  nombre: "editar_variante",
  descripcion:
    "Cambia el nombre, la talla, las unidades por caja, el ITBMS o si una presentación se publica en la web y en el bot. El PRECIO no se cambia aquí: para eso está cambiar_precio. Ejemplo: editar_variante con codigo «NAT-M», publicado true y motivo «revisada, ya se puede vender» la saca a la web y al bot.",
  parametros: z.object({
    codigo,
    nombre: z.string().min(1).max(120).optional().describe("El nombre nuevo."),
    talla: z
      .string()
      .min(1)
      .max(20)
      .nullable()
      .optional()
      .describe("La talla nueva. Mande null para dejarla sin talla."),
    unidades_por_caja: unidadesPorCaja.optional(),
    tasa_itbms_bp: tasaItbmsBp
      .nullable()
      .optional()
      .describe("ITBMS en puntos básicos: 700 es 7 %. null lo deja en PENDIENTE."),
    publicado: z
      .boolean()
      .optional()
      .describe("true la saca a la web y al bot; false la guarda sin quitarla del catálogo."),
    motivo,
  }),
  nivel: "sensible",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const cambios: {
      nombre?: string;
      talla?: string | null;
      unidadesPorCaja?: number;
      tasaItbmsBp?: number | null;
      publicado?: boolean;
    } = {
      ...(args.nombre === undefined ? {} : { nombre: args.nombre }),
      ...(args.talla === undefined ? {} : { talla: args.talla }),
      ...(args.unidades_por_caja === undefined
        ? {}
        : { unidadesPorCaja: args.unidades_por_caja }),
      ...(args.tasa_itbms_bp === undefined ? {} : { tasaItbmsBp: args.tasa_itbms_bp }),
      ...(args.publicado === undefined ? {} : { publicado: args.publicado }),
    };

    // Una llamada que solo trae el código y el motivo no es un error del
    // modelo que se pueda ignorar: `editarVariante` no tiene nada que escribir
    // y devuelve `ok` con la versión que ya había, así que sin esta guarda la
    // herramienta contestaría «hecho» sin haber cambiado nada. Y lo peor es
    // que la persona ya habría tocado «Permitir» por esto.
    if (Object.keys(cambios).length === 0) {
      throw new Error(
        "no se dijo qué cambiar: mande al menos nombre, talla, unidades_por_caja, " +
          "tasa_itbms_bp o publicado. Para el precio, cambiar_precio.",
      );
    }

    // La versión NO es un argumento de la herramienta y no puede serlo: ninguna
    // herramienta de lectura la devuelve, así que pedírsela al modelo es
    // pedirle que se la invente. Se lee aquí, justo antes de escribir, igual
    // que hace `cambiar_precio`.
    //
    // Y no es esto lo que cierra la actualización perdida: eso lo hace el
    // control del batch de `editarVariante`, que mira los valores YA escritos.
    // Si alguien guardó entre esta lectura y la escritura, el batch se cae en
    // vez de pisarle el cambio.
    const actual = await ctx.db
      .prepare("SELECT version FROM variantes WHERE codigo = ?")
      .bind(args.codigo)
      .first<{ version: number }>();
    if (actual === null) throw new Error(`no existe el artículo ${args.codigo}`);

    // El motivo no se le pasa a `editarVariante`: allí solo se escribe en
    // `precios_historial`, y solo cuando cambia el precio — que por aquí no
    // cambia. El que vale es el de la bitácora de `acciones`.
    const r = await editarVariante(paraCatalogo(ctx), args.codigo, cambios, actual.version);
    if (!r.ok) throw new Error(r.mensaje);

    return { codigo: args.codigo, version: r.datos.version, cambios };
  },
});

// ---------------------------------------------------------------------------
// Retirar
// ---------------------------------------------------------------------------

export const verRetiroDeVariante = definir({
  nombre: "ver_retiro_variante",
  descripcion:
    "Dice qué va a pasar DE VERDAD si se retira del catálogo una presentación: si desaparece o si solo queda oculta porque ya se vendió o se movió, y por qué. Se consulta ANTES de retirar nada. Ejemplo: ver_retiro_variante con codigo «NAT-M».",
  parametros: z.object({ codigo }),
  nivel: "lectura",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // La MISMA función que mira la pantalla antes de enseñar el «¿seguro?» y la
    // misma que vuelve a decidir al retirar. Si esta herramienta calculara su
    // propio veredicto, el aviso y lo que pasa podrían discrepar — que es justo
    // lo que `comoSeBorra` existe para evitar.
    const r = await comoSeBorra(paraCatalogo(ctx), args.codigo);

    if (!r.ok) {
      // Se contesta, no se falla: un modelo que se equivoca de código tiene
      // que poder corregirse en el mismo turno.
      return {
        codigo: args.codigo,
        existe: false,
        modo: null,
        yaOculta: null,
        razones: [],
        archivos: 0,
        aviso: `no hay ninguna presentación con el código «${args.codigo}»`,
      };
    }

    if (r.datos.modo === "se_oculta") {
      const razones = r.datos.rastros.map(explicar);
      return {
        codigo: args.codigo,
        existe: true,
        modo: r.datos.modo,
        yaOculta: r.datos.yaOculta,
        // Las frases las arma `explicar`, la misma del panel: así las dos
        // puertas dan la misma razón con las mismas palabras.
        razones,
        archivos: 0,
        aviso:
          `«${args.codigo}» ya tiene historia (${razones.join("; ")}): si se retira NO ` +
          "desaparece, queda oculta —fuera de la web y del bot— y su fila se conserva para " +
          "que los pedidos viejos sigan teniendo sentido.",
      };
    }

    return {
      codigo: args.codigo,
      existe: true,
      modo: r.datos.modo,
      yaOculta: false,
      razones: [],
      // Cuántas fotos se van con ella, no cuáles: la clave de R2 no le sirve
      // de nada al modelo.
      archivos: r.datos.archivos.length,
      aviso:
        `«${args.codigo}» no tiene ninguna venta ni ningún movimiento: si se retira, la fila ` +
        `desaparece de verdad y se va con ${r.datos.archivos.length} foto(s). Eso no se deshace.`,
    };
  },
});

export const retirarVariante = definir({
  nombre: "retirar_variante",
  descripcion:
    "Retira del catálogo una presentación. Si nunca se vendió ni se movió, la fila desaparece con sus fotos; si ya tiene historia, NO desaparece: queda oculta, fuera de la web y del bot, y su fila se conserva. Pregunte antes con ver_retiro_variante para saber cuál de las dos cosas va a pasar. Ejemplo: retirar_variante con codigo «NAT-M» y motivo «el proveedor la descontinuó».",
  parametros: z.object({ codigo, motivo }),
  nivel: "sensible",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // El veredicto lo vuelve a calcular `borrarVariante` por dentro, y hace
    // bien: entre que esto se propuso y una persona lo permitió pueden pasar
    // treinta minutos, y en ese rato una clienta puede comprar. Por eso aquí no
    // se le adelanta ningún modo ni se le pasa el que dijo `ver_retiro_variante`.
    //
    // El motivo no se le pasa porque la función no lo recibe: no hay columna
    // donde ponerlo. Queda en `acciones`, que no se edita ni se borra.
    const r = await borrarVariante(paraCatalogo(ctx), args.codigo);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      codigo: args.codigo,
      modo: r.datos.modo,
      razones: r.datos.rastros.map(explicar),
      archivos: r.datos.archivos.length,
      // En palabras, porque «se_oculta» y «se_borra» se parecen demasiado para
      // que el modelo se lo cuente bien a una persona.
      quedo:
        r.datos.modo === "se_borra"
          ? "la presentación desapareció del catálogo"
          : "la presentación quedó oculta: fuera de la web y del bot, pero su fila se conserva",
    };
  },
});

export const HERRAMIENTAS_DE_CATALOGO_ESCRITURA = [
  crearProductoDelCatalogo,
  crearVarianteDelCatalogo,
  darDeAltaProducto,
  editarVarianteDelCatalogo,
  verRetiroDeVariante,
  retirarVariante,
] as const;
