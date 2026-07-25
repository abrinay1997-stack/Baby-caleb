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
import Beneficios from './pages/Beneficios';
import ComoComprar from './pages/ComoComprar';
import FAQ from './pages/FAQ';
import Historia from './pages/Historia';
import Tips from './pages/Tips';

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
          <Route path="/beneficios" element={<Beneficios />} />
          <Route path="/historia" element={<Historia />} />
          <Route path="/tips" element={<Tips />} />
          <Route path="/como-comprar" element={<ComoComprar />} />
          <Route path="/faq" element={<FAQ />} />
        </Routes>
        <Chatbot />
        <S20Footer />
      </div>
    </BrowserRouter>
  );
}
