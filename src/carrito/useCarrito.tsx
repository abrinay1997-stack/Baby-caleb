import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { type Carrito, VACIO, agregar as agregarA, ponerCantidad, quitar as quitarDe, unidades } from './carrito';
import { alCambiarEnOtraPestana, guardar, leer, olvidar } from './almacen';

/**
 * El carrito, disponible en toda la página.
 *
 * Un contexto y no un estado por pantalla porque dos sitios muy separados
 * necesitan el mismo número: la burbujita de la barra de navegación y la
 * pantalla del carrito. Pasarlo por propiedades obligaría a que lo conociera
 * cada bloque intermedio.
 *
 * Aquí NO se calcula ningún total ni se guarda ningún precio: eso vive en
 * `carrito.ts` y está explicado ahí. Este archivo solo conecta esa lógica pura
 * con React y con el almacenamiento del navegador.
 */

interface Valor {
  readonly carrito: Carrito;
  readonly unidades: number;
  readonly agregar: (codigo: string, cantidad?: number) => void;
  readonly poner: (codigo: string, cantidad: number) => void;
  readonly quitar: (codigo: string) => void;
  readonly vaciar: () => void;
}

const Ctx = createContext<Valor | null>(null);

export function ProveedorCarrito({ children }: { children: ReactNode }) {
  // Se lee del almacenamiento en el primer render y no en un efecto: si se
  // leyera después, la primera pintada mostraría el carrito vacío y la segunda
  // lo llenaría, y la burbujita saltaría de 0 a 3 a la vista de la clienta.
  const [carrito, setCarrito] = useState<Carrito>(() =>
    typeof window === 'undefined' ? VACIO : leer()
  );

  // El primer render ya trae lo guardado; volver a escribirlo sería escribir lo
  // mismo que acabamos de leer, y en una pestaña nueva pisaría lo que otra
  // pestaña hubiera guardado un instante antes.
  const primero = useRef(true);
  useEffect(() => {
    if (primero.current) {
      primero.current = false;
      return;
    }
    guardar(carrito);
  }, [carrito]);

  useEffect(() => alCambiarEnOtraPestana(setCarrito), []);

  const valor = useMemo<Valor>(
    () => ({
      carrito,
      unidades: unidades(carrito),
      agregar: (codigo, cantidad = 1) => setCarrito((c) => agregarA(c, codigo, cantidad)),
      poner: (codigo, cantidad) => setCarrito((c) => ponerCantidad(c, codigo, cantidad)),
      quitar: (codigo) => setCarrito((c) => quitarDe(c, codigo)),
      vaciar: () => {
        setCarrito(VACIO);
        // Se borra la clave además de vaciar el estado: un carrito vacío
        // guardado y una clave ausente son lo mismo para la clienta, y no
        // dejar basura es más limpio.
        olvidar();
      },
    }),
    [carrito]
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

/**
 * Falla a la vista si falta el proveedor.
 *
 * Devolver un carrito vacío de consuelo escondería el error: los botones de
 * «Agregar» no harían nada y nadie sabría por qué. Un error en la consola
 * durante el desarrollo cuesta un minuto; un botón muerto en producción cuesta
 * ventas.
 */
export function useCarrito(): Valor {
  const v = useContext(Ctx);
  if (v === null) {
    throw new Error('useCarrito se usó fuera de <ProveedorCarrito>');
  }
  return v;
}
