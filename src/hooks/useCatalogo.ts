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

/**
 * Los tres estados, con nombre.
 *
 * Estaba escrito a mano dentro de `VariantePublica` y no se podía nombrar
 * desde fuera, así que cualquier otro archivo que quisiera razonar sobre los
 * estados tenía que volver a escribir la lista — y una lista escrita dos veces
 * es una lista que un día dirá dos cosas.
 */
export type Disponibilidad = 'disponible' | 'pocas' | 'agotado';

export interface VariantePublica {
  readonly codigo: string;
  readonly slug: string;
  readonly nombre: string;
  readonly talla: string | null;
  readonly pesoMinLb: number | null;
  readonly pesoMaxLb: number | null;
  readonly unidadesPorCaja: number;
  readonly precioCents: number;
  readonly disponibilidad: Disponibilidad;
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
  /**
   * El slug del PRODUCTO al que pertenece, para agrupar las presentaciones.
   *
   * No es `slug`: ese lleva el código pegado detrás
   * (`panales-nateen-cierre-nat-m`) porque cada talla necesita su propia URL.
   *
   * Opcional porque la copia del build se generó antes de que el catálogo
   * llevara productos. Ausente quiere decir que no se puede agrupar por el
   * sistema, y entonces manda `content.json` — ver `laListaDeLaTienda`.
   */
  readonly productoSlug?: string;
  /**
   * La foto que la dueña subió desde el panel, o `null` si no subió ninguna.
   *
   * **Desde hoy la foto tiene un solo dueño y es el sistema.** La tienda la
   * sacaba de `content.json` —un archivo de este repositorio— mientras la
   * dueña subía fotos en su panel que no se veían en ninguna parte: llegaban a
   * R2, quedaban guardadas y el catálogo público no traía el campo, así que la
   * tienda ni se enteraba. La de `content.json` sigue ahí y sigue sirviendo,
   * pero como RESPALDO: si hay foto del sistema, manda la del sistema; si no,
   * se enseña la de siempre. Quién gana se decide en `FotoDeProducto.tsx`, en
   * un solo sitio.
   *
   * Es una ruta RELATIVA (`/foto/<clave>`) y se pide al propio dominio de la
   * tienda a propósito: con el dominio del panel delante, la foto no se ve
   * nunca —Access por un lado y la CSP del panel por el otro—. El sistema no
   * deja salir otra cosa (`fotoPublica`, en `sistema/src/rpc/catalogo.ts`).
   *
   * Opcional porque la copia del build puede haberse generado antes de que
   * este campo existiera. Ausente cuenta igual que `null`: la foto de
   * `content.json`, que es lo que se enseñaba ayer.
   */
  readonly imagen?: string | null;
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

/**
 * Un producto tal como lo manda el sistema.
 *
 * Es el espejo de `ProductoDelCatalogo` del sistema. No se comparte el tipo
 * porque son dos paquetes que se despliegan por separado: lo que los mantiene
 * de acuerdo es `test/la-foto-del-sistema.test.ts` y el contrato, no un
 * import.
 */
export interface ProductoDelSistema {
  readonly slug: string;
  readonly nombre: string;
  readonly descripcion: string | null;
  readonly orden: number;
  /** La marca, o `null` si el producto no la tiene puesta. */
  readonly marca?: string | null;
  /** 'panal' | 'pants' | 'wipes' | 'portabebe' | … Tal cual la manda el sistema. */
  readonly familia?: string;
}

/**
 * Los productos del último catálogo que llegó.
 *
 * Vacío mientras no haya llegado nada, y vacío también cuando el sistema
 * contesta con la copia del build —que se generó antes de que el catálogo
 * llevara productos—. Las dos cosas significan lo mismo para la tienda: no se
 * sabe, así que manda `content.json`.
 */
let productosDelSistema: readonly ProductoDelSistema[] = [];

export const productosDeLaTiendaDelSistema = (): readonly ProductoDelSistema[] =>
  productosDelSistema;

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
  enVuelo ??= fetch('/api/catalogo', {
    /**
     * EL NAVEGADOR NO GUARDA ESTO, Y NO ES UNA PRECAUCIÓN: ES UN ARREGLO.
     *
     * El Worker pide `max-age=30` (`worker/catalogo.ts`) y producción devuelve
     * `max-age=14400` — cuatro horas. Medido el 15-nov en babycaleb.com. Son
     * los 4 h por defecto del «Browser Cache TTL» de la zona de Cloudflare,
     * que PISA la cabecera del origen salvo que se ponga en «Respect Existing
     * Headers».
     *
     * Con eso, la dueña publicaba un producto en el panel, recargaba la tienda
     * y seguía viendo el catálogo viejo. Durante cuatro horas. No había nada
     * roto que mirar: la base estaba bien, la API contestaba bien, y una
     * petición nueva —un `curl`, otro navegador— lo veía al instante. Solo su
     * pestaña mentía. El dueño lo persiguió días.
     *
     * `no-store` lo decide el JavaScript, no una negociación de cabeceras, así
     * que ningún ajuste de la zona lo puede pisar. El borde sigue cacheando
     * 60 s (`s-maxage`), que es lo que protege a la D1: lo que se quita es la
     * copia privada del navegador, que no protegía a nadie.
     *
     * El ajuste de la zona conviene cambiarlo igual —arregla de paso cualquier
     * otra ruta de `/api/*`—, pero esto no depende de eso.
     */
    cache: 'no-store',
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(
      (d: {
        variantes?: VariantePublica[];
        productos?: ProductoDelSistema[];
        whatsapp?: { numero: string | null };
        desdeRespaldo?: boolean;
      }) => {
      // El celular se guarda al llegar, con el catálogo: viene en el mismo
      // sobre y por la misma petición. Un segundo viaje para un dato que ya
      // está en la respuesta sería una consulta de más en cada visita.
      numeroDeWhatsapp = d.whatsapp?.numero ?? null;
      // Los PRODUCTOS llegan en el mismo sobre que las variantes, y por la
      // misma razón que el celular: están en la respuesta, pedirlos aparte
      // sería un viaje de más en cada visita.
      productosDelSistema = d.productos ?? [];
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

// ---------------------------------------------------------------------------
// La lista de la tienda: qué productos se enseñan y con qué texto
// ---------------------------------------------------------------------------

/** Una ficha de `content.json`, con lo que la tienda todavía saca de ahí. */
export interface FichaDelArchivo {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly image?: string;
  readonly descatalogado?: boolean;
  readonly variants?: readonly {
    readonly codigo?: string;
    readonly size?: string;
    readonly units?: string;
    readonly image?: string;
  }[];
}

/** Una presentación lista para su fila, con las palabras que la tienda enseña. */
export interface PresentacionParaPintar {
  readonly codigo: string;
  readonly talla: string;
  readonly unidades: string;
}

/**
 * Cómo se nombra una presentación que NO tiene ficha en `content.json`.
 *
 * Las que sí la tienen conservan sus palabras tal cual —«Caja RN», «160 uds»,
 * y «ajustable» en el fular, que no es un número— porque esas frases están
 * redactadas y el diseño de la web no se cambia de paso. Esto es solo para los
 * productos que la dueña crea desde el panel, que no tienen ninguna.
 */
export function comoSeLlamaLaPresentacion(v: VariantePublica | undefined): {
  talla: string;
  unidades: string;
} {
  const talla = v?.talla ?? null;
  const n = v?.unidadesPorCaja;
  return {
    talla: talla === null || talla.trim() === '' ? 'Única' : talla,
    // «1 uds» es la clase de detalle que hace que una tienda parezca
    // automática. Un portabebés viene de uno en uno.
    unidades: n === undefined ? '' : n === 1 ? '1 unidad' : `${n} uds`,
  };
}

/** Un producto ya listo para pintar, venga de donde venga. */
export interface ProductoParaPintar {
  /** La clave de agrupación: el slug del producto en el sistema, o el id de la ficha. */
  readonly clave: string;
  readonly nombre: string;
  /** El párrafo de debajo del nombre. `null` = no hay, y no se pinta. */
  readonly descripcion: string | null;
  /** Los códigos de sus presentaciones, en el orden en que se enseñan. */
  readonly codigos: readonly string[];
  /** Esas mismas presentaciones, con las palabras con que se enseñan. */
  readonly presentaciones: readonly PresentacionParaPintar[];
  /** La ficha de `content.json`, si la tiene: de ahí sale la foto de respaldo. */
  readonly ficha: FichaDelArchivo | undefined;
}

/**
 * Qué productos enseña la tienda, y con qué nombre y qué texto.
 *
 * **EL FALLO QUE CIERRA.** La lista salía de `content.json`, un archivo del
 * repositorio de esta web que nadie escribe desde ningún sitio. La dueña
 * creaba un producto en el panel, le ponía precio, le subía la foto y lo
 * publicaba — y no aparecía. Tenía su página, tenía su foto y se podía pedir
 * por su enlace directo, pero no entraba en la lista hasta que un programador
 * editara ese archivo y desplegara. El dueño preguntó cuatro días seguidos.
 *
 * Desde aquí manda el sistema: lo que la dueña publica, se ve.
 *
 * **Qué queda de `content.json`, y por qué no se borra.** La FOTO de respaldo.
 * El sistema ya es el dueño del nombre, del texto de venta, del precio, de la
 * existencia y de la foto cuando la hay; lo que no tiene es una foto de
 * familia para el producto que nunca recibió una desde el panel. Mientras eso
 * siga así, la ficha del archivo se empareja por los códigos de sus
 * presentaciones — no por su `id`, que nadie garantiza que coincida con el
 * slug del sistema.
 *
 * **Falla abierta, igual que antes.** Sin catálogo —todavía no llegó, o el
 * sistema no contesta y lo que hay es la copia del build, que se generó antes
 * de que el catálogo llevara productos— se enseña `content.json` entero, que
 * es lo que se enseñaba ayer. Una tienda con un producto de más es un pedido
 * que hay que aclarar; una tienda vacía es una tienda cerrada.
 */
export function laListaDeLaTienda(
  delSistema: readonly ProductoDelSistema[],
  delArchivo: readonly FichaDelArchivo[],
  catalogo: Catalogo,
  estado: { readonly cargando: boolean },
): ProductoParaPintar[] {
  const porCodigoDeFicha = new Map<string, FichaDelArchivo>();
  for (const f of delArchivo) {
    for (const v of f.variants ?? []) {
      if (typeof v.codigo === 'string' && v.codigo !== '') porCodigoDeFicha.set(v.codigo, f);
    }
  }

  // El camino de respaldo: lo de siempre, con la regla de siempre.
  if (estado.cargando || delSistema.length === 0) {
    return delArchivo
      .filter((f) => f.descatalogado !== true)
      .filter((f) => laTiendaLoEnsena(f, catalogo, estado))
      .map((f) => {
        const codigos = (f.variants ?? [])
          .map((v) => v.codigo)
          .filter((c): c is string => typeof c === 'string' && c !== '');
        return {
          clave: f.id ?? f.name ?? '',
          nombre: f.name ?? '',
          descripcion: f.description ?? null,
          codigos,
          presentaciones: codigos.map((codigo) => {
            const dela = (f.variants ?? []).find((v) => v.codigo === codigo);
            const puesto = comoSeLlamaLaPresentacion(catalogo.get(codigo));
            return {
              codigo,
              talla: dela?.size ?? puesto.talla,
              unidades: dela?.units ?? puesto.unidades,
            };
          }),
          ficha: f,
        };
      });
  }

  const variantes = [...catalogo.values()];
  return delSistema
    .map((p) => {
      // El orden de las presentaciones lo decide el sistema, que ya las manda
      // ordenadas por talla. Reordenarlas aquí sería un segundo dueño del
      // orden.
      const codigos = variantes
        .filter((v) => v.productoSlug === p.slug)
        .map((v) => v.codigo);
      const ficha = codigos.map((c) => porCodigoDeFicha.get(c)).find((f) => f !== undefined);
      // Las palabras de la ficha mandan donde las hay: «Caja RN · 160 uds» y
      // «ajustable» están redactadas, y deducirlas del sistema le pondría al
      // fular «Caja Unitalla · 1 uds». Donde no las hay —un producto creado
      // desde el panel— se deducen, que es mejor que dejar la fila muda.
      const presentaciones = codigos.map((codigo) => {
        const dela = (ficha?.variants ?? []).find((v) => v.codigo === codigo);
        const puesto = comoSeLlamaLaPresentacion(catalogo.get(codigo));
        return {
          codigo,
          talla: dela?.size ?? puesto.talla,
          unidades: dela?.units ?? puesto.unidades,
        };
      });
      return {
        clave: p.slug,
        nombre: p.nombre,
        descripcion: p.descripcion,
        codigos,
        presentaciones,
        ficha,
      };
    })
    // Un producto sin ninguna presentación visible es una tarjeta vacía. El
    // sistema ya los filtra, pero el catálogo y la lista de productos pueden
    // llegar desacompasados si alguna vez se sirven de cachés distintas.
    .filter((p) => p.codigos.length > 0);
}
