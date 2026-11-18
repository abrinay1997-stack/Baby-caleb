/**
 * El paso de pago: el contrato con el servidor y lo único que el navegador
 * decide.
 *
 * ## LO QUE ESTE ARCHIVO NO HACE, Y ES EL PUNTO
 *
 * No calcula un total. No calcula un envío. No suma impuestos. No decide si
 * algo está pagado. El cuerpo que se manda lleva **códigos, cantidades y los
 * datos de la clienta**, y nada más: el servidor saca el precio de su base,
 * cotiza el envío por la zona y devuelve el total que se va a cobrar.
 *
 * Es la misma frontera que ya está escrita en `carrito.ts` —el carrito vive en
 * `localStorage`, que la clienta puede editar con dos clics— llevada un paso
 * más allá: si aquí se mandara un total, ese total sería editable, y el cobro
 * se haría con lo que diga el navegador. Por eso el contrato dice que los
 * precios que lleguen de aquí **se ignoran**, y por eso no se mandan: mandar
 * algo que el servidor tira es invitar al siguiente a creer que sirve.
 *
 * El `CLAUDE.md` del repositorio lo dice en una línea: «el navegador no decide
 * un pago».
 *
 * ## LOS MENSAJES DE ERROR DEL SERVIDOR SE ENSEÑAN TAL CUAL
 *
 * `{ ok: false, codigo, mensaje }` trae un `mensaje` escrito para que lo lea
 * una clienta. No se reescribe, no se adorna y no se traduce a «algo salió
 * mal»: el que lo escribió sabía qué pasó y esta pantalla no. Lo único que se
 * redacta aquí es el caso en que **no hubo respuesta** —la petición se cayó
 * antes de llegar—, porque ahí no hay ningún mensaje que enseñar.
 *
 * ## LA LLAVE DE IDEMPOTENCIA
 *
 * La misma cadena para el mismo carrito. Si la clienta toca pagar dos veces
 * —o vuelve atrás y lo intenta otra vez— el servidor devuelve el pedido que ya
 * existe en vez de crear otro y apartar el inventario dos veces. Por eso se
 * GUARDA, amarrada a la huella del carrito: en cuanto el carrito cambia, el
 * pedido es otro y la llave también.
 */

/** Una línea del pedido: lo mismo que guarda el carrito. */
export interface LineaDePedido {
  readonly codigo: string;
  readonly cantidad: number;
}

/** Lo que la clienta escribe en el formulario. */
export interface DatosDeLaClienta {
  readonly nombre: string;
  readonly celular: string;
  /** El NOMBRE de la zona del tarifario. Vacío = no eligió ninguna. */
  readonly zona: string;
  readonly notas: string;
}

export const DATOS_EN_BLANCO: DatosDeLaClienta = {
  nombre: '',
  celular: '',
  zona: '',
  notas: '',
};

/**
 * El cuerpo exacto de `POST /api/pago/yappy/iniciar`.
 *
 * Es el contrato del servidor y no se cambia desde aquí. Fíjese en lo que NO
 * está: ningún precio, ningún total, ningún envío.
 */
export interface CuerpoDeInicio {
  readonly nombre: string;
  readonly celular: string;
  readonly zona?: string;
  readonly notas?: string;
  readonly lineas: readonly LineaDePedido[];
  readonly idempotencia: string;
}

/** El pedido que el servidor creó, con SUS cifras. */
export interface PedidoDelServidor {
  readonly numero: string;
  readonly token: string;
  readonly totalCents: number;
  readonly envioCents: number;
}

/** Los tres valores que hay que pasarle al botón de Yappy. */
export interface DatosDelBoton {
  readonly transactionId: string;
  readonly token: string;
  readonly documentName: string;
}

export interface InicioAceptado {
  readonly pedido: PedidoDelServidor;
  readonly boton: DatosDelBoton;
}

/**
 * La respuesta, ya clasificada.
 *
 * `rechazado` es un «no» del servidor y trae SU mensaje. `sin_respuesta` es
 * que no contestó nadie —sin red, el Worker caído, la petición cortada— y es
 * el único caso cuyo texto se escribe aquí, porque no hay ninguno que enseñar.
 */
export type Inicio =
  | { readonly estado: 'listo'; readonly datos: InicioAceptado }
  | { readonly estado: 'rechazado'; readonly codigo: string; readonly mensaje: string }
  | { readonly estado: 'sin_respuesta'; readonly mensaje: string };

export const RUTA_DE_INICIO = '/api/pago/yappy/iniciar';

/**
 * Lo que se dice cuando la petición no llegó a ninguna parte.
 *
 * No dice «error 500» ni «fallo de red»: dice qué hacer. Y no dice nada del
 * pedido, porque no se sabe si se creó — por eso la llave de idempotencia
 * sigue guardada y el siguiente intento recupera el mismo pedido si lo hubo.
 */
export const SIN_RESPUESTA =
  'No pudimos conectarnos para empezar el pago. Revisa tu conexión y vuelve a intentarlo; ' +
  'si ya se había creado tu pedido, no se duplica.';

// ---------------------------------------------------------------------------
// Lo que el navegador SÍ puede comprobar: que el formulario esté completo
// ---------------------------------------------------------------------------

/**
 * Esto NO es la validación de verdad.
 *
 * La de verdad la hace el servidor, que es el único que puede. Esto existe
 * para no gastar un viaje —y un pedido a medias— en un campo vacío o en un
 * celular de cinco números. Si alguna vez las dos discrepan, manda el
 * servidor: su `mensaje` se enseña tal cual.
 */
export interface Problemas {
  readonly nombre?: string;
  readonly celular?: string;
  readonly zona?: string;
}

/** Lo más largo que se acepta en un campo de texto, para no mandar un libro. */
const LARGO_NOMBRE = 80;
const LARGO_NOTAS = 300;

/**
 * El celular, solo con sus números.
 *
 * El contrato dice «con o sin guiones», así que se limpia aquí y el servidor
 * normaliza otra vez: dos limpiezas de lo mismo no estorban, y una pantalla
 * que acepta «6000-0001» y «6000 0001» es una pantalla menos frustrante.
 *
 * El prefijo del país se quita si viene: `+507 6000-0001` es el mismo celular
 * que `60000001`, y rechazarlo por el prefijo sería rechazar lo que la gente
 * tiene guardado en su propio teléfono.
 */
export function soloNumeros(texto: string): string {
  const digitos = texto.replace(/\D+/g, '');
  return digitos.length === 11 && digitos.startsWith('507') ? digitos.slice(3) : digitos;
}

/**
 * Cuántos números tiene un celular panameño.
 *
 * No es una cifra del negocio: es el largo del ejemplo del propio contrato
 * («6000-0001»). Y el servidor lo vuelve a comprobar, así que equivocarse aquí
 * no deja pasar nada — solo molesta antes de tiempo.
 */
const NUMEROS_DEL_CELULAR = 8;

export function revisarDatos(
  datos: DatosDeLaClienta,
  opciones: { readonly zonaObligatoria: boolean },
): Problemas {
  const problemas: { nombre?: string; celular?: string; zona?: string } = {};

  const nombre = datos.nombre.trim();
  if (nombre.length < 2) {
    problemas.nombre = 'Escribe tu nombre para que sepamos a quién entregarle.';
  } else if (nombre.length > LARGO_NOMBRE) {
    problemas.nombre = 'Ese nombre es demasiado largo; déjanos solo el nombre y el apellido.';
  }

  const celular = soloNumeros(datos.celular);
  if (celular === '') {
    problemas.celular = 'Escribe tu celular: es por donde te confirmamos la entrega.';
  } else if (celular.length !== NUMEROS_DEL_CELULAR) {
    problemas.celular = `El celular lleva ${NUMEROS_DEL_CELULAR} números, como 6000-0001.`;
  }

  if (opciones.zonaObligatoria && datos.zona.trim() === '') {
    problemas.zona = 'Elige tu zona de envío para que podamos cotizar la entrega.';
  }

  return problemas;
}

export const hayProblemas = (p: Problemas): boolean => Object.keys(p).length > 0;

/** El primer campo con problema, para llevarle el foco. */
export function primerProblema(p: Problemas): keyof Problemas | null {
  for (const campo of ['nombre', 'celular', 'zona'] as const) {
    if (p[campo] !== undefined) return campo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// La llave de idempotencia
// ---------------------------------------------------------------------------

/**
 * La huella del carrito: qué códigos y cuántos, sin importar el orden.
 *
 * Sin ordenar, mover una línea de sitio cambiaría la huella y la clienta
 * tendría una llave nueva para el mismo pedido — o sea, dos pedidos.
 */
export function huellaDelCarrito(lineas: readonly LineaDePedido[]): string {
  return lineas
    .map((l) => `${l.codigo}x${l.cantidad}`)
    .sort()
    .join('|');
}

/** El mínimo que pide el contrato son 8 caracteres; esto da 36 o 32. */
export function llaveNueva(): string {
  try {
    const c = globalThis.crypto;
    if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c !== undefined && typeof c.getRandomValues === 'function') {
      const bytes = c.getRandomValues(new Uint8Array(16));
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // `crypto` existe en todo navegador que nos interesa, pero no en un
    // contexto no seguro ni en una prueba de Node vieja. Caer aquí es mejor
    // que reventar en el único momento en que la clienta quiere pagar.
  }
  // Sin `crypto` la llave es más débil, y da igual para lo que sirve: no es un
  // secreto, es una etiqueta que tiene que repetirse para el mismo carrito y
  // no chocar con la de otra persona.
  return `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const CLAVE_GUARDADA = 'bc.pago.llave.v1';

/** Lo guardado: la huella del carrito y la llave que le toca. */
interface Guardado {
  readonly huella: string;
  readonly llave: string;
}

function leerGuardado(): Guardado | null {
  try {
    const crudo = window.localStorage.getItem(CLAVE_GUARDADA);
    if (crudo === null) return null;
    const leido: unknown = JSON.parse(crudo);
    if (leido === null || typeof leido !== 'object') return null;
    const { huella, llave } = leido as { huella?: unknown; llave?: unknown };
    if (typeof huella !== 'string' || typeof llave !== 'string') return null;
    if (llave.length < 8) return null;
    return { huella, llave };
  } catch {
    // `localStorage` LANZA —no devuelve vacío— en ventana privada de Safari y
    // con las cookies de sitio bloqueadas. Sin llave guardada se genera una
    // nueva: se pierde la protección contra el doble toque, no la venta.
    return null;
  }
}

/**
 * La llave para ESTE carrito: la guardada si sigue siendo el mismo, o una
 * nueva.
 *
 * Se llama en cada intento de pago, no una vez al montar la pantalla: entre
 * montar y pagar la clienta puede abrir otra pestaña y cambiar el carrito.
 */
export function llaveDelCarrito(lineas: readonly LineaDePedido[]): string {
  const huella = huellaDelCarrito(lineas);
  const guardado = leerGuardado();
  if (guardado !== null && guardado.huella === huella) return guardado.llave;

  const llave = llaveNueva();
  try {
    window.localStorage.setItem(CLAVE_GUARDADA, JSON.stringify({ huella, llave }));
  } catch {
    /* ídem: sin sitio o sin permiso, la llave vale solo para este intento */
  }
  return llave;
}

/** Se olvida cuando el pedido ya está creado y la clienta empieza otro. */
export function olvidarLlave(): void {
  try {
    window.localStorage.removeItem(CLAVE_GUARDADA);
  } catch {
    /* ídem */
  }
}

// ---------------------------------------------------------------------------
// La llamada
// ---------------------------------------------------------------------------

/** `true` si la respuesta tiene la forma que el contrato promete. */
function esInicioAceptado(d: unknown): d is InicioAceptado {
  if (d === null || typeof d !== 'object') return false;
  const { pedido, boton } = d as { pedido?: unknown; boton?: unknown };
  if (pedido === null || typeof pedido !== 'object') return false;
  if (boton === null || typeof boton !== 'object') return false;
  const p = pedido as Record<string, unknown>;
  const b = boton as Record<string, unknown>;
  return (
    typeof p.numero === 'string' &&
    typeof p.token === 'string' &&
    typeof p.totalCents === 'number' &&
    typeof p.envioCents === 'number' &&
    typeof b.transactionId === 'string' &&
    typeof b.token === 'string' &&
    typeof b.documentName === 'string'
  );
}

/**
 * Empieza el cobro: crea el pedido en el servidor y trae los tres valores del
 * botón.
 *
 * `fetch` se puede inyectar para probarlo sin navegador. No hay más razón: en
 * producción es el del navegador.
 */
export async function iniciarPagoConYappy(
  cuerpo: CuerpoDeInicio,
  pedir: typeof fetch = fetch,
): Promise<Inicio> {
  let respuesta: Response;
  try {
    respuesta = await pedir(RUTA_DE_INICIO, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      // Un pedido no se cachea nunca, y menos uno que aparta inventario.
      cache: 'no-store',
    });
  } catch {
    return { estado: 'sin_respuesta', mensaje: SIN_RESPUESTA };
  }

  let leido: unknown;
  try {
    leido = await respuesta.json();
  } catch {
    // Un 502 de Cloudflare llega como HTML. No es un «no» del servidor: es
    // que no contestó el servidor.
    return { estado: 'sin_respuesta', mensaje: SIN_RESPUESTA };
  }

  const sobre = (leido ?? {}) as { ok?: unknown; datos?: unknown; codigo?: unknown; mensaje?: unknown };

  // El «no» del servidor manda, sea cual sea el código HTTP: el contrato dice
  // `ok: false` y trae el mensaje redactado. Se enseña TAL CUAL.
  if (sobre.ok === false) {
    return {
      estado: 'rechazado',
      codigo: typeof sobre.codigo === 'string' ? sobre.codigo : 'sin_codigo',
      mensaje:
        typeof sobre.mensaje === 'string' && sobre.mensaje.trim() !== ''
          ? sobre.mensaje
          : SIN_RESPUESTA,
    };
  }

  if (sobre.ok === true && esInicioAceptado(sobre.datos)) {
    return { estado: 'listo', datos: sobre.datos };
  }

  // Contestó algo que no es ninguna de las dos formas del contrato. Se trata
  // como «no contestó»: inventarle un significado sería adivinar (trampa §2).
  return { estado: 'sin_respuesta', mensaje: SIN_RESPUESTA };
}

/** El cuerpo, armado. La `zona` y las `notas` solo van si hay algo que mandar. */
export function cuerpoDeInicio(
  datos: DatosDeLaClienta,
  lineas: readonly LineaDePedido[],
  idempotencia: string,
): CuerpoDeInicio {
  const zona = datos.zona.trim();
  const notas = datos.notas.trim().slice(0, LARGO_NOTAS);
  return {
    nombre: datos.nombre.trim(),
    celular: soloNumeros(datos.celular),
    ...(zona === '' ? {} : { zona }),
    ...(notas === '' ? {} : { notas }),
    lineas: lineas.map((l) => ({ codigo: l.codigo, cantidad: l.cantidad })),
    idempotencia,
  };
}

// ---------------------------------------------------------------------------
// Lo que dice Yappy cuando el pago NO salió
// ---------------------------------------------------------------------------

/**
 * Los códigos de `eventError`, con palabras.
 *
 * Están leídos del propio componente (el enum de estados del paquete de
 * Yappy), no supuestos: `EXPIRED`, `FAILED`, `DENIED`,
 * `DUPLICATED_TRANSACTION` y `CANCELLED` son los cinco que el componente
 * emite por `eventError`.
 *
 * Ninguno de estos textos dice que el pedido se perdió: el pedido existe en el
 * servidor y la dueña lo ve. Lo que no salió es el cobro.
 */
export const PORQUE_NO_SALIO: Record<string, string> = {
  EXPIRED: 'Se venció el tiempo para pagar en Yappy. Puedes volver a intentarlo.',
  FAILED: 'Yappy no pudo completar el pago. Vuelve a intentarlo en un momento.',
  DENIED: 'Yappy no autorizó el pago. Revisa tu app de Yappy y vuelve a intentarlo.',
  DUPLICATED_TRANSACTION:
    'Yappy vio este pago como repetido. No lo intentes de nuevo todavía: escríbenos y lo revisamos contigo.',
  CANCELLED: 'Cancelaste el pago en Yappy. Tu pedido sigue aquí si quieres intentarlo otra vez.',
};

/**
 * Qué se le dice a la clienta cuando `eventError` trae algo que no está en la
 * lista.
 *
 * Hace falta porque el componente emite por `eventError` también el ERROR de
 * la petición con que comprueba si Yappy está en línea, y eso no es ninguno de
 * los cinco códigos. Y porque mañana pueden añadir otro: un `undefined` en
 * pantalla es peor que una frase honesta.
 */
export const NO_SALIO_SIN_CODIGO =
  'El pago no se completó. Tu pedido sigue aquí; vuelve a intentarlo o escríbenos.';

export const porqueNoSalio = (codigo: unknown): string =>
  typeof codigo === 'string' && PORQUE_NO_SALIO[codigo] !== undefined
    ? PORQUE_NO_SALIO[codigo]
    : NO_SALIO_SIN_CODIGO;

// ---------------------------------------------------------------------------
// La página de resultado
// ---------------------------------------------------------------------------

/**
 * **LO QUE SE DICE DESPUÉS DE `eventSuccess`, Y POR QUÉ NO DICE «PAGADO».**
 *
 * `eventSuccess` NO significa que el pedido esté pagado. En el código del
 * componente de Yappy ese evento se emite para tres estados internos
 * (`COMPLETED`, `C` y `EXECUTED`) y hay estados —`REJECTED` entre ellos— que
 * no disparan ni éxito ni error: la pantalla se queda sin noticias.
 *
 * Quien marca un pedido como pagado es el aviso firmado que Yappy manda al
 * servidor por detrás (`/api/pago/yappy`, que el Worker enruta y el sistema
 * verifica). Esta pantalla no lo sabe y no puede saberlo.
 *
 * Si alguien cambia este texto por «¡Pagado!» o «Tu pedido está confirmado»,
 * un día alguien va a recibir mercancía sin haber pagado. Hay una prueba que
 * lee este archivo y se pone roja si aparece esa clase de frase
 * (`test/el-navegador-no-decide-un-pago.test.ts`).
 */
export const ESTAMOS_CONFIRMANDO = 'Estamos confirmando tu pago';

/** A dónde se manda a la clienta cuando Yappy avisa de que terminó. */
export const rutaDelResultado = (numeroDePedido: string): string =>
  `/pago/resultado/${encodeURIComponent(numeroDePedido)}`;

/**
 * Qué forma tiene un número de pedido que llega POR LA URL.
 *
 * Llega de la barra de direcciones, así que es entrada no confiable: se
 * comprueba la forma antes de pintarlo. No se comprueba que exista —esta
 * pantalla no consulta nada y no puede—, solo que no sea basura.
 */
export const esNumeroDePedido = (texto: string): boolean => /^[A-Za-z0-9._-]{1,40}$/.test(texto);
