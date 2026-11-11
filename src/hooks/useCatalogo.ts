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
}

export type Catalogo = ReadonlyMap<string, VariantePublica>;

const porCodigo = (vs: readonly VariantePublica[]): Catalogo =>
  new Map(vs.map((v) => [v.codigo, v]));

const DEL_BUILD: Catalogo = porCodigo(
  (respaldo as { variantes?: VariantePublica[] }).variantes ?? []
);

let enVuelo: Promise<Catalogo> | null = null;
/** Quién quiere enterarse de que el catálogo de verdad ya llegó. */
const avisos = new Set<() => void>();
let yaLlego = false;

function pedirUnaVez(): Promise<Catalogo> {
  enVuelo ??= fetch('/api/catalogo')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { variantes?: VariantePublica[] }) => porCodigo(d.variantes ?? []))
    .catch(() => {
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
export function useCatalogoConEstado(): { catalogo: Catalogo; cargando: boolean } {
  const catalogo = useCatalogo();
  const [cargando, setCargando] = useState(() => cargandoCatalogo());

  useEffect(() => {
    if (!cargandoCatalogo()) {
      setCargando(false);
      return;
    }
    const avisar = () => setCargando(false);
    avisos.add(avisar);
    // Puede haber llegado entre el render y este efecto.
    if (!cargandoCatalogo()) avisar();
    return () => {
      avisos.delete(avisar);
    };
  }, []);

  return { catalogo, cargando };
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
