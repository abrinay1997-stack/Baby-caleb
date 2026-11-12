import { z } from "zod";
import {
  buscar as buscarClientas,
  encontrarOCrear as encontrarOCrearClienta,
  leerFicha as leerFichaDeClienta,
} from "../../db/clientes";
import { crearPedido, reglasDelPedido } from "../../db/pedidos";
import { leerPedido, listarPedidos, type PedidoEnLista } from "../../db/pedidos-lectura";
import { agendar, cancelar } from "../../db/transiciones";
import { formatear } from "../../dominio/dinero";
import { fechaPanama } from "../../dominio/metricas";
import { puedeVer, type Rol } from "../../seguridad/roles";
import { clienteDeReferencia, referenciaDe } from "../referencias";
import { definir, type Contexto } from "../registro";

/**
 * Pedidos y clientas: lo que hasta hoy solo se podía hacer desde el panel.
 *
 * El motivo de que este archivo exista es la trampa §13 de `docs/TRAMPAS.md`:
 * **una capacidad que solo se alcanza desde una pantalla depende de que esa
 * pantalla exista, se despliegue y esté bien escrita**, y en este repositorio
 * ya se vieron las tres cosas fallar por separado. Ocho rutas del panel
 * —listar pedidos, verlos, tomarlos, agendarlos, anularlos, buscar clientas,
 * su ficha y darlas de alta— no tenían herramienta, así que por MCP no se
 * podían ni pedir ni probar. `node scripts/sin-mcp.mjs` las contaba una por
 * una.
 *
 * TRES REGLAS QUE MANDAN SOBRE TODO LO DEMÁS AQUÍ
 *
 * **1. Nada de una clienta sale hacia el modelo (D-20, 06-asistente §7).** El
 * modelo es un Contributor y Meta entrena con lo que recibe; las cifras del
 * negocio van —el dueño lo aceptó— pero las clientas son terceras personas que
 * no acordaron nada. Hacia fuera una clienta es `C-0042` y nada más: ni
 * nombre, ni celular, ni correo, ni dirección, ni coordenadas. El nombre lo
 * pone el panel DESPUÉS, al mostrar la respuesta (`ponerLosNombres`). Y no se
 * sostiene con buena voluntad: `referencias.revisar()` mira lo que sale y, si
 * se cuela algo, `conversar.ts` y el servidor MCP **descartan el resultado
 * entero**. Una herramienta que devuelva un nombre no da un aviso: deja de
 * funcionar.
 *
 * **2. El costo no sale por ninguna.** `leerPedido` sabe traerlo con permiso
 * de `costo_y_margen` —que la dueña tiene— y aquí se le pide SIEMPRE que no lo
 * traiga. No es un descuido de permisos: es que una herramienta que a veces
 * trae costo y a veces no es una forma difícil de equivocarse, y
 * `fronteras.test.ts` lo vigila para todas.
 *
 * **3. El motor es el mismo que el del panel.** Ninguna de estas herramientas
 * escribe SQL de negocio: llaman a `db/pedidos.ts`, `db/transiciones.ts` y
 * `db/clientes.ts`, las mismas funciones que llaman las rutas. Dos caminos
 * distintos hacia los pedidos acabarían discrepando, y el que se equivoca del
 * lado flojo es el que nadie revisa.
 *
 * DÓNDE QUEDA EL «MOTIVO» DE LAS QUE ESCRIBEN
 *
 * `anular_pedido` se lo pasa a `cancelar`, que lo escribe en el evento del
 * pedido. Las otras tres no tienen columna donde ponerlo, y aun así lo piden:
 * va en `acciones.argumentos_json`, la bitácora que un trigger impide editar y
 * borrar, y es lo que lee la persona en la tarjeta de «¿Permite esto?» antes
 * de tocar Permitir. Un pedido creado sin explicación es exactamente lo que
 * nadie puede auditar después.
 */

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

const referenciaDeClienta = z
  .string()
  .min(1)
  // 40 y no 20: el tope del esquema está para que no entre un texto enorme, no
  // para decir qué es una referencia —eso lo dice `PATRON_REFERENCIA`, y lo
  // comprueba `clienteDeReferencia`—. Con 20, lo que el modelo escribiera de
  // más se rechazaría por «demasiado largo» en vez de con la explicación de
  // cómo se escribe una referencia, que es lo que le sirve para corregirse.
  .max(40)
  .describe("La referencia de la clienta, como C-0042. Sale de buscar_cliente.");

const elPedido = z
  .string()
  .min(1)
  .max(40)
  .describe("El número del pedido (BC-000123) o su id.");

const porQue = z
  .string()
  .min(3)
  .max(200)
  .describe("Por qué se hace. Queda en la bitácora de acciones, que no se edita ni se borra.");

/**
 * Quién mira, para `pedidos-lectura`.
 *
 * `veDinero` sale del MISMO permiso que usa el panel (`cobros`), así que la
 * asistente tampoco ve el total por aquí.
 *
 * `veCosto` va en `false` fijo y no en `puedeVer(rol, "costo_y_margen")`: la
 * dueña SÍ tiene ese permiso, y preguntándoselo al rol `ver_pedido` le
 * devolvería el costo por línea. Ver el costo es cosa del panel; ninguna
 * herramienta del asistente lo trae.
 *
 * **Y está medido, porque no se notaba.** Al validar por mutación, cambiar este
 * `false` por `puedeVer(rol, "costo_y_margen")` NO ponía roja ninguna prueba:
 * el costo tampoco salía, porque el mapeo de `items` no copia
 * `costo_unit_cents` de todas formas. Un control cuya neutralización no rompe
 * nada no defiende nada (TRAMPAS §1), así que ahora lo vigila una prueba
 * directa —por eso esta función se exporta— y sigue aquí como segunda capa: el
 * día que alguien mapee las líneas con un `...l`, este `false` es lo que lo
 * salva.
 */
export const quienMira = (rol: Rol) => ({ veDinero: puedeVer(rol, "cobros"), veCosto: false });

/** Los montos, en centavos y en palabras. `null` cuando el rol no ve dinero. */
const comoSeLee = (cents: number | null): string | null =>
  cents === null ? null : formatear(cents);

/**
 * De varios pedidos a la referencia de su clienta, en dos consultas.
 *
 * Hace falta porque `listarPedidos` y `comprobantesPorConfirmar` devuelven el
 * NOMBRE de la clienta —es lo que pinta el panel— y el nombre no puede salir
 * hacia el modelo. La referencia no está en ninguna de las dos respuestas, así
 * que se busca aparte.
 *
 * Se resuelve en bloque y no pedido por pedido a propósito: D1 cobra por viaje,
 * y una lista de cincuenta pedidos serían cincuenta viajes para traducir un
 * dato que cabe en uno. `referenciaDe` solo se llama por las clientas que
 * todavía no tienen número, que es una vez en la vida de cada una.
 */
export async function referenciasPorPedido(
  db: D1Database,
  pedidoIds: readonly string[],
): Promise<Map<string, string | null>> {
  const salida = new Map<string, string | null>();
  if (pedidoIds.length === 0) return salida;

  const huecos = pedidoIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT id, cliente_id FROM pedidos WHERE id IN (${huecos})`)
    .bind(...pedidoIds)
    .all<{ id: string; cliente_id: string | null }>();

  const clientas = [...new Set(results.map((f) => f.cliente_id).filter((v) => v !== null))];
  const porClienta = new Map<string, string>();
  if (clientas.length > 0) {
    const huecosC = clientas.map(() => "?").join(",");
    const { results: filas } = await db
      .prepare(`SELECT id, referencia FROM clientes WHERE id IN (${huecosC})`)
      .bind(...clientas)
      .all<{ id: string; referencia: number | null }>();

    for (const f of filas) {
      // `referenciaDe` es la única que reparte números, y escribe uno nuevo si
      // la clienta no lo tenía. Se llama solo en ese caso: una clienta que ya
      // tiene referencia no cuesta ni un viaje más.
      porClienta.set(f.id, await referenciaDe(db, f.id));
    }
  }

  for (const f of results) {
    salida.set(f.id, f.cliente_id === null ? null : (porClienta.get(f.cliente_id) ?? null));
  }
  return salida;
}

/**
 * Un pedido de la lista, con la clienta convertida en referencia.
 *
 * `cliente` (el nombre) NO se copia. No se pone en `null` ni se tacha: no
 * existe en lo que sale. Lo que no se tiene no se puede soltar por error.
 */
function comoSeVeUnPedido(p: PedidoEnLista, clienta: string | null) {
  return {
    id: p.id,
    numero: p.numero,
    estado: p.estado,
    estadoPago: p.estado_pago,
    clienta,
    origen: p.origen,
    lineas: p.lineas,
    creadoEn: p.creado_en,
    /** Cuándo se le vence el apartado. `null` = no vence. */
    venceEn: p.vence_en,
    totalCents: p.total_cents,
    total: comoSeLee(p.total_cents),
    pagadoCents: p.pagado_cents,
    pagado: comoSeLee(p.pagado_cents),
    saldoCents: p.saldo_cents,
    saldo: comoSeLee(p.saldo_cents),
  };
}

/**
 * El pedido que nombra la persona, sea por número o por id.
 *
 * El panel trabaja con el id porque lo tiene en la pantalla. Quien habla con el
 * asistente dice «BC-000123», que es lo único que la clienta y la dueña ven
 * escrito. Se aceptan los dos y no se adivina: o casa con un id, o casa con un
 * número, o no hay pedido.
 */
const pedidoQueDicen = (db: D1Database, dicho: string) =>
  db
    .prepare("SELECT id, numero FROM pedidos WHERE id = ?1 OR numero = ?1")
    .bind(dicho.trim())
    .first<{ id: string; numero: string }>();

/** Lo que se contesta cuando el pedido que dicen no está. */
const noHayEsePedido = (dicho: string) =>
  `no hay ningún pedido con el número «${dicho}». Búsquelo con buscar_pedido antes de darlo por perdido.`;

/** El contexto que piden las funciones de `src/db/`, con QUIÉN lo hizo. */
const comoElUsuario = (ctx: Contexto) => ({
  db: ctx.db,
  ahora: ctx.ahora,
  // El correo y no el id: es lo que queda escrito cuando alguien pregunte quién
  // tomó este pedido, y es lo mismo que escribe el panel. Nunca se devuelve —un
  // correo es un dato de una persona y la guarda de D-20 lo cazaría.
  actor: ctx.usuario.correo,
});

// ---------------------------------------------------------------------------
// Leer · GET /pedidos y GET /pedidos/:id
// ---------------------------------------------------------------------------

export const buscarPedido = definir({
  nombre: "buscar_pedido",
  descripcion:
    "Los pedidos, el más nuevo primero, con su estado y su saldo. Se puede filtrar por estado, por texto del número o del nombre de la clienta, o por la referencia de una clienta. Ejemplo: buscar_pedido con estado «por_abonar» devuelve lo que falta por cobrar antes de agendar.",
  parametros: z.object({
    estado: z
      .string()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "por_abonar, agendado, en_ruta, entregado, cancelado o devuelto. Sin estado, todos.",
      ),
    busca: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("Texto del número del pedido o del nombre de la clienta, como «BC-0001» o «Ana»."),
    clienta: referenciaDeClienta.optional().describe("Solo los de esa clienta, como C-0042."),
    cuantos: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Cuántos pedidos devolver como máximo."),
  }),
  nivel: "lectura",
  categoria: "pedidos",
  // Los mismos que `exige("pedidos")` en el panel: la contadora los ve, y el
  // dinero de cada uno lo recorta `listarPedidos` según su rol.
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    // Una referencia que no es de nadie se dice, no se ignora: filtrar por una
    // clienta que no existe devolvería la lista entera y el modelo la leería
    // como «estos son los pedidos de ella».
    let clienteId: string | undefined;
    if (args.clienta !== undefined) {
      const c = await clienteDeReferencia(ctx.db, args.clienta);
      if (c === null) {
        return { pedidos: [], cuantos: 0, hayMas: false, aviso: noEsReferencia(args.clienta) };
      }
      clienteId = c.id;
    }

    const r = await listarPedidos(ctx.db, quienMira(ctx.usuario.rol), {
      ...(args.estado === undefined ? {} : { estado: args.estado }),
      ...(args.busca === undefined ? {} : { busca: args.busca }),
      ...(clienteId === undefined ? {} : { clienteId }),
      limite: args.cuantos,
    });

    // Un estado mal escrito se cuenta y se explica en vez de reventar: un
    // modelo que se equivoca de palabra tiene que poder corregirse en el mismo
    // turno. La lista de estados válidos vive en `pedidos-lectura.ts`, que es
    // quien la valida; aquí no se copia para que no acaben diciendo cosas
    // distintas.
    if (!r.ok) return { pedidos: [], cuantos: 0, hayMas: false, aviso: r.mensaje };

    const referencias = await referenciasPorPedido(
      ctx.db,
      r.datos.pedidos.map((p) => p.id),
    );

    return {
      pedidos: r.datos.pedidos.map((p) => comoSeVeUnPedido(p, referencias.get(p.id) ?? null)),
      cuantos: r.datos.pedidos.length,
      hayMas: r.datos.hayMas,
      veElDinero: quienMira(ctx.usuario.rol).veDinero,
      aviso: avisoDeLaLista(r.datos.pedidos.length, args, quienMira(ctx.usuario.rol).veDinero),
    };
  },
});

const noEsReferencia = (dicho: string) =>
  `«${dicho}» no tiene la forma de una referencia de clienta: se escriben como C-0042. Búsquela con buscar_cliente.`;

/**
 * Por qué una búsqueda de pedidos volvió vacía, y qué falta de la que no.
 *
 * Una lista vacía es la respuesta más peligrosa de esta herramienta: el modelo
 * lee `pedidos: []` y contesta «no hay pedidos», que son tres cosas distintas
 * —no hay ninguno todavía, no hay ninguno EN ESE ESTADO, o el texto no casó con
 * nada— y llevan a respuestas opuestas.
 *
 * Y cuando sí hay pedidos pero el rol no ve dinero, también se dice: un modelo
 * que recibe `total: null` sin explicación contesta que el pedido no tiene
 * total, y eso es falso.
 */
function avisoDeLaLista(
  cuantos: number,
  args: { estado?: string | undefined; busca?: string | undefined; clienta?: string | undefined },
  veDinero: boolean,
): string | null {
  if (cuantos === 0) {
    if (args.busca !== undefined) {
      return `ningún pedido casa con «${args.busca}». Pruebe con el número completo o con menos letras.`;
    }
    if (args.clienta !== undefined) return `${args.clienta} todavía no tiene ningún pedido anotado.`;
    if (args.estado !== undefined) {
      return `ahora mismo no hay ningún pedido en estado «${args.estado}». Sin estado se ven todos.`;
    }
    return "todavía no hay ningún pedido anotado en el sistema. No es que falten datos: es que no hay.";
  }
  return veDinero
    ? null
    : "los montos van en blanco porque su rol no ve el dinero de los pedidos. No es que el pedido no tenga total.";
}

export const verPedido = definir({
  nombre: "ver_pedido",
  descripcion:
    "Un pedido con sus líneas: qué lleva, cuánto de cada cosa, el envío, el total y lo que falta por cobrar. Ejemplo: ver_pedido con pedido «BC-000123» dice qué pidió y cuánto debe todavía.",
  parametros: z.object({ pedido: elPedido }),
  nivel: "lectura",
  categoria: "pedidos",
  roles: ["duena", "asistente", "contadora"],
  /**
   * Devuelve la nota que escribió la clienta, así que a partir de aquí el turno
   * desconfía: construir deja de ser directo y pasa por la persona
   * (06-asistente §7). Es la defensa contra que lo que el modelo cree que le
   * pidieron venga de dentro de esa nota y no de quien está hablando.
   */
  textoExterno: true,

  async ejecutar(ctx, args) {
    const cual = await pedidoQueDicen(ctx.db, args.pedido);
    if (cual === null) {
      return { existe: false, aviso: noHayEsePedido(args.pedido) };
    }

    const r = await leerPedido(ctx.db, quienMira(ctx.usuario.rol), cual.id);
    if (!r.ok) return { existe: false, aviso: r.mensaje };

    const p = r.datos;
    const referencias = await referenciasPorPedido(ctx.db, [p.id]);

    return {
      existe: true,
      ...comoSeVeUnPedido(p, referencias.get(p.id) ?? null),
      subtotalCents: p.subtotal_cents,
      subtotal: comoSeLee(p.subtotal_cents),
      envioCents: p.envio_cents,
      envio: comoSeLee(p.envio_cents),
      descuentoCents: p.descuento_cents,
      descuento: comoSeLee(p.descuento_cents),
      itbmsCents: p.itbms_cents,
      itbms: comoSeLee(p.itbms_cents),
      // La zona de envío NO sale, ni la bodega de cada línea. En un país
      // pequeño una zona es casi una dirección, y una dirección es justo lo que
      // D-20 deja fuera. El monto del envío sí va: ese es del negocio.
      tieneZona: p.zona !== null,
      /**
       * Lo que escribió la clienta, tal cual.
       *
       * Va marcado como texto de fuera (`textoExterno`) y no se recorta: si
       * dentro hay un celular, un correo o el nombre de una clienta, la guarda
       * de D-20 descarta este resultado entero y el modelo se queda sin él. Eso
       * es la guarda haciendo su trabajo, no un fallo — la nota se lee en el
       * panel, que es donde sí se puede ver.
       */
      notaDeLaClienta: p.notas_cliente,
      items: p.items.map((l) => ({
        codigo: l.codigo,
        nombre: l.nombre,
        cantidad: l.cantidad,
        precioUnitCents: l.precio_unit_cents,
        precioUnit: comoSeLee(l.precio_unit_cents),
      })),
      aviso: avisoDelPedido(p, quienMira(ctx.usuario.rol).veDinero),
    };
  },
});

/** Lo que hay que decir de un pedido que SÍ se encontró. */
function avisoDelPedido(
  p: { items: readonly unknown[]; estado: string; vence_en: number | null },
  veDinero: boolean,
): string | null {
  if (p.items.length === 0) {
    return "este pedido no tiene ninguna línea anotada, lo que no debería pasar: revíselo en el panel.";
  }
  if (!veDinero) {
    return "los montos van en blanco porque su rol no ve el dinero de los pedidos. No es que el pedido no tenga total.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Escribir · POST /pedidos, /pedidos/:id/agendar y /pedidos/:id/cancelar
// ---------------------------------------------------------------------------

export const crearPedidoDeLaClienta = definir({
  nombre: "crear_pedido",
  descripcion:
    "Toma un pedido y aparta la mercancía. El precio NO se escribe: lo pone el servidor desde el catálogo. El pedido queda «por_abonar» hasta que entre el abono. Ejemplo: crear_pedido con clienta «C-0042», lineas [{codigo: «NAT-M», cantidad: 2}] y motivo «lo pidió por WhatsApp».",
  parametros: z.object({
    clienta: referenciaDeClienta,
    lineas: z
      .array(
        z.object({
          codigo: z.string().min(1).max(40).describe("El código del artículo, como NAT-M."),
          cantidad: z.number().int().positive().max(10_000),
          bodega: z
            .string()
            .min(1)
            .max(60)
            .optional()
            .describe("De qué bodega sale. Si falta, se elige la que tenga con qué."),
        }),
      )
      .min(1)
      .max(50)
      .describe("Qué lleva el pedido. Sin líneas no es un pedido."),
    zona: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("El nombre de la zona de envío. Sin zona, el envío se cotiza aparte."),
    motivo: porQue,
  }),
  /**
   * Sensible, y eso significa que el asistente NO la ejecuta: la propone con el
   * detalle exacto y espera a que una persona toque «Permitir». Un pedido
   * aparta mercancía —`reservado` sube y esas unidades dejan de poderse
   * vender—, y eso es tocar existencias.
   */
  nivel: "sensible",
  categoria: "pedidos",
  /**
   * Solo la dueña, aunque la ruta del panel la deja también a la asistente.
   *
   * No es un capricho ni un ensanche al revés: en este repositorio una acción
   * sensible la confirma la dueña y hay una prueba en `registro.test.ts` que se
   * cae si una sensible se le da a alguien más. La asistente sigue tomando
   * pedidos desde el panel, que es donde los toma hoy; por el asistente, el que
   * aparta mercancía es quien responde por ella.
   */
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const clienta = await clienteDeReferencia(ctx.db, args.clienta);
    if (clienta === null) throw new Error(noEsReferencia(args.clienta));

    // Las reglas del pedido —el abono mínimo y el plazo— las resuelve la misma
    // función que usa la ruta del panel. `crearPedido` se niega a inventarlas.
    const reglas = await reglasDelPedido({ db: ctx.db, ahora: ctx.ahora });
    if (!reglas.ok) throw new Error(reglas.mensaje);

    const r = await crearPedido(
      {
        ...comoElUsuario(ctx),
        abonoMinimoCents: reglas.datos.abonoMinimoCents,
        minutosParaAbonar: reglas.datos.minutosParaAbonar,
      },
      {
        idempotencia: llaveDelPedido(ctx, clienta.id, args.lineas),
        clienteId: clienta.id,
        // «panel» quiere decir «lo tecleó la casa», no «lo tecleó un
        // navegador»: un pedido que toma el equipo hablando con la clienta es
        // ese, entre por el chat del panel, por Telegram o por MCP. Poner aquí
        // el canal convertiría la puerta por la que se pidió en un canal de
        // venta, y las métricas por canal dejarían de significar algo. Por qué
        // puerta entró queda anotado en `acciones.canal`.
        origen: "panel",
        // Una línea sin bodega NO lleva la clave puesta en `undefined`: con
        // `exactOptionalPropertyTypes`, «no la dijeron» y «la dijeron vacía»
        // son cosas distintas, y `crearPedido` elige bodega solo en el primer
        // caso. Es la misma distinción que el panel cuida en cada campo.
        lineas: args.lineas.map((l) => ({
          codigo: l.codigo,
          cantidad: l.cantidad,
          ...(l.bodega === undefined ? {} : { bodega: l.bodega }),
        })),
        ...(args.zona === undefined ? {} : { zona: args.zona }),
      },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pedidoId: r.datos.id,
      numero: r.datos.numero,
      clienta: args.clienta,
      // `token` NO se devuelve. Es lo que abre el enlace de seguimiento del
      // pedido sin pedir nada más: un secreto, y los secretos no salen por una
      // herramienta (06-asistente §3, punto 3).
      totalCents: r.datos.totalCents,
      total: formatear(r.datos.totalCents),
      envioCents: r.datos.envioCents,
      envio: formatear(r.datos.envioCents),
      abonoMinimoCents: r.datos.abonoMinimoCents,
      abonoMinimo: formatear(r.datos.abonoMinimoCents),
      requierePagoTotal: r.datos.requierePagoTotal,
      venceEn: r.datos.venceEn,
    };
  },
});

/**
 * La llave con la que queda identificada esta petición.
 *
 * ⚠️ **Hoy esta llave no cierra nada, y conviene saberlo antes de confiar en
 * ella.** `crearPedido` la recibe y lo único que hace con ella es escribirla en
 * el `datos_json` del evento «creado»: no la busca en la tabla `idempotencia`
 * —que sí usan `src/rpc/crm.ts` y `src/db/entregas.ts`— ni hay un UNIQUE que
 * la cubra. O sea que `POST /pedidos` tampoco es idempotente, pese a que su
 * comentario en el panel diga que sin la llave «un doble toque con mala señal
 * crea dos pedidos»: con ella, también. Queda dicho aquí y en el informe; no
 * se arregla desde una herramienta del asistente porque cambiar eso cambia el
 * panel y la web, y la ventana de retención es una decisión de la dueña.
 *
 * Lo que SÍ impide el doble pedido por esta puerta es otra cosa, y es real: la
 * herramienta es sensible, así que no se ejecuta sin una fila de `acciones`
 * confirmada, y el trigger `acciones_solo_se_cierran_una_vez` aborta el segundo
 * cierre. Es la idempotencia que describe 06-asistente §3: el id de la acción.
 *
 * Aun así la llave se DERIVA del contenido y no se inventa al azar, por dos
 * motivos: una llave distinta en cada intento no serviría de nada el día que
 * alguien la compruebe, y mientras tanto deja en el evento del pedido una
 * huella con la que dos pedidos gemelos se reconocen a simple vista. Lleva el
 * día de Panamá dentro para que «lo mismo otra vez el mes que viene» sea otra
 * petición y no la misma. El día es una ventana de deduplicación, no una cifra
 * del negocio.
 */
function llaveDelPedido(
  ctx: Contexto,
  clienteId: string,
  lineas: readonly { codigo: string; cantidad: number }[],
): string {
  const que = lineas.map((l) => `${l.codigo}x${l.cantidad}`).join(",");
  return `asistente:${ctx.usuario.id}:${fechaPanama(ctx.ahora)}:${clienteId}:${que}`;
}

export const agendarPedido = definir({
  nombre: "agendar_pedido",
  descripcion:
    "Mete un pedido en la lista de entregas. Si alcanza el abono o no lo decide el servidor con la regla copiada en el pedido el día que se creó. Ejemplo: agendar_pedido con pedido «BC-000123» y motivo «ya mandó el comprobante y está confirmado».",
  parametros: z.object({ pedido: elPedido, motivo: porQue }),
  /**
   * Construcción, no sensible: agendar no mueve dinero ni existencias. La
   * mercancía ya está apartada desde que se creó el pedido, y lo único que
   * cambia es que entra en la lista de entregas. Si el abono no alcanza, no
   * agenda — eso lo decide `puedeAgendar`, que es la regla con sus pruebas.
   */
  nivel: "construccion",
  categoria: "pedidos",
  /** Los mismos que `exigeEditar("pedidos")` en el panel. */
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const cual = await pedidoQueDicen(ctx.db, args.pedido);
    if (cual === null) throw new Error(noHayEsePedido(args.pedido));

    const r = await agendar(comoElUsuario(ctx), cual.id);
    if (!r.ok) throw new Error(r.mensaje);

    return { pedidoId: cual.id, numero: cual.numero, agendado: true };
  },
});

export const anularPedido = definir({
  nombre: "anular_pedido",
  descripcion:
    "Cancela un pedido y devuelve al inventario lo que tenía apartado. Si hubo abono, ese dinero queda esperando una decisión y no desaparece. Ejemplo: anular_pedido con pedido «BC-000123» y motivo «la clienta ya no lo quiere».",
  parametros: z.object({ pedido: elPedido, motivo: porQue }),
  /**
   * Sensible: devuelve mercancía al inventario y, si hubo abono, deja dinero de
   * una clienta esperando una decisión. El motivo no es burocracia — un
   * movimiento así sin explicación es lo que nadie puede auditar después, y por
   * eso `cancelar` lo exige y lo escribe en el evento del pedido.
   */
  nivel: "sensible",
  categoria: "pedidos",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const cual = await pedidoQueDicen(ctx.db, args.pedido);
    if (cual === null) throw new Error(noHayEsePedido(args.pedido));

    const r = await cancelar(comoElUsuario(ctx), cual.id, args.motivo);
    if (!r.ok) throw new Error(r.mensaje);

    return {
      pedidoId: cual.id,
      numero: cual.numero,
      anulado: true,
      /** Unidades que volvieron a estar disponibles. */
      liberadas: r.datos.liberadas,
    };
  },
});

// ---------------------------------------------------------------------------
// Clientas · GET /clientes, GET /clientes/:id y POST /clientes
// ---------------------------------------------------------------------------

export const buscarCliente = definir({
  nombre: "buscar_cliente",
  descripcion:
    "Encuentra una clienta por su nombre o su celular y devuelve su REFERENCIA (C-0042), cuántos pedidos tiene y cuándo fue el último. El nombre y el celular no salen de aquí. Ejemplo: buscar_cliente con texto «Ana» devuelve C-0042 para poder preguntar por sus pedidos.",
  parametros: z.object({
    texto: z
      .string()
      .min(1)
      .max(80)
      .describe("El nombre o el celular que dijo la persona: «Ana», «6000-0001»."),
    cuantos: z.number().int().min(1).max(20).default(10).describe("Cuántas devolver como máximo."),
  }),
  nivel: "lectura",
  categoria: "clientes",
  /** Los mismos que `exige("pedidos")` en el panel. */
  roles: ["duena", "asistente", "contadora"],
  /**
   * NO lleva `textoExterno`, y es una decisión, no un olvido: aquí ENTRA un
   * nombre y no SALE ninguno. Lo que vuelve —la referencia, dos cuentas y una
   * fecha— lo escribe el sistema, no una clienta. Marcarla endurecería el resto
   * del turno sin que nada de fuera haya entrado en lo que el modelo lee, y una
   * marca que no corresponde enseña a no mirarlas.
   */

  async ejecutar(ctx, args) {
    // `buscar` normaliza el celular antes de comparar, así que «6000-0001»
    // encuentra a quien está guardada como 50760000001. Esa traducción vive
    // allá y no aquí: es la misma que usa el panel.
    const r = await buscarClientas(ctx.db, args.texto, args.cuantos);
    if (!r.ok) return { clientas: [], cuantas: 0, aviso: r.mensaje };

    const clientas = [];
    for (const c of r.datos.clientas) {
      clientas.push({
        // Lo ÚNICO que identifica a la clienta hacia fuera. `nombre` y
        // `celular_e164` vienen en la fila y se quedan aquí.
        clienta: await referenciaDe(ctx.db, c.id),
        pedidos: c.pedidos,
        ultimoPedido: c.ultimo_pedido,
      });
    }

    return {
      clientas,
      cuantas: clientas.length,
      // El aviso NO repite lo que se buscó.
      //
      // Lo repetía, y eso mataba la herramienta justo cuando traía malas
      // noticias: con coincidencia el aviso es null y todo iba bien, pero sin
      // coincidencia volvía el texto buscado, y si ese texto era un celular
      // —la mitad de para lo que existe esta herramienta, y el ejemplo de su
      // propia descripción— la guarda de D-20 veía un celular en la respuesta y
      // tumbaba el resultado entero. Comprobado en vivo por MCP:
      // `buscar_cliente("6000-0001")` contestaba «Ese resultado traía datos de
      // una clienta (celular)». Con el consejo «pruebe con el celular
      // completo» dentro del mensaje que nunca se podía entregar.
      //
      // El razonamiento de arriba —«aquí ENTRA un nombre y no SALE ninguno»—
      // miraba los datos y se le escapó que la ENTRADA se estaba copiando en
      // la salida. Un eco también es una salida.
      aviso:
        clientas.length === 0
          ? "ninguna clienta casa con eso. Pruebe con menos letras del nombre, o con el celular completo."
          : null,
    };
  },
});

export const historialDeCliente = definir({
  nombre: "historial_de_cliente",
  descripcion:
    "La ficha de una clienta por su referencia: sus pedidos, cuánto ha comprado y qué datos le faltan para cobrarle con tarjeta o para facturarle. Ejemplo: historial_de_cliente con clienta «C-0042» dice qué ha pedido y que le falta el correo para pagar con tarjeta.",
  parametros: z.object({ clienta: referenciaDeClienta }),
  nivel: "lectura",
  categoria: "clientes",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const quien = await clienteDeReferencia(ctx.db, args.clienta);
    if (quien === null) {
      return { existe: false, aviso: noEsReferencia(args.clienta) };
    }

    const r = await leerFichaDeClienta(ctx.db, quienMira(ctx.usuario.rol), quien.id);
    if (!r.ok) return { existe: false, aviso: r.mensaje };

    const f = r.datos;
    const vePlata = quienMira(ctx.usuario.rol).veDinero;

    return {
      existe: true,
      clienta: args.clienta,
      // De `f.clienta` sale el ANTES y el después y nada más: nombre,
      // apellido, celular, correo, identificación y notas se quedan en la
      // base. Las notas tampoco salen aunque las escriba la casa: son texto
      // libre sobre una persona, y es donde acaba escrita una dirección que la
      // guarda de D-20 no sabe reconocer en prosa.
      desdeCuando: f.clienta.creado_en,
      tieneNotas: f.clienta.notas !== null && f.clienta.notas.trim() !== "",
      /** Su ficha se fusionó en otra: la persona vive allá. */
      fusionada: f.clienta.fusionado_en_id !== null,
      anonimizada: f.clienta.anonimizado_en !== null,
      // De las direcciones solo la CUENTA. Ni la calle, ni la ciudad, ni la
      // zona: en un país pequeño la zona es casi la dirección.
      cuantasDirecciones: f.direcciones.length,
      tieneDireccionActiva: f.direcciones.some((d) => d.activa === 1),
      // `falta` son nombres de campos («el correo», «la ciudad»), no valores:
      // dice QUÉ hay que ir a poner en el panel sin decir qué hay puesto.
      faltaParaTarjeta: f.falta.paraTarjeta,
      faltaParaFactura: f.falta.paraFactura,
      pedidos: f.pedidos.map((p) => comoSeVeUnPedido(p, args.clienta)),
      cuantosPedidos: f.pedidos.length,
      aviso: avisoDeLaFicha(f, vePlata, args.clienta),
    };
  },
});

/** Qué hay que decir de una ficha que sí se encontró. */
function avisoDeLaFicha(
  f: {
    clienta: { fusionado_en_id: string | null; anonimizado_en: number | null };
    pedidos: readonly unknown[];
  },
  veDinero: boolean,
  referencia: string,
): string | null {
  if (f.clienta.anonimizado_en !== null) {
    return `${referencia} está anonimizada: sus datos se borraron a pedido suyo y lo que queda son sus pedidos.`;
  }
  if (f.clienta.fusionado_en_id !== null) {
    return `${referencia} es una ficha que se fusionó en otra: la persona vive en la otra, y es ahí donde hay que mirar.`;
  }
  if (f.pedidos.length === 0) {
    return `${referencia} está dada de alta y todavía no tiene ningún pedido. No es que falten datos.`;
  }
  return veDinero
    ? null
    : "los montos de sus pedidos van en blanco porque su rol no ve el dinero. No es que no tengan total.";
}

export const darDeAltaClienta = definir({
  nombre: "dar_de_alta_clienta",
  descripcion:
    "Da de alta una clienta con su nombre y su celular, y devuelve su referencia. Si ese celular ya es de alguien, devuelve a ESA persona en vez de abrir otra ficha. Ejemplo: dar_de_alta_clienta con nombre «Ana Gómez», celular «6000-0001» y motivo «escribió por WhatsApp para pedir».",
  parametros: z.object({
    nombre: z.string().min(1).max(120).describe("Cómo se llama, tal como lo dijo la persona."),
    celular: z
      .string()
      .min(7)
      .max(20)
      .describe("Su celular. Se entiende con guiones, con espacios, con +507 o con los ocho dígitos."),
    motivo: porQue,
  }),
  /**
   * Construcción: no toca dinero, ni precios, ni existencias. Abre una ficha, y
   * si el celular ya era de alguien no abre nada —devuelve a esa persona—, que
   * es la defensa contra la misma señora con tres fichas y el historial
   * repartido entre las tres.
   */
  nivel: "construccion",
  categoria: "clientes",
  /** Los mismos que `exigeEditar("pedidos")` en el panel. */
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const r = await encontrarOCrearClienta(comoElUsuario(ctx), {
      nombre: args.nombre,
      celular: args.celular,
    });
    if (!r.ok) throw new Error(r.mensaje);

    return {
      // La referencia, no el id ni el nombre. `encontrarOCrear` devuelve el
      // nombre para que el panel pueda decir «ya la tenía»; eso lo dice el
      // panel, que puede verlo, y no el modelo.
      clienta: await referenciaDe(ctx.db, r.datos.clienteId),
      /** `false` significa que ese celular ya era de alguien y es esa persona. */
      nueva: r.datos.nuevo,
    };
  },
});

export const HERRAMIENTAS_DE_PEDIDOS = [
  buscarPedido,
  verPedido,
  crearPedidoDeLaClienta,
  agendarPedido,
  anularPedido,
  buscarCliente,
  historialDeCliente,
  darDeAltaClienta,
] as const;
