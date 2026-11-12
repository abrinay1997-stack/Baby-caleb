import { Hono, type Context, type MiddlewareHandler } from "hono";
import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
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
import { leerPedido, listarPedidos } from "../db/pedidos-lectura";
import {
  comprobantesPorConfirmar,
  confirmarPago,
  esMetodoManual,
  registrarComprobante,
  registrarContracargo,
  registrarReembolso,
  rechazarPago,
} from "../db/pagos";
import {
  ajustarRedondeoDeInventario,
  cerrarMes,
  huecosAbiertos,
  libroDiario,
  mayorDeCuenta,
  porCobrar,
  reabrirMes,
  registrarAsiento,
  resumenContable,
  revertirAsiento,
  revisionDeCierre,
} from "../db/contabilidad";
import { asientoManual } from "../dominio/contabilidad";
import { resumenDelNegocio } from "../db/metricas";
import { esNombrePeriodo } from "../dominio/metricas";
import {
  apagar as apagarPasarela,
  cambiarModo,
  configurarCredencial,
  encender as encenderPasarela,
  estado as estadoDePasarelas,
  quitarCredencial,
} from "../db/pasarelas";
import {
  registrar as registrarMovimientos,
  trasladar as trasladarExistencias,
} from "../db/inventario";
import {
  cambiarUso as cambiarUsoDeBodega,
  crear as crearBodega,
  renombrar as renombrarBodega,
} from "../db/bodegas";
import { crear as crearZona, editar as editarZona, type CambiosEnZona } from "../db/zonas-admin";
import {
  alta as altaDeUsuario,
  cambiarAcceso as cambiarAccesoDeUsuario,
} from "../db/usuarios";
import { MINUTOS_VINCULO, crearCodigoDeVinculo } from "../db/telegram";
import {
  buscar as buscarClientas,
  editar as editarClienta,
  encontrarOCrear as encontrarOCrearClienta,
  leerFicha as leerFichaDeClienta,
} from "../db/clientes";
import type { CambiosEnClienta, CambiosEnDireccion } from "../db/clientes";
import { type HacerProveedor, registrarRutasDelAsistente } from "./asistente-rutas";
import { crearPedido } from "../db/pedidos";
import { agendar as agendarPedido, cancelar as cancelarPedido } from "../db/transiciones";
import {
  armarRuta,
  cancelarRuta,
  cerrarRuta,
  crearEnvio,
  despacharRuta,
  devolverParada,
  devolverPedidoEntregado,
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
export function crearPanel(
  resolver: ResolverUsuario = porAccess,
  /** El cerebro de Caleb. Por omisión el real; las pruebas pasan uno de guion. */
  hacerProveedor?: HacerProveedor,
) {
  const panel = new Hono<Entorno>();

  panel.use("*", async (c, next) => {
    const quien = await resolver(c.req.raw, c.env);
    if (!quien.ok) return c.json(fallo("no_autorizado", quien.motivo), 403);
    c.set("usuario", quien.usuario);
    await next();
    return;
  });

  registrarRutas(panel, hacerProveedor);
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
 * Un campo que la pantalla puede mandar escrito, vacío, o no mandar.
 *
 * Los tres significan cosas distintas y por eso no se aplanan: `undefined` es
 * «no lo toques», `null` y `""` son «déjalo en blanco». Si `null` se tradujera
 * a «no lo toques», borrar un dato desde la pantalla sería imposible y no
 * fallaría nada: el campo volvería a aparecer lleno al recargar.
 */
const nuloOTexto = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" ? v : undefined;

/**
 * El código del contrato decide el HTTP, no al revés.
 *
 * Los doce códigos son contrato con el CRM y quien llama actúa según el código,
 * no según el número. Esto existe para que el navegador y los intermedios
 * (cachés, proxys) no traten un conflicto como un éxito.
 */
function codigoHttp(codigo: string): 400 | 403 | 404 | 409 | 422 | 500 {
  // `pasarela_no_disponible` no es un error del sistema: es que la pasarela
  // está encendida y le falta una credencial, o está apagada. Sin esta línea
  // caía en el 500 de abajo y quien lo viera buscaría una avería que no hay.
  if (codigo === "pasarela_no_disponible") return 409;
  // Igual que el anterior: «ese mes está cerrado» no es una avería del
  // sistema. Sin esta línea el panel enseñaría «error del sistema» cuando lo
  // correcto es decir que el periodo está cerrado y hay que reabrirlo.
  if (codigo === "periodo_cerrado") return 409;
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

/**
 * Un entero que llega en la URL, donde todo es texto.
 *
 * `entero` no sirve para eso y el error era invisible: pide un `number` y
 * `c.req.query()` devuelve `string`, así que `enteroDeTexto(c.req.query("limite"))`
 * daba `undefined` SIEMPRE. El efecto no era un error ni un 400 — era que
 * `?limite=10` se ignoraba en silencio y la ruta usaba su valor por defecto.
 * Pasaba en tres rutas (el libro diario, los pedidos y los cobros) y ninguna
 * prueba lo notaba, porque todas pedían sin límite.
 *
 * `Number(v)` y no `parseInt`: `parseInt("10 gatos")` da 10, y un límite que
 * sale de un texto a medias es peor que ninguno.
 */
const enteroDeTexto = (v: unknown): number | undefined => {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * El cuerpo de una zona, pasando SOLO las claves que de verdad vinieron.
 *
 * Es lo que hace posible distinguir las tres cosas que puede querer decir una
 * tarifa: un número, `null` («se cotiza a mano») y que no venga («déjala como
 * estaba»). Si se copiaran todas las claves con `??`, un `null` se volvería
 * «sin cambio» y la dueña vería que su cambio no pasó sin que nada fallara —y
 * una zona que debía cotizarse a mano seguiría cobrando una tarifa vieja.
 *
 * Los valores van tal cual: quien los valida es `src/db/zonas-admin.ts`, y un
 * segundo sitio que los interpretara acabaría discrepando del primero.
 */
const CAMPOS_DE_ZONA = [
  "nombre",
  "alias",
  "region",
  "metodo",
  "tarifaCents",
  "requierePagoTotal",
  "bodegaPreferidaId",
  "activa",
] as const;

function cambiosDeZona(b: Record<string, unknown>): CambiosEnZona {
  const cambios: Record<string, unknown> = {};
  for (const campo of CAMPOS_DE_ZONA) {
    if (campo in b) cambios[campo] = b[campo];
  }
  return cambios as CambiosEnZona;
}

// ---------------------------------------------------------------------------

function registrarRutas(panel: Hono<Entorno>, hacerProveedor?: HacerProveedor): void {
  // Caleb, el asistente, en su propio archivo: este ya pasa de las mil líneas
  // y aquel tiene su propio secreto, su propio proveedor y su propio motivo
  // para fallar.
  registrarRutasDelAsistente(panel, hacerProveedor);

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
  /**
   * La portada.
   *
   * **Sin `exige(...)`**, y es deliberado: es lo primero que se abre, y un 403
   * aquí deja el panel sin portada para quien sí puede entrar. Los permisos se
   * aplican DENTRO — `resumenDelNegocio` recibe el rol y **no consulta** lo que
   * ese rol no puede ver, así que el bloque llega en `null` y no es que se
   * esconda: es que nunca se pidió a la base.
   *
   * Un periodo que no se entiende cae en «hoy» en vez de fallar: esta pantalla
   * tiene que abrir siempre.
   */
  panel.get("/resumen", async (c) => {
    const pedido = c.req.query("periodo") ?? "hoy";
    const r = await resumenDelNegocio(
      { db: c.env.DB, ahora: Date.now(), rol: c.get("usuario").rol },
      esNombrePeriodo(pedido) ? pedido : "hoy",
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
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

  /**
   * Mover existencias.
   *
   * Es la única puerta del panel hacia el inventario, y hasta hoy no existía:
   * la pantalla sabía leer y nadie sabía escribir, así que el sistema creía
   * que había cero de todo y no se podía ni vender ni reservar.
   *
   * No hay forma de «poner el stock en 40». El inventario es un libro: se
   * registra lo que entró o lo que salió, y la existencia es la suma. La base
   * lo defiende con un trigger que prohíbe editar un movimiento, así que una
   * ruta que escribiera el número directo tendría que saltarse el libro — y
   * entonces el libro ya no explicaría el número.
   *
   * Lo más parecido es el CONTEO, que sí recibe «conté 37»: pero no lo escribe
   * como un absoluto, sino como la diferencia contra lo que había, con su
   * motivo y su rastro. Y lo hace a prueba de carreras (ver `quedaEn`).
   *
   * `precios_y_stock` y no `pedidos`: mirar cuánto hay es una cosa y cambiarlo
   * es otra. Según la matriz de roles, solo la dueña.
   */
  panel.post("/existencias/movimientos", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const lineas = b["lineas"];
    if (!Array.isArray(lineas)) {
      return c.json(fallo("entrada_invalida", "un movimiento necesita sus renglones"), 400);
    }

    const r = await registrarMovimientos(
      { db: c.env.DB, actor: c.get("usuario").id, ahora: Date.now() },
      {
        tipo: b["tipo"],
        ...(texto(b["motivo"]) === undefined ? {} : { motivo: texto(b["motivo"]) as string }),
        lineas: lineas as never,
      },
    );
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
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

  /**
   * Una bodega nueva.
   *
   * `precios_y_stock` y no `ajustes`: una bodega es donde vive el inventario,
   * y quien puede mover el stock es quien decide dónde se guarda. Hoy los dos
   * permisos acaban en la misma persona, pero el que dice la verdad sobre lo
   * que se está tocando es este.
   */
  panel.post("/bodegas", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await crearBodega({ db: c.env.DB, ahora: Date.now() }, b["nombre"]);
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /**
   * Renombrar una bodega o dejar de usarla.
   *
   * **No hay `DELETE` y no es un olvido.** Una bodega aparece en cada
   * movimiento de inventario que pasó por ella, y los movimientos no se borran
   * —hay un trigger que lo impide—: borrarla dejaría el libro apuntando a un
   * sitio que no existe. Lo que se puede es dejar de usarla, y entonces nada
   * nuevo sale ni entra ahí.
   *
   * Las dos cosas en la misma ruta porque son la misma fila; cada una va a su
   * función, que lleva su propia fila de control.
   */
  panel.patch("/bodegas/:id", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const ctx = { db: c.env.DB, ahora: Date.now() };
    const id = c.req.param("id");

    if ("nombre" in b) {
      const r = await renombrarBodega(ctx, id, b["nombre"]);
      if (!r.ok) return c.json(r, codigoHttp(r.codigo));
    }
    if ("activa" in b) {
      const r = await cambiarUsoDeBodega(ctx, id, b["activa"] === true);
      if (!r.ok) return c.json(r, codigoHttp(r.codigo));
    }
    if (!("nombre" in b) && !("activa" in b)) {
      return c.json(fallo("entrada_invalida", "no hay nada que cambiar"), 400);
    }

    return c.json(ok({ id }));
  });

  /**
   * Trasladar mercancía de una bodega a otra.
   *
   * Los dos movimientos van en el mismo batch dentro de `trasladar`: o sale de
   * una y entra en la otra, o no pasa nada. Es el MISMO camino que usa la
   * herramienta `trasladar_stock` del asistente — un segundo camino hacia el
   * inventario sería un segundo sitio donde olvidarse de la fila de control.
   */
  panel.post("/bodegas/traslados", exigeEditar("precios_y_stock"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const motivo = texto(b["motivo"])?.trim();
    const r = await trasladarExistencias(
      { db: c.env.DB, actor: c.get("usuario").id, ahora: Date.now() },
      {
        codigo: texto(b["codigo"]) ?? "",
        desdeId: texto(b["desdeId"]) ?? "",
        haciaId: texto(b["haciaId"]) ?? "",
        cantidad: entero(b["cantidad"]) ?? 0,
        ...(motivo === undefined || motivo === "" ? {} : { motivo }),
      },
    );
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  panel.get("/zonas", exige("pedidos"), async (c) => {
    const { results } = await c.env.DB.prepare(
      // `bodega_preferida_id` además del nombre: el nombre es para leer y el
      // id es lo que la hoja de editar necesita para dejar marcada la bodega
      // que ya estaba. Sin él, abrir y guardar una zona le borraría la bodega.
      `SELECT z.id, z.nombre, z.alias_json, z.region, z.metodo, z.tarifa_cents,
              z.requiere_pago_total, z.activa, z.bodega_preferida_id,
              b.nombre AS bodega_preferida
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

  /**
   * Crear y cambiar zonas de envío.
   *
   * `ajustes` y no `precios_y_stock`: una zona no es mercancía, es una regla
   * con cifras del negocio —lo que se le cobra a la clienta por llevarle el
   * pedido—, y esas las cambia quien cambia los ajustes. La asistente toma
   * pedidos, así que NECESITA ver las zonas (la lectura va con `pedidos`),
   * pero no le toca mover una tarifa.
   *
   * Lo que viaja en `tarifaCents` son tres cosas distintas y las tres
   * importan: un número (la tarifa), `null` (se cotiza a mano) y que el campo
   * no venga (déjala como estaba). Por eso la ruta pasa el cuerpo tal cual y
   * es `editar` quien mira si la clave está, con `in`.
   */
  panel.post("/zonas", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await crearZona({ db: c.env.DB, ahora: Date.now() }, cambiosDeZona(b));
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  panel.patch("/zonas/:id", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await editarZona(
      { db: c.env.DB, ahora: Date.now() },
      c.req.param("id"),
      cambiosDeZona(b),
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });




  // ---------------------------------------------------------------------------
  // Contabilidad (F5)
  //
  // LOS LIBROS NO SE EDITAN NI SE BORRAN. Por eso no hay aquí ningún PATCH ni
  // ningún DELETE: un asiento equivocado se corrige con su reverso, que es
  // otro asiento y deja las dos cosas escritas. La base lo hace cumplir con
  // triggers; estas rutas simplemente no ofrecen lo que no se puede hacer.
  //
  // Cerrar un mes lleva el permiso `cierre_de_mes` y no `contabilidad`: la
  // contadora lleva los libros, pero cerrar es un acto de la dueña.
  // ---------------------------------------------------------------------------

  const contextoContable = (c: Context<Entorno>) => ({
    db: c.env.DB,
    ahora: Date.now(),
    actor: c.get("usuario").correo,
  });

  /** Un rango de fechas de la query, o el mes en curso. */
  const rango = (c: Context<Entorno>) => {
    const hoy = new Date().toISOString().slice(0, 10);
    const desde = texto(c.req.query("desde")) ?? `${hoy.slice(0, 7)}-01`;
    return { desde, hasta: texto(c.req.query("hasta")) ?? hoy };
  };

  panel.get("/contabilidad", exige("contabilidad"), async (c) => {
    const ctx = { db: c.env.DB, ahora: Date.now() };
    const [resumen, huecos] = await Promise.all([
      resumenContable(ctx, rango(c)),
      huecosAbiertos(ctx),
    ]);
    return c.json(ok({ resumen, huecos }));
  });

  panel.get("/contabilidad/diario", exige("contabilidad"), async (c) => {
    const limite = enteroDeTexto(c.req.query("limite"));
    const asientos = await libroDiario(
      { db: c.env.DB, ahora: Date.now() },
      { ...rango(c), ...(limite === undefined ? {} : { limite }) },
    );
    return c.json(ok({ asientos }));
  });

  panel.get("/contabilidad/cuentas/:codigo", exige("contabilidad"), async (c) => {
    const r = await mayorDeCuenta(
      { db: c.env.DB, ahora: Date.now() },
      c.req.param("codigo"),
      rango(c),
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  panel.get("/contabilidad/por-cobrar", exige("contabilidad"), async (c) => {
    const al = texto(c.req.query("al")) ?? new Date().toISOString().slice(0, 10);
    return c.json(ok(await porCobrar({ db: c.env.DB, ahora: Date.now() }, al)));
  });

  /**
   * Revertir un asiento.
   *
   * Es la ÚNICA forma de corregir, y por eso pide motivo. Un libro con un
   * reverso sin explicación tiene el mismo agujero que uno editado: se sabe
   * que algo cambió y no por qué.
   */
  panel.post("/contabilidad/asientos/:id/reverso", exigeEditar("contabilidad"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const r = await revertirAsiento(
      contextoContable(c),
      c.req.param("id"),
      texto(b["motivo"]) ?? "",
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Un asiento a mano. La pantalla no lo ofrece; el asistente y F5.5 sí. */
  panel.post("/contabilidad/asientos", exigeEditar("contabilidad"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const lineas = b["lineas"];
    if (!Array.isArray(lineas)) {
      return c.json(fallo("entrada_invalida", "un asiento necesita sus líneas"), 400);
    }
    const armado = asientoManual({
      fecha: texto(b["fecha"]) ?? "",
      descripcion: texto(b["descripcion"]) ?? "",
      lineas: lineas as never,
      referencia: (b["referencia"] ?? null) as never,
    });
    if (!armado.ok) return c.json(armado, codigoHttp(armado.codigo));
    const r = await registrarAsiento(contextoContable(c), armado.datos);
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  panel.get("/contabilidad/cierre", exige("contabilidad"), async (c) => {
    const mes = texto(c.req.query("mes")) ?? new Date().toISOString().slice(0, 7);
    const r = await revisionDeCierre({ db: c.env.DB, ahora: Date.now() }, mes);
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Cerrar es de la dueña, no de la contadora: `cierre_de_mes`. */
  panel.post("/contabilidad/cierre", exigeEditar("cierre_de_mes"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const r = await cerrarMes(contextoContable(c), texto(b["mes"]) ?? "");
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  panel.post("/contabilidad/cierre/reabrir", exigeEditar("cierre_de_mes"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const r = await reabrirMes(
      contextoContable(c),
      texto(b["mes"]) ?? "",
      texto(b["motivo"]) ?? "",
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Los centavos sueltos del costo promedio.
   *
   * Existe como ruta para poder dispararlo a mano mientras no haya un cron.
   * No calcula nada nuevo: baja a cero el valor de lo que ya no tiene
   * unidades y deja el asiento que lo explica.
   */
  panel.post("/contabilidad/redondeos", exigeEditar("contabilidad"), async (c) => {
    const r = await ajustarRedondeoDeInventario(contextoContable(c));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  // ---------------------------------------------------------------------------
  // Pasarelas de cobro (F4b)
  //
  // Se configuran desde aquí como en Odoo. DOS REGLAS para estas cinco rutas, y
  // las dos van contra el reflejo normal de quien programa:
  //
  //  - **No se devuelve eco del cuerpo.** Ni en la respuesta ni en el `detalle`
  //    de un fallo. El valor de una credencial viaja en el cuerpo y en ningún
  //    otro sitio; un eco lo pondría en un registro, en una captura de pantalla
  //    o en una herramienta del navegador.
  //  - **Nada de `console.*` con el cuerpo.** Por lo mismo.
  //
  // Y el actor sale de la sesión, nunca del cuerpo: si saliera del cuerpo,
  // cualquiera firmaría con el nombre de otra persona el día que se cambió una
  // clave de cobro.
  // ---------------------------------------------------------------------------

  const contextoPasarelas = (c: Context<Entorno>) => ({
    db: c.env.DB,
    ahora: Date.now(),
    actor: c.get("usuario").correo,
    llaveMaestra: c.env.PASARELAS_LLAVE_MAESTRA,
  });

  /**
   * El estado de las tres pasarelas.
   *
   * `exige` y no `exigeEditar` porque es una lectura. Hoy dan lo mismo —solo
   * la dueña tiene el permiso `ajustes`— pero el día que exista un rol que
   * mire sin tocar, esta ruta ya está del lado correcto.
   *
   * Lo que devuelve NO lleva ninguna credencial, y no porque se borre antes de
   * responder: la consulta de `estado` no nombra siquiera la columna del
   * secreto. Lo que no se lee no se puede devolver por error.
   */
  panel.get("/pasarelas", exige("ajustes"), async (c) => {
    const r = await estadoDePasarelas(contextoPasarelas(c));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  panel.post("/pasarelas/:pasarela/credenciales/:credencial", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const r = await configurarCredencial(contextoPasarelas(c), {
      pasarela: c.req.param("pasarela"),
      modo: b["modo"],
      credencial: c.req.param("credencial"),
      valor: b["valor"],
      motivo: texto(b["motivo"]) ?? "",
    });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Quitar una credencial.
   *
   * `POST …/quitar` y no `DELETE`: hace falta mandar el modo y el motivo en el
   * cuerpo, y un `DELETE` con cuerpo lo pierde en algunos intermedios.
   *
   * Que se pueda quitar es deliberado. «Ya no uso PayPal, quíteme la clave» es
   * una petición de seguridad, y un sistema que no la puede cumplir se queda
   * con un secreto descifrable para siempre. Lo que no se borra es el libro.
   */
  panel.post(
    "/pasarelas/:pasarela/credenciales/:credencial/quitar",
    exigeEditar("ajustes"),
    async (c) => {
      const b = (await cuerpo(c)) ?? {};
      const r = await quitarCredencial(contextoPasarelas(c), {
        pasarela: c.req.param("pasarela"),
        modo: b["modo"],
        credencial: c.req.param("credencial"),
        motivo: texto(b["motivo"]) ?? "",
      });
      return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
    },
  );

  /** Prueba o real. No se cambia con la pasarela encendida. */
  panel.post("/pasarelas/:pasarela/modo", exigeEditar("ajustes"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const r = await cambiarModo(contextoPasarelas(c), {
      pasarela: c.req.param("pasarela"),
      modo: b["modo"],
      motivo: texto(b["motivo"]) ?? "",
    });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Encender o apagar.
   *
   * Encender exige las credenciales completas del modo en el que está. Apagar
   * NO lleva ninguna condición: es el interruptor de emergencia, y una
   * condición ahí es un interruptor que no responde el día que hace falta.
   */
  panel.post("/pasarelas/:pasarela/encendida", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const motivo = texto(b["motivo"]) ?? "";
    const pasarela = c.req.param("pasarela");
    const r =
      b["encendida"] === true
        ? await encenderPasarela(contextoPasarelas(c), { pasarela, motivo })
        : await apagarPasarela(contextoPasarelas(c), { pasarela, motivo });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  // ---------------------------------------------------------------------------
  // Pedidos (F4.2)
  //
  // El centro del negocio, y hasta ahora el único sitio al que nadie podía
  // mirar: el sistema sabía CREAR un pedido y no tenía ni una consulta para
  // enseñarlo.
  //
  // Quién ve el dinero y quién ve el costo lo decide la matriz de roles, y se
  // recorta EN LA CONSULTA. Esconderlo en la pantalla dejaría el dato viajando
  // hasta el navegador, donde lo ve cualquiera que abra las herramientas.
  // ---------------------------------------------------------------------------

  /** Quién mira, para `pedidos-lectura`. */
  const quienMira = (c: Context<Entorno>) => {
    const rol = c.get("usuario").rol;
    return { veDinero: puedeVer(rol, "cobros"), veCosto: puedeVer(rol, "costo_y_margen") };
  };

  panel.get("/pedidos", exige("pedidos"), async (c) => {
    const estado = texto(c.req.query("estado"));
    const busca = texto(c.req.query("busca"));
    const limite = enteroDeTexto(c.req.query("limite"));
    const r = await listarPedidos(c.env.DB, quienMira(c), {
      ...(estado === undefined || estado === "" ? {} : { estado }),
      ...(busca === undefined ? {} : { busca }),
      ...(limite === undefined ? {} : { limite }),
    });
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Buscar una clienta, por nombre o por celular.
   *
   * Es un selector para tomar un pedido, no un listado de clientas: devuelve
   * pocas y solo cuando se escribe algo. Un listado completo de personas con
   * su teléfono es justo lo que no debe salir de un panel sin que alguien lo
   * haya pedido.
   */
  panel.get("/clientes", exige("pedidos"), async (c) => {
    const r = await buscarClientas(
      c.env.DB,
      c.req.query("buscar") ?? "",
      enteroDeTexto(c.req.query("limite")) ?? 20,
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Dar de alta una clienta — o encontrar la que ya estaba.
   *
   * No se llama «crear» a propósito. Si el celular ya es de alguien, devuelve a
   * ESA persona: es la defensa contra el problema que tiene todo negocio que
   * lleva años atendiendo por WhatsApp, la misma señora con tres fichas y el
   * historial de compras repartido entre las tres.
   *
   * La respuesta dice `nuevo` para que la pantalla pueda avisar «ya la tenía»
   * en vez de dejar a quien atiende con la duda.
   */
  panel.post("/clientes", exigeEditar("pedidos"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    const r = await encontrarOCrearClienta(contextoCatalogo(c), {
      nombre: texto(b["nombre"]) ?? "",
      celular: texto(b["celular"]) ?? "",
    });
    return c.json(r, r.ok ? (r.datos.nuevo ? 201 : 200) : codigoHttp(r.codigo));
  });

  /**
   * La ficha de una clienta: sus datos, sus direcciones y sus pedidos.
   *
   * Va con `pedidos` y no con un permiso propio: quien toma pedidos es quien
   * necesita saber a quién se los está tomando. El dinero de esos pedidos lo
   * recorta la consulta según el rol, igual que en el listado — la contadora
   * ve la ficha, la asistente ve la ficha, y el total solo lo ve quien tiene
   * `cobros`.
   */
  panel.get("/clientes/:id", exige("pedidos"), async (c) => {
    const r = await leerFichaDeClienta(c.env.DB, quienMira(c), c.req.param("id"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Corregir la ficha de una clienta.
   *
   * Lo que entra aquí es lo que hace falta para COBRAR CON TARJETA y para
   * FACTURAR: el apellido separado del nombre, la cédula o el RUC con su tipo,
   * y los datos de facturación de una de sus direcciones. Nada de eso llega
   * solo — la pasarela no devuelve la cédula y el chat no la pregunta.
   *
   * Un campo que no viene NO SE TOCA; uno que viene vacío o en `null` se
   * guarda en blanco. Son dos cosas distintas y la pantalla depende de que lo
   * sigan siendo: sin eso, borrar un dato mal escrito no se podría.
   */
  panel.patch("/clientes/:id", exigeEditar("pedidos"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const cambios: { -readonly [K in keyof CambiosEnClienta]: CambiosEnClienta[K] } = {};
    const nombre = texto(b["nombre"]);
    if (nombre !== undefined) cambios.nombre = nombre;
    const celular = texto(b["celular"]);
    if (celular !== undefined) cambios.celular = celular;
    const apellido = nuloOTexto(b["apellido"]);
    if (apellido !== undefined) cambios.apellido = apellido;
    const correo = nuloOTexto(b["correo"]);
    if (correo !== undefined) cambios.correo = correo;
    const identificacion = nuloOTexto(b["identificacion"]);
    if (identificacion !== undefined) cambios.identificacion = identificacion;
    const tipo = nuloOTexto(b["identificacionTipo"]);
    if (tipo !== undefined) cambios.identificacionTipo = tipo;
    const notas = nuloOTexto(b["notas"]);
    if (notas !== undefined) cambios.notas = notas;

    const cruda = b["direccion"];
    if (typeof cruda === "object" && cruda !== null && !Array.isArray(cruda)) {
      const d = cruda as Record<string, unknown>;
      const idDireccion = (texto(d["id"]) ?? "").trim();
      // Sin id no hay a qué dirección aplicarlo, y adivinar «la activa» sería
      // escribir en una fila que quien guarda no eligió.
      if (idDireccion === "") {
        return c.json(fallo("entrada_invalida", "falta decir en qué dirección"), 400);
      }
      const direccion: { -readonly [K in keyof CambiosEnDireccion]: CambiosEnDireccion[K] } = {
        id: idDireccion,
      };
      const ciudad = nuloOTexto(d["ciudad"]);
      if (ciudad !== undefined) direccion.ciudad = ciudad;
      const provincia = nuloOTexto(d["provinciaIso"]);
      if (provincia !== undefined) direccion.provinciaIso = provincia;
      const postal = nuloOTexto(d["codigoPostal"]);
      if (postal !== undefined) direccion.codigoPostal = postal;
      const pais = nuloOTexto(d["pais"]);
      if (pais !== undefined) direccion.pais = pais;
      cambios.direccion = direccion;
    }

    const r = await editarClienta(contextoCatalogo(c), c.req.param("id"), cambios);
    if (!r.ok) return c.json(r, codigoHttp(r.codigo));

    // Se devuelve la ficha RECIÉN LEÍDA y no un «listo»: la pantalla la usa
    // para repintar «qué falta» sin pedirla otra vez, y así lo que se ve
    // después de guardar es lo que de verdad quedó en la base.
    const ficha = await leerFichaDeClienta(c.env.DB, quienMira(c), c.req.param("id"));
    return c.json(ficha, ficha.ok ? 200 : codigoHttp(ficha.codigo));
  });

  /**
   * Las reglas que `crearPedido` exige RESUELTAS.
   *
   * Esa función se niega a inventar ninguna —«aquí no se inventa ninguno»,
   * dice su contrato— así que quien la llama tiene que leer los ajustes y
   * traérselas. Esto es ese paso, en un solo sitio para que la ruta del panel
   * y la de la web no acaben resolviéndolas distinto.
   *
   * `abono_minimo_cents` NO admite PENDIENTE por diseño (su esquema lo dice),
   * así que siempre hay un número: el de la dueña, o el de fábrica.
   *
   * El plazo sale de `reserva_horas_comprobante` y no de
   * `reserva_minutos_pago_en_linea`, porque un pedido tomado DESDE EL PANEL lo
   * toma una persona hablando con la clienta, y se paga con comprobante o en
   * efectivo, no por un enlace de pago. Con la clave sin decidir el plazo es
   * `null` —«no vence»—, que es un valor que el contrato de `crearPedido`
   * contempla, no un hueco: un pedido que tomó una persona no se cancela solo
   * a espaldas de quien lo tomó.
   */
  async function reglasDelPedido(
    c: Context<Entorno>,
  ): Promise<Resultado<{ abonoMinimoCents: number; minutosParaAbonar: number | null }>> {
    const r = await leerVigentes({ db: c.env.DB, ahora: Date.now() });
    if (!r.ok) return r;
    const de = (clave: string) => r.datos.ajustes.find((a) => a.clave === clave);

    const abono = de("abono_minimo_cents");
    if (abono === undefined || abono.pendiente || typeof abono.valor !== "number") {
      return fallo(
        "entrada_invalida",
        "falta decidir el abono mínimo. Está en Configuración › Ajustes.",
      );
    }

    const horas = de("reserva_horas_comprobante");
    const minutosParaAbonar =
      horas === undefined || horas.pendiente || typeof horas.valor !== "number"
        ? null
        : horas.valor * 60;

    return ok({ abonoMinimoCents: abono.valor, minutosParaAbonar });
  }

  /**
   * Tomar un pedido desde el panel.
   *
   * Hasta hoy `crearPedido` estaba escrita y probada, y no la llamaba nadie:
   * ni el panel ni la web. El sistema sabía crear pedidos y no tenía ninguna
   * puerta por donde entrara uno.
   *
   * El `origen` se fija aquí en «panel» y NO se lee del cuerpo. Es lo que hace
   * que las métricas por canal signifiquen algo: si quien llama pudiera
   * declararse «web», un pedido tecleado a mano contaría como una venta que la
   * tienda nunca hizo.
   *
   * Ningún precio entra por aquí: `crearPedido` recibe códigos y cantidades y
   * los precios los pone el servidor desde el catálogo. Es la regla de un dato
   * con un solo dueño, y aquí se nota en que el cuerpo ni siquiera tiene dónde
   * escribir un precio.
   */
  panel.post("/pedidos", exigeEditar("pedidos"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const lineas = b["lineas"];
    if (!Array.isArray(lineas) || lineas.length === 0) {
      return c.json(fallo("entrada_invalida", "un pedido sin líneas no es un pedido"), 400);
    }

    // La llave de idempotencia la pone la PANTALLA, una por formulario abierto.
    // Sin ella, un doble toque con mala señal crea dos pedidos y aparta el
    // stock dos veces, y eso solo se descubre contando cajas.
    const idempotencia = texto(b["idempotencia"]);
    if (idempotencia === undefined || idempotencia.trim() === "") {
      return c.json(fallo("entrada_invalida", "falta la llave de idempotencia"), 400);
    }

    const reglas = await reglasDelPedido(c);
    if (!reglas.ok) return c.json(reglas, codigoHttp(reglas.codigo));

    const r = await crearPedido(
      {
        db: c.env.DB,
        ahora: Date.now(),
        actor: c.get("usuario").correo,
        abonoMinimoCents: reglas.datos.abonoMinimoCents,
        minutosParaAbonar: reglas.datos.minutosParaAbonar,
      },
      {
        idempotencia: idempotencia.trim(),
        clienteId: texto(b["clienteId"]) ?? "",
        origen: "panel",
        lineas: lineas as never,
        ...(texto(b["zona"]) === undefined ? {} : { zona: texto(b["zona"]) as string }),
        ...(texto(b["direccionId"]) === undefined
          ? {}
          : { direccionId: texto(b["direccionId"]) as string }),
        ...(texto(b["notasCliente"]) === undefined
          ? {}
          : { notasCliente: texto(b["notasCliente"]) as string }),
      },
    );
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /**
   * Agendar: el pedido entra en la lista de entregas.
   *
   * No recibe ninguna condición. Si alcanza o no el abono lo decide el
   * servidor con la regla COPIADA EN EL PEDIDO el día que se creó, no con el
   * ajuste de hoy: subir mañana el abono mínimo no puede cambiar las reglas de
   * un pedido de ayer.
   */
  panel.post("/pedidos/:id/agendar", exigeEditar("pedidos"), async (c) => {
    const r = await agendarPedido(contextoCatalogo(c), c.req.param("id"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Cancelar: libera lo que estaba apartado.
   *
   * Pide motivo y no es burocracia: cancelar devuelve mercancía al inventario
   * y, si hubo abono, deja dinero de una clienta esperando una decisión. Un
   * movimiento así sin explicación es exactamente lo que nadie puede auditar
   * después.
   */
  panel.post("/pedidos/:id/cancelar", exigeEditar("pedidos"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const motivo = (texto(b["motivo"]) ?? "").trim();
    if (motivo === "") {
      return c.json(fallo("entrada_invalida", "diga por qué se cancela: queda en la bitácora"), 400);
    }
    const r = await cancelarPedido(contextoCatalogo(c), c.req.param("id"), motivo);
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * La clienta devuelve lo que ya se le entregó (asiento 13).
   *
   * La mercancía vuelve al inventario con el costo con el que salió, la venta
   * se deshace y lo que se le devuelve queda donde corresponde: descontado de
   * lo que debía, o anotado como dinero suyo que está aquí. Todo en un batch:
   * mercancía sin asiento es un descuadre que no se ve hasta el cierre.
   *
   * Pide `cobros` en «editar» y no `pedidos`: esto decide dinero —una venta
   * menos y un saldo a favor de la clienta— y en la matriz de hoy eso es la
   * dueña. Devolver una PARADA que no se llegó a entregar es otra cosa y va
   * con `pedidos`: ahí no hay venta que deshacer.
   */
  panel.post("/pedidos/:id/devolucion", exigeEditar("cobros"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const motivo = (texto(b["motivo"]) ?? "").trim();
    if (motivo === "") {
      return c.json(
        fallo("entrada_invalida", "diga por qué se devuelve: queda en la bitácora"),
        400,
      );
    }
    const r = await devolverPedidoEntregado(contextoEntrega(c), c.req.param("id"), motivo);
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  panel.get("/pedidos/:id", exige("pedidos"), async (c) => {
    const r = await leerPedido(c.env.DB, quienMira(c), c.req.param("id"));
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  // ---------------------------------------------------------------------------
  // Cobros (F4.4)
  //
  // El módulo de pagos estaba escrito y probado desde F4.4 y NO TENÍA NI UNA
  // RUTA: `confirmarPago` no se podía llamar desde ningún sitio, así que un
  // comprobante entraba en «confirmando» y se quedaba ahí para siempre. La
  // regla «el navegador no decide un pago» estaba cumplida de la peor forma
  // posible — nadie decidía nada.
  //
  // Van con `cobros` y no con `pedidos`: quien despacha ve los pedidos y no
  // tiene por qué tocar el dinero. En la matriz de roles, `cobros` en
  // «editar» hoy solo lo tienen la dueña y la contadora.
  // ---------------------------------------------------------------------------

  /** La bandeja: comprobantes esperando que una persona los mire. */
  panel.get("/cobros", exige("cobros"), async (c) => {
    const limite = enteroDeTexto(c.req.query("limite"));
    const r = await comprobantesPorConfirmar(c.env.DB, limite ?? 50);
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Anotar un comprobante.
   *
   * Entra en «confirmando» aunque lo registre la dueña desde el panel: la
   * separación entre «alguien dice que pagó» y «una persona lo comprobó» no es
   * por desconfianza de quien lo anota, es que son dos hechos distintos y los
   * libros necesitan saber cuál es cuál. Confirmar es un clic más.
   */
  panel.post("/cobros", exigeEditar("cobros"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const pedidoId = texto(b["pedidoId"]);
    const montoCents = entero(b["montoCents"]);
    const metodo = texto(b["metodo"]);
    const tipo = texto(b["tipo"]);
    const idempotencia = texto(b["idempotencia"]);
    const comprobanteR2 = texto(b["comprobanteR2"]);

    if (pedidoId === undefined || montoCents === undefined || metodo === undefined) {
      return c.json(fallo("entrada_invalida", "hacen falta el pedido, el monto y el método"), 400);
    }
    // Esta guarda NO es la que protege: `registrarComprobante` ya rechaza un
    // método que no es manual, y la mutación que la quita no pone roja ni una
    // prueba. Se queda porque estrecha el tipo —`texto()` da `string` y el
    // módulo pide `MetodoManual`—, así que sin ella haría falta un cast, que
    // es justo la clase de afirmación que luego no se comprueba. Quien la lea
    // no debe creer que es lo que defiende.
    if (!esMetodoManual(metodo)) {
      return c.json(fallo("entrada_invalida", `«${metodo}» no es un método manual`), 400);
    }

    // La del tipo SÍ protege, y se midió: sin ella, el CHECK de la columna
    // salta y el `catch` del módulo lo contaba como el UNIQUE de la clave de
    // idempotencia, respondiendo «ese comprobante ya estaba registrado». El
    // `catch` ya está arreglado; esta guarda da el mensaje que nombra el campo.
    if (tipo !== "abono" && tipo !== "total" && tipo !== "saldo") {
      return c.json(fallo("entrada_invalida", "el tipo es «abono», «total» o «saldo»"), 400);
    }

    const r = await registrarComprobante(
      { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo },
      {
        // Sin clave de idempotencia no hay candado: dos clics del mismo botón
        // escriben dos comprobantes por el mismo dinero. Se exige en vez de
        // inventarse una, porque una inventada aquí sería distinta en cada
        // intento y el candado no cerraría nada.
        idempotencia: idempotencia ?? `panel:${pedidoId}:${montoCents}:${metodo}`,
        pedidoId,
        montoCents,
        metodo,
        tipo,
        ...(comprobanteR2 === undefined ? {} : { comprobanteR2 }),
      },
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Una persona mira la captura y dice que sí. Aquí entra el dinero. */
  panel.post("/cobros/:pagoId/confirmar", exigeEditar("cobros"), async (c) => {
    const r = await confirmarPago(
      { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo },
      c.req.param("pagoId"),
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * La captura del comprobante.
   *
   * Sin esto la pantalla pedía confirmar a ciegas, y eso vacía la regla «el
   * navegador no decide un pago»: si quien confirma no puede VER la captura,
   * su clic no comprueba nada — solo traslada la firma. Una captura puede
   * estar recortada, ser de otro pedido, ser de ayer o ser de otra persona, y
   * todo eso se ve mirándola.
   *
   * Se sirve en vez de dar un enlace de R2 porque el bucket es privado y tiene
   * que seguir siéndolo: ahí viven las capturas de pago de las clientas.
   */
  panel.get("/cobros/:pagoId/comprobante", exige("cobros"), async (c) => {
    const fila = await c.env.DB.prepare("SELECT comprobante_r2 FROM pagos WHERE id = ?")
      .bind(c.req.param("pagoId"))
      .first<{ comprobante_r2: string | null }>();
    if (fila?.comprobante_r2 == null) {
      return c.json(fallo("no_encontrado", "ese pago no tiene captura"), 404);
    }

    const a = await c.env.PRIVADO.get(fila.comprobante_r2);
    if (a === null) {
      // La fila dice que hay captura y en R2 no está. Es una avería, no un
      // 404: confundirlos manda al siguiente que lo mire a buscar la captura
      // en vez de mirar el almacenamiento.
      return c.json(fallo("interno", "la captura está registrada pero no se pudo leer"), 500);
    }

    const mime = await c.env.DB.prepare("SELECT mime FROM archivos WHERE r2_key = ?")
      .bind(fila.comprobante_r2)
      .first<{ mime: string }>();

    return new Response(a.body, {
      headers: {
        "content-type": mime?.mime ?? "application/octet-stream",
        // Que el navegador no adivine el tipo, y que esto NO entre en ninguna
        // caché compartida: es el recibo bancario de una clienta.
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-disposition": "inline",
      },
    });
  });

  /**
   * Se le devuelve dinero a una clienta (asiento 14).
   *
   * Anota un reembolso QUE YA SE HIZO: la transferencia de vuelta, el efectivo
   * entregado, o la devolución hecha en el portal de la pasarela. El sistema no
   * mueve dinero —no tiene con qué— así que esto no ordena nada: registra el
   * hecho y su asiento, juntos.
   *
   * Pide el permiso de `cobros` en «editar», que hoy solo tiene la dueña:
   * quien despacha mira los pedidos y no saca dinero de ninguna cuenta.
   */
  panel.post("/cobros/:pagoId/reembolso", exigeEditar("cobros"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const montoCents = entero(b["montoCents"]);
    const motivo = texto(b["motivo"]);
    const proveedorRef = texto(b["proveedorRef"]);

    if (montoCents === undefined) {
      // El monto NO se deduce del pago: un reembolso puede ser parcial, y
      // suponer «el pago entero» es decidir por quien lo está registrando.
      return c.json(fallo("entrada_invalida", "diga cuánto se le devolvió, en centavos"), 400);
    }
    if (motivo === undefined || motivo.trim() === "") {
      return c.json(
        fallo("entrada_invalida", "diga por qué se le devolvió: queda en la bitácora"),
        400,
      );
    }

    const r = await registrarReembolso(
      { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo },
      {
        pagoId: c.req.param("pagoId"),
        montoCents,
        motivo,
        ...(proveedorRef === undefined ? {} : { proveedorRef }),
      },
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * La pasarela revierte un cobro (asiento 15).
   *
   * Lo registra una persona porque hoy ninguna pasarela está encendida y el
   * aviso de PayPal todavía no llega a ningún sitio; el día que llegue, el
   * webhook llamará a la misma función con los mismos datos.
   */
  panel.post("/cobros/:pagoId/contracargo", exigeEditar("cobros"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const montoCents = entero(b["montoCents"]);
    const motivo = texto(b["motivo"]);
    const proveedorRef = texto(b["proveedorRef"]);

    if (montoCents === undefined) {
      return c.json(fallo("entrada_invalida", "diga cuánto se llevaron, en centavos"), 400);
    }
    if (motivo === undefined || motivo.trim() === "") {
      return c.json(
        fallo("entrada_invalida", "diga qué dijo la pasarela: queda en la bitácora"),
        400,
      );
    }

    const r = await registrarContracargo(
      { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo },
      {
        pagoId: c.req.param("pagoId"),
        montoCents,
        motivo,
        ...(proveedorRef === undefined ? {} : { proveedorRef }),
      },
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /** Y dice que no. No se borra: queda el rechazo y su motivo. */
  panel.post("/cobros/:pagoId/rechazar", exigeEditar("cobros"), async (c) => {
    const b = (await cuerpo(c)) ?? {};
    const motivo = texto(b["motivo"]);
    if (motivo === undefined || motivo.trim() === "") {
      return c.json(
        fallo("entrada_invalida", "diga por qué se rechaza: sin motivo no le sirve a nadie"),
        400,
      );
    }
    const r = await rechazarPago(
      { db: c.env.DB, ahora: Date.now(), actor: c.get("usuario").correo },
      c.req.param("pagoId"),
      motivo,
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
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
   * Dar de alta a alguien en el panel.
   *
   * Entrar son DOS cosas: Cloudflare Access comprueba que la persona es quien
   * dice ser, y esta tabla dice si además trabaja aquí. Esta ruta hace la
   * segunda. La primera sigue siendo de Access: alguien dado de alta aquí y
   * fuera de la aplicación de Access no entra, y hay que decirlo en la
   * pantalla para que nadie dé por hecho que con esto basta.
   */
  panel.post("/usuarios", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);

    const r = await altaDeUsuario(
      { db: c.env.DB, ahora: Date.now() },
      { correo: b["correo"], nombre: b["nombre"], rol: b["rol"] },
    );
    return c.json(r, r.ok ? 201 : codigoHttp(r.codigo));
  });

  /**
   * Quitarle o devolverle el acceso a alguien.
   *
   * No se borra la fila: `usuarios.id` queda escrito en los pedidos que esa
   * persona tomó y en los movimientos que registró. Lo que se apaga es el
   * acceso, y tiene efecto en su siguiente petición.
   *
   * Quien no puede quedarse fuera es la ÚLTIMA DUEÑA ACTIVA: sin ella nadie
   * tendría el permiso de `ajustes`, o sea que nadie podría volver a dar de
   * alta a nadie, ni a sí mismo. Eso lo impide la fila de control dentro de
   * `cambiarAcceso`, mirando cuántas quedaron después del cambio.
   */
  panel.patch("/usuarios/:id", exigeEditar("ajustes"), async (c) => {
    const b = await cuerpo(c);
    if (b === null) return c.json(fallo("entrada_invalida", "falta el cuerpo"), 400);
    if (typeof b["activo"] !== "boolean") {
      return c.json(fallo("entrada_invalida", "diga si la persona entra o no entra"), 400);
    }

    const r = await cambiarAccesoDeUsuario(
      { db: c.env.DB, ahora: Date.now() },
      c.req.param("id"),
      b["activo"],
    );
    return c.json(r, r.ok ? 200 : codigoHttp(r.codigo));
  });

  /**
   * Un código para vincular el Telegram de alguien.
   *
   * La puerta de Telegram autentica cruzando el `chat_id` con
   * `usuarios.telegram_chat_id`, y esa columna existe desde la primera
   * migración sin que nada la escribiera: la única forma de poner un chat ahí
   * era un UPDATE a mano en la consola de D1, y la dueña de este sistema no
   * usa la terminal. Una puerta cuya llave se fabrica por SQL es una puerta
   * cerrada.
   *
   * El código se devuelve UNA vez y no se guarda en ningún sitio: en la tabla
   * queda su hash. Vale para un solo uso, vence a los `MINUTOS_VINCULO`
   * minutos y pedir otro anula el anterior.
   *
   * **Lo que la pantalla tiene que decir**, porque es el precio de la regla
   * del silencio: si el código se pega mal, el bot no contesta NADA —a un chat
   * sin vincular no se le contesta ni un error, para no confirmar que detrás
   * hay un sistema del negocio—. Así que «no pasó nada» significa «genere
   * otro», y si eso no está escrito en la pantalla, nadie lo va a adivinar.
   *
   * Lleva `exigeEditar("ajustes")` —o sea, solo la dueña— porque este código
   * es una llave: con él, un chat cualquiera queda hablando con Caleb con los
   * permisos de la persona que se vincula.
   */
  panel.post("/usuarios/:id/telegram", exigeEditar("ajustes"), async (c) => {
    const usuario = c.get("usuario");
    const r = await crearCodigoDeVinculo(
      { db: c.env.DB, ahora: Date.now() },
      c.req.param("id"),
      usuario.id,
    );
    return c.json(
      r.ok ? ok({ ...r.datos, minutos: MINUTOS_VINCULO }) : r,
      r.ok ? 201 : codigoHttp(r.codigo),
    );
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
