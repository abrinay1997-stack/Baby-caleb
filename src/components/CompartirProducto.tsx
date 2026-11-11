import { useState } from 'react'

/**
 * Compartir una ficha de producto.
 *
 * El enlace que comparte NO es el de la barra de direcciones: es el corto,
 * `/p/<slug>`. La ruta larga, pegada en WhatsApp junto a un texto, se parte y
 * deja de ser enlace; la corta cabe en un mensaje y se dicta por teléfono sin
 * equivocarse. El desvío vive en el Worker.
 *
 * Dos caminos, y el segundo no es un adorno: `navigator.share` abre la hoja
 * del sistema —WhatsApp, mensajes, lo que la clienta tenga— y es lo que se
 * quiere en un teléfono, pero no existe en los navegadores de escritorio. Sin
 * el respaldo de copiar, el botón no haría nada justo donde la dueña arma sus
 * publicaciones.
 */
export function CompartirProducto({ slug, nombre }: { slug: string; nombre: string }) {
  const [copiado, setCopiado] = useState(false)

  async function compartir() {
    const enlace = `${window.location.origin}/p/${slug}`
    const datos = {
      title: nombre,
      text: `${nombre} — Baby Caleb`,
      url: enlace,
    }

    // `canShare` antes de `share`: en algunos navegadores `share` existe pero
    // rechaza la promesa con estos datos, y entonces el botón parece roto.
    if (typeof navigator.share === 'function' && (navigator.canShare?.(datos) ?? true)) {
      try {
        await navigator.share(datos)
        return
      } catch {
        // La persona cerró la hoja de compartir. No es un error que mostrar:
        // se cae al respaldo y queda el enlace copiado, que tampoco estorba.
      }
    }

    try {
      await navigator.clipboard.writeText(enlace)
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 2400)
    } catch {
      // Sin permiso para el portapapeles (pasa en http y en algunos modos
      // privados) se enseña el enlace para copiarlo a mano. Es feo y funciona,
      // que es mejor que un botón que no hace nada.
      window.prompt('Copie el enlace del producto:', enlace)
    }
  }

  return (
    <button
      type="button"
      onClick={compartir}
      aria-label={`Compartir ${nombre}`}
      className="text-muted hover:text-fg focus-visible:outline-accent-edge inline-flex items-center gap-2 self-start rounded-md py-2 text-sm underline underline-offset-4 focus-visible:outline-2"
    >
      <span aria-hidden="true">🔗</span>
      <span aria-live="polite">{copiado ? 'Enlace copiado' : 'Compartir este producto'}</span>
    </button>
  )
}
