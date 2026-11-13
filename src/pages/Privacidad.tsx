import DocumentoLegal from './DocumentoLegal';
import Seo from '../components/Seo';
import { PRIVACIDAD, TERMINOS } from '../data/legal';

/**
 * La política de privacidad (Ley 81 de 2019).
 *
 * El texto no vive aquí: vive en `src/data/legal.ts`, con la cita del archivo
 * y la línea de donde sale cada afirmación. Esta página solo lo pinta.
 *
 * La ruta es `/privacidad` y no otra porque `content.json` ya la nombra
 * (`legal.privacyUrl`): era el enlace que el sitio prometía y no existía.
 */
export default function Privacidad() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-dvh flex flex-col">
      <Seo ruta={PRIVACIDAD.ruta} />
      <div className="flex-grow">
        <DocumentoLegal
          documento={PRIVACIDAD}
          tambien={{ ruta: TERMINOS.ruta, titulo: 'los términos y condiciones' }}
        />
      </div>
    </main>
  );
}
