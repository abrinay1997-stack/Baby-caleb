import { useEffect, useState } from 'react';
import respaldo from '../data/catalogo.respaldo.json';

/**
 * El precio y la disponibilidad, desde `/api/catalogo` (F3.5).
 *
 * Antes los precios venían dentro de `content.json`, o sea dentro del paquete
 * del sitio: cambiar un precio era editar, construir y desplegar, y hasta que
 * eso pasara la web decía una cosa y el bot otra. Ahora los dos leen lo mismo.
 *
 * Arranca con la copia del build y la reemplaza en cuanto llega la de verdad.
 * Así la primera pintada ya trae precios —nadie ve un «Consultar» que parpadea
 * y se convierte en $50— y, si el sistema no contesta, se queda con la copia,
 * que es lo que el plan pide (08-operacion.md §Qué hacer cuando).
 *
 * La petición se hace UNA vez por carga de página aunque la usen cinco
 * componentes: la promesa se comparte.
 */

export interface VariantePublica {
  readonly codigo: string;
  readonly slug: string;
  readonly nombre: string;
  readonly talla: string | null;
  readonly pesoMinLb: number | null;
  readonly pesoMaxLb: number | null;
  readonly unidadesPorCaja: number;
  readonly precioCents: number;
  readonly disponibilidad: 'disponible' | 'pocas' | 'agotado';
  /**
   * Si la web enseña el botón «Pedir por WhatsApp» en este artículo.
   *
   * Llega YA RESUELTO del sistema: junta el ajuste global
   * `whatsapp_pedidos_activo`, el celular de `whatsapp_numero` y la columna
   * `pedir_por_whatsapp` de la variante. El navegador no combina nada — si lo
   * hiciera, cambiar la regla exigiría desplegar la web y una pestaña abierta
   * desde ayer la combinaría a su manera.
   *
   * Opcional porque la copia del build (`catalogo.respaldo.json`) se generó
   * antes de que este campo existiera. Ausente cuenta como `false`: con el
   * sistema caído no se promete un canal de pedidos que nadie va a leer.
   */
  readonly pedirPorWhatsapp?: boolean;
}

/**
 * A qué celular van los pedidos por WhatsApp. `null` = no hay ninguno.
 *
 * Es un ajuste del negocio y NO una constante del código: cambia cuando la
 * dueña cambia de celular, desde el panel, sin desplegar nada. `contacto.ts`
 * sigue teniendo el número para los enlaces de la barra y del pie, que son
 * «escríbenos» y no «pide este producto»; el día que esos también salgan de
 * aquí, ese archivo se queda sin razón de ser.
 */
let numeroDeWhatsapp: string | null = null;

export const whatsappDePedidos = (): string | null => numeroDeWhatsapp;

export type Catalogo = ReadonlyMap<string, VariantePublica>;

const porCodigo = (vs: readonly VariantePublica[]): Catalogo =>
  new Map(vs.map((v) => [v.codigo, v]));

const DEL_BUILD: Catalogo = porCodigo(
  (respaldo as { variantes?: VariantePublica[] }).variantes ?? []
);

/**
 * `true` cuando lo que se está enseñando es la copia del build, no el catálogo.
 *
 * Existía el dato y no lo leía nadie. El Worker lo manda en cada respuesta
 * (`desdeRespaldo`) «para que la pantalla pueda avisar», y la pantalla no
 * avisaba: el `fetch` contesta **200** aunque esté sirviendo el respaldo, así
 * que el `catch` de abajo no salta y el navegador toma la copia por el
 * catálogo de verdad, con toda confianza.
 *
 * Lo que se enseñaba ese día: los doce artículos en «agotado», los precios de
 * la fecha en que se generó la copia y —porque el respaldo no trae el celular
 * a propósito— **sin botón de pedir por WhatsApp**. Una tienda muerta con cara
 * de tienda sana, y ni un aviso en ninguna parte.
 */
let sirviendoCopiaVieja = false;

/**
 * ¿Lo que se ve salió de la copia del build?
 *
 * Es distinto de `cargandoCatalogo()`: aquello es «todavía no llegó», esto es
 * «llegó, y es la copia». «No se sabe» y «es viejo» son dos respuestas
 * distintas y la pantalla no puede darlas igual.
 */
export const catalogoEsCopiaVieja = (): boolean => sirviendoCopiaVieja;

let enVuelo: Promise<Catalogo> | null = null;
/** Quién quiere enterarse de que el catálogo de verdad ya llegó. */
const avisos = new Set<() => void>();
let yaLlego = false;

/**
 * Pide el catálogo una sola vez y comparte la respuesta.
 *
 * Se exporta porque es la operación de verdad, y el hook de abajo solo la
 * envuelve para React. Sin un punto de entrada que se pueda llamar desde
 * fuera, lo único comprobable sería el hook —que necesita un árbol de React
 * montado— y lo que hay que vigilar aquí no es el render: es de dónde salieron
 * los precios que se están enseñando.
 */
export function pedirUnaVez(): Promise<Catalogo> {
  enVuelo ??= fetch('/api/catalogo')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(
      (d: {
        variantes?: VariantePublica[];
        whatsapp?: { numero: string | null };
        desdeRespaldo?: boolean;
      }) => {
      // El celular se guarda al llegar, con el catálogo: viene en el mismo
      // sobre y por la misma petición. Un segundo viaje para un dato que ya
      // está en la respuesta sería una consulta de más en cada visita.
      numeroDeWhatsapp = d.whatsapp?.numero ?? null;
      // La respuesta llega con 200 en los dos casos: el Worker sirve la copia
      // cuando el sistema no contesta y sigue devolviendo una página sana. Lo
      // único que los distingue es este campo.
      sirviendoCopiaVieja = d.desdeRespaldo === true;
      return porCodigo(d.variantes ?? []);
      },
    )
    .catch(() => {
      // Aquí no hace falta mirar el campo: si la petición se cayó del todo, lo
      // que queda es la copia y punto.
      sirviendoCopiaVieja = true;
      // Sin catálogo del sistema nos quedamos con la copia del build. No se
      // vacía la promesa: reintentar en cada componente que se monte sería
      // castigar a un sistema que ya está caído.
      return DEL_BUILD;
    })
    .then((c) => {
      yaLlego = true;
      for (const avisar of avisos) avisar();
      return c;
    });
  return enVuelo;
}

/**
 * Si el catálogo de verdad todavía no llegó.
 *
 * Hace falta porque la copia del build **miente sobre la disponibilidad**: se
 * genera en el despliegue y hoy trae las doce variantes en `agotado`. Durante
 * los primeros cientos de milisegundos la página diría que no hay nada de
 * nada, y después cambiaría sola.
 *
 * Con los precios eso daba igual —un precio viejo sigue siendo un precio— y
 * por eso la copia se pinta de entrada. Con un botón de «Agregar» no da
 * igual: saldría apagado y se encendería solo, y quien lo tocó en medio ve
 * que no pasa nada y lo vuelve a tocar.
 *
 * Así que esto existe para poder decir «un momento» en vez de decir una cosa
 * y cambiarla.
 */
export function cargandoCatalogo(): boolean {
  return !yaLlego;
}

export function useCatalogo(): Catalogo {
  const [catalogo, setCatalogo] = useState<Catalogo>(DEL_BUILD);

  useEffect(() => {
    let vivo = true;
    void pedirUnaVez().then((c) => {
      if (vivo && c.size > 0) setCatalogo(c);
    });
    return () => {
      vivo = false;
    };
  }, []);

  return catalogo;
}

/**
 * El catálogo y si todavía se está esperando.
 *
 * Aparte de `useCatalogo` para no cambiarle la forma a los sitios que solo
 * quieren precios y les da igual la espera.
 */
export function useCatalogoConEstado(): {
  catalogo: Catalogo;
  cargando: boolean;
  /** `true` si lo que se está enseñando es la copia del build. */
  copiaVieja: boolean;
} {
  const catalogo = useCatalogo();
  const [cargando, setCargando] = useState(() => cargandoCatalogo());
  const [copiaVieja, setCopiaVieja] = useState(() => catalogoEsCopiaVieja());

  useEffect(() => {
    if (!cargandoCatalogo()) {
      setCargando(false);
      return;
    }
    const avisar = () => {
      setCargando(false);
      // Se lee DESPUÉS de que llegue: antes todavía no se sabe de dónde salió,
      // y enseñar el aviso mientras carga diría que algo va mal cuando lo
      // único que pasa es que la respuesta no ha vuelto.
      setCopiaVieja(catalogoEsCopiaVieja());
    };
    avisos.add(avisar);
    // Puede haber llegado entre el render y este efecto.
    if (!cargandoCatalogo()) avisar();
    return () => {
      avisos.delete(avisar);
    };
  }, []);

  return { catalogo, cargando, copiaVieja };
}

/** `5000` da `$50`; `4650` da `$46.50`. Los centavos solo salen si los hay. */
export function dolares(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * El precio de una variante, o `Consultar`.
 *
 * `Consultar` no es un hueco: es lo que ya decía la web cuando un producto no
 * llevaba precio (el fular). Que un código ausente del catálogo signifique lo
 * mismo es deliberado — vale más pedir que confirmen a inventar un número.
 */
export function precioDe(catalogo: Catalogo, codigo?: string): string {
  const v = codigo === undefined ? undefined : catalogo.get(codigo);
  return v === undefined ? 'Consultar' : dolares(v.precioCents);
}

/** El «desde $X» de un producto: el más barato de sus variantes. */
export function desdeDe(catalogo: Catalogo, codigos: readonly (string | undefined)[]): string {
  const precios = codigos
    .map((c) => (c === undefined ? undefined : catalogo.get(c)?.precioCents))
    .filter((p): p is number => p !== undefined);
  return precios.length === 0 ? 'Consultar' : `Desde ${dolares(Math.min(...precios))}`;
}

/** Lo mínimo que esta decisión necesita saber de un producto de `content.json`. */
export interface ProductoDeLaTienda {
  readonly descatalogado?: boolean;
  readonly variants?: readonly { readonly codigo?: string }[];
}

/**
 * ¿La tienda puede enseñar este producto?
 *
 * **El problema que resuelve.** La lista de la tienda sale de `content.json`,
 * un archivo escrito a mano, y el precio y la existencia salen de la D1. O
 * sea: la pregunta «¿qué productos hay?» tenía DOS dueños. Si la dueña
 * retiraba un producto desde el panel, el sistema dejaba de publicarlo y la
 * tienda **lo seguía ofreciendo**, con un «Consultar» donde antes iba el
 * precio. Una clienta tocaba «Pedir» sobre algo que ya no existe.
 *
 * Ahora la D1 manda también en esto: un producto solo se enseña si el sistema
 * publica alguna de sus presentaciones.
 *
 * **Lo que esto NO arregla, y conviene no confundirlo:** un producto creado en
 * el panel sigue sin salir en la lista, porque su descripción, su foto y su
 * texto de venta viven en `content.json` y nadie los escribió. Eso se dice
 * ahora en el panel, en vez de dejar a la dueña preguntándose por qué su
 * producto no aparece.
 *
 * **Falla abierta, a propósito.** Si el catálogo todavía no llegó, o llegó
 * vacío porque el sistema no contesta, se enseña TODO. Una tienda con un
 * producto de más es un pedido que hay que aclarar; una tienda vacía es una
 * tienda cerrada, y eso es peor en todos los casos.
 */
export function laTiendaLoEnsena(
  producto: ProductoDeLaTienda,
  catalogo: Catalogo,
  estado: { readonly cargando: boolean },
): boolean {
  // Lo descatalogado a mano sigue mandando: es la forma de sacar algo de la
  // tienda sin tocar la base.
  if (producto.descatalogado === true) return false;

  // Todavía no sabemos nada: no se esconde nada en la primera pintada.
  if (estado.cargando) return true;

  // El catálogo vino vacío — el sistema no contesta y ni siquiera hubo copia.
  // Esconderlo todo dejaría la tienda en blanco.
  if (catalogo.size === 0) return true;

  const codigos = (producto.variants ?? [])
    .map((v) => v.codigo)
    .filter((c): c is string => typeof c === 'string' && c !== '');

  // Un producto sin ningún código no lo maneja el sistema (el fular, las
  // toallitas sueltas). No hay nada que comprobar, así que se enseña.
  if (codigos.length === 0) return true;

  return codigos.some((c) => catalogo.has(c));
}
