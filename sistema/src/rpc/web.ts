import { WorkerEntrypoint } from "cloudflare:workers";
import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { type CatalogoPublico, catalogoPublico } from "./catalogo";
import { zonasPublicas } from "./zonas";
import type { ZonaPublica } from "./zonas";
import { leerPublico } from "../db/archivos";
import { DOMINIO_DEL_AVISO, recibirAvisoDeYappy, type Resuelto } from "../pagos/recibir-aviso";
import { cobrarCarrito, type CarritoACobrar, type ListoParaPagar } from "../pagos/cobrar-carrito";

/**
 * Lo que la web puede pedirle al sistema (03-contratos §2).
 *
 * Va por service binding: no sale a internet, no lleva token y no hay forma de
 * llamarlo desde fuera de la cuenta. Por eso aquí no hay autenticación —la
 * tiene el binding— y por eso lo que importa es QUÉ SE DEVUELVE: cualquier
 * cosa que salga por aquí acaba en un navegador, así que sale el precio, la
 * etiqueta de disponibilidad y la FOTO del artículo, nunca el costo ni la
 * cantidad exacta.
 *
 * ## La foto del catálogo (`VarianteDelCatalogo.imagen`)
 *
 * La cadena existía entera menos el último eslabón: la dueña subía la foto en
 * el panel, se convertía, se guardaba en R2, quedaba en `variantes.imagen` y
 * `/foto/<clave>` la servía con un 200 — y el catálogo público NO llevaba el
 * campo, así que la tienda seguía pintando la de `content.json` y la foto que
 * ella había subido no se veía en ninguna parte. El panel prometía algo que no
 * pasaba.
 *
 * Ahora sale por aquí, y con dos reglas que no son opcionales:
 *
 *  - **Relativa siempre** (`/foto/<clave>`, nunca un dominio). Con
 *    `panel.babycaleb.com` delante, la foto no se ve nunca: Access tapa el
 *    dominio del panel y la CSP del panel (`img-src 'self'`) tapa el de la
 *    web. El filtro de la forma es `fotoPublica` en `rpc/catalogo.ts`.
 *  - **La de `content.json` queda como RESPALDO, no como segunda verdad.** Si
 *    el sistema tiene foto, manda la del sistema; si no, la tienda enseña lo
 *    que enseñaba ayer. Y si la clave no está en R2, la tienda vuelve sola a
 *    la de `content.json` en vez de dejar un hueco (`FotoDeProducto.tsx` en la
 *    web).
 *
 * **Decisión de MCP (CLAUDE.md · `docs/TRAMPAS.md` §13), escrita aquí para que
 * no se olvide:** este cambio no añade ninguna capacidad nueva que alguien
 * pueda querer por una herramienta. SUBIR la foto ya estaba decidido como
 * `solo_panel` en `scripts/sin-mcp.mjs` («se sube una imagen, no datos: una
 * herramienta tendría que recibir el archivo por el modelo»), y lo que se
 * añade aquí es el cable que lleva a la tienda una foto que ya estaba subida
 * —no una puerta nueva—. `node scripts/sin-mcp.mjs` sigue en 0 pendientes.
 *
 * Lo que SÍ falta por MCP, y es anterior a este cambio: «¿a qué artículos les
 * falta foto?». El panel lo contesta —`GET /catalogo` devuelve `v.imagen`— y
 * `buscar_articulo`, que es su pareja en el mapa de cobertura, no lo devuelve.
 * Es un hueco de CAMPO, no de ruta, y por eso `sin-mcp.mjs` no lo ve: compara
 * rutas con herramientas, no las columnas de cada una. Se arregla en
 * `asistente/herramientas/catalogo.ts`, que no es este archivo.
 *
 * En F3.2 solo están catálogo y zonas. Los pedidos y los pagos llegan en F4a:
 * los métodos no se declaran vacíos, porque un método que existe y no hace
 * nada es peor que uno que no existe.
 */
export class SistemaWeb extends WorkerEntrypoint<Env> {
  async catalogo(): Promise<Resultado<CatalogoPublico>> {
    return ok(await catalogoPublico(this.env.DB, Date.now()));
  }

  async zonasEnvio(): Promise<Resultado<ZonaPublica[]>> {
    return ok(await zonasPublicas(this.env.DB));
  }

  /**
   * Prueba de vida para la web (08-operacion §2).
   *
   * No dice nada del negocio: si el binding contesta y la base responde, la
   * web sabe que puede pedir el catálogo. Que falle no es que el sistema esté
   * caído, es que la web tiene que servir su copia de respaldo.
   */
  /**
   * Una imagen del catálogo, por su clave.
   *
   * Existe porque el Worker del sistema está ENTERO detrás de Cloudflare
   * Access: una URL de imagen servida desde aquí no la puede abrir nadie sin
   * sesión, y una foto de producto tiene que verla cualquiera. Así que la
   * sirve la web, que sí es pública, pidiéndola por este binding.
   *
   * Lo que decide si sale o no es `leerPublico`, no esta función ni la web:
   * en este bucket viven también los comprobantes de pago de las clientas, y
   * la comprobación tiene que estar en un solo sitio y del lado de los datos.
   *
   * Devuelve los bytes y no un `Response` porque un `Response` con cuerpo no
   * cruza un service binding sin complicaciones; para una foto de catálogo el
   * tamaño es pequeño y la web la cachea en el borde.
   */
  async archivo(
    clave: string,
  ): Promise<Resultado<{ bytes: ArrayBuffer; mime: string } | null>> {
    if (typeof clave !== "string" || clave === "" || clave.length > 512) {
      return fallo("entrada_invalida", "clave inválida");
    }
    const a = await leerPublico({ db: this.env.DB, r2: this.env.PRIVADO }, clave);
    if (a === null) return ok(null);
    return ok({ bytes: await new Response(a.cuerpo).arrayBuffer(), mime: a.mime });
  }

  /**
   * El carrito de la web, convertido en un pedido que se puede pagar.
   *
   * Lo que entra son CÓDIGOS Y CANTIDADES. Ni un precio, ni un total, ni el
   * costo del envío: todo eso lo pone el servidor leyendo la base. Un carrito
   * manipulado desde las herramientas del navegador —diez segundos de trabajo—
   * cambia lo que esa persona VE, no lo que se le cobra.
   *
   * Devuelve los tres valores del botón de Yappy y nada más. La clave secreta
   * del comercio se queda aquí: hay una prueba que comprueba que no sale.
   *
   * **Decisión de MCP (CLAUDE.md · TRAMPAS §13):** la capacidad de «crear un
   * pedido y cobrarlo» ya existe por MCP, repartida en `crear_pedido` y
   * `registrar_cobro`, y con confirmación de una persona porque mueve dinero.
   * Esto no es una capacidad nueva: es la misma, abierta a una clienta que no
   * tiene a nadie al otro lado. Lo que sí entra con este cambio es
   * `ver_avisos_de_pago`, que es la pregunta que la dueña va a hacer cuando
   * una clienta diga que ya pagó.
   */
  async cobrarCarrito(carrito: CarritoACobrar): Promise<Resultado<ListoParaPagar>> {
    if (carrito === null || typeof carrito !== "object") {
      return fallo("entrada_invalida", "carrito inválido");
    }
    return await cobrarCarrito(
      {
        db: this.env.DB,
        ahora: Date.now(),
        llaveMaestra: this.env.PASARELAS_LLAVE_MAESTRA,
        /*
          La URL del aviso sale del SERVIDOR, nunca del navegador. Si viniera
          de fuera, cualquiera podría pedir que Yappy mandara el aviso de SU
          pago a una dirección suya — y entonces el pago nunca se aplicaría
          aquí, o peor, se aplicaría donde esa persona quisiera.
        */
        urlDelAviso: `https://${DOMINIO_DEL_AVISO}/api/pago/yappy`,
      },
      carrito,
    );
  }

  /**
   * El aviso de pago de Yappy (el IPN), que llega POR LA WEB.
   *
   * Tiene que entrar por ahí y no por aquí directamente, y el motivo es de
   * infraestructura: el Worker del sistema está ENTERO detrás de Cloudflare
   * Access, que contesta un 302 de login antes de que el Worker corra. Yappy
   * recibiría ese 302, no entendería nada, y el pago de la clienta no se
   * aplicaría nunca. La web sí es pública, así que recibe la URL y la pasa por
   * este binding — que no sale a internet.
   *
   * Lo que entra es la cadena de consulta TAL CUAL. No se confía en nada de
   * ella: `recibirAvisoDeYappy` abre la clave del baúl, comprueba que el
   * dominio es el nuestro, verifica la firma en tiempo constante, y solo
   * entonces aplica. El aviso es un GET abierto que cualquiera puede llamar.
   *
   * **Decisión de MCP (CLAUDE.md · TRAMPAS §13):** esto no es una capacidad
   * que la dueña vaya a querer por una herramienta — nadie «recibe un aviso de
   * pago» a mano; lo manda Yappy. Lo que sí hace falta por MCP, y entra en el
   * mismo cambio, es poder PREGUNTAR por esos avisos: cuando una clienta diga
   * «ya pagué» y el sistema diga que no, la pregunta es «¿llegó el aviso de
   * Yappy de este pedido, y qué decía?». Eso es `ver_avisos_de_cobro`.
   */
  async avisoDeYappy(consulta: string): Promise<Resultado<Resuelto>> {
    if (typeof consulta !== "string" || consulta.length > 2048) {
      return fallo("entrada_invalida", "aviso inválido");
    }
    return await recibirAvisoDeYappy(
      {
        db: this.env.DB,
        ahora: Date.now(),
        actor: "yappy: aviso de pago",
        llaveMaestra: this.env.PASARELAS_LLAVE_MAESTRA,
      },
      consulta,
    );
  }

  async salud(): Promise<Resultado<{ sano: boolean; version: string }>> {
    const uno = await this.env.DB.prepare("SELECT 1 AS uno").first<{ uno: number }>();
    return ok({ sano: uno?.uno === 1, version: this.env.VERSION });
  }
}
