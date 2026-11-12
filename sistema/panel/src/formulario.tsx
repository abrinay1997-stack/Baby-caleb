import type { ReactNode } from "react";

/**
 * Las piezas de los formularios de las hojas.
 *
 * Están aquí y no copiadas en cada hoja por lo mismo que `componentes.tsx`:
 * los números del §7 son contrato —16 px en los campos, 44 px en lo que se
 * toca— y con una copia por pantalla basta que una se quede en 14 px para que
 * el teléfono haga zoom al escribir justo ahí. Un solo sitio, y el auditor
 * mide lo mismo en todas.
 */

/**
 * 16 px en los campos es contrato (§7b): por debajo, iOS hace zoom al enfocar
 * y la persona termina peleando con el viewport en vez de escribiendo. El
 * tamaño sale del CSS base del panel, así que aquí NO se baja con ninguna
 * clase de texto.
 */
export const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

/**
 * `rounded-[14px]` y no `rounded-pill`: esa clase NO existe en este proyecto
 * —se usa `rounded-full` o el radio de la marca— y una clase de Tailwind que
 * no existe no da ningún error, simplemente no hace nada.
 */
export const BOTON =
  "tactil flex-1 rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

/**
 * El mismo botón, pero FUERA del pie de una hoja.
 *
 * `BOTON` lleva `flex-1`, que es `flex: 1 1 0%`: su ancho base es cero y crece
 * para repartirse el pie. Puesto en una fila normal, ese ancho cero lo deja
 * del tamaño de la palabra más larga y «Zona nueva» sale partido en dos
 * líneas dentro de una cajita. Se vio en la captura del teléfono, no en el
 * código ni en las medidas: el botón cumplía sus 44 px de alto igual.
 */
export const BOTON_SUELTO =
  "tactil inline-flex items-center justify-center whitespace-nowrap rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

export function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: string;
  children: ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[14px] font-bold">{etiqueta}</span>
      {children}
      {ayuda === undefined ? null : (
        <span className="mt-1 block text-[12px] text-muted">{ayuda}</span>
      )}
    </label>
  );
}

/**
 * Un grupo de opciones, con su pregunta como `<legend>` de verdad.
 *
 * No es un `Campo` con radios dentro: un `<label>` solo puede nombrar a UN
 * control, así que envolver cinco radios en uno deja a quien usa lector de
 * pantalla sin saber de qué es la pregunta. `fieldset` + `legend` es lo que
 * existe para esto.
 */
export function Grupo({
  pregunta,
  ayuda,
  children,
}: {
  pregunta: string;
  ayuda?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 mb-4 border-0 p-0">
      <legend className="mb-2 p-0 text-[14px] font-bold">{pregunta}</legend>
      {ayuda === undefined ? null : (
        <p className="mb-2 mt-0 text-[12px] text-muted">{ayuda}</p>
      )}
      <div className="grid gap-2">{children}</div>
    </fieldset>
  );
}

/**
 * Una opción del grupo: toda la tarjeta se toca, no solo el circulito.
 *
 * En un teléfono, un radio de 20 px al lado de un texto se falla con el pulgar
 * una de cada tres veces. El `tactil` le pone los 44 px de alto del §7a a la
 * fila entera.
 */
export function Opcion({
  nombre,
  marcada,
  alElegir,
  titulo,
  ayuda,
}: {
  /** El `name` del grupo: es lo que hace que elegir una desmarque la otra. */
  nombre: string;
  marcada: boolean;
  alElegir: () => void;
  titulo: string;
  ayuda?: string;
}) {
  return (
    <label
      className={`tactil flex cursor-pointer items-start gap-3 rounded-[12px] border p-3 ${
        marcada ? "border-accent bg-surface" : "border-line"
      }`}
    >
      <input
        type="radio"
        name={nombre}
        checked={marcada}
        onChange={alElegir}
        className="mt-1"
      />
      <span className="block">
        <span className="block font-bold">{titulo}</span>
        {ayuda === undefined ? null : (
          <span className="block text-[13px] font-normal text-muted">{ayuda}</span>
        )}
      </span>
    </label>
  );
}

/** Lo que salió mal, donde se ve y para quien usa lector de pantalla. */
export function Aviso({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3 font-bold"
    >
      {children}
    </p>
  );
}
