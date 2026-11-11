import DocumentoLegal from './DocumentoLegal';
import Seo from '../components/Seo';
import { PRIVACIDAD, TERMINOS } from '../data/legal';

/**
 * Los términos y condiciones.
 *
 * Igual que la política de privacidad: el texto está en `src/data/legal.ts` y
 * esta página solo lo pinta. Aquí el hueco más grande es la política de
 * cambios y devoluciones, que no la puede escribir nadie más que la dueña.
 */
export default function Terminos() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo ruta={TERMINOS.ruta} />
      <div className="flex-grow">
        <DocumentoLegal
          documento={TERMINOS}
          tambien={{ ruta: PRIVACIDAD.ruta, titulo: 'la política de privacidad' }}
        />
      </div>
    </main>
  );
}
