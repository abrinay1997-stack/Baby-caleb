import S16HowToBuy from '../blocks/S16HowToBuy';
import S18Coverage from '../blocks/S18Coverage';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function ComoComprar() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo
        title="Cómo comprar | Baby Caleb Panamá"
        description="Haz tu pedido por WhatsApp en 3 pasos. Vendemos 100% online con entrega a domicilio en Ciudad de Panamá."
        path="/como-comprar"
      />
      <h1 className="sr-only">Cómo comprar en Baby Caleb</h1>
      <div className="flex-grow">
        <S16HowToBuy />
        <S18Coverage />
      </div>
      <S19CTA />
    </main>
  );
}
