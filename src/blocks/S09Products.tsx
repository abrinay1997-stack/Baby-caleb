import { useMemo, useState } from 'react';
import { gsap } from 'gsap';

import { getContentData } from '../data/content';
import { useGsapContext } from '../hooks/useGsapContext';
import { Section } from '../components/ui/Section';
import { SectionHeader } from '../components/ui/SectionHeader';
import { buttonVariants } from '../components/ui/Button';
import {
  comoSeLlamaLaPresentacion,
  useCatalogoConEstado,
  productosDeLaTiendaDelSistema,
} from '../hooks/useCatalogo';
import { fotoPorCodigos } from '../components/FotoDeProducto';
import { whatsappCon } from '../data/contacto';
import {
  SIN_FILTROS,
  articulosDeLaTienda,
  filtrar,
  opcionesDe,
  type Filtros,
} from '../tienda/articulos';
import { FiltrosDelCatalogo } from './FiltrosDelCatalogo';
import { TarjetaDeArticulo } from './TarjetaDeArticulo';

/**
 * La tienda, artículo por artículo.
 *
 * ## Qué cambió y por qué
 *
 * Había una tarjeta por PRODUCTO con sus tallas dentro. El dueño lo dijo tres
 * veces: «no me agrada para nada que yo voy a pedir un producto y está
 * agrupado… todo debería estar separado, no en grupos». Y tenía razón por un
 * motivo que se puede medir: desde que hay dos marcas de pañal con quince
 * dólares de diferencia, comparar la M de una con la M de la otra exigía abrir
 * dos tarjetas y acordarse de un precio. Eso es dejar la venta en la mesa.
 *
 * Ahora cada talla de cada marca es su propia tarjeta, y encima van los
 * filtros: categoría, marca y talla, con el orden aparte.
 *
 * ## Dónde vive cada decisión
 *
 * Aquí NO hay reglas de negocio. Qué se enseña, en qué orden y qué cuenta como
 * agotado está en `src/tienda/articulos.ts`, que son funciones puras con sus
 * veinte pruebas. Este archivo pinta.
 *
 * Esa separación no es gusto: el fallo de «creo un producto y no sale en la
 * tienda» vivió cuatro días porque la regla de qué se enseñaba estaba metida
 * dentro de un componente, donde una prueba no llega.
 */
export default function S09Products() {
  const { catalogo, cargando, copiaVieja } = useCatalogoConEstado();
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);

  const productos = productosDeLaTiendaDelSistema();
  const delArchivo = getContentData().products;

  /**
   * La foto de respaldo, emparejada por CÓDIGO y no por slug.
   *
   * `content.json` tiene sus propios ids, y nadie garantiza que coincidan con
   * los slugs del sistema. Lo que sí coincide son los códigos de las
   * presentaciones, que es lo que las dos listas comparten.
   */
  const fotoDeRespaldo = useMemo(() => {
    const porCodigo = new Map<string, string>();
    for (const f of delArchivo) {
      if (f.image === undefined) continue;
      for (const v of f.variants ?? []) {
        if (typeof v.codigo === 'string' && v.codigo !== '') porCodigo.set(v.codigo, f.image);
      }
    }
    return porCodigo;
  }, [delArchivo]);

  const articulos = useMemo(
    () =>
      articulosDeLaTienda(
        productos,
        catalogo,
        (codigo) => fotoPorCodigos([codigo], catalogo, fotoDeRespaldo.get(codigo))?.src,
        (v) => {
          const puesto = comoSeLlamaLaPresentacion(v);
          return { talla: puesto.talla, unidades: puesto.unidades };
        },
      ),
    [productos, catalogo, fotoDeRespaldo],
  );

  const opciones = useMemo(() => opcionesDe(articulos), [articulos]);
  const visibles = useMemo(() => filtrar(articulos, filtros), [articulos, filtros]);

  const containerRef = useGsapContext(() => {
    gsap.from('.product-card', {
      y: 40,
      duration: 0.8,
      stagger: 0.06,
      ease: 'power3.out',
      scrollTrigger: { trigger: containerRef.current, start: 'top 80%' },
    });
  });

  return (
    <Section id="productos" ref={containerRef} variant="bg">
      <SectionHeader
        kicker="01 / Catálogo"
        title="Esenciales diseñados para proteger su piel."
      />

      {/*
        Cuando el sistema no contesta, la web sigue en pie con una copia de los
        precios del día del despliegue, y hasta hace poco no lo decía en ninguna
        parte: el `fetch` contesta 200 igual, así que el navegador tomaba la
        copia por el catálogo de verdad.

        Enseñar un precio viejo en silencio es peor que no enseñar ninguno:
        quien lo lee se lo cree y escribe pidiéndolo.
      */}
      {copiaVieja ? (
        <p
          role="status"
          className="mb-8 rounded-2xl border border-line bg-surface px-5 py-4 text-sm text-muted"
        >
          <strong className="font-semibold text-fg">Estamos actualizando el catálogo.</strong>{' '}
          Los precios y la disponibilidad que ve aquí pueden no estar al día. Antes de hacer su
          pedido, confírmelos con nosotras por WhatsApp.
        </p>
      ) : null}

      {articulos.length === 0 ? (
        <p className="text-muted">
          {cargando ? 'Cargando el catálogo…' : 'El catálogo no está disponible en este momento.'}
        </p>
      ) : (
        <>
          <FiltrosDelCatalogo
            opciones={opciones}
            filtros={filtros}
            alCambiar={setFiltros}
            cuantosSalen={visibles.length}
            cuantosHay={articulos.length}
          />

          {visibles.length === 0 ? (
            /*
              Un callejón sin salida con la salida puesta. «No hay resultados»
              a secas deja a la clienta mirando una pantalla vacía sin saber
              qué tocar para deshacerlo.
            */
            <div className="rounded-2xl border border-line bg-surface p-8 text-center">
              <p className="m-0 mb-4 font-bold text-fg">
                No hay artículos con esos filtros.
              </p>
              <button
                type="button"
                onClick={() => setFiltros({ ...SIN_FILTROS, orden: filtros.orden })}
                className={buttonVariants({ variant: 'outline' })}
              >
                Ver todo el catálogo
              </button>
            </div>
          ) : (
            /*
              Una LISTA, no una pila de divs: un lector de pantalla anuncia
              «lista de 15 artículos» y quien escucha sabe cuánto hay por
              delante antes de empezar a recorrerla.

              Las columnas crecen con la pantalla y la tarjeta más estrecha
              cabe en un teléfono de 320 px sin desbordarse.
            */
            <ul className="m-0 grid list-none grid-cols-1 gap-6 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visibles.map((a) => (
                <TarjetaDeArticulo
                  key={a.codigo}
                  articulo={a}
                  variante={catalogo.get(a.codigo)}
                  foto={a.foto === undefined ? undefined : { src: a.foto }}
                  cargando={cargando}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-10 text-center">
        <a
          href={whatsappCon('Hola Baby Caleb, tengo una consulta sobre el catálogo')}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline' })}
        >
          Consultar por WhatsApp
        </a>
      </div>
    </Section>
  );
}
