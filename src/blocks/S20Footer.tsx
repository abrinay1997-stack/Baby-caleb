import { Link } from 'react-router-dom';
import { getContentData } from '../data/content';

export default function S20Footer() {
  const { social, legal } = getContentData();

  return (
    <footer className="bg-bg border-t border-line py-12 md:py-20">
      <div className="container-normal">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          <div className="md:col-span-2">
            <span className="font-display font-bold text-2xl text-fg tracking-tight block mb-4">Baby Caleb</span>
            <p className="text-muted text-sm max-w-sm">
              Especialistas en pañales hipoalergénicos Nateen y fulares Moon. Cuidando de tu bebé en cada etapa.
            </p>
          </div>
          
          <div>
            <h4 className="font-bold text-fg mb-4">Enlaces</h4>
            <ul className="space-y-2">
              <li><Link to="/productos" className="text-sm text-muted hover:text-accent transition-colors">Productos</Link></li>
              <li><Link to="/beneficios" className="text-sm text-muted hover:text-accent transition-colors">Beneficios</Link></li>
              <li><Link to="/como-comprar" className="text-sm text-muted hover:text-accent transition-colors">Cómo comprar</Link></li>
              <li><Link to="/faq" className="text-sm text-muted hover:text-accent transition-colors">FAQ</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-bold text-fg mb-4">Contacto</h4>
            <ul className="space-y-2">
              <li><a href={social.whatsapp} target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-accent transition-colors">WhatsApp</a></li>
              <li><a href={`https://instagram.com/${social.instagram.replace('@', '')}`} target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-accent transition-colors">Instagram</a></li>
              <li><a href={`mailto:${social.email}`} className="text-sm text-muted hover:text-accent transition-colors">Email</a></li>
            </ul>
          </div>
        </div>
        
        <div className="pt-8 border-t border-line flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-muted">
          <p>© {new Date().getFullYear()} {legal.company}. Todos los derechos reservados.</p>
        </div>
      </div>
    </footer>
  );
}
