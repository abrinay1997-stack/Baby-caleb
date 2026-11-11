import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Menu, ShoppingBag, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { WHATSAPP_URL } from '../data/contacto';
import { useCarrito } from '../carrito/useCarrito';

export default function S01Nav() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const { unidades } = useCarrito();
  const whatsappLink = WHATSAPP_URL;

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

  /**
   * El acceso al carrito.
   *
   * El `aria-label` dice el número además de pintarlo: la burbujita es un
   * adorno visual, y quien usa lector de pantalla necesita oír «Mi carrito, 3
   * productos», no «Mi carrito» y una cifra suelta en otro sitio.
   *
   * Solo aparece con algo dentro. Un cero permanente en la barra es ruido que
   * enseña a no mirarla.
   */
  const botonCarrito = () => (
    <Link
      to="/carrito"
      aria-label={
        unidades === 0
          ? 'Mi carrito, vacío'
          : `Mi carrito, ${unidades} ${unidades === 1 ? 'producto' : 'productos'}`
      }
      aria-current={location.pathname === '/carrito' ? 'page' : undefined}
      className="relative grid h-11 w-11 place-items-center rounded-full text-fg transition-colors hover:text-accent-strong focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      <ShoppingBag className="h-6 w-6" aria-hidden="true" />
      {unidades > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-0 right-0 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-fg"
        >
          {unidades > 99 ? '99+' : unidades}
        </span>
      ) : null}
    </Link>
  );

  return (
    <>
      <header
        aria-label="Navegación principal"
        // El vidrio NO se pinta aquí: va en `.bc-vidrio::before` (src/styles/tokens.css),
        // y el tinte con él. Lo único que viaja por React es `data-scrolled`, que es un
        // estado, no el efecto. Si el efecto dependiera de este componente, desmontarlo lo
        // apagaría — que es exactamente el fallo que esto evita.
        data-scrolled={isScrolled ? '' : undefined}
        className={`bc-vidrio fixed left-1/2 -translate-x-1/2 z-[9999] transition-all duration-500 w-[95%] max-w-6xl rounded-2xl border border-line/30 shadow-[0_8px_32px_0_rgba(27,50,70,0.1)] flex items-center justify-between ${
          isScrolled ? 'top-4 py-3 px-6' : 'top-6 py-4 px-6 md:px-8'
        }`}
      >
        <Link to="/" className="flex items-center gap-2 group focus-visible:outline-accent-edge">
          {/* `whitespace-nowrap`: el nombre de la marca no se parte en dos
              líneas, pase lo que pase. Se vio con el traductor del navegador
              puesto —«FAQ» se convierte en «Preguntas frecuentes» y los
              enlaces crecen— y la marca acababa como «Bebé / Caleb». El
              traductor es solo el caso que lo destapó: cualquier texto más
              largo (otro idioma, un nombre más largo) haría lo mismo.
              `shrink-0` para que la barra encoja los enlaces y no la marca. */}
          <span
            translate="no"
            className="font-display font-bold text-xl text-fg tracking-tight whitespace-nowrap shrink-0"
          >
            Baby Caleb
          </span>
        </Link>

        {/* Desktop Nav */}
        <nav className="hidden lg:flex items-center gap-6 xl:gap-8">
          {links.map((link) => (
            <Link
              key={link.label}
              to={link.href}
              aria-current={location.pathname === link.href ? 'page' : undefined}
              className={`text-sm font-medium transition-colors duration-200 focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4 rounded-sm ${
                location.pathname === link.href ? 'text-accent-strong' : 'text-fg hover:text-accent-strong'
              }`}
            >
              {link.label}
            </Link>
          ))}
          {botonCarrito()}
          <a
            href={whatsappLink}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-accent text-accent-fg px-5 py-2.5 rounded-pill text-sm font-bold hover:opacity-90 transition-opacity focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4 shadow-soft"
          >
            Pedir por WhatsApp
          </a>
        </nav>

        {/* Carrito y menú juntos: en un teléfono es donde llega el pulgar */}
        <div className="flex items-center gap-1 lg:hidden">
          {botonCarrito()}
          <button
            className="p-3 -m-3 focus-visible:outline-accent-edge rounded-sm"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Abrir menú"
            aria-expanded={mobileMenuOpen}
          >
            <Menu className="w-6 h-6 text-fg" />
          </button>
        </div>
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
              className="absolute top-6 right-6 p-2 focus-visible:outline-accent-edge rounded-sm"
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
                  className={`font-display text-3xl font-bold focus-visible:outline-accent-edge rounded-sm inline-block w-max ${
                    location.pathname === link.href ? 'text-accent-strong' : 'text-fg'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
              <Link
                to="/carrito"
                onClick={() => setMobileMenuOpen(false)}
                aria-current={location.pathname === '/carrito' ? 'page' : undefined}
                className={`font-display text-3xl font-bold focus-visible:outline-accent-edge rounded-sm inline-flex w-max items-center gap-3 ${
                  location.pathname === '/carrito' ? 'text-accent-strong' : 'text-fg'
                }`}
              >
                Mi carrito
                {unidades > 0 ? (
                  <span className="grid h-7 min-w-7 place-items-center rounded-full bg-accent px-2 text-sm font-bold text-accent-fg">
                    {unidades > 99 ? '99+' : unidades}
                  </span>
                ) : null}
              </Link>
              <div className="mt-8">
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block bg-accent text-accent-fg px-8 py-4 rounded-pill text-lg font-bold w-full text-center focus-visible:outline-accent-edge"
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
