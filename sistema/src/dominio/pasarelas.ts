import { fallo, ok, type Resultado } from "../contrato/resultado";

/**
 * El catálogo de pasarelas de cobro: qué hay, qué pide cada una y qué se
 * acepta como valor.
 *
 * ## Por qué existe este archivo
 *
 * El dueño lo pidió así: «necesitamos poder poner los conectores o pasarelas
 * de pago en el panel administrativo, poder integrarlos así como en Odoo». En
 * Odoo un conector no es una pantalla escrita a mano: es una ficha que declara
 * qué credenciales pide, y el formulario se dibuja de esa ficha. Eso es esto.
 *
 * La consecuencia práctica: **la pantalla no sabe nada de Yappy**. Pregunta al
 * catálogo qué campos tiene Yappy y los pinta. El día que Tilopay confirme sus
 * credenciales se escriben aquí y la pantalla se llena sola, sin tocar ni un
 * `.tsx`. Tres formularios escritos a mano serían tres sitios donde el nombre
 * de una credencial puede discrepar del que busca el adaptador — y ese error no
 * se ve hasta que falla un cobro.
 *
 * ## Puro: ni D1, ni red, ni `env`
 *
 * Lo carga también el panel (el teléfono), así que no arrastra nada del Worker.
 * Lo que toca la base está en `src/db/pasarelas.ts`; lo que cifra, en
 * `src/seguridad/cifrado.ts`.
 *
 * ## Aquí NO hay cifras del negocio
 *
 * Ni comisiones, ni montos, ni plazos. Las comisiones viven en
 * `ajustes.comisiones` y las pone la dueña (`src/dominio/ajustes.ts`). Lo único
 * numérico de este archivo son los largos mínimo y máximo de una credencial, y
 * son barandas contra el dedo gordo, no decisiones de nadie.
 *
 * ## Qué está encendido NO se guarda aquí
 *
 * Vive en `ajustes.pasarelas_activas`, que ya existe y ya tiene historial,
 * pantalla y validación. Una segunda columna «activa» en una tabla mía sería un
 * segundo dueño del mismo dato, y el día que discreparan el checkout haría caso
 * a uno y el panel enseñaría el otro.
 */

// ---------------------------------------------------------------------------
// Las tres pasarelas y los dos modos
// ---------------------------------------------------------------------------

/**
 * Las pasarelas que cobran por API.
 *
 * Son las tres de docs/plan/04-pagos.md §2 y las mismas de
 * `PASARELAS_CON_COMISION` en `src/dominio/ajustes.ts` y de
 * `IniciarPagoEntrada.proveedor` en `src/contrato/esquemas.ts`. Se escriben
 * aquí a mano en vez de importarlas para no acoplar dos módulos del dominio por
 * una lista de tres palabras; hay una prueba en `pasarelas.test.ts` que falla si
 * las listas se separan.
 *
 * `manual` no está, y no es un olvido: el pago con comprobante no tiene
 * credenciales que configurar, no se enciende ni se apaga —«siempre está
 * disponible» (04-pagos §1.7)— y su flujo ya vive en `src/db/pagos.ts`.
 */
export const PASARELAS = ["yappy", "tilopay", "paypal"] as const;

export type Pasarela = (typeof PASARELAS)[number];

export const esPasarela = (v: unknown): v is Pasarela =>
  typeof v === "string" && (PASARELAS as readonly string[]).includes(v);

/**
 * Prueba y real son DOS JUEGOS DE CREDENCIALES, no un interruptor de estilo.
 *
 * Es la distinción más cara de esta pieza. Un cobro real hecho con credenciales
 * de prueba deja a la clienta con un pedido agendado que nadie pagó; al revés,
 * se le cobra de verdad en un ensayo. Por eso el modo es parte de la IDENTIDAD
 * de cada credencial —`(pasarela, modo, credencial)` es la llave en D1— y no
 * un campo al lado: no hay forma de leer la credencial de prueba estando en
 * real, porque son filas distintas y además el cifrado está atado al modo
 * (`contextoDeCifrado`).
 *
 * Una pasarela nace en `prueba`, que es el modo que no cobra. Pasar a `real`
 * es un acto aparte y explícito de la dueña.
 */
export const MODOS = ["prueba", "real"] as const;

export type Modo = (typeof MODOS)[number];

export const esModo = (v: unknown): v is Modo =>
  typeof v === "string" && (MODOS as readonly string[]).includes(v);

export const ETIQUETAS_MODO: Record<Modo, string> = {
  prueba: "Modo de prueba",
  real: "Modo real: cobra de verdad",
};

/** El otro modo. Lo usa la pantalla para decir qué hay guardado al otro lado. */
export const elOtroModo = (modo: Modo): Modo => (modo === "prueba" ? "real" : "prueba");

// ---------------------------------------------------------------------------
// Qué pide cada pasarela
// ---------------------------------------------------------------------------

/**
 * Qué se teclea.
 *
 * Hoy todas las credenciales son una línea sin espacios: un identificador o una
 * clave. El tipo existe de todas formas porque el día que una pasarela pida un
 * certificado de varias líneas, la pantalla tiene que poder enterarse por el
 * catálogo en vez de adivinarlo por el nombre del campo.
 */
export type Forma = "linea";

export interface Credencial {
  /** Minúsculas con guion bajo. Es la llave en D1 y la que buscará el adaptador. */
  readonly nombre: string;
  /** Cómo se llama en el portal de la pasarela. Es lo que la dueña va a buscar. */
  readonly titulo: string;
  /** De dónde se saca. Se lee en la pantalla, debajo del campo. */
  readonly explica: string;
  /** Si sin ella la pasarela no se puede encender. */
  readonly obligatoria: boolean;
  readonly forma: Forma;
}

export interface Conector {
  readonly pasarela: Pasarela;
  readonly titulo: string;
  readonly explica: string;
  /**
   * Por qué todavía no se puede configurar, o `null` si sí se puede.
   *
   * No es un «no implementado»: es que el documento que manda (04-pagos) no
   * dice qué credenciales pide esa pasarela, y bautizarlas a ojo tiene un costo
   * concreto — la dueña pega su clave en un campo llamado `api_key`, el
   * adaptador la busca mañana como `llave_api` y no la encuentra, o peor, la
   * encuentra a medias. El propio documento lo dice: «No se escribe código con
   * nombres adivinados» (§4.1).
   */
  readonly porConfirmar: string | null;
  readonly credenciales: readonly Credencial[];
  /** Dónde está escrito lo de arriba. Para no tener que creerme. */
  readonly fuente: string;
}

/**
 * El catálogo.
 *
 * Cada credencial de aquí está NOMBRADA en docs/plan/04-pagos.md. Lo que el
 * documento no nombra no se inventa: queda `porConfirmar` y la pantalla dice
 * qué falta y quién lo confirma, igual que un ajuste en `"PENDIENTE"` dice que
 * falta decidirlo en vez de arrancar con un número de relleno.
 */
export const CONECTORES: Record<Pasarela, Conector> = {
  yappy: {
    pasarela: "yappy",
    titulo: "Yappy · Botón de Pago",
    explica:
      "El más usado en Panamá y el único con el que se puede abonar. La cuenta de Yappy Comercial ya existe a nombre del negocio.",
    porConfirmar: null,
    credenciales: [
      {
        nombre: "id_comercio",
        titulo: "ID de comercio",
        explica:
          "Lo genera un usuario administrador en Yappy Comercial, en Productos › Botón de Pago. No es el de la «Integración Core», que solo sirve para leer movimientos.",
        obligatoria: true,
        forma: "linea",
      },
      {
        nombre: "clave_secreta",
        titulo: "Clave secreta",
        explica:
          "Se genera en la misma pantalla de Yappy Comercial, junto al ID de comercio. Con ella el sistema comprueba que el aviso de pago viene de Yappy y no de otro.",
        obligatoria: true,
        forma: "linea",
      },
    ],
    fuente: "docs/plan/04-pagos.md §4.1",
  },

  tilopay: {
    pasarela: "tilopay",
    titulo: "Tilopay · tarjetas y cuotas",
    explica:
      "Tarjeta de crédito o débito y las cuotas de BAC. Solo para el pago total: su cargo fijo se come casi todo un abono pequeño.",
    // Estaba bloqueada porque el plan no nombraba sus credenciales y bautizarlas
    // a ojo tiene un costo concreto. Ya no hace falta adivinar: su documentación
    // para desarrolladores las nombra, y los tres nombres de aquí son LOS DE SU
    // API, letra por letra. Es a propósito: el adaptador los manda tal cual en
    // el cuerpo de la petición, así que no hay capa de traducción donde
    // equivocarse. Es el mismo criterio que con PayPal.
    //
    // Siguen siendo tres y no dos: `apiuser` y `password` sacan el token de
    // `POST /api/v1/login`, y `key` es ADEMÁS un parámetro obligatorio de
    // `processPayment` y de `consult`. Con dos de las tres no se cobra.
    //
    // El `OrderHash` sigue sin ser público —se pide por un caso a su soporte—
    // pero no bloquea, y nunca bloqueó: el plan ya decidió que la verdad es la
    // consulta al servidor (04-pagos §4.2), no el hash que vuelve en la URL.
    porConfirmar: null,
    credenciales: [
      {
        nombre: "apiuser",
        titulo: "Usuario de API",
        explica:
          "Está en el panel de Tilopay, en Integraciones de plataforma (admin.tilopay.com). Con él y la contraseña el servidor pide el token que le deja cobrar. NO es el correo con el que la dueña entra al panel.",
        obligatoria: true,
        forma: "linea",
      },
      {
        nombre: "password",
        titulo: "Contraseña de API",
        explica:
          "La de la misma pantalla, al lado del usuario de API. Tampoco es la contraseña con la que la dueña entra al panel. Nunca sale del servidor: Tilopay avisa de que no debe llegar al navegador.",
        obligatoria: true,
        forma: "linea",
      },
      {
        nombre: "key",
        titulo: "Llave de integración",
        explica:
          "La tercera de esa misma pantalla. Viaja en cada cobro y en cada consulta, así que sin ella no se cobra aunque las otras dos estén puestas.",
        obligatoria: true,
        forma: "linea",
      },
    ],
    fuente:
      "tilopay.com/en/developers/api/autenticacion y .../hosted-payment-page/process-payment (su documentación, verificada por ellos el 2026-10-20); docs/plan/04-pagos.md §4.2",
  },

  paypal: {
    pasarela: "paypal",
    titulo: "PayPal",
    explica:
      "La comisión más alta de las tres; sirve para quien paga desde fuera de Panamá. Solo para el pago total.",
    porConfirmar: null,
    credenciales: [
      {
        nombre: "client_id",
        titulo: "Client ID de la app REST",
        explica:
          "Se crea una app REST en la cuenta PayPal Business del negocio. Ojo: la app de la caja de arena (sandbox) y la de producción tienen credenciales distintas — van en el modo que les toca.",
        obligatoria: true,
        forma: "linea",
      },
      {
        nombre: "client_secret",
        titulo: "Secret de la app REST",
        explica:
          "Está al lado del Client ID, detrás de «Show». Con los dos el sistema pide el token que le deja crear y capturar órdenes.",
        obligatoria: true,
        forma: "linea",
      },
      {
        nombre: "webhook_id",
        titulo: "ID del webhook",
        explica:
          "El identificador del webhook que se registra en la misma app. Es obligatorio: sin él no se puede comprobar la firma de un aviso de PayPal, y un reembolso o una disputa entrarían sin verificar — que es justo lo que la regla 3 del plan prohíbe.",
        obligatoria: true,
        forma: "linea",
      },
    ],
    fuente: "docs/plan/04-pagos.md §4.3",
  },
};

export const conectorDe = (pasarela: Pasarela): Conector => CONECTORES[pasarela];

/** En el orden del catálogo, que es el de la pantalla. */
export const CONECTORES_EN_ORDEN: readonly Conector[] = PASARELAS.map((p) => CONECTORES[p]);

export function credencialDe(pasarela: Pasarela, nombre: string): Credencial | undefined {
  return CONECTORES[pasarela].credenciales.find((c) => c.nombre === nombre);
}

// ---------------------------------------------------------------------------
// Qué se acepta como valor
// ---------------------------------------------------------------------------

/**
 * Barandas de largo, NO decisiones de nadie.
 *
 * Tres caracteres no son una clave de cobro, son un dedo que resbaló; y
 * quinientos doce bytes son más de lo que mide cualquier credencial de estas
 * tres pasarelas, así que pasado ahí lo que se pegó es otra cosa (media página,
 * un certificado, el portapapeles equivocado). El mínimo está así de bajo a
 * propósito: un mínimo apretado rechazaría una credencial corta de verdad, y
 * eso es el error caro — la dueña con la clave correcta en la mano y el sistema
 * diciéndole que no.
 */
export const LARGO_MINIMO_CREDENCIAL = 4;
export const LARGO_MAXIMO_CREDENCIAL = 512;

/** Visible ASCII: de `!` a `~`. Sin espacios, sin acentos, sin control. */
const UNA_LINEA = /^[\x21-\x7E]+$/;

/**
 * Comprueba una credencial y la devuelve limpia.
 *
 * **Ningún mensaje de error repite el valor.** Ni entero, ni recortado, ni los
 * últimos cuatro caracteres. Un mensaje de error viaja por el cable, se pinta
 * en la pantalla, se copia en una captura de WhatsApp y a veces acaba en un
 * registro: es una de las maneras más fáciles de que una clave de cobro salga
 * de donde debe estar. Lo que se dice es QUÉ está mal, no qué se escribió.
 *
 * Limpia significa solo quitar lo de los bordes. Pegar una clave desde un
 * correo o un PDF arrastra un salto de línea o un espacio final casi siempre, y
 * eso rompería el cobro con un error de la pasarela que no explica nada. Lo que
 * NO se hace es tocar el interior: una clave no se «corrige».
 */
export function validarCredencial(
  pasarela: unknown,
  nombre: unknown,
  valor: unknown,
): Resultado<string> {
  if (!esPasarela(pasarela)) {
    return fallo(
      "entrada_invalida",
      `«${String(nombre)}» no pertenece a ninguna pasarela de este sistema. Las que hay son: ${PASARELAS.join(", ")}.`,
    );
  }

  const conector = CONECTORES[pasarela];
  if (conector.porConfirmar !== null) {
    return fallo(
      "entrada_invalida",
      `${conector.titulo} todavía no se puede configurar. ${conector.porConfirmar}`,
    );
  }

  if (typeof nombre !== "string") {
    return fallo("entrada_invalida", "No se dijo qué credenciales se está poniendo.");
  }
  const credencial = credencialDe(pasarela, nombre);
  if (credencial === undefined) {
    return fallo(
      "entrada_invalida",
      `${conector.titulo} no pide ninguna credencial que se llame «${nombre}». Pide: ${conector.credenciales.map((c) => c.titulo).join(", ")}.`,
    );
  }

  if (typeof valor !== "string") {
    return fallo("entrada_invalida", `«${credencial.titulo}» se escribe como texto.`);
  }

  const limpio = valor.trim();
  if (limpio === "") {
    return fallo(
      "entrada_invalida",
      `«${credencial.titulo}» llegó vacío. Si todavía no la tiene, deje el campo sin tocar: el sistema dirá que falta, que no es lo mismo que decir que está puesta.`,
    );
  }
  if (limpio.length < LARGO_MINIMO_CREDENCIAL) {
    return fallo(
      "entrada_invalida",
      `«${credencial.titulo}» tiene muy pocos caracteres para ser una credencial. Revise que se pegó completa.`,
    );
  }
  if (limpio.length > LARGO_MAXIMO_CREDENCIAL) {
    return fallo(
      "entrada_invalida",
      `«${credencial.titulo}» tiene más de ${LARGO_MAXIMO_CREDENCIAL} caracteres: eso ya no es una credencial de ${conector.titulo}. Revise que no se pegó de más.`,
    );
  }
  if (!UNA_LINEA.test(limpio)) {
    return fallo(
      "entrada_invalida",
      `«${credencial.titulo}» trae espacios, saltos de línea o acentos por dentro. Péguela de una sola línea, tal como aparece en el portal, y sin nada más alrededor.`,
    );
  }

  return ok(limpio);
}

// ---------------------------------------------------------------------------
// Qué falta para poder encenderla
// ---------------------------------------------------------------------------

/**
 * Las credenciales obligatorias que faltan.
 *
 * Devuelve las fichas enteras y no sus nombres técnicos porque quien lo lee es
 * la pantalla, y lo que tiene que escribir es «falta la Clave secreta», no
 * «falta clave_secreta». Decir «configuración incompleta» a secas deja a la
 * dueña abriendo campos uno por uno a ver cuál es.
 */
export function queFalta(
  pasarela: Pasarela,
  puestas: readonly string[],
): readonly Credencial[] {
  return CONECTORES[pasarela].credenciales.filter(
    (c) => c.obligatoria && !puestas.includes(c.nombre),
  );
}

export type Encendible =
  | { readonly puede: true }
  | { readonly puede: false; readonly motivo: string; readonly faltan: readonly Credencial[] };

/**
 * ¿Se puede encender esta pasarela con lo que hay puesto?
 *
 * Es una regla pura a propósito: la misma respuesta la necesita la pantalla
 * —para no ofrecer un botón que va a fallar— y el servidor —para que no se
 * encienda nada aunque alguien llame a la ruta a mano. Dos copias de esta
 * decisión acabarían discrepando, y la que se equivoca del lado flojo es la
 * que nadie revisa.
 *
 * Lo que esto NO dice es si la pasarela funciona. Eso solo lo dice un cobro
 * real de prueba y su reembolso (04-pagos §10), y eso lo hace una persona.
 */
export function puedeEncenderse(pasarela: Pasarela, puestas: readonly string[]): Encendible {
  const conector = CONECTORES[pasarela];
  if (conector.porConfirmar !== null) {
    return { puede: false, motivo: conector.porConfirmar, faltan: [] };
  }

  const faltan = queFalta(pasarela, puestas);
  if (faltan.length > 0) {
    return {
      puede: false,
      motivo: `Para encender ${conector.titulo} falta ${faltan.map((c) => `«${c.titulo}»`).join(" y ")}.`,
      faltan,
    };
  }
  return { puede: true };
}

// ---------------------------------------------------------------------------
// El contexto del cifrado
// ---------------------------------------------------------------------------

/**
 * La etiqueta con la que se ata cada secreto a su sitio.
 *
 * Va como «datos autenticados adicionales» de AES-GCM: no se cifra, pero el
 * descifrado falla si no es exactamente la misma. El efecto es el que importa:
 * **un secreto cifrado para el modo de prueba no se puede descifrar como si
 * fuera el del modo real**, ni el de Yappy como si fuera el de PayPal. Alguien
 * que copie el texto cifrado de una fila a otra —con un UPDATE a mano en la
 * consola de D1, por ejemplo— no consigue que se use: consigue que falle.
 *
 * Eso convierte la regla «prueba y real son dos juegos distintos» en algo que
 * el criptograma hace cumplir, no en una condición de un `WHERE` que alguien
 * puede olvidar mañana.
 *
 * Vive en el dominio para que cifrar y descifrar la calculen con la MISMA
 * función. Dos formas de escribir esta cadena serían dos credenciales que no se
 * pueden volver a leer.
 */
export function contextoDeCifrado(pasarela: Pasarela, modo: Modo, credencial: string): string {
  return `babycaleb/pasarela/${pasarela}/${modo}/${credencial}`;
}
