import { Link } from 'react-router-dom';
import { getContentData } from '../data/content';

export default function S20Footer() {
  const { social, legal } = getContentData();

  return (
    <footer className="bg-bg border-t border-line py-12 md:py-20">
      <div className="container-normal">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          <div className="md:col-span-2">
            <img
              src="/img/logo.png"
              alt="Baby Caleb — pañales desechables"
              className="w-32 h-32 md:w-36 md:h-36 object-contain mb-4"
              loading="lazy"
              decoding="async"
            />
            <p className="text-muted text-sm max-w-sm">
              Esenciales de bebé hipoalergénicos y biodegradables — pensamos en cada etapa de tu bebé.
            </p>
            <p className="text-muted text-xs mt-4 max-w-sm">
              Venta 100% online con entrega a domicilio en Ciudad de Panamá.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-fg mb-4">Enlaces</h4>
            <ul className="space-y-2">
              <li><Link to="/productos" className="text-sm text-muted hover:text-accent-strong transition-colors">Productos</Link></li>
              <li><Link to="/beneficios" className="text-sm text-muted hover:text-accent-strong transition-colors">Beneficios</Link></li>
              <li><Link to="/historia" className="text-sm text-muted hover:text-accent-strong transition-colors">Historia</Link></li>
              <li><Link to="/tips" className="text-sm text-muted hover:text-accent-strong transition-colors">Tips</Link></li>
              <li><Link to="/como-comprar" className="text-sm text-muted hover:text-accent-strong transition-colors">Cómo comprar</Link></li>
              <li><Link to="/faq" className="text-sm text-muted hover:text-accent-strong transition-colors">FAQ</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-bold text-fg mb-4">Contacto</h4>
            <ul className="space-y-2">
              <li><a href={social.whatsapp} target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-accent-strong transition-colors">WhatsApp</a></li>
              <li><a href={`https://instagram.com/${social.instagram.replace('@', '')}`} target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-accent-strong transition-colors">Instagram</a></li>
              <li><a href={`mailto:${social.email}`} className="text-sm text-muted hover:text-accent-strong transition-colors">Email</a></li>
            </ul>
          </div>
        </div>
        
        <div className="pt-8 border-t border-line flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-muted">
          <p>© {new Date().getFullYear()} {legal.company}. Todos los derechos reservados.</p>
          {/* Aquí y no escondidas: la Ley 81 pide que la persona pueda leer el
              aviso ANTES de dar sus datos, y el chat de esta página recoge lo
              que escriba. Un aviso al que no se llega no es un aviso. */}
          <nav aria-label="Enlaces legales" className="flex gap-4">
            <Link to={legal.privacyUrl} className="hover:text-accent-strong transition-colors">
              Privacidad
            </Link>
            <Link to="/terminos" className="hover:text-accent-strong transition-colors">
              Términos
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
