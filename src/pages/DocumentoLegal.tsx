import { Link } from 'react-router-dom';
import { Section } from '../components/ui/Section';
import {
  pendientesDe,
  type Bloque,
  type DocumentoLegal as Documento,
} from '../data/legal';

/**
 * Cómo se pinta un documento legal.
 *
 * Las dos páginas legales —privacidad y términos— son el mismo objeto: un
 * título, una fecha y una lista de secciones. Pintarlas con el mismo
 * componente no es ahorro de líneas: es que el día que haya que arreglar el
 * tamaño de letra en el teléfono, se arregle en los dos a la vez.
 *
 * ## Las decisiones de forma, y por qué
 *
 * - **Un texto legal se lee en el teléfono.** El cuerpo va a 16 px (`text-base`)
 *   y la columna se corta en `--measure` (68 caracteres), que es el token que ya
 *   tiene la hoja de estilos para medir una línea legible. No hay anchos en
 *   píxeles inventados.
 * - **Índice navegable.** El documento es largo, así que arriba va la lista de
 *   secciones con enlaces de ancla. Cada enlace tiene 44 px de alto (`min-h-11`),
 *   que es lo mínimo para un dedo.
 * - **Los encabezados llevan `id` y la clase `scroll-anchor`**, que es la que la
 *   hoja de estilos usa para que la barra de navegación fija no tape el título
 *   al llegar por un enlace de ancla. Es CSS que ya existía; aquí solo se usa.
 * - **Los huecos se VEN.** Un bloque `pendiente` se pinta como un aviso con
 *   borde, no como una nota al pie: el punto entero es que nadie publique esto
 *   creyendo que está completo.
 *
 * Colores, tipografía y bordes salen de los tokens de la marca. No hay un solo
 * color escrito a mano en este archivo.
 */

const FECHA = new Intl.DateTimeFormat('es-PA', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** «2026-11-11» → «11 de noviembre de 2026». */
function enPalabras(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : FECHA.format(d);
}

function BloqueLegal({ bloque }: { bloque: Bloque }) {
  switch (bloque.tipo) {
    case 'p':
      return <p className="text-base text-muted leading-relaxed">{bloque.texto}</p>;

    case 'lista':
      return (
        <ul className="list-disc pl-5 space-y-3 text-base text-muted leading-relaxed">
          {bloque.puntos.map((punto) => (
            <li key={punto}>{punto}</li>
          ))}
        </ul>
      );

    case 'nota':
      return (
        <div className="border-l-4 border-sage-edge bg-surface rounded-r-lg pl-5 pr-4 py-4">
          <p className="text-sm text-muted leading-relaxed">{bloque.texto}</p>
        </div>
      );

    case 'pendiente':
      return (
        <div className="border border-accent-edge bg-surface rounded-xl p-5">
          <span className="mono text-accent-strong block mb-3">Pendiente</span>
          <p className="text-base text-fg leading-relaxed">{bloque.que}</p>
          <p className="text-sm text-muted leading-relaxed mt-3">
            <span className="font-bold text-fg">Lo tiene que dar:</span> {bloque.quien}
          </p>
        </div>
      );
  }
}

interface DocumentoLegalProps {
  documento: Documento;
  /** El otro documento legal, para enlazarlo al final. */
  tambien: { ruta: string; titulo: string };
}

export default function DocumentoLegal({ documento, tambien }: DocumentoLegalProps) {
  const pendientes = pendientesDe(documento);

  return (
    <Section variant="bg">
      <article className="flex flex-col gap-12 md:gap-16">
        <header className="flex flex-col gap-6" style={{ maxWidth: 'var(--measure)' }}>
          <span className="mono text-accent-strong block">Legal</span>
          <h1 className="text-3xl md:text-5xl text-fg text-balance leading-tight">
            {documento.titulo}
          </h1>
          <p className="text-lg text-muted leading-relaxed">{documento.entradilla}</p>
          <p className="text-sm text-muted">
            Última actualización: {enPalabras(documento.actualizado)}
          </p>
        </header>

        {!documento.revisadoPorAbogado && (
          <div
            role="note"
            aria-label="Aviso sobre el estado de este documento"
            className="border border-accent-edge bg-surface rounded-xl p-5 md:p-6"
            style={{ maxWidth: 'var(--measure)' }}
          >
            <span className="mono text-accent-strong block mb-3">Borrador sin revisar</span>
            <p className="text-base text-fg leading-relaxed">{documento.aviso}</p>
          </div>
        )}

        <nav aria-labelledby={`indice-${documento.ruta.replace('/', '')}`}>
          <h2
            id={`indice-${documento.ruta.replace('/', '')}`}
            className="text-xl text-fg mb-5"
          >
            En esta página
          </h2>
          <ol className="flex flex-col border-t border-line" style={{ maxWidth: 'var(--measure)' }}>
            {documento.secciones.map((seccion) => (
              <li key={seccion.id} className="border-b border-line">
                <a
                  href={`#${seccion.id}`}
                  className="min-h-11 flex items-center text-base text-muted hover:text-accent-strong transition-colors focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 py-2"
                >
                  {seccion.titulo}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex flex-col gap-12" style={{ maxWidth: 'var(--measure)' }}>
          {documento.secciones.map((seccion) => (
            <section key={seccion.id} aria-labelledby={seccion.id}>
              <h2
                id={seccion.id}
                className="scroll-anchor text-2xl md:text-3xl text-fg leading-tight mb-6"
              >
                {seccion.titulo}
              </h2>
              <div className="flex flex-col gap-5">
                {seccion.bloques.map((bloque, i) => (
                  <BloqueLegal key={i} bloque={bloque} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {pendientes.length > 0 && (
          <section aria-labelledby="lo-que-falta" style={{ maxWidth: 'var(--measure)' }}>
            <h2
              id="lo-que-falta"
              className="scroll-anchor text-2xl md:text-3xl text-fg leading-tight mb-6"
            >
              Lo que todavía falta en este documento
            </h2>
            <p className="text-base text-muted leading-relaxed mb-6">
              Estos {pendientes.length} huecos están marcados arriba, en la sección a la que
              pertenecen. Se juntan aquí para que se vean de un golpe, sin tener que leer el
              documento entero.
            </p>
            <ol className="list-decimal pl-5 space-y-5">
              {pendientes.map((p) => (
                <li key={p.que} className="text-base text-fg leading-relaxed">
                  {p.que}{' '}
                  <span className="text-muted">
                    <span className="font-bold text-fg">Lo tiene que dar:</span> {p.quien}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <footer className="border-t border-line pt-8" style={{ maxWidth: 'var(--measure)' }}>
          <p className="text-base text-muted leading-relaxed">
            Vea también{' '}
            <Link
              to={tambien.ruta}
              className="font-bold text-accent-strong hover:underline focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {tambien.titulo}
            </Link>
            .
          </p>
        </footer>
      </article>
    </Section>
  );
}
