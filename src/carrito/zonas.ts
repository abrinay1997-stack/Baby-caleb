/**
 * Las zonas de envío, para el desplegable del paso de pago.
 *
 * ## DE DÓNDE SALEN, Y DÓNDE FALTA EL CABLE
 *
 * El tarifario tiene un solo dueño: la tabla `zonas_envio` de la D1 del
 * sistema. El sistema ya la publica para la web —`SistemaWeb.zonasEnvio()`, en
 * `sistema/src/rpc/web.ts`, que devuelve `nombre`, `region`, `tarifaCents` y
 * `requierePagoTotal`— y el `wrangler.jsonc` de la web ya tiene el binding.
 *
 * Lo que NO existe todavía es la puerta HTTP: `worker/index.ts` enruta
 * `/api/catalogo`, `/api/chat`, `/api/pago/yappy` y `/api/salud`, y cualquier
 * otra cosa bajo `/api/` cae en su 404. O sea: hoy el navegador **no puede**
 * pedir las zonas, aunque el dato esté publicado al otro lado del binding. Es
 * la trampa §13 del repositorio —una pieza terminada que nadie llama— y el
 * arreglo son tres líneas en `worker/index.ts`, que este trabajo no toca.
 *
 * Por eso esta pantalla **no se cae sin zonas**: pregunta, y si no hay lista
 * sigue sin ella. El contrato del inicio de pago declara `zona?` opcional, el
 * envío lo cotiza el servidor y vuelve en `envioCents`, así que una clienta
 * puede pagar igual. Lo que no se hace es escribir el tarifario a mano aquí
 * para tapar el hueco: eso le daría un segundo dueño al precio del envío.
 *
 * ## NINGUNA TARIFA SE PINTA
 *
 * `tarifaCents` llega y no se enseña. El precio del envío que vale es el que
 * devuelve el servidor al crear el pedido; enseñar aquí la tarifa de la zona
 * sería prometer un número antes de que nadie lo haya calculado, y el día que
 * las dos discrepen la clienta tendría razón en quejarse. Lo único que se usa
 * de `tarifaCents` es si es `null`, que significa «esta zona se cotiza con una
 * persona» — y eso sí se dice, porque cambia lo que va a pasar después.
 */

export interface ZonaDeEnvio {
  readonly id: string;
  readonly nombre: string;
  readonly region: 'ciudad' | 'interior';
  /** `null` = no hay tarifa fija y el envío se cotiza con una persona. */
  readonly tarifaCents: number | null;
}

export const RUTA_DE_ZONAS = '/api/zonas';

/**
 * Las tres respuestas posibles, con nombre.
 *
 * `sin_lista` y `cargando` no son lo mismo y la pantalla no puede decirlas
 * igual: una es «todavía no sé» y la otra es «no se va a poder». Es la misma
 * distinción que `useCatalogo` hace entre `cargando` y `copiaVieja`.
 */
export type EstadoDeZonas =
  | { readonly estado: 'cargando' }
  | { readonly estado: 'listas'; readonly zonas: readonly ZonaDeEnvio[] }
  | { readonly estado: 'sin_lista' };

/** Una fila cualquiera, antes de comprobar que sea una zona. */
function aZona(cruda: unknown): ZonaDeEnvio | null {
  if (cruda === null || typeof cruda !== 'object') return null;
  const z = cruda as Record<string, unknown>;
  if (typeof z.nombre !== 'string' || z.nombre.trim() === '') return null;
  const tarifa = z.tarifaCents;
  return {
    id: typeof z.id === 'string' && z.id !== '' ? z.id : z.nombre,
    nombre: z.nombre,
    region: z.region === 'interior' ? 'interior' : 'ciudad',
    tarifaCents: typeof tarifa === 'number' ? tarifa : null,
  };
}

/**
 * Saca la lista de lo que haya contestado la ruta.
 *
 * Se aceptan DOS formas porque la ruta todavía no existe y cuál de las dos
 * tendrá no lo decide este archivo: el sistema habla en `{ ok, datos }` por el
 * binding (`contrato/resultado.ts`) y `/api/catalogo` contesta el sobre
 * plano. Cualquier otra cosa es `null`, y entonces la pantalla dice que no hay
 * lista en vez de adivinar.
 */
export function zonasDeLaRespuesta(leido: unknown): readonly ZonaDeEnvio[] | null {
  const crudas = Array.isArray(leido)
    ? leido
    : leido !== null && typeof leido === 'object'
      ? ((): unknown[] | null => {
          const s = leido as { ok?: unknown; datos?: unknown; zonas?: unknown };
          if (s.ok === false) return null;
          if (Array.isArray(s.datos)) return s.datos;
          if (Array.isArray(s.zonas)) return s.zonas;
          return null;
        })()
      : null;
  if (crudas === null) return null;

  const zonas = crudas.map(aZona).filter((z): z is ZonaDeEnvio => z !== null);
  // Una lista vacía no es una lista: con cero zonas el desplegable no sirve
  // para nada y la pantalla tiene que ofrecer el camino sin zona.
  return zonas.length === 0 ? null : zonas;
}

/**
 * Pide las zonas una vez y comparte la respuesta, igual que el catálogo.
 *
 * No reintenta: si la ruta no existe hoy, no va a existir en el siguiente
 * render, y pedirla otra vez por cada componente que se monte sería castigar
 * a un servidor que ya dijo que no.
 */
let enVuelo: Promise<readonly ZonaDeEnvio[] | null> | null = null;

export function pedirZonasUnaVez(pedir: typeof fetch = fetch): Promise<readonly ZonaDeEnvio[] | null> {
  enVuelo ??= pedir(RUTA_DE_ZONAS, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .then((leido) => (leido === null ? null : zonasDeLaRespuesta(leido)))
    .catch(() => null);
  return enVuelo;
}

/** Para las pruebas: vuelve a dejar la promesa compartida sin empezar. */
export function olvidarZonas(): void {
  enVuelo = null;
}
