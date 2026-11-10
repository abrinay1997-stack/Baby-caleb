import S09Products from '../blocks/S09Products';
import S10Gallery from '../blocks/S10Gallery';
import S18Coverage from '../blocks/S18Coverage';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function Productos() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo ruta="/productos" />
      <h1 className="sr-only">Catálogo de pañales y wipes hipoalergénicos Nateen</h1>
      <div className="flex-grow">
        <S09Products />
        <S10Gallery />
        <S18Coverage />
      </div>
      <S19CTA />
    </main>
  );
}
