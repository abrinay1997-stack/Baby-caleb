import { WorkerEntrypoint } from "cloudflare:workers";
import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { type CatalogoPublico, catalogoPublico } from "./catalogo";
import { zonasPublicas } from "./zonas";
import type { ZonaPublica } from "./zonas";
import { leerPublico } from "../db/archivos";

/**
 * Lo que la web puede pedirle al sistema (03-contratos §2).
 *
 * Va por service binding: no sale a internet, no lleva token y no hay forma de
 * llamarlo desde fuera de la cuenta. Por eso aquí no hay autenticación —la
 * tiene el binding— y por eso lo que importa es QUÉ SE DEVUELVE: cualquier
 * cosa que salga por aquí acaba en un navegador, así que sale el precio y la
 * etiqueta de disponibilidad, nunca el costo ni la cantidad exacta.
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

  async salud(): Promise<Resultado<{ sano: boolean; version: string }>> {
    const uno = await this.env.DB.prepare("SELECT 1 AS uno").first<{ uno: number }>();
    return ok({ sano: uno?.uno === 1, version: this.env.VERSION });
  }
}
