import type { Disponibilidad } from '../hooks/useCatalogo';
import { precioLegible } from '../seo/producto';

/**
 * El precio de una ficha, arriba y grande, y lo que se puede decir con él.
 *
 * ## Por qué sale de la cuarta fila de una lista
 *
 * El precio era el último renglón de un `<dl>`, detrás de la talla, el peso y
 * las unidades por caja, en `text-lg` (18 px) y con la misma pinta que el
 * resto de los datos. Medido en la ficha de la caja M a 390 px el 2026-11-18:
 * el «$50» empezaba a **807 px del inicio de la página**, con el viewport de
 * un iPhone 14 en 844 — o sea, en el último centímetro de la pantalla, y eso
 * contando CERO barra del navegador. Con la barra de Safari encima (~110 px)
 * no se veía sin bajar, y con la tarjeta del píxel abierta tampoco.
 *
 * El dueño lo pidió así: «el precio arriba, grande, pegado a la foto». Aquí
 * vive esa decisión, y por eso este bloque es lo primero de la columna de
 * datos: en el teléfono la columna va DEBAJO de la foto, así que ser el
 * primero es la única forma de quedar pegado a ella.
 *
 * ## LO QUE ESTE BLOQUE NO DICE, Y NO ES UN OLVIDO
 *
 * El dueño pidió además dos cosas que **hoy no se pueden decir sin
 * inventarlas**, y por eso no están:
 *
 *  - **Un precio tachado con su porcentaje de descuento.** Una variante trae
 *    UN campo de dinero, `precioCents`, y ninguno más (`useCatalogo.ts`). El
 *    `descuento_cents` del sistema es de un PEDIDO —se prorratea entre sus
 *    líneas— y no es un «antes» de este artículo; `precios_historial` es el
 *    libro de cambios de precio, no una tarifa de marketing: sacar de ahí una
 *    fila vieja y tacharla fabricaría una rebaja que la dueña nunca declaró.
 *  - **Cuotas, o un precio distinto pagando por transferencia.** Las cuotas
 *    son del banco y no están en ninguna tabla de este proyecto; la
 *    transferencia es una forma de anotar un pago ya hecho, no una segunda
 *    tarifa.
 *
 * `CLAUDE.md` lo resume en cuatro palabras —«ninguna cifra a ojo»— y es la
 * regla que más caro sale: la portada tuvo «Desde $17» escrito a mano mientras
 * el pañal más barato costaba $45.
 *
 * **El día que el dato exista**, lo que hay que tocar es el sobre de
 * `/api/catalogo` —un segundo campo de dinero por variante— y este bloque, que
 * es el único sitio donde se decide cómo se enseña un precio en la ficha. Lo
 * que NO se hace es escribir el aviso a mano mientras tanto: un texto que
 * alguien tiene que acordarse de borrar es la siguiente mentira esperando
 * turno (`docs/TRAMPAS.md` §13). Que no se cuele lo vigila
 * `test/sin-rebajas-inventadas.test.ts`.
 */

/**
 * Lo que se dice de la existencia. Una frase, un dueño.
 *
 * Se dice si hay o no hay. NUNCA cuántas quedan: eso es del negocio, y el
 * sistema tampoco lo manda hasta aquí.
 *
 * Está fuera del JSX porque la dice este bloque y la vuelve a necesitar quien
 * quiera resumir la ficha; escrita dos veces, un día dirían dos cosas.
 */
export function fraseDeDisponibilidad(disponibilidad: Disponibilidad): string {
  if (disponibilidad === 'agotado') {
    return 'Ahora mismo está agotado. Escríbenos y te avisamos cuando entre.';
  }
  return disponibilidad === 'pocas' ? 'Quedan pocas cajas.' : 'Disponible para entrega.';
}

export function PrecioDeLaFicha({
  precioCents,
  disponibilidad,
}: {
  readonly precioCents: number;
  readonly disponibilidad: Disponibilidad;
}) {
  const agotado = disponibilidad === 'agotado';

  return (
    <div className="flex flex-col gap-2">
      {/* `translate="no"`: un traductor del navegador que convierta «$50» a
          otra moneda estaría inventando un precio. */}
      <p
        translate="no"
        className="text-accent-strong text-4xl leading-none font-bold md:text-5xl"
      >
        {precioLegible(precioCents)}
      </p>
      <p className={agotado ? 'text-muted text-sm' : 'text-fg text-sm'}>
        {fraseDeDisponibilidad(disponibilidad)}
      </p>
    </div>
  );
}
