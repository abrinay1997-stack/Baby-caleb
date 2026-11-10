import S16HowToBuy from '../blocks/S16HowToBuy';
import S18Coverage from '../blocks/S18Coverage';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function ComoComprar() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo ruta="/como-comprar" />
      <h1 className="sr-only">Cómo comprar en Baby Caleb</h1>
      <div className="flex-grow">
        <S16HowToBuy />
        <S18Coverage />
      </div>
      <S19CTA />
    </main>
  );
}
