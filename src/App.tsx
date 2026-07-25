/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { initSmoothScroll } from './lib/smooth';

import S01Nav from './blocks/S01Nav';
import S20Footer from './blocks/S20Footer';
import Chatbot from './components/Chatbot';

import Home from './pages/Home';
import Productos from './pages/Productos';
import Beneficios from './pages/Beneficios';
import ComoComprar from './pages/ComoComprar';
import FAQ from './pages/FAQ';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
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
      <div className="bg-bg min-h-screen text-fg font-body">
        <S01Nav />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/productos" element={<Productos />} />
          <Route path="/beneficios" element={<Beneficios />} />
          <Route path="/como-comprar" element={<ComoComprar />} />
          <Route path="/faq" element={<FAQ />} />
        </Routes>
        <Chatbot />
        <S20Footer />
      </div>
    </BrowserRouter>
  );
}

