import { Link, useLocation } from 'react-router-dom';
import Seo from '../components/Seo';
import { Section } from '../components/ui/Section';
import { buttonVariants } from '../components/ui/Button';
import { WHATSAPP_URL } from '../data/contacto';

/**
 * La dirección que no existe.
 *
 * ## Qué se veía antes
 *
 * Nada. `<Routes>` no tenía comodín, así que cualquier ruta que no fuera una
 * de las once conocidas pintaba la barra, el pie, y entre los dos un hueco:
 * **sin `<main>`, sin `<h1>` y sin un solo enlace de salida**. En el teléfono
 * el logo del pie quedaba pegado debajo de la barra y lo que se leía era una
 * tienda rota, no una dirección equivocada. axe lo veía como «contenido fuera
 * de todo landmark» y «el destino del salto al contenido no existe», que es
 * exactamente lo que pasaba.
 *
 * No es un caso raro: el sitio reparte enlaces cortos `/p/<slug>` por WhatsApp
 * e Instagram, y un slug viejo o mal copiado cae justo aquí.
 *
 * ## Qué hace ahora
 *
 * Dice qué pasó, enseña la dirección que se pidió —para que quien la copió mal
 * lo vea— y ofrece las dos salidas que de verdad sirven en esta tienda: el
 * catálogo y el WhatsApp. No hay diseño nuevo: `Section` y `buttonVariants`,
 * los mismos del resto del sitio.
 *
 * ## Por qué no se indexa
 *
 * El Worker ya marca `noindex` todo lo que no está en las rutas públicas
 * (`seo/rutas.ts`), así que esta pantalla no necesita hacer nada: la dirección
 * que la trajo aquí no estaba en la lista. `Seo` recibe los textos a mano
 * porque esta ruta tampoco está en esa lista —igual que el carrito— y sin
 * ellos la pestaña se quedaría con el título de la página anterior.
 */
const META = {
  title: 'No encontramos esa página | Baby Caleb Panamá',
  description: 'La dirección que buscas no existe o cambió. Mira el catálogo o escríbenos.',
};

export default function NoEncontrada() {
  const { pathname } = useLocation();

  return (
    <main id="main-content" className="flex min-h-dvh flex-col pt-32 md:pt-24">
      <Seo ruta={pathname} meta={META} />
      <Section variant="bg" className="flex-grow">
        <p className="mono text-accent-strong mb-6 block">Error 404</p>
        <h1 className="text-fg text-3xl leading-tight text-balance md:text-4xl">
          No encontramos esa página
        </h1>
        <p className="text-muted mt-4 max-w-prose">
          El enlace puede estar incompleto o la página pudo cambiar de dirección.
          No es culpa tuya y no perdiste nada: tu carrito sigue guardado.
        </p>

        {/* La dirección pedida, a la vista. Quien copió un enlace de un chat y
            se dejó un trozo lo ve aquí sin tener que mirar la barra del
            navegador, que en el teléfono va recortada. `break-all` porque un
            slug largo, sin esto, se sale de la pantalla. */}
        <p className="text-muted mt-6 text-sm">
          Buscabas: <code className="text-fg break-all">{pathname}</code>
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link to="/productos" className={buttonVariants({ size: 'lg' })}>
            Ver el catálogo
          </Link>
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            Escribirnos por WhatsApp
          </a>
        </div>

        {/* Aire al final: el globo del chat es fijo abajo a la derecha y sin
            esto se sienta encima del botón de WhatsApp. Es el mismo remate que
            lleva el carrito, por el mismo motivo. */}
        <div className="pb-20" />
      </Section>
    </main>
  );
}
