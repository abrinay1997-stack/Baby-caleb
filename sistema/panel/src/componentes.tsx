import { Children, cloneElement, isValidElement } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Estado } from "./api";

/**
 * Las piezas que repiten todas las pantallas.
 *
 * Están aquí y no copiadas en cada vista porque el §7l del sistema de diseño
 * del CRM lo dice con todas las letras: «úsalas en vez de inventar una variante
 * por vista». Una tabla que se apila distinto en cada pantalla es una tabla que
 * se rompe en una de ellas sin que nadie lo note.
 */

/** Tarjeta: el envoltorio de casi todo. */
export function Tarjeta({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[14px] border border-line bg-surface p-4 ${className}`}>
      {children}
    </section>
  );
}

/** Una cifra grande con su etiqueta. 32 px y no 38: en un teléfono se parte. */
export function Cifra({
  etiqueta,
  valor,
  nota,
}: {
  etiqueta: string;
  valor: string;
  nota?: string;
}) {
  return (
    <Tarjeta>
      <p className="m-0 text-[12px] uppercase tracking-wide text-muted">{etiqueta}</p>
      <p className="m-0 text-[32px] font-bold leading-tight">{valor}</p>
      {nota ? <p className="m-0 text-[12px] text-muted">{nota}</p> : null}
    </Tarjeta>
  );
}

/**
 * Mientras carga.
 *
 * Dice qué está cargando en vez de girar en silencio: en un teléfono con mala
 * señal, saber que algo está pasando es la diferencia entre esperar y recargar.
 */
export function Cargando({ que }: { que: string }) {
  return (
    <p role="status" aria-live="polite" className="m-0 py-8 text-center text-muted">
      Cargando {que}…
    </p>
  );
}

/** Cuando algo falló. El mensaje ya viene en español desde `api.ts`. */
export function Fallo({ mensaje }: { mensaje: string }) {
  return (
    <Tarjeta className="border-accent-edge">
      <p role="alert" className="m-0 font-bold">
        No se pudo cargar
      </p>
      <p className="m-0 mt-1 text-muted">{mensaje}</p>
    </Tarjeta>
  );
}

/**
 * Cuando no hay nada todavía.
 *
 * Un listado vacío sin explicación parece una pantalla rota. Esto dice por qué
 * está vacío y qué sigue, que casi siempre es «esto se llena en tal fase».
 */
export function Vacio({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <Tarjeta>
      <p className="m-0 font-bold">{titulo}</p>
      <p className="m-0 mt-1 text-muted">{detalle}</p>
    </Tarjeta>
  );
}

/** Resuelve las tres fases de una carga sin que cada pantalla lo repita. */
export function Carga<T>({
  estado,
  que,
  children,
}: {
  estado: Estado<T>;
  que: string;
  children: (datos: T) => ReactNode;
}) {
  if (estado.fase === "cargando") return <Cargando que={que} />;
  if (estado.fase === "error") return <Fallo mensaje={estado.mensaje} />;
  return <>{children(estado.datos)}</>;
}

/**
 * Rejilla que en el teléfono se apila (§7f).
 *
 * En escritorio es una rejilla de verdad; bajo 767 px cada fila se vuelve una
 * tarjeta y cada celda se lee como par etiqueta/valor. La celda con la etiqueta
 * vacía es la identificadora: sin etiqueta y con peso de titular.
 *
 * Nada de `min-width` en píxeles: «a grid with a pixel min-width is a
 * horizontal scrollbar with extra steps».
 */
export function Rejilla({
  columnas,
  children,
}: {
  columnas: string[];
  children: ReactNode;
}) {
  return (
    // El número de columnas viaja como variable de CSS y NO como
    // `grid-template-columns` en línea. Un estilo en línea no sabe de puntos de
    // quiebre: aplicado a todos los anchos, en el teléfono reparte las filas en
    // N columnas en vez de apilarlas y la pantalla se desborda de lado. Eso es
    // el `min-width` en píxeles que el §7f prohíbe, escrito de otra forma.
    // `.rejilla` (estilos.css) es una columna hasta 767 px y usa esta variable
    // desde 768. Lo encontró `scripts/auditar-panel.mjs` midiendo el desborde.
    <div
      className="rejilla grid gap-x-4 gap-y-2"
      style={{ "--columnas": `repeat(${columnas.length}, minmax(0, auto))` } as CSSProperties}
      role="table"
    >
      <div className="solo-escritorio contents" role="row">
        {columnas.map((c) => (
          <div
            key={c}
            role="columnheader"
            className="border-b border-line pb-1 text-[12px] font-bold uppercase tracking-wide text-muted"
          >
            {c}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

export function Fila({ children }: { children: ReactNode }) {
  // El primer `meta` se marca para que no empiece con un punto suelto. Se
  // calcula aquí y no con `:first-of-type` en CSS porque en el teléfono las
  // celdas se reordenan con `order`: el primero que se VE no tiene por qué ser
  // el primero del DOM, y el selector miraría el DOM.
  let yaHuboMeta = false;
  const hijos = Children.map(children, (hijo: ReactNode) => {
    if (!isValidElement<{ papel?: string; etiqueta?: string }>(hijo)) return hijo;
    const papel = hijo.props.papel ?? (hijo.props.etiqueta === "" ? "titulo" : "meta");
    if (papel !== "meta") return hijo;
    if (yaHuboMeta) return hijo;
    yaHuboMeta = true;
    return cloneElement(hijo as React.ReactElement<{ primero?: boolean }>, { primero: true });
  });

  return (
    <div
      role="row"
      className="filas mb-2 grid gap-1 rounded-[14px] border border-line bg-surface p-3 md:mb-0 md:gap-0 md:rounded-none md:border-0 md:border-b md:bg-transparent md:p-0 md:pb-2"
    >
      {hijos}
    </div>
  );
}

/**
 * Qué papel juega esta celda EN EL TELÉFONO. En escritorio no cambia nada: la
 * cuadrícula sigue siendo una tabla con sus columnas.
 *
 * Existe porque apilar cada celda como par etiqueta/valor —la solución obvia
 * para una tabla en un teléfono— gastaba CATORCE líneas por producto para
 * decir siete datos. Doce productos eran ciento setenta líneas de scroll para
 * ver un catálogo de doce cosas. Es correcto y es inusable.
 *
 *   titulo   el nombre. Grande, sin etiqueta.
 *   clave    el dato que se viene a buscar (el precio, lo que queda). Va a la
 *            derecha del título, en la misma línea y en negrita.
 *   estado   la pastilla. Línea propia, debajo.
 *   meta     todo lo demás, plegado en UNA línea separada por puntos.
 */
export type PapelEnTelefono = "titulo" | "clave" | "estado" | "meta";

export function Celda({
  etiqueta,
  children,
  papel,
  primero,
  className = "",
}: {
  /** Vacía = es la celda identificadora de la fila. */
  etiqueta: string;
  children: ReactNode;
  papel?: PapelEnTelefono;
  /** Lo pone `Fila`: el primer `meta` no lleva punto separador delante. */
  primero?: boolean;
  className?: string;
}) {
  // Sin etiqueta es el nombre de la fila: ese es el título y no hace falta
  // decirlo dos veces en cada pantalla.
  const papelReal: PapelEnTelefono = papel ?? (etiqueta === "" ? "titulo" : "meta");
  return (
    <div role="cell" className={`celda ${className}`} data-etiqueta={etiqueta}
      data-papel={papelReal}
      {...(primero ? { "data-primero": "" } : {})}
    >
      {children}
    </div>
  );
}

/**
 * Etiqueta de estado. Lleva texto, no solo color: el color por sí solo no es
 * un estado para quien no lo distingue (§7d).
 */
export function Pastilla({
  tono,
  children,
}: {
  tono: "bien" | "aviso" | "mal" | "neutro";
  children: ReactNode;
}) {
  const tonos = {
    // El relleno es el color de la marca; el texto encima es el navy, que es
    // lo único que se lee sobre los dos (5.56 y 6.96).
    bien: "bg-sage text-fg",
    aviso: "bg-accent text-accent-fg",
    mal: "bg-fg text-bg",
    neutro: "border border-line text-muted",
  } as const;
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-bold ${tonos[tono]}`}
    >
      {children}
    </span>
  );
}
