/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { initSmoothScroll, scrollToTop } from './lib/smooth';

import S01Nav from './blocks/S01Nav';
import S20Footer from './blocks/S20Footer';
import Chatbot from './components/Chatbot';

import Home from './pages/Home';
import Productos from './pages/Productos';
import FichaProducto from './pages/FichaProducto';
import Beneficios from './pages/Beneficios';
import ComoComprar from './pages/ComoComprar';
import FAQ from './pages/FAQ';
import Historia from './pages/Historia';
import Tips from './pages/Tips';
import CarritoPagina from './pages/Carrito';
import Privacidad from './pages/Privacidad';
import Terminos from './pages/Terminos';
import { ProveedorCarrito } from './carrito/useCarrito';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    scrollToTop();
  }, [pathname]);
  return null;
}

export default function App() {
  useEffect(() => {
    initSmoothScroll();
  }, []);

  return (
    <BrowserRouter>
      {/* Envuelve TODO lo de dentro del router: la barra de navegación necesita
          el número del carrito igual que la pantalla del carrito. */}
      <ProveedorCarrito>
      <ScrollToTop />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[10001] focus:bg-accent focus:text-accent-fg focus:px-5 focus:py-3 focus:rounded-pill focus:font-bold focus:shadow-soft"
      >
        Saltar al contenido
      </a>
      <div className="bg-bg min-h-screen text-fg font-body">
        <S01Nav />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/productos" element={<Productos />} />
          {/* La ficha de una variante (F3.7). Va DESPUÉS de /productos para que
              la lista no se la coma. */}
          <Route path="/productos/:slug" element={<FichaProducto />} />
          <Route path="/beneficios" element={<Beneficios />} />
          <Route path="/historia" element={<Historia />} />
          <Route path="/tips" element={<Tips />} />
          <Route path="/como-comprar" element={<ComoComprar />} />
          <Route path="/faq" element={<FAQ />} />
          {/* No se indexa: ya está en SIN_INDEXAR de seo/rutas.ts, porque un
              carrito es de una persona y no del público. */}
          <Route path="/carrito" element={<CarritoPagina />} />
          {/* Las legales SÍ se indexan: un aviso de privacidad que Google no
              encuentra no sirve de aviso, y la Ley 81 pide que la persona
              pueda leerlo ANTES de dar sus datos. Por eso están en RUTAS de
              seo/rutas.ts y no en SIN_INDEXAR. */}
          <Route path="/privacidad" element={<Privacidad />} />
          <Route path="/terminos" element={<Terminos />} />
        </Routes>
        <Chatbot />
        <S20Footer />
      </div>
      </ProveedorCarrito>
    </BrowserRouter>
  );
}
