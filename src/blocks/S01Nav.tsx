import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Menu, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

export default function S01Nav() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const whatsappLink = "https://wa.me/50767575065";

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  const links = [
    { label: 'Productos', href: '/productos' },
    { label: 'Beneficios', href: '/beneficios' },
    { label: 'Historia', href: '/historia' },
    { label: 'Tips', href: '/tips' },
    { label: 'Cómo comprar', href: '/como-comprar' },
    { label: 'FAQ', href: '/faq' }
  ];

  return (
    <>
      <header
        aria-label="Navegación principal"
        className={`fixed left-1/2 -translate-x-1/2 z-[9999] transition-all duration-500 w-[95%] max-w-6xl rounded-2xl border border-line/30 shadow-[0_8px_32px_0_rgba(27,50,70,0.1)] backdrop-blur-xl flex items-center justify-between ${
          isScrolled ? 'top-4 bg-surface/80 py-3 px-6' : 'top-6 bg-surface/50 py-4 px-6 md:px-8'
        }`}
      >
        <Link to="/" className="flex items-center gap-2 group focus-visible:outline-accent">
          <span className="font-display font-bold text-xl text-fg tracking-tight">Baby Caleb</span>
        </Link>

        {/* Desktop Nav */}
        <nav className="hidden lg:flex items-center gap-6 xl:gap-8">
          {links.map((link) => (
            <Link
              key={link.label}
              to={link.href}
              aria-current={location.pathname === link.href ? 'page' : undefined}
              className={`text-sm font-medium transition-colors duration-200 focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-4 rounded-sm ${
                location.pathname === link.href ? 'text-accent' : 'text-fg hover:text-accent'
              }`}
            >
              {link.label}
            </Link>
          ))}
          <a
            href={whatsappLink}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-accent text-accent-fg px-5 py-2.5 rounded-pill text-sm font-bold hover:opacity-90 transition-opacity focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-4 shadow-soft"
          >
            Pedir por WhatsApp
          </a>
        </nav>

        {/* Mobile Toggle */}
        <button
          className="lg:hidden p-3 -m-3 focus-visible:outline-accent rounded-sm"
          onClick={() => setMobileMenuOpen(true)}
          aria-label="Abrir menú"
          aria-expanded={mobileMenuOpen}
        >
          <Menu className="w-6 h-6 text-fg" />
        </button>
      </header>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ y: -20 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-0 z-[10000] bg-bg flex flex-col pt-24 px-6 pb-12"
            role="dialog"
            aria-modal="true"
            aria-label="Menú de navegación"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setMobileMenuOpen(false);
              }
            }}
          >
            <button
              className="absolute top-6 right-6 p-2 focus-visible:outline-accent rounded-sm"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Cerrar menú"
            >
              <X className="w-8 h-8 text-fg" />
            </button>
            <nav 
              className="flex flex-col gap-6 mt-12 flex-grow"
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setMobileMenuOpen(false);
                }
              }}
            >
              {links.map((link) => (
                <Link
                  key={link.label}
                  to={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  aria-current={location.pathname === link.href ? 'page' : undefined}
                  className={`font-display text-3xl font-bold focus-visible:outline-accent rounded-sm inline-block w-max ${
                    location.pathname === link.href ? 'text-accent' : 'text-fg'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
              <div className="mt-8">
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block bg-accent text-accent-fg px-8 py-4 rounded-pill text-lg font-bold w-full text-center focus-visible:outline-accent"
                >
                  Pedir por WhatsApp
                </a>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
