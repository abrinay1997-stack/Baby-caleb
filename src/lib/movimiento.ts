/**
 * ¿Esta persona pidió menos movimiento?
 *
 * ## Por qué hace falta un archivo para una línea
 *
 * `src/index.css` ya tiene el bloque de siempre:
 *
 *     @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; … } }
 *
 * y no sirve de nada aquí. Ese bloque apaga animaciones y transiciones **de
 * CSS**. GSAP no usa ninguna de las dos: calcula cada cuadro y escribe un
 * `transform` en el atributo `style` del elemento. Una regla de CSS no puede
 * apagar lo que no es CSS.
 *
 * Medido el 2026-11-13 con el navegador puesto en `reduce`: el titular seguía
 * entrando palabra por palabra, las tarjetas seguían subiendo al llegar al
 * viewport, y la tarjeta flotante del hero seguía oscilando — `repeat: -1`, o
 * sea **para siempre**. Eso último no es solo una preferencia ignorada: es un
 * fallo de WCAG 2.2.2 (movimiento automático de más de cinco segundos sin
 * forma de pararlo), que es Nivel A.
 *
 * Lo único que sí lo miraba era Lenis, en `smooth.ts`.
 *
 * ## Por qué se pregunta aquí y no en cada bloque
 *
 * Porque la respuesta tiene que ser la misma en los diez sitios que animan. Un
 * `matchMedia` copiado en cada bloque es el camino conocido: uno se escribe
 * mal, nadie lo nota —no falla, solo se mueve— y la preferencia se cumple en
 * nueve pantallas de diez.
 *
 * ## Qué pasa cuando la respuesta es «sí»
 *
 * No se anima: **no se ejecuta la animación en absoluto**. Es importante que
 * sea así y no «la misma animación en 0.01 s». Todas las animaciones de
 * entrada de esta web son `gsap.from(...)`, o sea «ven desde aquí hasta donde
 * ya estás»: si no se ejecutan, el elemento se queda exactamente donde el
 * diseño lo puso. Acortarlas, en cambio, sigue moviendo el contenido —solo que
 * a tirones— y además deja la ventana en la que el elemento está a mitad de
 * camino.
 */

/**
 * Se pregunta en el momento, no al cargar.
 *
 * La preferencia se cambia en el sistema operativo con la pestaña abierta, y
 * un valor leído una vez al arrancar se queda viejo sin que nada avise.
 */
export function prefiereMenosMovimiento(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Ejecuta `animar` solo si la persona no pidió quietud.
 *
 * Devuelve lo que devuelva `animar`, o `undefined` si no se ejecutó, para que
 * quien necesite limpiar algo sepa si hay algo que limpiar.
 */
export function conMovimiento<T>(animar: () => T): T | undefined {
  return prefiereMenosMovimiento() ? undefined : animar();
}
