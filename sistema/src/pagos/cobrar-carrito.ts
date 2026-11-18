import { fallo, ok, type Resultado } from "../contrato/resultado";
import { iniciarCobro } from "../db/cobros-en-linea";
import { encontrarOCrear } from "../db/clientes";
import { crearPedido, minutosDeReservaEnLinea, reglasDelPedido } from "../db/pedidos";
import { abrirCredenciales } from "../db/pasarelas";
import { credencialesYappy, yappy } from "./yappy";
import { DOMINIO_DECLARADO } from "./recibir-aviso";
import type { Buscador } from "./proveedor";

/**
 * El carrito de la web, convertido en un pedido que se puede pagar.
 *
 * Es el paso que faltaba entre «la clienta llenó su carrito» y «el botón de
 * Yappy aparece en pantalla». Hace tres cosas, en este orden y en este sitio
 * para que ninguna se pueda saltar:
 *
 *   1. Encuentra o crea la ficha de la clienta por su celular.
 *   2. Crea el pedido — **con los precios del servidor**, no los del navegador.
 *   3. Arranca el cobro y devuelve lo que el botón necesita.
 *
 * ## EL NAVEGADOR MANDA QUÉ, NUNCA CUÁNTO
 *
 * Lo que entra son códigos y cantidades. Ni un precio, ni un total, ni el costo
 * del envío. Todo eso lo pone `crearPedido` leyendo la base, y por eso un
 * carrito manipulado —cambiar el precio en las herramientas del navegador, que
 * cuesta diez segundos— no cambia lo que se cobra: cambia lo que esa persona
 * VE, y al llegar aquí se recalcula entero.
 *
 * Es la misma regla que ya protege el aviso de pago, un paso antes: el
 * navegador no decide un pago, y tampoco decide un precio.
 *
 * ## Por qué el cobro es por el TOTAL y no por el abono
 *
 * Baby Caleb acepta abonos —apartar con una parte y pagar el resto al
 * entregar—, pero eso se hace hablando con una persona. Un cobro en línea de
 * una clienta que no conoce a nadie se hace completo: si pagara un abono, el
 * saldo quedaría a cobrar en la puerta por un motorizado, que es justo el
 * trato que el negocio quiere evitar cuando la venta empezó sola en la web.
 *
 * El día que eso cambie, el monto sale de `reglasDelPedido` y no de aquí.
 */

/** Lo que manda el navegador. Ni un precio entre estos campos. */
export interface CarritoACobrar {
  readonly nombre: string;
  readonly celular: string;
  /** El nombre de la zona de envío, como la llama el tarifario. */
  readonly zona?: string | undefined;
  readonly notas?: string | undefined;
  readonly lineas: ReadonlyArray<{ readonly codigo: string; readonly cantidad: number }>;
  /**
   * La misma cadena para el mismo INTENTO de pago.
   *
   * Es lo que impide que un doble toque —o una pestaña reenviada— cree dos
   * pedidos y aparte el inventario dos veces.
   *
   * **Escrito tras un susto:** la primera versión de este archivo decía que
   * `crearPedido` la usaba para devolver el pedido que ya existe. **Es falso.**
   * `crearPedido` solo la ANOTA en la bitácora del pedido; no deduplica nada.
   * Lo encontró la prueba del doble toque, que creó dos pedidos — y habría ido
   * a producción con un comentario afirmando lo contrario, que es peor que no
   * tener comentario.
   *
   * La deduplicación la hace ESTE archivo, con la tabla `idempotencia`, igual
   * que `rpc/crm.ts` y `db/entregas.ts`.
   */
  readonly idempotencia: string;
}

export interface ListoParaPagar {
  readonly pedido: {
    readonly numero: string;
    /** El token público del pedido: con él la clienta puede verlo después. */
    readonly token: string;
    readonly totalCents: number;
    readonly envioCents: number;
  };
  /**
   * Lo que el componente de Yappy necesita, y NADA más.
   *
   * Los tres valores que devuelve su API. Ninguno es un secreto: la clave
   * secreta del comercio se queda en el servidor y no sale por aquí ni por
   * error — hay una prueba que lo comprueba.
   */
  readonly boton: {
    readonly transactionId: string;
    readonly token: string;
    readonly documentName: string;
  };
}

const TOPE_DE_LINEAS = 40;
const TOPE_POR_LINEA = 99;

export interface ContextoDelCobro {
  readonly db: D1Database;
  readonly ahora: number;
  readonly llaveMaestra?: string | undefined;
  /** A dónde manda Yappy su aviso. Sale del Worker, no del navegador. */
  readonly urlDelAviso: string;
  /** El teléfono de la clienta, que Yappy exige para mandarle la solicitud. */
  readonly aliasYappy?: string | undefined;
}

export async function cobrarCarrito(
  ctx: ContextoDelCobro,
  carrito: CarritoACobrar,
  buscar: Buscador = fetch,
): Promise<Resultado<ListoParaPagar>> {
  // ---- Lo que entra, antes de tocar nada -----------------------------------
  if (!Array.isArray(carrito.lineas) || carrito.lineas.length === 0) {
    return fallo("entrada_invalida", "el carrito está vacío");
  }
  if (carrito.lineas.length > TOPE_DE_LINEAS) {
    return fallo("entrada_invalida", `un pedido no puede llevar más de ${TOPE_DE_LINEAS} artículos distintos`);
  }
  for (const l of carrito.lineas) {
    if (typeof l?.codigo !== "string" || l.codigo.trim() === "") {
      return fallo("entrada_invalida", "hay una línea sin artículo");
    }
    if (!Number.isSafeInteger(l.cantidad) || l.cantidad < 1 || l.cantidad > TOPE_POR_LINEA) {
      return fallo(
        "entrada_invalida",
        `la cantidad de ${l.codigo} tiene que ser un número entre 1 y ${TOPE_POR_LINEA}`,
      );
    }
  }
  if (typeof carrito.idempotencia !== "string" || carrito.idempotencia.trim().length < 8) {
    return fallo("entrada_invalida", "falta la referencia del carrito");
  }

  // ---- 0 · ¿Esto ya se hizo? -----------------------------------------------
  //
  // Va ANTES de crear la ficha de la clienta y antes del pedido: deduplicar
  // después de apartar inventario no deduplica nada.
  const clave = carrito.idempotencia.trim();
  const huella = await huellaDe({
    lineas: carrito.lineas,
    celular: carrito.celular,
    zona: carrito.zona ?? null,
  });

  const ya = await ctx.db
    .prepare(
      "SELECT huella_entrada, respuesta_json FROM idempotencia WHERE clave = ? AND ruta = ? AND vence_en > ?",
    )
    .bind(clave, RUTA, ctx.ahora)
    .first<{ huella_entrada: string; respuesta_json: string | null }>();

  if (ya !== null) {
    /**
     * MISMA CLAVE CON OTRA ENTRADA = `repetido`, NUNCA la respuesta anterior.
     *
     * Es la lección que `rpc/crm.ts` tiene escrita por haberla sufrido: ahí,
     * dos ventas distintas con la misma clave devolvían la respuesta de la
     * primera con `ok: true` y no descontaban nada. Una venta perdida
     * reportada como cumplida es peor que un error, porque nadie la va a
     * buscar.
     */
    if (ya.huella_entrada !== huella) {
      return fallo(
        "repetido",
        "Ese carrito cambió mientras se pagaba. Vuelve a la tienda y empieza el pago otra vez.",
      );
    }
    if (ya.respuesta_json !== null) {
      try {
        return ok(JSON.parse(ya.respuesta_json) as ListoParaPagar);
      } catch {
        // Si no se puede leer, se sigue adelante: es mejor un pedido de más
        // —que vence y suelta su reserva— que una clienta que no puede pagar.
      }
    }
  }

  // ---- 1 · La clienta ------------------------------------------------------
  const cliente = await encontrarOCrear(
    { db: ctx.db, ahora: ctx.ahora, actor: "web: checkout" },
    { nombre: carrito.nombre ?? "", celular: carrito.celular ?? "" },
  );
  if (!cliente.ok) return cliente;

  // ---- 2 · El pedido, con los precios del SERVIDOR -------------------------
  const reglas = await reglasDelPedido({ db: ctx.db, ahora: ctx.ahora });
  const minutos = await minutosDeReservaEnLinea({ db: ctx.db, ahora: ctx.ahora });
  if (!minutos.ok) return minutos;
  if (!reglas.ok) return reglas;

  const pedido = await crearPedido(
    {
      db: ctx.db,
      ahora: ctx.ahora,
      actor: "web: checkout",
      abonoMinimoCents: reglas.datos.abonoMinimoCents,
      /**
       * El reloj de la WEB, no el del teléfono.
       *
       * `reglasDelPedido` da el plazo de un pedido que toma una persona, que
       * puede no vencer. Este nace de un botón público y tiene que vencer
       * siempre: si no, cada carrito abandonado se queda con la caja.
       */
      minutosParaAbonar: minutos.datos,
    },
    {
      idempotencia: carrito.idempotencia,
      clienteId: cliente.datos.clienteId,
      origen: "web",
      lineas: carrito.lineas.map((l) => ({ codigo: l.codigo.trim(), cantidad: l.cantidad })),
      ...(carrito.zona === undefined || carrito.zona.trim() === "" ? {} : { zona: carrito.zona.trim() }),
      ...(carrito.notas === undefined || carrito.notas.trim() === ""
        ? {}
        : { notasCliente: carrito.notas.trim() }),
    },
  );
  if (!pedido.ok) return pedido;

  // ---- 3 · El cobro --------------------------------------------------------
  const cred = await abrirCredenciales({ db: ctx.db, ahora: ctx.ahora, llaveMaestra: ctx.llaveMaestra }, "yappy");
  if (!cred.ok) return cred;

  const suyas = credencialesYappy(cred.datos.modo, cred.datos.valores, DOMINIO_DECLARADO);
  if (!suyas.ok) return suyas;

  /**
   * El teléfono al que Yappy manda la solicitud.
   *
   * Por defecto, el de la clienta: es a su Yappy al que tiene que llegar. En el
   * entorno de PRUEBAS tiene que ser un número dado de alta en el programa de
   * pruebas de Yappy, y por eso se puede forzar desde fuera — con cualquier
   * otro, la orden se crea y la solicitud no llega a ningún teléfono, y eso se
   * lee como «no funciona» cuando lo que pasa es ese dato.
   */
  const alias = ctx.aliasYappy ?? carrito.celular;

  const cobro = await iniciarCobro(
    { db: ctx.db, ahora: ctx.ahora, actor: "web: checkout" },
    {
      pedidoId: pedido.datos.id,
      proveedor: "yappy",
      metodo: "yappy",
      tipo: "total",
      montoCents: pedido.datos.totalCents,
      urlAviso: ctx.urlDelAviso,
    },
    yappy({ aliasYappy: soloDigitos(alias) }, buscar),
    suyas.datos,
  );
  if (!cobro.ok) return cobro;

  if (cobro.datos.datosBoton === undefined) {
    // Yappy no devolvió los tres valores. El pago existe y quedó anotado, pero
    // sin ellos el botón no puede abrir el modal: se dice en vez de devolver
    // un objeto a medias que reventaría en el navegador.
    return fallo(
      "pasarela_no_disponible",
      "Yappy no devolvió los datos del botón. El pedido quedó creado; inténtelo otra vez en un momento.",
    );
  }

  const b = cobro.datos.datosBoton;
  if (b.transactionId === undefined || b.token === undefined || b.documentName === undefined) {
    return fallo("pasarela_no_disponible", "Yappy devolvió los datos del botón incompletos.");
  }

  const listo: ListoParaPagar = {
    pedido: {
      numero: pedido.datos.numero,
      token: pedido.datos.token,
      totalCents: pedido.datos.totalCents,
      envioCents: pedido.datos.envioCents,
    },
    boton: {
      transactionId: b.transactionId,
      token: b.token,
      documentName: b.documentName,
    },
  };

  /**
   * SE GUARDA DIEZ MINUTOS, NO VEINTICUATRO HORAS.
   *
   * Lo que se guarda incluye el token del botón de Yappy, y **una orden de
   * Yappy vive cinco minutos**. Devolver esa respuesta media hora después
   * daría un botón muerto: la clienta toca, no pasa nada, y nadie sabe por
   * qué.
   *
   * Con diez minutos, el doble toque —que es el riesgo de verdad, y ocurre en
   * segundos— queda cubierto, y un reintento posterior crea un pedido nuevo,
   * que es lo correcto porque el anterior ya no se puede pagar. Ese pedido
   * viejo vence solo y el cron suelta su reserva.
   */
  await ctx.db
    .prepare(
      `INSERT OR REPLACE INTO idempotencia (clave, ruta, huella_entrada, respuesta_json, creado_en, vence_en)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(clave, RUTA, huella, JSON.stringify(listo), ctx.ahora, ctx.ahora + MINUTOS_DE_GRACIA * 60_000)
    .run();

  return ok(listo);
}

/** La ruta con la que se guarda la clave, para no chocar con las de otros. */
const RUTA = "web:cobrar-carrito";
const MINUTOS_DE_GRACIA = 10;

/**
 * La huella de lo que se pidió.
 *
 * Sirve para distinguir «la misma clienta tocó dos veces» de «alguien reusó la
 * clave con otro carrito». No lleva el nombre ni las notas a propósito:
 * corregir una tilde del nombre no debería contar como un carrito distinto, y
 * lo que decide qué se cobra son las líneas, el celular y la zona.
 */
async function huellaDe(entrada: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(entrada));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Yappy quiere el celular sin prefijo y sin adornos.
 *
 * La clienta escribe «6000-0001», «+507 6000 0001» o «507-6000-0001». Se
 * quedan los dígitos y se quita el 507 de delante si está: mandarlo con el
 * prefijo es uno de los motivos por los que la solicitud no llega a ningún
 * teléfono, y el error que devuelve Yappy no lo dice.
 */
function soloDigitos(celular: string): string {
  const d = (celular ?? "").replace(/\D/g, "");
  return d.startsWith("507") && d.length > 8 ? d.slice(3) : d;
}
