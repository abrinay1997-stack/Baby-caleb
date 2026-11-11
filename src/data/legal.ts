/**
 * Las páginas legales: privacidad y términos.
 *
 * ## Por qué el texto vive aquí y no dentro de la página
 *
 * Es texto largo que cambia por motivos que no tienen nada que ver con el
 * diseño: lo cambia la dueña cuando confirma un dato, o un abogado cuando lo
 * revisa. Separarlo deja que esa gente lea y corrija un archivo de frases, sin
 * tocar JSX, y deja que las pruebas lo vigilen (`test/legal.test.ts`).
 *
 * ## LA REGLA DE ESTE ARCHIVO: nada que no esté comprobado
 *
 * Esto es un texto legal sobre datos de personas reales. Cada afirmación de
 * aquí sale del CÓDIGO que corre hoy o de un documento del plan, y lleva su
 * cita en un comentario. Lo que no se pudo comprobar NO se rellena con algo
 * plausible: se queda como un bloque `pendiente` visible en la página, con el
 * nombre de quién tiene que darlo. Un correo inventado en una política de
 * privacidad es peor que un hueco — el hueco se ve y se arregla.
 *
 * Tampoco va aquí ningún precio: el precio vive en la D1 del sistema y nada
 * más (regla del `CLAUDE.md` del repositorio). Hay una prueba que lo vigila.
 *
 * ## Lo que este archivo NO es
 *
 * No lo escribió un abogado. Mientras `revisadoPorAbogado` sea `false`, las
 * dos páginas enseñan arriba un aviso que lo dice, y la prueba exige que ese
 * aviso exista. Quitarlo es una decisión de la dueña, no una limpieza.
 */

// Los datos de contacto NO se escriben a mano aquí: salen de `content.json`,
// que es donde viven el WhatsApp, el correo y el horario del negocio
// (`content.json` → `social`, `nap`). Repetirlos sería tener dos dueños del
// mismo dato, y el día que cambie el número uno de los dos miente.
import content from "../../content.json";

export interface BloqueTexto {
  readonly tipo: "p";
  readonly texto: string;
}

export interface BloqueLista {
  readonly tipo: "lista";
  readonly puntos: readonly string[];
}

/**
 * Un hueco: un dato que la ley pide y que todavía no existe.
 *
 * `que` es qué falta, en palabras de alguien que no programa. `quien` es quién
 * lo tiene que dar — la dueña, un abogado, un contrato con un proveedor—.
 * Nunca se deja vacío: un pendiente sin dueño no lo llena nadie.
 */
export interface BloquePendiente {
  readonly tipo: "pendiente";
  readonly que: string;
  readonly quien: string;
}

/** Una aclaración al margen: contexto honesto, no obligación legal. */
export interface BloqueNota {
  readonly tipo: "nota";
  readonly texto: string;
}

export type Bloque = BloqueTexto | BloqueLista | BloquePendiente | BloqueNota;

export interface SeccionLegal {
  /** El ancla de la sección. Es lo que usa el índice, así que no se cambia a la ligera. */
  readonly id: string;
  readonly titulo: string;
  readonly bloques: readonly Bloque[];
}

export interface DocumentoLegal {
  readonly ruta: string;
  readonly titulo: string;
  readonly entradilla: string;
  /** Fecha de la última edición del texto, en ISO (AAAA-MM-DD). */
  readonly actualizado: string;
  /** Mientras sea `false`, la página enseña `aviso` arriba de todo. */
  readonly revisadoPorAbogado: boolean;
  readonly aviso: string;
  readonly secciones: readonly SeccionLegal[];
}

const AVISO_BORRADOR =
  "Este texto es un borrador técnico. Lo escribió el equipo que programa la web, " +
  "describiendo lo que la página hace de verdad, y NO lo ha revisado un abogado ni " +
  "lo ha aprobado la dueña del negocio. Los huecos marcados PENDIENTE hay que " +
  "llenarlos antes de publicarlo como documento oficial.";

const CONTACTO = (content as { social: { whatsapp: string; email: string; instagram: string } })
  .social;
const NEGOCIO = (content as { nap: { phone: string; hours: string[] } }).nap;

const POR_WHATSAPP = `WhatsApp ${NEGOCIO.phone}`;
const POR_CORREO = `correo ${CONTACTO.email}`;
const HORARIO = NEGOCIO.hours.join(" · ");

// ---------------------------------------------------------------------------
// PRIVACIDAD
// ---------------------------------------------------------------------------

export const PRIVACIDAD: DocumentoLegal = {
  ruta: "/privacidad",
  titulo: "Política de privacidad",
  entradilla:
    "Qué datos recoge esta página, qué pasa con lo que usted escribe en el chat, " +
    "con quién se comparte y cómo puede pedir que los borremos. Escrito según la Ley 81 " +
    "de 2019 de protección de datos personales de Panamá y su reglamento, el Decreto " +
    "Ejecutivo 285 de 2021.",
  actualizado: "2026-11-11",
  revisadoPorAbogado: false,
  aviso: AVISO_BORRADOR,
  secciones: [
    {
      id: "quien-responde",
      titulo: "1. Quién responde por sus datos",
      bloques: [
        {
          tipo: "p",
          texto:
            "Baby Caleb Panamá es una tienda en línea de pañales, wipes y esenciales de bebé " +
            "que vende por WhatsApp y entrega a domicilio en la Ciudad de Panamá. Esta página " +
            "web es del negocio, y el negocio es el responsable de los datos que aquí se " +
            "recogen.",
        },
        {
          // `content.json` → `legal.company` es «Baby Caleb Panamá» (nombre
          // comercial) y `legal.vat` está VACÍO: el RUC no existe en el
          // repositorio. La razón social tampoco. No se inventan.
          tipo: "pendiente",
          que:
            "La razón social exacta del negocio (el nombre completo con el que está inscrito), " +
            "su RUC y la dirección física o apartado para recibir notificaciones. En la web " +
            "aparece hoy solo el nombre comercial «Baby Caleb Panamá».",
          quien: "La dueña del negocio (sale del registro del negocio y del aviso de operación).",
        },
        {
          tipo: "p",
          texto:
            `Para cualquier cosa de esta política puede escribirnos por ${POR_WHATSAPP} o al ` +
            `${POR_CORREO}. Atendemos ${HORARIO}.`,
        },
        {
          tipo: "pendiente",
          que:
            "Confirmar si ese correo es el canal oficial para pedidos sobre datos personales " +
            "(acceso, corrección, borrado), quién los atiende y en cuántos días se contesta. " +
            "Hoy ese correo es el general del negocio.",
          quien: "La dueña del negocio.",
        },
        {
          tipo: "pendiente",
          que:
            "Si la ley obliga a nombrar un encargado o responsable de protección de datos para " +
            "un negocio de este tamaño, y quién sería.",
          quien: "Un abogado.",
        },
      ],
    },
    {
      id: "que-datos",
      titulo: "2. Qué datos recoge esta página",
      bloques: [
        {
          tipo: "p",
          texto:
            "Esta página no le pide crear una cuenta y no cobra: no hay pasarela de pago ni " +
            "ningún campo donde poner una tarjeta. Tampoco le pedimos su nombre, su cédula ni " +
            "su dirección en un formulario del sitio. Lo único que recoge la página es esto:",
        },
        {
          // Comprobado: src/components/Chatbot.tsx:43-57 (manda `messages` y
          // `sesion` a POST /api/chat; el campo acepta hasta 250 caracteres,
          // línea 166) · src/chat/sesion.ts:19-51 (el identificador de sesión
          // en localStorage, clave `bc-chat-sesion`) · worker/index.ts:61-62 y
          // worker/chat.ts:87-147 (qué hace el servidor con eso).
          tipo: "lista",
          puntos: [
            "Lo que usted escribe en el chat. El texto de sus mensajes, tal como lo escribe, y las respuestas del asistente. Si usted escribe ahí su nombre, su teléfono, su dirección, el peso o la edad de su bebé, eso viaja con el mensaje: el chat no lo pide, pero tampoco lo bloquea.",
            "Un número al azar que identifica la conversación. Se guarda en su propio navegador (no es una cookie) y sirve para que sus mensajes queden agrupados en una sola conversación en vez de abrir una nueva con cada pregunta. No dice quién es usted, no se cruza con ningún dato suyo, y desaparece si usted borra los datos del sitio o entra desde otro teléfono.",
            "Su lista de compras, si usa el carrito de la página. Se guarda también en su propio navegador y lleva solo códigos de producto y cantidades: ni precios, ni su nombre, ni su dirección. No llega a nuestros servidores — de hecho, el pedido se manda por WhatsApp con el texto de la lista, y es ahí donde empieza a existir.",
            "Los datos técnicos de la visita. Como en cualquier página web, el servidor que la sirve procesa su dirección IP, el navegador que usa y la página que pidió, para poder enviarle la página y para seguridad.",
          ],
        },
        {
          tipo: "p",
          texto:
            "Lo demás —su nombre, su número, su dirección de entrega, la forma de pago— se lo " +
            "pedimos por WhatsApp cuando usted decide hacer un pedido, y eso se trata en la " +
            "conversación de WhatsApp, no en esta página.",
        },
        {
          tipo: "nota",
          texto:
            "Cuando esta web tenga carrito y pedidos en línea, recogerá más datos que los de " +
            "arriba. Esta política se actualiza ANTES de que eso se encienda, no después.",
        },
      ],
    },
    {
      id: "inteligencia-artificial",
      titulo: "3. El chat lo atiende una inteligencia artificial",
      bloques: [
        {
          tipo: "p",
          texto:
            "El chat de esta página no lo contesta una persona: lo contesta un modelo de " +
            "inteligencia artificial. Lo decimos aquí porque cambia qué pasa con lo que usted " +
            "escribe.",
        },
        {
          // La declaración que el dueño del proyecto pidió por escrito:
          // «dentro de las políticas de privacidad vamos a poner que
          // utilizamos esta inteligencia por el tema de la protección de
          // datos. Y sí, estamos conscientes que su modelo se entrena con
          // nuestra conversación.»
          //
          // Respaldo en el repositorio: `sistema/reglas.json` →
          // `ia_entrena_con_datos: true`; decisión D-19 y su corrección del
          // 2026-11-09 en `docs/plan/10-riesgos-y-decisiones.md` (el nivel
          // «Contributor» del modelo cuesta menos a cambio de permiso para
          // entrenar con los mensajes y las respuestas); riesgo R16 en el
          // mismo documento.
          tipo: "p",
          texto:
            "Usamos inteligencia artificial a sabiendas, y queremos que usted lo sepa también: " +
            "las conversaciones pueden usarse para entrenar el modelo que las atiende. Lo " +
            "decimos así, en lugar de callarlo, porque es lo que el negocio decidió asumir " +
            "cuando escogió esta tecnología. En la práctica significa que lo que usted escriba " +
            "en el chat no se queda solamente con nosotros.",
        },
        {
          // Cambió el 2026-11-11: el chat de la web pasó de Groq al MISMO
          // proveedor que el asistente interno, con su propia llave. Antes
          // este párrafo decía «el chat usa otro proveedor y su contrato está
          // por confirmar», y decirlo así ya no sería honesto: ahora sí se
          // sabe, y la respuesta es que sí entrena. Respaldo:
          // `ia_entrena_con_datos: true` en `sistema/reglas.json`, decisión
          // D-19 y su corrección del 2026-11-09 en
          // `docs/plan/10-riesgos-y-decisiones.md`, y worker/chat.ts.
          tipo: "p",
          texto:
            "Se escogió a propósito un servicio de inteligencia artificial más barato, que " +
            "cuesta menos justamente a cambio de permiso para entrenar con lo que recibe. Es " +
            "el mismo para el chat de esta página y para el trabajo interno del negocio, así " +
            "que lo dicho arriba vale sin matices: lo que usted escriba en el chat puede " +
            "terminar entrenando un modelo.",
        },
        {
          tipo: "p",
          texto:
            "Por eso le pedimos que NO escriba en el chat datos que no quiera que salgan de " +
            "aquí: su cédula, datos de salud, números de cuenta o tarjeta, ni información de " +
            "otra persona. Para cerrar un pedido o cualquier cosa delicada, escríbanos por " +
            `${POR_WHATSAPP} y le contesta una persona.`,
        },
        {
          // Comprobado: worker/chat.ts manda la conversación a
          // `https://api.meta.ai/v1/messages` con el modelo
          // `muse-spark-1.3-contributor`. Y worker/chat.ts + worker/env.ts:
          // cuando se conecte la bandeja del negocio (el «binding» CRM), el
          // mensaje pasa por ahí y la conversación se guarda para que la dueña
          // la pueda leer, contestar o pausar.
          tipo: "p",
          texto:
            "Hoy el texto de sus mensajes sale hacia la empresa que presta el servicio de " +
            "inteligencia artificial, que está fuera de Panamá, y vuelve con la respuesta. " +
            "Cuando conectemos el chat con la bandeja de atención del negocio, la conversación " +
            "quedará además guardada ahí, para que una persona del equipo pueda leerla, " +
            "contestarle o apagar el bot.",
        },
        {
          tipo: "pendiente",
          que:
            "Dejar por escrito el nombre de la empresa que presta el servicio de inteligencia " +
            "artificial, en qué país procesa los datos, qué dice su contrato sobre entrenar con " +
            "las conversaciones y cuánto tiempo las guarda. Hoy el proveedor que usa el chat de " +
            "la web y el que usa el asistente interno del negocio no son el mismo, y las " +
            "condiciones de cada uno hay que leerlas en su contrato, no suponerlas.",
          quien:
            "El equipo técnico, leyendo el contrato de cada proveedor; y un abogado, para decir " +
            "si hace falta pedirle permiso explícito a la clienta antes de escribir en el chat.",
        },
        {
          tipo: "nota",
          texto:
            "El negocio usa además, por dentro, un asistente de inteligencia artificial para su " +
            "propio trabajo (pedidos, inventario, cuentas). A ese asistente se le manda a " +
            "propósito una referencia —por ejemplo «C-0042»— en vez del nombre, el celular, el " +
            "correo o la dirección de una clienta, justamente porque ese modelo entrena con lo " +
            "que recibe. Es una decisión escrita del proyecto, con pruebas automáticas que la " +
            "vigilan.",
        },
      ],
    },
    {
      id: "para-que",
      titulo: "4. Para qué usamos lo que recogemos",
      bloques: [
        {
          tipo: "lista",
          puntos: [
            "Para contestarle. Sus mensajes se usan para entender su pregunta y responderla, y para pasarle la conversación a una persona cuando hace falta.",
            "Para que la página funcione y esté segura. Los datos técnicos de la visita sirven para servir la página, para que cargue rápido y para frenar abusos.",
            "Para saber qué páginas se visitan, sin seguirle el rastro. Ver el apartado de cookies.",
          ],
        },
        {
          tipo: "p",
          texto:
            "No vendemos sus datos. No los usamos para armar un perfil suyo. No le mandamos " +
            "publicidad por haber escrito en el chat: si algún día queremos mandarle " +
            "promociones, se lo pediremos aparte y usted podrá decir que no sin perder nada.",
        },
        {
          tipo: "pendiente",
          que:
            "Decidir y dejar por escrito en qué nos apoyamos legalmente para tratar estos datos " +
            "(el consentimiento de quien escribe en el chat, la ejecución del pedido, u otra " +
            "base de la Ley 81), y si el chat debe pedir ese consentimiento antes del primer " +
            "mensaje.",
          quien: "Un abogado.",
        },
      ],
    },
    {
      id: "con-quien",
      titulo: "5. Con quién se comparten",
      bloques: [
        {
          tipo: "p",
          texto:
            "No le damos sus datos a nadie para que haga su negocio con ellos. Sí hay empresas " +
            "que nos prestan servicios y que, al prestarlos, procesan datos:",
        },
        {
          // Comprobado: wrangler.jsonc (la web vive en Cloudflare Workers,
          // `observability` encendida) · index.html:23-32 (la fuente
          // Montserrat se pide a fonts.googleapis.com y fonts.gstatic.com, así
          // que el navegador de la visitante contacta a Google) ·
          // worker/chat.ts:129 (el proveedor de inteligencia artificial) ·
          // worker/prompt.ts:16 y src/components/Chatbot.tsx:149 (el chat
          // empuja a WhatsApp, que es de Meta).
          tipo: "lista",
          puntos: [
            "La empresa que aloja la página (Cloudflare). Sirve el sitio y guarda los registros técnicos de cada visita por poco tiempo.",
            "La empresa que presta el modelo de inteligencia artificial. Recibe el texto de los mensajes del chat para poder contestarlos. Está fuera de Panamá.",
            "Google, por la tipografía. La letra de la página se descarga de los servidores de Google, así que su navegador los contacta y Google ve su dirección IP al hacerlo.",
            "WhatsApp e Instagram (Meta), si usted nos escribe por ahí. Esa conversación ocurre dentro de esas aplicaciones y se rige también por las condiciones de Meta, que nosotros no controlamos.",
          ],
        },
        {
          tipo: "p",
          texto:
            "Varias de estas empresas están fuera de Panamá, así que sus datos salen del país " +
            "cuando usted usa el chat o simplemente abre la página.",
        },
        {
          tipo: "pendiente",
          que:
            "Tener firmado con cada uno de esos proveedores el contrato de tratamiento de datos " +
            "que exige la ley, y revisar si la transferencia fuera de Panamá necesita algo más " +
            "(por ejemplo, avisarle a usted o pedirle permiso aparte).",
          quien: "La dueña del negocio con un abogado; el equipo técnico aporta la lista de proveedores.",
        },
        {
          tipo: "pendiente",
          que:
            "Decidir si la tipografía se sirve desde nuestra propia página en vez de pedirla a " +
            "Google. Es un cambio técnico pequeño que quitaría a Google de esta lista.",
          quien: "El equipo técnico, con el visto bueno de la dueña.",
        },
      ],
    },
    {
      id: "cuanto-tiempo",
      titulo: "6. Cuánto tiempo se guardan",
      bloques: [
        {
          // Comprobado: el Worker no escribe el contenido de los mensajes en
          // ningún registro propio (worker/chat.ts solo registra el evento
          // `chat_sin_catalogo`, línea 21, sin texto de la conversación).
          // La retención de los registros de la plataforma —7 días como
          // máximo en Workers Logs— es dato de la documentación de Cloudflare,
          // citada en el informe, no del código.
          tipo: "p",
          texto:
            "El número al azar que identifica su conversación vive en su navegador hasta que " +
            "usted borre los datos del sitio. Los registros técnicos de la plataforma donde " +
            "vive la web se guardan pocos días (hasta siete, según su documentación) y no " +
            "llevan el texto de las conversaciones.",
        },
        {
          tipo: "pendiente",
          que:
            "Decir cuánto tiempo se guardan las conversaciones del chat una vez que queden en " +
            "la bandeja del negocio, cuánto las guarda el proveedor de inteligencia artificial, " +
            "y cuánto se conservan los datos de una clienta que ya no compra. El plan del " +
            "sistema ya propone plazos para otras cosas (por ejemplo, los comprobantes de pago " +
            "se guardan cinco años por obligación contable), pero los del chat no están " +
            "confirmados.",
          quien: "La dueña del negocio, con el equipo técnico y, para los plazos obligatorios, un abogado.",
        },
      ],
    },
    {
      id: "cookies",
      titulo: "7. Cookies y lo que se guarda en su navegador",
      bloques: [
        {
          // Comprobado: no existe ni una línea que escriba `document.cookie`
          // en `src/` ni en `worker/`. Lo único que se guarda en el navegador
          // es `bc-chat-sesion` (src/chat/sesion.ts:19). La analítica de
          // Cloudflare está preparada pero HOY APAGADA: `CF_ANALYTICS_TOKEN`
          // está vacío en wrangler.jsonc, y worker/head.ts:157-171 no inyecta
          // nada si está vacío. Que esa analítica no usa cookies ni
          // localStorage y no identifica por IP es dato de la documentación de
          // Cloudflare, citada en el informe.
          tipo: "p",
          texto:
            "Esta página no usa cookies propias, ni para publicidad ni para seguirle el rastro. " +
            "Lo que guarda en su navegador —el número al azar de la conversación del chat y, si " +
            "lo usa, su lista del carrito— lo guarda en el almacenamiento del sitio, no en " +
            "cookies, y no sale de su teléfono. Puede borrarlo cuando quiera desde los ajustes " +
            "de su navegador, en la opción de borrar los datos del sitio.",
        },
        {
          tipo: "p",
          texto:
            "Para saber cuántas personas visitan la página usamos (o vamos a usar) una " +
            "herramienta de medición que, según su fabricante, no usa cookies, no guarda nada " +
            "en su navegador y no lo identifica por su dirección IP ni por su navegador. " +
            "Mientras esto se escribe, esa medición está apagada.",
        },
        {
          tipo: "p",
          texto:
            "La empresa que aloja la página puede poner, por su cuenta, alguna cookie técnica " +
            "de seguridad para distinguir a una persona de un programa automático. No la " +
            "ponemos nosotros y no la usamos para nada.",
        },
        {
          tipo: "pendiente",
          que:
            "Comprobar en el navegador, con la página ya en vivo, si aparece alguna cookie de " +
            "seguridad de la plataforma y decir aquí su nombre y para qué sirve. Y volver a " +
            "revisar este apartado el día que la web tenga carrito, pagos en línea o píxel de " +
            "publicidad: ahí sí hay cookies de verdad y haría falta pedir permiso.",
          quien: "El equipo técnico.",
        },
      ],
    },
    {
      id: "sus-derechos",
      titulo: "8. Sus derechos",
      bloques: [
        {
          tipo: "p",
          texto:
            "La ley panameña de protección de datos personales le da estos derechos sobre sus " +
            "datos, y no se los puede quitar nadie:",
        },
        {
          // Los derechos ARCO (acceso, rectificación, cancelación, oposición)
          // y la portabilidad salen de la Ley 81 de 2019 y del Decreto
          // Ejecutivo 285 de 2021. El detalle de las fuentes y lo que NO se
          // pudo verificar están en el informe de entrega.
          tipo: "lista",
          puntos: [
            "Acceso: pedirnos qué datos suyos tenemos y qué hacemos con ellos.",
            "Rectificación: pedirnos que corrijamos un dato equivocado o incompleto.",
            "Cancelación: pedirnos que borremos sus datos cuando ya no haya razón para tenerlos.",
            "Oposición: decirnos que dejemos de usarlos para algo que usted no quiere.",
            "Portabilidad: pedir una copia de sus datos en un archivo que usted pueda llevarse.",
          ],
        },
        {
          tipo: "p",
          texto:
            `Para ejercer cualquiera de ellos, escríbanos por ${POR_WHATSAPP} o al ` +
            `${POR_CORREO}, diciendo qué quiere y cómo lo podemos identificar. Le contestamos ` +
            "por el mismo medio.",
        },
        {
          tipo: "p",
          texto:
            "Hay cosas que no podemos borrar aunque usted lo pida, porque la ley obliga a " +
            "guardarlas: por ejemplo, los comprobantes de una compra, que son parte de la " +
            "contabilidad del negocio. En ese caso se lo decimos y le explicamos qué sí se " +
            "puede borrar.",
        },
        {
          tipo: "pendiente",
          que:
            "El plazo exacto en que la ley obliga a contestar una de estas solicitudes, y si " +
            "hace falta un formulario o una forma concreta de pedirlo. Una fuente secundaria " +
            "menciona diez días hábiles; no se pudo confirmar en el texto oficial de la ley " +
            "desde el entorno donde se escribió esta página.",
          quien: "Un abogado.",
        },
      ],
    },
    {
      id: "menores",
      titulo: "9. Datos de niños y niñas",
      bloques: [
        {
          tipo: "p",
          texto:
            "Esta página está dirigida a personas adultas que compran para un bebé, no a " +
            "menores de edad. No pedimos datos de su bebé en ninguna parte del sitio.",
        },
        {
          tipo: "p",
          texto:
            "Pero si usted le escribe al chat algo como la edad o el peso de su bebé para que " +
            "le recomendemos una talla, ese dato viaja con el mensaje y le aplica todo lo dicho " +
            "arriba sobre la inteligencia artificial. Puede preguntarnos la talla por " +
            `${POR_WHATSAPP} si prefiere no escribirlo en el chat.`,
        },
        {
          tipo: "pendiente",
          que:
            "Decidir si el chat debe avisar en pantalla, antes del primer mensaje, que lo " +
            "escrito ahí pasa por una inteligencia artificial, y si hace falta un cuidado " +
            "especial por tratarse de datos de un bebé.",
          quien: "Un abogado, y la dueña del negocio para el texto del aviso.",
        },
      ],
    },
    {
      id: "seguridad",
      titulo: "10. Cómo cuidamos lo que tenemos",
      bloques: [
        {
          // Comprobado: worker/index.ts:24-33 pone las cabeceras de seguridad
          // (x-frame-options, x-content-type-options, referrer-policy) y
          // public/_headers hace lo mismo con los archivos estáticos. Todo el
          // sitio se sirve por HTTPS.
          tipo: "p",
          texto:
            "La página se sirve cifrada (HTTPS) y lleva las protecciones técnicas corrientes " +
            "para que nadie la pueda incrustar en otro sitio ni leer por el camino. Las claves " +
            "de los servicios que usa la web se guardan como secretos de la plataforma: no " +
            "están escritas en el código ni en el repositorio.",
        },
        {
          tipo: "p",
          texto:
            "Si algún día pasara algo que ponga en riesgo sus datos, se lo diremos y se lo " +
            "diremos también a la autoridad, como manda la ley.",
        },
      ],
    },
    {
      id: "cambios",
      titulo: "11. Cambios a esta política",
      bloques: [
        {
          tipo: "p",
          texto:
            "Cuando cambiemos algo de aquí, cambiaremos también la fecha de arriba. Si el " +
            "cambio es de fondo —por ejemplo, que la web empiece a cobrar en línea o a usar " +
            "cookies de publicidad— lo diremos de forma visible en la página antes de que " +
            "empiece a regir.",
        },
        {
          tipo: "pendiente",
          que:
            "La fecha en que este documento empieza a regir, que es el día en que la dueña lo " +
            "apruebe y un abogado lo revise. Hasta entonces la fecha de arriba es solo la de la " +
            "última edición del borrador.",
          quien: "La dueña del negocio.",
        },
      ],
    },
    {
      id: "reclamos",
      titulo: "12. Si algo no le parece",
      bloques: [
        {
          tipo: "p",
          texto:
            "Escríbanos primero: casi todo se arregla hablando. Si no queda conforme, puede " +
            "presentar su queja ante la autoridad panameña de protección de datos personales, " +
            "que atiende consultas y denuncias en esta materia.",
        },
        {
          tipo: "pendiente",
          que:
            "El nombre exacto de la autoridad, su dirección y el canal para presentar una queja, " +
            "confirmados al día de la publicación. Esta página se escribió sin poder abrir las " +
            "páginas oficiales del Estado desde el entorno de trabajo.",
          quien: "Un abogado, o cualquiera que pueda abrir la página oficial de la autoridad.",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// TÉRMINOS Y CONDICIONES
// ---------------------------------------------------------------------------

export const TERMINOS: DocumentoLegal = {
  ruta: "/terminos",
  titulo: "Términos y condiciones",
  entradilla:
    "Cómo funciona comprar en Baby Caleb Panamá: qué hace esta página, qué no hace, " +
    "cómo se cierra un pedido y qué puede esperar de nosotros.",
  actualizado: "2026-11-11",
  revisadoPorAbogado: false,
  aviso: AVISO_BORRADOR,
  secciones: [
    {
      id: "que-es-esta-pagina",
      titulo: "1. Qué es esta página",
      bloques: [
        {
          // Comprobado: worker/prompt.ts:16 y 39-43 («el negocio vende online:
          // los pedidos se cierran por WhatsApp y se entregan por delivery. NO
          // hay checkout en la web») y content.json → `howToBuy`, los tres
          // pasos: escribir, elegir, recibir.
          tipo: "p",
          texto:
            "Esta página es el catálogo y la información de Baby Caleb Panamá. Aquí usted ve " +
            "qué vendemos, de qué talla, y cómo pedirlo. La página no cobra: no hay pago en " +
            "línea. Si arma una lista en el carrito, esa lista se queda en su teléfono y sirve " +
            "para mandárnosla; todo pedido se cierra hablando con una persona por WhatsApp o " +
            "por mensaje directo de Instagram.",
        },
        {
          tipo: "p",
          texto:
            "Usar la página no lo obliga a nada. Hacer un pedido sí: ahí empieza un acuerdo " +
            "entre usted y nosotros, y es de eso que habla este documento.",
        },
      ],
    },
    {
      id: "como-se-hace-un-pedido",
      titulo: "2. Cómo se hace un pedido",
      bloques: [
        {
          tipo: "lista",
          puntos: [
            `Usted nos escribe por ${POR_WHATSAPP} o por mensaje directo en Instagram (${CONTACTO.instagram}), ya sea de cero o mandando la lista que armó en el carrito.`,
            "Le confirmamos qué hay, de qué talla, cuánto cuesta hoy y cuánto cuesta la entrega en su zona.",
            "Usted acepta, coordinamos el pago y la entrega, y le llevamos la caja a su dirección.",
          ],
        },
        {
          tipo: "p",
          texto:
            "El pedido existe cuando una persona del equipo se lo confirma por WhatsApp. Nada " +
            "de lo que diga el chat de la página, ni lo que aparezca en el catálogo, es por sí " +
            "solo un pedido aceptado.",
        },
      ],
    },
    {
      id: "precios",
      titulo: "3. Precios",
      bloques: [
        {
          // Los precios de la web salen del catálogo del sistema por
          // /api/catalogo (src/hooks/useCatalogo.ts:44) y pueden cambiar sin
          // aviso. En este archivo NO se escribe ningún monto: regla del
          // CLAUDE.md del repositorio, y hay una prueba que lo vigila
          // (test/legal.test.ts).
          tipo: "p",
          texto:
            "Los precios que ve en la página son los del catálogo al momento de cargarla, en " +
            "dólares de Estados Unidos, y pueden cambiar. El precio que vale para su compra es " +
            "el que le confirmemos por WhatsApp cuando haga el pedido.",
        },
        {
          tipo: "p",
          texto:
            "Si un precio sale mal en la página por un error nuestro, se lo diremos antes de " +
            "cobrarle y usted decide si sigue con el pedido o no. No le vamos a cobrar de más " +
            "amparados en un error de la pantalla.",
        },
        {
          tipo: "p",
          texto:
            "El costo de la entrega no va incluido en el precio del producto y depende de su " +
            "zona: se le dice antes de cerrar el pedido.",
        },
        {
          tipo: "pendiente",
          que:
            "Si los precios publicados incluyen o no el ITBMS (el impuesto), y si el negocio " +
            "emite factura fiscal.",
          quien: "La dueña del negocio, con su contadora.",
        },
      ],
    },
    {
      id: "disponibilidad",
      titulo: "4. Qué hay y qué no",
      bloques: [
        {
          // Comprobado: el catálogo público expone `disponible` / `pocas` /
          // `agotado` y NUNCA la cantidad exacta de existencias
          // (src/hooks/useCatalogo.ts:29 y el comentario de
          // src/carrito/carrito.ts sobre por qué la cantidad no sale hacia
          // afuera). Cajas completas: worker/prompt.ts:30.
          tipo: "p",
          texto:
            "La página dice si un producto está disponible, si quedan pocas unidades o si está " +
            "agotado, pero no la cantidad exacta. Que algo aparezca disponible no lo aparta para " +
            "usted: se aparta cuando confirmamos su pedido.",
        },
        {
          tipo: "p",
          texto:
            "Vendemos cajas completas. No vendemos paquetes sueltos ni presentaciones pequeñas.",
        },
      ],
    },
    {
      id: "entregas",
      titulo: "5. Entregas",
      bloques: [
        {
          // Comprobado: worker/prompt.ts:40-42 (solo online, delivery en
          // Ciudad de Panamá, sin tienda física ni punto de retiro; el costo y
          // la cobertura NO están confirmados) y content.json → `coverage`
          // («Ciudad de Panamá: según zona» · «Interior: cotizar por
          // WhatsApp»).
          tipo: "p",
          texto:
            "Entregamos a domicilio en la Ciudad de Panamá. No tenemos tienda física ni punto " +
            "donde retirar. Para otras zonas del país, se cotiza por WhatsApp antes de cerrar " +
            "el pedido.",
        },
        {
          tipo: "p",
          texto:
            "El día y la hora de la entrega se coordinan con usted. Le pedimos que haya alguien " +
            "para recibir la caja en la dirección y el horario acordados.",
        },
        {
          tipo: "pendiente",
          que:
            "El tarifario de entrega por zona, el tiempo que tarda una entrega, los días en que " +
            "no se entrega, y qué pasa si nadie recibe el pedido (se reprograma, se cobra otro " +
            "viaje, o qué).",
          quien: "La dueña del negocio.",
        },
      ],
    },
    {
      id: "pagos",
      titulo: "6. Formas de pago",
      bloques: [
        {
          // Comprobado: worker/prompt.ts:43 — «Métodos de pago: no
          // confirmados. No los inventes; los coordina el humano por
          // WhatsApp». El propio bot tiene prohibido decirlos, así que esta
          // página tampoco los dice.
          tipo: "p",
          texto:
            "El pago se coordina por WhatsApp al cerrar el pedido. Esta página no cobra ni " +
            "guarda datos de tarjeta: no le pida nunca a esta web un número de tarjeta, porque " +
            "no hay dónde ponerlo.",
        },
        {
          tipo: "pendiente",
          que:
            "La lista de formas de pago que acepta el negocio, si hace falta un abono para " +
            "apartar un pedido y de cuánto, y qué pasa con ese abono si el pedido se cancela.",
          quien: "La dueña del negocio.",
        },
      ],
    },
    {
      id: "cambios-y-devoluciones",
      titulo: "7. Cambios, devoluciones y producto con problemas",
      bloques: [
        {
          tipo: "p",
          texto:
            "Si su caja llega dañada, incompleta o no es lo que pidió, escríbanos de una por " +
            `${POR_WHATSAPP} con una foto y lo resolvemos.`,
        },
        {
          tipo: "pendiente",
          que:
            "La política de cambios y devoluciones completa: en cuántos días se puede pedir un " +
            "cambio, en qué estado tiene que estar el producto, si se devuelve el dinero o se " +
            "da un crédito para la próxima compra, quién paga el viaje de la devolución, y qué " +
            "pasa con una caja ya abierta. Esto es lo que más falta de todo este documento y es " +
            "lo que más preguntan las clientas.",
          quien:
            "La dueña del negocio, y un abogado para comprobar que cumple con las normas de " +
            "protección al consumidor de Panamá.",
        },
      ],
    },
    {
      id: "el-chat",
      titulo: "8. El chat de la página informa, no vende",
      bloques: [
        {
          // Comprobado: el chat es un modelo de inteligencia artificial
          // (worker/chat.ts:129-147) con instrucciones de escalar a WhatsApp
          // para cerrar pedido, cotizar envío, formas de pago, quejas o
          // cualquier cosa que no tenga verificada (worker/prompt.ts:51).
          tipo: "p",
          texto:
            "El chat lo contesta una inteligencia artificial, no una persona. Sirve para " +
            "orientarla sobre tallas, productos y cómo comprar. Puede equivocarse, y lo que " +
            "diga no obliga al negocio: lo que vale es lo que le confirme una persona por " +
            "WhatsApp.",
        },
        {
          tipo: "p",
          texto:
            "Lo que usted escriba en el chat pasa por un servicio de inteligencia artificial " +
            "que está fuera de Panamá y que puede usar las conversaciones para entrenar su " +
            "modelo. Está explicado en la política de privacidad, y le pedimos leerlo antes de " +
            "escribir ahí algo delicado.",
        },
      ],
    },
    {
      id: "no-es-consejo-medico",
      titulo: "9. Esto no es consejo médico",
      bloques: [
        {
          // La web tiene una sección educativa y de tips sobre pañalitis,
          // irritación y cuándo consultar al pediatra (content.json → `tips`,
          // `education`; src/blocks/S13Tips.tsx). Eso pide este apartado.
          tipo: "p",
          texto:
            "La página tiene consejos sobre el cuidado de la piel del bebé y sobre cómo elegir " +
            "talla. Es información general, hecha con cariño y con lo que hemos aprendido " +
            "vendiendo, pero no es una consulta médica y no reemplaza a su pediatra.",
        },
        {
          tipo: "p",
          texto:
            "Si su bebé tiene una irritación que no mejora, fiebre, o cualquier cosa que la " +
            "preocupe, llévelo al pediatra. No espere a que el chat le diga qué hacer.",
        },
      ],
    },
    {
      id: "uso-del-sitio",
      titulo: "10. Uso del sitio y contenido",
      bloques: [
        {
          tipo: "p",
          texto:
            "Los textos, las fotos y el diseño de esta página son del negocio o de quien se lo " +
            "autorizó. Puede compartir los enlaces todo lo que quiera; copiar el contenido para " +
            "usarlo en otro negocio, no.",
        },
        {
          tipo: "p",
          texto:
            "Las marcas de los productos que vendemos son de sus dueños y aparecen aquí para " +
            "decirle qué es lo que está comprando.",
        },
        {
          tipo: "p",
          texto:
            "Le pedimos no usar la página ni el chat para mandar insultos, publicidad, intentos " +
            "de estafa o datos de otras personas. Podemos dejar de atender una conversación que " +
            "se use para eso.",
        },
        {
          tipo: "pendiente",
          que:
            "Confirmar quién tiene los derechos de las fotos del sitio (si las tomó el negocio, " +
            "si son del proveedor o si se compraron) y si hace falta autorización escrita del " +
            "proveedor para usar sus imágenes de producto.",
          quien: "La dueña del negocio.",
        },
      ],
    },
    {
      id: "responsabilidad",
      titulo: "11. Hasta dónde respondemos",
      bloques: [
        {
          tipo: "p",
          texto:
            "Respondemos por lo que vendemos: que la caja llegue, que sea la que pidió y que " +
            "esté en buen estado. Si algo de eso falla por nuestra culpa, lo arreglamos.",
        },
        {
          tipo: "p",
          texto:
            "No respondemos por cosas que no están en nuestras manos, como que su internet se " +
            "caiga, que una aplicación de mensajería deje de funcionar o que un proveedor " +
            "cambie la presentación de un producto.",
        },
        {
          tipo: "pendiente",
          que:
            "Revisar este apartado con criterio legal: en Panamá hay derechos del consumidor " +
            "que un documento como este no puede recortar, y hay que asegurarse de que lo " +
            "escrito aquí no intente hacerlo.",
          quien: "Un abogado.",
        },
      ],
    },
    {
      id: "ley-aplicable",
      titulo: "12. Ley aplicable y reclamos",
      bloques: [
        {
          tipo: "p",
          texto:
            "Este acuerdo se rige por las leyes de la República de Panamá. Si tiene un reclamo, " +
            "escríbanos primero: queremos resolverlo. Si no queda conforme, le quedan abiertas " +
            "las vías que da la ley panameña de protección al consumidor.",
        },
        {
          tipo: "pendiente",
          que:
            "Nombrar la norma y la autoridad de protección al consumidor que corresponde, con " +
            "su canal de reclamos al día de la publicación.",
          quien: "Un abogado.",
        },
      ],
    },
    {
      id: "cambios-al-documento",
      titulo: "13. Cambios a estos términos",
      bloques: [
        {
          tipo: "p",
          texto:
            "Podemos cambiar este documento. Cuando lo hagamos, cambiará la fecha de arriba. Lo " +
            "que valga para su pedido es lo que decía este documento el día en que usted lo hizo.",
        },
        {
          tipo: "pendiente",
          que: "La fecha en que estos términos empiezan a regir, una vez aprobados y revisados.",
          quien: "La dueña del negocio.",
        },
      ],
    },
  ],
};

export const DOCUMENTOS: readonly DocumentoLegal[] = [PRIVACIDAD, TERMINOS];

/**
 * Los huecos de un documento, en orden de lectura.
 *
 * Lo usan dos cosas: el resumen del final de cada página —para que la dueña
 * vea de un golpe todo lo que falta, sin cazarlo sección por sección— y las
 * pruebas, que exigen que ningún hueco se quede sin dueño.
 */
export function pendientesDe(documento: DocumentoLegal): readonly BloquePendiente[] {
  return documento.secciones.flatMap((s) =>
    s.bloques.filter((b): b is BloquePendiente => b.tipo === "pendiente"),
  );
}
